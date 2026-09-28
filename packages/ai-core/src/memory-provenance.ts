/**
 * The ONE place a turn's memory provenance is decided (#893).
 *
 * `source` is assigned by the forming code path, never the model
 * (docs/doctrine/memory-provenance.md). For a conversational turn the
 * forming path has exactly two facts to go on: WHOSE words the turn ran,
 * and whether tool content entered it.
 *
 * - A turn running ANOTHER principal's words — a customer's
 *   `motebit_task`, a caller's `motebit_query` — forms `peer_agent`,
 *   whatever else happened in it. Its candidates are that principal's
 *   claims, not the owner's; stamping them `user_stated` would let a
 *   stranger's words surface in the owner's recall as `[from:user]` —
 *   the persistent-injection / hallucinated-authority channel the
 *   registry exists to close. Checked FIRST, so no later branch can
 *   promote a foreign turn.
 * - An owner turn whose tools succeeded formed its candidates under
 *   external tool content — `tool_derived`, an unverified outside claim.
 * - Otherwise the owner said it — `user_stated`.
 *
 * `check-memory-source-canonical` locks this: no other non-test file in
 * `packages/ai-core/src` may name `"user_stated"`, and the foreign branch
 * here must be the first return.
 */

import type { MemorySource } from "@motebit/sdk";

export interface TurnProvenanceFacts {
  /**
   * The turn runs another principal's words. Carried on the turn's loop
   * dependencies (`MotebitLoopDependencies.foreignPrincipal`), set by the
   * runtime per turn — never read from runtime-wide state.
   */
  readonly foreignPrincipal: boolean | undefined;
  /** Tool calls in this turn that returned successfully. */
  readonly toolCallsSucceeded: number;
}

export function turnMemorySource(facts: TurnProvenanceFacts): MemorySource {
  if (facts.foreignPrincipal === true) return "peer_agent";
  if (facts.toolCallsSucceeded > 0) return "tool_derived";
  return "user_stated";
}
