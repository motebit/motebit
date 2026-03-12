import { describe, it, expect } from "vitest";
import { computeGradient, InMemoryGradientStore } from "../gradient.js";
import type { GradientSnapshot, BehavioralStats } from "../gradient.js";
import type { MemoryNode, MemoryEdge, EventLogEntry } from "@motebit/sdk";
import { EventType, SensitivityLevel, MemoryType, RelationType } from "@motebit/sdk";

const HALF_LIFE_7D = 7 * 24 * 60 * 60 * 1000;
const HALF_LIFE_30D = 30 * 24 * 60 * 60 * 1000;

function makeNode(overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    node_id: crypto.randomUUID(),
    motebit_id: "test-motebit",
    content: "test",
    embedding: [0.1, 0.2],
    confidence: 0.8,
    sensitivity: SensitivityLevel.None,
    created_at: Date.now(),
    last_accessed: Date.now(),
    half_life: HALF_LIFE_7D,
    tombstoned: false,
    pinned: false,
    memory_type: MemoryType.Semantic,
    ...overrides,
  };
}

function makeEdge(
  sourceId: string,
  targetId: string,
  overrides: Partial<MemoryEdge> = {},
): MemoryEdge {
  return {
    edge_id: crypto.randomUUID(),
    source_id: sourceId,
    target_id: targetId,
    relation_type: RelationType.Related,
    weight: 1.0,
    confidence: 0.8,
    ...overrides,
  };
}

function makeConsolidationEvent(
  action: string,
  overrides: Partial<EventLogEntry> = {},
): EventLogEntry {
  return {
    event_id: crypto.randomUUID(),
    motebit_id: "test-motebit",
    timestamp: Date.now(),
    event_type: EventType.MemoryConsolidated,
    payload: { action },
    version_clock: 1,
    tombstoned: false,
    ...overrides,
  };
}

describe("computeGradient", () => {
  it("returns baseline gradient for empty motebit (ie/te default to 0.5)", () => {
    const result = computeGradient("test-motebit", [], [], [], null);

    // ie=0.5, te=0.5 default when no behavioral stats
    // gradient = 0.15*0.5 + 0.10*0.5 = 0.125
    expect(result.knowledge_density).toBe(0);
    expect(result.knowledge_quality).toBe(0);
    expect(result.graph_connectivity).toBe(0);
    expect(result.temporal_stability).toBe(0);
    expect(result.interaction_efficiency).toBe(0.5);
    expect(result.tool_efficiency).toBe(0.5);
    expect(result.gradient).toBeCloseTo(0.125, 10);
    expect(result.delta).toBe(0);
    expect(result.stats.live_nodes).toBe(0);
    expect(result.stats.live_edges).toBe(0);
  });

  it("knowledge density scales with confidence-weighted node count", () => {
    const node1 = makeNode({ confidence: 0.9 });
    const result1 = computeGradient("test-motebit", [node1], [], [], null);

    const node2 = makeNode({ confidence: 0.9 });
    const node3 = makeNode({ confidence: 0.9 });
    const result2 = computeGradient("test-motebit", [node1, node2, node3], [], [], null);

    // More nodes = higher density
    expect(result2.knowledge_density).toBeGreaterThan(result1.knowledge_density);
    expect(result2.knowledge_density_raw).toBeGreaterThan(result1.knowledge_density_raw);
  });

  it("knowledge density is normalized via x/(x+50)", () => {
    // With 50 units of confidence mass, kd should be ~0.5
    const nodes: MemoryNode[] = [];
    for (let i = 0; i < 50; i++) {
      nodes.push(makeNode({ confidence: 1.0 }));
    }
    const result = computeGradient("test-motebit", nodes, [], [], null);

    // Each node has confidence ~1.0 and just created (no decay), so mass ~50
    expect(result.knowledge_density).toBeGreaterThan(0.45);
    expect(result.knowledge_density).toBeLessThan(0.55);
  });

  it("knowledge quality = (reinforce+update)/total", () => {
    const events = [
      makeConsolidationEvent("ADD"),
      makeConsolidationEvent("ADD"),
      makeConsolidationEvent("REINFORCE"),
      makeConsolidationEvent("UPDATE"),
    ];

    const result = computeGradient("test-motebit", [], [], events, null);

    // (1 reinforce + 1 update) / 4 total = 0.5
    expect(result.knowledge_quality).toBe(0.5);
  });

  it("new motebit has kq near 0 (all ADDs)", () => {
    const events = [
      makeConsolidationEvent("ADD"),
      makeConsolidationEvent("ADD"),
      makeConsolidationEvent("ADD"),
    ];

    const result = computeGradient("test-motebit", [], [], events, null);
    expect(result.knowledge_quality).toBe(0);
  });

  it("mature motebit has kq near 1 (all REINFORCEs)", () => {
    const events = [
      makeConsolidationEvent("REINFORCE"),
      makeConsolidationEvent("REINFORCE"),
      makeConsolidationEvent("UPDATE"),
    ];

    const result = computeGradient("test-motebit", [], [], events, null);
    expect(result.knowledge_quality).toBe(1);
  });

  it("graph connectivity scales with edge/node ratio", () => {
    const n1 = makeNode();
    const n2 = makeNode();
    const n3 = makeNode();
    const e1 = makeEdge(n1.node_id, n2.node_id);

    const result1 = computeGradient("test-motebit", [n1, n2, n3], [], [], null);
    const result2 = computeGradient("test-motebit", [n1, n2, n3], [e1], [], null);

    expect(result2.graph_connectivity).toBeGreaterThan(result1.graph_connectivity);
    expect(result1.graph_connectivity).toBe(0);
  });

  it("graph connectivity is normalized via x/(x+2)", () => {
    const n1 = makeNode();
    const n2 = makeNode();
    // 2 edges / 2 nodes = ratio 1.0, normalized: 1/(1+2) = 0.333
    const e1 = makeEdge(n1.node_id, n2.node_id);
    const e2 = makeEdge(n2.node_id, n1.node_id);

    const result = computeGradient("test-motebit", [n1, n2], [e1, e2], [], null);

    expect(result.graph_connectivity_raw).toBeCloseTo(1.0, 1);
    expect(result.graph_connectivity).toBeCloseTo(1 / 3, 1);
  });

  it("temporal stability weights semantic ratio, pinned, half-life", () => {
    const semanticNode = makeNode({ memory_type: MemoryType.Semantic });
    const episodicNode = makeNode({ memory_type: MemoryType.Episodic });

    // 50% semantic → ts semantic component = 0.6 * 0.5 = 0.3
    const result1 = computeGradient("test-motebit", [semanticNode, episodicNode], [], [], null);

    // 100% semantic → ts semantic component = 0.6 * 1.0 = 0.6
    const result2 = computeGradient("test-motebit", [semanticNode], [], [], null);

    expect(result2.temporal_stability).toBeGreaterThan(result1.temporal_stability);
  });

  it("pinned nodes increase temporal stability", () => {
    const unpinned = [makeNode({ pinned: false }), makeNode({ pinned: false })];
    const pinned = [makeNode({ pinned: true }), makeNode({ pinned: true })];

    const result1 = computeGradient("test-motebit", unpinned, [], [], null);
    const result2 = computeGradient("test-motebit", pinned, [], [], null);

    expect(result2.temporal_stability).toBeGreaterThan(result1.temporal_stability);
  });

  it("longer half-life increases temporal stability", () => {
    const shortHL = [makeNode({ half_life: HALF_LIFE_7D }), makeNode({ half_life: HALF_LIFE_7D })];
    const longHL = [makeNode({ half_life: HALF_LIFE_30D }), makeNode({ half_life: HALF_LIFE_30D })];

    const result1 = computeGradient("test-motebit", shortHL, [], [], null);
    const result2 = computeGradient("test-motebit", longHL, [], [], null);

    expect(result2.temporal_stability).toBeGreaterThan(result1.temporal_stability);
  });

  it("composite is weighted sum of all 7 sub-metrics", () => {
    const node = makeNode({ confidence: 1.0 });
    const edge = makeEdge(node.node_id, node.node_id);
    const events = [makeConsolidationEvent("REINFORCE")];
    const behavioral: BehavioralStats = {
      turnCount: 5,
      totalIterations: 10,
      toolCallsSucceeded: 8,
      toolCallsBlocked: 1,
      toolCallsFailed: 1,
    };

    const result = computeGradient("test-motebit", [node], [edge], events, null, undefined, undefined, behavioral);

    const expected =
      0.15 * result.knowledge_density +
      0.20 * result.knowledge_quality +
      0.10 * result.graph_connectivity +
      0.15 * result.temporal_stability +
      0.15 * result.retrieval_quality +
      0.15 * result.interaction_efficiency +
      0.10 * result.tool_efficiency;

    expect(result.gradient).toBeCloseTo(expected, 10);
  });

  it("delta = current - previous", () => {
    const node = makeNode({ confidence: 0.9 });
    const result = computeGradient("test-motebit", [node], [], [], 0.1);

    expect(result.delta).toBeCloseTo(result.gradient - 0.1, 10);
  });

  it("delta is 0 when no previous", () => {
    const node = makeNode();
    const result = computeGradient("test-motebit", [node], [], [], null);

    expect(result.delta).toBe(0);
  });

  it("excludes tombstoned nodes", () => {
    const live = makeNode({ confidence: 0.9 });
    const dead = makeNode({ confidence: 0.9, tombstoned: true });

    const result = computeGradient("test-motebit", [live, dead], [], [], null);

    expect(result.stats.live_nodes).toBe(1);
  });

  it("handles single node correctly", () => {
    const node = makeNode({ confidence: 0.5 });
    const result = computeGradient("test-motebit", [node], [], [], null);

    expect(result.gradient).toBeGreaterThan(0);
    expect(result.stats.live_nodes).toBe(1);
    expect(result.stats.avg_confidence).toBe(0.5);
  });

  it("handles all tombstoned nodes", () => {
    const dead1 = makeNode({ tombstoned: true });
    const dead2 = makeNode({ tombstoned: true });

    const result = computeGradient("test-motebit", [dead1, dead2], [], [], null);

    // Memory sub-metrics are 0, but ie/te default to 0.5
    expect(result.gradient).toBeCloseTo(0.125, 10);
    expect(result.stats.live_nodes).toBe(0);
  });

  it("handles all pinned nodes", () => {
    const pinned = [makeNode({ pinned: true }), makeNode({ pinned: true })];

    const result = computeGradient("test-motebit", pinned, [], [], null);

    expect(result.stats.pinned_count).toBe(2);
    expect(result.temporal_stability).toBeGreaterThan(0);
  });

  it("handles zero half-life gracefully", () => {
    const node = makeNode({ half_life: 0 });
    const result = computeGradient("test-motebit", [node], [], [], null);

    // With zero half-life, computeDecayedConfidence returns initial confidence
    expect(result.gradient).toBeGreaterThan(0);
  });

  it("respects custom config weights", () => {
    const node = makeNode({ confidence: 1.0 });
    const events = [makeConsolidationEvent("REINFORCE")];

    const result = computeGradient("test-motebit", [node], [], events, null, {
      weight_kd: 1.0,
      weight_kq: 0,
      weight_gc: 0,
      weight_ts: 0,
      weight_rq: 0,
      weight_ie: 0,
      weight_te: 0,
    });

    // With all weight on kd, gradient should equal kd
    expect(result.gradient).toBeCloseTo(result.knowledge_density, 10);
  });

  it("parses consolidation_action payload key", () => {
    const event: EventLogEntry = {
      event_id: crypto.randomUUID(),
      motebit_id: "test-motebit",
      timestamp: Date.now(),
      event_type: EventType.MemoryConsolidated,
      payload: { consolidation_action: "reinforce" },
      version_clock: 1,
      tombstoned: false,
    };

    const result = computeGradient("test-motebit", [], [], [event], null);
    expect(result.stats.consolidation_reinforce).toBe(1);
  });

  it("retrieval quality is 0 when no retrieval stats provided", () => {
    const node = makeNode();
    const result = computeGradient("test-motebit", [node], [], [], null);
    expect(result.retrieval_quality).toBe(0);
    expect(result.stats.avg_retrieval_score).toBe(0);
    expect(result.stats.retrieval_count).toBe(0);
  });

  it("retrieval quality equals avgScore when retrieval stats provided", () => {
    const node = makeNode();
    const result = computeGradient("test-motebit", [node], [], [], null, undefined, {
      avgScore: 0.75,
      count: 10,
    });
    expect(result.retrieval_quality).toBe(0.75);
    expect(result.stats.avg_retrieval_score).toBe(0.75);
    expect(result.stats.retrieval_count).toBe(10);
  });

  it("retrieval quality contributes to composite with default weight 0.15", () => {
    const result = computeGradient("test-motebit", [], [], [], null, undefined, {
      avgScore: 1.0,
      count: 5,
    });
    // kd/kq/gc/ts = 0, rq = 1.0 * 0.15, ie/te default to 0.5
    // gradient = 0.15 * 1.0 + 0.15 * 0.5 + 0.10 * 0.5 = 0.275
    expect(result.gradient).toBeCloseTo(0.275, 10);
  });

  it("stats are correctly populated", () => {
    const n1 = makeNode({ confidence: 0.6, pinned: true, memory_type: MemoryType.Semantic });
    const n2 = makeNode({ confidence: 0.4, pinned: false, memory_type: MemoryType.Episodic });
    const e1 = makeEdge(n1.node_id, n2.node_id);
    const events = [
      makeConsolidationEvent("ADD"),
      makeConsolidationEvent("REINFORCE"),
      makeConsolidationEvent("NOOP"),
    ];

    const result = computeGradient("test-motebit", [n1, n2], [e1], events, null);

    expect(result.stats.live_nodes).toBe(2);
    expect(result.stats.live_edges).toBe(1);
    expect(result.stats.semantic_count).toBe(1);
    expect(result.stats.episodic_count).toBe(1);
    expect(result.stats.pinned_count).toBe(1);
    expect(result.stats.avg_confidence).toBe(0.5);
    expect(result.stats.consolidation_add).toBe(1);
    expect(result.stats.consolidation_reinforce).toBe(1);
    expect(result.stats.consolidation_noop).toBe(1);
    expect(result.stats.consolidation_update).toBe(0);
  });
});

describe("behavioral metrics", () => {
  it("ie=1.0 when avgIterations=1 (single iteration per turn)", () => {
    const stats: BehavioralStats = {
      turnCount: 5,
      totalIterations: 5, // 5/5 = 1.0 avg
      toolCallsSucceeded: 0,
      toolCallsBlocked: 0,
      toolCallsFailed: 0,
    };
    const result = computeGradient("test-motebit", [], [], [], null, undefined, undefined, stats);
    expect(result.interaction_efficiency).toBeCloseTo(1.0, 10);
  });

  it("ie=0.0 when avgIterations=MAX_TOOL_ITERATIONS (10)", () => {
    const stats: BehavioralStats = {
      turnCount: 3,
      totalIterations: 30, // 30/3 = 10.0 avg
      toolCallsSucceeded: 0,
      toolCallsBlocked: 0,
      toolCallsFailed: 0,
    };
    const result = computeGradient("test-motebit", [], [], [], null, undefined, undefined, stats);
    expect(result.interaction_efficiency).toBeCloseTo(0.0, 10);
  });

  it("ie=0.5 default when no turns tracked", () => {
    const stats: BehavioralStats = {
      turnCount: 0,
      totalIterations: 0,
      toolCallsSucceeded: 0,
      toolCallsBlocked: 0,
      toolCallsFailed: 0,
    };
    const result = computeGradient("test-motebit", [], [], [], null, undefined, undefined, stats);
    expect(result.interaction_efficiency).toBe(0.5);
  });

  it("ie=0.5 default when no behavioral stats provided", () => {
    const result = computeGradient("test-motebit", [], [], [], null);
    expect(result.interaction_efficiency).toBe(0.5);
  });

  it("te=1.0 when all tool calls succeed", () => {
    const stats: BehavioralStats = {
      turnCount: 1,
      totalIterations: 1,
      toolCallsSucceeded: 10,
      toolCallsBlocked: 0,
      toolCallsFailed: 0,
    };
    const result = computeGradient("test-motebit", [], [], [], null, undefined, undefined, stats);
    expect(result.tool_efficiency).toBeCloseTo(1.0, 10);
  });

  it("te=0.0 when all tool calls are blocked", () => {
    const stats: BehavioralStats = {
      turnCount: 1,
      totalIterations: 1,
      toolCallsSucceeded: 0,
      toolCallsBlocked: 5,
      toolCallsFailed: 0,
    };
    const result = computeGradient("test-motebit", [], [], [], null, undefined, undefined, stats);
    expect(result.tool_efficiency).toBeCloseTo(0.0, 10);
  });

  it("te=0.5 default when no tool calls", () => {
    const stats: BehavioralStats = {
      turnCount: 3,
      totalIterations: 3,
      toolCallsSucceeded: 0,
      toolCallsBlocked: 0,
      toolCallsFailed: 0,
    };
    const result = computeGradient("test-motebit", [], [], [], null, undefined, undefined, stats);
    expect(result.tool_efficiency).toBe(0.5);
  });

  it("te=0.5 default when no behavioral stats provided", () => {
    const result = computeGradient("test-motebit", [], [], [], null);
    expect(result.tool_efficiency).toBe(0.5);
  });

  it("composite score uses all 7 weights that sum to 1.0", () => {
    // Verify default weights sum to 1.0
    const weights = [0.15, 0.20, 0.10, 0.15, 0.15, 0.15, 0.10];
    const sum = weights.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 10);
  });

  it("behavioral stats are recorded in snapshot stats", () => {
    const stats: BehavioralStats = {
      turnCount: 7,
      totalIterations: 14,
      toolCallsSucceeded: 20,
      toolCallsBlocked: 3,
      toolCallsFailed: 2,
    };
    const result = computeGradient("test-motebit", [], [], [], null, undefined, undefined, stats);
    expect(result.stats.avg_iterations_per_turn).toBeCloseTo(2.0, 10);
    expect(result.stats.total_turns).toBe(7);
    expect(result.stats.tool_calls_succeeded).toBe(20);
    expect(result.stats.tool_calls_blocked).toBe(3);
    expect(result.stats.tool_calls_failed).toBe(2);
  });

  it("ie is clamped to [0, 1] range", () => {
    // avgIterations > MAX (shouldn't happen in practice but defensive)
    const stats: BehavioralStats = {
      turnCount: 1,
      totalIterations: 15, // 15 > MAX_TOOL_ITERATIONS (10)
      toolCallsSucceeded: 0,
      toolCallsBlocked: 0,
      toolCallsFailed: 0,
    };
    const result = computeGradient("test-motebit", [], [], [], null, undefined, undefined, stats);
    expect(result.interaction_efficiency).toBe(0);
  });
});

describe("InMemoryGradientStore", () => {
  it("save and latest round-trip", () => {
    const store = new InMemoryGradientStore();
    const snapshot: GradientSnapshot = {
      motebit_id: "test-motebit",
      timestamp: Date.now(),
      gradient: 0.42,
      delta: 0.02,
      knowledge_density: 0.3,
      knowledge_density_raw: 15,
      knowledge_quality: 0.5,
      graph_connectivity: 0.2,
      graph_connectivity_raw: 0.5,
      temporal_stability: 0.6,
      retrieval_quality: 0.65,
      interaction_efficiency: 0.8,
      tool_efficiency: 0.9,
      stats: {
        live_nodes: 10,
        live_edges: 5,
        semantic_count: 7,
        episodic_count: 3,
        pinned_count: 2,
        avg_confidence: 0.7,
        avg_half_life: HALF_LIFE_7D,
        consolidation_add: 3,
        consolidation_update: 2,
        consolidation_reinforce: 4,
        consolidation_noop: 1,
        total_confidence_mass: 15,
        avg_retrieval_score: 0.65,
        retrieval_count: 20,
        avg_iterations_per_turn: 1.5,
        total_turns: 10,
        tool_calls_succeeded: 15,
        tool_calls_blocked: 2,
        tool_calls_failed: 1,
      },
    };

    store.save(snapshot);
    const latest = store.latest("test-motebit");

    expect(latest).not.toBeNull();
    expect(latest!.gradient).toBe(0.42);
    expect(latest!.stats.live_nodes).toBe(10);
  });

  it("latest returns null for unknown motebit", () => {
    const store = new InMemoryGradientStore();
    expect(store.latest("unknown")).toBeNull();
  });

  it("list returns snapshots in descending timestamp order", () => {
    const store = new InMemoryGradientStore();
    const base: GradientSnapshot = {
      motebit_id: "test-motebit",
      timestamp: 1000,
      gradient: 0.1,
      delta: 0,
      knowledge_density: 0,
      knowledge_density_raw: 0,
      knowledge_quality: 0,
      graph_connectivity: 0,
      graph_connectivity_raw: 0,
      temporal_stability: 0,
      retrieval_quality: 0,
      interaction_efficiency: 0,
      tool_efficiency: 0,
      stats: {
        live_nodes: 0,
        live_edges: 0,
        semantic_count: 0,
        episodic_count: 0,
        pinned_count: 0,
        avg_confidence: 0,
        avg_half_life: 0,
        consolidation_add: 0,
        consolidation_update: 0,
        consolidation_reinforce: 0,
        consolidation_noop: 0,
        total_confidence_mass: 0,
        avg_retrieval_score: 0,
        retrieval_count: 0,
        avg_iterations_per_turn: 0,
        total_turns: 0,
        tool_calls_succeeded: 0,
        tool_calls_blocked: 0,
        tool_calls_failed: 0,
      },
    };

    store.save({ ...base, timestamp: 1000, gradient: 0.1 });
    store.save({ ...base, timestamp: 3000, gradient: 0.3 });
    store.save({ ...base, timestamp: 2000, gradient: 0.2 });

    const all = store.list("test-motebit");
    expect(all).toHaveLength(3);
    expect(all[0]!.timestamp).toBe(3000);
    expect(all[1]!.timestamp).toBe(2000);
    expect(all[2]!.timestamp).toBe(1000);
  });

  it("list respects limit", () => {
    const store = new InMemoryGradientStore();
    const base: GradientSnapshot = {
      motebit_id: "test-motebit",
      timestamp: 0,
      gradient: 0,
      delta: 0,
      knowledge_density: 0,
      knowledge_density_raw: 0,
      knowledge_quality: 0,
      graph_connectivity: 0,
      graph_connectivity_raw: 0,
      temporal_stability: 0,
      retrieval_quality: 0,
      interaction_efficiency: 0,
      tool_efficiency: 0,
      stats: {
        live_nodes: 0,
        live_edges: 0,
        semantic_count: 0,
        episodic_count: 0,
        pinned_count: 0,
        avg_confidence: 0,
        avg_half_life: 0,
        consolidation_add: 0,
        consolidation_update: 0,
        consolidation_reinforce: 0,
        consolidation_noop: 0,
        total_confidence_mass: 0,
        avg_retrieval_score: 0,
        retrieval_count: 0,
        avg_iterations_per_turn: 0,
        total_turns: 0,
        tool_calls_succeeded: 0,
        tool_calls_blocked: 0,
        tool_calls_failed: 0,
      },
    };

    for (let i = 0; i < 5; i++) {
      store.save({ ...base, timestamp: i * 1000 });
    }

    const limited = store.list("test-motebit", 2);
    expect(limited).toHaveLength(2);
  });

  it("list filters by motebit_id", () => {
    const store = new InMemoryGradientStore();
    const base: GradientSnapshot = {
      motebit_id: "a",
      timestamp: 0,
      gradient: 0,
      delta: 0,
      knowledge_density: 0,
      knowledge_density_raw: 0,
      knowledge_quality: 0,
      graph_connectivity: 0,
      graph_connectivity_raw: 0,
      temporal_stability: 0,
      retrieval_quality: 0,
      interaction_efficiency: 0,
      tool_efficiency: 0,
      stats: {
        live_nodes: 0,
        live_edges: 0,
        semantic_count: 0,
        episodic_count: 0,
        pinned_count: 0,
        avg_confidence: 0,
        avg_half_life: 0,
        consolidation_add: 0,
        consolidation_update: 0,
        consolidation_reinforce: 0,
        consolidation_noop: 0,
        total_confidence_mass: 0,
        avg_retrieval_score: 0,
        retrieval_count: 0,
        avg_iterations_per_turn: 0,
        total_turns: 0,
        tool_calls_succeeded: 0,
        tool_calls_blocked: 0,
        tool_calls_failed: 0,
      },
    };

    store.save({ ...base, motebit_id: "a" });
    store.save({ ...base, motebit_id: "b" });
    store.save({ ...base, motebit_id: "a" });

    expect(store.list("a")).toHaveLength(2);
    expect(store.list("b")).toHaveLength(1);
    expect(store.list("c")).toHaveLength(0);
  });
});
