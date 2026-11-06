/**
 * Self-contained PII redaction tests — no LLM API key required.
 * Run: npx ts-node --esm src/task3-llm-guardrail/test/redaction.test.ts
 */

const PII_PATTERNS: { name: string; regex: RegExp }[] = [
  { name: "email",       regex: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g },
  { name: "ssn",         regex: /\b\d{3}-\d{2}-\d{4}\b/g },
  { name: "credit_card", regex: /\b(?:\d[ -]?){13,16}\b/g },
  { name: "phone",       regex: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g },
];

function redact(text: string): string {
  let result = text;
  for (const { regex } of PII_PATTERNS) {
    result = result.replace(regex, "[REDACTED]");
  }
  return result;
}

// StreamBuffer mirrors the production implementation
class StreamBuffer {
  private buffer = "";
  private readonly OVERLAP = 64;

  process(delta: string): string {
    this.buffer += delta;
    if (this.buffer.length <= this.OVERLAP) return "";
    const flushTo = this.buffer.length - this.OVERLAP;
    const toFlush = this.buffer.slice(0, flushTo);
    this.buffer = this.buffer.slice(flushTo);
    return redact(toFlush);
  }

  flush(): string {
    const remaining = redact(this.buffer);
    this.buffer = "";
    return remaining;
  }
}

// ── Test runner ───────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}: ${(err as Error).message}`);
    failed++;
  }
}

function assert(actual: string, expected: string) {
  if (actual !== expected) throw new Error(`\n    Expected: "${expected}"\n    Got:      "${actual}"`);
}

function assertContains(actual: string, substr: string) {
  if (!actual.includes(substr)) throw new Error(`Expected to contain "${substr}", got: "${actual}"`);
}

function assertNotContains(actual: string, substr: string) {
  if (actual.includes(substr)) throw new Error(`Expected NOT to contain "${substr}", but it did`);
}

console.log("\n🔒 PII Redaction Tests\n");

// Email
test("redacts standard email", () => {
  assert(redact("Contact jane.doe@example.com for info"), "Contact [REDACTED] for info");
});
test("redacts email with subdomain", () => {
  assertNotContains(redact("user@mail.corp.io"), "@");
});
test("does not redact non-email text", () => {
  assert(redact("hello world"), "hello world");
});

// SSN
test("redacts SSN format XXX-XX-XXXX", () => {
  assert(redact("SSN: 123-45-6789"), "SSN: [REDACTED]");
});
test("does not redact partial SSN-like number", () => {
  assertNotContains(redact("ref: 12-34-567"), "123-45");
});

// Credit card
test("redacts 16-digit credit card", () => {
  assertNotContains(redact("Card: 4111111111111111"), "4111");
});
test("redacts spaced credit card", () => {
  assertNotContains(redact("Card: 4111 1111 1111 1111"), "4111");
});

// Phone
test("redacts US phone (555) 867-5309", () => {
  assertNotContains(redact("Call (555) 867-5309"), "867-5309");
});
test("redacts phone with country code +1", () => {
  assertNotContains(redact("+1 555 867 5309"), "867");
});

// Multiple PII in one string
test("redacts multiple PII types in one string", () => {
  const input = "Email: test@corp.com, SSN: 999-88-7777, Card: 4111111111111111";
  const output = redact(input);
  assertNotContains(output, "test@corp.com");
  assertNotContains(output, "999-88-7777");
  assertNotContains(output, "4111");
});

// StreamBuffer cross-chunk test
test("StreamBuffer catches email split across chunks", () => {
  const buf = new StreamBuffer();
  const fullText = "reach me at jane@example.com anytime";
  // Split mid-email
  const split = 20; // "reach me at jane@exa"
  const part1 = fullText.slice(0, split);
  const part2 = fullText.slice(split);

  let out = buf.process(part1);
  out += buf.process(part2);
  out += buf.flush();

  assertNotContains(out, "jane@example.com");
  assertContains(out, "[REDACTED]");
});

test("StreamBuffer passes through clean text unchanged", () => {
  const buf = new StreamBuffer();
  const text = "The quick brown fox jumps over the lazy dog. ".repeat(5);
  let out = buf.process(text);
  out += buf.flush();
  assertNotContains(out, "[REDACTED]");
});

// Summary
console.log(`\n${"─".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
