import { describe, it, expect } from "vitest";
import {
  computeGradient,
  computePrecision,
  gradientToMarketConfig,
  NEUTRAL_PRECISION,
  InMemoryGradientStore,
  summarizeGradientHistory,
  buildPrecisionContext,
} from "../gradient.js";
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
  it("returns baseline gradient for empty motebit (ie/te/cp default to 0.5)", () => {
    const result = computeGradient("test-motebit", [], [], [], null);

    // ie=0.5, te=0.5, cp=0.5 default when no behavioral/curiosity stats
    // gradient = 0.12*0.5 + 0.10*0.5 + 0.13*0.5 = 0.175
    expect(result.knowledge_density).toBe(0);
    expect(result.knowledge_quality).toBe(0);
    expect(result.graph_connectivity).toBe(0);
    expect(result.temporal_stability).toBe(0);
    expect(result.interaction_efficiency).toBe(0.5);
    expect(result.tool_efficiency).toBe(0.5);
    expect(result.curiosity_pressure).toBe(0.5);
    expect(result.gradient).toBeCloseTo(0.175, 10);
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

  it("composite is weighted sum of all 8 sub-metrics", () => {
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

    const result = computeGradient(
      "test-motebit",
      [node],
      [edge],
      events,
      null,
      undefined,
      undefined,
      behavioral,
    );

    const expected =
      0.15 * result.knowledge_density +
      0.17 * result.knowledge_quality +
      0.08 * result.graph_connectivity +
      0.1 * result.temporal_stability +
      0.15 * result.retrieval_quality +
      0.12 * result.interaction_efficiency +
      0.1 * result.tool_efficiency +
      0.13 * result.curiosity_pressure;

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

    // Memory sub-metrics are 0, but ie/te/cp default to 0.5
    expect(result.gradient).toBeCloseTo(0.175, 10);
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
      weight_cp: 0,
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
    // kd/kq/gc/ts = 0, rq = 1.0 * 0.15, ie=0.5*0.12, te=0.5*0.10, cp=0.5*0.13
    // gradient = 0.15 + 0.06 + 0.05 + 0.065 = 0.325
    expect(result.gradient).toBeCloseTo(0.325, 10);
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

  it("composite score uses all 8 weights that sum to 1.0", () => {
    // Verify default weights sum to 1.0
    const weights = [0.15, 0.17, 0.08, 0.1, 0.15, 0.12, 0.1, 0.13];
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
      curiosity_pressure: 0.7,
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
        curiosity_target_count: 0,
        avg_curiosity_score: 0,
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
      curiosity_pressure: 0,
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
        curiosity_target_count: 0,
        avg_curiosity_score: 0,
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
      curiosity_pressure: 0,
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
        curiosity_target_count: 0,
        avg_curiosity_score: 0,
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
      curiosity_pressure: 0,
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
        curiosity_target_count: 0,
        avg_curiosity_score: 0,
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

// === Active Inference Precision Tests ===

describe("computePrecision", () => {
  function makeSnapshot(gradient: number, delta = 0): GradientSnapshot {
    return {
      motebit_id: "test",
      timestamp: Date.now(),
      gradient,
      delta,
      knowledge_density: gradient,
      knowledge_density_raw: gradient,
      knowledge_quality: gradient,
      graph_connectivity: gradient,
      graph_connectivity_raw: gradient,
      temporal_stability: gradient,
      retrieval_quality: gradient,
      interaction_efficiency: gradient,
      tool_efficiency: gradient,
      curiosity_pressure: gradient,
      stats: {
        live_nodes: 10,
        live_edges: 5,
        semantic_count: 7,
        episodic_count: 3,
        pinned_count: 1,
        avg_confidence: 0.8,
        avg_half_life: 604800000,
        consolidation_add: 0,
        consolidation_update: 0,
        consolidation_reinforce: 0,
        consolidation_noop: 0,
        total_confidence_mass: 8,
        avg_retrieval_score: 0.7,
        retrieval_count: 5,
        avg_iterations_per_turn: 2,
        total_turns: 5,
        tool_calls_succeeded: 8,
        tool_calls_blocked: 1,
        tool_calls_failed: 1,
        curiosity_target_count: 3,
        avg_curiosity_score: 0.5,
      },
    };
  }

  it("neutral gradient (0.5) yields balanced precision", () => {
    const p = computePrecision(makeSnapshot(0.5));
    expect(p.selfTrust).toBeCloseTo(0.5, 1);
    expect(p.explorationDrive).toBeCloseTo(0.5, 1);
    expect(p.retrievalPrecision).toBeCloseTo(0.6, 1);
    expect(p.curiosityModulation).toBeLessThanOrEqual(0.8);
  });

  it("high gradient (0.8) yields high self-trust, low exploration", () => {
    const p = computePrecision(makeSnapshot(0.8));
    expect(p.selfTrust).toBeGreaterThan(0.7);
    expect(p.explorationDrive).toBeLessThan(0.3);
    expect(p.retrievalPrecision).toBeGreaterThan(0.7);
    expect(p.curiosityModulation).toBeLessThan(0.3);
  });

  it("low gradient (0.2) yields low self-trust, high exploration", () => {
    const p = computePrecision(makeSnapshot(0.2));
    expect(p.selfTrust).toBeLessThan(0.3);
    expect(p.explorationDrive).toBeGreaterThan(0.7);
    expect(p.retrievalPrecision).toBeLessThan(0.5);
    expect(p.curiosityModulation).toBeGreaterThan(0.5);
  });

  it("declining gradient boosts exploration via decline penalty", () => {
    const stable = computePrecision(makeSnapshot(0.4, 0));
    const declining = computePrecision(makeSnapshot(0.4, -0.1));
    expect(declining.explorationDrive).toBeGreaterThan(stable.explorationDrive);
    expect(declining.curiosityModulation).toBeGreaterThan(stable.curiosityModulation);
  });

  it("rising gradient does not add decline penalty", () => {
    const stable = computePrecision(makeSnapshot(0.6, 0));
    const rising = computePrecision(makeSnapshot(0.6, 0.1));
    expect(rising.explorationDrive).toBeCloseTo(stable.explorationDrive, 5);
  });

  it("curiosityModulation is capped at 0.8", () => {
    const p = computePrecision(makeSnapshot(0.0, -0.5));
    expect(p.curiosityModulation).toBeLessThanOrEqual(0.8);
  });

  it("all precision values are in [0, 1]", () => {
    for (const g of [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1.0]) {
      for (const d of [-0.5, -0.1, 0, 0.1, 0.5]) {
        const p = computePrecision(makeSnapshot(g, d));
        expect(p.selfTrust).toBeGreaterThanOrEqual(0);
        expect(p.selfTrust).toBeLessThanOrEqual(1);
        expect(p.explorationDrive).toBeGreaterThanOrEqual(0);
        expect(p.explorationDrive).toBeLessThanOrEqual(1);
        expect(p.retrievalPrecision).toBeGreaterThanOrEqual(0);
        expect(p.retrievalPrecision).toBeLessThanOrEqual(1);
        expect(p.curiosityModulation).toBeGreaterThanOrEqual(0);
        expect(p.curiosityModulation).toBeLessThanOrEqual(1);
      }
    }
  });

  it("NEUTRAL_PRECISION has balanced values", () => {
    expect(NEUTRAL_PRECISION.selfTrust).toBe(0.5);
    expect(NEUTRAL_PRECISION.explorationDrive).toBe(0.5);
    expect(NEUTRAL_PRECISION.retrievalPrecision).toBe(0.6);
    expect(NEUTRAL_PRECISION.curiosityModulation).toBe(0.4);
  });
});

// === Self-Model Summary Tests ===

describe("summarizeGradientHistory", () => {
  function makeSnapshot(gradient: number, delta = 0, timestamp = Date.now()): GradientSnapshot {
    return {
      motebit_id: "test",
      timestamp,
      gradient,
      delta,
      knowledge_density: gradient * 0.8,
      knowledge_density_raw: gradient * 40,
      knowledge_quality: gradient * 0.9,
      graph_connectivity: gradient * 0.5,
      graph_connectivity_raw: gradient * 1.0,
      temporal_stability: gradient * 0.7,
      retrieval_quality: gradient * 0.85,
      interaction_efficiency: gradient * 0.9,
      tool_efficiency: gradient * 0.95,
      curiosity_pressure: gradient * 0.8,
      stats: {
        live_nodes: 10,
        live_edges: 5,
        semantic_count: 7,
        episodic_count: 3,
        pinned_count: 1,
        avg_confidence: 0.8,
        avg_half_life: 604800000,
        consolidation_add: 0,
        consolidation_update: 0,
        consolidation_reinforce: 0,
        consolidation_noop: 0,
        total_confidence_mass: 8,
        avg_retrieval_score: 0.7,
        retrieval_count: 5,
        avg_iterations_per_turn: 2,
        total_turns: 5,
        tool_calls_succeeded: 8,
        tool_calls_blocked: 1,
        tool_calls_failed: 1,
        curiosity_target_count: 3,
        avg_curiosity_score: 0.5,
      },
    };
  }

  it("returns empty assessment for no history", () => {
    const summary = summarizeGradientHistory([]);
    expect(summary.snapshotCount).toBe(0);
    expect(summary.gradient).toBe(0);
    expect(summary.strengths).toHaveLength(0);
    expect(summary.weaknesses).toHaveLength(0);
    expect(summary.trajectory).toContain("No gradient history");
  });

  it("produces first-measurement trajectory for single snapshot", () => {
    const summary = summarizeGradientHistory([makeSnapshot(0.6)]);
    expect(summary.snapshotCount).toBe(1);
    expect(summary.trajectory).toContain("First measurement");
    expect(summary.gradient).toBe(0.6);
  });

  it("identifies strengths for high-gradient agent", () => {
    const summary = summarizeGradientHistory([makeSnapshot(0.85)]);
    expect(summary.strengths.length).toBeGreaterThan(0);
    expect(summary.overall).toContain("high");
  });

  it("identifies weaknesses for low-gradient agent", () => {
    const summary = summarizeGradientHistory([makeSnapshot(0.15)]);
    expect(summary.weaknesses.length).toBeGreaterThan(0);
    expect(summary.overall).toContain("low");
  });

  it("describes rising trajectory across multiple snapshots", () => {
    const now = Date.now();
    const snapshots = [
      makeSnapshot(0.7, 0.05, now),
      makeSnapshot(0.6, 0.05, now - 3600000),
      makeSnapshot(0.5, 0.05, now - 7200000),
      makeSnapshot(0.4, 0, now - 10800000),
    ];
    const summary = summarizeGradientHistory(snapshots);
    expect(summary.trajectory).toContain("rising");
    expect(summary.trajectory).toContain("accumulating better models");
    expect(summary.delta).toBe(0.05);
  });

  it("describes declining trajectory", () => {
    const now = Date.now();
    const snapshots = [
      makeSnapshot(0.3, -0.1, now),
      makeSnapshot(0.5, -0.1, now - 3600000),
      makeSnapshot(0.7, 0, now - 7200000),
    ];
    const summary = summarizeGradientHistory(snapshots);
    expect(summary.trajectory).toContain("declining");
    expect(summary.trajectory).toContain("eroding");
  });

  it("describes stable trajectory when delta is near zero", () => {
    const now = Date.now();
    const snapshots = [
      makeSnapshot(0.5, 0.001, now),
      makeSnapshot(0.5, -0.001, now - 3600000),
      makeSnapshot(0.5, 0, now - 7200000),
    ];
    const summary = summarizeGradientHistory(snapshots);
    expect(summary.trajectory).toContain("Stable");
  });

  it("describes exploiting posture for high self-trust", () => {
    const summary = summarizeGradientHistory([makeSnapshot(0.9)]);
    expect(summary.posture).toContain("Exploit");
  });

  it("describes exploring posture for low self-trust", () => {
    const summary = summarizeGradientHistory([makeSnapshot(0.1)]);
    expect(summary.posture).toContain("Explor");
  });

  it("describes balanced posture for moderate gradient", () => {
    const summary = summarizeGradientHistory([makeSnapshot(0.5)]);
    expect(summary.posture).toContain("Balanced");
  });
});

// ── gradientToMarketConfig (closed-loop feedback) ──

describe("gradientToMarketConfig", () => {
  function makeDetailedSnapshot(overrides: Partial<GradientSnapshot> = {}): GradientSnapshot {
    return {
      motebit_id: "test",
      timestamp: Date.now(),
      gradient: 0.5,
      delta: 0,
      knowledge_density: 0.5,
      knowledge_density_raw: 0.5,
      knowledge_quality: 0.5,
      graph_connectivity: 0.5,
      graph_connectivity_raw: 0.5,
      temporal_stability: 0.5,
      retrieval_quality: 0.5,
      interaction_efficiency: 0.5,
      tool_efficiency: 0.5,
      curiosity_pressure: 0.5,
      stats: {
        live_nodes: 10,
        live_edges: 5,
        semantic_count: 7,
        episodic_count: 3,
        pinned_count: 1,
        avg_confidence: 0.8,
        avg_half_life: 604800000,
        consolidation_add: 0,
        consolidation_update: 0,
        consolidation_reinforce: 0,
        consolidation_noop: 0,
        total_confidence_mass: 8,
        avg_retrieval_score: 0.7,
        retrieval_count: 5,
        avg_iterations_per_turn: 2,
        total_turns: 5,
        tool_calls_succeeded: 8,
        tool_calls_blocked: 1,
        tool_calls_failed: 1,
        curiosity_target_count: 3,
        avg_curiosity_score: 0.5,
      },
      ...overrides,
    };
  }

  it("returns all market config weights", () => {
    const cfg = gradientToMarketConfig(makeDetailedSnapshot());
    expect(cfg.weight_trust).toBeDefined();
    expect(cfg.weight_success_rate).toBeDefined();
    expect(cfg.weight_latency).toBeDefined();
    expect(cfg.weight_price_efficiency).toBeDefined();
    expect(cfg.weight_capability_match).toBeDefined();
    expect(cfg.weight_availability).toBeDefined();
    expect(cfg.exploration_weight).toBeDefined();
  });

  it("high gradient (exploit) keeps trust/success_rate weights high", () => {
    const cfg = gradientToMarketConfig(makeDetailedSnapshot({ gradient: 0.9 }));
    // High gradient → high self-trust → low exploration → weights near defaults
    expect(cfg.weight_trust!).toBeGreaterThan(0.2);
    expect(cfg.weight_success_rate!).toBeGreaterThan(0.2);
    expect(cfg.exploration_weight!).toBeLessThan(0.3);
  });

  it("low gradient (explore) shifts weight toward availability/capability", () => {
    const cfg = gradientToMarketConfig(makeDetailedSnapshot({ gradient: 0.1 }));
    // Low gradient → low self-trust → high exploration
    expect(cfg.weight_availability!).toBeGreaterThan(0.1);
    expect(cfg.weight_capability_match!).toBeGreaterThan(0.1);
    expect(cfg.exploration_weight!).toBeGreaterThan(0.7);
  });

  it("low tool_efficiency boosts weight_trust", () => {
    const baseline = gradientToMarketConfig(makeDetailedSnapshot({ tool_efficiency: 0.8 }));
    const weak = gradientToMarketConfig(makeDetailedSnapshot({ tool_efficiency: 0.1 }));
    // Low tool efficiency → prefer trusted agents
    expect(weak.weight_trust!).toBeGreaterThan(baseline.weight_trust!);
  });

  it("low retrieval_quality boosts weight_capability_match", () => {
    const baseline = gradientToMarketConfig(makeDetailedSnapshot({ retrieval_quality: 0.8 }));
    const weak = gradientToMarketConfig(makeDetailedSnapshot({ retrieval_quality: 0.1 }));
    expect(weak.weight_capability_match!).toBeGreaterThan(baseline.weight_capability_match!);
  });

  it("low interaction_efficiency boosts weight_latency", () => {
    const baseline = gradientToMarketConfig(makeDetailedSnapshot({ interaction_efficiency: 0.8 }));
    const weak = gradientToMarketConfig(makeDetailedSnapshot({ interaction_efficiency: 0.1 }));
    expect(weak.weight_latency!).toBeGreaterThan(baseline.weight_latency!);
  });

  it("metric-specific shifts are bounded (max 0.05 each)", () => {
    // Worst case: all metrics at 0
    const worst = gradientToMarketConfig(
      makeDetailedSnapshot({
        tool_efficiency: 0,
        retrieval_quality: 0,
        interaction_efficiency: 0,
      }),
    );
    const neutral = gradientToMarketConfig(
      makeDetailedSnapshot({
        tool_efficiency: 0.5,
        retrieval_quality: 0.5,
        interaction_efficiency: 0.5,
      }),
    );
    // Each metric shift is ≤0.05
    expect(worst.weight_trust! - neutral.weight_trust!).toBeLessThanOrEqual(0.05 + 1e-10);
    expect(worst.weight_capability_match! - neutral.weight_capability_match!).toBeLessThanOrEqual(
      0.05 + 1e-10,
    );
    expect(worst.weight_latency! - neutral.weight_latency!).toBeLessThanOrEqual(0.05 + 1e-10);
  });

  it("declining gradient increases exploration", () => {
    const stable = gradientToMarketConfig(makeDetailedSnapshot({ gradient: 0.4, delta: 0 }));
    const declining = gradientToMarketConfig(makeDetailedSnapshot({ gradient: 0.4, delta: -0.1 }));
    expect(declining.exploration_weight!).toBeGreaterThan(stable.exploration_weight!);
  });

  it("respects base config overrides", () => {
    const cfg = gradientToMarketConfig(makeDetailedSnapshot(), {
      max_candidates: 5,
      settlement_timeout_ms: 10_000,
    });
    expect(cfg.max_candidates).toBe(5);
    expect(cfg.settlement_timeout_ms).toBe(10_000);
  });
});

// ── buildPrecisionContext (system prompt modulation) ──

describe("buildPrecisionContext", () => {
  it("low selfTrust produces cautious context", () => {
    const ctx = buildPrecisionContext({
      selfTrust: 0.2,
      explorationDrive: 0.8,
      retrievalPrecision: 0.42,
      curiosityModulation: 0.7,
    });
    expect(ctx).toContain("Active Inference Posture");
    expect(ctx).toContain("currently low");
    expect(ctx).toContain("clarifying questions");
    expect(ctx).toContain("verify");
  });

  it("high selfTrust produces confident context", () => {
    const ctx = buildPrecisionContext({
      selfTrust: 0.85,
      explorationDrive: 0.15,
      retrievalPrecision: 0.81,
      curiosityModulation: 0.15,
    });
    expect(ctx).toContain("Active Inference Posture");
    expect(ctx).toContain("high");
    expect(ctx).toContain("decisively");
    expect(ctx).toContain("autonomy");
  });

  it("moderate selfTrust produces balanced context", () => {
    const ctx = buildPrecisionContext({
      selfTrust: 0.55,
      explorationDrive: 0.45,
      retrievalPrecision: 0.63,
      curiosityModulation: 0.4,
    });
    expect(ctx).toContain("moderate");
    expect(ctx).toContain("Balance");
  });

  it("high explorationDrive encourages trying different approaches", () => {
    const ctx = buildPrecisionContext({
      selfTrust: 0.3,
      explorationDrive: 0.75,
      retrievalPrecision: 0.48,
      curiosityModulation: 0.7,
    });
    expect(ctx).toContain("exploration drive is elevated");
    expect(ctx).toContain("different approaches");
    expect(ctx).toContain("alternative tools");
  });

  it("low explorationDrive encourages proven methods", () => {
    const ctx = buildPrecisionContext({
      selfTrust: 0.8,
      explorationDrive: 0.2,
      retrievalPrecision: 0.78,
      curiosityModulation: 0.2,
    });
    expect(ctx).toContain("proven methods");
    expect(ctx).toContain("familiar tools");
  });

  it("neutral precision produces non-empty balanced context", () => {
    const ctx = buildPrecisionContext(NEUTRAL_PRECISION);
    expect(ctx).toContain("Active Inference Posture");
    expect(ctx).toContain("moderate");
  });

  it("returns empty string when no specific tier is triggered", () => {
    // With selfTrust=0.5 and explorationDrive=0.5, the moderate tier fires but exploration doesn't
    const ctx = buildPrecisionContext({
      selfTrust: 0.5,
      explorationDrive: 0.5,
      retrievalPrecision: 0.6,
      curiosityModulation: 0.5,
    });
    // selfTrust 0.5 triggers moderate tier, so context should be non-empty
    expect(ctx).toContain("moderate");
  });

  it("low selfTrust context differs from high selfTrust context", () => {
    const low = buildPrecisionContext({
      selfTrust: 0.2,
      explorationDrive: 0.8,
      retrievalPrecision: 0.42,
      curiosityModulation: 0.7,
    });
    const high = buildPrecisionContext({
      selfTrust: 0.85,
      explorationDrive: 0.15,
      retrievalPrecision: 0.81,
      curiosityModulation: 0.15,
    });
    expect(low).not.toBe(high);
    // Low context should NOT contain "decisively"
    expect(low).not.toContain("decisively");
    // High context should NOT contain "clarifying questions"
    expect(high).not.toContain("clarifying questions");
  });

  it("explorationDrive modulates independently of selfTrust tier", () => {
    // Moderate self-trust but high exploration
    const ctx = buildPrecisionContext({
      selfTrust: 0.55,
      explorationDrive: 0.75,
      retrievalPrecision: 0.63,
      curiosityModulation: 0.6,
    });
    expect(ctx).toContain("moderate"); // from selfTrust
    expect(ctx).toContain("exploration drive is elevated"); // from explorationDrive
  });
});
