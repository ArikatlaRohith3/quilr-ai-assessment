import express, { type NextFunction, type Request, type Response } from "express";
import { SseError, SseParser } from "./sse-parser.js";
import { StreamRedactor } from "./stream-redactor.js";
import { redactWithCount } from "./pii-detector.js";
import { gatewayError } from "../shared/errors.js";
import { createLogger } from "../shared/logger.js";
import { intFromEnv, isMain } from "../shared/runtime.js";

const log = createLogger("llm-guardrail");
const SOURCE = "llm-guardrail";

export interface GuardrailOptions {
  /** Base URL of an OpenAI-compatible API, e.g. https://api.openai.com */
  upstreamBaseUrl: string;
  apiKey: string;
  /** Max wait for upstream response headers. */
  headersTimeoutMs?: number;
  /** Max silence between two upstream chunks once streaming. */
  idleTimeoutMs?: number;
}

type ChatChunk = {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: Array<{ index?: number; delta?: Record<string, unknown> & { content?: unknown }; finish_reason?: unknown }>;
  usage?: unknown;
  error?: unknown;
};

/** Inbound: scrub PII from every text part of every message before it leaves our trust boundary. */
function redactMessages(messages: unknown[]): { messages: unknown[]; count: number } {
  let count = 0;
  const scrub = (s: string) => {
    const r = redactWithCount(s);
    count += r.count;
    return r.text;
  };
  const out = messages.map((m) => {
    if (!m || typeof m !== "object") return m;
    const msg = { ...(m as Record<string, unknown>) };
    if (typeof msg.content === "string") msg.content = scrub(msg.content);
    else if (Array.isArray(msg.content)) {
      msg.content = msg.content.map((part) =>
        part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
          ? { ...part, text: scrub((part as { text: string }).text) }
          : part,
      );
    }
    return msg;
  });
  return { messages: out, count };
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
    const body = req.body as Record<string, unknown>;
    if (!body || typeof body !== "object" || !Array.isArray(body.messages) || body.messages.length === 0) {
      res.status(400).json(gatewayError(400, "messages must be a non-empty array", SOURCE));
      return;
    }

    const inbound = redactMessages(body.messages);
    const upstreamBody = { ...body, messages: inbound.messages, stream: true };
    log.info("proxying completion", { inbound_redactions: inbound.count, messages: inbound.messages.length });

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
    const redactors = new Map<number, StreamRedactor>();
    const redactorFor = (i: number) => {
      let r = redactors.get(i);
      if (!r) redactors.set(i, (r = new StreamRedactor()));
      return r;
    };
    let template: Pick<ChatChunk, "id" | "object" | "created" | "model"> = { object: "chat.completion.chunk" };
    let doneSent = false;
    let malformed = 0;

    /** Emits whatever each choice still holds (redacted). Called on finish_reason, [DONE] and end-of-stream. */
    const flushAll = async () => {
      for (const [index, r] of redactors) {
        const tail = r.flush();
        if (tail) await sendData({ ...template, choices: [{ index, delta: { content: tail }, finish_reason: null }] });
      }
    };

    const handleEvent = async (data: string) => {
      if (doneSent) return; // anything after [DONE] is ignored; [DONE] is emitted exactly once
      if (data.trim() === "[DONE]") {
        await flushAll();
        await sendData("[DONE]");
        doneSent = true;
        return;
      }

      let chunk: ChatChunk;
      try {
        chunk = JSON.parse(data) as ChatChunk;
        if (!chunk || typeof chunk !== "object") throw new Error("not an object");
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

      template = { id: chunk.id, object: chunk.object ?? "chat.completion.chunk", created: chunk.created, model: chunk.model };
      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      let meaningful = chunk.usage !== undefined && chunk.usage !== null;

      for (const choice of choices) {
        const index = typeof choice.index === "number" ? choice.index : 0;
        const delta = choice.delta && typeof choice.delta === "object" ? choice.delta : undefined;
        const redactor = redactorFor(index);
        let content = "";
        if (delta && typeof delta.content === "string") content = redactor.push(delta.content);
        if (choice.finish_reason) content += redactor.flush();
        if (delta && "content" in delta) delta.content = content;
        else if (content) choice.delta = { ...(delta ?? {}), content };

        const otherDeltaKeys = delta ? Object.keys(delta).filter((k) => k !== "content") : [];
        if (content || choice.finish_reason || otherDeltaKeys.length > 0) meaningful = true;
      }
      // Frames whose only content is still held back are suppressed; the text is emitted later, redacted.
      if (meaningful || choices.length === 0) await sendData(chunk);
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
      const redactions = [...redactors.values()].reduce((s, r) => s + r.redactions, 0);
      log.info("stream finished", { outbound_redactions: redactions, malformed_frames: malformed, client_disconnected: clientGone });
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
  const port = intFromEnv("PORT", 3003);
  const app = createGuardrailApp({
    upstreamBaseUrl: process.env.LLM_BASE_URL ?? "https://api.openai.com",
    apiKey: process.env.LLM_API_KEY ?? "",
    headersTimeoutMs: intFromEnv("UPSTREAM_HEADERS_TIMEOUT_MS", 30_000),
    idleTimeoutMs: intFromEnv("UPSTREAM_IDLE_TIMEOUT_MS", 30_000),
  });
  app.listen(port, () => log.info("LLM Streaming Guardrail listening", { port }));
}
