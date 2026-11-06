import type { NormalizedRequest, NormalizedResponse, ProviderAdapter, ProviderOutcome } from "./types.js";

/**
 * Adapter for OpenAI-compatible Chat Completions APIs (OpenAI, Azure OpenAI
 * compatible gateways, vLLM, etc.): POST {baseUrl}/v1/chat/completions,
 * `Authorization: Bearer`, response in choices[0].message / usage.prompt_tokens.
 */
export class OpenAIAdapter implements ProviderAdapter {
  readonly name = "openai";

  constructor(private readonly cfg: { baseUrl: string; apiKey: string; defaultModel: string }) {}

  async complete(req: NormalizedRequest, timeoutMs: number): Promise<ProviderOutcome> {
    const body: Record<string, unknown> = {
      model: req.model ?? this.cfg.defaultModel,
      messages: req.messages,
      stream: false,
    };
    if (req.max_tokens !== undefined) body.max_tokens = req.max_tokens;
    if (req.temperature !== undefined) body.temperature = req.temperature;

    let res: Response;
    let json: unknown;
    try {
      // The signal also bounds reading the body, so a slow-dripping response still times out.
      const signal = AbortSignal.timeout(timeoutMs);
      res = await fetch(`${this.cfg.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.cfg.apiKey}` },
        body: JSON.stringify(body),
        signal,
      });
      if (res.status === 429) return { kind: "rate_limited" };
      if (!res.ok) {
        await res.body?.cancel();
        if ([400, 404, 422].includes(res.status)) return { kind: "rejected", detail: `HTTP ${res.status}` };
        return { kind: "unavailable", detail: `HTTP ${res.status}` };
      }
      json = await res.json();
    } catch (err) {
      const name = (err as Error).name;
      if (name === "TimeoutError" || name === "AbortError") return { kind: "timeout" };
      return { kind: "unavailable", detail: name === "SyntaxError" ? "invalid JSON" : "network error" };
    }

    const data = json as {
      model?: string;
      choices?: Array<{ message?: { content?: unknown }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = data.choices?.[0];
    if (!choice || typeof choice.message?.content !== "string") return { kind: "unavailable", detail: "unexpected response shape" };

    const finish = choice.finish_reason;
    const response: NormalizedResponse = {
      provider: this.name,
      model: data.model ?? String(body.model),
      content: choice.message.content,
      finish_reason: finish === "length" || finish === "content_filter" || finish === "tool_calls" ? finish : "stop",
    };
    if (typeof data.usage?.prompt_tokens === "number" && typeof data.usage?.completion_tokens === "number") {
      response.usage = { input_tokens: data.usage.prompt_tokens, output_tokens: data.usage.completion_tokens };
    }
    return { kind: "ok", response };
  }
}
