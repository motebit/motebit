/**
 * Operator-facing health summary aggregation.
 *
 * Answers "is the relay being used, and by whom" from the data already
 * persisted in the schema — no new instrumentation, no probabilistic
 * sampling, just SQL over the truth tables. The output is the load-
 * bearing signal the operator console's Health panel renders.
 *
 * Four classes of signal:
 *
 *   1. Motebit registry — total registered + activity windows
 *      (last-heartbeat within 24h / 7d / 30d). Activity is the proof
 *      that registered identities are doing work, not just sitting in
 *      the DB.
 *   2. Federation — peer count by state, federation-settlement volume
 *      over the trailing 7d. The federation-settlement count is the
 *      sharpest external-traffic signal: cross-relay settlements only
 *      happen when a peer agent delegated to one of *this* relay's
 *      agents (or vice versa).
 *   3. Tasks + money — settlements + volume + platform fees over 7d /
 *      30d. The economic loop's heartbeat. Zero settlements over 30d
 *      on a relay with N>0 registered motebits is the strongest
 *      "no real usage" signal there is.
 *   4. Subscribers — Stripe-source-of-truth count of paying customers
 *      (relay_subscriptions, status='active'), lifetime cohort size,
 *      and 7d/30d new-subscriber counts. The commercial-legibility
 *      signal: "how many paying users" answered without leaving the
 *      relay db. Status counts are aggregated as a map so churn shows
 *      up as a non-zero `canceled` bucket alongside `active`.
 *
 * Every count is integer; every micro-unit value is a SUM of `INTEGER
 * NOT NULL` columns; no float arithmetic. The query block is
 * intentionally a single function so the operator console gets one
 * snapshot consistent across all sub-counts.
 */

import type { DatabaseDriver } from "@motebit/persistence";

export interface HealthMotebits {
  total_registered: number;
  active_24h: number;
  active_7d: number;
  active_30d: number;
}

export interface HealthFederation {
  peer_count: number;
  active_peers: number;
  suspended_peers: number;
  federation_settlements_7d: number;
  federation_volume_7d_micro: number;
}

export interface HealthTasks {
  settlements_7d: number;
  settlements_30d: number;
  volume_7d_micro: number;
  volume_30d_micro: number;
  fees_7d_micro: number;
  fees_30d_micro: number;
}

export interface HealthSubscribers {
  total_active: number;
  total_lifetime: number;
  created_7d: number;
  created_30d: number;
  /** Stripe statuses keyed verbatim (active, canceled, past_due, …); zero buckets are omitted. */
  status_counts: Record<string, number>;
}

export interface HealthSummary {
  motebits: HealthMotebits;
  federation: HealthFederation;
  tasks: HealthTasks;
  subscribers: HealthSubscribers;
  generated_at: number;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Aggregate the operator health snapshot.
 *
 * Best-effort: any sub-query that throws (table missing on a fresh
 * boot, schema mid-migration) returns zero for that metric rather
 * than failing the whole snapshot. The operator console reads the
 * shape verbatim and renders zeros honestly — there's no "no data"
 * conflated with "real zero" because the schema is always-present
 * after migration v1.
 */
export function aggregateHealthSummary(
  db: DatabaseDriver,
  nowMs: number = Date.now(),
): HealthSummary {
  const cutoff24h = nowMs - DAY_MS;
  const cutoff7d = nowMs - 7 * DAY_MS;
  const cutoff30d = nowMs - 30 * DAY_MS;

  const motebits: HealthMotebits = {
    total_registered: count(db, "SELECT COUNT(*) AS n FROM agent_registry"),
    active_24h: count(
      db,
      "SELECT COUNT(*) AS n FROM agent_registry WHERE last_heartbeat >= ?",
      cutoff24h,
    ),
    active_7d: count(
      db,
      "SELECT COUNT(*) AS n FROM agent_registry WHERE last_heartbeat >= ?",
      cutoff7d,
    ),
    active_30d: count(
      db,
      "SELECT COUNT(*) AS n FROM agent_registry WHERE last_heartbeat >= ?",
      cutoff30d,
    ),
  };

  const federation: HealthFederation = {
    peer_count: count(db, "SELECT COUNT(*) AS n FROM relay_peers"),
    active_peers: count(db, "SELECT COUNT(*) AS n FROM relay_peers WHERE state = 'active'"),
    suspended_peers: count(db, "SELECT COUNT(*) AS n FROM relay_peers WHERE state = 'suspended'"),
    federation_settlements_7d: count(
      db,
      "SELECT COUNT(*) AS n FROM relay_federation_settlements WHERE settled_at >= ?",
      cutoff7d,
    ),
    federation_volume_7d_micro: sum(
      db,
      "SELECT COALESCE(SUM(gross_amount), 0) AS n FROM relay_federation_settlements WHERE settled_at >= ?",
      cutoff7d,
    ),
  };

  const tasks: HealthTasks = {
    settlements_7d: count(
      db,
      "SELECT COUNT(*) AS n FROM relay_settlements WHERE settled_at >= ?",
      cutoff7d,
    ),
    settlements_30d: count(
      db,
      "SELECT COUNT(*) AS n FROM relay_settlements WHERE settled_at >= ?",
      cutoff30d,
    ),
    volume_7d_micro: sum(
      db,
      "SELECT COALESCE(SUM(amount_settled), 0) AS n FROM relay_settlements WHERE settled_at >= ?",
      cutoff7d,
    ),
    volume_30d_micro: sum(
      db,
      "SELECT COALESCE(SUM(amount_settled), 0) AS n FROM relay_settlements WHERE settled_at >= ?",
      cutoff30d,
    ),
    fees_7d_micro: sum(
      db,
      "SELECT COALESCE(SUM(platform_fee), 0) AS n FROM relay_settlements WHERE settled_at >= ?",
      cutoff7d,
    ),
    fees_30d_micro: sum(
      db,
      "SELECT COALESCE(SUM(platform_fee), 0) AS n FROM relay_settlements WHERE settled_at >= ?",
      cutoff30d,
    ),
  };

  const subscribers: HealthSubscribers = {
    total_active: count(
      db,
      "SELECT COUNT(*) AS n FROM relay_subscriptions WHERE status = 'active'",
    ),
    total_lifetime: count(db, "SELECT COUNT(*) AS n FROM relay_subscriptions"),
    created_7d: count(
      db,
      "SELECT COUNT(*) AS n FROM relay_subscriptions WHERE created_at >= ?",
      cutoff7d,
    ),
    created_30d: count(
      db,
      "SELECT COUNT(*) AS n FROM relay_subscriptions WHERE created_at >= ?",
      cutoff30d,
    ),
    status_counts: subscriptionStatusCounts(db),
  };

  return {
    motebits,
    federation,
    tasks,
    subscribers,
    generated_at: nowMs,
  };
}

function count(db: DatabaseDriver, sql: string, ...params: unknown[]): number {
  try {
    const row = db.prepare(sql).get(...params) as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

function sum(db: DatabaseDriver, sql: string, ...params: unknown[]): number {
  return count(db, sql, ...params); // shape-identical
}

/**
 * GROUP BY status over `relay_subscriptions`. Best-effort: a missing
 * table on a fresh boot returns an empty map rather than failing the
 * snapshot, mirroring the `count`/`sum` helpers above.
 */
function subscriptionStatusCounts(db: DatabaseDriver): Record<string, number> {
  try {
    const rows = db
      .prepare("SELECT status, COUNT(*) AS n FROM relay_subscriptions GROUP BY status")
      .all() as Array<{ status: string; n: number }>;
    const out: Record<string, number> = {};
    for (const row of rows) {
      if (typeof row.status === "string" && row.status.length > 0) {
        out[row.status] = row.n;
      }
    }
    return out;
  } catch {
    return {};
  }
}
