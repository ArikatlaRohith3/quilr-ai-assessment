import type { NormalizedRequest } from "./providers/types.js";

/**
 * Pre-request token estimation for reservations.
 *
 *  - Input text is counted with `gpt-tokenizer` (a declared dependency; the
 *    o200k_base encoding used by GPT-4o-family models). If it cannot be loaded,
 *    the router falls back to a ~4 chars/token heuristic and reports
 *    `tokenizer: "heuristic-4cpt"` on /health.
 *  - Neither is exact for every provider (Claude and GPT tokenizers differ), which
 *    is why reservations are reconciled against the provider's reported usage.
 *  - Output tokens are reserved up front: the request's max_tokens, or a default.
 *  - When a provider reports no usage, the reservation (input estimate + reserved
 *    output) is kept as-is — the conservative choice.
 *
 * Bounded cost: BPE encoding runs synchronously on the event loop and is slow on
 * adversarial input (a 4 MB run of one repeated character measured ~3.6 s). A
 * tokenizer therefore declares `maxCharsPerRequest`; text beyond that budget is
 * counted by its UTF-8 byte length instead. Every byte-level BPE token covers at
 * least one byte, so that part is an over-estimate, never an under-estimate.
 */

export interface Tokenizer {
  name: string;
  count(text: string): number;
  /** Most characters this tokenizer will process per request; the rest is counted as UTF-8 bytes. Omit for O(1) tokenizers. */
  maxCharsPerRequest?: number;
}

export const heuristicTokenizer: Tokenizer = {
  name: "heuristic-4cpt",
  count: (text) => Math.ceil(text.length / 4),
};

/** Per-request budget for real tokenization (worst case measured ≈ 100 ms, for 50k CJK characters). */
export const TOKENIZE_CHAR_BUDGET = 50_000;

const PER_MESSAGE_OVERHEAD = 4; // role + framing tokens, as in OpenAI's accounting
const PER_REQUEST_OVERHEAD = 3;

type Importer = (specifier: string) => Promise<unknown>;

/**
 * Loads gpt-tokenizer, or falls back to the heuristic if it cannot be imported
 * (e.g. a trimmed deployment). `importer` exists so tests can exercise the fallback.
 */
export async function loadTokenizer(importer: Importer = (s) => import(s)): Promise<Tokenizer> {
  try {
    const mod = (await importer("gpt-tokenizer")) as { countTokens?: (s: string) => number; encode?: (s: string) => number[] };
    const countTokens = mod.countTokens;
    const encode = mod.encode;
    if (typeof countTokens === "function") return { name: "gpt-tokenizer", count: (t) => countTokens(t), maxCharsPerRequest: TOKENIZE_CHAR_BUDGET };
    if (typeof encode === "function") return { name: "gpt-tokenizer", count: (t) => encode(t).length, maxCharsPerRequest: TOKENIZE_CHAR_BUDGET };
  } catch {
    /* not loadable — fall back */
  }
  return heuristicTokenizer;
}

export interface TokenEstimate {
  input: number;
  output: number;
  total: number;
}

export function estimateTokens(req: NormalizedRequest, tokenizer: Tokenizer, defaultOutputReservation: number): TokenEstimate {
  let budget = tokenizer.maxCharsPerRequest ?? Number.POSITIVE_INFINITY;
  let input = PER_REQUEST_OVERHEAD;
  for (const m of req.messages) {
    const text = m.content;
    const exact = text.length <= budget ? text : text.slice(0, budget);
    budget -= exact.length;
    input += PER_MESSAGE_OVERHEAD + tokenizer.count(exact);
    if (exact.length < text.length) input += Buffer.byteLength(text.slice(exact.length), "utf8");
  }
  const output = req.max_tokens ?? defaultOutputReservation;
  return { input, output, total: input + output };
}
