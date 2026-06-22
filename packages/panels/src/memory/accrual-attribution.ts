/**
 * Accrual attribution — the calm in-flow phrase a surface renders for a
 * leverage moment (felt-accumulation Inc 3). Pure and sensitivity-bounded:
 * given a produced `AccrualBasis`, return the phrase to weave into the act,
 * the disclosure ceiling falling as the leveraged source's tier rises
 * (felt-accumulation § Disclosure — summary-not-secret, never the leveraged
 * content itself). Surface-agnostic projection; each surface renders the text
 * its own way (web inline, mobile, spatial), so the phrasing and the ceiling
 * stay consistent across surfaces instead of drifting per-surface.
 *
 * Doctrine: docs/doctrine/felt-accumulation.md.
 */

import {
  type AccrualBasis,
  type AccrualKind,
  SensitivityLevel,
  rankSensitivity,
} from "@motebit/protocol";

export interface AccrualAttribution {
  /** The calm in-flow phrase, already bounded by the basis's sensitivity tier. */
  readonly text: string;
}

// Open tier (none / personal): name the consequence — the leverage felt.
const OPEN: Record<AccrualKind, string> = {
  recalled_memory: "Recalled from what you've told me",
  trust_edge: "Trusting a peer you've worked with",
  consolidated_fact: "Drawing on what I pieced together earlier",
  prior_approval_pattern: "Matching a choice you've made before",
  standing_delegation: "Acting under a grant you signed",
};

// Guarded tier (medical and above): redact to the existence of a private draw —
// never the leveraged content, on a shoulder-surfable surface.
const GUARDED: Record<AccrualKind, string> = {
  recalled_memory: "Acted on a private memory",
  trust_edge: "Trusting a private relationship",
  consolidated_fact: "Drawing on a private pattern",
  prior_approval_pattern: "Matching a private preference",
  standing_delegation: "Acting under a private grant",
};

const GUARDED_FLOOR = rankSensitivity(SensitivityLevel.Medical);

/**
 * Project a produced `AccrualBasis` to its calm attribution phrase. The basis
 * is produced-not-authored upstream (felt-accumulation §3); this only chooses
 * how much of the consequence is safe to name given its sensitivity tier.
 */
export function resolveAccrualAttribution(basis: AccrualBasis): AccrualAttribution {
  const guarded = rankSensitivity(basis.sensitivity) >= GUARDED_FLOOR;
  return { text: (guarded ? GUARDED : OPEN)[basis.kind] };
}
