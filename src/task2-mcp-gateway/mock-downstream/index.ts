/**
 * Mock downstream MCP server for Task 2 gateway testing.
 * Listens on port 3003 and responds to tools/list and tools/call.
 */
import express from "express";

const app = express();
app.use(express.json());
const PORT = process.env.MOCK_PORT ?? 3003;

const TOOLS = [
  { name: "get_data",        description: "Fetch public data" },
  { name: "admin_reset_key", description: "Reset API key (admin only)" },
  { name: "admin_purge_cache", description: "Purge cache (admin only)" },
];

app.get("/health", (_req, res) => res.json({ status: "ok", service: "mock-downstream" }));

app.post("/", (req, res) => {
  const { jsonrpc, id, method, params } = req.body as {
    jsonrpc: string; id: unknown; method: string;
    params?: { name?: string; arguments?: unknown };
  };

  if (jsonrpc !== "2.0") {
    res.status(400).json({ jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid request" } });
    return;
  }

  if (method === "tools/list") {
    res.json({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }

  if (method === "tools/call") {
    const name = params?.name ?? "";
    const tool = TOOLS.find(t => t.name === name);
    if (!tool) {
      res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Tool not found: ${name}` } });
      return;
    }
    res.json({
      jsonrpc: "2.0", id,
      result: { content: [{ type: "text", text: `✅ Executed tool: ${name}` }] },
    });
    return;
  }

  res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
});

app.listen(PORT, () => console.log(`[mock-downstream] Running on http://localhost:${PORT}`));
