/**
 * Trust algebra: concrete semiring operations for agent trust scoring.
 *
 * (TrustScores, max, ×, 0, 1) — standard algebraic path problem.
 * Multiplicative discount for serial chains, max for parallel paths.
 *
 * These are protocol-level primitives: any compatible implementation
 * must compute trust the same way for interoperable routing.
 */

import type { TrustTransitionThresholds, AgentTrustLevel } from "./index.js";

// ── Trust Semiring Algebra ──────────────────────────────────────────

/**
 * Canonical AgentTrustLevel → [0,1] mapping (single source of truth).
 *
 * Uses string literals instead of enum computed keys to avoid circular
 * initialization between trust-algebra.ts ↔ index.ts. The values match
 * AgentTrustLevel enum values exactly.
 */
export const TRUST_LEVEL_SCORES: Record<string, number> = {
  unknown: 0.1,
  first_contact: 0.3,
  verified: 0.6,
  trusted: 0.9,
  blocked: 0.0,
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

// ── Default Thresholds ─────────────────────────────────────────────

export const DEFAULT_TRUST_THRESHOLDS: TrustTransitionThresholds = {
  promoteToVerified_minTasks: 5,
  promoteToVerified_minRate: 0.8,
  promoteToTrusted_minTasks: 20,
  promoteToTrusted_minRate: 0.9,
  demote_belowRate: 0.5,
  demote_minTasks: 3,
};
