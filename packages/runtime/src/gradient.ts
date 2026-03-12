/**
 * Intelligence Gradient — measures how a motebit gets smarter over time.
 *
 * Eight sub-metrics, one composite score. Pure aggregation over existing data —
 * no new LLM calls, no new embeddings.
 *
 * Sub-metrics:
 *   kd  Knowledge Density      — sum of decayed confidence, normalized via x/(x+50)
 *   kq  Knowledge Quality      — (reinforce + update) / total consolidation events in 7-day window
 *   gc  Graph Connectivity     — edges/nodes ratio, normalized via x/(x+2)
 *   ts  Temporal Stability     — weighted mix of semantic ratio, pinned ratio, avg half-life
 *   rq  Retrieval Quality      — avg cosine similarity of memory retrievals since last housekeeping
 *   ie  Interaction Efficiency — fewer loop iterations per turn = more efficient
 *   te  Tool Efficiency        — ratio of succeeded tool calls to total tool calls
 *   cp  Curiosity Pressure     — avg curiosity score of top targets (internal self-trust signal)
 *
 * Composite: gradient = kd*0.15 + kq*0.17 + gc*0.08 + ts*0.10 + rq*0.15 + ie*0.12 + te*0.10 + cp*0.13
 */

import { MemoryType } from "@motebit/sdk";
import type { MemoryNode, MemoryEdge, EventLogEntry } from "@motebit/sdk";
import { computeDecayedConfidence } from "@motebit/memory-graph";

/** Must match MAX_TOOL_ITERATIONS in @motebit/ai-core loop.ts */
const MAX_TOOL_ITERATIONS = 10;

// === Types ===

export interface GradientSnapshot {
  motebit_id: string;
  timestamp: number;
  gradient: number;
  delta: number;
  knowledge_density: number;
  knowledge_density_raw: number;
  knowledge_quality: number;
  graph_connectivity: number;
  graph_connectivity_raw: number;
  temporal_stability: number;
  retrieval_quality: number;
  interaction_efficiency: number;
  tool_efficiency: number;
  curiosity_pressure: number;
  stats: {
    live_nodes: number;
    live_edges: number;
    semantic_count: number;
    episodic_count: number;
    pinned_count: number;
    avg_confidence: number;
    avg_half_life: number;
    consolidation_add: number;
    consolidation_update: number;
    consolidation_reinforce: number;
    consolidation_noop: number;
    total_confidence_mass: number;
    avg_retrieval_score: number;
    retrieval_count: number;
    avg_iterations_per_turn: number;
    total_turns: number;
    tool_calls_succeeded: number;
    tool_calls_blocked: number;
    tool_calls_failed: number;
    curiosity_target_count: number;
    avg_curiosity_score: number;
  };
}

export interface GradientStoreAdapter {
  save(snapshot: GradientSnapshot): void;
  latest(motebitId: string): GradientSnapshot | null;
  list(motebitId: string, limit?: number): GradientSnapshot[];
}

export interface BehavioralStats {
  turnCount: number;
  totalIterations: number;
  toolCallsSucceeded: number;
  toolCallsBlocked: number;
  toolCallsFailed: number;
}

export interface GradientConfig {
  /** Weight for knowledge density (default 0.15) */
  weight_kd: number;
  /** Weight for knowledge quality (default 0.20) */
  weight_kq: number;
  /** Weight for graph connectivity (default 0.10) */
  weight_gc: number;
  /** Weight for temporal stability (default 0.15) */
  weight_ts: number;
  /** Weight for retrieval quality (default 0.15) */
  weight_rq: number;
  /** Weight for interaction efficiency (default 0.15) */
  weight_ie: number;
  /** Weight for tool efficiency (default 0.10) */
  weight_te: number;
  /** Weight for curiosity pressure (default 0.13) */
  weight_cp: number;
  /** Normalization constant for knowledge density: x/(x+K) (default 50) */
  kd_norm_k: number;
  /** Normalization constant for graph connectivity: x/(x+K) (default 2) */
  gc_norm_k: number;
}

const DEFAULT_CONFIG: GradientConfig = {
  weight_kd: 0.15,
  weight_kq: 0.17,
  weight_gc: 0.08,
  weight_ts: 0.10,
  weight_rq: 0.15,
  weight_ie: 0.12,
  weight_te: 0.10,
  weight_cp: 0.13,
  kd_norm_k: 50,
  gc_norm_k: 2,
};

// === Consolidation Event Parsing ===

type ConsolidationAction = "ADD" | "UPDATE" | "REINFORCE" | "NOOP";

function extractConsolidationAction(event: EventLogEntry): ConsolidationAction | null {
  const payload = event.payload;
  if (payload.action != null) {
    const action = String(payload.action as string).toUpperCase();
    if (action === "ADD" || action === "UPDATE" || action === "REINFORCE" || action === "NOOP") {
      return action;
    }
  }
  if (payload.consolidation_action != null) {
    const action = String(payload.consolidation_action as string).toUpperCase();
    if (action === "ADD" || action === "UPDATE" || action === "REINFORCE" || action === "NOOP") {
      return action;
    }
  }
  return null;
}

// === Pure Computation ===

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function computeGradient(
  motebitId: string,
  nodes: MemoryNode[],
  edges: MemoryEdge[],
  consolidationEvents: EventLogEntry[],
  previousGradient: number | null,
  config?: Partial<GradientConfig>,
  retrievalStats?: { avgScore: number; count: number },
  behavioralStats?: BehavioralStats,
  curiosityPressure?: { avgScore: number; count: number },
): GradientSnapshot {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const now = Date.now();

  // Filter to live (non-tombstoned) nodes
  const liveNodes = nodes.filter((n) => !n.tombstoned);
  const liveNodeIds = new Set(liveNodes.map((n) => n.node_id));
  const liveEdges = edges.filter(
    (e) => liveNodeIds.has(e.source_id) || liveNodeIds.has(e.target_id),
  );

  // === Knowledge Density (kd) ===
  let totalConfidenceMass = 0;
  let totalConfidence = 0;
  for (const node of liveNodes) {
    const elapsed = now - node.created_at;
    const decayed = computeDecayedConfidence(node.confidence, node.half_life, elapsed);
    totalConfidenceMass += decayed;
    totalConfidence += node.confidence;
  }
  const kdRaw = totalConfidenceMass;
  const kd = kdRaw / (kdRaw + cfg.kd_norm_k); // x/(x+50)

  // === Knowledge Quality (kq) ===
  let addCount = 0;
  let updateCount = 0;
  let reinforceCount = 0;
  let noopCount = 0;

  for (const event of consolidationEvents) {
    const action = extractConsolidationAction(event);
    if (action === "ADD") addCount++;
    else if (action === "UPDATE") updateCount++;
    else if (action === "REINFORCE") reinforceCount++;
    else if (action === "NOOP") noopCount++;
  }

  const totalConsolidation = addCount + updateCount + reinforceCount + noopCount;
  const kq = totalConsolidation > 0 ? (reinforceCount + updateCount) / totalConsolidation : 0;

  // === Graph Connectivity (gc) ===
  const nodeCount = liveNodes.length;
  const edgeCount = liveEdges.length;
  const gcRaw = nodeCount > 0 ? edgeCount / nodeCount : 0;
  const gc = gcRaw / (gcRaw + cfg.gc_norm_k); // x/(x+2)

  // === Temporal Stability (ts) ===
  let semanticCount = 0;
  let episodicCount = 0;
  let pinnedCount = 0;
  let totalHalfLife = 0;

  for (const node of liveNodes) {
    const memType = node.memory_type ?? MemoryType.Semantic;
    if (memType === MemoryType.Semantic) semanticCount++;
    else if (memType === MemoryType.Episodic) episodicCount++;
    if (node.pinned) pinnedCount++;
    totalHalfLife += node.half_life;
  }

  const totalTyped = semanticCount + episodicCount;
  const semanticRatio = totalTyped > 0 ? semanticCount / totalTyped : 0;
  const pinnedRatio = nodeCount > 0 ? pinnedCount / nodeCount : 0;
  const avgHalfLifeDays = nodeCount > 0 ? totalHalfLife / nodeCount / MS_PER_DAY : 0;
  const halfLifeScore = Math.min(avgHalfLifeDays / 30, 1);

  const ts = 0.6 * semanticRatio + 0.2 * pinnedRatio + 0.2 * halfLifeScore;

  // === Retrieval Quality (rq) ===
  const rq = retrievalStats?.avgScore ?? 0;

  // === Interaction Efficiency (ie) ===
  // 1.0 = always single-iteration, 0.0 = always hitting MAX_TOOL_ITERATIONS (10)
  let ie: number;
  if (behavioralStats && behavioralStats.turnCount > 0) {
    const avgIterations = behavioralStats.totalIterations / behavioralStats.turnCount;
    ie = 1 - (avgIterations - 1) / (MAX_TOOL_ITERATIONS - 1);
    ie = Math.max(0, Math.min(1, ie));
  } else {
    ie = 0.5;
  }

  // === Tool Efficiency (te) ===
  // Ratio of succeeded tool calls to total tool calls
  let te: number;
  if (behavioralStats) {
    const totalToolCalls =
      behavioralStats.toolCallsSucceeded +
      behavioralStats.toolCallsBlocked +
      behavioralStats.toolCallsFailed;
    if (totalToolCalls > 0) {
      te = behavioralStats.toolCallsSucceeded / totalToolCalls;
    } else {
      te = 0.5;
    }
  } else {
    te = 0.5;
  }

  // === Curiosity Pressure (cp) ===
  // Average curiosity score of top targets — measures how much the agent's
  // knowledge base is degrading. High pressure = knowledge decaying unattended.
  // Inverted: high curiosity pressure means LOW self-trust, so cp = 1 - avgCuriosity.
  let cp: number;
  if (curiosityPressure && curiosityPressure.count > 0) {
    // Normalize: curiosity scores are unbounded (confidenceLoss × staleness² × confidence).
    // Typical range 0-2. Use x/(x+1) to map to 0-1, then invert.
    const normalizedAvg = curiosityPressure.avgScore / (curiosityPressure.avgScore + 1);
    cp = 1 - normalizedAvg;
  } else {
    cp = 0.5; // No data — neutral
  }

  // === Composite ===
  const gradient =
    cfg.weight_kd * kd +
    cfg.weight_kq * kq +
    cfg.weight_gc * gc +
    cfg.weight_ts * ts +
    cfg.weight_rq * rq +
    cfg.weight_ie * ie +
    cfg.weight_te * te +
    cfg.weight_cp * cp;
  const delta = previousGradient !== null ? gradient - previousGradient : 0;

  const avgConfidence = nodeCount > 0 ? totalConfidence / nodeCount : 0;
  const avgHalfLife = nodeCount > 0 ? totalHalfLife / nodeCount : 0;

  const avgIterationsPerTurn =
    behavioralStats && behavioralStats.turnCount > 0
      ? behavioralStats.totalIterations / behavioralStats.turnCount
      : 0;

  return {
    motebit_id: motebitId,
    timestamp: now,
    gradient,
    delta,
    knowledge_density: kd,
    knowledge_density_raw: kdRaw,
    knowledge_quality: kq,
    graph_connectivity: gc,
    graph_connectivity_raw: gcRaw,
    temporal_stability: ts,
    retrieval_quality: rq,
    interaction_efficiency: ie,
    tool_efficiency: te,
    curiosity_pressure: cp,
    stats: {
      live_nodes: nodeCount,
      live_edges: edgeCount,
      semantic_count: semanticCount,
      episodic_count: episodicCount,
      pinned_count: pinnedCount,
      avg_confidence: avgConfidence,
      avg_half_life: avgHalfLife,
      consolidation_add: addCount,
      consolidation_update: updateCount,
      consolidation_reinforce: reinforceCount,
      consolidation_noop: noopCount,
      total_confidence_mass: totalConfidenceMass,
      avg_retrieval_score: retrievalStats?.avgScore ?? 0,
      retrieval_count: retrievalStats?.count ?? 0,
      avg_iterations_per_turn: avgIterationsPerTurn,
      total_turns: behavioralStats?.turnCount ?? 0,
      tool_calls_succeeded: behavioralStats?.toolCallsSucceeded ?? 0,
      tool_calls_blocked: behavioralStats?.toolCallsBlocked ?? 0,
      tool_calls_failed: behavioralStats?.toolCallsFailed ?? 0,
      curiosity_target_count: curiosityPressure?.count ?? 0,
      avg_curiosity_score: curiosityPressure?.avgScore ?? 0,
    },
  };
}

// === In-Memory Store (for tests) ===

export class InMemoryGradientStore implements GradientStoreAdapter {
  private snapshots: GradientSnapshot[] = [];

  save(snapshot: GradientSnapshot): void {
    this.snapshots.push(snapshot);
  }

  latest(motebitId: string): GradientSnapshot | null {
    const matching = this.snapshots.filter((s) => s.motebit_id === motebitId);
    if (matching.length === 0) return null;
    return matching[matching.length - 1]!;
  }

  list(motebitId: string, limit?: number): GradientSnapshot[] {
    const matching = this.snapshots
      .filter((s) => s.motebit_id === motebitId)
      .sort((a, b) => b.timestamp - a.timestamp);
    return limit !== undefined ? matching.slice(0, limit) : matching;
  }
}
