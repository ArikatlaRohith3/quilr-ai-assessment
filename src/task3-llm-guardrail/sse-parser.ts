/**
 * Incremental Server-Sent Events parser (WHATWG HTML §9.2.6 event-stream rules).
 *
 * Network reads are arbitrary byte slices, so a frame like
 *   data: {"choices":[{"delta":{"content":"My email is test@example.com"}}]}\n\n
 * may arrive split anywhere — inside the JSON, inside "data:", between \r and \n.
 * This parser keeps the partial line and partial event between `push()` calls and
 * only emits an event when its terminating blank line has been seen.
 *
 *  - Lines end in \n, \r or \r\n (a \r at the end of a chunk waits for the next one).
 *  - Multiple `data:` lines are joined with "\n".
 *  - Comment lines (":keep-alive") are ignored; `event:` and `id:` are tracked.
 *  - An unterminated event at end-of-stream is discarded (fail closed).
 *  - Memory is bounded: an event larger than `maxEventChars` throws SseError.
 */

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

export class SseError extends Error {}

export class SseParser {
  private buffer = "";
  private dataLines: string[] = [];
  private dataSize = 0;
  private eventType = "";
  private lastEventId: string | undefined;

  constructor(private readonly maxEventChars = 1_000_000) {}

  /** Feed decoded text; returns every event completed by this chunk. */
  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    let start = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer[i];
      if (ch !== "\n" && ch !== "\r") continue;
      if (ch === "\r") {
        // "\r" as the last char may be the first half of "\r\n" — wait for more input.
        if (i === this.buffer.length - 1) break;
        this.processLine(this.buffer.slice(start, i), events);
        if (this.buffer[i + 1] === "\n") i++;
      } else {
        this.processLine(this.buffer.slice(start, i), events);
      }
      start = i + 1;
    }
    this.buffer = this.buffer.slice(start);
    if (this.buffer.length + this.dataSize > this.maxEventChars) {
      throw new SseError(`SSE event exceeds ${this.maxEventChars} characters`);
    }
    return events;
  }

  /** End of stream. A trailing "\r" still terminates its line; an event without a blank line after it is dropped. */
  end(): SseEvent[] {
    const events: SseEvent[] = [];
    if (this.buffer.endsWith("\r")) this.processLine(this.buffer.slice(0, -1), events);
    this.buffer = "";
    this.dataLines = [];
    this.dataSize = 0;
    return events;
  }

  /** Characters currently held (partial line + partial event) — exposed for memory tests. */
  get bufferedChars(): number {
    return this.buffer.length + this.dataSize;
  }

  private processLine(line: string, events: SseEvent[]): void {
    if (line === "") {
      if (this.dataLines.length > 0) {
        events.push({ event: this.eventType || "message", data: this.dataLines.join("\n"), id: this.lastEventId });
      }
      this.dataLines = [];
      this.dataSize = 0;
      this.eventType = "";
      return;
    }
    if (line.startsWith(":")) return; // comment / keep-alive

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    switch (field) {
      case "data":
        this.dataLines.push(value);
        this.dataSize += value.length + 1;
        if (this.dataSize > this.maxEventChars) throw new SseError(`SSE event exceeds ${this.maxEventChars} characters`);
        break;
      case "event":
        this.eventType = value;
        break;
      case "id":
        if (!value.includes("\0")) this.lastEventId = value;
        break;
      default:
        break; // "retry" and unknown fields are ignored
    }
  }
}
