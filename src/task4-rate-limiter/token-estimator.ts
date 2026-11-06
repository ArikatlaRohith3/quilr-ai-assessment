import type { NormalizedRequest } from "./providers/types.js";

/**
 * Pre-request token estimation for reservations.
 *
 *  - If an optional tokenizer package is installed (`gpt-tokenizer`), it is used
 *    for input text. Otherwise a ~4 chars/token heuristic is used. Neither is
 *    exact for every provider (Claude and GPT tokenizers differ), which is why
 *    reservations are reconciled against the provider's reported usage afterwards.
 *  - Output tokens are reserved up front: the request's max_tokens, or a default.
 *  - When a provider reports no usage, the reservation (input estimate + reserved
 *    output) is kept as-is — the conservative choice.
 */

export interface Tokenizer {
  name: string;
  count(text: string): number;
}

export const heuristicTokenizer: Tokenizer = {
  name: "heuristic-4cpt",
  count: (text) => Math.ceil(text.length / 4),
};

const PER_MESSAGE_OVERHEAD = 4; // role + framing tokens, as in OpenAI's accounting
const PER_REQUEST_OVERHEAD = 3;

export async function loadTokenizer(): Promise<Tokenizer> {
  const pkg = "gpt-tokenizer"; // optional; not a declared dependency
  try {
    const mod = (await import(pkg)) as { encode?: (s: string) => number[] };
    if (typeof mod.encode === "function") {
      const encode = mod.encode;
      return { name: "gpt-tokenizer", count: (text) => encode(text).length };
    }
  } catch {
    /* not installed — fall back */
  }
  return heuristicTokenizer;
}

export interface TokenEstimate {
  input: number;
  output: number;
  total: number;
}

export function estimateTokens(req: NormalizedRequest, tokenizer: Tokenizer, defaultOutputReservation: number): TokenEstimate {
  const input =
    PER_REQUEST_OVERHEAD + req.messages.reduce((sum, m) => sum + PER_MESSAGE_OVERHEAD + tokenizer.count(m.content), 0);
  const output = req.max_tokens ?? defaultOutputReservation;
  return { input, output, total: input + output };
}
