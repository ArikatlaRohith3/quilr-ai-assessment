/** Provider-neutral request/response shapes used by the router. Each adapter translates to/from its API. */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface NormalizedRequest {
  /** Model requested by the client — honoured by the primary (OpenAI-compatible) provider only. */
  model?: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
}

export interface NormalizedResponse {
  provider: string;
  model: string;
  content: string;
  finish_reason: "stop" | "length" | "content_filter" | "tool_calls";
  /** Absent when the provider didn't report usage. */
  usage?: { input_tokens: number; output_tokens: number };
}

export type ProviderOutcome =
  | { kind: "ok"; response: NormalizedResponse }
  /** Provider throttled us (HTTP 429) — fail over. */
  | { kind: "rate_limited" }
  /** No response within the deadline — fail over. */
  | { kind: "timeout" }
  /** 5xx / overloaded / network / auth misconfiguration / unparseable reply — fail over. */
  | { kind: "unavailable"; detail: string }
  /** The provider says the request itself is invalid (400/404/422) — failing over won't help. */
  | { kind: "rejected"; detail: string };

export interface ProviderAdapter {
  readonly name: string;
  complete(req: NormalizedRequest, timeoutMs: number): Promise<ProviderOutcome>;
}
