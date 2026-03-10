/**
 * Intelligence Gradient — measures how a motebit gets smarter over time.
 *
 * Four sub-metrics, one composite score. Pure aggregation over existing data —
 * no new LLM calls, no new embeddings.
 *
 * Sub-metrics:
 *   kd  Knowledge Density    — sum of decayed confidence, normalized via x/(x+50)
 *   kq  Knowledge Quality    — (reinforce + update) / total consolidation events in 7-day window
 *   gc  Graph Connectivity   — edges/nodes ratio, normalized via x/(x+2)
 *   ts  Temporal Stability   — weighted mix of semantic ratio, pinned ratio, avg half-life
 *   rq  Retrieval Quality    — avg cosine similarity of memory retrievals since last housekeeping
 *
 * Composite: gradient = kd*0.20 + kq*0.25 + gc*0.15 + ts*0.20 + rq*0.20
 */

import { MemoryType } from "@motebit/sdk";
import type { MemoryNode, MemoryEdge, EventLogEntry } from "@motebit/sdk";
import { computeDecayedConfidence } from "@motebit/memory-graph";

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
  };
}

export interface GradientStoreAdapter {
  save(snapshot: GradientSnapshot): void;
  latest(motebitId: string): GradientSnapshot | null;
  list(motebitId: string, limit?: number): GradientSnapshot[];
}

export interface GradientConfig {
  /** Weight for knowledge density (default 0.20) */
  weight_kd: number;
  /** Weight for knowledge quality (default 0.25) */
  weight_kq: number;
  /** Weight for graph connectivity (default 0.15) */
  weight_gc: number;
  /** Weight for temporal stability (default 0.20) */
  weight_ts: number;
  /** Weight for retrieval quality (default 0.20) */
  weight_rq: number;
  /** Normalization constant for knowledge density: x/(x+K) (default 50) */
  kd_norm_k: number;
  /** Normalization constant for graph connectivity: x/(x+K) (default 2) */
  gc_norm_k: number;
}

const DEFAULT_CONFIG: GradientConfig = {
  weight_kd: 0.2,
  weight_kq: 0.25,
  weight_gc: 0.15,
  weight_ts: 0.2,
  weight_rq: 0.2,
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

  // === Composite ===
  const gradient =
    cfg.weight_kd * kd +
    cfg.weight_kq * kq +
    cfg.weight_gc * gc +
    cfg.weight_ts * ts +
    cfg.weight_rq * rq;
  const delta = previousGradient !== null ? gradient - previousGradient : 0;

  const avgConfidence = nodeCount > 0 ? totalConfidence / nodeCount : 0;
  const avgHalfLife = nodeCount > 0 ? totalHalfLife / nodeCount : 0;

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
