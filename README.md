# QuilrAI — AI Infrastructure Assessment

> **TypeScript (strict)** · Node.js ≥ 22.13 · MCP SDK · Express · zod 4 · SQLite (`node:sqlite`) · Anthropic SDK

Four modules covering an AI gateway stack: an MCP server, an MCP security gateway, a streaming PII guardrail, and a rate-limited LLM router with provider failover. Every behaviour described below is covered by an automated test (**76 tests**, `npm test`) and by the end-to-end demo (`npm run demo`, 21 checks). Neither needs API keys.

---

## Architecture

```
                 JWT (HS256)                         stdio JSON-RPC
┌──────────┐   ┌───────────────────────────┐   ┌────────────────────────┐
│ AI agent │──▶│ Task 2 · MCP gateway :3002│──▶│ Task 1 · MCP server    │
└──────────┘   │ auth → allowlist → RBAC   │   │ (spawned child process)│
               └───────────────────────────┘   └────────────────────────┘

┌──────────┐   ┌───────────────────────────┐   ┌────────────────────────┐
│  Client  │──▶│ Task 3 · guardrail  :3003 │──▶│ OpenAI-compatible LLM  │
└──────────┘   │ SSE parse → safe-cut PII  │   │ (streaming)            │
               └───────────────────────────┘   └────────────────────────┘

┌──────────┐   ┌───────────────────────────┐   ┌────────────────────────┐
│  Tenant  │──▶│ Task 4 · router     :3004 │──▶│ Primary  (OpenAI API)  │
└──────────┘   │ atomic SQLite reservations│ ┌▶│ Fallback (Claude API)  │
               └───────────────────────────┘ │ └────────────────────────┘
                              429 / timeout / 5xx
```

---

## Quick start

```bash
npm install
npm test                  # build + 76 tests (node:test)
npm run demo              # in-process end-to-end demo, prints ✅/❌, exits non-zero on failure

cp .env.example .env      # then fill in what you need (see below)
npm run task1             # MCP server (stdio)
npm run task2             # MCP gateway        :3002  (needs GATEWAY_JWT_SECRET)
npm run task3             # LLM guardrail      :3003  (needs LLM_API_KEY for a real upstream)
npm run task4             # rate-limit router  :3004  (needs TENANT_API_KEYS + provider keys)
npm run mock-downstream   # optional HTTP MCP mock :3010 for Task 2
npm run token -- admin alice 3600   # mint a gateway JWT (role, subject, ttl seconds)
npm run simulate          # burst simulation against a running Task 4
```

All `npm run taskN` scripts load `.env` automatically (`node --env-file-if-exists`). Logs are JSON lines on **stderr**. Secrets (`authorization`, `*key*`, `token`, `secret`, `password`, `cookie`) are masked by the shared logger.

---

## Task 1 — MCP server with strict validation

`src/task1-mcp-server/` (`schemas.ts`, `tools.ts`, `index.ts`)

| Tool | Input | Rules |
|------|-------|-------|
| `get_customer_record` | `customer_id` | `^CUST-\d{5}$` |
| `trigger_refund` | `customer_id`, `amount`, `reason` | amount finite, > 0, ≤ 10 000, ≤ 2 decimals; reason trimmed, 10–500 chars |

- **Schemas are strict.** Unknown fields such as `"approved_by": "admin"` are rejected.
- **`1e400` is rejected.** `JSON.parse` turns it into `Infinity`, so non-finite amounts get an explicit error.
- **Padding doesn't count.** Whitespace is trimmed before the minimum-length check.
- **Real JSON-RPC errors.** `McpServer` from the SDK turns every handler error, including its own zod failures, into `result.isError`. This server uses the lower-level `Server` instead and throws `McpError(InvalidParams)`, so the client gets error **`-32602`**:
  - invalid arguments → `-32602`
  - unknown tool → `-32602`
  - handler crash → `-32603`, with nothing internal leaked
  - business failures, such as a suspended customer → a normal `isError` result
- **Clean stdout.** Only JSON-RPC frames go to stdout; all logging goes to stderr. A test checks every stdout line.

```jsonc
→ {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_customer_record","arguments":{"customer_id":"INVALID"}}}
← {"jsonrpc":"2.0","id":2,"error":{"code":-32602,"message":"MCP error -32602: Invalid params: customer_id: customer_id must match format CUST-XXXXX (e.g. CUST-00123)"}}
```

---

## Task 2 — MCP security gateway

`src/task2-mcp-gateway/` (`auth.ts`, `authorization.ts`, `proxy.ts`, `index.ts`, `mint-token.ts`)

**Authentication: signed JWTs.** The old base64 `role:admin` token could be forged by anyone and is now rejected with 401. A token is accepted only if all of these hold:
- the algorithm is `HS256` (`alg: none` and other algorithms are rejected)
- the signature matches, checked with a constant-time compare
- `exp` is present and in the future
- `iss` and `aud` match the configuration
- `role` is `admin` or `viewer`

The secret comes from `GATEWAY_JWT_SECRET` and must be at least 32 characters.

```bash
TOKEN=$(npm run -s token -- viewer alice 600)
curl -s localhost:3002/ -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"get_customer_record","arguments":{"customer_id":"CUST-00123"}}}'
```

**Request pipeline.** Each check rejects the request before the next runs:

| Check | Rejection |
|-------|-----------|
| Body is a single JSON object (no batches) | 400 · `-32600` |
| Valid bearer JWT | 401 · `-32000` + `WWW-Authenticate` |
| JSON-RPC 2.0 envelope with an `id` (notifications rejected) and object `params` | 400 · `-32600` / `-32602` |
| Method allowlist: `tools/list`, `tools/call`, `ping` (deny by default) | 400 · `-32601` |
| `tools/call`: `name` matches `^[A-Za-z0-9_.\-/]{1,128}$`, `arguments` is an object | 400 · `-32602` |
| Authorization: `admin_*` (any casing) and `ADMIN_ONLY_TOOLS` need `role=admin` | 403 · `-32001 Unauthorized Tool Call` |
| Forward to the downstream with a per-request timeout | 504 · `-32003` timeout / 502 · `-32002` failure |

- **IDs are preserved.** Every response keeps the client's JSON-RPC `id`.
- **Request IDs.** `X-Request-ID` is propagated downstream and echoed back. Values that aren't safe are replaced with a generated ID.
- **One audit line per request.** It records the subject, role, method, tool, decision, status and latency. It never contains the token or the tool arguments.

**Downstream.** By default the gateway spawns the Task 1 server and bridges HTTP to **stdio** (`StdioDownstream`):
1. It performs the MCP `initialize` handshake.
2. It rewrites request IDs to internal `gw-N` values, so concurrent clients reusing the same ID can't collide, then restores the original ID on the response.
3. It applies per-request timeouts and restarts the child process if it exits.

To use an HTTP MCP endpoint instead, set `DOWNSTREAM_URL`. For example, `npm run mock-downstream` serves one on :3010; it used to be on :3003, which clashed with Task 3.

---

## Task 3 — streaming PII guardrail

`src/task3-llm-guardrail/` (`sse-parser.ts`, `pii-detector.ts`, `stream-redactor.ts`, `index.ts`)

The guardrail proxies OpenAI-compatible `/v1/chat/completions` and redacts PII in both directions:
- **Inbound:** prompt messages, both string content and content parts.
- **Outbound:** the streamed deltas.

| Pattern | Example | Output |
|---------|---------|--------|
| Email | `jane.doe@example.com` | `[REDACTED]` |
| SSN | `123-45-6789` | `[REDACTED]` |
| Credit card (13–19 digits, spaces/dashes) | `4111 1111 1111 1111` | `[REDACTED]` |
| Phone (NANP and E.164) | `+1 (555) 867-5309`, `+447911123456` | `[REDACTED]` |

**SSE parsing.** An incremental WHATWG-style parser:
- keeps partial frames across network reads
- handles `\n`, `\r\n` and `\r` line endings
- joins multi-line `data:` fields
- enforces a maximum event size

Frames that aren't valid JSON are dropped rather than passed through unredacted.

**Redaction across chunk boundaries: the "safe cut".** The old fixed 64-character overlap could leak PII that was longer or split in an unlucky place. The `StreamRedactor` instead keeps a buffer and releases text only up to a **safe cut**. A safe cut is a position where no PII match could continue across the boundary:
- It is a character that can't be part of PII, so not `[A-Za-z0-9._%+\-@()]`.
- It is not whitespace that could join two parts of a phone or card number.

Text before the cut is redacted and sent immediately, so ordinary prose streams without delay. A candidate that could still turn into PII is held back until it resolves. The held-back buffer is capped at `MAX_HOLDBACK = 1024` characters; beyond that, text more than 320 characters behind the stream's current end is released after redaction, because no pattern is that long.

**Invariant.** For any way of splitting the stream, the streamed output equals `redact(full text)`. The tests check every split point, byte-by-byte delivery, and 400 random fuzz cases.

**Stream handling:**
- `[DONE]` is sent exactly once.
- A `finish_reason` flushes that choice's buffer.
- If the upstream ends without `[DONE]`, held text is flushed (redacted) and a sanitised error event is sent.
- Upstream error bodies are never forwarded.
- Backpressure is respected.

**Cancellation.** If the client disconnects, or the header or idle timeout fires, the upstream request is aborted with an `AbortController`.

Measured in tests: TTFT is under 500 ms, and memory stays bounded on unbroken 50 KB tokens.

---

## Task 4 — rate-limiting router with failover

`src/task4-rate-limiter/` (`database.ts`, `rate-limiter.ts`, `token-estimator.ts`, `tenants.ts`, `providers/`, `router.ts`, `index.ts`)

**Tenant authentication.** Tenants send `Authorization: Bearer <key>`. Keys come from `TENANT_API_KEYS="tenantA:key,tenantB:key"` and must be at least 16 characters. Only SHA-256 digests are kept in memory. There's no default tenant, and a bare `X-Tenant-Key` header no longer grants access.

**Atomic sliding window.** The limit is `MAX_TOKENS_PER_MINUTE` (default 50 000) per tenant, persisted in SQLite (WAL, `busy_timeout`).
1. **Estimate** the request's tokens: input plus `max_tokens`, or `DEFAULT_OUTPUT_RESERVATION` if not set. It uses `gpt-tokenizer` if that package is installed, otherwise a chars/4 heuristic, plus per-message overhead.
2. **Reserve** inside a `BEGIN IMMEDIATE` transaction: sum the last 60 s of usage and insert a reservation only if it fits. Concurrent requests, including **separate processes sharing the database file**, can't over-allocate. Tests cover 25 concurrent requests and 4 worker threads.
3. **Settle** when the provider responds:
   - On success, **commit** the provider's actual `usage.total_tokens`, or the estimate if no usage was reported.
   - On failure, **release** the reservation so it doesn't count against the tenant.

A rejected request gets HTTP 429 with an exact `Retry-After`, worked out from when the oldest usage in the window expires. Every response carries `X-RateLimit-Limit` and `X-RateLimit-Remaining`. A request bigger than the whole limit gets 400.

**Providers.** Each provider has its own adapter behind one normalised interface:
- **Primary:** an OpenAI-compatible Chat Completions adapter (`fetch` with a timeout).
- **Fallback:** a Claude adapter built on the **official `@anthropic-ai/sdk`**:
  - Model `claude-opus-5-5` by default.
  - System messages move to the top-level `system` field.
  - `temperature` is not forwarded, because current Claude models reject sampling parameters.
  - `maxRetries: 0`, because the router owns the retry policy.
  - SDK error types are mapped onto rate-limited / timeout / unavailable / rejected.

**Failover:**

| Primary outcome | Router |
|-----------------|--------|
| success | 200, `X-Gateway-Provider: openai` |
| 429 / timeout (`PROVIDER_TIMEOUT_MS`, default 3 s) / 5xx / garbage | jittered delay → fallback; success → 200, `X-Gateway-Fallback: true` |
| 400 / 404 / 422 (bad request) | 400, no failover (the fallback would fail the same way) |
| both rate limited / timeout / failed | 503 + `Retry-After` / 504 / 502 |

Responses come back in a normalised `chat.completion` shape that includes `provider` and `usage.estimated`. Errors are always sanitised:
```json
{ "error": { "code": 502, "message": "All providers failed", "source": "llm-gateway" } }
```

> **Refusal fallback (on by default).** The Claude adapter sends the server-side refusal fallback beta (`server-side-fallback-2026-07-01`, `fallbacks: "default"`). If Claude declines a request on safety grounds, the API reruns it on a fallback model instead of returning a refusal. Set `ANTHROPIC_REFUSAL_FALLBACK=off` to disable it, for example behind proxies that reject beta parameters. If a refusal still comes back, it maps to `finish_reason: "content_filter"`.

`GET /metrics` returns per-tenant usage. It requires `Authorization: Bearer $METRICS_TOKEN`, and returns 404 when `METRICS_TOKEN` is unset.

```bash
curl -s localhost:3004/v1/chat/completions -H "Authorization: Bearer $TENANT_KEY" \
  -H "Content-Type: application/json" -d '{"messages":[{"role":"user","content":"Hello"}],"max_tokens":64}'
```

---

## Tests

`npm test` builds and then runs `node --test` over `dist/tests/*.test.js`. The suites start real servers on ephemeral ports against local mock providers, so they make no network calls and need no keys.

| Suite | Tests | Highlights |
|-------|------:|------------|
| `task1.test.ts` | 15 | Schema edge cases; spawns the real stdio server: raw `1e400`, `-32602` vs `isError`, stdout purity |
| `task2.test.ts` | 21 | Forged, `alg:none`, tampered, expired, wrong-aud/iss tokens; `ADMIN_` in any casing; invalid JSON-RPC; ID preservation; timeouts/502; audit logs with no secrets; stdio bridge to Task 1 with concurrent same-ID requests |
| `task3.test.ts` | 22 | SSE parser at every split point; redactor ≡ `redact(full)` at every split, char-by-char and under fuzz; byte-sliced end-to-end; single `[DONE]`; malformed frames; missing `[DONE]`; client disconnect cancels upstream; TTFT; no PII in logs |
| `task4.test.ts` | 18 | Exact 429 + Retry-After; oversized → 400; 25 concurrent requests and 4 processes on one DB with no over-allocation; persistence across restarts; reconciliation; every failover path; Anthropic request translation; tenant isolation; `/metrics` auth; no keys in logs |

---

## Project structure

```
src/
├── shared/                 logger (secret masking), JSON-RPC errors, runtime helpers, mock providers
├── task1-mcp-server/       schemas.ts · tools.ts · index.ts
├── task2-mcp-gateway/      auth.ts · authorization.ts · proxy.ts · index.ts · mint-token.ts · mock-downstream/
├── task3-llm-guardrail/    sse-parser.ts · pii-detector.ts · stream-redactor.ts · index.ts
├── task4-rate-limiter/     database.ts · rate-limiter.ts · token-estimator.ts · tenants.ts · router.ts · index.ts
│   ├── providers/          types.ts · openai.ts · anthropic.ts
│   └── simulate/           burst simulation against a running router
├── tests/                  helpers.ts · task1–4.test.ts
└── demo/                   end-to-end demo (all four tasks, mocks only)
```

## Tech stack

| Concern | Choice | Reason |
|---------|--------|--------|
| MCP | `@modelcontextprotocol/sdk` (low-level `Server`) | Official SDK; real JSON-RPC error codes |
| Validation | `zod` 4 (`z.strictObject`, `z.toJSONSchema`) | One source for validation and the advertised JSON Schema |
| Auth | HS256 JWT via `node:crypto` | No extra dependency; constant-time verification |
| Storage | `node:sqlite` (WAL, `BEGIN IMMEDIATE`) | Built-in, safe across processes, no native build |
| Claude | `@anthropic-ai/sdk` | Official SDK, typed errors |
| Tests | `node:test` | Built-in, no test framework dependency |
