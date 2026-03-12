/**
 * Continuous reputation score — turns categorical trust records into
 * a 0.0–1.0 signal for granular policy decisions.
 *
 * Three components, equally weighted:
 *   successRate  = (1 + successful_tasks) / (2 + total_tasks)  — Beta-binomial (α=β=1)
 *   volumeScore  = min(interaction_count / 50, 1.0)  — saturates at 50
 *   recencyScore = exp(-daysSinceLastSeen / 90)       — 90-day half-life
 *
 * The Beta-binomial prior (Laplace smoothing) prevents extreme scores from
 * small samples: 0/0 → 0.5 (uncertain), 1/1 → 0.67 (promising), 0/1 → 0.33
 * (concerning). Converges to MLE as evidence accumulates.
 *
 * Special cases:
 *   - Blocked agents always return 0.0
 *   - Unknown agents return 0.0
 */

import { AgentTrustLevel } from "@motebit/sdk";
import type { AgentTrustRecord } from "@motebit/sdk";

const MS_PER_DAY = 86_400_000;
const VOLUME_SATURATION = 50;
const RECENCY_HALF_LIFE_DAYS = 90;

export function computeReputationScore(
  record: AgentTrustRecord,
  now?: number,
): number {
  if (record.trust_level === AgentTrustLevel.Blocked) return 0.0;
  if (record.trust_level === AgentTrustLevel.Unknown) return 0.0;

  const timestamp = now ?? Date.now();

  // Success rate: Beta-binomial with uniform prior (α=β=1, Laplace smoothing)
  const successfulTasks = record.successful_tasks ?? 0;
  const failedTasks = record.failed_tasks ?? 0;
  const totalTasks = successfulTasks + failedTasks;
  const successRate = (1 + successfulTasks) / (2 + totalTasks);

  // Volume: saturates at 50 interactions
  const volumeScore = Math.min(record.interaction_count / VOLUME_SATURATION, 1.0);

  // Recency: exponential decay with 90-day half-life
  const daysSinceLastSeen = (timestamp - record.last_seen_at) / MS_PER_DAY;
  const recencyScore = Math.exp(-daysSinceLastSeen / RECENCY_HALF_LIFE_DAYS);

  const raw = (successRate + volumeScore + recencyScore) / 3;
  return Math.max(0, Math.min(1, raw));
}
