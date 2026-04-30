import { describe, it, expect, beforeEach } from "vitest";
import { AgentTrustLevel, asMotebitId } from "@motebit/sdk";
import type { AgentTrustRecord, LatencyStatsStoreAdapter } from "@motebit/sdk";
import { readLatencyStats } from "../latency-stats-projection.js";

class InMemoryLatencyStore implements LatencyStatsStoreAdapter {
  rows: Array<{ motebit_id: string; remote_motebit_id: string; latency_ms: number }> = [];
  shouldThrow = false;
  async record(motebitId: string, remoteMotebitId: string, latencyMs: number): Promise<void> {
    this.rows.push({
      motebit_id: motebitId,
      remote_motebit_id: remoteMotebitId,
      latency_ms: latencyMs,
    });
  }
  async getStats(
    motebitId: string,
    remoteMotebitId: string,
    limit = 100,
  ): Promise<{ avg_ms: number; p95_ms: number; sample_count: number }> {
    if (this.shouldThrow) throw new Error("store unavailable");
    const samples = this.rows
      .filter((r) => r.motebit_id === motebitId && r.remote_motebit_id === remoteMotebitId)
      .slice(0, limit)
      .map((r) => r.latency_ms);
    if (samples.length === 0) return { avg_ms: 0, p95_ms: 0, sample_count: 0 };
    const avg_ms = samples.reduce((a, b) => a + b, 0) / samples.length;
    const sorted = [...samples].sort((a, b) => a - b);
    const p95Index = Math.min(Math.ceil(sorted.length * 0.95) - 1, sorted.length - 1);
    return { avg_ms, p95_ms: sorted[p95Index]!, sample_count: samples.length };
  }
}

function makeRecord(remoteId: string): AgentTrustRecord {
  return {
    motebit_id: asMotebitId("self"),
    remote_motebit_id: asMotebitId(remoteId),
    trust_level: AgentTrustLevel.Verified,
    first_seen_at: 0,
    last_seen_at: 0,
    interaction_count: 1,
  };
}

describe("readLatencyStats", () => {
  let store: InMemoryLatencyStore;

  beforeEach(() => {
    store = new InMemoryLatencyStore();
  });

  it("returns null when the store has zero samples for the pair", async () => {
    const record = makeRecord("m-no-samples");
    expect(await readLatencyStats(store, "self", record)).toBeNull();
  });

  it("projects avg/p95/sample_count when samples exist", async () => {
    await store.record("self", "m-active", 100);
    await store.record("self", "m-active", 200);
    await store.record("self", "m-active", 300);
    const record = makeRecord("m-active");
    const proj = await readLatencyStats(store, "self", record);
    expect(proj).not.toBeNull();
    expect(proj?.sample_count).toBe(3);
    expect(proj?.avg_ms).toBeCloseTo(200);
  });

  it("scopes samples to the (motebit_id, remote_motebit_id) pair — other pairs don't leak in", async () => {
    await store.record("self", "m-other", 9999);
    await store.record("other-self", "m-target", 9999);
    const record = makeRecord("m-target");
    expect(await readLatencyStats(store, "self", record)).toBeNull();
  });

  it("collapses store errors to null without throwing — best-effort projection", async () => {
    store.shouldThrow = true;
    const record = makeRecord("m-broken-store");
    expect(await readLatencyStats(store, "self", record)).toBeNull();
  });

  it("returns null when sample_count is 0 even if the store responds successfully", async () => {
    // The default in-memory store returns sample_count: 0 for empty pairs.
    // The projection MUST treat that as no-data, not as "0ms latency".
    const record = makeRecord("m-zero-count");
    expect(await readLatencyStats(store, "self", record)).toBeNull();
  });
});
