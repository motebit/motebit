/**
 * Memory promotion — the tentative → absolute transition.
 *
 * Motebit's reinforcement path in `MemoryGraph.consolidateAndForm`
 * boosts confidence by +0.1 and multiplies half_life by 1.5 on every
 * REINFORCE decision. That gives a continuous signal, but the UI and
 * the AI loop actually want the discrete question: "is this claim
 * ground truth yet?" This module answers that question and emits
 * `memory_promoted` (spec/memory-delta-v1.md §5.8) when the answer
 * flips from "no" to "yes."
 *
 * The heuristic is a confidence-threshold crossing, NOT a raw count,
 * for a specific reason: different memories enter at different base
 * confidences (episodic 0.6, semantic 0.7, explicit-user-statement
 * 0.9). Counting reinforcements would undercount high-baseline
 * memories that were already near-certain on first formation.
 * Threshold-crossing captures the "moved from hypothesis to fact"
 * state-change regardless of entry point.
 *
 * The module is pure — no I/O, no graph traversal. `MemoryGraph`
 * calls `shouldPromote` at REINFORCE time, passing before/after
 * confidence, and decides whether to emit the event. Keeps this file
 * trivially testable and keeps the emission site explicit.
 */

import type { MemoryNode, MemoryPromotedPayload } from "@motebit/sdk";

/**
 * Confidence crossing this threshold (from below, on a REINFORCE or
 * MERGE boost) triggers promotion. Tuned against motebit's +0.1
 * per-reinforcement step so a typical semantic memory (entry 0.7)
 * promotes after ~3 reinforcements; an explicit-user-statement
 * memory (entry 0.9) promotes after ~1 reinforcement. Both feel right
 * from the user's POV.
 */
export const PROMOTION_CONFIDENCE_THRESHOLD = 0.95;

/**
 * Return true iff a confidence update crosses the promotion threshold
 * from below. Idempotent: a second call with the same (prior, next)
 * still returns true only when prior < threshold; a follow-up update
 * that stays above threshold returns false.
 */
export function shouldPromote(priorConfidence: number, nextConfidence: number): boolean {
  return (
    priorConfidence < PROMOTION_CONFIDENCE_THRESHOLD &&
    nextConfidence >= PROMOTION_CONFIDENCE_THRESHOLD
  );
}

/**
 * Rough estimate of how many reinforcements it took to reach the
 * current confidence, given motebit's +0.1 per-step compounding and a
 * typical 0.7 baseline. Payload field is informational — consumers
 * MAY use it to calibrate their own promotion policy but MUST NOT
 * rely on it as a precise audit count (use the event log for that).
 */
export function estimateReinforcementCount(currentConfidence: number): number {
  const baseline = 0.7;
  if (currentConfidence <= baseline) return 0;
  return Math.max(1, Math.round((currentConfidence - baseline) / 0.1));
}

/**
 * Build a `MemoryPromotedPayload` for a node whose confidence just
 * crossed the threshold. Caller is responsible for checking
 * `shouldPromote` and emitting the event through the event log.
 */
export function buildPromotionPayload(
  node: Pick<MemoryNode, "node_id">,
  priorConfidence: number,
  nextConfidence: number,
  reason: string,
): MemoryPromotedPayload {
  return {
    node_id: node.node_id,
    from_confidence: priorConfidence,
    to_confidence: nextConfidence,
    reinforcement_count: estimateReinforcementCount(nextConfidence),
    reason,
  };
}
