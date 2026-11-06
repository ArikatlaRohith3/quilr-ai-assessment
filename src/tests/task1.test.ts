import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { GetCustomerRecordInput, TriggerRefundInput } from "../task1-mcp-server/schemas.js";
import { startServer } from "../task1-mcp-server/index.js";
import "./helpers.js";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "../task1-mcp-server/index.js");
const VALID_REASON = "Product defective on arrival";

/**
 * Minimal stdio JSON-RPC client that writes raw text, so tests can send things a
 * typed client can't (1e400, invalid JSON, non-JSON-RPC objects).
 */
class StdioClient {
  readonly proc: ChildProcessWithoutNullStreams;
  readonly stdoutLines: string[] = [];
  stderr = "";
  private buf = "";
  private waiters = new Map<string | number | null, (msg: any) => void>();
  readonly exited: Promise<number | null>;

  constructor() {
    this.proc = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, LOG_LEVEL: "debug" } });
    this.exited = new Promise((resolve) => this.proc.once("exit", (code) => resolve(code)));
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => {
      this.buf += chunk;
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        if (!line.trim()) continue;
        this.stdoutLines.push(line);
        const msg = JSON.parse(line);
        this.waiters.get(msg.id)?.(msg);
        this.waiters.delete(msg.id);
      }
    });
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (c: string) => (this.stderr += c));
  }

  /** Sends one raw line and resolves with the response carrying `id` (null for parse errors). */
  sendRaw(id: number | string | null, raw: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for id ${id}`)), 5000);
      this.waiters.set(id, (m) => { clearTimeout(t); resolve(m); });
      this.proc.stdin.write(raw + "\n");
    });
  }

  request(id: number, method: string, params: unknown): Promise<any> {
    return this.sendRaw(id, JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  }

  call(id: number, name: string, args?: unknown): Promise<any> {
    return this.request(id, "tools/call", args === undefined ? { name } : { name, arguments: args });
  }

  async init(): Promise<void> {
    const r = await this.request(0, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    assert.ok(r.result, "initialize should succeed");
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }

  close(): void {
    this.proc.kill();
  }
}

/** Runs an ES module snippet in a fresh Node process and returns its exit code and output. */
function runSnippet(code: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, LOG_LEVEL: "info" } });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (c) => (stdout += c));
    p.stderr.on("data", (c) => (stderr += c));
    p.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

// ───────────────────────────── schema unit tests ─────────────────────────────

describe("Task 1 — schemas (unit)", () => {
  const refund = (over: Record<string, unknown>) => TriggerRefundInput.safeParse({ customer_id: "CUST-00123", amount: 5, reason: VALID_REASON, ...over });

  test("valid customer IDs", () => {
    for (const ok of ["CUST-00000", "CUST-99999", "CUST-00123"]) assert.ok(GetCustomerRecordInput.safeParse({ customer_id: ok }).success, ok);
  });

  test("invalid customer IDs (exactly five ASCII digits, no padding, case-sensitive)", () => {
    for (const bad of ["", "CUST-0012", "CUST-001234", "cust-00123", "CUST_00123", " CUST-00123", "CUST-00123 ", "CUST-00123\n", "CUST-0012a", "CUST-１２３４５", "XCUST-00123"]) {
      assert.equal(GetCustomerRecordInput.safeParse({ customer_id: bad }).success, false, JSON.stringify(bad));
    }
    assert.equal(GetCustomerRecordInput.safeParse({ customer_id: 12345 }).success, false);
    assert.equal(GetCustomerRecordInput.safeParse({ customer_id: null }).success, false);
  });

  test("negative and zero amounts are rejected", () => {
    for (const bad of [0, -0, -1, -0.01]) assert.equal(refund({ amount: bad }).success, false, String(bad));
  });

  test("NaN and ±Infinity are rejected with a 'finite' message", () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const r = refund({ amount: bad });
      assert.equal(r.success, false, String(bad));
      assert.match(r.error!.issues[0].message, /finite/);
    }
  });

  test("amount: non-numbers, > max and > 2 decimals are rejected; valid amounts pass", () => {
    for (const bad of ["10", null, true, 1.234, 10000.01]) assert.equal(refund({ amount: bad }).success, false, String(bad));
    for (const ok of [0.01, 1, 49.99, 10000]) assert.ok(refund({ amount: ok }).success, String(ok));
  });

  test("reason needs ≥ 10 non-whitespace characters", () => {
    for (const bad of ["", "          ", "\t\n  \r ", "short", "a         b", "x . . . . . . .", "123456789"]) {
      assert.equal(refund({ reason: bad }).success, false, JSON.stringify(bad));
    }
    assert.ok(refund({ reason: "abcdefghij" }).success, "exactly 10 non-whitespace chars");
    assert.ok(refund({ reason: "a b c d e f g h i j" }).success, "10 non-whitespace chars with spaces between");
    const r = refund({ reason: "   Product defective   " });
    assert.ok(r.success);
    assert.equal(r.data.reason, "Product defective", "surrounding whitespace is trimmed");
    assert.equal(refund({ reason: "x".repeat(501) }).success, false, "max 500");
  });

  test("missing required fields are rejected", () => {
    assert.equal(GetCustomerRecordInput.safeParse({}).success, false);
    for (const field of ["customer_id", "amount", "reason"]) {
      const args: Record<string, unknown> = { customer_id: "CUST-00123", amount: 5, reason: VALID_REASON };
      delete args[field];
      const r = TriggerRefundInput.safeParse(args);
      assert.equal(r.success, false, field);
      assert.deepEqual(r.error!.issues[0].path, [field]);
      assert.equal(r.error!.issues[0].message, "is required");
    }
  });

  test("unexpected fields are rejected (strict)", () => {
    assert.equal(GetCustomerRecordInput.safeParse({ customer_id: "CUST-00123", include_ssn: true }).success, false);
    assert.equal(refund({ approved_by: "admin" }).success, false);
  });

  test("valid refund request", () => {
    const r = TriggerRefundInput.safeParse({ customer_id: "CUST-00123", amount: 49.99, reason: VALID_REASON });
    assert.ok(r.success);
    assert.deepEqual(r.data, { customer_id: "CUST-00123", amount: 49.99, reason: VALID_REASON });
  });
});

// ─────────────────────── real server over stdio (JSON-RPC) ───────────────────────

describe("Task 1 — MCP server over stdio (JSON-RPC)", () => {
  let c: StdioClient;
  let id = 100;
  before(async () => { c = new StdioClient(); await c.init(); });
  after(() => c.close());

  /** Asserts a real JSON-RPC error -32602 (not a result with isError) and returns it. */
  const expectInvalidParams = (r: any, field?: string, fragment?: RegExp) => {
    assert.equal(r.result, undefined, `expected a JSON-RPC error, got result ${JSON.stringify(r.result)}`);
    assert.equal(r.error?.code, -32602, JSON.stringify(r));
    if (field) assert.ok(r.error.data?.issues?.some((i: any) => i.field === field), `issue for ${field}: ${JSON.stringify(r.error)}`);
    if (fragment) assert.match(r.error.message, fragment);
    return r.error;
  };
  const refund = (over: Record<string, unknown>) => c.call(id++, "trigger_refund", { customer_id: "CUST-00123", amount: 5, reason: VALID_REASON, ...over });

  test("tools/list advertises both tools with strict JSON schemas", async () => {
    const r = await c.request(id++, "tools/list", {});
    const byName = Object.fromEntries(r.result.tools.map((t: any) => [t.name, t]));
    assert.deepEqual(Object.keys(byName).sort(), ["get_customer_record", "trigger_refund"]);
    for (const t of r.result.tools) {
      assert.equal(t.inputSchema.type, "object");
      assert.equal(t.inputSchema.additionalProperties, false);
    }
    assert.deepEqual(byName.trigger_refund.inputSchema.required.sort(), ["amount", "customer_id", "reason"]);
    assert.equal(byName.get_customer_record.inputSchema.properties.customer_id.pattern, "^CUST-\\d{5}$");
  });

  test("valid customer ID → result", async () => {
    const r = await c.call(id++, "get_customer_record", { customer_id: "CUST-00123" });
    assert.equal(r.error, undefined);
    assert.equal(r.result.isError, undefined);
    assert.equal(JSON.parse(r.result.content[0].text).customer_id, "CUST-00123");
  });

  test("invalid customer ID → -32602 with the exact error shape", async () => {
    const rid = id++;
    const r = await c.call(rid, "get_customer_record", { customer_id: "INVALID" });
    assert.deepEqual(r, {
      jsonrpc: "2.0",
      id: rid,
      error: {
        code: -32602,
        message: "MCP error -32602: Invalid params: customer_id: must match format CUST-XXXXX (exactly five digits, e.g. CUST-00123)",
        data: { issues: [{ field: "customer_id", message: "must match format CUST-XXXXX (exactly five digits, e.g. CUST-00123)" }] },
      },
    });
    expectInvalidParams(await c.call(id++, "get_customer_record", { customer_id: "CUST-1234" }), "customer_id");
    expectInvalidParams(await c.call(id++, "get_customer_record", { customer_id: 12345 }), "customer_id", /must be a string/);
  });

  test("negative refund amount → -32602", async () => {
    expectInvalidParams(await refund({ amount: -5 }), "amount", /greater than 0/);
  });

  test("zero refund amount → -32602", async () => {
    expectInvalidParams(await refund({ amount: 0 }), "amount", /greater than 0/);
  });

  test("Infinity (1e400 on the wire) → -32602", async () => {
    const rid = id++;
    const raw = `{"jsonrpc":"2.0","id":${rid},"method":"tools/call","params":{"name":"trigger_refund","arguments":{"customer_id":"CUST-00123","amount":1e400,"reason":"${VALID_REASON}"}}}`;
    expectInvalidParams(await c.sendRaw(rid, raw), "amount", /finite/);
    expectInvalidParams(await c.sendRaw(id, raw.replace(`"id":${rid}`, `"id":${id++}`).replace("1e400", "-1e400")), "amount", /finite/);
  });

  test("NaN → rejected (NaN is not valid JSON: -32700 parse error; null / \"NaN\" → -32602)", async () => {
    // JSON has no NaN literal, so a client can only send it as invalid JSON, null or a string.
    const raw = `{"jsonrpc":"2.0","id":${id++},"method":"tools/call","params":{"name":"trigger_refund","arguments":{"customer_id":"CUST-00123","amount":NaN,"reason":"${VALID_REASON}"}}}`;
    const r = await c.sendRaw(null, raw);
    assert.deepEqual(r, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    expectInvalidParams(await refund({ amount: null }), "amount", /must be a number/);
    expectInvalidParams(await refund({ amount: "NaN" }), "amount", /must be a number/);
  });

  test("empty refund reason → -32602", async () => {
    expectInvalidParams(await refund({ reason: "" }), "reason", /10 non-whitespace/);
  });

  test("reason containing only spaces → -32602", async () => {
    expectInvalidParams(await refund({ reason: "               " }), "reason", /10 non-whitespace/);
    expectInvalidParams(await refund({ reason: "a         b" }), "reason", /10 non-whitespace/);
  });

  test("missing required fields → -32602 naming every missing field", async () => {
    expectInvalidParams(await c.call(id++, "get_customer_record", {}), "customer_id", /is required/);
    const err = expectInvalidParams(await c.call(id++, "trigger_refund", {}));
    assert.deepEqual(err.data.issues.map((i: any) => i.field).sort(), ["amount", "customer_id", "reason"]);
    expectInvalidParams(await c.call(id++, "trigger_refund", { customer_id: "CUST-00123" }), "amount", /amount: is required/);
    // No `arguments` key at all is treated as {}.
    expectInvalidParams(await c.call(id++, "get_customer_record"), "customer_id", /is required/);
  });

  test("unexpected fields → -32602", async () => {
    expectInvalidParams(await c.call(id++, "get_customer_record", { customer_id: "CUST-00123", include_ssn: true }), "arguments", /unknown field\(s\) include_ssn/);
    expectInvalidParams(await refund({ approved_by: "admin" }), "arguments", /unknown field\(s\) approved_by/);
  });

  test("valid refund request → result with trimmed reason", async () => {
    const r = await c.call(id++, "trigger_refund", { customer_id: "CUST-00123", amount: 49.99, reason: `  ${VALID_REASON}  ` });
    assert.equal(r.error, undefined);
    assert.equal(r.result.isError, undefined);
    const body = JSON.parse(r.result.content[0].text);
    assert.equal(body.status, "processed");
    assert.equal(body.amount, 49.99);
    assert.equal(body.reason, VALID_REASON);
    assert.match(body.refund_id, /^REF-[0-9a-f-]{36}$/);
  });

  test("business failures on valid input stay tool results (isError), not protocol errors", async () => {
    assert.equal((await c.call(id++, "get_customer_record", { customer_id: "CUST-99999" })).result.isError, true);
    assert.equal((await refund({ customer_id: "CUST-00789" })).result.isError, true, "suspended account");
  });

  test("unknown tool → -32602", async () => {
    expectInvalidParams(await c.call(id++, "drop_database", {}), undefined, /Unknown tool/);
  });

  test("valid JSON that isn't JSON-RPC → -32600, and the server keeps serving", async () => {
    const r = await c.sendRaw(null, JSON.stringify({ hello: "world" }));
    assert.deepEqual(r, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
    const ok = await c.call(id++, "get_customer_record", { customer_id: "CUST-00456" });
    assert.equal(JSON.parse(ok.result.content[0].text).customer_id, "CUST-00456");
  });

  test("stdout carries only JSON-RPC frames; logs go to stderr without submitted values", () => {
    assert.ok(c.stdoutLines.length > 15);
    for (const line of c.stdoutLines) assert.equal(JSON.parse(line).jsonrpc, "2.0", line);
    assert.match(c.stderr, /"msg":"invalid arguments"/);
    assert.ok(!c.stderr.includes(VALID_REASON), "the free-text refund reason must never be logged");
  });
});

// ─────────────────────── startup, shutdown and stdout protection ───────────────────────

describe("Task 1 — startup and shutdown", () => {
  const moduleUrl = pathToFileURL(SERVER).href;

  test("startServer rejects when the transport fails to start", async () => {
    const broken: Transport = {
      start: async () => { throw new Error("stdio unavailable"); },
      send: async () => {},
      close: async () => {},
    };
    await assert.rejects(startServer(broken), /stdio unavailable/);
  });

  test("a startup failure is logged to stderr and exits with code 1 — stdout stays empty", async () => {
    const r = await runSnippet(`
      import { runOrExit } from ${JSON.stringify(moduleUrl)};
      runOrExit(() => Promise.reject(new Error("transport failed to start")));
    `);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "");
    const fatal = r.stderr.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.msg === "fatal");
    assert.deepEqual({ stage: fatal.stage, error: fatal.error }, { stage: "startup", error: "transport failed to start" });
  });

  test("an uncaught exception after startup exits 1 with a logged reason", async () => {
    const r = await runSnippet(`
      import { runOrExit } from ${JSON.stringify(moduleUrl)};
      runOrExit(() => new Promise(() => { setTimeout(() => { throw new Error("boom"); }, 10); }));
    `);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /"stage":"uncaughtException","error":"boom"/);
  });

  test("protectStdout redirects stray console.log output to stderr", async () => {
    const r = await runSnippet(`
      import { protectStdout } from ${JSON.stringify(moduleUrl)};
      protectStdout();
      console.log("stray debug output", { a: 1 });
      console.info("more noise");
    `);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /stray debug output \{ a: 1 \}/);
    assert.match(r.stderr, /more noise/);
  });

  test("closing stdin shuts the server down cleanly (exit 0)", async () => {
    const c = new StdioClient();
    await c.init();
    c.proc.stdin.end();
    assert.equal(await c.exited, 0);
    assert.match(c.stderr, /"msg":"shutting down","reason":"stdin closed"/);
  });
});
