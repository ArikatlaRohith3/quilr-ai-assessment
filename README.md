# QuilrAI — AI Infrastructure Assessment

> **TypeScript (strict)** · Node.js ≥ 22.13 · `@modelcontextprotocol/sdk` · Express · zod 4 · SQLite (`node:sqlite`) · `@anthropic-ai/sdk`

This repository contains four services that together form a small, security-focused AI gateway stack:

| # | Service | What it does | Interface |
|---|---------|--------------|-----------|
| 1 | **MCP server** | Customer-support tools with strict input validation | MCP over **stdio** |
| 2 | **MCP security gateway** | Authenticates agents (signed JWT), applies deny-by-default method and role policy, proxies to Task 1 | MCP Streamable HTTP · `:3002` |
| 3 | **Streaming PII guardrail** | Proxies OpenAI-compatible streaming completions, redacting PII in requests and in the token stream | HTTP + SSE · `:3003` |
| 4 | **Rate-limiting router** | Per-tenant token budget with atomic SQLite reservations, OpenAI → Claude failover | HTTP (JSON or SSE) · `:3004` |

**Verified status (2026-11-07):** `npm ci` → `npm test` gives **118 / 118 tests passing** · `npm run demo` gives **21 / 21 checks** · `tsc --noEmit` is clean · `npm audit` reports 0 vulnerabilities. See [Testing](#testing) for the exact environment and what was *not* verified.

---

## Contents

1. [Architecture](#architecture)
2. [Getting started](#getting-started)
3. [Configuration](#configuration)
4. [Task 1 — MCP server](#task-1--mcp-server-with-strict-validation)
5. [Task 2 — MCP security gateway](#task-2--mcp-security-gateway)
6. [Task 3 — Streaming PII guardrail](#task-3--streaming-pii-guardrail)
7. [Task 4 — Rate-limiting router](#task-4--rate-limiting-router-with-failover)
8. [Security design](#security-design)
9. [Testing](#testing)
10. [Known limitations](#known-limitations)
11. [Project structure and tech stack](#project-structure)
12. [Changes from v1 (historical)](#changes-from-v1-historical)

---

## Architecture

```
                       ┌──────────────────────────────────────────┐
  AI agent / MCP ─────▶│ Task 2 · MCP security gateway      :3002 │
  client (HTTP)  JWT   │  auth (HS256 JWT) → envelope checks →    │      stdio (JSON-RPC,
                       │  method allowlist → role policy →        │──────  newline-delimited)
                       │  forward · audit log                     │      ┌─────────────────────┐
                       └──────────────────────────────────────────┘ ───▶│ Task 1 · MCP server │
                                       │ optional: DOWNSTREAM_URL       │ zod-validated tools │
                                       └──────▶ any HTTP MCP server     └─────────────────────┘

                       ┌──────────────────────────────────────────┐
  App (HTTP + SSE) ───▶│ Task 3 · streaming PII guardrail   :3003 │──────▶ OpenAI-compatible
     client API key    │  client auth → inbound redaction →       │        chat completions API
                       │  SSE parser → per-field stream redactors │        (LLM_BASE_URL)
                       └──────────────────────────────────────────┘
                                       │ optional: LLM_BASE_URL = Task 4
                                       ▼
                       ┌──────────────────────────────────────────┐        ┌──────────────────┐
  Tenant (HTTP) ──────▶│ Task 4 · rate-limiting router      :3004 │──────▶ │ Primary: OpenAI- │
   tenant API key      │  tenant auth → validation → estimate →   │        │ compatible API   │
                       │  atomic reservation (SQLite) → route →   │  429 / └──────────────────┘
                       │  reconcile to actual usage               │ timeout┌──────────────────┐
                       └──────────────────────────────────────────┘  / 5xx▶│ Fallback: Claude │
                                       │                                   │ (Anthropic SDK)  │
                                       ▼                                   └──────────────────┘
                              rate_limiter.db (WAL)
```

The services are independent processes and can also be chained:

- **Task 2 → Task 1** is the default. The gateway spawns the Task 1 server as a child process and bridges HTTP to the stdio transport.
- **Task 3 → Task 4** works when the guardrail's `LLM_BASE_URL` points at the router and its `LLM_API_KEY` is a tenant key. The router accepts `stream: true`, and an integration test covers the full path: client → guardrail → router → provider.

Shared code lives in `src/shared/`:
- a structured logger that masks secrets
- JSON-RPC error helpers
- the API-key registry used by Tasks 3 and 4
- runtime helpers
- the mock providers used by the tests and the demo

---

## Getting started

### Prerequisites

- **Node.js ≥ 22.13**, as declared in `package.json`; `node:sqlite` is built in from 22.13. This README was verified on **Node 26.12.1** (npm 11.20.0, Windows 11) only.
- No API keys are needed for the tests or the demo, which use local mock providers.

### Install, build, verify

```bash
npm ci                 # reproducible install from package-lock.json
npm test               # clean build (tsc) + all 118 tests
npm run demo           # end-to-end demo of all four tasks; exits non-zero if any check fails
```

`npm run build` compiles `src/` to `dist/`. `npm run typecheck` runs `tsc --noEmit`.

### Run the services

```bash
cp .env.example .env   # fill in the values each service needs (see Configuration)

npm run task1          # MCP server on stdio (normally spawned by Task 2, not run by hand)
npm run task2          # MCP gateway        :3002   requires GATEWAY_JWT_SECRET
npm run task3          # PII guardrail      :3003   requires GUARDRAIL_API_KEYS (+ LLM_API_KEY for a real LLM)
npm run task4          # rate-limit router  :3004   requires TENANT_API_KEYS (+ provider keys)

npm run mock-downstream            # optional HTTP MCP mock on :3010 (use with DOWNSTREAM_URL)
npm run token -- viewer alice 600  # mint a gateway JWT: role, subject, TTL in seconds
npm run simulate                   # burst simulation against a running Task 4
```

All `npm run taskN` scripts load `.env` automatically (`node --env-file-if-exists=.env`). Each HTTP service exposes `GET /health`. Every service logs JSON lines to **stderr**.

Generate secrets and keys with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

---

## Configuration

Every variable is listed in [`.env.example`](.env.example). `PORT` and `LOG_LEVEL` (`debug | info | warn | error | silent`) apply to every service.

| Service | Variable | Default | Purpose |
|---------|----------|---------|---------|
| Task 2 | `GATEWAY_JWT_SECRET` | — (**required**, ≥ 32 chars) | HS256 signing secret shared with the token issuer |
| | `GATEWAY_JWT_ISSUER` / `GATEWAY_JWT_AUDIENCE` | `quilr-auth` / `quilr-mcp-gateway` | Required `iss` / `aud` claims |
| | `DOWNSTREAM_URL` | empty → stdio bridge to Task 1 | HTTP MCP endpoint to proxy instead |
| | `DOWNSTREAM_TIMEOUT_MS` | `5000` | Per-request downstream timeout |
| | `ADMIN_ONLY_TOOLS` | empty | Extra admin-only tools besides the `admin_` prefix |
| Task 3 | `GUARDRAIL_API_KEYS` | — (**required**) | `clientId:key,…` (keys ≥ 16 chars) |
| | `LLM_BASE_URL` / `LLM_API_KEY` | `https://api.openai.com` / — | Upstream API and the operator's key |
| | `UPSTREAM_HEADERS_TIMEOUT_MS` / `UPSTREAM_IDLE_TIMEOUT_MS` | `30000` / `30000` | Wait for headers / maximum silence mid-stream |
| Task 4 | `TENANT_API_KEYS` | — (**required**) | `tenantId:key,…` (keys ≥ 16 chars) |
| | `MAX_TOKENS_PER_MINUTE` | `50000` | Per-tenant sliding-window budget |
| | `DEFAULT_OUTPUT_RESERVATION` | `1024` (must be ≥ 1) | Output tokens reserved and sent as `max_tokens` when the client omits it |
| | `PROVIDER_TIMEOUT_MS` / `FAILOVER_MAX_JITTER_MS` | `3000` / `200` | Per-provider timeout / random delay before failover |
| | `DB_PATH` | `./rate_limiter.db` | SQLite file (WAL mode) |
| | `METRICS_TOKEN` | empty → `/metrics` disabled | Bearer token for `GET /metrics` |
| | `PRIMARY_BASE_URL` / `PRIMARY_API_KEY` / `PRIMARY_MODEL` | `https://api.openai.com` / — / `gpt-4o-mini` | Primary OpenAI-compatible provider |
| | `ALLOWED_MODELS` | empty → `PRIMARY_MODEL` only | Models a tenant may request |
| | `SECONDARY_API_KEY` (or `ANTHROPIC_API_KEY`) / `SECONDARY_MODEL` / `SECONDARY_BASE_URL` | — / `claude-opus-5-5` / Claude API | Fallback Claude provider |
| | `ANTHROPIC_REFUSAL_FALLBACK` | `on` | Server-side refusal fallback on the Claude API (`off` to disable) |

Services that need a secret refuse to start without it:
- Task 2 without `GATEWAY_JWT_SECRET`
- Task 3 without at least one client key
- Task 4 without at least one tenant key

---

## Task 1 — MCP server with strict validation

**Code:** `src/task1-mcp-server/`
- `schemas.ts`: zod schemas
- `tools.ts`: tool handlers and mock data
- `index.ts`: server, transport and process lifecycle

| Tool | Arguments | Validation |
|------|-----------|------------|
| `get_customer_record` | `customer_id` | `^CUST-\d{5}$` (exactly five ASCII digits) |
| `trigger_refund` | `customer_id`, `amount`, `reason` | `amount`: finite, > 0, ≤ 10 000, at most 2 decimals · `reason`: trimmed, ≥ 10 **non-whitespace** characters, ≤ 500 |

### Design

- **Strict schemas.** Both tools use `z.strictObject`, so unknown fields such as `"approved_by": "admin"` are rejected rather than silently dropped. The JSON Schema advertised in `tools/list` is generated from the same zod schema (`z.toJSONSchema`), so the two can't drift.
- **Real protocol errors.** The SDK's high-level `McpServer` turns every handler error, including validation failures, into a *successful* result with `isError: true`. This server uses the low-level `Server` and throws `McpError` instead, so each case gets the right JSON-RPC response:

  | Case | Response |
  |------|----------|
  | Invalid arguments or an unknown tool | `-32602` |
  | Handler crash | `-32603` `Internal error while executing tool`, with no internals exposed |
  | Invalid JSON | `-32700` |
  | Valid JSON that isn't a JSON-RPC message | `-32600` (the SDK alone sends no reply at all) |
  | Business failure on valid input, such as an unknown or suspended customer | A normal result with `isError: true` |

- **Machine-readable details.** `error.data.issues` lists `{ field, message }` for each problem. Submitted values are never echoed or logged; for refunds, only the reason's *length* is logged.
- **Non-finite numbers.** JSON `1e400` parses to `Infinity` and is rejected as non-finite. JSON has no `NaN` literal, so a raw `NaN` arrives as a `-32700` parse error.
- **stdout carries only JSON-RPC.** All logging goes to stderr, and `console.log/info/debug` are redirected to stderr, so stray output, even from a dependency, can't corrupt the protocol stream.
- **Lifecycle:**
  - Startup failures, uncaught exceptions and unhandled rejections are logged to stderr and exit with code 1.
  - SIGINT, SIGTERM, stdin closing and EPIPE shut the server down cleanly with code 0.

### Example (stdio)

These are real responses from `node dist/task1-mcp-server/index.js`, one JSON-RPC message per line, sent after `initialize`:

```jsonc
→ {"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"trigger_refund","arguments":{"customer_id":"CUST-00123","amount":49.99,"reason":"Product arrived damaged"}}}
← {"result":{"content":[{"type":"text","text":"{\n  \"refund_id\": \"REF-4af833eb-527d-43f5-a749-78071f8a84c0\",\n  \"customer_id\": \"CUST-00123\",\n  \"amount\": 49.99,\n  \"reason\": \"Product arrived damaged\",\n  \"status\": \"processed\",\n  \"processed_at\": \"2026-11-07T00:28:20.492Z\"\n}"}]},"jsonrpc":"2.0","id":1}

→ {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"trigger_refund","arguments":{"customer_id":"CUST-00123","amount":1e400,"reason":"Product arrived damaged","approved_by":"admin"}}}
← {"jsonrpc":"2.0","id":2,"error":{"code":-32602,"message":"MCP error -32602: Invalid params: amount: must be a finite number; unknown field(s) approved_by","data":{"issues":[{"field":"amount","message":"must be a finite number"},{"field":"arguments","message":"unknown field(s) approved_by"}]}}}

→ {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_customer_record","arguments":{"customer_id":"CUST-99999"}}}
← {"result":{"content":[{"type":"text","text":"Customer CUST-99999 not found"}],"isError":true},"jsonrpc":"2.0","id":3}
```

---

## Task 2 — MCP security gateway

**Code:** `src/task2-mcp-gateway/`
- `auth.ts`: JWT verification
- `authorization.ts`: method and role policy
- `proxy.ts`: the HTTP and stdio downstreams
- `index.ts`: the HTTP app
- `mint-token.ts`: development token CLI

### Authentication: HS256-signed JWT

Every request, including `initialize` and notifications, needs `Authorization: Bearer <JWT>`. `verifyToken` accepts a token only if all of the following hold:

| Check | Rule |
|-------|------|
| Shape | Exactly three base64url parts; at most 4 096 characters |
| Algorithm | `header.alg` must be exactly `HS256`, so `alg: none` and algorithm-confusion tokens are rejected |
| Signature | HMAC-SHA256 with `GATEWAY_JWT_SECRET`, compared using `crypto.timingSafeEqual`. Claims are parsed only *after* the signature verifies |
| Expiry | `exp` is **required**; `nbf` and `iat` are honoured, with 30 s of clock skew allowed |
| Issuer / audience | `iss` and `aud` must match the configuration (`aud` may be an array) |
| Subject / role | `sub` must be present (≤ 256 chars); `role` must be `admin` or `viewer` |

Failures return HTTP **401** with JSON-RPC error `-32000` and a `WWW-Authenticate: Bearer` header. The client never learns *which* check failed; the reason is recorded only in the audit log. Tokens are issued by your identity provider. For development, `npm run token -- <role> [subject] [ttlSeconds]` mints one with the same secret.

### Authorization and request pipeline

The checks run in this order, and the first failure ends the request:

| # | Check | On failure |
|---|-------|-----------|
| 1 | Body is a single JSON object (batches are rejected: each element would need its own decision) | 400 · `-32600` |
| 2 | Valid bearer JWT | 401 · `-32000` |
| 3 | JSON-RPC 2.0 envelope; a request has a string or number `id` | 400 · `-32600` |
| 4 | `params`, if present, is an object | 200 · `-32602` |
| 5 | `initialize` is answered by the gateway itself (see below) | — |
| 6 | **Method allowlist (deny by default):** `tools/list`, `tools/call`, `ping` | 200 · `-32601` |
| 7 | `tools/call`: `name` matches `^[A-Za-z0-9_.\-/]{1,128}$` and `arguments` is an object | 200 · `-32602` |
| 8 | **Role policy:** tools starting with `admin_` (in any letter casing) or listed in `ADMIN_ONLY_TOOLS` need `role=admin` | 200 · `-32001 Unauthorized Tool Call` |
| 9 | Forward the request to the downstream, with a per-request timeout | 200 · `-32003` timeout / `-32002` unavailable |

On top of the pipeline:
- **Role-filtered discovery.** `tools/list` responses are filtered with the same rule as step 8, so viewers never see admin tool names.
- **Forwarding.** Only the vetted `jsonrpc`, `id`, `method` and `params` are sent downstream, and the reply always carries the client's original `id`.
- **Error details.** Downstream `error.data` of up to 8 KB, such as Task 1's validation `issues`, is passed through; anything larger is dropped.

### MCP transport compliance

The gateway implements MCP **Streamable HTTP** in stateless JSON-response mode, so standard MCP clients connect to it directly. The test suite drives it with the official SDK client (`StreamableHTTPClientTransport`), both against a mock downstream and through to the real Task 1 server.

- **`initialize`:** answered by the gateway, which owns the client-facing session. It negotiates the protocol version (unsupported versions fall back to the SDK's latest) and advertises only `tools`.
- **Notifications** (messages without an `id`): `202 Accepted` with an empty body; they are not forwarded.
- **`GET /` and `DELETE /`:** `405` with `Allow: POST`, because the gateway has no server-to-client stream and no sessions.
- **Status codes:** JSON-RPC errors on well-formed requests use **HTTP 200**, so MCP clients receive them as protocol errors (`McpError`, for example `-32001`) rather than transport failures. HTTP 4xx is reserved for unusable messages (400) and authentication (401).

### Downstream: stdio bridge to Task 1

By default, `StdioDownstream` spawns the Task 1 server and speaks newline-delimited JSON-RPC over its stdin and stdout:

1. It performs the MCP `initialize` / `notifications/initialized` handshake once, then multiplexes requests over that one session.
2. It rewrites each request ID to an internal `gw-N`, so concurrent clients reusing the same ID can't collide, and restores the original ID on the reply.
3. **Timeouts:** a timed-out request is rejected with `-32003`, the child is sent `notifications/cancelled`, and any late reply is dropped.
4. **Self-healing:**
   - After 2 consecutive timeouts the child is treated as hung, then killed and replaced.
   - A child that exits within 5 s of starting counts as a crash and is restarted with exponential backoff (250 ms, doubling, capped at 5 s). While it backs off, requests fail fast instead of spawning a new process each time.
   - A dying child fails only its own in-flight requests, never those of its replacement.

With `DOWNSTREAM_URL` set, `HttpDownstream` proxies to an HTTP MCP endpoint instead. One timeout covers connecting, headers and reading the body, so a body that stalls counts as a timeout. Responses are capped at 1 MB.

### Audit log

The gateway writes one structured line per request. It contains:
- the request ID, subject, role, method and tool
- the decision (`allowed`, `denied`, `unauthenticated` or `rejected`) and its reason
- the downstream latency and outcome

It **never** contains the token, other headers or tool arguments. Tests assert this. `X-Request-ID` is propagated downstream and echoed back to the client; unsafe values are replaced with a generated UUID.

### Examples

These are real responses from `npm run task2`, bridged to the real Task 1 server:

```bash
export GATEWAY_JWT_SECRET=...          # ≥ 32 chars
VIEWER=$(npm run -s token -- viewer alice 600)
```

```jsonc
// initialize
→ {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}
← 200 {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"quilr-mcp-gateway","version":"2.1.0"}}}

// allowed tool call (viewer)
→ {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_customer_record","arguments":{"customer_id":"CUST-00123"}}}
← 200 {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"{\n  \"customer_id\": \"CUST-00123\",\n  \"name\": \"Jane Doe\", …"}]}}   (abbreviated)

// invalid arguments: Task 1's structured error passes through the gateway
→ {"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"trigger_refund","arguments":{"customer_id":"CUST-00123","amount":-5,"reason":"   "}}}
← 200 {"jsonrpc":"2.0","id":4,"error":{"code":-32602,"message":"MCP error -32602: Invalid params: amount: must be greater than 0; reason: must contain at least 10 non-whitespace characters","data":{"issues":[{"field":"amount","message":"must be greater than 0"},{"field":"reason","message":"must contain at least 10 non-whitespace characters"}]}}}

// admin tool as viewer
→ {"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"admin_reset_key","arguments":{}}}
← 200 {"jsonrpc":"2.0","id":5,"error":{"code":-32001,"message":"Unauthorized Tool Call"}}

// forged unsigned token (base64 of "role:admin")
← 401  WWW-Authenticate: Bearer realm="mcp-gateway"
       {"jsonrpc":"2.0","id":6,"error":{"code":-32000,"message":"Authentication required"}}

// method outside the allowlist
→ {"jsonrpc":"2.0","id":7,"method":"resources/read","params":{}}
← 200 {"jsonrpc":"2.0","id":7,"error":{"code":-32601,"message":"Method not found: resources/read"}}

// notification
→ {"jsonrpc":"2.0","method":"notifications/initialized"}
← 202 (empty body)
```

---

## Task 3 — Streaming PII guardrail

**Code:** `src/task3-llm-guardrail/`
- `sse-parser.ts`: incremental SSE parser
- `pii-detector.ts`: patterns and the safe-cut rule
- `stream-redactor.ts`: bounded streaming redactor
- `index.ts`: the proxy

The guardrail proxies OpenAI-compatible `POST /v1/chat/completions`, always requesting a streamed reply from the upstream.

### Client authentication

Clients send `Authorization: Bearer <client key>`. Keys come from `GUARDRAIL_API_KEYS` and are held only as SHA-256 digests. A missing or unknown key gets **401** before anything is sent upstream. The client's key is never forwarded; upstream calls use the operator's `LLM_API_KEY`. Because the server won't start without at least one client key, it can't run as an open proxy on the operator's credentials.

### What gets redacted

| Pattern | Examples | Output |
|---------|----------|--------|
| Email | `jane.doe@example.com` | `[REDACTED]` |
| US SSN | `123-45-6789`, `123 45 6789` | `[REDACTED]` |
| Card number (13–19 digits, optional single spaces or dashes) | `4111 1111 1111 1111`, `4111-1111-1111-1111` | `[REDACTED]` |
| Phone: North American, E.164, international with separators | `(555) 867-5309`, `+1 555 867 5309`, `+447911123456`, `+44 7911 123456`, `+91 98765-43210` | `[REDACTED]` |

- **Inbound (request):** every string in every message is redacted before it leaves the trust boundary. That covers text, content parts, tool results, and tool-call arguments in the history. `logprobs` and `top_logprobs` are removed from the request.
- **Outbound (stream):** each field that carries generated text has its own streaming redactor, per choice:
  - `delta.content` and `delta.refusal`
  - `delta.reasoning_content` and `delta.reasoning`
  - `delta.tool_calls[i].function.arguments` (one redactor per tool call)

  PII split across frames is therefore caught in every field, not only in `content`. Every other string in a frame (tool names, IDs, provider extensions) is redacted whole. `logprobs` are replaced with `null`, because they repeat the generated text token by token.

### Incremental streaming redaction: the "safe cut"

The guardrail does **not** use a fixed overlap window. Each `StreamRedactor` appends incoming text to a small buffer and releases only the part before a **safe cut**: a position that no PII match can span. The rule follows from what every pattern can contain:

1. All characters of a match come from the PII character set `[A-Za-z0-9._%+\-@()]`.
2. The only whitespace inside a match sits between a digit or `)` on the left and a digit, `(` or `+` on the right, as in `4111 1111` or `(555) 867`.

`findSafeCut` walks back from the end of the buffer over that chain. Everything before the chain is passed through `redact()` and released immediately, so ordinary prose streams with near-zero delay; only the word currently being typed is held back. Because the character just before the cut is never part of a PII chain, regex word boundaries and look-arounds evaluate the same on the released slice as on the full text.

**Invariant.** For *any* way the stream is split, the concatenated output equals `redact(full text)`. The tests check this at every split point, character by character, and with 400 random fuzz cases.

**Bounded memory.** The held-back buffer is capped at `MAX_HOLDBACK = 1024` characters per stream. On pathological input, such as an unbroken run of letters, text more than 320 characters behind the end of the buffer is released after redaction, and the cut is moved left so it never splits a match.

### Stream handling

- **SSE parsing.** An incremental, WHATWG-style parser keeps partial frames across network reads, handles `\n`, `\r\n` and `\r`, joins multi-line `data:` fields, and rejects events over 1 000 000 characters.
- **Fail closed:**
  - Frames that aren't valid JSON are dropped, never passed through.
  - If the stream is interrupted, held-back text is discarded, because it may be an incomplete PII candidate.
- **Flushing:** a `finish_reason` flushes that choice's buffer. If the upstream ends without `[DONE]`, held text is flushed (redacted) and a sanitised error event is sent.
- **Single terminator:** `[DONE]` is sent exactly once; anything the upstream sends after it is ignored.
- **Error sanitising:** upstream error bodies are never forwarded. Error statuses map to sanitised `429` / `400` / `502` JSON errors.
- **Cancellation:** a client disconnect, the header timeout or the idle timeout aborts the upstream request through an `AbortController`. Backpressure on the client connection is respected.

### Example

This is a real response from `npm run task3`, pointed at a mock upstream whose reply splits PII across four deltas: `"Sure. Her email is jane.d"`, `"oe@example.com and her SSN is 123-4"`, `"5-6789. Card: 4111 1111 "` and `"1111 1111."`.

```bash
curl -N localhost:3003/v1/chat/completions \
  -H "Authorization: Bearer $GUARDRAIL_CLIENT_KEY" -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"My SSN is 123-45-6789, what is Jane'\''s email?"}]}'
```

```text
data: {"id":"chatcmpl-x","object":"chat.completion.chunk","created":1,"model":"gpt-mock","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-x","object":"chat.completion.chunk","created":1,"model":"gpt-mock","choices":[{"index":0,"delta":{"content":"Sure. Her email is "},"finish_reason":null}]}

data: {"id":"chatcmpl-x","object":"chat.completion.chunk","created":1,"model":"gpt-mock","choices":[{"index":0,"delta":{"content":"[REDACTED] and her SSN is "},"finish_reason":null}]}

data: {"id":"chatcmpl-x","object":"chat.completion.chunk","created":1,"model":"gpt-mock","choices":[{"index":0,"delta":{"content":"[REDACTED]. Card: "},"finish_reason":null}]}

data: {"id":"chatcmpl-x","object":"chat.completion.chunk","created":1,"model":"gpt-mock","choices":[{"index":0,"delta":{"content":"[REDACTED]."},"finish_reason":"stop"}]}

data: [DONE]
```

Without a valid key the guardrail returns `401 {"error":{"code":401,"message":"Invalid or missing API key","source":"llm-guardrail"}}`, and nothing is sent upstream.

---

## Task 4 — Rate-limiting router with failover

**Code:** `src/task4-rate-limiter/`
- `tenants.ts`: tenant authentication
- `token-estimator.ts`: token estimation
- `rate-limiter.ts`: reservations
- `database.ts`: the SQLite schema
- `router.ts`: failover
- `providers/`: the OpenAI and Anthropic adapters
- `index.ts`: the HTTP app

### Tenant authentication

Tenants send `Authorization: Bearer <tenant API key>`. Keys come from `TENANT_API_KEYS`, must be at least 16 characters, and are held only as **SHA-256 digests**. The presented key is hashed and looked up by digest. The tenant identity always comes from the key, never from a client-chosen header, and there is no default tenant. Missing or unknown keys get **401** with `WWW-Authenticate: Bearer`.

### Atomic sliding-window budget

The budget is `MAX_TOKENS_PER_MINUTE` per tenant over a 60 s sliding window, persisted in SQLite (WAL mode, `busy_timeout` 5 s).

1. **Validate** the request with zod: roles `system | user | assistant`, at most 500 messages, `max_tokens` ≤ 128 000. If an allowlist is configured, the requested model must be on it.
2. **Estimate** the tokens: input (from `gpt-tokenizer` if installed, otherwise a chars/4 heuristic, plus per-message overhead) plus output (`max_tokens`, or `DEFAULT_OUTPUT_RESERVATION`). A request larger than the whole budget gets **400**.
3. **Reserve** atomically. Inside one `BEGIN IMMEDIATE` transaction, sum the tenant's usage over the window and insert a `reserved` row only if the request fits. Because the check and the insert are a single write transaction, concurrent requests in one process, and separate processes sharing the database file, cannot over-allocate. The tests cover 25 concurrent requests and 4 worker threads.
4. **Cap the output.** The reserved output is **always sent to the provider as `max_tokens`**, so a reply can't be longer than its reservation, and omitting `max_tokens` can't bypass the budget.
5. **Settle:**
   - On success, the reservation is **committed** at the provider's reported `usage`, or kept at the estimate if no usage was reported.
   - If no provider delivered a reply, it is **released** and the tenant isn't charged.

A request that doesn't fit gets **429**, with a `Retry-After` computed from when enough of the oldest usage leaves the window. Admitted and rate-limited responses carry `X-RateLimit-Limit` and `X-RateLimit-Remaining`.

### Providers and failover

| Adapter | Implementation |
|---------|----------------|
| Primary: `OpenAIAdapter` | OpenAI-compatible Chat Completions via `fetch`, with an `AbortSignal` timeout that also covers reading the body |
| Fallback: `AnthropicAdapter` | The official **`@anthropic-ai/sdk`**, configured as follows: |

`AnthropicAdapter` details:
- **Model:** `claude-opus-5-5` by default.
- **Message translation:** `system` messages move to the top-level `system` field.
- **Parameters:** `temperature` is not forwarded, because current Claude models reject sampling parameters.
- **Retries:** `maxRetries: 0`, because the router owns retry and failover.
- **Errors:** SDK error classes map to rate-limited, timeout, unavailable or rejected.
- **Refusals:** a `refusal` stop reason maps to `finish_reason: "content_filter"`.

| Primary outcome | Router behaviour |
|-----------------|------------------|
| Success | 200, `X-Gateway-Provider: openai` |
| 429, timeout (`PROVIDER_TIMEOUT_MS`), 5xx or an unparseable body | Random delay of up to `FAILOVER_MAX_JITTER_MS`, then the fallback; on success, 200 with `X-Gateway-Fallback: true` |
| 400 / 404 / 422 (bad request) | 400, with no failover, because the fallback would reject it the same way |
| Both providers fail | 503 + `Retry-After: 5` if both rate-limited, 504 if timed out, otherwise 502 |

> **Refusal fallback (on by default).** The Claude adapter sends the server-side refusal-fallback beta (`server-side-fallback-2026-07-01`, `fallbacks: "default"`). If Claude declines a request on safety grounds, the API reruns it on a fallback model instead of returning a refusal. Set `ANTHROPIC_REFUSAL_FALLBACK=off` to disable it, for example behind proxies that reject beta parameters.

### Responses

- **Format:** responses use a normalised `chat.completion` shape that adds `provider` and `usage.estimated`.
- **Streaming:** with `"stream": true`, providers are still called non-streaming, so failover and token accounting stay exact. The finished answer is then delivered in OpenAI's streaming format: a content chunk, a finish chunk with `usage`, then `[DONE]`.
- **Errors:** always sanitised, as `{"error":{"code":…,"message":…,"source":"llm-gateway"}}`. Provider error bodies and stack traces are never forwarded.
- **Metrics:** `GET /metrics` returns per-tenant usage. It requires `Authorization: Bearer $METRICS_TOKEN`, and returns 404 when no token is configured.

### Examples

These are real responses from `npm run task4`, pointed at local mock providers, with `MAX_TOKENS_PER_MINUTE=2000`:

```bash
curl -s localhost:3004/v1/chat/completions -H "Authorization: Bearer $TENANT_KEY" \
  -H "Content-Type: application/json" -d '{"messages":[{"role":"user","content":"Hello"}],"max_tokens":64}'
```

```text
# success
HTTP/1.1 200 OK
X-RateLimit-Limit: 2000
X-RateLimit-Remaining: 1982
X-Gateway-Provider: openai
{"id":"chatcmpl-13e94ab6-…","object":"chat.completion","created":1794011270,"model":"gpt-4o-mini","provider":"openai",
 "choices":[{"index":0,"message":{"role":"assistant","content":"Hello! How can I help?"},"finish_reason":"stop"}],
 "usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18,"estimated":false}}

# a request whose reservation (max_tokens 1985 + input) no longer fits the remaining budget
HTTP/1.1 429 Too Many Requests
Retry-After: 60
X-RateLimit-Limit: 2000
X-RateLimit-Remaining: 1982
{"error":{"code":429,"message":"Rate limit exceeded: 2000 tokens/min","source":"llm-gateway"}}

# larger than the whole budget
HTTP/1.1 400 Bad Request
{"error":{"code":400,"message":"Request needs ~5009 tokens, more than the 2000 tokens/min budget","source":"llm-gateway"}}

# primary returns 429 → Claude fallback
HTTP/1.1 200 OK
X-Gateway-Fallback: true
X-Gateway-Provider: anthropic
{"id":"chatcmpl-900e19b8-…","object":"chat.completion","model":"claude-opus-5-5","provider":"anthropic",
 "choices":[{"index":0,"message":{"role":"assistant","content":"Hello from Claude (fallback)."},"finish_reason":"stop"}],
 "usage":{"prompt_tokens":13,"completion_tokens":9,"total_tokens":22,"estimated":false}}

# no key, or only an X-Tenant-Key header
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer realm="llm-gateway"
{"error":{"code":401,"message":"Invalid or missing tenant API key","source":"llm-gateway"}}

# model not on the allowlist
HTTP/1.1 400 Bad Request
{"error":{"code":400,"message":"Model not allowed: gpt-5-pro","source":"llm-gateway"}}
```

Some long IDs are abbreviated with `…`.

---

## Security design

| Threat | Control | Where |
|--------|---------|-------|
| Forged or tampered agent identity | HS256 JWT: exact `alg` check, constant-time signature compare, required `exp`, `iss`/`aud` binding, role allowlist; claims parsed only after the signature verifies | `task2…/auth.ts` |
| Privilege escalation through tool calls | Deny-by-default method allowlist; `admin_*` and `ADMIN_ONLY_TOOLS` need `role=admin`, matched case-insensitively against a restricted tool-name charset, so lookalike or padded names can't slip past; batches rejected | `task2…/authorization.ts`, `index.ts` |
| Tool discovery by low-privilege callers | `tools/list` filtered by role | `task2…/authorization.ts` |
| Argument smuggling or malformed input | Strict zod schemas (unknown fields rejected), finite-number and non-whitespace rules, `-32602` errors that never echo submitted values | `task1…/schemas.ts` |
| PII sent to or returned by an LLM | Inbound redaction of every message string; per-field outbound stream redaction with a provable chunk-boundary invariant; `logprobs` stripped; fail-closed handling of malformed frames and interrupted streams | `task3…/` |
| Open proxy or credential misuse | Client keys required for Task 3 and tenant keys for Task 4, both stored as SHA-256 digests; caller keys never forwarded upstream; services refuse to start without keys | `shared/api-keys.ts` |
| Budget exhaustion and cost abuse | Atomic reservations, output capped at the reservation, oversized requests rejected, model allowlist | `task4…/` |
| Information leakage in errors | Upstream and downstream error bodies are never forwarded; clients get generic, sanitised messages; auth-failure reasons appear only in logs | all services |
| Secrets in logs | Structured logger masks `authorization`, `*key*`, `token`, `secret`, `password` and `cookie` fields; tests assert logs contain no tokens, keys, tool arguments or PII | `shared/logger.ts` |
| Resource exhaustion | Body limits (1 / 2 / 4 MB), JWT length cap, bounded redactor buffer, SSE event-size cap, 1 MB downstream response cap, per-request timeouts, restart backoff for a crashing downstream | various |
| Protocol corruption (stdio) | stdout reserved for JSON-RPC; `console.*` redirected to stderr | `task1…/index.ts` |

---

## Testing

```bash
npm test                                   # clean build + every suite
npm run test:only                          # rerun suites against the existing build
node --test dist/tests/task3.test.js       # a single suite (after a build)
TEST_LOGS=1 npm run test:only              # show service logs during tests
npm run demo                               # 21-check end-to-end demo
```

The suites use `node:test`. They start the real services on ephemeral ports, spawning the real Task 1 process where relevant, against local mock providers. They make no network calls and need no keys.

### Verified results

**Environment:** 2026-11-07, Windows 11, Node 26.12.1, npm 11.20.0, starting from a clean `npm ci`.

| Command | Result |
|---------|--------|
| `npm test` | **118 tests, 22 suites: 118 pass, 0 fail** (≈ 10.6 s) |
| `npm run demo` | **All 21 checks passed** |
| `npx tsc --noEmit` | No errors |
| `npm audit` | 0 vulnerabilities |

| Suite | Tests | Coverage highlights |
|-------|------:|---------------------|
| `task1.test.ts` | 30 | Valid and invalid IDs; negative, zero, NaN and ±Infinity (`1e400` on the wire) amounts; empty and whitespace-only reasons; missing and unexpected fields; valid refund. Covered as schema tests and over the real stdio server, including the exact `-32602` response shape, `-32700`/`-32600` replies, stdout purity, startup failure → exit 1, uncaught exception → exit 1, and stdin close → exit 0 |
| `task2.test.ts` | 34 | Forged base64, `alg:none`, tampered, wrong-secret, expired, wrong-`aud`/`iss`, unknown-role and missing-`exp` tokens; `admin_` in any casing; invalid envelopes; ID preservation; `X-Request-ID`; secret-free audit logs; **official MCP SDK client** (connect, list, call, `McpError -32001`, end to end to Task 1); `initialize`, 202 notifications, 405 GET/DELETE; role-filtered `tools/list`; `error.data` pass-through and size cap; hung-downstream cancel and replace; crash-loop backoff; stalled and oversized HTTP bodies |
| `task3.test.ts` | 29 | SSE parser at every split point, byte by byte, with CRLF/CR, incomplete and oversized events; redactor ≡ `redact(full)` at every split point, char by char and under fuzz; bounded memory; byte-sliced end-to-end streams; single `[DONE]`; malformed frames dropped; missing `[DONE]`; client disconnect cancels the upstream; TTFT < 500 ms; client auth (401, upstream never called, key never forwarded); PII in tool-call arguments, `refusal` and `reasoning_content` split across frames; `logprobs` stripped; inbound tool-call history redacted; no PII in logs |
| `task4.test.ts` | 25 | Exact 429 and `Retry-After`; oversized → 400; 25 concurrent requests and 4 worker processes sharing one DB with no over-allocation; persistence across restarts; reconciliation to actual usage; every failover path; Anthropic request translation (system field, no `temperature`, default model); output capped at the reservation on both providers; `stream: true` output; model allowlist; tenant isolation; `/metrics` auth; no keys in logs; **client → Task 3 → Task 4 → provider integration** (PII redacted both ways, 429 propagated) |

### Not verified

- Calls to the **real** OpenAI and Claude APIs. Every provider interaction in the tests and the demo uses local mocks, built to the documented request and response formats.
- **Node 22.x** (the declared minimum) and **Linux/macOS**. Only the environment above was exercised.
- `npm run simulate`, which needs a running router with provider keys, is provided as a manual tool and isn't part of the results above.

---

## Known limitations

- **Provider timeout.** `PROVIDER_TIMEOUT_MS` defaults to 3 s per provider, which suits short completions. Long generations need a higher value, or both providers will time out (504).
- **Synchronous SQLite.** `node:sqlite` calls are synchronous. Under heavy lock contention between several router processes, a write can briefly block a process's event loop, bounded by `busy_timeout` (5 s). Transactions are very short, so this matters only at high multi-process load.
- **Token estimates.** Without `gpt-tokenizer` installed, input is estimated at about 4 characters per token. The provider's reported usage is the source of truth after each call; between reservation and reconciliation, a large underestimate of the input can overshoot the budget by that difference.
- **Router streaming.** In Task 4, `stream: true` delivers the finished answer in streaming format; tokens are not relayed incrementally from the provider.
- **PII detection** is pattern-based (email, SSN, card, phone). Other identifier types, such as names, addresses or IBANs, are not detected. Over-redaction (for example, a 13–19 digit order number) is the intended failure mode.

---

## Project structure

```
src/
├── shared/                 api-keys.ts · logger.ts (secret masking) · errors.ts (JSON-RPC) · runtime.ts · mock-providers.ts
├── task1-mcp-server/       schemas.ts · tools.ts · index.ts
├── task2-mcp-gateway/      auth.ts · authorization.ts · proxy.ts · index.ts · mint-token.ts · mock-downstream/
├── task3-llm-guardrail/    sse-parser.ts · pii-detector.ts · stream-redactor.ts · index.ts
├── task4-rate-limiter/     database.ts · rate-limiter.ts · token-estimator.ts · tenants.ts · router.ts · index.ts
│   ├── providers/          types.ts · openai.ts · anthropic.ts
│   └── simulate/           burst simulation against a running router
├── tests/                  helpers.ts · task1–4.test.ts
└── demo/                   end-to-end demo (all four tasks, mock providers)
```

## Tech stack

| Concern | Choice | Reason |
|---------|--------|--------|
| MCP | `@modelcontextprotocol/sdk` (low-level `Server`; SDK client in tests) | Official SDK; real JSON-RPC error codes |
| Validation | `zod` 4 (`z.strictObject`, `z.toJSONSchema`) | One source for runtime validation and the advertised JSON Schema |
| Auth | HS256 JWT on `node:crypto` | No extra dependency; every verification rule explicit and auditable |
| Storage | `node:sqlite` (WAL, `BEGIN IMMEDIATE`) | Built in; atomic across processes; no native build |
| Claude | `@anthropic-ai/sdk` | Official SDK, typed errors |
| HTTP | Express 4 | Minimal and well understood |
| Tests | `node:test` | Built in; no test-framework dependency |

---

## Changes from v1 (historical)

> This section records designs that were **removed**. None of them exist in the current code. They are listed so reviewers comparing against the first submission can see what changed and why.

| Area | v1 (removed) | Problem | Current implementation |
|------|--------------|---------|------------------------|
| Task 1 | `McpServer` with default zod objects | Validation failures came back as successful `isError` results; unknown fields were silently dropped; `Infinity` and whitespace-padded reasons passed | Low-level `Server`, real `-32602` errors, strict schemas, finite and non-whitespace rules |
| Task 2 auth | Unsigned base64 token (`base64("role:admin")`) | Anyone could forge an admin token | HS256-signed JWT with signature, `exp`, `iss`, `aud` and role verification |
| Task 2 policy | `tools/list` and every method other than `tools/call` forwarded without authentication; `admin_` check case-sensitive; HTTP-only downstream (mock on port 3003) | No deny-by-default; a differently cased name such as `ADMIN_reset_key` skipped the check; the mock's port clashed with Task 3 | Authentication on every request, method allowlist, case-insensitive role policy, role-filtered `tools/list`, MCP Streamable HTTP, stdio bridge to Task 1, mock on `:3010` |
| Task 3 | Fixed 64-character overlap buffer, `delta.content` only | PII longer than the overlap, or split unluckily, could leak; other fields were not redacted; anyone could use the operator's key | Incremental SSE parser + safe-cut redactor with a proven invariant, per-field redaction, client API keys |
| Task 4 auth | `X-Tenant-Key` header trusted as the tenant ID, with a default tenant | Any caller could spend any tenant's budget | `Authorization: Bearer <tenant key>` validated against SHA-256 digests; no default tenant |
| Task 4 limits | Check the window → call the provider → record a character-based estimate | Concurrent requests could all pass the check and together exceed the budget; actual provider usage was never recorded | Atomic `BEGIN IMMEDIATE` reservations, output capped at the reservation, reconciliation to actual usage |

The demo and the tests still send v1-style requests on purpose, such as a forged base64 token or a bare `X-Tenant-Key` header, and assert that they are **rejected with 401**.
