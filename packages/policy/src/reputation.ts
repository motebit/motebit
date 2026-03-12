/**
 * Continuous reputation score — turns categorical trust records into
 * a 0.0–1.0 signal for granular policy decisions.
 *
 * Three components, equally weighted:
 *   successRate  = successful_tasks / (successful_tasks + failed_tasks)
 *   volumeScore  = min(interaction_count / 50, 1.0)  — saturates at 50
 *   recencyScore = exp(-daysSinceLastSeen / 90)       — 90-day half-life
 *
 * Special cases:
 *   - Blocked agents always return 0.0
 *   - Unknown agents return 0.0
 *   - No tasks yet → successRate defaults to 0.5 (neutral)
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

  // Success rate: neutral 0.5 when no tasks recorded
  const successfulTasks = record.successful_tasks ?? 0;
  const failedTasks = record.failed_tasks ?? 0;
  const totalTasks = successfulTasks + failedTasks;
  const successRate = totalTasks > 0 ? successfulTasks / totalTasks : 0.5;

  // Volume: saturates at 50 interactions
  const volumeScore = Math.min(record.interaction_count / VOLUME_SATURATION, 1.0);

  // Recency: exponential decay with 90-day half-life
  const daysSinceLastSeen = (timestamp - record.last_seen_at) / MS_PER_DAY;
  const recencyScore = Math.exp(-daysSinceLastSeen / RECENCY_HALF_LIFE_DAYS);

  const raw = (successRate + volumeScore + recencyScore) / 3;
  return Math.max(0, Math.min(1, raw));
}
