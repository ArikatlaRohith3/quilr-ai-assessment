/**
 * PII patterns, redaction, and the "safe cut" rule that makes streaming redaction sound.
 */

export const REDACTED = "[REDACTED]";

export const PII_PATTERNS: ReadonlyArray<{ name: string; regex: RegExp }> = [
  // Email first: its local part may contain digit runs the numeric patterns would otherwise grab.
  { name: "email", regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { name: "ssn", regex: /\b\d{3}-\d{2}-\d{4}\b/g },
  // 13–19 digits, optionally separated by single spaces or dashes (no Luhn check: over-redaction is the safe failure).
  { name: "credit_card", regex: /\b\d(?:[ -]?\d){12,18}\b/g },
  // North American numbers: +1 (555) 867-5309, 555.867.5309, 5558675309 …
  { name: "phone", regex: /(?<![\w+])(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]?\d{3}[-.\s]?\d{4}(?!\w)/g },
  // Compact international E.164: +447911123456
  { name: "phone_e164", regex: /(?<![\w+])\+[1-9]\d{7,14}(?!\w)/g },
  // International with separators: +44 7911 123456, +91 98765-43210, +33 1.23.45.67.89 (8–15 digits after "+")
  { name: "phone_intl", regex: /(?<![\w+])\+[1-9](?:[ .-]?\d){7,14}(?!\w)/g },
  // SSN written with spaces: 123 45 6789
  { name: "ssn_spaced", regex: /\b\d{3} \d{2} \d{4}\b/g },
];

export function redactWithCount(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const { regex } of PII_PATTERNS) {
    out = out.replace(regex, () => {
      count++;
      return REDACTED;
    });
  }
  return { text: out, count };
}

export function redact(text: string): string {
  return redactWithCount(text).text;
}

// ── Safe cut ──────────────────────────────────────────────────────────────────
//
// Every match of the patterns above is a chain of "PII characters"
// (letters, digits, . _ % + - @ ( )) in which the only whitespace allowed sits
// between a digit/")" on the left and a digit/"("/"+" on the right
// (e.g. "4111 1111", "(555) 867", "+1 555").
//
// findSafeCut walks back from the end of the buffer over that chain. The chain
// is the only part of the text that a *future* chunk could turn into PII, so it
// is held back; everything before it can be redacted and released now. Because
// the character just before the cut is never part of a PII chain, no match can
// straddle the cut, and regex boundaries (\b, look-arounds) evaluate the same
// on the released slice as on the full text.

const PII_CHAR = /[A-Za-z0-9._%+\-@()]/;
const JOIN_LEFT = /[0-9)]/;
const JOIN_RIGHT = /[0-9(+]/;

/** Upper bound on held-back characters (per stream) — keeps memory bounded on adversarial input. */
export const MAX_HOLDBACK = 1024;
/** Longer than any realistic PII match; text this far from the end of the buffer is final. */
const SETTLED_MARGIN = 320;

export function findSafeCut(text: string): number {
  let h = text.length;
  while (h > 0) {
    const ch = text[h - 1];
    if (PII_CHAR.test(ch)) {
      h--;
      continue;
    }
    const joinable =
      /\s/.test(ch) && h >= 2 && JOIN_LEFT.test(text[h - 2]) && (h === text.length || JOIN_RIGHT.test(text[h]));
    if (joinable) {
      h--;
      continue;
    }
    break;
  }

  if (text.length - h <= MAX_HOLDBACK) return h;

  // Pathological: an enormous unbroken chain (e.g. 5 KB of letters). Release all
  // but the last SETTLED_MARGIN chars, moving the cut left so it never splits a match.
  let cut = text.length - SETTLED_MARGIN;
  for (const { regex } of PII_PATTERNS) {
    for (const m of text.matchAll(regex)) {
      const start = m.index!;
      if (start < cut && start + m[0].length > cut) cut = start;
    }
  }
  return cut;
}
