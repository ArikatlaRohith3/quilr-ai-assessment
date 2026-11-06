import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage, NormalizedRequest, NormalizedResponse, ProviderAdapter, ProviderOutcome } from "./types.js";

/**
 * Adapter for the Claude Messages API via the official SDK.
 *
 * Translation from the gateway's OpenAI-style request:
 *  - `system` messages move to the top-level `system` field.
 *  - `max_tokens` is required by the Messages API; when the client sent none we use
 *    a generous default rather than truncating replies.
 *  - `temperature` is NOT forwarded: current Claude models reject sampling params.
 *  - The client's `model` (an OpenAI name) is ignored; the configured Claude model is used.
 *  - Text blocks are concatenated; thinking blocks are dropped.
 *  - stop_reason → finish_reason: end_turn/stop_sequence→stop, max_tokens→length,
 *    refusal→content_filter, tool_use→tool_calls.
 *
 * The SDK's own retries are disabled (maxRetries: 0): the router owns failover
 * and the 3-second budget.
 */
export interface AnthropicAdapterConfig {
  apiKey: string;
  model: string;
  baseURL?: string;
  defaultMaxTokens?: number;
  /** Server-side refusal fallback ("default" routing). Claude API only — turn off for proxies that reject betas. */
  refusalFallback?: boolean;
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly name = "anthropic";
  private readonly client: Anthropic;

  constructor(private readonly cfg: AnthropicAdapterConfig) {
    this.client = new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseURL, maxRetries: 0 });
  }

  private toAnthropic(messages: ChatMessage[]): { system?: string; messages: Anthropic.Beta.BetaMessageParam[] } {
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const rest: Anthropic.Beta.BetaMessageParam[] = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
    return { system: system || undefined, messages: rest };
  }

  async complete(req: NormalizedRequest, timeoutMs: number): Promise<ProviderOutcome> {
    const { system, messages } = this.toAnthropic(req.messages);
    if (messages.length === 0 || messages[0].role !== "user") {
      return { kind: "rejected", detail: "conversation must start with a user message" };
    }

    const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
      model: this.cfg.model,
      max_tokens: req.max_tokens ?? this.cfg.defaultMaxTokens ?? 16000,
      messages,
      ...(system ? { system } : {}),
    };
    if (this.cfg.refusalFallback !== false) {
      Object.assign(params, { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
    }

    let message: Anthropic.Beta.BetaMessage;
    try {
      message = await this.client.beta.messages.create(params, {
        timeout: timeoutMs,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) return { kind: "rate_limited" };
      if (err instanceof Anthropic.APIConnectionTimeoutError || err instanceof Anthropic.APIUserAbortError) return { kind: "timeout" };
      if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.NotFoundError || err instanceof Anthropic.UnprocessableEntityError) {
        return { kind: "rejected", detail: `HTTP ${err.status}` };
      }
      if (err instanceof Anthropic.APIConnectionError) return { kind: "unavailable", detail: "network error" };
      if (err instanceof Anthropic.APIError) return { kind: "unavailable", detail: `HTTP ${err.status}` }; // 401/403/5xx/529 overloaded
      if ((err as Error).name === "TimeoutError" || (err as Error).name === "AbortError") return { kind: "timeout" };
      return { kind: "unavailable", detail: "unexpected error" };
    }

    const text = message.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const stop = message.stop_reason;
    const finish: NormalizedResponse["finish_reason"] =
      stop === "max_tokens" ? "length" : stop === "refusal" ? "content_filter" : stop === "tool_use" ? "tool_calls" : "stop";

    const response: NormalizedResponse = { provider: this.name, model: message.model, content: text, finish_reason: finish };
    if (message.usage) {
      response.usage = { input_tokens: message.usage.input_tokens, output_tokens: message.usage.output_tokens };
    }
    return { kind: "ok", response };
  }
}
