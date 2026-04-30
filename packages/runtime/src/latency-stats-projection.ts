/**
 * Project the most-recent observed-latency snapshot from the local
 * `LatencyStatsStore` onto an `AgentTrustRecord`.
 *
 * Why this lives here. The `agent_trust` row carries no latency
 * column — caching avg/p95 there would invite drift on every new
 * delegation. The authoritative source is the `latency_stats` table
 * (`SqliteLatencyStatsStore` in `@motebit/persistence`), which records
 * one row per observed task latency and computes the rolling avg/p95
 * on demand. At read time we project the current stats onto the
 * record so the Agents panel can render the per-row latency readout
 * without surfaces having to import the persistence layer.
 *
 * Sibling to `hardware-attestation-projection.ts`. Both close the
 * doctrine breach in `docs/doctrine/self-attesting-system.md`: every
 * routing-input the runtime computes against MUST be visible to the
 * user. Latency factors into peer ranking via `agent-graph.ts`'s
 * latency map (default 3000ms when stats are absent); this projection
 * surfaces the raw signal the routing path uses.
 *
 * The projected shape is byte-aligned with
 * `AgentTrustRecord["latency_stats"]` in `@motebit/protocol` and with
 * `AgentLatencyStats` in `@motebit/panels`. Field names match the
 * relay's `task-routing.ts` wire vocabulary (`avg_ms` / `p95_ms` /
 * `sample_count`).
 *
 * Pure read, best-effort. Store errors and zero-sample windows both
 * collapse to `null` (no readout shown) — the trust path never breaks
 * because the projection couldn't resolve a sample.
 */

import type { AgentTrustRecord, LatencyStatsStoreAdapter } from "@motebit/sdk";

type LatencyProjection = NonNullable<AgentTrustRecord["latency_stats"]>;

export async function readLatencyStats(
  store: LatencyStatsStoreAdapter,
  motebitId: string,
  record: AgentTrustRecord,
): Promise<LatencyProjection | null> {
  let stats: { avg_ms: number; p95_ms: number; sample_count: number };
  try {
    stats = await store.getStats(motebitId, record.remote_motebit_id);
  } catch {
    return null;
  }
  if (stats.sample_count === 0) return null;
  return {
    avg_ms: stats.avg_ms,
    p95_ms: stats.p95_ms,
    sample_count: stats.sample_count,
  };
}
