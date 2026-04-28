/**
 * Fee aggregation — operator-console reporting for the 5% platform fee
 * collected on relay-mediated settlements.
 *
 * The doctrine: every settlement on the relay carries a `platform_fee`
 * column (integer micro-units) recorded at settlement time. This module
 * aggregates those rows three ways for the operator console:
 *   - total: SUM(platform_fee) across the sample window
 *   - by rail: GROUP BY settlement_mode (relay = guest rail, p2p = sovereign rail)
 *   - by period: GROUP BY UTC-day buckets within the window
 *
 * The "rail" axis is intentionally coarse — it reflects the doctrine split
 * (guest-custody vs sovereign-custody) rather than per-provider granularity
 * (Stripe vs x402 vs Bridge). Operators who need provider-level
 * attribution can drill into recent settlements via /api/v1/admin/settlements.
 *
 * Currency is fixed to "USDC" today; relay_settlements has no currency
 * column. When multi-currency settlement ships, this module gets a
 * currency dimension at the same time.
 */

import type { DatabaseDriver } from "@motebit/persistence";

export interface FeesByRail {
  rail: string;
  collected_micro: number;
}

export interface FeesByPeriod {
  period_start: number;
  period_end: number;
  collected_micro: number;
}

export interface FeesAggregation {
  total_collected_micro: number;
  total_collected_currency: string;
  by_period: FeesByPeriod[];
  by_rail: FeesByRail[];
  fee_rate: number;
  sample_window_days: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Aggregate platform fees over the last `windowDays` days.
 *
 * Returns micro-units integers throughout — no float arithmetic in the
 * money path (root CLAUDE.md "Money model"). The fee rate is the
 * configured platformFeeRate (typically 0.05 = 5%); it's reported alongside
 * the raw sums so the console can render "5% fee · $X collected" without
 * hunting for it.
 */
export function aggregateFees(
  db: DatabaseDriver,
  feeRate: number,
  windowDays: number,
  nowMs: number = Date.now(),
): FeesAggregation {
  const windowStartMs = nowMs - windowDays * DAY_MS;
  const totalRow = db
    .prepare(
      `SELECT COALESCE(SUM(platform_fee), 0) AS total
         FROM relay_settlements
         WHERE settled_at >= ?`,
    )
    .get(windowStartMs) as { total: number } | undefined;
  const total = totalRow?.total ?? 0;

  const byRailRows = db
    .prepare(
      `SELECT
           COALESCE(settlement_mode, 'relay') AS rail,
           COALESCE(SUM(platform_fee), 0) AS collected_micro
         FROM relay_settlements
         WHERE settled_at >= ?
         GROUP BY COALESCE(settlement_mode, 'relay')
         ORDER BY collected_micro DESC`,
    )
    .all(windowStartMs) as Array<{ rail: string; collected_micro: number }>;

  // Per-day buckets in UTC. We round both edges to the start-of-day to
  // make consecutive periods join cleanly without a gap.
  const dayStartUtc = (ms: number) => Math.floor(ms / DAY_MS) * DAY_MS;
  const byPeriodRows = db
    .prepare(
      `SELECT
           CAST(settled_at / ? AS INTEGER) * ? AS period_start,
           COALESCE(SUM(platform_fee), 0) AS collected_micro
         FROM relay_settlements
         WHERE settled_at >= ?
         GROUP BY CAST(settled_at / ? AS INTEGER)
         ORDER BY period_start ASC`,
    )
    .all(DAY_MS, DAY_MS, dayStartUtc(windowStartMs), DAY_MS) as Array<{
    period_start: number;
    collected_micro: number;
  }>;

  const by_period: FeesByPeriod[] = byPeriodRows.map((r) => ({
    period_start: r.period_start,
    period_end: r.period_start + DAY_MS,
    collected_micro: r.collected_micro,
  }));

  return {
    total_collected_micro: total,
    total_collected_currency: "USDC",
    by_period,
    by_rail: byRailRows,
    fee_rate: feeRate,
    sample_window_days: windowDays,
  };
}
