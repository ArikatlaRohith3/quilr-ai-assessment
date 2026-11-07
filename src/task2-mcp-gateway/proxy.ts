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

/** Largest downstream response the gateway will buffer. */
export const MAX_RESPONSE_BYTES = 1_000_000;
/** error.data larger than this is dropped (it's meant for small structured details such as validation issues). */
const MAX_ERROR_DATA_BYTES = 8_192;

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

/**
 * Returns a copy of the downstream reply carrying the client's original id and
 * nothing unexpected. `error.data` is kept (e.g. Task 1's per-field validation
 * issues) when it is small; oversized data is dropped.
 */
function withOriginalId(reply: JsonRpcResponse, id: JsonRpcId): JsonRpcResponse {
  if (!reply.error) return { jsonrpc: "2.0", id, result: reply.result };
  const error: JsonRpcResponse["error"] = { code: reply.error.code, message: reply.error.message };
  if (reply.error.data !== undefined) {
    const size = Buffer.byteLength(JSON.stringify(reply.error.data) ?? "");
    if (size <= MAX_ERROR_DATA_BYTES) error.data = reply.error.data;
  }
  return { jsonrpc: "2.0", id, error };
}

// ── HTTP downstream (e.g. the mock server, or any MCP server behind HTTP) ─────
export class HttpDownstream implements Downstream {
  readonly kind = "http";
  constructor(private readonly url: string, private readonly timeoutMs: number) {}

  async send(request: JsonRpcRequest, ctx: { requestId: string }): Promise<JsonRpcResponse> {
    // One signal bounds the whole exchange: connecting, headers AND reading the body.
    const signal = AbortSignal.timeout(this.timeoutMs);
    let text: string;
    let status: number;
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Request-ID": ctx.requestId },
        body: JSON.stringify(request),
        signal,
      });
      status = res.status;
      text = await readCapped(res);
    } catch (err) {
      if (signal.aborted) throw new DownstreamTimeoutError();
      if (err instanceof DownstreamError) throw err;
      throw new DownstreamError(`unreachable: ${(err as Error).message}`);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new DownstreamError(`non-JSON response (HTTP ${status})`);
    }
    if (!isJsonRpcResponse(body)) throw new DownstreamError(`invalid JSON-RPC response (HTTP ${status})`);
    return withOriginalId(body, request.id);
  }

  async close(): Promise<void> {}
}

/** Reads a response body, refusing to buffer more than MAX_RESPONSE_BYTES. */
async function readCapped(res: Response): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (declared > MAX_RESPONSE_BYTES) {
    await res.body?.cancel().catch(() => {});
    throw new DownstreamError(`response too large (${declared} bytes)`);
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new DownstreamError(`response too large (> ${MAX_RESPONSE_BYTES} bytes)`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// ── stdio downstream: HTTP → MCP bridge to the Task 1 server ──────────────────
export interface StdioDownstreamOptions {
  /** After this many timeouts in a row the child is considered hung and is restarted. */
  maxConsecutiveTimeouts?: number;
  /** A child that exits sooner than this after starting counts as a crash for backoff purposes. */
  crashWindowMs?: number;
  /** First restart delay after a crash; doubles per consecutive crash. */
  initialBackoffMs?: number;
  /** Upper bound for the restart delay. */
  maxBackoffMs?: number;
}

/**
 * Spawns an MCP server as a child process and speaks newline-delimited JSON-RPC
 * over its stdin/stdout (the MCP stdio transport).
 *
 *  - Performs the MCP `initialize` handshake once, then multiplexes requests.
 *  - Concurrent clients may reuse the same JSON-RPC id, so each request gets a
 *    unique internal id; the client's original id is restored on the reply.
 *  - A request that exceeds the timeout is rejected, the child is told with
 *    `notifications/cancelled`, and its late reply is dropped.
 *  - A child that stops answering (N timeouts in a row) is killed and restarted.
 *  - A child that keeps crashing is restarted with exponential backoff; while
 *    backing off, requests fail fast instead of spawning a process each time.
 */
export class StdioDownstream implements Downstream {
  readonly kind = "stdio";
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<string, { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; owner: ChildProcessWithoutNullStreams | null }>();
  /** Children we killed on purpose (hung): their exit is not a crash. */
  private readonly retired = new WeakSet<ChildProcessWithoutNullStreams>();
  private stdoutBuffer = "";
  private startedAt = 0;
  private consecutiveTimeouts = 0;
  private crashes = 0;
  private restartNotBefore = 0;
  private closed = false;
  /** Number of child processes started so far (for health reporting and tests). */
  spawnCount = 0;

  private readonly opts: Required<StdioDownstreamOptions>;

  constructor(private readonly command: string, private readonly args: string[], private readonly timeoutMs: number, opts: StdioDownstreamOptions = {}) {
    this.opts = {
      maxConsecutiveTimeouts: opts.maxConsecutiveTimeouts ?? 2,
      crashWindowMs: opts.crashWindowMs ?? 5_000,
      initialBackoffMs: opts.initialBackoffMs ?? 250,
      maxBackoffMs: opts.maxBackoffMs ?? 5_000,
    };
  }

  private start(): Promise<void> {
    const child = spawn(this.command, this.args, { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.stdoutBuffer = "";
    this.startedAt = Date.now();
    this.consecutiveTimeouts = 0;
    this.spawnCount++;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => log.debug("downstream stderr", { line: chunk.trim().slice(0, 500) }));
    // A write to a child that has closed its stdin raises EPIPE here; without a listener it would crash the gateway.
    child.stdin.on("error", (err) => log.warn("downstream stdin error", { error: err.message }));
    child.on("exit", (code) => this.onExit(child, code));
    child.on("error", (err) => this.failAll(new DownstreamError(`spawn failed: ${err.message}`), child));

    return this.call("initialize", {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "quilr-mcp-gateway", version: "2.1.0" },
    }).then((reply) => {
      if (reply.error) throw new DownstreamError(`initialize failed: ${reply.error.message}`);
      this.write({ jsonrpc: "2.0", method: "notifications/initialized" });
      log.info("downstream MCP session initialized", { kind: this.kind, spawn: this.spawnCount });
    });
  }

  private onExit(child: ChildProcessWithoutNullStreams, code: number | null): void {
    if (this.child === child) {
      this.child = null;
      this.ready = null;
    }
    // Only this child's requests fail; a replacement may already be serving others.
    this.failAll(new DownstreamError("downstream process exited"), child);
    if (this.closed) return;
    if (this.retired.has(child)) {
      log.warn("unresponsive downstream process stopped", { code });
      return;
    }

    const uptime = Date.now() - this.startedAt;
    if (uptime < this.opts.crashWindowMs) {
      this.crashes++;
      const backoff = Math.min(this.opts.initialBackoffMs * 2 ** (this.crashes - 1), this.opts.maxBackoffMs);
      this.restartNotBefore = Date.now() + backoff;
      log.warn("downstream process exited", { code, uptime_ms: uptime, crashes: this.crashes, restart_in_ms: backoff });
    } else {
      this.crashes = 0;
      this.restartNotBefore = 0;
      log.warn("downstream process exited", { code, uptime_ms: uptime });
    }
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    // A well-behaved server never writes a line this long; don't let a broken one exhaust memory.
    if (this.stdoutBuffer.length > MAX_RESPONSE_BYTES && this.stdoutBuffer.indexOf("\n") < 0) {
      log.warn("downstream wrote an oversized line; restarting it");
      this.stdoutBuffer = "";
      this.child?.kill();
      return;
    }
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
      this.consecutiveTimeouts = 0;
      if (isJsonRpcResponse(msg)) entry.resolve(msg);
      else entry.reject(new DownstreamError("invalid JSON-RPC response"));
    }
  }

  private write(message: object): void {
    if (!this.child) throw new DownstreamError("downstream not running");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  private onTimeout(internalId: string, method: string): void {
    // MCP: tell the server to stop working on it (initialize must never be cancelled).
    if (method !== "initialize") {
      try {
        this.write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: internalId, reason: "gateway timeout" } });
      } catch { /* child already gone */ }
    }
    this.consecutiveTimeouts++;
    if (this.child && this.consecutiveTimeouts >= this.opts.maxConsecutiveTimeouts) {
      log.warn("downstream unresponsive; restarting it", { consecutive_timeouts: this.consecutiveTimeouts });
      const hung = this.child;
      this.retired.add(hung);
      this.child = null;
      this.ready = null;
      this.failAll(new DownstreamError("downstream unresponsive"), hung);
      hung.kill();
    }
  }

  private call(method: string, params: unknown): Promise<JsonRpcResponse> {
    const internalId = `gw-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(internalId);
        reject(new DownstreamTimeoutError());
        this.onTimeout(internalId, method);
      }, this.timeoutMs);
      this.pending.set(internalId, { resolve, reject, timer, owner: this.child });
      try {
        this.write({ jsonrpc: "2.0", id: internalId, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(internalId);
        reject(err);
      }
    });
  }

  private failAll(err: Error, owner: ChildProcessWithoutNullStreams): void {
    for (const [id, entry] of this.pending) {
      if (entry.owner !== owner) continue;
      clearTimeout(entry.timer);
      entry.reject(err);
      this.pending.delete(id);
    }
  }

  async send(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (!this.ready) {
      const wait = this.restartNotBefore - Date.now();
      if (wait > 0) throw new DownstreamError(`downstream restarting (backoff ${wait} ms)`);
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
    this.closed = true;
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
