/**
 * The single producer of `AuthorityDelta` — every deny/raise site calls
 * a constructor here; none hand-rolls a delta. One module, one shape
 * per refusal class, or the system regresses to the scattered-residuals
 * problem this primitive exists to fix (the first-metered-dollar
 * ceremony, 2026-07-06/07: five correct refusals, five bespoke proses,
 * six hours of debugging).
 *
 * Constructors, not an algebra: each deny site already knows its axis,
 * so composition helpers (`leq`/`join`/fold) are deliberately absent —
 * promote them only when a third consumer needs to COMPOSE authorities
 * (multi-grant join, plan-level folds), per rule-of-three.
 *
 * See `AuthorityDelta` in @motebit/protocol for the two load-bearing
 * invariants (owner-facing asymmetry; predictor-never-authority).
 */

import type { AuthorityDelta, RiskLevel } from "@motebit/protocol";

/** The delegated scope lacks the tool — repair: a grant covering it. */
export function scopeDelta(toolName: string): AuthorityDelta {
  return { missing_scope: [toolName] };
}

/** Governance posture ceiling below the action's risk — repair: a
 *  deliberate posture change by the owner (never by grant override). */
export function postureDelta(requiredRisk: RiskLevel, postureCeiling: RiskLevel): AuthorityDelta {
  return { required_risk: requiredRisk, posture_ceiling: postureCeiling };
}

/** R4 raised for lack of standing authority — repair: a verified grant
 *  covering the tool, or a live human approval (the disjunction of
 *  memory-never-confers-authority). */
export function grantRequiredDelta(requiredRisk: RiskLevel): AuthorityDelta {
  return { required_risk: requiredRisk, requires_verified_grant: true };
}

/** Spend exceeds remaining ceiling — repair: a grant with the overage. */
export function spendOverageDelta(overageMicro: number): AuthorityDelta {
  return { spend_overage_micro: overageMicro };
}

/** Approval quorum not yet met. */
export function quorumShortfallDelta(shortfall: number): AuthorityDelta {
  return { quorum_shortfall: shortfall };
}

/** Terminal grant states — no residual exists; re-mint is the repair. */
export function terminalDelta(state: "revoked" | "expired"): AuthorityDelta {
  return { terminal: state };
}
