import type { LatencyStatsStoreAdapter } from "@motebit/runtime";
import { idbRequest } from "./idb.js";

interface LatencyEntry {
  motebit_id: string;
  remote_motebit_id: string;
  latency_ms: number;
  recorded_at: number;
}

/**
 * IDB-backed LatencyStatsStore.
 *
 * All LatencyStatsStoreAdapter methods are async, so direct IDB reads/writes
 * are fine — no cache needed.
 */
export class IdbLatencyStatsStore implements LatencyStatsStoreAdapter {
  constructor(private db: IDBDatabase) {}

  // eslint-disable-next-line @typescript-eslint/require-await -- fire-and-forget IDB add
  async record(motebitId: string, remoteMotebitId: string, latencyMs: number): Promise<void> {
    const tx = this.db.transaction("latency_stats", "readwrite");
    const entry: LatencyEntry = {
      motebit_id: motebitId,
      remote_motebit_id: remoteMotebitId,
      latency_ms: latencyMs,
      recorded_at: Date.now(),
    };
    tx.objectStore("latency_stats").add(entry);
  }

  async getStats(
    motebitId: string,
    remoteMotebitId: string,
    limit = 100,
  ): Promise<{ avg_ms: number; p95_ms: number; sample_count: number }> {
    const tx = this.db.transaction("latency_stats", "readonly");
    const store = tx.objectStore("latency_stats");
    const index = store.index("motebit_remote");
    const entries = (await idbRequest(
      index.getAll([motebitId, remoteMotebitId]),
    )) as LatencyEntry[];

    if (entries.length === 0) {
      return { avg_ms: 0, p95_ms: 0, sample_count: 0 };
    }

    // Take the most recent `limit` entries
    entries.sort((a, b) => b.recorded_at - a.recorded_at);
    const recent = entries.slice(0, limit);

    const sum = recent.reduce((acc, e) => acc + e.latency_ms, 0);
    const avg_ms = sum / recent.length;

    // p95: sort ascending by latency, take the 95th percentile value
    const sorted = recent.map((e) => e.latency_ms).sort((a, b) => a - b);
    const p95Index = Math.min(Math.ceil(sorted.length * 0.95) - 1, sorted.length - 1);
    const p95_ms = sorted[p95Index] ?? 0;

    return { avg_ms, p95_ms, sample_count: recent.length };
  }
}
