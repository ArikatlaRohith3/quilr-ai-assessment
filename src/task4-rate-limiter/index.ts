import express, { type NextFunction, type Request, type Response } from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { openDatabase } from "./database.js";
import { RateLimiter } from "./rate-limiter.js";
import { TenantRegistry } from "./tenants.js";
import { Router } from "./router.js";
import { estimateTokens, loadTokenizer, type Tokenizer } from "./token-estimator.js";
import { OpenAIAdapter } from "./providers/openai.js";
import { AnthropicAdapter } from "./providers/anthropic.js";
import type { NormalizedRequest } from "./providers/types.js";
import { gatewayError } from "../shared/errors.js";
import { createLogger } from "../shared/logger.js";
import { intFromEnv, isMain } from "../shared/runtime.js";

const log = createLogger("llm-router");
const SOURCE = "llm-gateway";

const ChatRequest = z.object({
  model: z.string().min(1).max(128).optional(),
  messages: z
    .array(z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string().max(200_000) }))
    .min(1)
    .max(500),
  max_tokens: z.number().int().positive().max(128_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  stream: z.boolean().optional(),
});

export interface RouterAppOptions {
  limiter: RateLimiter;
  tenants: TenantRegistry;
  router: Router;
  tokenizer: Tokenizer;
  /** Output tokens reserved when the client doesn't send max_tokens. */
  defaultOutputReservation: number;
  /** Bearer token for GET /metrics. When unset, /metrics is disabled. */
  metricsToken?: string;
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function createRouterApp(opts: RouterAppOptions) {
  const { limiter, tenants, router, tokenizer } = opts;
  // The reservation doubles as the provider's output cap, so it must be a real limit.
  if (!Number.isInteger(opts.defaultOutputReservation) || opts.defaultOutputReservation < 1) {
    throw new Error("defaultOutputReservation must be a positive integer (it caps max_tokens for requests that omit it)");
  }
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "4mb" }));

  const fail = (res: Response, status: number, message: string) => res.status(status).json(gatewayError(status, message, SOURCE));

  app.get("/health", (_req, res) => res.json({ status: "ok", service: "rate-limiter", tokenizer: tokenizer.name }));

  app.get("/metrics", (req, res) => {
    if (!opts.metricsToken) return fail(res, 404, "Not found");
    const presented = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
    if (!safeEqual(presented, opts.metricsToken)) return fail(res, 401, "Authentication required");
    res.json({
      limit: limiter.limit,
      tenants: limiter.allUsage().map((u) => ({
        tenant: u.tenant_id,
        tokens_used: u.used,
        tokens_remaining: Math.max(0, limiter.limit - u.used),
      })),
    });
  });

  app.post("/v1/chat/completions", async (req: Request, res: Response) => {
    const requestId = randomUUID();
    res.setHeader("X-Request-ID", requestId);

    // 1. Tenant identity comes from the API key, never from a client-chosen header.
    const tenantId = tenants.authenticate(req.headers.authorization);
    if (!tenantId) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="llm-gateway"');
      return fail(res, 401, "Invalid or missing tenant API key");
    }

    // 2. Validate and normalise the request.
    const parsed = ChatRequest.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, `Invalid request: ${parsed.error.issues[0]?.path.join(".") || "body"} ${parsed.error.issues[0]?.message ?? ""}`.trim());
    if (parsed.data.stream) return fail(res, 400, "Streaming is not supported by this endpoint");
    const request: NormalizedRequest = {
      model: parsed.data.model,
      messages: parsed.data.messages,
      // Always sent to the provider: output can never exceed the output tokens reserved below.
      // Without this, a request omitting max_tokens reserves the default but may generate far more.
      max_tokens: parsed.data.max_tokens ?? opts.defaultOutputReservation,
      temperature: parsed.data.temperature,
    };

    // 3. Estimate and atomically reserve.
    const estimate = estimateTokens(request, tokenizer, opts.defaultOutputReservation);
    if (estimate.total > limiter.limit) {
      return fail(res, 400, `Request needs ~${estimate.total} tokens, more than the ${limiter.limit} tokens/min budget`);
    }
    const reservation = limiter.reserve(tenantId, estimate.total);
    res.setHeader("X-RateLimit-Limit", String(limiter.limit));
    if (!reservation.ok) {
      log.info("rate limited", { requestId, tenant: tenantId, used: reservation.used, requested: estimate.total });
      res.setHeader("Retry-After", String(reservation.retryAfterSec));
      res.setHeader("X-RateLimit-Remaining", String(Math.max(0, limiter.limit - reservation.used)));
      return fail(res, 429, `Rate limit exceeded: ${limiter.limit} tokens/min`);
    }

    // 4. Route with failover. Any unexpected error releases the reservation.
    let result;
    try {
      result = await router.complete(request, requestId);
    } catch (err) {
      limiter.release(reservation.id);
      log.error("router crashed", { requestId, error: String(err) });
      return fail(res, 500, "Internal gateway error");
    }
    const { outcome } = result;
    if (result.usedFallback) res.setHeader("X-Gateway-Fallback", "true");
    res.setHeader("X-Gateway-Provider", result.provider);

    if (outcome.kind !== "ok") {
      // Nothing was delivered, so the tenant isn't charged for it.
      limiter.release(reservation.id);
      if (outcome.kind === "rejected") return fail(res, 400, "Upstream provider rejected the request");
      if (outcome.kind === "timeout") return fail(res, 504, "All providers timed out");
      if (outcome.kind === "rate_limited") {
        res.setHeader("Retry-After", "5");
        return fail(res, 503, "All providers are rate limited");
      }
      return fail(res, 502, "All providers failed");
    }

    // 5. Reconcile the reservation with real usage (or keep the estimate if none was reported).
    const r = outcome.response;
    const actual = r.usage ? r.usage.input_tokens + r.usage.output_tokens : estimate.total;
    limiter.commit(reservation.id, actual);
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, limiter.limit - limiter.usage(tenantId))));
    log.info("completed", {
      requestId, tenant: tenantId, provider: r.provider, fallback: result.usedFallback,
      estimated: estimate.total, actual, usage_reported: !!r.usage,
    });

    res.json({
      id: `chatcmpl-${requestId}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: r.model,
      provider: r.provider,
      choices: [{ index: 0, message: { role: "assistant", content: r.content }, finish_reason: r.finish_reason }],
      usage: r.usage
        ? { prompt_tokens: r.usage.input_tokens, completion_tokens: r.usage.output_tokens, total_tokens: actual, estimated: false }
        : { prompt_tokens: estimate.input, completion_tokens: estimate.output, total_tokens: estimate.total, estimated: true },
    });
  });

  app.use((err: Error & { type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    if (err.type === "entity.parse.failed") return fail(res, 400, "Invalid JSON body");
    if (err.type === "entity.too.large") return fail(res, 413, "Request too large");
    log.error("unhandled error", { error: err.message });
    fail(res, 500, "Internal gateway error");
  });

  return app;
}

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dbPath = process.env.DB_PATH ?? path.join(here, "../../rate_limiter.db");
  const tenants = TenantRegistry.fromEnv();
  if (tenants.size === 0) throw new Error("TENANT_API_KEYS must define at least one tenant (tenantId:apiKey,...)");

  const limiter = new RateLimiter(openDatabase(dbPath), { limit: intFromEnv("MAX_TOKENS_PER_MINUTE", 50_000), windowMs: 60_000 });
  const primary = new OpenAIAdapter({
    baseUrl: process.env.PRIMARY_BASE_URL ?? "https://api.openai.com",
    apiKey: process.env.PRIMARY_API_KEY ?? "",
    defaultModel: process.env.PRIMARY_MODEL ?? "gpt-4o-mini",
  });
  const secondary = new AnthropicAdapter({
    apiKey: process.env.SECONDARY_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? "",
    baseURL: process.env.SECONDARY_BASE_URL || undefined,
    model: process.env.SECONDARY_MODEL ?? "claude-opus-5-5",
    refusalFallback: process.env.ANTHROPIC_REFUSAL_FALLBACK !== "off",
  });
  const router = new Router(primary, secondary, {
    timeoutMs: intFromEnv("PROVIDER_TIMEOUT_MS", 3000),
    maxJitterMs: intFromEnv("FAILOVER_MAX_JITTER_MS", 200),
  });
  const tokenizer = await loadTokenizer();
  const app = createRouterApp({
    limiter, tenants, router, tokenizer,
    defaultOutputReservation: intFromEnv("DEFAULT_OUTPUT_RESERVATION", 1024),
    metricsToken: process.env.METRICS_TOKEN || undefined,
  });
  const port = intFromEnv("PORT", 3004);
  app.listen(port, () => log.info("Rate-limiting LLM router listening", { port, db: dbPath, tenants: tenants.size, tokenizer: tokenizer.name }));
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    log.error("fatal", { error: (err as Error).message });
    process.exit(1);
  });
}
