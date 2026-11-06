import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import type { JsonRpcId } from "../shared/errors.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("mcp-gateway");

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class DownstreamTimeoutError extends Error {
  constructor() { super("downstream timed out"); }
}
export class DownstreamError extends Error {}

/** Something that can answer a single MCP JSON-RPC request. */
export interface Downstream {
  readonly kind: string;
  send(request: JsonRpcRequest, ctx: { requestId: string }): Promise<JsonRpcResponse>;
  close(): Promise<void>;
}

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.jsonrpc !== "2.0") return false;
  if ("error" in v) {
    const e = v.error as Record<string, unknown> | null;
    return !!e && typeof e.code === "number" && typeof e.message === "string";
  }
  return "result" in v;
}

/** Returns a copy of the downstream reply carrying the client's original id (and nothing unexpected). */
function withOriginalId(reply: JsonRpcResponse, id: JsonRpcId): JsonRpcResponse {
  return reply.error
    ? { jsonrpc: "2.0", id, error: { code: reply.error.code, message: reply.error.message } }
    : { jsonrpc: "2.0", id, result: reply.result };
}

// ── HTTP downstream (e.g. the mock server, or any MCP server behind HTTP) ─────
export class HttpDownstream implements Downstream {
  readonly kind = "http";
  constructor(private readonly url: string, private readonly timeoutMs: number) {}

  async send(request: JsonRpcRequest, ctx: { requestId: string }): Promise<JsonRpcResponse> {
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Request-ID": ctx.requestId },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if ((err as Error).name === "TimeoutError" || (err as Error).name === "AbortError") throw new DownstreamTimeoutError();
      throw new DownstreamError(`unreachable: ${(err as Error).message}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new DownstreamError(`non-JSON response (HTTP ${res.status})`);
    }
    if (!isJsonRpcResponse(body)) throw new DownstreamError(`invalid JSON-RPC response (HTTP ${res.status})`);
    return withOriginalId(body, request.id);
  }

  async close(): Promise<void> {}
}

// ── stdio downstream: HTTP → MCP bridge to the Task 1 server ──────────────────
/**
 * Spawns an MCP server as a child process and speaks newline-delimited JSON-RPC
 * over its stdin/stdout (the MCP stdio transport).
 *
 *  - Performs the MCP `initialize` handshake once, then multiplexes requests.
 *  - Concurrent clients may reuse the same JSON-RPC id, so each request gets a
 *    unique internal id; the client's original id is restored on the reply.
 *  - A request that exceeds the timeout is rejected and its late reply dropped.
 *  - If the child dies, pending requests fail and the next request restarts it.
 */
export class StdioDownstream implements Downstream {
  readonly kind = "stdio";
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<string, { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private stdoutBuffer = "";

  constructor(private readonly command: string, private readonly args: string[], private readonly timeoutMs: number) {}

  private start(): Promise<void> {
    const child = spawn(this.command, this.args, { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.stdoutBuffer = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => log.debug("downstream stderr", { line: chunk.trim().slice(0, 500) }));
    child.on("exit", (code) => {
      log.warn("downstream process exited", { code });
      if (this.child === child) {
        this.child = null;
        this.ready = null;
      }
      this.failAll(new DownstreamError("downstream process exited"));
    });
    child.on("error", (err) => this.failAll(new DownstreamError(`spawn failed: ${err.message}`)));

    return this.call("initialize", {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "quilr-mcp-gateway", version: "2.0.0" },
    }).then((reply) => {
      if (reply.error) throw new DownstreamError(`initialize failed: ${reply.error.message}`);
      this.write({ jsonrpc: "2.0", method: "notifications/initialized" });
      log.info("downstream MCP session initialized", { kind: this.kind });
    });
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline: number;
    while ((newline = this.stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        log.warn("downstream wrote a non-JSON line to stdout");
        continue;
      }
      const id = (msg as { id?: unknown }).id;
      const entry = typeof id === "string" ? this.pending.get(id) : undefined;
      if (!entry) continue; // notification, or a reply that already timed out
      this.pending.delete(id as string);
      clearTimeout(entry.timer);
      if (isJsonRpcResponse(msg)) entry.resolve(msg);
      else entry.reject(new DownstreamError("invalid JSON-RPC response"));
    }
  }

  private write(message: object): void {
    if (!this.child) throw new DownstreamError("downstream not running");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  private call(method: string, params: unknown): Promise<JsonRpcResponse> {
    const internalId = `gw-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(internalId);
        reject(new DownstreamTimeoutError());
      }, this.timeoutMs);
      this.pending.set(internalId, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: "2.0", id: internalId, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(internalId);
        reject(err);
      }
    });
  }

  private failAll(err: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
      this.pending.delete(id);
    }
  }

  async send(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (!this.ready) {
      this.ready = this.start().catch((err) => {
        this.ready = null;
        this.child?.kill();
        throw err;
      });
    }
    await this.ready;
    const reply = await this.call(request.method, request.params ?? {});
    return withOriginalId(reply, request.id);
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.ready = null;
    if (!child) return;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill();
    });
  }
}
