/**
 * Rate limiter simulation — fires rapid requests to show:
 * 1. Requests succeeding under the token limit
 * 2. Rate limit kicking in (429)
 * 3. Failover header (X-Gateway-Fallback) when primary is saturated
 *
 * Run against Task 4: npm run task4  (then in another terminal: npm run simulate)
 */

const GATEWAY = process.env.GATEWAY_URL ?? "http://localhost:3004";
const TENANT   = "sim-tenant-001";

const COLORS = {
  green:  (s: string) => `\x1b[32m${s}\x1b[0m`,
  red:    (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan:   (s: string) => `\x1b[36m${s}\x1b[0m`,
  bold:   (s: string) => `\x1b[1m${s}\x1b[0m`,
};

function makeBody(tokens: number) {
  // Each word ≈ 4 chars ≈ 1 token
  const words = "word ".repeat(tokens * 4);
  return {
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: words.trim() }],
  };
}

async function request(seq: number, tokens: number): Promise<void> {
  const start = Date.now();
  try {
    const res = await fetch(`${GATEWAY}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Tenant-Key": TENANT,
      },
      body: JSON.stringify(makeBody(tokens)),
    });

    const ms = Date.now() - start;
    const fallback = res.headers.get("X-Gateway-Fallback") === "true";

    if (res.status === 429) {
      const retry = res.headers.get("Retry-After");
      console.log(COLORS.red(`  [${seq}] 429 Rate Limited — Retry-After: ${retry}s  (${ms}ms)`));
      return;
    }
    if (res.status === 502 || res.status === 504) {
      const data = await res.json() as { error?: { message?: string } };
      console.log(COLORS.yellow(`  [${seq}] ${res.status} Gateway Error — ${data.error?.message}  (${ms}ms)`));
      return;
    }
    if (!res.ok) {
      console.log(COLORS.yellow(`  [${seq}] ${res.status} Upstream Error  (${ms}ms)`));
      return;
    }

    const tag = fallback ? COLORS.yellow(" [FALLBACK]") : "";
    console.log(COLORS.green(`  [${seq}] 200 OK${tag}  (${ms}ms, ~${tokens} tokens)`));
  } catch (err) {
    console.log(COLORS.red(`  [${seq}] Network error: ${err}`));
  }
}

async function main() {
  console.log(COLORS.bold("\n🚦 Rate Limiter & Failover Simulation"));
  console.log(`   Gateway: ${GATEWAY}`);
  console.log(`   Tenant:  ${TENANT}\n`);

  // Phase 1: Normal requests (small, should pass)
  console.log(COLORS.cyan("Phase 1 — Normal requests (100 tokens each):"));
  for (let i = 1; i <= 5; i++) {
    await request(i, 100);
    await new Promise(r => setTimeout(r, 100));
  }

  // Phase 2: Large burst (each request ~10,000 tokens → 5 requests = 50,000 → hits limit)
  console.log(COLORS.cyan("\nPhase 2 — Large burst (10,000 tokens each):"));
  for (let i = 6; i <= 10; i++) {
    await request(i, 10000);
    await new Promise(r => setTimeout(r, 50));
  }

  // Phase 3: Requests after limit is hit
  console.log(COLORS.cyan("\nPhase 3 — Post-limit requests (should be rate limited):"));
  for (let i = 11; i <= 13; i++) {
    await request(i, 500);
    await new Promise(r => setTimeout(r, 50));
  }

  console.log(COLORS.bold("\n✅ Simulation complete\n"));
}

main().catch(console.error);
