/**
 * Mock downstream MCP server (HTTP) for gateway testing.
 * Exposes admin_ tools so the authorization matrix can be exercised end-to-end.
 * Default port 3010 (3003 belongs to the Task 3 guardrail).
 */
import express from "express";
import { createLogger } from "../../shared/logger.js";
import { intFromEnv, isMain } from "../../shared/runtime.js";

const log = createLogger("mock-downstream");

export const MOCK_TOOLS = [
  { name: "get_data", description: "Fetch public data", inputSchema: { type: "object" } },
  { name: "admin_reset_key", description: "Reset API key (admin only)", inputSchema: { type: "object" } },
  { name: "admin_purge_cache", description: "Purge cache (admin only)", inputSchema: { type: "object" } },
];

export function createMockDownstream(opts: { delayMs?: number } = {}) {
  const app = express();
  app.use(express.json());
  app.get("/health", (_req, res) => res.json({ status: "ok", service: "mock-downstream" }));

  app.post("/", async (req, res) => {
    const { jsonrpc, id, method, params } = req.body as {
      jsonrpc: string; id: unknown; method: string; params?: { name?: string };
    };
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    log.debug("request", { method, request_id: req.headers["x-request-id"] });

    if (jsonrpc !== "2.0") return res.status(400).json({ jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid request" } });
    if (method === "ping") return res.json({ jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list") return res.json({ jsonrpc: "2.0", id, result: { tools: MOCK_TOOLS } });
    if (method === "tools/call") {
      const name = params?.name ?? "";
      if (!MOCK_TOOLS.some((t) => t.name === name)) {
        return res.json({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${name}` } });
      }
      return res.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Executed tool: ${name}` }] } });
    }
    res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
  });
  return app;
}

if (isMain(import.meta.url)) {
  const port = intFromEnv("MOCK_PORT", 3010);
  createMockDownstream().listen(port, () => log.info("mock downstream listening", { port }));
}
