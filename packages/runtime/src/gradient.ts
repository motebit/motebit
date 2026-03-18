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
  PrecisionWeights,
  MarketConfig,
  GradientSnapshot,
  GradientStoreAdapter,
} from "@motebit/sdk";
import { computeDecayedConfidence } from "@motebit/memory-graph";

// Re-export from SDK so internal consumers that import from "./gradient.js" still resolve
export type { GradientSnapshot, GradientStoreAdapter } from "@motebit/sdk";

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

// === Active Inference Precision ===

/**
 * Pure: GradientSnapshot → PrecisionWeights.
 *
 * Maps the intelligence gradient into precision weights that modulate
 * the agent's epistemic/pragmatic balance. This is the feedback wire
 * from model evidence (gradient) to action selection (curiosity, routing,
 * memory retrieval).
 *
 * The sigmoid center (0.5) means: a gradient of 0.5 yields neutral precision.
 * Below 0.5 the agent becomes increasingly exploratory.
 * Above 0.5 the agent becomes increasingly exploitative.
 * The steepness (k=6) keeps precision responsive without being twitchy.
 */
export function computePrecision(snapshot: GradientSnapshot): PrecisionWeights {
  const g = snapshot.gradient; // [0, 1]
  const d = snapshot.delta; // negative = declining

  // Sigmoid: selfTrust = 1 / (1 + e^(-k*(g - 0.5)))
  // k=6 gives useful dynamic range: g=0.2→0.12, g=0.5→0.50, g=0.8→0.88
  const k = 6;
  const selfTrust = 1 / (1 + Math.exp(-k * (g - 0.5)));

  // Exploration is the complement, boosted when gradient is declining
  // A declining gradient (negative delta) increases exploration urgency
  const declinePenalty = d < 0 ? Math.min(Math.abs(d) * 2, 0.3) : 0;
  const explorationDrive = Math.min(1, 1 - selfTrust + declinePenalty);

  // Retrieval precision: when self-trust is high, lean on similarity (semantic precision).
  // When low, flatten weights to diversify what gets retrieved.
  // Range: 0.3 (low trust, diversified) to 0.9 (high trust, precise)
  const retrievalPrecision = 0.3 + selfTrust * 0.6;

  // Curiosity modulation: fed back into state vector curiosity field.
  // High exploration drive = high curiosity. Capped at 0.8 so the agent
  // never becomes purely curiosity-driven (always some pragmatic residual).
  const curiosityModulation = Math.min(0.8, explorationDrive);

  return { selfTrust, explorationDrive, retrievalPrecision, curiosityModulation };
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

/** Default precision when no gradient has been computed yet (neutral). */
export const NEUTRAL_PRECISION: PrecisionWeights = {
  selfTrust: 0.5,
  explorationDrive: 0.5,
  retrievalPrecision: 0.6,
  curiosityModulation: 0.4,
};

// === Precision Context for System Prompt ===

/**
 * Pure: PrecisionWeights → system prompt string.
 *
 * Translates the agent's active inference posture into natural language
 * guidance that modulates LLM behavior during conversation. This is the
 * wire from gradient → system prompt → behavior change → outcome → gradient.
 *
 * Three tiers:
 *   selfTrust < 0.4  → cautious: prefer clarification, verify before acting
 *   selfTrust > 0.7  → confident: act decisively, use proven methods
 *   otherwise        → balanced: moderate autonomy
 *
 * explorationDrive modulates approach selection independently:
 *   high (> 0.6) → try different tools/approaches, explore alternatives
 *   low  (< 0.4) → stick with proven methods, minimize experimentation
 */
export function buildPrecisionContext(weights: PrecisionWeights): string {
  const parts: string[] = [];

  // Self-trust tier
  if (weights.selfTrust < 0.4) {
    parts.push(
      "Your confidence in your own outputs is currently low. Prefer asking clarifying questions over making assumptions. Before executing tools with irreversible effects, verify your understanding with the user. When uncertain, say so — hedging is appropriate right now.",
    );
  } else if (weights.selfTrust > 0.7) {
    parts.push(
      "Your confidence in your own outputs is high. You can act decisively and trust your reasoning. Execute tool calls confidently when you have sufficient context. Minimize unnecessary clarification questions — your track record supports autonomy.",
    );
  } else {
    parts.push(
      "Your confidence is moderate. Balance autonomy with verification — ask for clarification on ambiguous requests, but act directly when the intent is clear.",
    );
  }

  // Exploration drive
  if (weights.explorationDrive > 0.6) {
    parts.push(
      "Your exploration drive is elevated — your knowledge base may be stale or incomplete. Try different approaches when the first attempt stalls. Consider alternative tools or framings. Ask questions that expand your understanding of the user's domain.",
    );
  } else if (weights.explorationDrive < 0.4) {
    parts.push(
      "Your exploration drive is low — your knowledge base is well-established. Use proven methods and familiar tools. Stick with approaches that have worked before rather than experimenting.",
    );
  }

  if (parts.length === 0) return "";
  return `[Active Inference Posture] ${parts.join(" ")}`;
}

// === Self-Model Summary ===

/**
 * Metric descriptor for self-narration.
 * Maps sub-metric keys to human-readable labels and thresholds.
 */
interface MetricDescriptor {
  key: keyof Pick<
    GradientSnapshot,
    | "knowledge_density"
    | "knowledge_quality"
    | "graph_connectivity"
    | "temporal_stability"
    | "retrieval_quality"
    | "interaction_efficiency"
    | "tool_efficiency"
    | "curiosity_pressure"
  >;
  label: string;
  /** Below this value the metric is "weak" */
  lowThreshold: number;
  /** Above this value the metric is "strong" */
  highThreshold: number;
  /** Natural-language fragments: [strong, weak] */
  assessment: [string, string];
}

const METRIC_DESCRIPTORS: MetricDescriptor[] = [
  {
    key: "knowledge_density",
    label: "Knowledge density",
    lowThreshold: 0.25,
    highThreshold: 0.6,
    assessment: [
      "accumulated a rich knowledge base",
      "knowledge base is still sparse — more experience needed",
    ],
  },
  {
    key: "knowledge_quality",
    label: "Knowledge quality",
    lowThreshold: 0.3,
    highThreshold: 0.65,
    assessment: [
      "memories are being reinforced and refined through use",
      "mostly adding new memories without reinforcing existing ones",
    ],
  },
  {
    key: "graph_connectivity",
    label: "Graph connectivity",
    lowThreshold: 0.15,
    highThreshold: 0.4,
    assessment: [
      "memories are well-connected — ideas relate to each other",
      "memory graph is fragmented — few connections between concepts",
    ],
  },
  {
    key: "temporal_stability",
    label: "Temporal stability",
    lowThreshold: 0.3,
    highThreshold: 0.6,
    assessment: [
      "long-lived semantic memories dominate — knowledge persists",
      "memories are predominantly short-lived or episodic",
    ],
  },
  {
    key: "retrieval_quality",
    label: "Retrieval quality",
    lowThreshold: 0.3,
    highThreshold: 0.65,
    assessment: [
      "retrieving relevant memories with high fidelity",
      "retrieval scores are low — memory search needs better context",
    ],
  },
  {
    key: "interaction_efficiency",
    label: "Interaction efficiency",
    lowThreshold: 0.4,
    highThreshold: 0.75,
    assessment: [
      "completing tasks with few iterations — efficient problem-solving",
      "taking many iterations per task — may need better planning",
    ],
  },
  {
    key: "tool_efficiency",
    label: "Tool efficiency",
    lowThreshold: 0.5,
    highThreshold: 0.85,
    assessment: ["tool calls succeed consistently", "tool calls are frequently blocked or failing"],
  },
  {
    key: "curiosity_pressure",
    label: "Curiosity pressure",
    lowThreshold: 0.3,
    highThreshold: 0.65,
    assessment: [
      "knowledge base is well-maintained — low decay pressure",
      "knowledge is decaying significantly — attention needed",
    ],
  },
];

export interface SelfModelSummary {
  /** One-sentence trajectory assessment */
  trajectory: string;
  /** Current overall assessment (1-2 sentences) */
  overall: string;
  /** Per-metric strengths (human-readable) */
  strengths: string[];
  /** Per-metric weaknesses (human-readable) */
  weaknesses: string[];
  /** Active inference posture description */
  posture: string;
  /** Composite gradient value */
  gradient: number;
  /** Gradient delta (trend) */
  delta: number;
  /** Number of snapshots analyzed */
  snapshotCount: number;
}

/**
 * Pure: GradientSnapshot[] → SelfModelSummary.
 *
 * Takes gradient history (most-recent-first) and produces a natural-language
 * self-assessment. No LLM calls, no I/O. The agent narrates its own trajectory
 * from the numbers alone.
 *
 * This is the self-model: the agent can articulate what it knows about its own
 * growth, where it's strong, where it's weak, and what posture it's adopting.
 */
export function summarizeGradientHistory(snapshots: GradientSnapshot[]): SelfModelSummary {
  if (snapshots.length === 0) {
    return {
      trajectory: "No gradient history — this agent has not yet measured itself.",
      overall: "Insufficient data for self-assessment.",
      strengths: [],
      weaknesses: [],
      posture: "Neutral — no precision data available.",
      gradient: 0,
      delta: 0,
      snapshotCount: 0,
    };
  }

  const latest = snapshots[0]!;
  const precision = computePrecision(latest);

  // Trajectory: analyze trend across history
  const trajectory = narrateTrajectory(snapshots);

  // Per-metric assessment
  const strengths: string[] = [];
  const weaknesses: string[] = [];

  for (const desc of METRIC_DESCRIPTORS) {
    const value = latest[desc.key];
    if (value >= desc.highThreshold) {
      strengths.push(desc.assessment[0]);
    } else if (value < desc.lowThreshold) {
      weaknesses.push(desc.assessment[1]);
    }
  }

  // Overall assessment
  const overall = narrateOverall(latest, strengths.length, weaknesses.length);

  // Active inference posture
  const posture = narratePosture(precision);

  return {
    trajectory,
    overall,
    strengths,
    weaknesses,
    posture,
    gradient: latest.gradient,
    delta: latest.delta,
    snapshotCount: snapshots.length,
  };
}

function narrateTrajectory(snapshots: GradientSnapshot[]): string {
  if (snapshots.length === 1) {
    const g = snapshots[0]!.gradient;
    return `First measurement: gradient at ${(g * 100).toFixed(1)}%. Trajectory unknown — need more data.`;
  }

  // Compute overall trend: linear regression slope over available history
  const oldest = snapshots[snapshots.length - 1]!;
  const latest = snapshots[0]!;
  const totalDelta = latest.gradient - oldest.gradient;
  const spanMs = latest.timestamp - oldest.timestamp;
  const spanHours = spanMs / (1000 * 60 * 60);

  // Count positive vs negative deltas for consistency
  let rising = 0;
  let falling = 0;
  for (const s of snapshots) {
    if (s.delta > 0.001) rising++;
    else if (s.delta < -0.001) falling++;
  }
  const consistency = Math.max(rising, falling) / Math.max(1, rising + falling);

  if (Math.abs(totalDelta) < 0.02) {
    return `Stable at ${(latest.gradient * 100).toFixed(1)}% over ${snapshots.length} measurements (${formatDuration(spanHours)}). The agent's model evidence is steady.`;
  }

  const direction = totalDelta > 0 ? "rising" : "declining";
  const rate = Math.abs(totalDelta);
  const pace = rate > 0.15 ? "rapidly" : rate > 0.05 ? "steadily" : "gradually";
  const consistencyNote =
    consistency > 0.8
      ? "consistently"
      : consistency > 0.5
        ? "with some fluctuation"
        : "with significant volatility";

  return `Gradient ${pace} ${direction} from ${(oldest.gradient * 100).toFixed(1)}% to ${(latest.gradient * 100).toFixed(1)}% over ${snapshots.length} measurements (${formatDuration(spanHours)}), ${consistencyNote}. ${totalDelta > 0 ? "The agent is accumulating better models of its niche." : "Model evidence is eroding — the agent should explore and rebuild."}`;
}

function narrateOverall(
  snapshot: GradientSnapshot,
  strengthCount: number,
  weaknessCount: number,
): string {
  const g = snapshot.gradient;
  const level = g >= 0.7 ? "high" : g >= 0.45 ? "moderate" : g >= 0.25 ? "low" : "very low";
  const balance =
    strengthCount > weaknessCount
      ? "More strengths than weaknesses"
      : strengthCount === weaknessCount
        ? "Balanced strengths and weaknesses"
        : "More weaknesses than strengths";

  return `Intelligence gradient is ${level} at ${(g * 100).toFixed(1)}%. ${balance} — ${strengthCount} strong, ${weaknessCount} needing attention.`;
}

function narratePosture(precision: PrecisionWeights): string {
  if (precision.selfTrust > 0.7) {
    return `Exploiting: high self-trust (${(precision.selfTrust * 100).toFixed(0)}%), tight retrieval precision, low curiosity. The agent trusts its model and acts decisively.`;
  }
  if (precision.selfTrust < 0.3) {
    return `Exploring: low self-trust (${(precision.selfTrust * 100).toFixed(0)}%), diversified retrieval, high curiosity (${(precision.curiosityModulation * 100).toFixed(0)}%). The agent is actively questioning its model.`;
  }
  return `Balanced: moderate self-trust (${(precision.selfTrust * 100).toFixed(0)}%), mixed retrieval strategy, moderate curiosity (${(precision.curiosityModulation * 100).toFixed(0)}%). The agent is maintaining equilibrium between known and unknown.`;
}

function formatDuration(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
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
