/**
 * Trust algebra — judgment layer.
 *
 * Protocol-level primitives (scores, constants, composition) are re-exported
 * from @motebit/protocol. This file adds the judgment functions that encode
 * Motebit's specific business logic for trust transitions and delegation
 * trust composition.
 */

import type { AgentTrustRecord, TrustTransitionThresholds } from "@motebit/protocol";
import {
  AgentTrustLevel,
  REFERENCE_TRUST_THRESHOLDS,
  trustMultiply,
  joinParallelRoutes,
} from "@motebit/protocol";

// ── Re-export protocol primitives ──────────────────────────────────

export {
  TRUST_LEVEL_SCORES,
  trustLevelToScore,
  TRUST_ZERO,
  TRUST_ONE,
  trustAdd,
  trustMultiply,
  composeTrustChain,
  joinParallelRoutes,
  REFERENCE_TRUST_THRESHOLDS,
  // Back-compat alias — deprecated since 1.0.1, removed in 2.0.0.
  // Downstream code should switch to REFERENCE_TRUST_THRESHOLDS.
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- intentional re-export of deprecated alias
  DEFAULT_TRUST_THRESHOLDS,
} from "@motebit/protocol";

// ── Judgment: Trust Level Transitions (BSL) ────────────────────────

/**
 * Pure: evaluate whether a trust record should transition levels.
 *
 * Promotion: sustained evidence of success (asymmetric — harder to earn).
 * Demotion: success rate dropping below threshold (faster — protect the network).
 * Blocked is never auto-assigned or auto-removed (security decision).
 *
 * Returns the new level, or null if no transition.
 */
export function evaluateTrustTransition(
  record: AgentTrustRecord,
  thresholds?: Partial<TrustTransitionThresholds>,
): AgentTrustLevel | null {
  const t = { ...REFERENCE_TRUST_THRESHOLDS, ...thresholds };
  const level = record.trust_level;
  const succeeded = record.successful_tasks ?? 0;
  const failed = record.failed_tasks ?? 0;
  const total = succeeded + failed;

  // Blocked is manual-only — never auto-transition in or out
  if (level === AgentTrustLevel.Blocked) return null;

  const rate = total > 0 ? succeeded / total : 1;

  // Check demotion first (fail-fast, protect the network)
  if (total >= t.demote_minTasks && rate < t.demote_belowRate) {
    if (level === AgentTrustLevel.Trusted) return AgentTrustLevel.Verified;
    if (level === AgentTrustLevel.Verified) return AgentTrustLevel.FirstContact;
    // FirstContact and Unknown can't demote further (Blocked is manual)
    return null;
  }

  // Check promotion (asymmetric — higher bar)
  if (level === AgentTrustLevel.Unknown && total >= 1) {
    return AgentTrustLevel.FirstContact;
  }
  if (
    level === AgentTrustLevel.FirstContact &&
    succeeded >= t.promoteToVerified_minTasks &&
    rate >= t.promoteToVerified_minRate
  ) {
    return AgentTrustLevel.Verified;
  }
  if (
    level === AgentTrustLevel.Verified &&
    succeeded >= t.promoteToTrusted_minTasks &&
    rate >= t.promoteToTrusted_minRate
  ) {
    return AgentTrustLevel.Trusted;
  }

  return null;
}

// ── Judgment: Delegation Trust Composition (BSL) ───────────────────

/** Structural type for recursive delegation receipt walking. */
export interface DelegationReceiptLike {
  motebit_id: string;
  delegation_receipts?: DelegationReceiptLike[];
}

/**
 * Compose trust through a delegation receipt tree.
 *
 * Walks `receipt.delegation_receipts` recursively:
 * - Each sub-delegation: directTrust ⊗ getTrust(sub.motebit_id)
 * - Parallel branches joined with ⊕ (best route wins)
 * - No sub-delegations → returns directTrust unchanged.
 */
export function composeDelegationTrust(
  directTrust: number,
  receipt: DelegationReceiptLike,
  getTrust: (motebitId: string) => number,
): number {
  const subs = receipt.delegation_receipts;
  if (!subs || subs.length === 0) return directTrust;

  const branchScores = subs.map((sub) => {
    const subTrust = getTrust(sub.motebit_id);
    const chainScore = trustMultiply(directTrust, subTrust);
    // Recurse: sub may have its own delegation_receipts
    return composeDelegationTrust(chainScore, sub, getTrust);
  });

  return joinParallelRoutes(branchScores);
}
