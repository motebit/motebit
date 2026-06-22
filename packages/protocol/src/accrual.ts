/**
 * Accrual basis types — the leverage register of the felt interior.
 *
 * Permissive floor (Apache-2.0): the interoperable shape of a "leverage
 * moment" — the typed basis an act carries when it was shaped by ACCRUED
 * state (a recalled memory, a trust edge, a consolidated fact). This is
 * thesis #2 (the agent gets more capable the longer it runs) made felt: not
 * the interior's mass (the resting `Felt*` records) but the interior DRAWN
 * UPON, in the flow of an act.
 *
 * Authorship rule (the honesty floor, enforced downstream by the Inc-5 gate
 * `check-accrual-basis-canonical`): an `AccrualBasis` is PRODUCED by the
 * accrual code path that drew upon the state — never authored by the model.
 * The memory-graph retrieval emits `recalled_memory`; the trust-graph edge
 * lookup emits `trust_edge`; the model's text output carries no leverage
 * marker. A basis the runtime did not produce is not a leverage moment, it's
 * a claim. Same forming-code-path authorship rule as `MemorySource`.
 *
 * LOCAL by construction: a leverage attribution is felt by the OWNER and
 * rendered on the body (an act, per `records-vs-acts.md`), never synced — so
 * `AccrualKind` is a structural-lock closed union with a bespoke gate, NOT a
 * registered wire registry like `MemorySource` (it fails the wire-presence
 * criterion). The `Record<AccrualKind, string>` marker map below is the
 * compile-time structural lock until the gate lands.
 *
 * Doctrine: `docs/doctrine/felt-accumulation.md`.
 */

import type { SensitivityLevel } from "./index.js";

// === Accrual Kind ===

/**
 * The kind of accumulated state an act drew upon — the leverage made felt.
 *
 * - `recalled_memory` — a memory retrieval shaped the act (a question not
 *   re-asked, a preference honored).
 * - `trust_edge` — a first-person trust edge reduced friction (a peer not
 *   re-verified).
 * - `consolidated_fact` — a fact synthesized by the idle consolidation cycle
 *   shaped a plan.
 * - `prior_approval_pattern` — a learned approval pattern spared the owner a
 *   confirmation.
 * - `standing_delegation` — an action ran automatically under a verified
 *   standing-delegation grant.
 *
 * Closed, append-only (`docs/doctrine/agility-as-role.md`). A new accrual
 * source is one union entry + one `ACCRUAL_KIND_MARKERS` entry + one gate
 * reference.
 */
export type AccrualKind =
  | "recalled_memory"
  | "trust_edge"
  | "consolidated_fact"
  | "prior_approval_pattern"
  | "standing_delegation";

/**
 * Frozen canonical iteration order over `AccrualKind` — the single source of
 * truth for "every accrual kind" (exhaustive switches, the marker map, the
 * Inc-5 coverage gate enumerate through this).
 */
export const ALL_ACCRUAL_KINDS: readonly AccrualKind[] = Object.freeze([
  "recalled_memory",
  "trust_edge",
  "consolidated_fact",
  "prior_approval_pattern",
  "standing_delegation",
] as AccrualKind[]);

/**
 * Type guard — narrows `unknown` to `AccrualKind`. Consumers that re-read a
 * basis from local storage call this before trusting the value; unknown
 * values are dropped, never coerced to a real kind.
 */
export function isAccrualKind(value: unknown): value is AccrualKind {
  return typeof value === "string" && (ALL_ACCRUAL_KINDS as readonly string[]).includes(value);
}

/**
 * Canonical short render anchors — the per-kind label a surface weaves into
 * the act it annotates (Ring 3 composes the full calm attribution, e.g.
 * "recalled from three weeks ago"; this is the stable anchor). A
 * `Record<AccrualKind, string>` so a registry append without a marker is a
 * compile error — the render surface cannot silently lag the union.
 */
export const ACCRUAL_KIND_MARKERS: Readonly<Record<AccrualKind, string>> = Object.freeze({
  recalled_memory: "recalled",
  trust_edge: "trusted",
  consolidated_fact: "consolidated",
  prior_approval_pattern: "approval-pattern",
  standing_delegation: "standing-grant",
});

// === Accrual Basis ===

/**
 * The produced basis an act carries when accrued state shaped it — the typed
 * leverage moment. PRODUCED by the accrual code path, never authored by the
 * model (the honesty floor above).
 *
 * - `kind` — which accrual source drew the leverage.
 * - `sourceRef` — an opaque pointer to the leveraged source, for explicit
 *   reveal (a memory node id, a peer `motebit_id`, a grant id). Opaque to the
 *   protocol; interpreted per `kind`. NEVER the source artifact itself — for
 *   `trust_edge` / `standing_delegation` the basis POINTS TO the signed grant
 *   the act ran under, it never carries the authority
 *   (`docs/doctrine/memory-never-confers-authority.md`; leverage reveals,
 *   never authorizes).
 * - `sensitivity` — the leveraged source's tier, which BOUNDS the render:
 *   summary-not-secret, the disclosure ceiling falling as the tier rises
 *   (`felt-accumulation.md` § Disclosure).
 */
export interface AccrualBasis {
  readonly kind: AccrualKind;
  readonly sourceRef: string;
  readonly sensitivity: SensitivityLevel;
}

/**
 * Mixin for an act/result that MAY have been shaped by accrued state. The
 * optional `accrualBasis` is the render path's hook: a surface attributes
 * leverage only when a basis is present, and its absence is the fail-closed
 * default (no genuine leverage → no attribution → the act renders plain).
 * Downstream act/result types in the runtime extend this at Inc 2/3.
 */
export interface AccrualAttributed {
  readonly accrualBasis?: AccrualBasis;
}
