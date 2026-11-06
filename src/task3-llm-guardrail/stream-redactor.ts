import { findSafeCut, redactWithCount } from "./pii-detector.js";

/**
 * Bounded streaming redactor for one text stream (one choice of a completion).
 *
 * push() returns only text that is final: anything that could still be the
 * beginning of an email, card number, phone number or SSN stays buffered until
 * the next delta settles it (or flush() at end of stream). Plain prose is
 * released immediately, except the word currently being typed, so TTFT stays low.
 */
export class StreamRedactor {
  private pending = "";
  redactions = 0;

  push(delta: string): string {
    this.pending += delta;
    const cut = findSafeCut(this.pending);
    if (cut === 0) return "";
    const { text, count } = redactWithCount(this.pending.slice(0, cut));
    this.pending = this.pending.slice(cut);
    this.redactions += count;
    return text;
  }

  flush(): string {
    const { text, count } = redactWithCount(this.pending);
    this.pending = "";
    this.redactions += count;
    return text;
  }

  get bufferedChars(): number {
    return this.pending.length;
  }
}
