import { describe, it, expect, beforeEach } from "vitest";
import { openMotebitDB } from "../idb.js";
import { IdbLatencyStatsStore } from "../latency-stats-store.js";

describe("IdbLatencyStatsStore", () => {
  let store: IdbLatencyStatsStore;
  const motebitId = "m-local";
  const remoteId = "m-remote";

  beforeEach(async () => {
    const db = await openMotebitDB(`test-latency-${crypto.randomUUID()}`);
    store = new IdbLatencyStatsStore(db);
  });

  it("record + getStats round-trip", async () => {
    await store.record(motebitId, remoteId, 100);

    await new Promise((r) => setTimeout(r, 50));

    const stats = await store.getStats(motebitId, remoteId);
    expect(stats.sample_count).toBe(1);
    expect(stats.avg_ms).toBe(100);
    expect(stats.p95_ms).toBe(100);
  });

  it("getStats returns zeros for no data", async () => {
    const stats = await store.getStats(motebitId, remoteId);
    expect(stats.avg_ms).toBe(0);
    expect(stats.p95_ms).toBe(0);
    expect(stats.sample_count).toBe(0);
  });

  it("getStats computes avg_ms, p95_ms, sample_count", async () => {
    // Record 20 samples: 10, 20, 30, ..., 200
    for (let i = 1; i <= 20; i++) {
      await store.record(motebitId, remoteId, i * 10);
    }

    await new Promise((r) => setTimeout(r, 50));

    const stats = await store.getStats(motebitId, remoteId);
    expect(stats.sample_count).toBe(20);

    // avg = (10+20+...+200)/20 = 2100/20 = 105
    expect(stats.avg_ms).toBe(105);

    // p95: ceil(20*0.95)-1 = ceil(19)-1 = 18th index in ascending sort
    // Ascending: 10,20,...,200 → index 18 = 190
    expect(stats.p95_ms).toBe(190);
  });

  it("getStats respects limit param", async () => {
    // Record 10 samples with different latencies
    for (let i = 1; i <= 10; i++) {
      await store.record(motebitId, remoteId, i * 100);
    }

    await new Promise((r) => setTimeout(r, 50));

    // Only take last 3 entries (most recent by recorded_at)
    const stats = await store.getStats(motebitId, remoteId, 3);
    expect(stats.sample_count).toBe(3);
    // Most recent 3 are 800, 900, 1000 — avg = 900
    // (We can't guarantee exact order due to same-ms timestamps,
    // but sample_count must be 3)
  });

  it("isolates by remote motebit ID", async () => {
    await store.record(motebitId, "m-remote-a", 100);
    await store.record(motebitId, "m-remote-b", 200);

    await new Promise((r) => setTimeout(r, 50));

    const statsA = await store.getStats(motebitId, "m-remote-a");
    expect(statsA.sample_count).toBe(1);
    expect(statsA.avg_ms).toBe(100);

    const statsB = await store.getStats(motebitId, "m-remote-b");
    expect(statsB.sample_count).toBe(1);
    expect(statsB.avg_ms).toBe(200);
  });
});
