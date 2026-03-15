import { describe, it, expect, beforeEach } from "vitest";
import { openMotebitDB } from "../idb.js";
import { IdbGradientStore } from "../gradient-store.js";
import type { GradientSnapshot } from "@motebit/sdk";

describe("IdbGradientStore", () => {
  let store: IdbGradientStore;
  const motebitId = "m-test-1";

  function makeSnapshot(timestamp: number, gradient = 0.5): GradientSnapshot {
    return {
      motebit_id: motebitId,
      timestamp,
      gradient,
      delta: 0,
      knowledge_density: 0.3,
      knowledge_density_raw: 15,
      knowledge_quality: 0.4,
      graph_connectivity: 0.2,
      graph_connectivity_raw: 1.5,
      temporal_stability: 0.5,
      retrieval_quality: 0.6,
      interaction_efficiency: 0.7,
      tool_efficiency: 0.8,
      curiosity_pressure: 0.5,
      stats: {
        live_nodes: 10,
        live_edges: 5,
        semantic_count: 7,
        episodic_count: 3,
        pinned_count: 2,
        avg_confidence: 0.8,
        avg_half_life: 604800000,
        consolidation_add: 5,
        consolidation_update: 2,
        consolidation_reinforce: 3,
        consolidation_noop: 1,
        total_confidence_mass: 8,
        avg_retrieval_score: 0.6,
        retrieval_count: 10,
        avg_iterations_per_turn: 2,
        total_turns: 5,
        tool_calls_succeeded: 8,
        tool_calls_blocked: 1,
        tool_calls_failed: 0,
        curiosity_target_count: 3,
        avg_curiosity_score: 0.4,
      },
    };
  }

  beforeEach(async () => {
    const db = await openMotebitDB(`test-gradient-${crypto.randomUUID()}`);
    store = new IdbGradientStore(db);
  });

  it("saves and retrieves latest", () => {
    const s1 = makeSnapshot(1000, 0.4);
    const s2 = makeSnapshot(2000, 0.6);
    store.save(s1);
    store.save(s2);
    const latest = store.latest(motebitId);
    expect(latest).not.toBeNull();
    expect(latest!.timestamp).toBe(2000);
    expect(latest!.gradient).toBe(0.6);
  });

  it("returns null for latest when empty", () => {
    expect(store.latest(motebitId)).toBeNull();
  });

  it("lists in descending order with limit", () => {
    store.save(makeSnapshot(1000, 0.3));
    store.save(makeSnapshot(2000, 0.5));
    store.save(makeSnapshot(3000, 0.7));

    const all = store.list(motebitId);
    expect(all).toHaveLength(3);
    expect(all[0]!.timestamp).toBe(3000);

    const limited = store.list(motebitId, 2);
    expect(limited).toHaveLength(2);
    expect(limited[0]!.timestamp).toBe(3000);
    expect(limited[1]!.timestamp).toBe(2000);
  });

  it("isolates by motebit ID", () => {
    store.save(makeSnapshot(1000, 0.5));
    store.save({ ...makeSnapshot(2000, 0.8), motebit_id: "m-other" });
    const list = store.list(motebitId);
    expect(list).toHaveLength(1);
    expect(list[0]!.motebit_id).toBe(motebitId);
  });

  it("preload round-trip", async () => {
    store.save(makeSnapshot(1000, 0.3));
    store.save(makeSnapshot(2000, 0.5));

    // Wait for IDB writes
    await new Promise((r) => setTimeout(r, 50));

    // New store, same DB
    const db = (store as unknown as { db: IDBDatabase }).db;
    const store2 = new IdbGradientStore(db);
    await store2.preload(motebitId);

    const latest = store2.latest(motebitId);
    expect(latest).not.toBeNull();
    expect(latest!.timestamp).toBe(2000);

    const list = store2.list(motebitId);
    expect(list).toHaveLength(2);
  });
});
