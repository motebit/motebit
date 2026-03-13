/**
 * Gradient Trending Integration Test
 *
 * Simulates an agent's lifecycle over multiple housekeeping cycles and asserts
 * the intelligence gradient trends upward as the agent accumulates knowledge,
 * reinforces memories, builds graph connections, and improves behavioral metrics.
 *
 * Uses computeGradient() directly — pure function, no runtime needed.
 */

import { describe, it, expect } from "vitest";
import { computeGradient, computePrecision } from "../gradient.js";
import type { GradientSnapshot, BehavioralStats } from "../gradient.js";
import type { MemoryNode, MemoryEdge, EventLogEntry } from "@motebit/sdk";
import { EventType, SensitivityLevel, MemoryType, RelationType } from "@motebit/sdk";

const HALF_LIFE_7D = 7 * 24 * 60 * 60 * 1000;
const HALF_LIFE_14D = 14 * 24 * 60 * 60 * 1000;
const HALF_LIFE_30D = 30 * 24 * 60 * 60 * 1000;

const MOTEBIT_ID = "trending-test-motebit";

let nodeCounter = 0;

function makeNode(overrides: Partial<MemoryNode> = {}): MemoryNode {
  nodeCounter++;
  return {
    node_id: `node-${nodeCounter}`,
    motebit_id: MOTEBIT_ID,
    content: `memory content ${nodeCounter}`,
    embedding: [0.1, 0.2],
    confidence: 0.7,
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

function makeEdge(sourceId: string, targetId: string): MemoryEdge {
  return {
    edge_id: `edge-${sourceId}-${targetId}`,
    source_id: sourceId,
    target_id: targetId,
    relation_type: RelationType.Related,
    weight: 1.0,
    confidence: 0.8,
  };
}

function makeConsolidationEvent(action: string): EventLogEntry {
  return {
    event_id: crypto.randomUUID(),
    motebit_id: MOTEBIT_ID,
    timestamp: Date.now(),
    event_type: EventType.MemoryConsolidated,
    payload: { action },
    version_clock: 1,
    tombstoned: false,
  };
}

describe("gradient trending upward over agent lifecycle", () => {
  it("composite gradient increases monotonically over 5 housekeeping cycles", () => {
    // Reset counter
    nodeCounter = 0;

    const snapshots: GradientSnapshot[] = [];

    // Accumulate state across cycles — each cycle adds to the previous
    let allNodes: MemoryNode[] = [];
    let allEdges: MemoryEdge[] = [];
    let allEvents: EventLogEntry[] = [];

    // ── Cycle 1: Fresh agent, sparse state ──
    // Few memories, no edges, all ADDs (brand new), poor behavioral stats
    const c1Nodes = [
      makeNode({ confidence: 0.5, half_life: HALF_LIFE_7D }),
      makeNode({ confidence: 0.4, half_life: HALF_LIFE_7D, memory_type: MemoryType.Episodic }),
    ];
    allNodes = [...allNodes, ...c1Nodes];
    allEvents = [...allEvents, makeConsolidationEvent("ADD"), makeConsolidationEvent("ADD")];
    const c1Behavioral: BehavioralStats = {
      turnCount: 2,
      totalIterations: 14, // avg 7 iterations — inefficient
      toolCallsSucceeded: 2,
      toolCallsBlocked: 2,
      toolCallsFailed: 1,
    };

    const s1 = computeGradient(
      MOTEBIT_ID,
      allNodes,
      allEdges,
      allEvents,
      null,
      undefined,
      { avgScore: 0.2, count: 2 },
      c1Behavioral,
      { avgScore: 1.5, count: 2 }, // high curiosity pressure = low cp score
    );
    snapshots.push(s1);

    // ── Cycle 2: Early learning ──
    // More memories, first edges, some REINFORCEs, slightly better behavior
    const c2Nodes = [
      makeNode({ confidence: 0.6, half_life: HALF_LIFE_7D }),
      makeNode({ confidence: 0.7, half_life: HALF_LIFE_14D, pinned: true }),
      makeNode({ confidence: 0.5, half_life: HALF_LIFE_7D }),
    ];
    allNodes = [...allNodes, ...c2Nodes];
    allEdges = [
      ...allEdges,
      makeEdge(c1Nodes[0]!.node_id, c2Nodes[0]!.node_id),
      makeEdge(c2Nodes[0]!.node_id, c2Nodes[1]!.node_id),
    ];
    allEvents = [
      ...allEvents,
      makeConsolidationEvent("REINFORCE"),
      makeConsolidationEvent("ADD"),
      makeConsolidationEvent("UPDATE"),
    ];
    const c2Behavioral: BehavioralStats = {
      turnCount: 4,
      totalIterations: 16, // avg 4 iterations — improving
      toolCallsSucceeded: 6,
      toolCallsBlocked: 1,
      toolCallsFailed: 1,
    };

    const s2 = computeGradient(
      MOTEBIT_ID,
      allNodes,
      allEdges,
      allEvents,
      s1.gradient,
      undefined,
      { avgScore: 0.4, count: 5 },
      c2Behavioral,
      { avgScore: 1.0, count: 3 }, // curiosity pressure easing
    );
    snapshots.push(s2);

    // ── Cycle 3: Building competence ──
    // More semantic memories with longer half-lives, denser graph, more REINFORCE
    const c3Nodes = [
      makeNode({ confidence: 0.8, half_life: HALF_LIFE_14D, pinned: true }),
      makeNode({ confidence: 0.75, half_life: HALF_LIFE_14D }),
      makeNode({ confidence: 0.7, half_life: HALF_LIFE_14D }),
      makeNode({ confidence: 0.65, half_life: HALF_LIFE_7D }),
    ];
    allNodes = [...allNodes, ...c3Nodes];
    allEdges = [
      ...allEdges,
      makeEdge(c2Nodes[1]!.node_id, c3Nodes[0]!.node_id),
      makeEdge(c3Nodes[0]!.node_id, c3Nodes[1]!.node_id),
      makeEdge(c3Nodes[1]!.node_id, c3Nodes[2]!.node_id),
      makeEdge(c1Nodes[0]!.node_id, c3Nodes[2]!.node_id),
    ];
    allEvents = [
      ...allEvents,
      makeConsolidationEvent("REINFORCE"),
      makeConsolidationEvent("REINFORCE"),
      makeConsolidationEvent("UPDATE"),
      makeConsolidationEvent("ADD"),
    ];
    const c3Behavioral: BehavioralStats = {
      turnCount: 6,
      totalIterations: 14, // avg ~2.3 — getting efficient
      toolCallsSucceeded: 12,
      toolCallsBlocked: 1,
      toolCallsFailed: 0,
    };

    const s3 = computeGradient(
      MOTEBIT_ID,
      allNodes,
      allEdges,
      allEvents,
      s2.gradient,
      undefined,
      { avgScore: 0.55, count: 10 },
      c3Behavioral,
      { avgScore: 0.6, count: 4 }, // curiosity pressure low — knowledge well-maintained
    );
    snapshots.push(s3);

    // ── Cycle 4: Maturing agent ──
    // High confidence memories, long half-lives, dense graph, mostly REINFORCE
    const c4Nodes = [
      makeNode({ confidence: 0.9, half_life: HALF_LIFE_30D, pinned: true }),
      makeNode({ confidence: 0.85, half_life: HALF_LIFE_30D }),
      makeNode({ confidence: 0.8, half_life: HALF_LIFE_14D }),
      makeNode({ confidence: 0.75, half_life: HALF_LIFE_14D }),
      makeNode({ confidence: 0.8, half_life: HALF_LIFE_30D, pinned: true }),
    ];
    allNodes = [...allNodes, ...c4Nodes];
    allEdges = [
      ...allEdges,
      makeEdge(c3Nodes[0]!.node_id, c4Nodes[0]!.node_id),
      makeEdge(c3Nodes[2]!.node_id, c4Nodes[1]!.node_id),
      makeEdge(c4Nodes[0]!.node_id, c4Nodes[1]!.node_id),
      makeEdge(c4Nodes[1]!.node_id, c4Nodes[2]!.node_id),
      makeEdge(c4Nodes[2]!.node_id, c4Nodes[3]!.node_id),
      makeEdge(c4Nodes[3]!.node_id, c4Nodes[4]!.node_id),
      makeEdge(c2Nodes[0]!.node_id, c4Nodes[3]!.node_id),
    ];
    allEvents = [
      ...allEvents,
      makeConsolidationEvent("REINFORCE"),
      makeConsolidationEvent("REINFORCE"),
      makeConsolidationEvent("REINFORCE"),
      makeConsolidationEvent("UPDATE"),
      makeConsolidationEvent("REINFORCE"),
    ];
    const c4Behavioral: BehavioralStats = {
      turnCount: 10,
      totalIterations: 15, // avg 1.5 — very efficient
      toolCallsSucceeded: 22,
      toolCallsBlocked: 0,
      toolCallsFailed: 1,
    };

    const s4 = computeGradient(
      MOTEBIT_ID,
      allNodes,
      allEdges,
      allEvents,
      s3.gradient,
      undefined,
      { avgScore: 0.72, count: 18 },
      c4Behavioral,
      { avgScore: 0.3, count: 5 }, // low curiosity pressure — well-maintained
    );
    snapshots.push(s4);

    // ── Cycle 5: Expert agent ──
    // Lots of high-confidence, long-lived, pinned semantic memories. Dense graph.
    // Almost all REINFORCE. Excellent behavioral stats. High retrieval quality.
    const c5Nodes = [
      makeNode({ confidence: 0.95, half_life: HALF_LIFE_30D, pinned: true }),
      makeNode({ confidence: 0.9, half_life: HALF_LIFE_30D, pinned: true }),
      makeNode({ confidence: 0.9, half_life: HALF_LIFE_30D }),
      makeNode({ confidence: 0.85, half_life: HALF_LIFE_30D }),
      makeNode({ confidence: 0.88, half_life: HALF_LIFE_30D, pinned: true }),
      makeNode({ confidence: 0.92, half_life: HALF_LIFE_30D }),
    ];
    allNodes = [...allNodes, ...c5Nodes];
    allEdges = [
      ...allEdges,
      makeEdge(c4Nodes[0]!.node_id, c5Nodes[0]!.node_id),
      makeEdge(c4Nodes[4]!.node_id, c5Nodes[1]!.node_id),
      makeEdge(c5Nodes[0]!.node_id, c5Nodes[1]!.node_id),
      makeEdge(c5Nodes[1]!.node_id, c5Nodes[2]!.node_id),
      makeEdge(c5Nodes[2]!.node_id, c5Nodes[3]!.node_id),
      makeEdge(c5Nodes[3]!.node_id, c5Nodes[4]!.node_id),
      makeEdge(c5Nodes[4]!.node_id, c5Nodes[5]!.node_id),
      makeEdge(c5Nodes[5]!.node_id, c5Nodes[0]!.node_id), // cycle in graph
      makeEdge(c3Nodes[1]!.node_id, c5Nodes[2]!.node_id), // cross-cycle link
      makeEdge(c1Nodes[0]!.node_id, c5Nodes[4]!.node_id), // long-range link
    ];
    allEvents = [
      ...allEvents,
      makeConsolidationEvent("REINFORCE"),
      makeConsolidationEvent("REINFORCE"),
      makeConsolidationEvent("REINFORCE"),
      makeConsolidationEvent("REINFORCE"),
      makeConsolidationEvent("REINFORCE"),
      makeConsolidationEvent("UPDATE"),
    ];
    const c5Behavioral: BehavioralStats = {
      turnCount: 15,
      totalIterations: 18, // avg 1.2 — near-optimal
      toolCallsSucceeded: 35,
      toolCallsBlocked: 0,
      toolCallsFailed: 0,
    };

    const s5 = computeGradient(
      MOTEBIT_ID,
      allNodes,
      allEdges,
      allEvents,
      s4.gradient,
      undefined,
      { avgScore: 0.85, count: 30 },
      c5Behavioral,
      { avgScore: 0.15, count: 6 }, // very low curiosity pressure
    );
    snapshots.push(s5);

    // ── Assertions ──

    // 1. Monotonically increasing composite gradient
    for (let i = 1; i < snapshots.length; i++) {
      expect(
        snapshots[i]!.gradient,
        `cycle ${i + 1} gradient (${snapshots[i]!.gradient.toFixed(4)}) should be >= cycle ${i} (${snapshots[i - 1]!.gradient.toFixed(4)})`,
      ).toBeGreaterThanOrEqual(snapshots[i - 1]!.gradient);
    }

    // 2. Meaningful total improvement (at least 0.15)
    const totalImprovement = s5.gradient - s1.gradient;
    expect(
      totalImprovement,
      `total improvement ${totalImprovement.toFixed(4)} should be >= 0.15`,
    ).toBeGreaterThanOrEqual(0.15);

    // 3. At least 5 of 8 sub-metrics improved from cycle 1 to cycle 5
    const subMetricKeys = [
      "knowledge_density",
      "knowledge_quality",
      "graph_connectivity",
      "temporal_stability",
      "retrieval_quality",
      "interaction_efficiency",
      "tool_efficiency",
      "curiosity_pressure",
    ] as const;

    let improvedCount = 0;
    for (const key of subMetricKeys) {
      if (s5[key] > s1[key]) {
        improvedCount++;
      }
    }
    expect(
      improvedCount,
      `${improvedCount} sub-metrics improved, need at least 5`,
    ).toBeGreaterThanOrEqual(5);

    // 4. Positive delta on every cycle after the first
    for (let i = 1; i < snapshots.length; i++) {
      expect(snapshots[i]!.delta, `cycle ${i + 1} delta should be positive`).toBeGreaterThan(0);
    }
  });

  it("knowledge density grows as memories accumulate", () => {
    nodeCounter = 0;

    // Cycle 1: 3 nodes
    const fewNodes = [
      makeNode({ confidence: 0.5 }),
      makeNode({ confidence: 0.6 }),
      makeNode({ confidence: 0.4 }),
    ];
    const s1 = computeGradient(MOTEBIT_ID, fewNodes, [], [], null);

    // Cycle 2: 15 nodes with higher confidence
    const manyNodes = [...fewNodes];
    for (let i = 0; i < 12; i++) {
      manyNodes.push(makeNode({ confidence: 0.7 + Math.random() * 0.3 }));
    }
    const s2 = computeGradient(MOTEBIT_ID, manyNodes, [], [], s1.gradient);

    // Cycle 3: 40 nodes
    for (let i = 0; i < 25; i++) {
      manyNodes.push(makeNode({ confidence: 0.8 + Math.random() * 0.2 }));
    }
    const s3 = computeGradient(MOTEBIT_ID, manyNodes, [], [], s2.gradient);

    expect(s2.knowledge_density).toBeGreaterThan(s1.knowledge_density);
    expect(s3.knowledge_density).toBeGreaterThan(s2.knowledge_density);
    // Approaches but never exceeds 1.0 due to x/(x+50) normalization
    expect(s3.knowledge_density).toBeLessThan(1.0);
  });

  it("knowledge quality shifts from ADD-dominated to REINFORCE-dominated", () => {
    // Early: all ADDs
    const earlyEvents = [
      makeConsolidationEvent("ADD"),
      makeConsolidationEvent("ADD"),
      makeConsolidationEvent("ADD"),
      makeConsolidationEvent("ADD"),
    ];
    const s1 = computeGradient(MOTEBIT_ID, [], [], earlyEvents, null);

    // Middle: mixed
    const midEvents = [
      ...earlyEvents,
      makeConsolidationEvent("REINFORCE"),
      makeConsolidationEvent("UPDATE"),
      makeConsolidationEvent("ADD"),
      makeConsolidationEvent("REINFORCE"),
    ];
    const s2 = computeGradient(MOTEBIT_ID, [], [], midEvents, s1.gradient);

    // Late: mostly REINFORCE
    const lateEvents = [
      ...midEvents,
      makeConsolidationEvent("REINFORCE"),
      makeConsolidationEvent("REINFORCE"),
      makeConsolidationEvent("REINFORCE"),
      makeConsolidationEvent("REINFORCE"),
      makeConsolidationEvent("UPDATE"),
      makeConsolidationEvent("REINFORCE"),
    ];
    const s3 = computeGradient(MOTEBIT_ID, [], [], lateEvents, s2.gradient);

    expect(s1.knowledge_quality).toBe(0); // all ADDs
    expect(s2.knowledge_quality).toBeGreaterThan(s1.knowledge_quality);
    expect(s3.knowledge_quality).toBeGreaterThan(s2.knowledge_quality);
  });

  it("graph connectivity grows as edges are added between nodes", () => {
    nodeCounter = 0;
    const nodes = [makeNode(), makeNode(), makeNode(), makeNode(), makeNode()];

    // Sparse: no edges
    const s1 = computeGradient(MOTEBIT_ID, nodes, [], [], null);

    // Some edges: 3 edges / 5 nodes = 0.6 ratio
    const edges1 = [
      makeEdge(nodes[0]!.node_id, nodes[1]!.node_id),
      makeEdge(nodes[1]!.node_id, nodes[2]!.node_id),
      makeEdge(nodes[2]!.node_id, nodes[3]!.node_id),
    ];
    const s2 = computeGradient(MOTEBIT_ID, nodes, edges1, [], s1.gradient);

    // Dense: 8 edges / 5 nodes = 1.6 ratio
    const edges2 = [
      ...edges1,
      makeEdge(nodes[3]!.node_id, nodes[4]!.node_id),
      makeEdge(nodes[4]!.node_id, nodes[0]!.node_id),
      makeEdge(nodes[0]!.node_id, nodes[2]!.node_id),
      makeEdge(nodes[1]!.node_id, nodes[3]!.node_id),
      makeEdge(nodes[2]!.node_id, nodes[4]!.node_id),
    ];
    const s3 = computeGradient(MOTEBIT_ID, nodes, edges2, [], s2.gradient);

    expect(s1.graph_connectivity).toBe(0);
    expect(s2.graph_connectivity).toBeGreaterThan(s1.graph_connectivity);
    expect(s3.graph_connectivity).toBeGreaterThan(s2.graph_connectivity);
  });

  it("temporal stability improves as memories shift to semantic with longer half-lives", () => {
    nodeCounter = 0;

    // Early: all episodic, short half-life
    const earlyNodes = [
      makeNode({ memory_type: MemoryType.Episodic, half_life: HALF_LIFE_7D }),
      makeNode({ memory_type: MemoryType.Episodic, half_life: HALF_LIFE_7D }),
    ];
    const s1 = computeGradient(MOTEBIT_ID, earlyNodes, [], [], null);

    // Middle: mix of semantic and episodic, some pinned, medium half-lives
    const midNodes = [
      ...earlyNodes,
      makeNode({ memory_type: MemoryType.Semantic, half_life: HALF_LIFE_14D, pinned: true }),
      makeNode({ memory_type: MemoryType.Semantic, half_life: HALF_LIFE_14D }),
    ];
    const s2 = computeGradient(MOTEBIT_ID, midNodes, [], [], s1.gradient);

    // Late: mostly semantic, long half-lives, many pinned
    const lateNodes = [
      ...midNodes,
      makeNode({ memory_type: MemoryType.Semantic, half_life: HALF_LIFE_30D, pinned: true }),
      makeNode({ memory_type: MemoryType.Semantic, half_life: HALF_LIFE_30D, pinned: true }),
      makeNode({ memory_type: MemoryType.Semantic, half_life: HALF_LIFE_30D }),
      makeNode({ memory_type: MemoryType.Semantic, half_life: HALF_LIFE_30D }),
    ];
    const s3 = computeGradient(MOTEBIT_ID, lateNodes, [], [], s2.gradient);

    expect(s2.temporal_stability).toBeGreaterThan(s1.temporal_stability);
    expect(s3.temporal_stability).toBeGreaterThan(s2.temporal_stability);
  });

  it("behavioral metrics improve as agent becomes more efficient", () => {
    // Cycle 1: inefficient — many iterations, many failures
    const bad: BehavioralStats = {
      turnCount: 3,
      totalIterations: 24, // avg 8
      toolCallsSucceeded: 3,
      toolCallsBlocked: 4,
      toolCallsFailed: 3,
    };
    const s1 = computeGradient(MOTEBIT_ID, [], [], [], null, undefined, undefined, bad);

    // Cycle 2: moderate
    const mid: BehavioralStats = {
      turnCount: 5,
      totalIterations: 15, // avg 3
      toolCallsSucceeded: 10,
      toolCallsBlocked: 2,
      toolCallsFailed: 1,
    };
    const s2 = computeGradient(MOTEBIT_ID, [], [], [], s1.gradient, undefined, undefined, mid);

    // Cycle 3: efficient — near single-iteration, all succeed
    const good: BehavioralStats = {
      turnCount: 10,
      totalIterations: 12, // avg 1.2
      toolCallsSucceeded: 20,
      toolCallsBlocked: 0,
      toolCallsFailed: 0,
    };
    const s3 = computeGradient(MOTEBIT_ID, [], [], [], s2.gradient, undefined, undefined, good);

    expect(s2.interaction_efficiency).toBeGreaterThan(s1.interaction_efficiency);
    expect(s3.interaction_efficiency).toBeGreaterThan(s2.interaction_efficiency);
    expect(s2.tool_efficiency).toBeGreaterThan(s1.tool_efficiency);
    expect(s3.tool_efficiency).toBeGreaterThan(s2.tool_efficiency);
  });

  it("precision feedback loop tracks gradient improvement", () => {
    nodeCounter = 0;

    // Low gradient → high exploration, low self-trust
    const s1 = computeGradient(MOTEBIT_ID, [], [], [], null);
    // s1.gradient ≈ 0.175 (defaults)

    // Build up to higher gradient
    const nodes: MemoryNode[] = [];
    const edges: MemoryEdge[] = [];
    for (let i = 0; i < 30; i++) {
      nodes.push(
        makeNode({
          confidence: 0.85,
          half_life: HALF_LIFE_30D,
          pinned: i % 3 === 0,
        }),
      );
    }
    for (let i = 0; i < nodes.length - 1; i++) {
      edges.push(makeEdge(nodes[i]!.node_id, nodes[i + 1]!.node_id));
    }
    const events = Array.from({ length: 15 }, () => makeConsolidationEvent("REINFORCE"));
    const behavioral: BehavioralStats = {
      turnCount: 10,
      totalIterations: 12,
      toolCallsSucceeded: 25,
      toolCallsBlocked: 0,
      toolCallsFailed: 0,
    };

    const s2 = computeGradient(
      MOTEBIT_ID,
      nodes,
      edges,
      events,
      s1.gradient,
      undefined,
      { avgScore: 0.8, count: 20 },
      behavioral,
      { avgScore: 0.2, count: 5 },
    );

    const p1 = computePrecision(s1);
    const p2 = computePrecision(s2);

    // As gradient improves, self-trust should increase and exploration should decrease
    expect(p2.selfTrust).toBeGreaterThan(p1.selfTrust);
    expect(p2.explorationDrive).toBeLessThan(p1.explorationDrive);
    expect(p2.retrievalPrecision).toBeGreaterThan(p1.retrievalPrecision);
  });
});
