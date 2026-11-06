import { format } from "node:util";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { TOOLS } from "./tools.js";
import { formatZodError, zodIssues } from "./schemas.js";
import { createLogger } from "../shared/logger.js";
import { isMain } from "../shared/runtime.js";

// All logging goes to stderr — stdout is reserved for JSON-RPC frames.
const log = createLogger("mcp-server");

/**
 * Why the low-level `Server` instead of `McpServer`:
 * `McpServer` catches every error raised while handling tools/call — including its
 * own Zod validation errors — and converts it into `result.isError: true`. Invalid
 * arguments must produce a JSON-RPC error with code -32602, so tools/call is handled
 * here and validation failures are thrown as `McpError(InvalidParams)`, which the
 * protocol layer serialises as a real `error` response.
 */
export function createMcpServer(): Server {
  const server = new Server({ name: "quilr-mcp-server", version: "2.1.0" }, { capabilities: { tools: {} } });
  const byName = new Map(TOOLS.map((t) => [t.name, t]));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => {
      const { $schema: _ignored, ...inputSchema } = z.toJSONSchema(t.schema, { target: "draft-7", io: "input" }) as Record<string, unknown>;
      return { name: t.name, description: t.description, inputSchema: inputSchema as { type: "object" } };
    }),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const tool = byName.get(name);
    if (!tool) {
      log.warn("unknown tool", { tool: name });
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
    }

    // A missing `arguments` object is validated as {} so the client is told which fields are required.
    const parsed = tool.schema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      const message = formatZodError(parsed.error);
      // Only field names and rule messages are logged/returned — never the submitted values.
      log.warn("invalid arguments", { tool: name, issues: message });
      throw new McpError(ErrorCode.InvalidParams, `Invalid params: ${message}`, { issues: zodIssues(parsed.error) });
    }

    try {
      return await tool.handler(parsed.data);
    } catch (err) {
      // Never leak internal error details (stack traces, file paths) to the client.
      log.error("tool handler failed", { tool: name, error: String(err) });
      throw new McpError(ErrorCode.InternalError, "Internal error while executing tool");
    }
  });

  // Protocol-level errors (e.g. a failed send) would otherwise be dropped silently.
  // Malformed input lines are already answered and logged by replyToMalformedInput.
  server.onerror = (err) => {
    if (isMalformedInputError(err)) return;
    log.error("protocol error", { error: String(err) });
  };
  return server;
}

/**
 * The SDK's stdio transport reports unparseable lines through `onerror` and sends
 * nothing back, which leaves the client waiting forever. JSON-RPC 2.0 requires a
 * reply with `id: null`: -32700 for invalid JSON, -32600 for JSON that isn't a valid
 * JSON-RPC message. Must be installed before `server.connect()` (the SDK chains it).
 */
const isMalformedInputError = (err: unknown) => err instanceof SyntaxError || (err as Error | undefined)?.name === "ZodError";

export function replyToMalformedInput(transport: Transport): void {
  transport.onerror = (err) => {
    if (!isMalformedInputError(err)) return;
    const isJsonError = err instanceof SyntaxError;
    const code = isJsonError ? ErrorCode.ParseError : ErrorCode.InvalidRequest;
    const message = isJsonError ? "Parse error" : "Invalid Request";
    log.warn("malformed input line", { code });
    const reply = { jsonrpc: "2.0", id: null, error: { code, message } } as unknown as JSONRPCMessage;
    transport.send(reply).catch((sendErr) => log.error("failed to send error reply", { error: String(sendErr) }));
  };
}

/** Builds the server and connects it. Rejects if the transport fails to start. */
export async function startServer(transport: Transport = new StdioServerTransport()): Promise<Server> {
  const server = createMcpServer();
  replyToMalformedInput(transport);
  await server.connect(transport);
  return server;
}

/**
 * Last line of defence for stdout: anything that calls console.log/info/debug —
 * including a dependency — goes to stderr instead of corrupting the JSON-RPC stream.
 */
export function protectStdout(): void {
  const toStderr = (...args: unknown[]) => void process.stderr.write(format(...args) + "\n");
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
}

/**
 * Runs `start` and turns every failure into a logged, non-zero exit instead of an
 * unhandled crash: startup errors, uncaught exceptions and unhandled rejections.
 * Shuts down cleanly (exit 0) on SIGINT/SIGTERM or when the client closes stdin.
 */
export function runOrExit(start: () => Promise<Server>, exit: (code: number) => void = (c) => process.exit(c)): void {
  let server: Server | undefined;
  let stopping = false;

  const fatal = (stage: string) => (err: unknown) => {
    log.error("fatal", { stage, error: err instanceof Error ? err.message : String(err) });
    exit(1);
  };
  const shutdown = (reason: string) => {
    if (stopping) return;
    stopping = true;
    log.info("shutting down", { reason });
    Promise.resolve(server?.close())
      .catch((err) => log.warn("error during shutdown", { error: String(err) }))
      .finally(() => exit(0));
  };

  process.on("uncaughtException", fatal("uncaughtException"));
  process.on("unhandledRejection", fatal("unhandledRejection"));
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.stdin.once("end", () => shutdown("stdin closed"));
  // EPIPE when the client goes away mid-write is a shutdown, not a crash.
  process.stdout.on("error", (err: NodeJS.ErrnoException) => (err.code === "EPIPE" ? shutdown("stdout closed") : fatal("stdout")(err)));

  start()
    .then((s) => {
      server = s;
      log.info("MCP server ready", { transport: "stdio", tools: TOOLS.map((t) => t.name) });
    })
    .catch(fatal("startup"));
}

if (isMain(import.meta.url)) {
  protectStdout();
  log.info("starting MCP server over stdio");
  runOrExit(() => startServer());
}
