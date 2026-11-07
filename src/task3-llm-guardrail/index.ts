import express, { type NextFunction, type Request, type Response } from "express";
import { SseError, SseParser } from "./sse-parser.js";
import { StreamRedactor } from "./stream-redactor.js";
import { redactWithCount } from "./pii-detector.js";
import { ApiKeyRegistry, parseKeyList } from "../shared/api-keys.js";
import { gatewayError } from "../shared/errors.js";
import { createLogger } from "../shared/logger.js";
import { intFromEnv, isMain } from "../shared/runtime.js";

const log = createLogger("llm-guardrail");
const SOURCE = "llm-guardrail";

export interface GuardrailOptions {
  /** Base URL of an OpenAI-compatible API, e.g. https://api.openai.com */
  upstreamBaseUrl: string;
  /** The operator's upstream key. Never taken from, or shown to, clients. */
  apiKey: string;
  /** Who may use the guardrail (Authorization: Bearer <client key>). Required: an open proxy would spend `apiKey` for anyone. */
  clients: ApiKeyRegistry;
  /** Max wait for upstream response headers. */
  headersTimeoutMs?: number;
  /** Max silence between two upstream chunks once streaming. */
  idleTimeoutMs?: number;
}

type Json = Record<string, unknown>;

// ── Outbound redaction model ─────────────────────────────────────────────────
//
// Text the model generates arrives in pieces spread over many frames, so a PII
// value can be split between frames. Every such field gets its own bounded
// StreamRedactor (per choice):
//   - delta.content, delta.refusal, delta.reasoning_content, delta.reasoning
//   - delta.tool_calls[i].function.arguments (keyed by the tool call's index)
// Every other string anywhere in the frame (tool names, ids, unknown provider
// extensions, array-style content…) is redacted in place, whole.
// `logprobs` is dropped entirely: it repeats the generated text one token at a
// time, which no per-frame redaction can make safe.

const STREAMED_TEXT_FIELDS = ["content", "refusal", "reasoning_content", "reasoning"] as const;
const toolKey = (i: number) => `tool:${i}`;

/** Redacts every string inside `value` (recursively), skipping the keys in `skip` at the top level. */
function redactDeep(value: unknown, skip: ReadonlySet<string> = new Set(), depth = 0): { value: unknown; count: number } {
  if (typeof value === "string") {
    const r = redactWithCount(value);
    return { value: r.text, count: r.count };
  }
  if (depth > 8 || value === null || typeof value !== "object") return { value, count: 0 };
  let count = 0;
  if (Array.isArray(value)) {
    const out = value.map((v) => {
      const r = redactDeep(v, undefined, depth + 1);
      count += r.count;
      return r.value;
    });
    return { value: out, count };
  }
  const out: Json = {};
  for (const [k, v] of Object.entries(value)) {
    if (skip.has(k)) {
      out[k] = v;
      continue;
    }
    const r = redactDeep(v, undefined, depth + 1);
    count += r.count;
    out[k] = r.value;
  }
  return { value: out, count };
}

/** All streaming redactors of one choice. */
class ChoiceRedaction {
  private readonly streams = new Map<string, StreamRedactor>();

  push(key: string, text: string): string {
    let r = this.streams.get(key);
    if (!r) this.streams.set(key, (r = new StreamRedactor()));
    return r.push(text);
  }

  /** Releases everything still held, as a delta in the upstream's own shape (or null if nothing was held). */
  flushDelta(): Json | null {
    const delta: Json = {};
    const toolCalls: Json[] = [];
    for (const [key, r] of this.streams) {
      const tail = r.flush();
      if (!tail) continue;
      if (key.startsWith("tool:")) toolCalls.push({ index: Number(key.slice(5)), function: { arguments: tail } });
      else delta[key] = tail;
    }
    if (toolCalls.length) delta.tool_calls = toolCalls;
    return Object.keys(delta).length ? delta : null;
  }

  get redactions(): number {
    let n = 0;
    for (const r of this.streams.values()) n += r.redactions;
    return n;
  }
}

/** Appends a flushed delta onto the delta of the frame that carries finish_reason. */
function mergeDelta(target: Json, extra: Json): void {
  for (const [k, v] of Object.entries(extra)) {
    if (k !== "tool_calls") {
      target[k] = (typeof target[k] === "string" ? (target[k] as string) : "") + (v as string);
      continue;
    }
    const calls = Array.isArray(target.tool_calls) ? (target.tool_calls as Json[]) : (target.tool_calls = []) as Json[];
    for (const tail of v as Json[]) {
      const existing = calls.find((c) => c && c.index === tail.index);
      const tailArgs = (tail.function as Json).arguments as string;
      if (!existing) calls.push(tail);
      else {
        const fn = (existing.function && typeof existing.function === "object" ? existing.function : (existing.function = {})) as Json;
        fn.arguments = (typeof fn.arguments === "string" ? fn.arguments : "") + tailArgs;
      }
    }
  }
}

/** Inbound: scrub PII from every string of every message (text, content parts, tool-call arguments, names) before it leaves our trust boundary. */
function redactMessages(messages: unknown[]): { messages: unknown[]; count: number } {
  const r = redactDeep(messages);
  return { messages: r.value as unknown[], count: r.count };
}

function sanitizedUpstreamStatus(status: number): { status: number; message: string } {
  if (status === 429) return { status: 429, message: "Upstream rate limit exceeded" };
  if (status === 400 || status === 404 || status === 422) return { status: 400, message: "Upstream rejected the request" };
  return { status: 502, message: `Upstream error (${status})` };
}

export function createGuardrailApp(opts: GuardrailOptions) {
  const headersTimeoutMs = opts.headersTimeoutMs ?? 30_000;
  const idleTimeoutMs = opts.idleTimeoutMs ?? 30_000;

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (_req, res) => res.json({ status: "ok", service: SOURCE }));

  app.post("/v1/chat/completions", async (req: Request, res: Response) => {
    // 0. Authenticate the caller before anything is sent upstream on the operator's key.
    const client = opts.clients.authenticate(req.headers.authorization);
    if (!client) {
      log.warn("rejected unauthenticated request");
      res.setHeader("WWW-Authenticate", 'Bearer realm="llm-guardrail"');
      res.status(401).json(gatewayError(401, "Invalid or missing API key", SOURCE));
      return;
    }

    const body = req.body as Json;
    if (!body || typeof body !== "object" || !Array.isArray(body.messages) || body.messages.length === 0) {
      res.status(400).json(gatewayError(400, "messages must be a non-empty array", SOURCE));
      return;
    }

    const inbound = redactMessages(body.messages);
    // logprobs would echo generated text token by token, outside the redactors' reach.
    const { logprobs: _lp, top_logprobs: _tlp, ...rest } = body;
    const upstreamBody = { ...rest, messages: inbound.messages, stream: true };
    log.info("proxying completion", { client, inbound_redactions: inbound.count, messages: inbound.messages.length });

    // One controller cancels the upstream request on client disconnect, header timeout or idle timeout.
    const upstreamAbort = new AbortController();
    let clientGone = false;
    res.on("close", () => {
      if (!res.writableEnded) {
        clientGone = true;
        upstreamAbort.abort();
        log.info("client disconnected; upstream request cancelled");
      }
    });

    let timer = setTimeout(() => upstreamAbort.abort(), headersTimeoutMs);
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(`${opts.upstreamBaseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify(upstreamBody),
        signal: upstreamAbort.signal,
      });
    } catch {
      clearTimeout(timer);
      if (!clientGone) res.status(504).json(gatewayError(504, "LLM provider unreachable or timed out", SOURCE));
      return;
    }
    clearTimeout(timer);

    if (!upstream.ok || !upstream.body) {
      // The upstream body may echo the prompt or internal details — never forward it.
      upstream.body?.cancel().catch(() => {});
      const mapped = sanitizedUpstreamStatus(upstream.status);
      log.warn("upstream error", { status: upstream.status });
      res.status(mapped.status).json(gatewayError(mapped.status, mapped.message, SOURCE));
      return;
    }

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const write = async (frame: string) => {
      if (clientGone) return;
      if (!res.write(frame)) await new Promise<void>((r) => res.once("drain", () => r()).once("close", () => r()));
    };
    const sendData = (payload: unknown) => write(`data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`);

    const parser = new SseParser();
    const choices = new Map<number, ChoiceRedaction>();
    const choiceState = (i: number) => {
      let c = choices.get(i);
      if (!c) choices.set(i, (c = new ChoiceRedaction()));
      return c;
    };
    let template: Json = { object: "chat.completion.chunk" };
    let doneSent = false;
    let malformed = 0;
    let wholeFieldRedactions = 0;

    /** Emits whatever each choice still holds (redacted). Called on [DONE], error events and end-of-stream. */
    const flushAll = async () => {
      for (const [index, state] of choices) {
        const delta = state.flushDelta();
        if (delta) await sendData({ ...template, choices: [{ index, delta, finish_reason: null }] });
      }
    };

    /** Redacts one choice in place. Returns true if the frame must be sent for this choice. */
    const processChoice = (choice: Json): boolean => {
      const index = typeof choice.index === "number" ? choice.index : 0;
      const state = choiceState(index);
      let meaningful = false;

      if ("logprobs" in choice) choice.logprobs = null;
      // Everything on the choice except the delta (index, finish_reason, provider extras) — redacted whole.
      const others = redactDeep(choice, new Set(["delta", "index", "finish_reason", "logprobs"]));
      wholeFieldRedactions += others.count;
      Object.assign(choice, others.value);

      const delta = choice.delta && typeof choice.delta === "object" && !Array.isArray(choice.delta) ? (choice.delta as Json) : undefined;
      if (delta) {
        // 1. Streamed text fields.
        for (const field of STREAMED_TEXT_FIELDS) {
          if (typeof delta[field] !== "string") continue;
          delta[field] = state.push(field, delta[field] as string);
          if (delta[field]) meaningful = true;
        }
        // 2. Tool calls: arguments are streamed; everything else (id, type, name) is redacted whole.
        if (Array.isArray(delta.tool_calls)) {
          delta.tool_calls = (delta.tool_calls as unknown[]).map((raw, pos) => {
            if (!raw || typeof raw !== "object") return raw;
            const tc = raw as Json;
            const tcIndex = typeof tc.index === "number" ? tc.index : pos;
            const fn = tc.function && typeof tc.function === "object" ? (tc.function as Json) : undefined;
            const r = redactDeep({ ...tc, function: undefined }, new Set(["index", "function"]));
            wholeFieldRedactions += r.count;
            const out = r.value as Json;
            if (Object.keys(out).some((k) => k !== "index" && k !== "function" && out[k] !== undefined)) meaningful = true;
            if (fn) {
              const fr = redactDeep(fn, new Set(["arguments"]));
              wholeFieldRedactions += fr.count;
              const fnOut = fr.value as Json;
              if (typeof fn.arguments === "string") {
                fnOut.arguments = state.push(toolKey(tcIndex), fn.arguments);
                if (fnOut.arguments) meaningful = true;
              }
              if (Object.keys(fnOut).some((k) => k !== "arguments")) meaningful = true;
              out.function = fnOut;
            } else delete out.function;
            return out;
          });
        }
        // 3. Any other delta field (role, array-style content, provider extensions) — redacted whole.
        const skip = new Set<string>([...STREAMED_TEXT_FIELDS, "tool_calls"]);
        const rest = redactDeep(delta, skip);
        wholeFieldRedactions += rest.count;
        Object.assign(delta, rest.value);
        if (Object.keys(delta).some((k) => !skip.has(k))) meaningful = true;
        for (const field of STREAMED_TEXT_FIELDS) if (field in delta && typeof delta[field] !== "string") meaningful = true;
      }

      // 4. finish_reason: release this choice's held text in the same frame.
      if (choice.finish_reason) {
        const tail = state.flushDelta();
        if (tail) {
          const target = delta ?? ((choice.delta = {}) as Json);
          mergeDelta(target, tail);
        }
        meaningful = true;
      }
      return meaningful;
    };

    const handleEvent = async (data: string) => {
      if (doneSent) return; // anything after [DONE] is ignored; [DONE] is emitted exactly once
      if (data.trim() === "[DONE]") {
        await flushAll();
        await sendData("[DONE]");
        doneSent = true;
        return;
      }

      let chunk: Json;
      try {
        chunk = JSON.parse(data) as Json;
        if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) throw new Error("not an object");
      } catch {
        // Fail closed: an unparseable frame is dropped, never passed through raw.
        malformed++;
        log.warn("dropped malformed SSE frame", { length: data.length });
        return;
      }

      if (chunk.error !== undefined) {
        log.warn("upstream sent an error event");
        await flushAll();
        await sendData({ error: { code: 502, message: "Upstream error during streaming", source: SOURCE } });
        doneSent = true;
        return;
      }

      // Top-level fields other than choices (id, model, usage, provider extras) — redacted whole.
      const top = redactDeep(chunk, new Set(["choices"]));
      wholeFieldRedactions += top.count;
      chunk = top.value as Json;
      template = { id: chunk.id, object: chunk.object ?? "chat.completion.chunk", created: chunk.created, model: chunk.model };

      const list = Array.isArray(chunk.choices) ? (chunk.choices as unknown[]) : [];
      let meaningful = chunk.usage !== undefined && chunk.usage !== null;
      for (const choice of list) {
        if (choice && typeof choice === "object" && processChoice(choice as Json)) meaningful = true;
      }
      // Frames whose only text is still held back are suppressed; the text is emitted later, redacted.
      if (meaningful || list.length === 0) await sendData(chunk);
    };

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    const resetIdle = () => {
      clearTimeout(timer);
      timer = setTimeout(() => upstreamAbort.abort(), idleTimeoutMs);
    };

    try {
      resetIdle();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        resetIdle();
        for (const ev of parser.push(decoder.decode(value, { stream: true }))) await handleEvent(ev.data);
        if (clientGone) break;
      }
      for (const ev of parser.push(decoder.decode())) await handleEvent(ev.data);
      for (const ev of parser.end()) await handleEvent(ev.data);

      if (!doneSent && !clientGone) {
        // Upstream closed without [DONE]: release what we hold (redacted) and signal the truncation.
        await flushAll();
        await sendData({ error: { code: 502, message: "Upstream stream ended unexpectedly", source: SOURCE } });
      }
    } catch (err) {
      if (!clientGone) {
        const reason = err instanceof SseError ? "oversized SSE event" : upstreamAbort.signal.aborted ? "upstream idle timeout" : "upstream stream error";
        log.warn("stream aborted", { reason });
        // Held-back text is discarded on error: it may be an incomplete PII candidate.
        await sendData({ error: { code: 502, message: "Upstream stream interrupted", source: SOURCE } });
      }
      upstreamAbort.abort();
    } finally {
      clearTimeout(timer);
      reader.cancel().catch(() => {});
      const streamed = [...choices.values()].reduce((s, c) => s + c.redactions, 0);
      log.info("stream finished", {
        client, outbound_redactions: streamed + wholeFieldRedactions, malformed_frames: malformed, client_disconnected: clientGone,
      });
      if (!res.writableEnded) res.end();
    }
  });

  app.use((err: Error & { type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    if (err.type === "entity.parse.failed") return res.status(400).json(gatewayError(400, "Invalid JSON body", SOURCE));
    if (err.type === "entity.too.large") return res.status(413).json(gatewayError(413, "Request too large", SOURCE));
    log.error("unhandled error", { error: err.message });
    res.status(500).json(gatewayError(500, "Internal error", SOURCE));
  });

  return app;
}

if (isMain(import.meta.url)) {
  let clients: ApiKeyRegistry;
  try {
    clients = new ApiKeyRegistry(parseKeyList(process.env.GUARDRAIL_API_KEYS ?? "", "GUARDRAIL_API_KEYS"));
    if (clients.size === 0) throw new Error("GUARDRAIL_API_KEYS must define at least one client (clientId:apiKey,...)");
  } catch (err) {
    log.error("fatal", { error: (err as Error).message });
    process.exit(1);
  }
  const port = intFromEnv("PORT", 3003);
  const app = createGuardrailApp({
    upstreamBaseUrl: process.env.LLM_BASE_URL ?? "https://api.openai.com",
    apiKey: process.env.LLM_API_KEY ?? "",
    clients,
    headersTimeoutMs: intFromEnv("UPSTREAM_HEADERS_TIMEOUT_MS", 30_000),
    idleTimeoutMs: intFromEnv("UPSTREAM_IDLE_TIMEOUT_MS", 30_000),
  });
  app.listen(port, () => log.info("LLM Streaming Guardrail listening", { port, clients: clients.size }));
}
