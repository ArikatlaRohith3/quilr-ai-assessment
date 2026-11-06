import express, { Request, Response } from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT ?? 3002;
const DOWNSTREAM_URL = process.env.DOWNSTREAM_URL ?? "http://localhost:3003";

// Decode a mock JWT-style token: "role:admin" or "role:viewer"
function extractRole(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  // Token format: base64("role:admin") or base64("role:viewer")
  try {
    const decoded = Buffer.from(token, "base64").toString("utf-8");
    const match = decoded.match(/^role:(\w+)$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// Forward request to downstream MCP server
async function forwardToDownstream(body: unknown): Promise<{ status: number; data: unknown }> {
  const res = await fetch(DOWNSTREAM_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return { status: res.status, data };
}

// JSON-RPC error helper
function jsonRpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

app.get("/health", (_req, res) => res.json({ status: "ok", service: "mcp-gateway" }));

app.post("/", async (req: Request, res: Response) => {
  const body = req.body as { jsonrpc?: string; method?: string; params?: { name?: string }; id?: unknown };

  // Validate JSON-RPC envelope
  if (body.jsonrpc !== "2.0" || !body.method) {
    res.status(400).json(jsonRpcError(body.id ?? null, -32600, "Invalid JSON-RPC request"));
    return;
  }

  const method = body.method;
  const role = extractRole(req.headers.authorization);

  console.log(`[gateway] method=${method} role=${role ?? "none"}`);

  // tools/list — forward transparently (no auth required)
  if (method === "tools/list") {
    try {
      const { status, data } = await forwardToDownstream(body);
      res.status(status).json(data);
    } catch {
      res.status(502).json(jsonRpcError(body.id, -32603, "Downstream unreachable"));
    }
    return;
  }

  // tools/call — inspect params.name for admin_ prefix
  if (method === "tools/call") {
    const toolName = body.params?.name ?? "";

    if (toolName.startsWith("admin_")) {
      if (role !== "admin") {
        console.log(`[gateway] BLOCKED: tool "${toolName}" requires admin role, got "${role}"`);
        res.status(403).json(jsonRpcError(body.id, -32001, "Unauthorized Tool Call"));
        return;
      }
    }

    // Authorized — forward to downstream
    try {
      const { status, data } = await forwardToDownstream(body);
      res.status(status).json(data);
    } catch {
      res.status(502).json(jsonRpcError(body.id, -32603, "Downstream unreachable"));
    }
    return;
  }

  // All other methods — forward transparently
  try {
    const { status, data } = await forwardToDownstream(body);
    res.status(status).json(data);
  } catch {
    res.status(502).json(jsonRpcError(body.id, -32603, "Downstream unreachable"));
  }
});

app.listen(PORT, () => {
  console.log(`[gateway] MCP Security Gateway running on http://localhost:${PORT}`);
  console.log(`[gateway] Forwarding authorized requests to ${DOWNSTREAM_URL}`);
});
