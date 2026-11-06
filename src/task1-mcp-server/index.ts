import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { TOOLS } from "./tools.js";
import { formatZodError } from "./schemas.js";
import { createLogger } from "../shared/logger.js";
import { isMain } from "../shared/runtime.js";

// All logging goes to stderr — stdout is reserved for JSON-RPC frames.
const log = createLogger("mcp-server");

/**
 * Why the low-level `Server` instead of `McpServer`:
 * `McpServer` catches every error raised while handling tools/call — including its
 * own Zod validation errors — and converts it into `result.isError: true`. The
 * assessment requires invalid arguments to produce a JSON-RPC error with code
 * -32602, so tools/call is handled here and validation failures are thrown as
 * `McpError(InvalidParams)`, which the protocol layer serialises as a real error.
 */
export function createMcpServer(): Server {
  const server = new Server({ name: "quilr-mcp-server", version: "2.0.0" }, { capabilities: { tools: {} } });
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

    const parsed = tool.schema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      const message = formatZodError(parsed.error);
      log.warn("invalid arguments", { tool: name, issues: message });
      throw new McpError(ErrorCode.InvalidParams, `Invalid params: ${message}`);
    }

    try {
      return await tool.handler(parsed.data);
    } catch (err) {
      // Never leak internal error details (stack traces, file paths) to the client.
      log.error("tool handler failed", { tool: name, error: String(err) });
      throw new McpError(ErrorCode.InternalError, "Internal error while executing tool");
    }
  });

  return server;
}

async function main() {
  log.info("starting MCP server over stdio");
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
  log.info("MCP server ready");
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    log.error("fatal", { error: String(err) });
    process.exit(1);
  });
}
