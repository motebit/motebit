import type {
  AgentTrustRecord,
  ExecutionReceipt,
  MotebitId,
} from "@motebit/sdk";
import { AgentTrustLevel } from "@motebit/sdk";

export interface ReputationSnapshot {
  motebit_id: MotebitId;
  timestamp: number;
  composite: number;
  sub_scores: {
    reliability: number;
    speed: number;
    trust_level: number;
    consistency: number;
    recency: number;
  };
  sample_size: number;
}

const TRUST_LEVEL_NUMERIC: Record<string, number> = {
  [AgentTrustLevel.Unknown]: 0.1,
  [AgentTrustLevel.FirstContact]: 0.3,
  [AgentTrustLevel.Verified]: 0.6,
  [AgentTrustLevel.Trusted]: 0.9,
  [AgentTrustLevel.Blocked]: 0.0,
};

const DEFAULT_TIME_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Pure: historical receipts + trust → reputation snapshot */
export function computeServiceReputation(
  motebitId: MotebitId,
  receipts: ExecutionReceipt[],
  trustRecord: AgentTrustRecord | null,
  timeWindowMs?: number,
): ReputationSnapshot {
  const window = timeWindowMs ?? DEFAULT_TIME_WINDOW_MS;
  const now = Date.now();
  const cutoff = now - window;

  // Filter to window
  const recent = receipts.filter((r) => r.completed_at >= cutoff);

  if (recent.length === 0) {
    const trustScore = trustRecord
      ? (TRUST_LEVEL_NUMERIC[trustRecord.trust_level] ?? 0.1)
      : 0.1;
    return {
      motebit_id: motebitId,
      timestamp: now,
      composite: trustScore * 0.3,
      sub_scores: { reliability: 0.5, speed: 0.5, trust_level: trustScore, consistency: 0.5, recency: 0.0 },
      sample_size: 0,
    };
  }

  // Reliability: fraction completed
  const completed = recent.filter((r) => r.status === "completed").length;
  const reliability = (1 + completed) / (2 + recent.length);

  // Speed: average duration (lower = better), normalized
  const durations = recent
    .filter((r) => r.completed_at > r.submitted_at)
    .map((r) => r.completed_at - r.submitted_at);
  const avgDuration = durations.length > 0
    ? durations.reduce((a, b) => a + b, 0) / durations.length
    : 10_000;
  const speed = 1 - avgDuration / (avgDuration + 5000);

  // Trust level
  const trust_level = trustRecord
    ? (TRUST_LEVEL_NUMERIC[trustRecord.trust_level] ?? 0.1)
    : 0.1;

  // Consistency: low stddev in duration = high consistency
  let consistency = 0.5;
  if (durations.length >= 2) {
    const mean = durations.reduce((a, b) => a + b, 0) / durations.length;
    const variance = durations.reduce((sum, d) => sum + (d - mean) ** 2, 0) / durations.length;
    const stddev = Math.sqrt(variance);
    const cv = mean > 0 ? stddev / mean : 1;
    consistency = Math.max(0, 1 - cv);
  }

  // Recency: how recent is the most recent receipt (exponential decay)
  const mostRecent = Math.max(...recent.map((r) => r.completed_at));
  const age = now - mostRecent;
  const recency = Math.exp(-age / (7 * 24 * 60 * 60 * 1000)); // 7-day half-life

  const composite =
    reliability * 0.30
    + speed * 0.20
    + trust_level * 0.20
    + consistency * 0.15
    + recency * 0.15;

  return {
    motebit_id: motebitId,
    timestamp: now,
    composite,
    sub_scores: { reliability, speed, trust_level, consistency, recency },
    sample_size: recent.length,
  };
}
