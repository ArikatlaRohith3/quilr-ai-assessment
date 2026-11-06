# QuilrAI Technical Assessment

Four production-grade TypeScript modules covering MCP servers, security gateways, LLM streaming guardrails, and rate-limiting routers.

## Setup

```bash
npm install
npm run build
```

---

## Task 1 — Custom MCP Server with Strict Validation

Exposes two tools over `stdio` transport using the official `@modelcontextprotocol/sdk`:

| Tool | Inputs | Validation |
|------|--------|------------|
| `get_customer_record` | `customer_id: string` | Must match `CUST-XXXXX` (Zod regex) |
| `trigger_refund` | `customer_id`, `amount: float`, `reason: string` | amount > 0, reason ≥ 10 chars |

**STDIO isolation:** all debug logs go to `stderr`; `stdout` carries only JSON-RPC messages.

```bash
npm run task1
# or pipe MCP messages directly:
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | npm run task1
```

---

## Task 2 — MCP Security Gateway Proxy

HTTP reverse proxy sitting between an AI agent and a downstream MCP server.

**Auth:** Bearer token decoded from base64 (`role:admin` or `role:viewer`).

| Method | Behaviour |
|--------|-----------|
| `tools/list` | Forwarded transparently |
| `tools/call` with `params.name` starting `admin_` | Requires `admin` role; returns `-32001 Unauthorized Tool Call` otherwise |
| All others | Forwarded transparently |

```bash
DOWNSTREAM_URL=http://localhost:3001 npm run task2

# Admin token: base64("role:admin") = "cm9sZTphZG1pbg=="
# Viewer token: base64("role:viewer") = "cm9sZTp2aWV3ZXI="

curl -X POST http://localhost:3002 \
  -H "Authorization: Bearer cm9sZTp2aWV3ZXI=" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"admin_reset_key"}}'
# → -32001 Unauthorized Tool Call
```

---

## Task 3 — LLM Gateway Streaming Guardrail (PII Redaction)

Proxies OpenAI-compatible streaming completions and redacts PII in real time.

**Redacted patterns:**
- Email addresses
- SSNs (`XXX-XX-XXXX`)
- Credit card numbers (13–16 digits)
- Phone numbers

**Design:** 64-character overlap buffer catches patterns that span chunk boundaries without buffering the full response — minimizing TTFT.

```bash
LLM_BASE_URL=https://api.openai.com LLM_API_KEY=sk-... npm run task3

curl -X POST http://localhost:3003/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"My email is test@example.com and SSN is 123-45-6789"}]}'
# → Streams back with [REDACTED] in place of PII
```

---

## Task 4 — Rate-Limiting & Model Fallback Router

Resilient LLM gateway with sliding-window token rate limiting and automatic failover.

**Rate limiter:** token-aware sliding window (default 50,000 tokens/min per tenant API key), persisted in SQLite on disk.

**Failover:** if primary returns `429` or times out after 3,000 ms, automatically retries on secondary provider. Response includes `X-Gateway-Fallback: true` header when fallback was used.

**Error sanitization:** upstream stack traces are never leaked; all errors return standardized `{ error: { code, message, source } }` payloads.

```bash
PRIMARY_LLM_URL=https://api.openai.com/v1/chat/completions \
SECONDARY_LLM_URL=https://api.anthropic.com/v1/messages \
LLM_API_KEY=sk-... npm run task4

curl -X POST http://localhost:3004/v1/chat/completions \
  -H "X-Tenant-Key: tenant-abc" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Hello"}]}'
```

---

## Project Structure

```
src/
├── task1-mcp-server/     # MCP server with Zod validation + stdio transport
├── task2-mcp-gateway/    # HTTP reverse proxy with role-based tool authorization
├── task3-llm-guardrail/  # Streaming LLM proxy with real-time PII redaction
└── task4-rate-limiter/   # Sliding window rate limiter + model fallback router
```
