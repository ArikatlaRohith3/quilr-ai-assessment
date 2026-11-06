import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GetCustomerRecordInput, TriggerRefundInput } from "../task1-mcp-server/schemas.js";
import "./helpers.js";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "../task1-mcp-server/index.js");

/** Minimal stdio JSON-RPC client that sends raw text, so tests can send things a typed client wouldn't (e.g. 1e400). */
class StdioClient {
  private proc: ChildProcessWithoutNullStreams;
  private buf = "";
  readonly stdoutLines: string[] = [];
  private waiters = new Map<string | number, (msg: any) => void>();

  constructor() {
    this.proc = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, LOG_LEVEL: "debug" } });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (c: string) => {
      this.buf += c;
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
    this.proc.stderr.resume();
  }

  sendRaw(id: number | string, raw: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for id ${id}`)), 5000);
      this.waiters.set(id, (m) => { clearTimeout(t); resolve(m); });
      this.proc.stdin.write(raw + "\n");
    });
  }

  request(id: number, method: string, params: unknown): Promise<any> {
    return this.sendRaw(id, JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  }

  call(id: number, name: string, args: unknown): Promise<any> {
    return this.request(id, "tools/call", { name, arguments: args });
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

describe("Task 1 — schemas (unit)", () => {
  test("customer_id edge cases", () => {
    for (const ok of ["CUST-00000", "CUST-99999", "CUST-00123"]) assert.ok(GetCustomerRecordInput.safeParse({ customer_id: ok }).success, ok);
    for (const bad of ["", "CUST-0012", "CUST-001234", "cust-00123", "CUST_00123", " CUST-00123", "CUST-00123 ", "CUST-00123\n", "CUST-0012a", "CUST-１２３４５", "XCUST-00123"]) {
      assert.equal(GetCustomerRecordInput.safeParse({ customer_id: bad }).success, false, JSON.stringify(bad));
    }
    assert.equal(GetCustomerRecordInput.safeParse({ customer_id: 12345 }).success, false);
    assert.equal(GetCustomerRecordInput.safeParse({}).success, false);
  });

  test("amount must be finite, positive, ≤ max, ≤ 2 decimals", () => {
    const base = { customer_id: "CUST-00123", reason: "Item arrived broken" };
    for (const ok of [0.01, 1, 49.99, 10000]) assert.ok(TriggerRefundInput.safeParse({ ...base, amount: ok }).success, String(ok));
    for (const bad of [0, -1, -0.01, Infinity, -Infinity, NaN, 1.234, 10000.01, "10"]) {
      assert.equal(TriggerRefundInput.safeParse({ ...base, amount: bad }).success, false, String(bad));
    }
  });

  test("reason is trimmed before the length check", () => {
    const base = { customer_id: "CUST-00123", amount: 5 };
    assert.equal(TriggerRefundInput.safeParse({ ...base, reason: "short" }).success, false);
    assert.equal(TriggerRefundInput.safeParse({ ...base, reason: "     x      " }).success, false);
    assert.equal(TriggerRefundInput.safeParse({ ...base, reason: "          " }).success, false);
    const r = TriggerRefundInput.safeParse({ ...base, reason: "   Product defective   " });
    assert.ok(r.success);
    assert.equal(r.data.reason, "Product defective");
  });

  test("unknown fields are rejected (strict)", () => {
    assert.equal(GetCustomerRecordInput.safeParse({ customer_id: "CUST-00123", include_ssn: true }).success, false);
    assert.equal(TriggerRefundInput.safeParse({ customer_id: "CUST-00123", amount: 5, reason: "Product defective", approved_by: "admin" }).success, false);
  });
});

describe("Task 1 — MCP server over stdio (JSON-RPC)", () => {
  let c: StdioClient;
  let id = 100;
  before(async () => { c = new StdioClient(); await c.init(); });
  after(() => c.close());

  const expectInvalidParams = (r: any, fragment?: string) => {
    assert.equal(r.result, undefined, `expected a JSON-RPC error, got result ${JSON.stringify(r.result)}`);
    assert.equal(r.error?.code, -32602, JSON.stringify(r));
    if (fragment) assert.match(r.error.message, new RegExp(fragment));
  };

  test("tools/list advertises both tools with strict JSON schemas", async () => {
    const r = await c.request(id++, "tools/list", {});
    const names = r.result.tools.map((t: any) => t.name).sort();
    assert.deepEqual(names, ["get_customer_record", "trigger_refund"]);
    for (const t of r.result.tools) {
      assert.equal(t.inputSchema.type, "object");
      assert.equal(t.inputSchema.additionalProperties, false);
    }
  });

  test("valid customer → result", async () => {
    const r = await c.call(id++, "get_customer_record", { customer_id: "CUST-00123" });
    assert.equal(r.result.isError, undefined);
    assert.equal(JSON.parse(r.result.content[0].text).customer_id, "CUST-00123");
  });

  test("well-formed but unknown customer → tool error (isError), not a protocol error", async () => {
    const r = await c.call(id++, "get_customer_record", { customer_id: "CUST-99999" });
    assert.equal(r.result.isError, true);
  });

  test("invalid customer format → -32602", async () => {
    expectInvalidParams(await c.call(id++, "get_customer_record", { customer_id: "INVALID" }), "customer_id");
    expectInvalidParams(await c.call(id++, "get_customer_record", { customer_id: "CUST-1234" }));
    expectInvalidParams(await c.call(id++, "get_customer_record", { customer_id: 12345 }));
  });

  test("missing fields → -32602", async () => {
    expectInvalidParams(await c.call(id++, "get_customer_record", {}), "customer_id");
    expectInvalidParams(await c.call(id++, "trigger_refund", { customer_id: "CUST-00123" }), "amount");
  });

  test("unknown fields → -32602", async () => {
    expectInvalidParams(await c.call(id++, "get_customer_record", { customer_id: "CUST-00123", extra: 1 }), "unknown field");
  });

  test("valid refund → result with trimmed reason", async () => {
    const r = await c.call(id++, "trigger_refund", { customer_id: "CUST-00123", amount: 49.99, reason: "  Product defective on arrival  " });
    const body = JSON.parse(r.result.content[0].text);
    assert.equal(body.status, "processed");
    assert.equal(body.reason, "Product defective on arrival");
  });

  test("negative / zero / non-finite / over-precise amounts → -32602", async () => {
    const base = { customer_id: "CUST-00123", reason: "Product defective" };
    expectInvalidParams(await c.call(id++, "trigger_refund", { ...base, amount: -5 }), "amount");
    expectInvalidParams(await c.call(id++, "trigger_refund", { ...base, amount: 0 }), "amount");
    expectInvalidParams(await c.call(id++, "trigger_refund", { ...base, amount: 1.005 }), "decimal");
    expectInvalidParams(await c.call(id++, "trigger_refund", { ...base, amount: "10" }), "amount");
    // 1e400 parses to Infinity — must be rejected by .finite()
    const rid = id++;
    const raw = `{"jsonrpc":"2.0","id":${rid},"method":"tools/call","params":{"name":"trigger_refund","arguments":{"customer_id":"CUST-00123","amount":1e400,"reason":"Product defective"}}}`;
    expectInvalidParams(await c.sendRaw(rid, raw), "finite");
  });

  test("short or whitespace-padded reason → -32602", async () => {
    const base = { customer_id: "CUST-00123", amount: 5 };
    expectInvalidParams(await c.call(id++, "trigger_refund", { ...base, reason: "short" }), "reason");
    expectInvalidParams(await c.call(id++, "trigger_refund", { ...base, reason: "    abc        " }), "reason");
  });

  test("unknown tool → -32602", async () => {
    expectInvalidParams(await c.call(id++, "drop_database", {}), "Unknown tool");
  });

  test("stdout carries only JSON-RPC frames (logs go to stderr)", () => {
    assert.ok(c.stdoutLines.length > 10);
    for (const line of c.stdoutLines) assert.equal(JSON.parse(line).jsonrpc, "2.0");
  });
});
