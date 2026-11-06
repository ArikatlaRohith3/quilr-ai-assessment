/**
 * Burst simulation against a running Task 4 router.
 *
 *   TENANT_API_KEYS=sim:sim-tenant-key-0123456789 npm run task4
 *   SIM_TENANT_KEY=sim-tenant-key-0123456789 npm run simulate      # in another terminal
 *
 * Phase 1: small sequential requests (pass). Phase 2: a concurrent burst that
 * exceeds the budget — atomic reservations admit exactly what fits. Phase 3:
 * follow-up requests are rejected with 429 + Retry-After.
 */

const GATEWAY = process.env.GATEWAY_URL ?? "http://localhost:3004";
const KEY = process.env.SIM_TENANT_KEY ?? "sim-tenant-key-0123456789";

const C = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

/** ~`tokens` input tokens with the 4-chars/token heuristic; max_tokens keeps the output reservation small. */
const body = (tokens: number) => ({ messages: [{ role: "user", content: "x".repeat(Math.max(0, tokens - 7) * 4) }], max_tokens: 1 });

async function request(seq: number, tokens: number): Promise<number> {
  const t0 = Date.now();
  try {
    const res = await fetch(`${GATEWAY}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body(tokens)),
    });
    const ms = Date.now() - t0;
    const data = (await res.json()) as { error?: { message?: string } };
    if (res.status === 200) {
      const tag = res.headers.get("x-gateway-fallback") === "true" ? C.yellow(" [FALLBACK]") : "";
      console.log(C.green(`  [${seq}] 200 OK${tag} (${ms}ms, ~${tokens} tokens, remaining ${res.headers.get("x-ratelimit-remaining")})`));
    } else if (res.status === 429) {
      console.log(C.red(`  [${seq}] 429 Rate limited — Retry-After ${res.headers.get("retry-after")}s (${ms}ms)`));
    } else {
      console.log(C.yellow(`  [${seq}] ${res.status} ${data.error?.message ?? ""} (${ms}ms)`));
    }
    return res.status;
  } catch (err) {
    console.log(C.red(`  [${seq}] network error: ${(err as Error).message}`));
    return 0;
  }
}

async function main() {
  console.log(C.bold("\n🚦 Rate limiter & failover simulation"));
  console.log(`   Gateway: ${GATEWAY}\n`);

  console.log(C.cyan("Phase 1 — sequential small requests (100 tokens each):"));
  for (let i = 1; i <= 5; i++) await request(i, 100);

  console.log(C.cyan("\nPhase 2 — concurrent burst: 8 × 10,000 tokens at once:"));
  const statuses = await Promise.all(Array.from({ length: 8 }, (_, i) => request(6 + i, 10_000)));
  const admitted = statuses.filter((s) => s !== 429 && s !== 0).length;
  console.log(C.bold(`   admitted ${admitted}, rejected ${statuses.filter((s) => s === 429).length} (no over-allocation)`));

  console.log(C.cyan("\nPhase 3 — follow-up requests:"));
  for (let i = 14; i <= 16; i++) await request(i, 500);

  console.log(C.bold("\nDone. Non-200/429 statuses mean the providers themselves failed (no API keys configured?).\n"));
}

main();
