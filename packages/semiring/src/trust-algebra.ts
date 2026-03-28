/**
 * Trust algebra: concrete semiring operations for agent trust scoring.
 *
 * (TrustScores, max, ×, 0, 1) — standard algebraic path problem.
 * Multiplicative discount for serial chains, max for parallel paths.
 *
 * Also includes the reputation state machine (trust level transitions)
 * and recursive delegation trust composition.
 */

import type { AgentTrustRecord, TrustTransitionThresholds } from "@motebit/protocol";
import { AgentTrustLevel } from "@motebit/protocol";

// ── Trust Semiring Algebra ──────────────────────────────────────────

/** Canonical AgentTrustLevel → [0,1] mapping (single source of truth). */
export const TRUST_LEVEL_SCORES: Record<string, number> = {
  [AgentTrustLevel.Unknown]: 0.1,
  [AgentTrustLevel.FirstContact]: 0.3,
  [AgentTrustLevel.Verified]: 0.6,
  [AgentTrustLevel.Trusted]: 0.9,
  [AgentTrustLevel.Blocked]: 0.0,
};

/** Convert a trust level to its numeric score. */
export function trustLevelToScore(level: AgentTrustLevel | string): number {
  return TRUST_LEVEL_SCORES[level] ?? 0.1;
}

/** Semiring zero — annihilator for ⊗, identity for ⊕. */
export const TRUST_ZERO = 0;

/** Semiring one — identity for ⊗. */
export const TRUST_ONE = 1;

/** ⊕: parallel paths — pick the best route. */
export function trustAdd(a: number, b: number): number {
  return Math.max(a, b);
}

/** ⊗: serial chain — discount per hop. */
export function trustMultiply(a: number, b: number): number {
  return a * b;
}

/** Fold a chain of trust scores with ⊗. Empty chain → 1.0 (identity). */
export function composeTrustChain(scores: number[]): number {
  return scores.reduce(trustMultiply, TRUST_ONE);
}

/** Fold parallel route scores with ⊕. No routes → 0.0 (identity). */
export function joinParallelRoutes(scores: number[]): number {
  return scores.reduce(trustAdd, TRUST_ZERO);
}

// ── Trust Level Transitions (reputation state machine) ────────────

export const DEFAULT_TRUST_THRESHOLDS: TrustTransitionThresholds = {
  promoteToVerified_minTasks: 5,
  promoteToVerified_minRate: 0.8,
  promoteToTrusted_minTasks: 20,
  promoteToTrusted_minRate: 0.9,
  demote_belowRate: 0.5,
  demote_minTasks: 3,
};

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
  const t = { ...DEFAULT_TRUST_THRESHOLDS, ...thresholds };
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

// ── Delegation Trust Composition ─────────────────────────────────

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
