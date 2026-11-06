import express, { Request, Response } from "express";
import { DatabaseSync } from "node:sqlite";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH ?? path.join(__dirname, "../../rate_limiter.db");

const app = express();
app.use(express.json());

const PORT = process.env.PORT ?? 3004;
const PRIMARY_LLM_URL   = process.env.PRIMARY_LLM_URL   ?? "https://api.openai.com/v1/chat/completions";
const SECONDARY_LLM_URL = process.env.SECONDARY_LLM_URL ?? "https://api.anthropic.com/v1/messages";
const LLM_API_KEY       = process.env.LLM_API_KEY       ?? "";

const MAX_TOKENS_PER_MINUTE = parseInt(process.env.MAX_TOKENS_PER_MINUTE ?? "50000", 10);
const WINDOW_MS  = 60_000;
const TIMEOUT_MS = 3_000;

// ── SQLite setup (node:sqlite built-in — no native deps) ─────────────────────
const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS token_usage (
    tenant_key  TEXT    NOT NULL,
    used_at     INTEGER NOT NULL,
    token_count INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_token_usage_tenant_time
    ON token_usage (tenant_key, used_at);
`);

function getWindowTotal(tenantKey: string): number {
  const cutoff = Date.now() - WINDOW_MS;
  const row = db.prepare(
    "SELECT COALESCE(SUM(token_count), 0) AS total FROM token_usage WHERE tenant_key = ? AND used_at > ?"
  ).get(tenantKey, cutoff) as { total: number };
  return row.total;
}

function recordUsage(tenantKey: string, tokens: number): void {
  db.prepare("INSERT INTO token_usage (tenant_key, used_at, token_count) VALUES (?, ?, ?)").run(tenantKey, Date.now(), tokens);
  // Evict expired rows to keep the table small
  db.prepare("DELETE FROM token_usage WHERE used_at <= ?").run(Date.now() - WINDOW_MS);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Rough estimate: ~1 token per 4 characters
function estimateTokens(body: Record<string, unknown>): number {
  const messages = body.messages as Array<{ content?: string }> | undefined;
  if (!messages) return 0;
  const chars = messages.reduce((s, m) => s + (m.content?.length ?? 0), 0);
  return Math.ceil(chars / 4);
}

function gatewayError(message: string, code = 500): object {
  return { error: { code, message, source: "llm-gateway" } };
}

// fetch with hard timeout — returns null on abort
async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<globalThis.Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if ((err as Error).name === "AbortError") return null;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

app.get("/health", (_req, res) => res.json({ status: "ok", service: "rate-limiter" }));

// ── Route ─────────────────────────────────────────────────────────────────────
app.post("/v1/chat/completions", async (req: Request, res: Response) => {
  const tenantKey = (req.headers["x-tenant-key"] as string) ?? "default";
  const body = req.body as Record<string, unknown>;

  const estimatedTokens = estimateTokens(body);
  const currentUsage    = getWindowTotal(tenantKey);

  console.log(`[router] tenant=${tenantKey} estimated=${estimatedTokens} window=${currentUsage}/${MAX_TOKENS_PER_MINUTE}`);

  if (currentUsage + estimatedTokens > MAX_TOKENS_PER_MINUTE) {
    res.setHeader("Retry-After", String(Math.ceil(WINDOW_MS / 1000)));
    res.status(429).json(gatewayError(`Rate limit exceeded: ${MAX_TOKENS_PER_MINUTE} tokens/min`, 429));
    return;
  }

  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${LLM_API_KEY}` },
    body: JSON.stringify(body),
  };

  // Try primary
  let response: globalThis.Response | null = null;
  let usedFallback = false;

  try {
    response = await fetchWithTimeout(PRIMARY_LLM_URL, init, TIMEOUT_MS);
  } catch (err) {
    console.error(`[router] Primary error: ${err}`);
  }

  // Failover on 429 or timeout
  if (!response || response.status === 429) {
    console.log(`[router] Failing over — primary ${!response ? "timed out" : "returned 429"}`);
    usedFallback = true;
    try {
      response = await fetchWithTimeout(SECONDARY_LLM_URL, init, TIMEOUT_MS);
    } catch (err) {
      console.error(`[router] Secondary error: ${err}`);
      res.status(502).json(gatewayError("Both providers failed"));
      return;
    }
  }

  if (!response) {
    res.status(504).json(gatewayError("Gateway timeout"));
    return;
  }

  recordUsage(tenantKey, estimatedTokens);

  if (!response.ok) {
    console.error(`[router] Upstream ${response.status} from ${usedFallback ? "secondary" : "primary"}`);
    res.status(response.status >= 500 ? 502 : response.status).json(
      gatewayError(`Upstream error (${response.status})`)
    );
    return;
  }

  const data = await response.json();
  if (usedFallback) res.setHeader("X-Gateway-Fallback", "true");
  res.json(data);
});

app.listen(PORT, () => {
  console.log(`[router] Rate-Limiting LLM Router on http://localhost:${PORT}`);
  console.log(`[router] Max ${MAX_TOKENS_PER_MINUTE} tokens/min | DB: ${DB_PATH}`);
});
