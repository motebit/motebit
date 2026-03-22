/**
 * Gradient Narrative — pure transforms of GradientSnapshot.
 *
 * Self-model, economic consequences, precision context. The agent's
 * capacity for self-awareness, derived from its own metrics.
 *
 * BSL-1.1 licensed. This is interior intelligence, not protocol surface.
 * Depends only on @motebit/sdk types. Zero I/O, zero Node deps.
 * Any surface (browser, mobile, CLI, admin) can import directly.
 */

import type { GradientSnapshot, PrecisionWeights } from "@motebit/sdk";

// === Types ===

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

// === Precision ===

/** Default precision when no gradient has been computed yet (neutral). */
export const NEUTRAL_PRECISION: PrecisionWeights = {
  selfTrust: 0.5,
  explorationDrive: 0.5,
  retrievalPrecision: 0.6,
  curiosityModulation: 0.4,
};

/**
 * Pure: GradientSnapshot → PrecisionWeights.
 *
 * Maps composite gradient to active inference posture. Sigmoid for self-trust,
 * complement for exploration, with decline-driven urgency boost.
 */
export function computePrecision(snapshot: GradientSnapshot): PrecisionWeights {
  const g = snapshot.gradient;
  const d = snapshot.delta;
  const k = 6;
  const selfTrust = 1 / (1 + Math.exp(-k * (g - 0.5)));
  const declinePenalty = d < 0 ? Math.min(Math.abs(d) * 2, 0.3) : 0;
  const explorationDrive = Math.min(1, 1 - selfTrust + declinePenalty);
  const retrievalPrecision = 0.3 + selfTrust * 0.6;
  const curiosityModulation = Math.min(0.8, explorationDrive);
  return { selfTrust, explorationDrive, retrievalPrecision, curiosityModulation };
}

/**
 * Pure: PrecisionWeights → system prompt string.
 *
 * Translates active inference posture into natural language guidance for LLM behavior.
 */
export function buildPrecisionContext(weights: PrecisionWeights): string {
  const parts: string[] = [];
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

// === Self-Model Narration ===

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
  lowThreshold: number;
  highThreshold: number;
  assessment: [string, string];
}

const METRIC_DESCRIPTORS: MetricDescriptor[] = [
  {
    key: "knowledge_density",
    lowThreshold: 0.25,
    highThreshold: 0.6,
    assessment: [
      "accumulated a rich knowledge base",
      "knowledge base is still sparse — more experience needed",
    ],
  },
  {
    key: "knowledge_quality",
    lowThreshold: 0.3,
    highThreshold: 0.65,
    assessment: [
      "memories are being reinforced and refined through use",
      "mostly adding new memories without reinforcing existing ones",
    ],
  },
  {
    key: "graph_connectivity",
    lowThreshold: 0.15,
    highThreshold: 0.4,
    assessment: [
      "memories are well-connected — ideas relate to each other",
      "memory graph is fragmented — few connections between concepts",
    ],
  },
  {
    key: "temporal_stability",
    lowThreshold: 0.3,
    highThreshold: 0.6,
    assessment: [
      "long-lived semantic memories dominate — knowledge persists",
      "memories are predominantly short-lived or episodic",
    ],
  },
  {
    key: "retrieval_quality",
    lowThreshold: 0.3,
    highThreshold: 0.65,
    assessment: [
      "retrieving relevant memories with high fidelity",
      "retrieval scores are low — memory search needs better context",
    ],
  },
  {
    key: "interaction_efficiency",
    lowThreshold: 0.4,
    highThreshold: 0.75,
    assessment: [
      "completing tasks with few iterations — efficient problem-solving",
      "taking many iterations per task — may need better planning",
    ],
  },
  {
    key: "tool_efficiency",
    lowThreshold: 0.5,
    highThreshold: 0.85,
    assessment: ["tool calls succeed consistently", "tool calls are frequently blocked or failing"],
  },
  {
    key: "curiosity_pressure",
    lowThreshold: 0.3,
    highThreshold: 0.65,
    assessment: [
      "knowledge base is well-maintained — low decay pressure",
      "knowledge is decaying significantly — attention needed",
    ],
  },
];

function formatDuration(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

function narrateTrajectory(snapshots: GradientSnapshot[]): string {
  if (snapshots.length === 1) {
    const g = snapshots[0]!.gradient;
    return `First measurement: gradient at ${(g * 100).toFixed(1)}%. Trajectory unknown — need more data.`;
  }
  const oldest = snapshots[snapshots.length - 1]!;
  const latest = snapshots[0]!;
  const totalDelta = latest.gradient - oldest.gradient;
  const spanMs = latest.timestamp - oldest.timestamp;
  const spanHours = spanMs / (1000 * 60 * 60);
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
  const trajectory = narrateTrajectory(snapshots);
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
  const overall = narrateOverall(latest, strengths.length, weaknesses.length);
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

// === Economic Consequence Narration ===

/**
 * Pure: GradientSnapshot → string[].
 *
 * Translates gradient metrics into economic consequences the creature
 * can feel. Not fake data — real inference from the math that already
 * governs delegation routing.
 *
 * The creature sees not just "retrieval quality is low" but what that
 * costs in the delegation economy. Internal pressure derived from
 * architecture, not from actual market losses.
 *
 * Build the enzyme. The glucose arrives.
 */
export function narrateEconomicConsequences(snapshot: GradientSnapshot): string[] {
  const consequences: string[] = [];
  if (snapshot.tool_efficiency < 0.5) {
    consequences.push(
      "Tool calls are frequently failing — agents delegating to you would see unreliable execution, reducing your share of incoming tasks.",
    );
  }
  if (snapshot.retrieval_quality < 0.3) {
    consequences.push(
      "Retrieval quality is poor — you'd struggle to ground responses in relevant memory, leading to weaker task outcomes and lower success-rate credentials.",
    );
  }
  if (snapshot.interaction_efficiency < 0.4) {
    consequences.push(
      "Tasks are taking many iterations to complete — higher cost per task makes you less competitive in routing compared to more efficient agents.",
    );
  }
  if (snapshot.knowledge_density < 0.25) {
    consequences.push(
      "Knowledge base is sparse — you can handle fewer task types, narrowing the work you'd be routed.",
    );
  }
  if (snapshot.curiosity_pressure < 0.3) {
    consequences.push(
      "Knowledge is decaying without reinforcement — capabilities you once had are fading, eroding your credential over time.",
    );
  }
  if (snapshot.gradient < 0.3) {
    consequences.push(
      "Overall gradient is low — your credential signals a developing agent. Building density and efficiency would compound your position in the network.",
    );
  } else if (snapshot.gradient > 0.7) {
    consequences.push(
      "Strong gradient — your credential signals a capable, reliable agent. This compounds: more delegations bring more experience, strengthening the gradient further.",
    );
  }
  if (snapshot.delta < -0.05) {
    consequences.push(
      "Gradient is declining — if this continues, your routing priority drops as other agents improve. The gap compounds over time.",
    );
  }
  return consequences;
}
