import type { DatabaseSync } from "node:sqlite";

/**
 * Sliding-window token limiter with atomic reservations.
 *
 * The old flow was check → call provider (await) → record. Two concurrent
 * requests could both pass the check during the await and together exceed the
 * limit. Now:
 *
 *   reserve()  — BEGIN IMMEDIATE; sum the window; insert a 'reserved' row; COMMIT.
 *                The check and the insert are one write transaction, so neither
 *                other requests in this process nor other processes sharing the
 *                database file can over-allocate.
 *   commit()   — reconcile the reservation to the provider's actual usage.
 *   release()  — the request never reached a provider; give the tokens back.
 */

export interface LimiterConfig {
  limit: number;
  windowMs: number;
  now?: () => number;
}

export type ReserveResult =
  | { ok: true; id: number; used: number; remaining: number }
  | { ok: false; used: number; retryAfterSec: number };

export class RateLimiter {
  private readonly now: () => number;

  constructor(private readonly db: DatabaseSync, private readonly cfg: LimiterConfig) {
    this.now = cfg.now ?? Date.now;
  }

  get limit(): number {
    return this.cfg.limit;
  }

  private windowSum(tenantId: string, cutoff: number): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(tokens), 0) AS used FROM token_reservations WHERE tenant_id = ? AND created_at > ? AND status != 'released'")
      .get(tenantId, cutoff) as { used: number };
    return Number(row.used);
  }

  /** Seconds until enough of the oldest usage leaves the window for `tokens` to fit. */
  private retryAfter(tenantId: string, cutoff: number, used: number, tokens: number, now: number): number {
    const mustFree = used + tokens - this.cfg.limit;
    const rows = this.db
      .prepare("SELECT created_at, tokens FROM token_reservations WHERE tenant_id = ? AND created_at > ? AND status != 'released' ORDER BY created_at ASC")
      .all(tenantId, cutoff) as Array<{ created_at: number; tokens: number }>;
    let freed = 0;
    for (const r of rows) {
      freed += Number(r.tokens);
      if (freed >= mustFree) return Math.max(1, Math.ceil((Number(r.created_at) + this.cfg.windowMs - now) / 1000));
    }
    return Math.ceil(this.cfg.windowMs / 1000);
  }

  reserve(tenantId: string, tokens: number): ReserveResult {
    const now = this.now();
    const cutoff = now - this.cfg.windowMs;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const used = this.windowSum(tenantId, cutoff);
      if (used + tokens > this.cfg.limit) {
        const retryAfterSec = this.retryAfter(tenantId, cutoff, used, tokens, now);
        this.db.exec("ROLLBACK");
        return { ok: false, used, retryAfterSec };
      }
      const info = this.db
        .prepare("INSERT INTO token_reservations (tenant_id, created_at, tokens, status) VALUES (?, ?, ?, 'reserved')")
        .run(tenantId, now, tokens);
      // Opportunistic cleanup keeps the table (and every SUM) small.
      this.db.prepare("DELETE FROM token_reservations WHERE created_at <= ?").run(cutoff);
      this.db.exec("COMMIT");
      return { ok: true, id: Number(info.lastInsertRowid), used: used + tokens, remaining: this.cfg.limit - used - tokens };
    } catch (err) {
      try { this.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw err;
    }
  }

  /** Reconcile to actual usage. May exceed the estimate; the overage counts against the window like any usage. */
  commit(id: number, actualTokens: number): void {
    this.db
      .prepare("UPDATE token_reservations SET tokens = ?, status = 'committed' WHERE id = ? AND status = 'reserved'")
      .run(Math.max(0, Math.round(actualTokens)), id);
  }

  release(id: number): void {
    this.db.prepare("UPDATE token_reservations SET tokens = 0, status = 'released' WHERE id = ? AND status = 'reserved'").run(id);
  }

  usage(tenantId: string): number {
    return this.windowSum(tenantId, this.now() - this.cfg.windowMs);
  }

  allUsage(): Array<{ tenant_id: string; used: number }> {
    return (
      this.db
        .prepare("SELECT tenant_id, COALESCE(SUM(tokens), 0) AS used FROM token_reservations WHERE created_at > ? AND status != 'released' GROUP BY tenant_id")
        .all(this.now() - this.cfg.windowMs) as Array<{ tenant_id: string; used: number }>
    ).map((r) => ({ tenant_id: r.tenant_id, used: Number(r.used) }));
  }
}
