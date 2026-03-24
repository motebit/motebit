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
import type {
  MemoryNode,
  MemoryEdge,
  EventLogEntry,
  MarketConfig,
  GradientSnapshot,
  GradientStoreAdapter,
} from "@motebit/sdk";
import { computeDecayedConfidence } from "@motebit/memory-graph";
import { computePrecision, computeStateBaseline } from "@motebit/gradient";

// Re-export from gradient/sdk so internal consumers that import from "./gradient.js" still resolve
export type { GradientSnapshot, GradientStoreAdapter } from "@motebit/sdk";
export type { SelfModelSummary } from "@motebit/gradient";
export { computePrecision, computeStateBaseline };
export {
  buildPrecisionContext,
  NEUTRAL_PRECISION,
  summarizeGradientHistory,
  narrateEconomicConsequences,
} from "@motebit/gradient";

/** Must match MAX_TOOL_ITERATIONS in @motebit/ai-core loop.ts */
const MAX_TOOL_ITERATIONS = 10;

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
  weight_ts: 0.1,
  weight_rq: 0.15,
  weight_ie: 0.12,
  weight_te: 0.1,
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
  // When no consolidation events exist in the window:
  //   - If the agent has live memories, default to neutral (0.5) — the agent is stable,
  //     not degrading. Dragging to 0 would penalize a mature, quiescent agent.
  //   - If the agent has zero memories, kq=0 is correct (truly empty, no quality to measure).
  // This is consistent with rq/ie/te/cp which all default to 0.5 on no data.
  const kq =
    totalConsolidation > 0
      ? (reinforceCount + updateCount) / totalConsolidation
      : liveNodes.length > 0
        ? 0.5
        : 0;

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
  // When no retrievals occurred (idle period), hold neutral (0.5) rather than
  // dragging the gradient down with 0. Consistent with ie/te/cp no-data defaults.
  const rq = retrievalStats && retrievalStats.count > 0 ? retrievalStats.avgScore : 0.5;

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

/**
 * Pure: GradientSnapshot → Partial<MarketConfig>.
 *
 * Closes the feedback loop: gradient measures agent quality, this function
 * translates that measurement into routing weights for delegation.
 *
 * Two layers of adjustment:
 * 1. Global exploration/exploitation from precision weights
 *    (shifts weight between trust/success_rate and availability/capability)
 * 2. Metric-specific corrections:
 *    - Low tool_efficiency → boost weight_trust (prefer agents with proven track records)
 *    - Low retrieval_quality → boost weight_capability_match (need exact capability matches)
 *    - Low interaction_efficiency → boost weight_latency (compensate with faster agents)
 *
 * The metric-specific shifts are small (±0.05 max) and additive on top of the
 * global exploration shift. They nudge, they don't dominate.
 */
export function gradientToMarketConfig(
  snapshot: GradientSnapshot,
  baseConfig?: Partial<MarketConfig>,
): Partial<MarketConfig> {
  const precision = computePrecision(snapshot);
  const e = Math.max(0, Math.min(1, precision.explorationDrive));

  // Layer 1: global exploration/exploitation shift
  // Same math as applyPrecisionToMarketConfig (inlined to avoid circular dep)
  // At e=0 (exploit): no change. At e=1 (explore): ±0.10 shift.
  const base_wt = baseConfig?.weight_trust ?? 0.25;
  const base_ws = baseConfig?.weight_success_rate ?? 0.25;
  const base_wl = baseConfig?.weight_latency ?? 0.15;
  const base_wp = baseConfig?.weight_price_efficiency ?? 0.15;
  const base_wc = baseConfig?.weight_capability_match ?? 0.1;
  const base_wa = baseConfig?.weight_availability ?? 0.1;

  let wt = base_wt - e * 0.1;
  const ws = base_ws - e * 0.1;
  const wl_base = base_wl;
  const wp = base_wp;
  let wc = base_wc + e * 0.1;
  const wa = base_wa + e * 0.1;

  // Layer 2: metric-specific corrections (±0.05 max each)
  // Deficit-driven: only activate when a metric is weak (below 0.4)
  const MAX_METRIC_SHIFT = 0.05;

  // Low tool efficiency → prefer trusted agents (they succeed more often)
  const teDeficit = Math.max(0, 0.4 - snapshot.tool_efficiency);
  wt += (teDeficit / 0.4) * MAX_METRIC_SHIFT;

  // Low retrieval quality → demand exact capability matches
  const rqDeficit = Math.max(0, 0.4 - snapshot.retrieval_quality);
  wc += (rqDeficit / 0.4) * MAX_METRIC_SHIFT;

  // Low interaction efficiency → prefer fast agents
  const ieDeficit = Math.max(0, 0.4 - snapshot.interaction_efficiency);
  const wl = wl_base + (ieDeficit / 0.4) * MAX_METRIC_SHIFT;

  return {
    ...baseConfig,
    weight_trust: wt,
    weight_success_rate: ws,
    weight_latency: wl,
    weight_price_efficiency: wp,
    weight_capability_match: wc,
    weight_availability: wa,
    exploration_weight: e,
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
