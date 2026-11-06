import type { NormalizedRequest, ProviderAdapter, ProviderOutcome } from "./providers/types.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("llm-router");

export interface RouteResult {
  outcome: ProviderOutcome;
  /** Provider whose outcome is returned. */
  provider: string;
  usedFallback: boolean;
  /** Why the primary was abandoned (when usedFallback). */
  failoverReason?: string;
}

/** Outcomes that justify trying the secondary provider. A "rejected" request is the client's fault — retrying elsewhere won't fix it. */
const FAILOVER_KINDS = new Set<ProviderOutcome["kind"]>(["rate_limited", "timeout", "unavailable"]);

export class Router {
  constructor(
    private readonly primary: ProviderAdapter,
    private readonly secondary: ProviderAdapter,
    private readonly opts: { timeoutMs: number; maxJitterMs: number },
  ) {}

  async complete(req: NormalizedRequest, requestId: string): Promise<RouteResult> {
    const first = await this.primary.complete(req, this.opts.timeoutMs);
    if (!FAILOVER_KINDS.has(first.kind)) return { outcome: first, provider: this.primary.name, usedFallback: false };

    const reason = first.kind === "unavailable" ? `unavailable (${first.detail})` : first.kind;
    // Jitter spreads a burst of simultaneous failovers so they don't hit the secondary in lockstep.
    const jitter = Math.floor(Math.random() * this.opts.maxJitterMs);
    log.warn("primary failed; failing over", { requestId, primary: this.primary.name, reason, jitter_ms: jitter });
    if (jitter) await new Promise((r) => setTimeout(r, jitter));

    const second = await this.secondary.complete(req, this.opts.timeoutMs);
    if (second.kind !== "ok") {
      log.error("secondary failed", { requestId, secondary: this.secondary.name, kind: second.kind });
    }
    return { outcome: second, provider: this.secondary.name, usedFallback: true, failoverReason: reason };
  }
}
