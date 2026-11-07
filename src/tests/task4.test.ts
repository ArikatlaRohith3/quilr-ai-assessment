import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openDatabase } from "../task4-rate-limiter/database.js";
import { RateLimiter } from "../task4-rate-limiter/rate-limiter.js";
import { TenantRegistry } from "../task4-rate-limiter/tenants.js";
import { Router } from "../task4-rate-limiter/router.js";
import { createRouterApp } from "../task4-rate-limiter/index.js";
import { heuristicTokenizer, estimateTokens } from "../task4-rate-limiter/token-estimator.js";
import { OpenAIAdapter } from "../task4-rate-limiter/providers/openai.js";
import { AnthropicAdapter } from "../task4-rate-limiter/providers/anthropic.js";
import { mockOpenAI, mockAnthropic, type MockLlm } from "../shared/mock-providers.js";
import { serve, captureLogs, type Running } from "./helpers.js";
import { createGuardrailApp } from "../task3-llm-guardrail/index.js";
import { ApiKeyRegistry } from "../shared/api-keys.js";

const KEY_A = "tenant-a-key-0123456789";
const KEY_B = "tenant-b-key-0123456789";
const PRIMARY_KEY = "sk-primary-SECRET-abcdef";
const SECONDARY_KEY = "sk-ant-SECRET-abcdef";
const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "quilr-rl-")), "rl.db");

interface Harness {
  url: string;
  primary: MockLlm;
  secondary: MockLlm;
  limiter: RateLimiter;
  close(): Promise<void>;
}

async function harness(opts: { limit?: number; timeoutMs?: number; dbFile?: string; defaultOutputReservation?: number } = {}): Promise<Harness> {
  const primary = await mockOpenAI();
  const secondary = await mockAnthropic();
  const limiter = new RateLimiter(openDatabase(opts.dbFile ?? ":memory:"), { limit: opts.limit ?? 50_000, windowMs: 60_000 });
  const router = new Router(
    new OpenAIAdapter({ baseUrl: primary.url, apiKey: PRIMARY_KEY, defaultModel: "gpt-test" }),
    new AnthropicAdapter({ baseURL: secondary.url, apiKey: SECONDARY_KEY, model: "claude-opus-5-5" }),
    { timeoutMs: opts.timeoutMs ?? 3000, maxJitterMs: 5 },
  );
  const app = createRouterApp({
    limiter,
    router,
    tenants: new TenantRegistry([{ tenantId: "tenant-a", apiKey: KEY_A }, { tenantId: "tenant-b", apiKey: KEY_B }]),
    tokenizer: heuristicTokenizer,
    defaultOutputReservation: opts.defaultOutputReservation ?? 1,
    metricsToken: "metrics-token",
  });
  const running: Running = await serve(app);
  return {
    url: running.url, primary, secondary, limiter,
    close: async () => { await running.close(); await primary.close(); await secondary.close(); },
  };
}

/** A request whose estimate is exactly `tokens` with the heuristic tokenizer and the harness default 1-token output reservation. */
function bodyOfTokens(tokens: number, extra: Record<string, unknown> = {}) {
  const overhead = 3 + 4 + 1; // request + one message + 1 reserved output token
  return { model: "gpt-test", messages: [{ role: "user", content: "x".repeat((tokens - overhead) * 4) }], ...extra };
}

async function post(url: string, body: unknown, key: string | null = KEY_A, headers: Record<string, string> = {}) {
  const res = await fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}), ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: (await res.json()) as any };
}

describe("Task 4 — token estimation", () => {
  test("input + reserved output", () => {
    const e = estimateTokens({ messages: [{ role: "user", content: "x".repeat(400) }], max_tokens: 50 }, heuristicTokenizer, 1024);
    assert.deepEqual(e, { input: 107, output: 50, total: 157 });
    assert.equal(estimateTokens({ messages: [{ role: "user", content: "" }] }, heuristicTokenizer, 1024).output, 1024);
  });
});

describe("Task 4 — rate limiting", () => {
  test("enforces the per-minute budget with Retry-After", async () => {
    const h = await harness({ limit: 1000 });
    try {
      for (let i = 0; i < 3; i++) {
        h.primary.options.usage = false; // keep reservations at the estimate
        assert.equal((await post(h.url, bodyOfTokens(300))).status, 200);
      }
      const r = await post(h.url, bodyOfTokens(300));
      assert.equal(r.status, 429);
      assert.deepEqual(r.body, { error: { code: 429, message: "Rate limit exceeded: 1000 tokens/min", source: "llm-gateway" } });
      const retry = Number(r.headers.get("retry-after"));
      assert.ok(retry >= 1 && retry <= 60, `Retry-After ${retry}`);
      assert.equal(r.headers.get("x-ratelimit-remaining"), "100");
      assert.equal(h.primary.requests.length, 3, "rejected request must not reach a provider");
    } finally { await h.close(); }
  });

  test("default 50K limit: a 50,001-token request can never fit", async () => {
    const h = await harness();
    try {
      const r = await post(h.url, bodyOfTokens(50_001));
      assert.equal(r.status, 400);
      assert.match(r.body.error.message, /50000 tokens\/min/);
    } finally { await h.close(); }
  });

  test("concurrent requests cannot over-allocate (atomic reservation)", async () => {
    const h = await harness({ limit: 10_000 });
    try {
      h.primary.options = { delayMs: 150, usage: false }; // all requests are in flight together
      const results = await Promise.all(Array.from({ length: 25 }, () => post(h.url, bodyOfTokens(1000))));
      const ok = results.filter((r) => r.status === 200).length;
      const limited = results.filter((r) => r.status === 429).length;
      assert.equal(ok, 10);
      assert.equal(limited, 15);
      assert.equal(h.limiter.usage("tenant-a"), 10_000);
    } finally { await h.close(); }
  });

  test("multiple processes sharing one SQLite file cannot over-allocate", async () => {
    const dbFile = tmpDb();
    openDatabase(dbFile).close(); // create schema
    const workerSrc = `
      const { workerData, parentPort } = require("node:worker_threads");
      import(workerData.mod).then(({ openDatabase }) => import(workerData.rl).then(({ RateLimiter }) => {
        const rl = new RateLimiter(openDatabase(workerData.db), { limit: 10000, windowMs: 60000 });
        let granted = 0;
        for (let i = 0; i < 60; i++) if (rl.reserve("shared", 300).ok) granted++;
        parentPort.postMessage(granted);
      }));`;
    const here = path.dirname(fileURLToPath(import.meta.url));
    const mod = pathToFileURL(path.join(here, "../task4-rate-limiter/database.js")).href;
    const rl = pathToFileURL(path.join(here, "../task4-rate-limiter/rate-limiter.js")).href;
    const grants = await Promise.all(
      Array.from({ length: 4 }, () => new Promise<number>((resolve, reject) => {
        const w = new Worker(workerSrc, { eval: true, workerData: { mod, rl, db: dbFile } });
        w.once("message", resolve);
        w.once("error", reject);
      })),
    );
    const total = grants.reduce((a, b) => a + b, 0);
    assert.equal(total, Math.floor(10_000 / 300), `grants per worker: ${grants}`);
    const check = new RateLimiter(openDatabase(dbFile), { limit: 10_000, windowMs: 60_000 });
    assert.ok(check.usage("shared") <= 10_000);
  });

  test("usage persists in SQLite across restarts", async () => {
    const dbFile = tmpDb();
    const db1 = openDatabase(dbFile);
    const a = new RateLimiter(db1, { limit: 1000, windowMs: 60_000 });
    const r = a.reserve("t", 700);
    assert.ok(r.ok);
    a.commit(r.id, 650);
    db1.close();
    const b = new RateLimiter(openDatabase(dbFile), { limit: 1000, windowMs: 60_000 });
    assert.equal(b.usage("t"), 650);
    assert.equal(b.reserve("t", 400).ok, false);
  });

  test("sliding window frees capacity as time passes", () => {
    let now = 1_000_000;
    const rl = new RateLimiter(openDatabase(":memory:"), { limit: 100, windowMs: 60_000, now: () => now });
    assert.ok(rl.reserve("t", 60).ok);
    now += 30_000;
    assert.ok(rl.reserve("t", 40).ok);
    const denied = rl.reserve("t", 10);
    assert.equal(denied.ok, false);
    assert.equal(!denied.ok && denied.retryAfterSec, 30); // first reservation expires in 30s
    now += 30_001;
    assert.ok(rl.reserve("t", 50).ok);
  });

  test("reservations reconcile to the provider's actual usage", async () => {
    const h = await harness({ limit: 10_000 });
    try {
      h.primary.options.usage = { input: 20, output: 5 };
      const r = await post(h.url, bodyOfTokens(500, { max_tokens: 10 })); // estimate 509; provider reports 25
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.usage, { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25, estimated: false });
      assert.equal(h.limiter.usage("tenant-a"), 25);
    } finally { await h.close(); }
  });
});

describe("Task 4 — failover", () => {
  let h: Harness;
  before(async () => { h = await harness({ timeoutMs: 300 }); });
  after(() => h.close());
  const reset = () => { h.primary.options = {}; h.secondary.options = {}; h.primary.requests.length = 0; h.secondary.requests.length = 0; };

  test("primary 200 → served by primary in normalised format", async () => {
    reset();
    const r = await post(h.url, { messages: [{ role: "user", content: "hi" }] });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-gateway-fallback"), null);
    assert.equal(r.body.provider, "openai");
    assert.equal(r.body.object, "chat.completion");
    assert.equal(r.body.choices[0].message.content, "Hello from primary");
    assert.equal(h.primary.requests[0].headers.authorization, `Bearer ${PRIMARY_KEY}`);
  });

  test("primary 429 → Anthropic fallback with a correctly translated request", async () => {
    reset();
    h.primary.options.mode = "429";
    const r = await post(h.url, { model: "gpt-4o-mini", temperature: 0.2, max_tokens: 64, messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "hi" }] });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-gateway-fallback"), "true");
    assert.equal(r.headers.get("x-gateway-provider"), "anthropic");
    assert.equal(r.body.choices[0].message.content, "Hello from fallback");
    assert.equal(r.body.choices[0].finish_reason, "stop");
    assert.deepEqual(r.body.usage, { prompt_tokens: 13, completion_tokens: 9, total_tokens: 22, estimated: false });

    const sent = h.secondary.requests[0];
    // The official SDK carries the key (x-api-key or Bearer, depending on SDK version); the primary's key must never leak.
    const sentKey = sent.headers["x-api-key"] ?? String(sent.headers.authorization ?? "").replace(/^Bearer /, "");
    assert.equal(sentKey, SECONDARY_KEY);
    assert.ok(sent.headers["anthropic-version"]);
    assert.ok(!JSON.stringify(sent.headers).includes(PRIMARY_KEY), "primary credentials must not be sent to Anthropic");
    assert.equal(sent.body.model, "claude-opus-5-5");
    assert.equal(sent.body.system, "Be brief.");
    assert.deepEqual(sent.body.messages, [{ role: "user", content: "hi" }]);
    assert.equal(sent.body.max_tokens, 64);
    assert.equal(sent.body.temperature, undefined);
  });

  test("primary timeout → fallback", async () => {
    reset();
    h.primary.options.mode = "slow";
    const t0 = Date.now();
    const r = await post(h.url, { messages: [{ role: "user", content: "hi" }] });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-gateway-fallback"), "true");
    assert.ok(Date.now() - t0 < 2000);
  });

  test("primary 5xx or garbage → fallback", async () => {
    for (const mode of ["500", "garbage"] as const) {
      reset();
      h.primary.options.mode = mode;
      const r = await post(h.url, { messages: [{ role: "user", content: "hi" }] });
      assert.equal(r.status, 200, mode);
      assert.equal(r.body.provider, "anthropic");
    }
  });

  test("primary 400 is not failed over", async () => {
    reset();
    h.primary.options.mode = "400";
    const r = await post(h.url, { messages: [{ role: "user", content: "hi" }] });
    assert.equal(r.status, 400);
    assert.equal(h.secondary.requests.length, 0);
  });

  test("backup failure → sanitized error, reservation released, nothing leaked", async () => {
    for (const [p, s, status] of [["429", "500", 502], ["slow", "slow", 504], ["429", "429", 503]] as const) {
      reset();
      h.primary.options.mode = p;
      h.secondary.options.mode = s;
      const before = h.limiter.usage("tenant-b");
      const r = await post(h.url, { messages: [{ role: "user", content: "hi" }] }, KEY_B);
      assert.equal(r.status, status, `${p}/${s}`);
      assert.deepEqual(Object.keys(r.body.error).sort(), ["code", "message", "source"]);
      const text = JSON.stringify(r.body);
      assert.ok(!/SECRET|stack|handler\.js/.test(text), text);
      assert.equal(h.limiter.usage("tenant-b"), before);
    }
  });

  test("stream: true returns the answer in OpenAI streaming format (audit M5)", async () => {
    reset();
    const res = await fetch(`${h.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY_A}` },
      body: JSON.stringify({ stream: true, max_tokens: 32, messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const events = (await res.text()).split("\n\n").filter(Boolean).map((e) => e.replace(/^data: /, ""));
    assert.equal(events.at(-1), "[DONE]");
    const chunks = events.slice(0, -1).map((e) => JSON.parse(e));
    assert.equal(chunks.map((c) => c.choices[0].delta.content ?? "").join(""), "Hello from primary");
    assert.equal(chunks.at(-1).choices[0].finish_reason, "stop");
    assert.deepEqual(chunks.at(-1).usage, { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, estimated: false });
  });
});

describe("Task 4 — tenant isolation & secrecy", () => {
  test("tenants authenticate by key; budgets are isolated; client headers can't pick a tenant", async () => {
    const h = await harness({ limit: 500 });
    try {
      h.primary.options.usage = false;
      assert.equal((await post(h.url, bodyOfTokens(500))).status, 200);
      assert.equal((await post(h.url, bodyOfTokens(10))).status, 429);
      assert.equal((await post(h.url, bodyOfTokens(10), KEY_B)).status, 200, "tenant B unaffected");

      assert.equal((await post(h.url, bodyOfTokens(10), null)).status, 401);
      assert.equal((await post(h.url, bodyOfTokens(10), "wrong-key-0123456789")).status, 401);
      assert.equal((await post(h.url, bodyOfTokens(10), null, { "X-Tenant-Key": "tenant-b" })).status, 401);
    } finally { await h.close(); }
  });

  test("/metrics requires its token and exposes no keys", async () => {
    const h = await harness();
    try {
      await post(h.url, bodyOfTokens(100));
      assert.equal((await fetch(`${h.url}/metrics`)).status, 401);
      const m = await (await fetch(`${h.url}/metrics`, { headers: { Authorization: "Bearer metrics-token" } })).json() as any;
      assert.equal(m.tenants[0].tenant, "tenant-a");
      assert.ok(!JSON.stringify(m).includes(KEY_A));
    } finally { await h.close(); }
  });

  test("logs never contain tenant keys, provider keys or upstream error bodies", async () => {
    const h = await harness();
    try {
      const { logs } = await captureLogs(async () => {
        h.primary.options.mode = "500";
        h.secondary.options.mode = "500";
        await post(h.url, { messages: [{ role: "user", content: "hi" }] });
        await post(h.url, { messages: [{ role: "user", content: "hi" }] }, "bad-key-0123456789");
      });
      for (const secret of [KEY_A, PRIMARY_KEY, SECONDARY_KEY, "sk-live-SECRET", "handler.js"]) assert.ok(!logs.includes(secret), `log leaked ${secret}`);
      assert.match(logs, /failing over/);
    } finally { await h.close(); }
  });
});

// ─────────────── audit fix H2: omitting max_tokens cannot bypass the limit ───────────────

describe("Task 4 — output is capped by the reservation (audit H2)", () => {
  const essay = { model: "gpt-test", messages: [{ role: "user", content: "write a very long essay" }] };

  test("requests without max_tokens send max_tokens = reserved output to the provider", async () => {
    const h = await harness({ defaultOutputReservation: 256 });
    try {
      assert.equal((await post(h.url, essay)).status, 200);
      assert.equal(h.primary.requests[0].body.max_tokens, 256);
      assert.equal((await post(h.url, { ...essay, max_tokens: 64 })).status, 200);
      assert.equal(h.primary.requests[1].body.max_tokens, 64, "an explicit max_tokens is kept");
    } finally { await h.close(); }
  });

  test("the fallback provider gets the same cap", async () => {
    const h = await harness({ defaultOutputReservation: 256 });
    try {
      h.primary.options = { mode: "429" };
      const r = await post(h.url, essay);
      assert.equal(r.headers.get("x-gateway-provider"), "anthropic");
      assert.equal(h.secondary.requests[0].body.max_tokens, 256);
    } finally { await h.close(); }
  });

  test("a burst of over-generating requests without max_tokens never exceeds the limit", async () => {
    const h = await harness({ limit: 10_000, defaultOutputReservation: 1024 });
    try {
      // The model would happily write 9,000 tokens per reply; only max_tokens stops it.
      h.primary.options = { usage: { input: 10, output: 9000 } };
      const statuses = await Promise.all(Array.from({ length: 12 }, () => post(h.url, essay).then((r) => r.status)));
      const admitted = statuses.filter((s) => s === 200).length;
      assert.ok(admitted >= 1 && statuses.every((s) => s === 200 || s === 429), String(statuses));
      const used = h.limiter.usage("tenant-a");
      assert.ok(used <= 10_000, `charged ${used} tokens against a 10,000 limit`);
      for (const req of h.primary.requests) assert.equal(req.body.max_tokens, 1024);
    } finally { await h.close(); }
  });

  test("a zero or invalid output reservation is refused at startup", async () => {
    const h = await harness();
    try {
      for (const bad of [0, -1, 1.5, NaN]) {
        assert.throws(() => createRouterApp({ limiter: h.limiter, router: null as any, tenants: new TenantRegistry([]), tokenizer: heuristicTokenizer, defaultOutputReservation: bad }), /defaultOutputReservation/, String(bad));
      }
    } finally { await h.close(); }
  });
});

// ─────────────── audit fixes M5 / M6 ───────────────

describe("Task 4 — model allowlist (audit M6)", () => {
  test("only allowlisted models may be requested; omitting the model uses the default", async () => {
    const primary = await mockOpenAI();
    const secondary = await mockAnthropic();
    const limiter = new RateLimiter(openDatabase(":memory:"), { limit: 50_000, windowMs: 60_000 });
    const app = createRouterApp({
      limiter,
      router: new Router(new OpenAIAdapter({ baseUrl: primary.url, apiKey: PRIMARY_KEY, defaultModel: "gpt-4o-mini" }), new AnthropicAdapter({ baseURL: secondary.url, apiKey: SECONDARY_KEY, model: "claude-opus-5-5" }), { timeoutMs: 2000, maxJitterMs: 0 }),
      tenants: new TenantRegistry([{ tenantId: "tenant-a", apiKey: KEY_A }]),
      tokenizer: heuristicTokenizer,
      defaultOutputReservation: 16,
      allowedModels: ["gpt-4o-mini"],
    });
    const running = await serve(app);
    try {
      const msg = { messages: [{ role: "user", content: "hi" }] };
      const denied = await post(running.url, { ...msg, model: "gpt-5-pro-expensive" });
      assert.equal(denied.status, 400);
      assert.equal(denied.body.error.message, "Model not allowed: gpt-5-pro-expensive");
      assert.equal(primary.requests.length, 0, "a denied model never reaches a provider");
      assert.equal(limiter.usage("tenant-a"), 0, "and costs the tenant nothing");
      assert.equal((await post(running.url, { ...msg, model: "gpt-4o-mini" })).status, 200);
      assert.equal((await post(running.url, msg)).status, 200);
      assert.equal(primary.requests[1].body.model, "gpt-4o-mini");
    } finally {
      await running.close(); await primary.close(); await secondary.close();
    }
  });
});

describe("Integration — client → Task 3 guardrail → Task 4 router → provider (audit M5)", () => {
  const GUARDRAIL_KEY = "guardrail-client-key-0123456789";

  async function chain(limit: number) {
    const h = await harness({ limit, defaultOutputReservation: 64 });
    // The guardrail authenticates to the router with a tenant key, exactly like any other tenant.
    const g = await serve(createGuardrailApp({ upstreamBaseUrl: h.url, apiKey: KEY_A, clients: new ApiKeyRegistry([{ id: "app", apiKey: GUARDRAIL_KEY }]) }));
    const ask = (content: string) => fetch(`${g.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${GUARDRAIL_KEY}` },
      body: JSON.stringify({ messages: [{ role: "user", content }] }),
    });
    return { h, ask, close: async () => { await g.close(); await h.close(); } };
  }

  test("PII is redacted in both directions and the request is rate-limited and served", async () => {
    const c = await chain(50_000);
    try {
      c.h.primary.options = { content: "Sure, I emailed jane.doe@example.com and noted SSN 123-45-6789." };
      const res = await c.ask("My card is 4111 1111 1111 1111");
      assert.equal(res.status, 200);
      const raw = await res.text();
      const text = raw.split("\n\n").filter((e) => e.startsWith("data: {")).map((e) => JSON.parse(e.slice(6)).choices?.[0]?.delta?.content ?? "").join("");
      assert.equal(text, "Sure, I emailed [REDACTED] and noted SSN [REDACTED].");
      assert.ok(raw.trimEnd().endsWith("data: [DONE]"));
      // Inbound redaction happened before the router (and therefore the provider) saw the prompt.
      assert.equal(c.h.primary.requests[0].body.messages[0].content, "My card is [REDACTED]");
      assert.ok(c.h.limiter.usage("tenant-a") > 0, "the router charged the tenant");
    } finally { await c.close(); }
  });

  test("the router's 429 reaches the client through the guardrail, sanitized", async () => {
    const c = await chain(100);
    try {
      assert.equal((await c.ask("x".repeat(80))).status, 200);
      const blocked = await c.ask("x".repeat(80));
      assert.equal(blocked.status, 429);
      assert.deepEqual(await blocked.json(), { error: { code: 429, message: "Upstream rate limit exceeded", source: "llm-guardrail" } });
    } finally { await c.close(); }
  });
});
