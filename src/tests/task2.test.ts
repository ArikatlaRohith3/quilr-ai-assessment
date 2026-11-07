import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createGatewayApp } from "../task2-mcp-gateway/index.js";
import { createMockDownstream } from "../task2-mcp-gateway/mock-downstream/index.js";
import { HttpDownstream, StdioDownstream } from "../task2-mcp-gateway/proxy.js";
import { signToken, verifyToken, AuthError, type AuthConfig } from "../task2-mcp-gateway/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpError, LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { serve, captureLogs, type Running } from "./helpers.js";

const auth: AuthConfig = { secret: "test-secret-0123456789-abcdefghijklmnop", issuer: "quilr-auth", audience: "quilr-mcp-gateway" };
const admin = signToken({ sub: "alice", role: "admin" }, auth);
const viewer = signToken({ sub: "bob", role: "viewer" }, auth);

async function rpc(url: string, body: unknown, token?: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: (await res.json()) as any };
}

const call = (id: unknown, name: unknown, args?: unknown) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, ...(args !== undefined ? { arguments: args } : {}) } });

describe("Task 2 — token verification (unit)", () => {
  const reason = (fn: () => unknown) => {
    try { fn(); return "accepted"; } catch (e) { assert.ok(e instanceof AuthError); return (e as AuthError).reason; }
  };

  test("valid token", () => assert.equal(verifyToken(admin, auth).role, "admin"));
  test("old forgeable base64 role token is rejected", () => {
    assert.equal(reason(() => verifyToken(Buffer.from("role:admin").toString("base64"), auth)), "malformed token");
  });
  test("wrong secret", () => {
    const t = signToken({ sub: "eve", role: "admin" }, { ...auth, secret: "another-secret-0123456789-abcdefghijk" });
    assert.equal(reason(() => verifyToken(t, auth)), "bad signature");
  });
  test("alg=none", () => {
    const h = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const p = Buffer.from(JSON.stringify({ sub: "eve", role: "admin", iss: auth.issuer, aud: auth.audience, exp: 9e9 })).toString("base64url");
    assert.match(reason(() => verifyToken(`${h}.${p}.`, auth)), /alg|signature/);
  });
  test("payload tampering (viewer → admin) breaks the signature", () => {
    const [h, p, s] = viewer.split(".");
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    const forged = Buffer.from(JSON.stringify({ ...claims, role: "admin" })).toString("base64url");
    assert.equal(reason(() => verifyToken(`${h}.${forged}.${s}`, auth)), "bad signature");
  });
  test("expired / wrong audience / wrong issuer / unknown role / missing exp", () => {
    assert.equal(reason(() => verifyToken(signToken({ sub: "a", role: "admin" }, auth, -120), auth)), "expired");
    assert.equal(reason(() => verifyToken(signToken({ sub: "a", role: "admin", aud: "other" }, auth), auth)), "wrong audience");
    assert.equal(reason(() => verifyToken(signToken({ sub: "a", role: "admin", iss: "evil" }, auth), auth)), "wrong issuer");
    assert.equal(reason(() => verifyToken(signToken({ sub: "a", role: "root" }, auth), auth)), "unknown role");
    assert.equal(reason(() => verifyToken(signToken({ sub: "a", role: "admin", exp: undefined }, auth), auth)), "missing exp");
  });
});

describe("Task 2 — gateway with HTTP downstream", () => {
  let down: Running;
  let gw: Running;
  const seenRequestIds: string[] = [];

  before(async () => {
    // Wrap the mock downstream to observe the propagated X-Request-ID.
    const spy = express();
    spy.use((req, _res, next) => { seenRequestIds.push(String(req.headers["x-request-id"])); next(); });
    spy.use(createMockDownstream());
    down = await serve(spy);
    gw = await serve(createGatewayApp({ auth, downstream: new HttpDownstream(down.url, 2000) }));
  });
  after(async () => { await gw.close(); await down.close(); });

  test("admin may call admin_ tool", async () => {
    const r = await rpc(gw.url, call(1, "admin_reset_key", {}), admin);
    assert.equal(r.status, 200);
    assert.equal(r.body.id, 1);
    assert.match(r.body.result.content[0].text, /admin_reset_key/);
  });

  test("viewer is blocked from admin_ tools with -32001 (any casing)", async () => {
    for (const name of ["admin_reset_key", "ADMIN_reset_key", "Admin_Purge_Cache"]) {
      const r = await rpc(gw.url, call("req-7", name, {}), viewer);
      assert.equal(r.status, 200, "JSON-RPC errors on well-formed requests use HTTP 200 (MCP Streamable HTTP)");
      assert.deepEqual(r.body, { jsonrpc: "2.0", id: "req-7", error: { code: -32001, message: "Unauthorized Tool Call" } });
    }
  });

  test("viewer may call non-admin tools and list tools", async () => {
    assert.equal((await rpc(gw.url, call(2, "get_data", {}), viewer)).body.result.content[0].text, "Executed tool: get_data");
    assert.equal((await rpc(gw.url, { jsonrpc: "2.0", id: 3, method: "tools/list" }, viewer)).body.result.tools.length, 3);
  });

  test("missing token → 401 -32000 with the request id preserved", async () => {
    const r = await rpc(gw.url, { jsonrpc: "2.0", id: 42, method: "tools/list" });
    assert.equal(r.status, 401);
    assert.deepEqual(r.body.error, { code: -32000, message: "Authentication required" });
    assert.equal(r.body.id, 42);
    assert.match(r.headers.get("www-authenticate") ?? "", /Bearer/);
  });

  test("forged tokens → 401", async () => {
    const forgedBase64 = Buffer.from("role:admin").toString("base64");
    const otherSecret = signToken({ sub: "eve", role: "admin" }, { ...auth, secret: "x".repeat(40) });
    for (const t of [forgedBase64, otherSecret, "a.b.c", "Bearer"]) {
      const r = await rpc(gw.url, call(5, "admin_reset_key", {}), t);
      assert.equal(r.status, 401, t);
      assert.equal(r.body.error.code, -32000);
    }
  });

  test("invalid JSON-RPC is rejected", async () => {
    const parse = await rpc(gw.url, "{not json", admin);
    assert.equal(parse.status, 400);
    assert.equal(parse.body.error.code, -32700);

    assert.equal((await rpc(gw.url, { id: 1, method: "tools/list" }, admin)).body.error.code, -32600); // no jsonrpc
    assert.equal((await rpc(gw.url, { jsonrpc: "2.0", id: null, method: "tools/list" }, admin)).body.error.code, -32600); // null id
    assert.equal((await rpc(gw.url, { jsonrpc: "2.0", id: { x: 1 }, method: "tools/list" }, admin)).body.error.code, -32600); // object id
    assert.equal((await rpc(gw.url, [call(1, "get_data")], admin)).body.error.code, -32600); // batch
    assert.equal((await rpc(gw.url, { jsonrpc: "2.0", id: 1, method: "resources/read" }, admin)).body.error.code, -32601);
  });

  test("malformed tools/call params → -32602", async () => {
    for (const bad of [call(9, undefined), call(9, 123), call(9, ""), call(9, " admin_x"), call(9, "get_data", [1, 2]), { jsonrpc: "2.0", id: 9, method: "tools/call", params: "x" }]) {
      const r = await rpc(gw.url, bad, admin);
      assert.equal(r.status, 200, JSON.stringify(bad));
      assert.equal(r.body.error.code, -32602, JSON.stringify(bad));
      assert.equal(r.body.id, 9);
    }
  });

  test("X-Request-ID is propagated (and generated when absent or unsafe)", async () => {
    const r = await rpc(gw.url, call(1, "get_data", {}), viewer, { "X-Request-ID": "trace-abc-123" });
    assert.equal(r.headers.get("x-request-id"), "trace-abc-123");
    assert.equal(seenRequestIds.at(-1), "trace-abc-123");
    const r2 = await rpc(gw.url, call(1, "get_data", {}), viewer, { "X-Request-ID": "bad id; <script>" });
    assert.match(r2.headers.get("x-request-id") ?? "", /^[A-Za-z0-9._-]{1,128}$/, "unsafe ids are replaced with a generated one");
    assert.notEqual(r2.headers.get("x-request-id"), "bad id; <script>");
  });

  test("audit log records decisions without leaking tokens or arguments", async () => {
    const { logs } = await captureLogs(async () => {
      await rpc(gw.url, call(1, "admin_reset_key", { note: "SECRET-ARG-123" }), viewer);
      await rpc(gw.url, call(2, "get_data", { note: "SECRET-ARG-456" }), viewer);
      await rpc(gw.url, call(3, "get_data", {}), "forged.token.value");
    });
    assert.match(logs, /"decision":"denied"/);
    assert.match(logs, /"decision":"allowed"/);
    assert.match(logs, /"decision":"unauthenticated"/);
    assert.match(logs, /"sub":"bob"/);
    assert.ok(!logs.includes(viewer), "token leaked into logs");
    assert.ok(!logs.includes("forged.token.value"), "presented credential leaked into logs");
    assert.ok(!logs.includes("SECRET-ARG"), "tool arguments leaked into logs");
  });
});

describe("Task 2 — downstream failures", () => {
  test("timeout → 504 -32003", async () => {
    const slow = await serve(createMockDownstream({ delayMs: 500 }));
    const gw = await serve(createGatewayApp({ auth, downstream: new HttpDownstream(slow.url, 100) }));
    try {
      const r = await rpc(gw.url, call(1, "get_data", {}), viewer);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { jsonrpc: "2.0", id: 1, error: { code: -32003, message: "Downstream MCP server timed out" } });
    } finally {
      await gw.close();
      await slow.close();
    }
  });

  test("unreachable or non-JSON downstream → 502 -32002 with no internal details", async () => {
    const html = express().post("/", (_q, s) => s.status(500).send("<pre>Error at /srv/app.js:42</pre>"));
    const bad = await serve(html);
    for (const url of ["http://127.0.0.1:1", bad.url]) {
      const gw = await serve(createGatewayApp({ auth, downstream: new HttpDownstream(url, 1000) }));
      const r = await rpc(gw.url, call(1, "get_data", {}), viewer);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.error, { code: -32002, message: "Downstream MCP server unavailable" });
      await gw.close();
    }
    await bad.close();
  });
});

describe("Task 2 + Task 1 — gateway bridged to the real MCP server over stdio", () => {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "../task1-mcp-server/index.js");
  let downstream: StdioDownstream;
  let gw: Running;
  before(async () => {
    downstream = new StdioDownstream(process.execPath, [script], 5000);
    gw = await serve(createGatewayApp({ auth, downstream }));
  });
  after(async () => { await gw.close(); await downstream.close(); });

  test("tools/list reaches Task 1 through the bridge", async () => {
    const r = await rpc(gw.url, { jsonrpc: "2.0", id: "list-1", method: "tools/list" }, viewer);
    assert.equal(r.body.id, "list-1");
    assert.deepEqual(r.body.result.tools.map((t: any) => t.name).sort(), ["get_customer_record", "trigger_refund"]);
  });

  test("Task 1 validation errors (-32602) pass through with the client's id", async () => {
    const r = await rpc(gw.url, call("abc", "get_customer_record", { customer_id: "INVALID" }), viewer);
    assert.equal(r.body.id, "abc");
    assert.equal(r.body.error.code, -32602);
  });

  test("concurrent clients reusing the same JSON-RPC id get their own responses", async () => {
    const ids = ["CUST-00123", "CUST-00456", "CUST-00789", "CUST-00123", "CUST-00456", "CUST-00789"];
    const replies = await Promise.all(ids.map((cid) => rpc(gw.url, call(1, "get_customer_record", { customer_id: cid }), viewer)));
    replies.forEach((r, i) => {
      assert.equal(r.body.id, 1);
      assert.equal(JSON.parse(r.body.result.content[0].text).customer_id, ids[i]);
    });
  });

  test("viewer is still blocked before anything reaches the MCP server", async () => {
    const r = await rpc(gw.url, call(1, "admin_reset_key", {}), viewer);
    assert.equal(r.body.error.code, -32001);
  });
});

// ─────────────── audit fix H1: real MCP clients can use the gateway ───────────────

async function sdkClient(url: string, token: string): Promise<Client> {
  const client = new Client({ name: "audit-probe", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

describe("Task 2 — MCP Streamable HTTP compliance (audit H1)", () => {
  let down: Running;
  let gw: Running;
  before(async () => {
    down = await serve(createMockDownstream());
    gw = await serve(createGatewayApp({ auth, downstream: new HttpDownstream(down.url, 2000) }));
  });
  after(async () => { await gw.close(); await down.close(); });

  test("initialize is answered by the gateway (version negotiated, tools capability only)", async () => {
    const init = (protocolVersion: string) => rpc(gw.url, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion, capabilities: {}, clientInfo: { name: "c", version: "1" } } }, viewer);
    const r = await init("2025-06-18");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.result, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "quilr-mcp-gateway", version: "2.1.0" } });
    assert.equal((await init("1999-01-01")).body.result.protocolVersion, LATEST_PROTOCOL_VERSION, "unknown versions fall back to the latest");
  });

  test("initialize still requires authentication", async () => {
    const r = await rpc(gw.url, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    assert.equal(r.status, 401);
    assert.equal(r.body.error.code, -32000);
  });

  test("notifications → 202 with no body; unauthenticated notifications → 401", async () => {
    const send = (token?: string) => fetch(gw.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    const ok = await send(viewer);
    assert.equal(ok.status, 202);
    assert.equal(await ok.text(), "");
    assert.equal((await send()).status, 401);
  });

  test("GET and DELETE → 405 (no SSE stream, no sessions)", async () => {
    for (const method of ["GET", "DELETE"]) {
      const r = await fetch(gw.url, { method, headers: { Authorization: `Bearer ${viewer}` } });
      assert.equal(r.status, 405, method);
      assert.equal(r.headers.get("allow"), "POST");
    }
  });

  test("official MCP SDK client: connect, list tools, call an allowed tool", async () => {
    const client = await sdkClient(gw.url, viewer);
    try {
      assert.deepEqual(client.getServerVersion(), { name: "quilr-mcp-gateway", version: "2.1.0" });
      assert.equal((await client.listTools()).tools.length, 3);
      const r = await client.callTool({ name: "get_data", arguments: {} });
      assert.equal((r.content as any)[0].text, "Executed tool: get_data");
    } finally {
      await client.close();
    }
  });

  test("official MCP SDK client: a blocked admin call surfaces as McpError -32001, not a transport error", async () => {
    const client = await sdkClient(gw.url, viewer);
    try {
      await assert.rejects(client.callTool({ name: "admin_reset_key", arguments: {} }), (err: unknown) => {
        assert.ok(err instanceof McpError, `expected McpError, got ${String(err)}`);
        assert.equal(err.code, -32001);
        return true;
      });
    } finally {
      await client.close();
    }
  });

  test("official MCP SDK client with a forged token cannot connect", async () => {
    await assert.rejects(sdkClient(gw.url, Buffer.from("role:admin").toString("base64")));
  });

  test("official MCP SDK client → gateway → real Task 1 server over stdio", async () => {
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "../task1-mcp-server/index.js");
    const downstream = new StdioDownstream(process.execPath, [script], 5000);
    const bridged = await serve(createGatewayApp({ auth, downstream }));
    const client = await sdkClient(bridged.url, viewer);
    try {
      assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), ["get_customer_record", "trigger_refund"]);
      const ok = await client.callTool({ name: "get_customer_record", arguments: { customer_id: "CUST-00123" } });
      assert.equal(JSON.parse((ok.content as any)[0].text).customer_id, "CUST-00123");
      await assert.rejects(client.callTool({ name: "get_customer_record", arguments: { customer_id: "INVALID" } }), (err: unknown) => {
        assert.ok(err instanceof McpError);
        assert.equal(err.code, -32602);
        return true;
      });
    } finally {
      await client.close();
      await bridged.close();
      await downstream.close();
    }
  });
});
