# QuilrAI — AI Infrastructure Assessment

> **TypeScript** · MCP SDK · Node.js 24 · Express · SQLite (built-in)

Four production-grade modules covering the full AI gateway stack: MCP servers, security proxies, streaming guardrails, and resilient LLM routing.

---

## Architecture Overview

```
┌─────────────┐     ┌──────────────────────┐     ┌─────────────────┐
│  AI Agent   │────▶│  Task 2: MCP Gateway │────▶│ Downstream MCP  │
└─────────────┘     │  (auth + filtering)  │     │ (Task 1 server) │
                    └──────────────────────┘     └─────────────────┘

┌─────────────┐     ┌──────────────────────┐     ┌─────────────────┐
│   Client    │────▶│ Task 3: LLM Guardrail│────▶│  LLM Provider   │
└─────────────┘     │  (PII redaction)     │     └─────────────────┘

┌─────────────┐     ┌──────────────────────┐     ┌─────────────────┐
│   Client    │────▶│ Task 4: Rate Limiter │────▶│ Primary / Fallback│
└─────────────┘     │  (SQLite + failover) │     └─────────────────┘
```

---

## Quick Start

```bash
npm install
npm run build

# Prove everything works in one command
npm run demo              # starts all servers, fires real requests, prints ✅/❌

# Or run tasks individually
npm run task1             # MCP server (stdio)
npm run task2             # MCP gateway  (port 3002)
npm run task3             # LLM guardrail (port 3003)
npm run task4             # Rate-limit router (port 3004)

# Tests & simulations (no API key needed)
npm run test:redaction    # 12 PII redaction unit tests
npm run simulate          # Rate limiter burst simulation
```

Copy `.env.example` to `.env` and fill in your API keys before running Tasks 3 & 4 against a real LLM.

---

## Task 1 — Custom MCP Server with Strict Validation

**File:** `src/task1-mcp-server/index.ts`

Exposes two tools over `stdio` transport using `@modelcontextprotocol/sdk`:

| Tool | Input | Validation |
|------|-------|------------|
| `get_customer_record` | `customer_id: string` | Must match `CUST-XXXXX` (Zod regex) |
| `trigger_refund` | `customer_id`, `amount: float`, `reason: string` | amount > 0, reason ≥ 10 chars |

**STDIO isolation:** `stdout` carries only JSON-RPC — all debug output goes to `stderr`.

**Example — valid call:**
```jsonc
// stdin →
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_customer_record","arguments":{"customer_id":"CUST-00123"}}}

// stdout ←
{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\n  \"customer_id\": \"CUST-00123\", ...}"}]}}
```

**Example — invalid format (Zod rejection):**
```jsonc
// stdin →
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_customer_record","arguments":{"customer_id":"INVALID"}}}

// stdout ←
{"jsonrpc":"2.0","id":2,"error":{"code":-32602,"message":"Invalid params: customer_id must match format CUST-XXXXX"}}
```

---

## Task 2 — MCP Security Gateway Proxy

**File:** `src/task2-mcp-gateway/index.ts`

HTTP reverse proxy with role-based tool authorization.

**Token format:** Base64-encode `role:admin` or `role:viewer`
```bash
echo -n "role:admin"  | base64  # → cm9sZTphZG1pbg==
echo -n "role:viewer" | base64  # → cm9sZTp2aWV3ZXI=
```

**Authorization matrix:**

| Method | Tool name | Role | Result |
|--------|-----------|------|--------|
| `tools/list` | — | any | Forwarded |
| `tools/call` | `get_data` | any | Forwarded |
| `tools/call` | `admin_reset_key` | viewer | ❌ `-32001 Unauthorized` |
| `tools/call` | `admin_reset_key` | admin | ✅ Forwarded |

**Example — blocked call:**
```bash
curl -X POST http://localhost:3002 \
  -H "Authorization: Bearer cm9sZTp2aWV3ZXI=" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"admin_reset_key"}}'

# Response:
{"jsonrpc":"2.0","id":1,"error":{"code":-32001,"message":"Unauthorized Tool Call"}}
```

---

## Task 3 — LLM Gateway Streaming Guardrail (PII Redaction)

**File:** `src/task3-llm-guardrail/index.ts`

Proxies OpenAI-compatible streaming completions with real-time PII redaction.

**Redacted patterns:**
| Pattern | Example input | Output |
|---------|--------------|--------|
| Email | `jane@example.com` | `[REDACTED]` |
| SSN | `123-45-6789` | `[REDACTED]` |
| Credit card | `4111 1111 1111 1111` | `[REDACTED]` |
| Phone | `+1 (555) 867-5309` | `[REDACTED]` |

**Design — cross-chunk safety:**
Uses a 64-character overlap buffer so patterns split across SSE chunk boundaries are still caught without buffering the entire response in memory. Minimizes Time To First Token (TTFT).

```bash
curl -X POST http://localhost:3003/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"My SSN is 123-45-6789 and email is test@corp.com"}]}'
# Streams back: "My SSN is [REDACTED] and email is [REDACTED]"
```

---

## Task 4 — Rate-Limiting & Model Fallback Router

**File:** `src/task4-rate-limiter/index.ts`

Resilient LLM gateway with sliding-window token rate limiting and automatic failover.

**Rate limiting:**
- Sliding window: 50,000 tokens/min per tenant (configurable via `MAX_TOKENS_PER_MINUTE`)
- Token usage persisted in SQLite on disk (`node:sqlite` — Node 24 built-in, zero native deps)
- Expired rows evicted on every write

**Failover logic:**
```
Request → Primary LLM
            ├── 429 or timeout (3s) → Secondary LLM
            │                           ├── success → respond + X-Gateway-Fallback: true
            │                           └── fail    → 502 sanitized error
            └── success → respond
```

**Error sanitization:** upstream stack traces are never exposed. All errors return:
```json
{ "error": { "code": 429, "message": "Rate limit exceeded: 50000 tokens/min", "source": "llm-gateway" } }
```

**Example — rate limit hit:**
```bash
curl -X POST http://localhost:3004/v1/chat/completions \
  -H "X-Tenant-Key: tenant-abc" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Hello"}]}'

# After limit exceeded:
# HTTP 429  Retry-After: 60
# {"error":{"code":429,"message":"Rate limit exceeded: 50000 tokens/min","source":"llm-gateway"}}
```

---

## Extras (Beyond the Requirements)

| Extra | Command | What it shows |
|-------|---------|---------------|
| **End-to-end demo** | `npm run demo` | Starts all servers, fires real requests, prints ✅/❌ |
| **PII redaction tests** | `npm run test:redaction` | 12 cases including cross-chunk boundary — no API key needed |
| **Rate limit simulation** | `npm run simulate` | Visual burst proof: green=ok, red=429, yellow=fallback |
| **Mock downstream** | auto-started by demo | Makes Task 2 gateway fully testable end-to-end |
| **`/health` endpoints** | all HTTP servers | Production-ready readiness signal |

---

## Project Structure

```
quilr-ai-assessment/
├── src/
│   ├── task1-mcp-server/
│   │   └── index.ts                  # MCP server — Zod validation, stdio transport
│   ├── task2-mcp-gateway/
│   │   ├── index.ts                  # HTTP proxy — role-based tool authorization
│   │   └── mock-downstream/
│   │       └── index.ts              # Mock MCP server for end-to-end testing
│   ├── task3-llm-guardrail/
│   │   ├── index.ts                  # Streaming proxy — real-time PII redaction
│   │   └── test/
│   │       └── redaction.test.ts     # 12 PII redaction tests (no API key needed)
│   ├── task4-rate-limiter/
│   │   ├── index.ts                  # LLM router — sliding window + failover
│   │   └── simulate/
│   │       └── index.ts              # Burst simulation with color-coded output
│   └── demo/
│       └── index.ts                  # Unified demo — starts all servers, runs assertions
├── .env.example
├── package.json
└── tsconfig.json
```

## Tech Stack

| Concern | Choice | Reason |
|---------|--------|--------|
| MCP SDK | `@modelcontextprotocol/sdk` | Official SDK, stdio transport |
| Validation | `zod` | Type-safe schema enforcement |
| HTTP server | `express` | Minimal, well-understood |
| SQLite | `node:sqlite` (built-in) | Zero native deps, Node 24+ |
| Language | TypeScript (strict) | Type safety across all modules |
