/**
 * In-process mock servers used by the tests and the demo — no API keys or network needed.
 *  - mockOpenAI:     OpenAI Chat Completions (JSON), with selectable failure modes
 *  - mockAnthropic:  Claude Messages API (JSON)
 *  - mockSseUpstream: OpenAI-style streaming endpoint driven by a script that writes raw bytes
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

export interface MockServer {
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

const readBody = (req: http.IncomingMessage) =>
  new Promise<string>((resolve) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });

async function start(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: any) => Promise<void> | void): Promise<MockServer & { server: http.Server }> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer(async (req, res) => {
    const raw = await readBody(req);
    let body: any = raw;
    try { body = raw ? JSON.parse(raw) : undefined; } catch { /* keep raw */ }
    requests.push({ path: req.url ?? "", headers: req.headers, body });
    try {
      await handler(req, res, body);
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

export type MockMode = "ok" | "429" | "500" | "400" | "slow" | "garbage";

export interface MockLlmOptions {
  mode?: MockMode;
  delayMs?: number;
  content?: string;
  /** Report token usage in the response (default true). */
  usage?: { input: number; output: number } | false;
}

export interface MockLlm extends MockServer {
  options: MockLlmOptions;
}

/** Failure bodies deliberately contain "secret" internals so tests can prove they never reach clients. */
const LEAKY_ERROR = { error: { message: "INTERNAL: stack trace at /srv/provider/handler.js:42 key=sk-live-SECRET" } };

async function failOrDelay(res: http.ServerResponse, o: MockLlmOptions): Promise<boolean> {
  const mode = o.mode ?? "ok";
  if (o.delayMs) await sleep(o.delayMs);
  // unref: a hanging mock must not keep the test process alive
  if (mode === "slow") await new Promise((r) => setTimeout(r, 60_000).unref());
  if (mode === "429") { json(res, 429, LEAKY_ERROR, { "retry-after": "1" }); return true; }
  if (mode === "500") { json(res, 500, LEAKY_ERROR); return true; }
  if (mode === "400") { json(res, 400, LEAKY_ERROR); return true; }
  if (mode === "garbage") { res.writeHead(200, { "Content-Type": "application/json" }); res.end("<html>oops"); return true; }
  return false;
}

export async function mockOpenAI(options: MockLlmOptions = {}): Promise<MockLlm> {
  // Handlers read `mock.options` at request time, so tests can reassign it between requests.
  let mock!: MockLlm;
  const srv = await start(async (_req, res, body) => {
    const o = mock.options;
    if (await failOrDelay(res, o)) return;
    const usage = o.usage === undefined ? { input: 11, output: 7 } : o.usage;
    json(res, 200, {
      id: "chatcmpl-mock",
      object: "chat.completion",
      model: body?.model ?? "gpt-mock",
      choices: [{ index: 0, message: { role: "assistant", content: o.content ?? "Hello from primary" }, finish_reason: "stop" }],
      ...(usage ? { usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output } } : {}),
    });
  });
  mock = Object.assign(srv, { options });
  return mock;
}

export async function mockAnthropic(options: MockLlmOptions = {}): Promise<MockLlm> {
  // Handlers read `mock.options` at request time, so tests can reassign it between requests.
  let mock!: MockLlm;
  const srv = await start(async (req, res, body) => {
    const o = mock.options;
    if (!req.url?.startsWith("/v1/messages")) return json(res, 404, { type: "error", error: { type: "not_found_error", message: "not found" } });
    if (await failOrDelay(res, o)) return;
    const usage = o.usage === undefined ? { input: 13, output: 9 } : o.usage;
    json(res, 200, {
      id: "msg_mock",
      type: "message",
      role: "assistant",
      model: body?.model ?? "claude-mock",
      content: [{ type: "text", text: o.content ?? "Hello from fallback" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: usage ? { input_tokens: usage.input, output_tokens: usage.output } : { input_tokens: 0, output_tokens: 0 },
    });
  });
  mock = Object.assign(srv, { options });
  return mock;
}

/** Streaming upstream. `script` writes raw bytes however it likes (split frames, delays, malformed data...). */
export interface SseUpstream extends MockServer {
  /** Resolves when the guardrail closes the upstream connection (client-disconnect propagation). */
  closed: Promise<void>;
}

export async function mockSseUpstream(
  script: (res: http.ServerResponse, body: any) => Promise<void>,
  opts: { status?: number } = {},
): Promise<SseUpstream> {
  let markClosed!: () => void;
  const closed = new Promise<void>((r) => (markClosed = r));
  const srv = await start(async (_req, res, body) => {
    res.on("close", () => markClosed());
    if (opts.status && opts.status !== 200) return json(res, opts.status, LEAKY_ERROR);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.flushHeaders();
    await script(res, body);
    if (!res.writableEnded) res.end();
  });
  return Object.assign(srv, { closed });
}

/** Builds OpenAI-style SSE text for the given content deltas. */
export function sseFrames(deltas: string[], opts: { done?: boolean } = {}): string {
  const base = { id: "chatcmpl-x", object: "chat.completion.chunk", created: 1, model: "gpt-mock" };
  let out = `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`;
  for (const d of deltas) out += `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: d }, finish_reason: null }] })}\n\n`;
  out += `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`;
  if (opts.done !== false) out += "data: [DONE]\n\n";
  return out;
}

/** Writes `text` in slices of the given sizes (cycled), optionally pausing between writes. */
export async function writeInSlices(res: http.ServerResponse, text: string, sizes: number[], pauseMs = 0): Promise<void> {
  const bytes = Buffer.from(text, "utf8");
  let i = 0;
  let k = 0;
  while (i < bytes.length) {
    const n = Math.max(1, sizes[k++ % sizes.length]);
    res.write(bytes.subarray(i, i + n));
    i += n;
    if (pauseMs) await sleep(pauseMs);
    else await new Promise((r) => setImmediate(r));
  }
}
