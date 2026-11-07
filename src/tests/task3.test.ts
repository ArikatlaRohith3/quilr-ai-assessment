import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SseParser, SseError } from "../task3-llm-guardrail/sse-parser.js";
import { redact, findSafeCut, MAX_HOLDBACK } from "../task3-llm-guardrail/pii-detector.js";
import { StreamRedactor } from "../task3-llm-guardrail/stream-redactor.js";
import { createGuardrailApp } from "../task3-llm-guardrail/index.js";
import { mockSseUpstream, sseFrames, writeInSlices } from "../shared/mock-providers.js";
import { serve, rng, sleep, captureLogs } from "./helpers.js";
import { ApiKeyRegistry } from "../shared/api-keys.js";

const CLIENT_KEY = "guardrail-client-key-0123456789";
const CLIENTS = new ApiKeyRegistry([{ id: "test-app", apiKey: CLIENT_KEY }]);
const CLIENT_HEADERS = { "Content-Type": "application/json", Authorization: `Bearer ${CLIENT_KEY}` };

const PII = ["jane.doe@example.com", "123-45-6789", "4111 1111 1111 1111", "4111-1111-1111-1111", "4111111111111111", "(555) 867-5309", "+1 555 867 5309", "555.867.5309", "+447911123456"];

/** Things that must never appear in output (sub-fragments that would still identify the value). */
const LEAK_MARKERS = ["jane.doe", "example.com", "45-6789", "1111 1111", "1111-1111", "41111111", "867-5309", "867 5309", "867.5309", "7911123456"];
const assertNoLeak = (out: string) => {
  for (const m of LEAK_MARKERS) assert.ok(!out.includes(m), `leaked "${m}" in: ${out}`);
};

describe("Task 3 — PII patterns", () => {
  test("each pattern is redacted", () => {
    for (const p of PII) assert.equal(redact(`x ${p} y`), "x [REDACTED] y", p);
  });
  test("clean text untouched", () => {
    for (const t of ["hello world", "Version 1.2.3 shipped in 2024", "call me maybe", "ref 12-34-567"]) assert.equal(redact(t), t);
  });
});

describe("Task 3 — incremental SSE parser", () => {
  const stream = 'data: {"a":1}\n\n:keep-alive\n\nevent: custom\ndata: line1\ndata: line2\n\ndata: [DONE]\n\n';
  const expected = [
    { event: "message", data: '{"a":1}' },
    { event: "custom", data: "line1\nline2" },
    { event: "message", data: "[DONE]" },
  ];
  const strip = (evs: any[]) => evs.map(({ event, data }) => ({ event, data }));

  test("same events for every possible 2-way split", () => {
    for (let i = 0; i <= stream.length; i++) {
      const p = new SseParser();
      assert.deepEqual(strip([...p.push(stream.slice(0, i)), ...p.push(stream.slice(i)), ...p.end()]), expected, `split at ${i}`);
    }
  });

  test("byte-by-byte, and with CRLF / CR line endings split mid-pair", () => {
    for (const variant of [stream, stream.replace(/\n/g, "\r\n"), stream.replace(/\n/g, "\r")]) {
      const p = new SseParser();
      const evs = [];
      for (const ch of variant) evs.push(...p.push(ch));
      evs.push(...p.end());
      assert.deepEqual(strip(evs), expected);
    }
  });

  test("incomplete trailing event is discarded at end of stream", () => {
    const p = new SseParser();
    assert.deepEqual(p.push('data: {"partial":'), []);
    assert.deepEqual(p.end(), []);
  });

  test("oversized events throw (bounded memory)", () => {
    const p = new SseParser(1000);
    assert.throws(() => p.push("data: " + "x".repeat(2000)), SseError);
  });
});

describe("Task 3 — streaming redactor", () => {
  const runStream = (chunks: string[]) => {
    const r = new StreamRedactor();
    return chunks.map((c) => r.push(c)).join("") + r.flush();
  };

  test("streamed output equals redact(full text) for EVERY split point", () => {
    for (const p of PII) {
      const full = `My details: ${p}, thanks!`;
      for (let i = 0; i <= full.length; i++) {
        const out = runStream([full.slice(0, i), full.slice(i)]);
        assert.equal(out, redact(full), `${p} split at ${i}`);
      }
    }
  });

  test("character-by-character streaming never leaks", () => {
    const full = `Email ${PII[0]}, SSN ${PII[1]}, card ${PII[2]}, phone ${PII[5]} and ${PII[6]}.`;
    const out = runStream([...full]);
    assert.equal(out, redact(full));
    assertNoLeak(out);
  });

  test("fuzz: random text + random chunking ≡ redact(full)", () => {
    const rand = rng(42);
    const words = ["the", "order", "shipped", "on", "2024-05-01", "total", "$19.99", "ref", "A1B2", "(", ")", "-", "+", "x@y", "a.b", ...PII];
    for (let iter = 0; iter < 400; iter++) {
      let full = "";
      const n = 5 + Math.floor(rand() * 30);
      for (let k = 0; k < n; k++) full += words[Math.floor(rand() * words.length)] + (rand() < 0.15 ? "\n" : " ");
      const chunks: string[] = [];
      for (let i = 0; i < full.length; ) {
        const size = 1 + Math.floor(rand() * 12);
        chunks.push(full.slice(i, i + size));
        i += size;
      }
      assert.equal(runStream(chunks), redact(full), `iteration ${iter}: ${JSON.stringify(full)}`);
    }
  });

  test("prose is released immediately (only the current word is held)", () => {
    const r = new StreamRedactor();
    assert.equal(r.push("Hello there, how are "), "Hello there, how are ");
    assert.equal(r.push("you"), "");
    assert.equal(r.push(" today"), "you ");
  });

  test("memory stays bounded on adversarial input", () => {
    const r = new StreamRedactor();
    let max = 0;
    for (let i = 0; i < 2000; i++) {
      r.push("a".repeat(50)); // 100 KB with no break: one giant "word"
      max = Math.max(max, r.bufferedChars);
    }
    assert.ok(max <= MAX_HOLDBACK + 50, `held ${max} chars`);
    const r2 = new StreamRedactor();
    for (let i = 0; i < 20000; i++) r2.push("lorem ipsum dolor sit amet ");
    assert.ok(r2.bufferedChars < 20);
  });

  test("findSafeCut never cuts inside a PII chain", () => {
    assert.equal(findSafeCut("call (555) 867-53"), "call ".length);
    assert.equal(findSafeCut("card 4111 1111 "), "card ".length);
    assert.equal(findSafeCut("mail jane@exa"), "mail ".length);
    assert.equal(findSafeCut("done. "), "done. ".length);
  });
});

// ── End-to-end through the HTTP proxy ─────────────────────────────────────────

async function collect(url: string, body: unknown = { model: "m", messages: [{ role: "user", content: "hi" }] }) {
  const res = await fetch(`${url}/v1/chat/completions`, { method: "POST", headers: CLIENT_HEADERS, body: JSON.stringify(body) });
  const raw = await res.text();
  const events = raw.split("\n\n").filter(Boolean).map((f) => f.replace(/^data: /, ""));
  const content = events
    .filter((e) => e.startsWith("{"))
    .map((e) => JSON.parse(e))
    .map((c) => c.choices?.[0]?.delta?.content ?? "")
    .join("");
  return { status: res.status, raw, events, content };
}

async function withGuardrail<T>(script: Parameters<typeof mockSseUpstream>[0], fn: (url: string, upstream: Awaited<ReturnType<typeof mockSseUpstream>>) => Promise<T>, status?: number) {
  const upstream = await mockSseUpstream(script, { status });
  const gw = await serve(createGuardrailApp({ upstreamBaseUrl: upstream.url, apiKey: "sk-test", clients: CLIENTS, idleTimeoutMs: 2000 }));
  try {
    return await fn(gw.url, upstream);
  } finally {
    await gw.close();
    await upstream.close();
  }
}

describe("Task 3 — guardrail proxy end-to-end", () => {
  const text = `Sure! Email ${PII[0]}, SSN ${PII[1]}, card ${PII[2]}, phone ${PII[5]}.`;

  test("PII split across network reads at arbitrary byte boundaries is redacted (email/SSN/card)", async () => {
    // Content deltas are split mid-PII AND the SSE bytes are split mid-JSON / mid-"data:".
    const deltas = ["Sure! Email jane.d", "oe@exam", "ple.com, SSN 123-4", "5-6789, card 4111 11", "11 1111 1111, phone (555) 8", "67-5309."];
    for (const sizes of [[1], [3, 7], [17], [64, 5, 1]]) {
      const r = await withGuardrail((res) => writeInSlices(res, sseFrames(deltas), sizes), (url) => collect(url));
      assert.equal(r.status, 200);
      assert.equal(r.content, redact(text), `slices ${sizes}`);
      assertNoLeak(r.raw);
      assert.equal(r.events.filter((e) => e === "[DONE]").length, 1);
    }
  });

  test("[DONE] is emitted exactly once even if upstream repeats it", async () => {
    const r = await withGuardrail(async (res) => { res.write(sseFrames(["hello"]) + "data: [DONE]\n\n"); }, (url) => collect(url));
    assert.equal(r.events.filter((e) => e === "[DONE]").length, 1);
    assert.equal(r.content, "hello");
  });

  test("malformed SSE frames are dropped, never passed through raw", async () => {
    const r = await withGuardrail(async (res) => {
      res.write('data: {"choices":[{"delta":{"content":"SSN 123-45-6789"\n\n'); // truncated JSON containing PII
      res.write(sseFrames(["ok"]));
    }, (url) => collect(url));
    assertNoLeak(r.raw);
    assert.equal(r.content, "ok");
  });

  test("upstream ending without [DONE] → held text released redacted + error event", async () => {
    const r = await withGuardrail((res) => writeInSlices(res, sseFrames(["call me at (555) 867-", "5309"], { done: false }), [9]), (url) => collect(url));
    assertNoLeak(r.raw);
    assert.match(r.raw, /Upstream stream ended unexpectedly/);
    assert.equal(r.events.includes("[DONE]"), false);
  });

  test("multi-line data: fields are joined correctly", async () => {
    const r = await withGuardrail(async (res) => {
      res.write('data: {"choices":[{"index":0,\ndata: "delta":{"content":"SSN 123-45-6789 ok"}}]}\n\ndata: [DONE]\n\n');
    }, (url) => collect(url));
    assert.equal(r.content, "SSN [REDACTED] ok");
  });

  test("inbound prompt PII is redacted before reaching the provider", async () => {
    await withGuardrail(async (res) => { res.write(sseFrames(["ok"])); }, async (url, upstream) => {
      await collect(url, { model: "m", messages: [{ role: "user", content: `I am ${PII[0]}, SSN ${PII[1]}` }, { role: "user", content: [{ type: "text", text: `card ${PII[2]}` }] }] });
      const sent = JSON.stringify(upstream.requests[0].body);
      assertNoLeak(sent);
      assert.equal(upstream.requests[0].body.stream, true);
      assert.equal(upstream.requests[0].headers.authorization, "Bearer sk-test");
    });
  });

  test("upstream HTTP errors are sanitized", async () => {
    const r = await withGuardrail(async () => {}, async (url) => {
      const res = await fetch(`${url}/v1/chat/completions`, { method: "POST", headers: CLIENT_HEADERS, body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }) });
      return { status: res.status, text: await res.text() };
    }, 500);
    assert.equal(r.status, 502);
    assert.ok(!r.text.includes("SECRET") && !r.text.includes("stack trace"));
  });

  test("client disconnect cancels the upstream request", async () => {
    await withGuardrail(async (res) => {
      res.write(sseFrames(["first words "], { done: false }));
      for (let i = 0; i < 200 && !res.destroyed; i++) { res.write(sseFrames(["more "], { done: false })); await sleep(50); }
    }, async (url, upstream) => {
      const ac = new AbortController();
      const res = await fetch(`${url}/v1/chat/completions`, { method: "POST", headers: CLIENT_HEADERS, body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }), signal: ac.signal });
      const reader = res.body!.getReader();
      await reader.read();
      ac.abort();
      const started = Date.now();
      await Promise.race([upstream.closed, sleep(3000).then(() => { throw new Error("upstream not cancelled within 3s"); })]);
      assert.ok(Date.now() - started < 3000);
    });
  });

  test("latency: first tokens reach the client before upstream finishes (no full buffering)", async () => {
    await withGuardrail(async (res) => {
      res.write(sseFrames(["Hello there, here is the answer "], { done: false }));
      await sleep(800);
      res.write(sseFrames(["done"]));
    }, async (url) => {
      const t0 = Date.now();
      const res = await fetch(`${url}/v1/chat/completions`, { method: "POST", headers: CLIENT_HEADERS, body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }) });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let seen = "";
      while (!seen.includes("Hello there")) seen += dec.decode((await reader.read()).value);
      const ttft = Date.now() - t0;
      assert.ok(ttft < 500, `TTFT ${ttft}ms`);
      await reader.cancel();
    });
  });

  test("logs contain counts, never the PII itself", async () => {
    const { logs } = await captureLogs(() => withGuardrail(async (res) => { res.write(sseFrames([`ssn ${PII[1]}`])); }, (url) =>
      collect(url, { messages: [{ role: "user", content: `mail ${PII[0]}` }] })));
    assertNoLeak(logs);
    assert.match(logs, /inbound_redactions/);
    assert.match(logs, /outbound_redactions/);
  });
});

// ─────────────── audit fixes: client auth (C2) and non-content fields (C1) ───────────────

const frame = (choice: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  `data: ${JSON.stringify({ id: "chatcmpl-x", object: "chat.completion.chunk", created: 1, model: "gpt-mock", choices: [{ index: 0, finish_reason: null, ...choice }], ...extra })}\n\n`;

/** Reassembles every streamed text field the client received, per choice 0. */
function reassemble(raw: string) {
  const out = { content: "", refusal: "", reasoning_content: "", tools: new Map<number, { name: string; args: string }>() };
  for (const ev of raw.split("\n\n").filter((e) => e.startsWith("data: {"))) {
    const c = JSON.parse(ev.slice(6));
    for (const ch of c.choices ?? []) {
      const d = ch.delta ?? {};
      for (const f of ["content", "refusal", "reasoning_content"] as const) if (typeof d[f] === "string") out[f] += d[f];
      for (const tc of d.tool_calls ?? []) {
        const t = out.tools.get(tc.index) ?? { name: "", args: "" };
        if (tc.function?.name) t.name += tc.function.name;
        if (typeof tc.function?.arguments === "string") t.args += tc.function.arguments;
        out.tools.set(tc.index, t);
      }
    }
  }
  return out;
}

describe("Task 3 — client authentication (audit C2)", () => {
  test("missing, malformed or unknown client keys → 401 and the upstream is never called", async () => {
    let upstreamCalls = 0;
    await withGuardrail(async (res) => { upstreamCalls++; res.write(sseFrames(["hi"])); }, async (url) => {
      for (const auth of [undefined, "", "Bearer", `Basic ${CLIENT_KEY}`, "Bearer wrong-key-0123456789abc", `Bearer ${CLIENT_KEY}x`]) {
        const headers: Record<string, string> = { "Content-Type": "application/json", ...(auth !== undefined ? { Authorization: auth } : {}) };
        const res = await fetch(`${url}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) });
        assert.equal(res.status, 401, String(auth));
        assert.match(res.headers.get("www-authenticate") ?? "", /Bearer/);
        assert.deepEqual(await res.json(), { error: { code: 401, message: "Invalid or missing API key", source: "llm-guardrail" } });
      }
    });
    assert.equal(upstreamCalls, 0, "unauthenticated requests must not reach the upstream");
  });

  test("the client's key is never forwarded; the upstream sees only the operator key", async () => {
    await withGuardrail(async (res) => { res.write(sseFrames(["hi"])); }, async (url, upstream) => {
      assert.equal((await collect(url)).status, 200);
      assert.equal(upstream.requests[0].headers.authorization, "Bearer sk-test");
      assert.ok(!JSON.stringify(upstream.requests[0]).includes(CLIENT_KEY));
    });
  });

  test("ApiKeyRegistry rejects short keys and bad ids at startup", () => {
    assert.throws(() => new ApiKeyRegistry([{ id: "a", apiKey: "short" }]), /at least 16/);
    assert.throws(() => new ApiKeyRegistry([{ id: "bad id!", apiKey: "x".repeat(20) }]), /invalid client id/);
  });
});

describe("Task 3 — PII outside delta.content (audit C1)", () => {
  const ARGS = JSON.stringify({ to: PII[0], ssn: PII[1], card: PII[2], note: "call (555) 867-5309" });

  test("tool_calls arguments split across frames (and bytes) are redacted; the JSON stays intact", async () => {
    // Split the arguments at every 5th char, and tool-call 1 interleaved with tool-call 0.
    const pieces = ARGS.match(/.{1,5}/gs)!;
    let sse = frame({ delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "send_email", arguments: "" } }] } });
    sse += frame({ delta: { tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "lookup", arguments: "" } }] } });
    pieces.forEach((p, i) => {
      sse += frame({ delta: { tool_calls: [{ index: 0, function: { arguments: p } }] } });
      if (i % 3 === 0) sse += frame({ delta: { tool_calls: [{ index: 1, function: { arguments: i === 0 ? '{"email":"jane.d' : i === 3 ? 'oe@example.com"}' : "" } }] } });
    });
    sse += frame({ delta: {}, finish_reason: "tool_calls" }) + "data: [DONE]\n\n";
    for (const sizes of [[1], [7], [4096]]) {
      const r = await withGuardrail((res) => writeInSlices(res, sse, sizes), (url) => collect(url));
      assertNoLeak(r.raw);
      const got = reassemble(r.raw);
      assert.equal(got.tools.get(0)!.name, "send_email");
      assert.equal(got.tools.get(0)!.args, redact(ARGS), `slices ${sizes}`);
      assert.deepEqual(JSON.parse(got.tools.get(0)!.args), { to: "[REDACTED]", ssn: "[REDACTED]", card: "[REDACTED]", note: "call [REDACTED]" });
      assert.equal(got.tools.get(1)!.args, '{"email":"[REDACTED]"}');
      assert.equal(r.events.filter((e) => e === "[DONE]").length, 1);
    }
  });

  test("refusal and reasoning_content streams are redacted across frames", async () => {
    const sse =
      frame({ delta: { refusal: "I can't share 4111 11" } }) + frame({ delta: { refusal: "11 1111 1111." } }) +
      frame({ delta: { reasoning_content: "user mail is jane." } }) + frame({ delta: { reasoning_content: "doe@example.com" } }) +
      frame({ delta: {}, finish_reason: "stop" }) + "data: [DONE]\n\n";
    const r = await withGuardrail(async (res) => { res.write(sse); }, (url) => collect(url));
    assertNoLeak(r.raw);
    const got = reassemble(r.raw);
    assert.equal(got.refusal, "I can't share [REDACTED].");
    assert.equal(got.reasoning_content, "user mail is [REDACTED]");
  });

  test("logprobs are stripped (request and response); unknown string fields are redacted whole", async () => {
    const sse =
      frame({ delta: { content: "ok " }, logprobs: { content: [{ token: PII[0], logprob: -0.1, top_logprobs: [{ token: PII[1] }] }] } }) +
      frame({ delta: { content: "", audio: { transcript: `my ssn is ${PII[1]}` } }, provider_note: `card ${PII[2]}` }, { system_fingerprint: `fp ${PII[0]}` }) +
      frame({ delta: {}, finish_reason: "stop" }) + "data: [DONE]\n\n";
    await withGuardrail(async (res) => { res.write(sse); }, async (url, upstream) => {
      const r = await collect(url, { messages: [{ role: "user", content: "hi" }], logprobs: true, top_logprobs: 5 });
      assertNoLeak(r.raw);
      assert.match(r.raw, /"logprobs":null/);
      assert.match(r.raw, /my ssn is \[REDACTED\]/);
      assert.equal(upstream.requests[0].body.logprobs, undefined, "logprobs must not be requested upstream");
      assert.equal(upstream.requests[0].body.top_logprobs, undefined);
    });
  });

  test("inbound: PII inside assistant tool_calls history and tool results is redacted before it goes upstream", async () => {
    await withGuardrail(async (res) => { res.write(sseFrames(["ok"])); }, async (url, upstream) => {
      await collect(url, {
        messages: [
          { role: "user", content: "email jane" },
          { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "send", arguments: JSON.stringify({ to: PII[0] }) } }] },
          { role: "tool", tool_call_id: "call_1", content: `sent to ${PII[0]}, ref ${PII[1]}` },
        ],
      });
      const sent = JSON.stringify(upstream.requests[0].body);
      assertNoLeak(sent);
      assert.equal(upstream.requests[0].body.messages[1].tool_calls[0].id, "call_1", "structure is preserved");
    });
  });
});
