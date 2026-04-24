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

// ── Reference Thresholds ───────────────────────────────────────────
//
// These values are the motebit reference implementation's starting
// point for agent-trust transitions — they prioritize, not compute.
// The semiring algebra above (`trustAdd`, `trustMultiply`,
// `TRUST_LEVEL_SCORES`, `TRUST_ZERO`, `TRUST_ONE`) IS protocol law —
// two interoperating motebit implementations must compute trust the
// same way. Transition thresholds are NOT protocol law — a federated
// implementation may choose stricter or looser values and still
// exchange trust scores correctly.
//
// The `REFERENCE_` prefix is the signal: "this is A reference default,
// not THE mandated value." Exported from the permissive-floor package
// so third-party integrators can adopt motebit's exact defaults if
// they want to (one import, zero reinvention) — renaming alone
// clarifies the role.

export const REFERENCE_TRUST_THRESHOLDS: TrustTransitionThresholds = {
  promoteToVerified_minTasks: 5,
  promoteToVerified_minRate: 0.8,
  promoteToTrusted_minTasks: 20,
  promoteToTrusted_minRate: 0.9,
  demote_belowRate: 0.5,
  demote_minTasks: 3,
};

/**
 * @deprecated since 1.0.1, removed in 2.0.0. Use {@link REFERENCE_TRUST_THRESHOLDS} instead.
 *
 * Reason: the `DEFAULT_` prefix read as "THE value every motebit
 * implementation uses," but trust-transition thresholds are motebit
 * product tuning — they govern promotion and demotion policy, not
 * protocol interop. A third-party motebit implementation may choose
 * different thresholds and still interoperate correctly (the semiring
 * algebra above is the interop contract). The `REFERENCE_` prefix
 * signals "motebit's reference-implementation default; implementers
 * MAY choose their own values." Rename-plus-deprecate so the naming
 * correction ships without a breaking change; the old export is
 * removed at 2.0.0.
 */
export const DEFAULT_TRUST_THRESHOLDS: TrustTransitionThresholds = REFERENCE_TRUST_THRESHOLDS;
