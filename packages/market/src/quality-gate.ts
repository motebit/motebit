/**
 * Quality gate for execution receipts (market-v1.md §6.2).
 *
 * Scores the quality of a completed task result. Low-quality "completed"
 * results can be reclassified as failures — triggering refund instead of
 * settlement, producing no trust signal.
 *
 * Quality = 0.6 × length_score + 0.3 × tool_score + 0.1 × latency_score
 *
 * Default failure threshold: quality < 0.2
 */

export interface QualityScore {
  /** Result length score ∈ [0,1]. min(length, 500) / 500. */
  length_score: number;
  /** Tool usage score ∈ [0,1]. min(tools_used, 3) / 3. */
  tool_score: number;
  /** Latency score ∈ [0,1]. Inverted: faster = higher. 1 - (clamp(ms,500,5000) - 500) / 4500. */
  latency_score: number;
  /** Composite quality ∈ [0,1]. Weighted sum of sub-scores. */
  quality: number;
  /** Whether the result passes the quality threshold. */
  passed: boolean;
}

export interface QualityGateConfig {
  /** Minimum quality score to pass (default: 0.2). */
  threshold?: number;
  /** Weight for result length (default: 0.6). */
  weight_length?: number;
  /** Weight for tool usage (default: 0.3). */
  weight_tools?: number;
  /** Weight for latency (default: 0.1). */
  weight_latency?: number;
}

const DEFAULTS: Required<QualityGateConfig> = {
  threshold: 0.2,
  weight_length: 0.6,
  weight_tools: 0.3,
  weight_latency: 0.1,
};

/**
 * Score the quality of a completed task result.
 *
 * @param resultLength - Length of the result string (characters)
 * @param toolsUsedCount - Number of tools invoked during execution
 * @param latencyMs - Time from submission to completion (milliseconds)
 * @param config - Optional threshold and weight overrides
 */
export function scoreQuality(
  resultLength: number,
  toolsUsedCount: number,
  latencyMs: number,
  config?: QualityGateConfig,
): QualityScore {
  const cfg = { ...DEFAULTS, ...config };

  const length_score = Math.min(resultLength, 500) / 500;
  const tool_score = Math.min(toolsUsedCount, 3) / 3;
  // Latency: clamp to [500, 5000], invert so faster = higher score.
  const clamped = Math.min(Math.max(latencyMs, 500), 5000);
  const latency_score = 1 - (clamped - 500) / 4500;

  const quality =
    cfg.weight_length * length_score +
    cfg.weight_tools * tool_score +
    cfg.weight_latency * latency_score;

  return {
    length_score,
    tool_score,
    latency_score,
    quality,
    passed: quality >= cfg.threshold,
  };
}
