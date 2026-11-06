/**
 * End-to-end demo: runs every task locally against mock providers (no API keys)
 * and prints a ✅/❌ per check. Exits non-zero if any check fails.
 *
 *   npm run build && npm run demo
 *
 * The full behaviour is covered by `npm test`; this is the short guided tour.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setLogLevel } from "../shared/logger.js";
import { mockAnthropic, mockOpenAI, mockSseUpstream, sseFrames, writeInSlices } from "../shared/mock-providers.js";
import { createGatewayApp } from "../task2-mcp-gateway/index.js";
import { createMockDownstream } from "../task2-mcp-gateway/mock-downstream/index.js";
import { HttpDownstream, StdioDownstream } from "../task2-mcp-gateway/proxy.js";
import { signToken } from "../task2-mcp-gateway/auth.js";
import { createGuardrailApp } from "../task3-llm-guardrail/index.js";
import { openDatabase } from "../task4-rate-limiter/database.js";
import { RateLimiter } from "../task4-rate-limiter/rate-limiter.js";
import { TenantRegistry } from "../task4-rate-limiter/tenants.js";
import { Router } from "../task4-rate-limiter/router.js";
import { createRouterApp } from "../task4-rate-limiter/index.js";
import { heuristicTokenizer } from "../task4-rate-limiter/token-estimator.js";
import { OpenAIAdapter } from "../task4-rate-limiter/providers/openai.js";
import { AnthropicAdapter } from "../task4-rate-limiter/providers/anthropic.js";

setLogLevel((process.env.LOG_LEVEL as "info") ?? "silent");

const here = path.dirname(fileURLToPath(import.meta.url));
const TASK1 = path.join(here, "../task1-mcp-server/index.js");

const C = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};
let passed = 0;
let failed = 0;
const check = (label: string, detail: string, ok: boolean) => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? C.green("✅") : C.red("❌")}  ${C.bold(label)}: ${detail}`);
};
const header = (t: string) => console.log(`\n${C.cyan("═".repeat(60))}\n${C.bold("  " + t)}\n${C.cyan("═".repeat(60))}`);

type Closer = () => Promise<void>;
const closers: Closer[] = [];
async function listen(app: { listen: (p: number, h: string, cb: () => void) => import("node:http").Server }): Promise<string> {
  const server = await new Promise<import("node:http").Server>((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  closers.push(() => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }));
  return `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
}

async function task1() {
  header("Task 1 — MCP server (stdio, strict Zod validation)");
  const proc = spawn(process.execPath, [TASK1], { stdio: ["pipe", "pipe", "pipe"] });
  proc.stderr.resume();
  const replies = new Map<number, any>();
  let buf = "";
  const stdoutLines: string[] = [];
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (c: string) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      stdoutLines.push(line);
      const m = JSON.parse(line); replies.set(m.id, m);
    }
  });
  const send = (o: object) => proc.stdin.write(JSON.stringify(o) + "\n");
  send({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "demo", version: "1" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_customer_record", arguments: { customer_id: "CUST-00123" } } });
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "trigger_refund", arguments: { customer_id: "CUST-00123", amount: 49.99, reason: "Product defective on arrival" } } });
  send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_customer_record", arguments: { customer_id: "INVALID" } } });
  send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "trigger_refund", arguments: { customer_id: "CUST-00123", amount: -5, reason: "   short    " } } });
  for (let i = 0; i < 50 && replies.size < 6; i++) await new Promise((r) => setTimeout(r, 100));
  proc.kill();

  check("tools/list", `${replies.get(1)?.result?.tools?.length ?? 0} tools`, replies.get(1)?.result?.tools?.length === 2);
  check("get_customer_record", "returned a record", !!replies.get(2)?.result && !replies.get(2).result.isError);
  check("trigger_refund", "refund processed", JSON.parse(replies.get(3)?.result?.content?.[0]?.text ?? "{}").status === "processed");
  check("bad customer_id", `JSON-RPC error ${replies.get(4)?.error?.code}: ${replies.get(4)?.error?.message}`, replies.get(4)?.error?.code === -32602);
  check("negative amount + padded reason", `JSON-RPC error ${replies.get(5)?.error?.code}`, replies.get(5)?.error?.code === -32602);
  check("stdout purity", "every stdout line is JSON-RPC", stdoutLines.every((l) => JSON.parse(l).jsonrpc === "2.0"));
}

async function task2() {
  header("Task 2 — MCP security gateway (signed JWT + deny-by-default)");
  const auth = { secret: "demo-secret-please-change-0123456789", issuer: "quilr-auth", audience: "quilr-mcp-gateway" };
  const admin = signToken({ sub: "alice", role: "admin" }, auth);
  const viewer = signToken({ sub: "bob", role: "viewer" }, auth);
  const rpc = async (url: string, body: object, token?: string) => {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as any };
  };
  const call = (id: number, name: string, args: object = {}) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

  const downUrl = await listen(createMockDownstream());
  const gw = await listen(createGatewayApp({ auth, downstream: new HttpDownstream(downUrl, 3000) }));
  let r = await rpc(gw, call(1, "admin_reset_key"), admin);
  check("admin → admin_reset_key", `HTTP ${r.status}, forwarded`, r.status === 200 && !!r.body.result);
  r = await rpc(gw, call(2, "admin_reset_key"), viewer);
  check("viewer → admin_reset_key", `HTTP ${r.status}, ${r.body.error?.code} ${r.body.error?.message}`, r.body.error?.code === -32001);
  r = await rpc(gw, call(3, "admin_reset_key"), Buffer.from("role:admin").toString("base64"));
  check("forged base64 'role:admin' token", `HTTP ${r.status}, ${r.body.error?.message}`, r.status === 401);
  r = await rpc(gw, { jsonrpc: "2.0", id: 4, method: "tools/list" });
  check("no token", `HTTP ${r.status}`, r.status === 401);

  const stdio = new StdioDownstream(process.execPath, [TASK1], 5000);
  closers.push(() => stdio.close());
  const bridged = await listen(createGatewayApp({ auth, downstream: stdio }));
  r = await rpc(bridged, { jsonrpc: "2.0", id: "x1", method: "tools/list" }, viewer);
  check("gateway → Task 1 over stdio bridge", `tools: ${r.body.result?.tools?.map((t: any) => t.name).join(", ")}`, r.body.result?.tools?.length === 2);
  r = await rpc(bridged, call(5, "get_customer_record", { customer_id: "CUST-00456" }), viewer);
  check("bridged tools/call", `customer ${JSON.parse(r.body.result?.content?.[0]?.text ?? "{}").customer_id}`, r.body.id === 5);
}

async function task3() {
  header("Task 3 — streaming PII guardrail");
  const deltas = ["Sure. Email jane.d", "oe@exam", "ple.com, SSN 123-4", "5-6789, card 4111 11", "11 1111 1111, phone (555) 8", "67-5309."];
  console.log(C.dim(`  upstream deltas (split mid-PII, bytes sent 7 at a time): ${JSON.stringify(deltas)}`));
  const upstream = await mockSseUpstream((res) => writeInSlices(res, sseFrames(deltas), [7]));
  closers.push(() => upstream.close());
  const gw = await listen(createGuardrailApp({ upstreamBaseUrl: upstream.url, apiKey: "demo" }));
  const res = await fetch(`${gw}/v1/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "My SSN is 987-65-4321" }] }),
  });
  const raw = await res.text();
  const content = raw.split("\n\n").filter((f) => f.startsWith("data: {")).map((f) => JSON.parse(f.slice(6)).choices?.[0]?.delta?.content ?? "").join("");
  console.log(C.dim(`  client received: ${JSON.stringify(content)}`));
  const leaks = ["jane.doe", "123-45-6789", "4111", "867-5309"].filter((s) => raw.includes(s));
  check("outbound redaction", leaks.length ? `LEAKED ${leaks}` : "no PII in the stream", leaks.length === 0);
  check("inbound redaction", "prompt sent upstream", !JSON.stringify(upstream.requests[0].body).includes("987-65-4321"));
  check("[DONE] once", "terminator forwarded exactly once", raw.split("data: [DONE]").length === 2);
}

async function task4() {
  header("Task 4 — rate limiter (1,000 tokens/min for the demo) + failover");
  const primary = await mockOpenAI({ usage: false });
  const secondary = await mockAnthropic();
  closers.push(() => primary.close(), () => secondary.close());
  const limiter = new RateLimiter(openDatabase(":memory:"), { limit: 1000, windowMs: 60_000 });
  const router = new Router(
    new OpenAIAdapter({ baseUrl: primary.url, apiKey: "demo", defaultModel: "gpt-4o-mini" }),
    new AnthropicAdapter({ baseURL: secondary.url, apiKey: "demo", model: "claude-opus-5-5" }),
    { timeoutMs: 3000, maxJitterMs: 200 },
  );
  const key = "demo-tenant-key-0123456789";
  const url = await listen(createRouterApp({
    limiter, router, tokenizer: heuristicTokenizer, defaultOutputReservation: 0,
    tenants: new TenantRegistry([{ tenantId: "demo", apiKey: key }]),
  }));
  const post = (content: string, k = key) => fetch(`${url}/v1/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${k}` },
    body: JSON.stringify({ messages: [{ role: "user", content }] }),
  });

  const statuses: number[] = [];
  for (let i = 0; i < 4; i++) statuses.push((await post("x".repeat(1172))).status); // ≈300 tokens each
  check("sliding window", `statuses ${statuses.join(", ")}`, statuses.join() === "200,200,200,429");

  const burst = await Promise.all(Array.from({ length: 10 }, () => post("y".repeat(372), "demo-tenant-key-0123456789"))); // ≈100 each, 100 left
  check("concurrent burst", `${burst.filter((r) => r.status === 200).length}/10 admitted with 100 tokens left`, burst.filter((r) => r.status === 200).length === 1);

  const other = await fetch(`${url}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json", "X-Tenant-Key": "demo" }, body: "{}" });
  check("tenant auth", `X-Tenant-Key alone → HTTP ${other.status}`, other.status === 401);

  const fresh = new RateLimiter(openDatabase(":memory:"), { limit: 50_000, windowMs: 60_000 });
  const url2 = await listen(createRouterApp({ limiter: fresh, router, tokenizer: heuristicTokenizer, defaultOutputReservation: 0, tenants: new TenantRegistry([{ tenantId: "demo", apiKey: key }]) }));
  primary.options.mode = "429";
  const fb = await fetch(`${url2}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) });
  const fbBody = (await fb.json()) as any;
  check("primary 429 → Anthropic fallback", `HTTP ${fb.status}, X-Gateway-Fallback=${fb.headers.get("x-gateway-fallback")}, provider=${fbBody.provider}`, fb.status === 200 && fbBody.provider === "anthropic");
  check("Anthropic request format", `official SDK + anthropic-version, model ${secondary.requests[0]?.body?.model}`, !!secondary.requests[0]?.headers["anthropic-version"]);
  secondary.options.mode = "500";
  const both = await fetch(`${url2}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) });
  const bothText = await both.text();
  check("both providers down", `HTTP ${both.status} ${bothText}`, both.status === 502 && !bothText.includes("SECRET"));
}

async function main() {
  console.log(C.bold("\n🚀 QuilrAI Assessment — live demo (mock providers, no API keys)"));
  for (const section of [task1, task2, task3, task4]) {
    try {
      await section();
    } catch (err) {
      check(section.name, `crashed: ${(err as Error).message}`, false);
    }
  }
  console.log(`\n${C.bold(failed === 0 ? C.green(`  All ${passed} checks passed`) : C.red(`  ${failed} of ${passed + failed} checks FAILED`))}\n`);
  for (const close of closers.reverse()) await close().catch(() => {});
  process.exit(failed === 0 ? 0 : 1);
}

main();
