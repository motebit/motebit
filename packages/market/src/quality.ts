import type { ExecutionReceipt } from "@motebit/protocol";

/**
 * Score the quality of a delegation result from [0, 1].
 * Distinguishes "completed successfully with good output" from
 * "completed but returned nothing useful."
 *
 * Heuristics:
 * - Result length: empty/trivial results score near 0
 * - Tool usage: completed tasks that used tools score higher
 * - Latency: extremely fast completions on non-trivial tasks may indicate short-circuiting
 */
export function scoreResultQuality(receipt: ExecutionReceipt): number {
  const result = typeof receipt.result === "string" ? receipt.result : "";

  // Length score: saturates at 500 chars
  const lengthScore = Math.min(result.length, 500) / 500;

  // Tool score: used tools = higher quality signal
  const toolCount = receipt.tools_used?.length ?? 0;
  const toolScore = Math.min(toolCount, 3) / 3;

  // Latency score: very fast (<500ms) on non-trivial = suspicious
  const latencyMs = (receipt.completed_at ?? 0) - (receipt.submitted_at ?? 0);
  const latencyScore = latencyMs > 0 ? Math.min(Math.max(latencyMs, 500), 5000) / 5000 : 0.5;

  return 0.6 * lengthScore + 0.3 * toolScore + 0.1 * latencyScore;
}

/** Quality threshold below which a "completed" receipt is reclassified as a failure. */
export const QUALITY_FAILURE_THRESHOLD = 0.2;
