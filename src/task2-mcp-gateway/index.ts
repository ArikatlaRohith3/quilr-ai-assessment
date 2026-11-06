import express, { type NextFunction, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AuthError, authConfigFromEnv, extractBearer, verifyToken, type AuthConfig, type Principal } from "./auth.js";
import { ALLOWED_METHODS, TOOL_NAME_PATTERN, authorizeToolCall, policyFromEnv, type PolicyConfig } from "./authorization.js";
import { DownstreamTimeoutError, HttpDownstream, StdioDownstream, type Downstream, type JsonRpcRequest } from "./proxy.js";
import { JSONRPC, jsonRpcError, safeJsonRpcId, type JsonRpcId } from "../shared/errors.js";
import { createLogger } from "../shared/logger.js";
import { intFromEnv, isMain } from "../shared/runtime.js";

const log = createLogger("mcp-gateway");
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export interface GatewayOptions {
  auth: AuthConfig;
  downstream: Downstream;
  policy?: PolicyConfig;
}

type Audit = {
  requestId: string;
  decision: "allowed" | "denied" | "unauthenticated" | "rejected";
  reason: string;
  method?: string;
  tool?: string;
  sub?: string;
  role?: string;
  downstream_ms?: number;
  outcome?: string;
};

/** One audit line per request. Never contains the token, headers or tool arguments. */
function audit(entry: Audit): void {
  log.info("audit", entry);
}

export function createGatewayApp({ auth, downstream, policy = {} }: GatewayOptions) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => res.json({ status: "ok", service: "mcp-gateway", downstream: downstream.kind }));

  app.post("/", async (req: Request, res: Response) => {
    const incoming = req.headers["x-request-id"];
    const requestId = typeof incoming === "string" && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
    res.setHeader("X-Request-ID", requestId);

    const body: unknown = req.body;
    const reply = (status: number, id: JsonRpcId, code: number, message: string) =>
      res.status(status).json(jsonRpcError(id, code, message));

    // 1. Envelope shape. Batches are rejected outright: each element would need its own authorization decision.
    if (Array.isArray(body)) {
      audit({ requestId, decision: "rejected", reason: "batch request" });
      return reply(400, null, JSONRPC.INVALID_REQUEST, "Batch requests are not supported");
    }
    if (!body || typeof body !== "object") {
      audit({ requestId, decision: "rejected", reason: "body is not an object" });
      return reply(400, null, JSONRPC.INVALID_REQUEST, "Invalid JSON-RPC request");
    }
    const msg = body as Record<string, unknown>;
    const id = safeJsonRpcId(msg.id);

    // 2. Authentication — before anything else in the message is acted upon.
    let principal: Principal;
    try {
      const token = extractBearer(req.headers.authorization);
      if (!token) throw new AuthError("missing bearer token");
      principal = verifyToken(token, auth);
    } catch (err) {
      const reason = err instanceof AuthError ? err.reason : "auth failure";
      audit({ requestId, decision: "unauthenticated", reason, method: typeof msg.method === "string" ? msg.method : undefined });
      res.setHeader("WWW-Authenticate", 'Bearer realm="mcp-gateway"');
      return reply(401, id, JSONRPC.UNAUTHENTICATED, "Authentication required");
    }
    const who = { sub: principal.sub, role: principal.role };

    // 3. JSON-RPC 2.0 envelope.
    if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string" || msg.method.length === 0) {
      audit({ requestId, ...who, decision: "rejected", reason: "invalid envelope" });
      return reply(400, id, JSONRPC.INVALID_REQUEST, "Invalid JSON-RPC request");
    }
    if (id === null) {
      audit({ requestId, ...who, method: msg.method, decision: "rejected", reason: "missing or invalid id" });
      return reply(400, null, JSONRPC.INVALID_REQUEST, "Request id must be a string or number (notifications are not supported)");
    }
    if (msg.params !== undefined && (msg.params === null || typeof msg.params !== "object" || Array.isArray(msg.params))) {
      audit({ requestId, ...who, method: msg.method, decision: "rejected", reason: "params not an object" });
      return reply(400, id, JSONRPC.INVALID_PARAMS, "params must be an object");
    }
    const method = msg.method;
    const params = (msg.params ?? {}) as Record<string, unknown>;

    // 4. Method allowlist (deny by default).
    if (!ALLOWED_METHODS.has(method)) {
      audit({ requestId, ...who, method, decision: "denied", reason: "method not allowed" });
      return reply(400, id, JSONRPC.METHOD_NOT_FOUND, `Method not found: ${method}`);
    }

    // 5. tools/call parameter validation + authorization.
    let tool: string | undefined;
    if (method === "tools/call") {
      if (typeof params.name !== "string" || !TOOL_NAME_PATTERN.test(params.name)) {
        audit({ requestId, ...who, method, decision: "rejected", reason: "invalid tool name" });
        return reply(400, id, JSONRPC.INVALID_PARAMS, "params.name must be a valid tool name");
      }
      const args = params.arguments;
      if (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args))) {
        audit({ requestId, ...who, method, tool: params.name, decision: "rejected", reason: "arguments not an object" });
        return reply(400, id, JSONRPC.INVALID_PARAMS, "params.arguments must be an object");
      }
      tool = params.name;
      const decision = authorizeToolCall(principal, tool, policy);
      if (!decision.allowed) {
        audit({ requestId, ...who, method, tool, decision: "denied", reason: decision.reason });
        return reply(403, id, JSONRPC.UNAUTHORIZED_TOOL, "Unauthorized Tool Call");
      }
    }

    // 6. Forward. Only the vetted fields are sent downstream.
    const forward: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const started = Date.now();
    try {
      const response = await downstream.send(forward, { requestId });
      audit({
        requestId, ...who, method, tool, decision: "allowed", reason: "policy allows",
        downstream_ms: Date.now() - started, outcome: response.error ? `error ${response.error.code}` : "ok",
      });
      res.status(200).json(response);
    } catch (err) {
      const timedOut = err instanceof DownstreamTimeoutError;
      audit({
        requestId, ...who, method, tool, decision: "allowed", reason: "policy allows",
        downstream_ms: Date.now() - started, outcome: timedOut ? "timeout" : "downstream error",
      });
      log.error("downstream failure", { requestId, error: (err as Error).message });
      if (timedOut) return reply(504, id, JSONRPC.DOWNSTREAM_TIMEOUT, "Downstream MCP server timed out");
      return reply(502, id, JSONRPC.DOWNSTREAM_ERROR, "Downstream MCP server unavailable");
    }
  });

  // Malformed JSON bodies → JSON-RPC parse error (instead of Express's HTML error page).
  app.use((err: Error & { type?: string; status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    if (err.type === "entity.parse.failed") return res.status(400).json(jsonRpcError(null, JSONRPC.PARSE_ERROR, "Parse error"));
    if (err.type === "entity.too.large") return res.status(413).json(jsonRpcError(null, JSONRPC.INVALID_REQUEST, "Request too large"));
    log.error("unhandled error", { error: err.message });
    res.status(500).json(jsonRpcError(null, JSONRPC.INTERNAL_ERROR, "Internal error"));
  });

  return app;
}

export function downstreamFromEnv(): Downstream {
  const timeoutMs = intFromEnv("DOWNSTREAM_TIMEOUT_MS", 5000);
  if (process.env.DOWNSTREAM_URL) return new HttpDownstream(process.env.DOWNSTREAM_URL, timeoutMs);
  // Default: bridge to the Task 1 MCP server over stdio.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const script = process.env.DOWNSTREAM_STDIO_SCRIPT ?? path.join(here, "../task1-mcp-server/index.js");
  return new StdioDownstream(process.execPath, [script], timeoutMs);
}

if (isMain(import.meta.url)) {
  let auth: AuthConfig;
  try {
    auth = authConfigFromEnv();
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }
  const downstream = downstreamFromEnv();
  const port = intFromEnv("PORT", 3002);
  const app = createGatewayApp({ auth, downstream, policy: policyFromEnv() });
  app.listen(port, () => log.info("MCP Security Gateway listening", { port, downstream: downstream.kind }));
  const shutdown = () => downstream.close().finally(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
