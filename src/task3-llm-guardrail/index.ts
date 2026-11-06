import express, { Request, Response } from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT ?? 3003;
const LLM_BASE_URL = process.env.LLM_BASE_URL ?? "https://api.openai.com";
const LLM_API_KEY = process.env.LLM_API_KEY ?? "";

// PII redaction patterns
const PII_PATTERNS: { name: string; regex: RegExp }[] = [
  { name: "email",       regex: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g },
  { name: "ssn",         regex: /\b\d{3}-\d{2}-\d{4}\b/g },
  { name: "credit_card", regex: /\b(?:\d[ -]?){13,16}\b/g },
  { name: "phone",       regex: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g },
];

function redact(text: string): string {
  let result = text;
  for (const { regex } of PII_PATTERNS) {
    result = result.replace(regex, "[REDACTED]");
  }
  return result;
}

// Stream buffer state — carry-over from previous chunk to handle patterns spanning chunk boundaries
class StreamBuffer {
  private buffer = "";
  // Keep last N chars as overlap to catch patterns split across chunks
  private readonly OVERLAP = 64;

  process(delta: string): string {
    this.buffer += delta;

    // Keep overlap at the end, flush everything before it
    if (this.buffer.length <= this.OVERLAP) return "";

    const flushTo = this.buffer.length - this.OVERLAP;
    const toFlush = this.buffer.slice(0, flushTo);
    this.buffer = this.buffer.slice(flushTo);

    return redact(toFlush);
  }

  flush(): string {
    const remaining = redact(this.buffer);
    this.buffer = "";
    return remaining;
  }
}

app.get("/health", (_req, res) => res.json({ status: "ok", service: "llm-guardrail" }));

// POST /v1/chat/completions — proxy with streaming PII redaction
app.post("/v1/chat/completions", async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;

  // Force streaming
  body.stream = true;

  console.log(`[guardrail] Proxying completion request to LLM provider`);

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(`${LLM_BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LLM_API_KEY}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    res.status(502).json({ error: { message: "LLM provider unreachable", source: "llm-guardrail" } });
    return;
  }

  if (!upstream.ok || !upstream.body) {
    res.status(upstream.status >= 500 ? 502 : upstream.status).json({
      error: { message: `Upstream error (${upstream.status})`, source: "llm-guardrail" },
    });
    return;
  }

  // Stream SSE back to client with PII redaction applied to content deltas
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");

  const streamBuf = new StreamBuffer();
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const raw = decoder.decode(value, { stream: true });

      // SSE lines: "data: {...}\n\n" or "data: [DONE]\n\n"
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;

        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") {
          // Flush remaining buffer before ending
          const tail = streamBuf.flush();
          if (tail) {
            // We can't rewrite past SSE frames, so emit a synthetic final delta
            const finalChunk = { choices: [{ delta: { content: tail }, finish_reason: null }] };
            res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
          }
          res.write("data: [DONE]\n\n");
          continue;
        }

        try {
          const chunk = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const content = chunk.choices?.[0]?.delta?.content;

          if (content) {
            const flushed = streamBuf.process(content);
            if (flushed) {
              // Replace the content delta with redacted version
              chunk.choices![0].delta!.content = flushed;
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            }
            // If nothing to flush yet, suppress this chunk (will be emitted later)
          } else {
            // Non-content frame (role, finish_reason, etc.) — pass through
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }
        } catch {
          // Malformed JSON in stream — pass raw line through
          res.write(`${line}\n`);
        }
      }
    }
  } finally {
    reader.releaseLock();
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`[guardrail] LLM Streaming Guardrail running on http://localhost:${PORT}`);
});
