/**
 * The structured verification-verdict vocabulary — graduated here from
 * `@motebit/crypto` (2026-07-08, EvalAttestation arc) because protocol is
 * the closed verdict vocabulary's home: `EvalAttestation` embeds whole
 * `VerificationVerdict`s per measurement, and `@motebit/wire-schemas` (which
 * may only see protocol) needs the shape for the zod parity block. Crypto
 * re-exports these type-only (the `EvidenceRef` graduation precedent) so the
 * verify family's public surface is unchanged, and keeps a compile-time
 * containment assert (`ArtifactType extends VerdictSubject`) so its
 * verify-result union can never drift outside this vocabulary.
 *
 * The governing rule — no unknown / unchecked / stale / integrity-only result
 * may silently read `true` — is enforced by the SHAPE: there is DELIBERATELY
 * no top-level `valid` boolean to over-read; a consumer branches on the axis
 * it depends on. See `docs/doctrine/verify-family-fail-closed.md` § "The
 * VerificationVerdict arc".
 */

import type { EvidenceRef } from "./evidence-provenance.js";

/** Did the signature verify over canonical bytes? The one clockless, always-establishable axis. */
export type IntegrityVerdict = "verified" | "invalid";

/**
 * The identity-binding rung (docs/doctrine/identity-binding-verification.md):
 * how strongly the signing key is bound to the claimed `motebit_id`. `sovereign`
 * = the id commits to the genesis key (offline, no operator); `anchored` =
 * transparency-log inclusion confirmed on-chain; `pinned` = time-valid in the
 * operator's succession chain; `unverified` = integrity only, key→id NOT
 * established (the embedded-key footgun, named honestly); `invalid` = a binding
 * was claimed and failed.
 */
export type IdentityBindingVerdict = "sovereign" | "anchored" | "pinned" | "unverified" | "invalid";

/**
 * Whether the authority (delegation grant / token scope) covering the action
 * holds. `valid` = a check ran and held; `expired` / `not_yet_valid` = outside
 * the validity window (past / future) under the verdict's `temporalBasis`;
 * `insufficient` = scope/structure does not confer it; `unknown` = no authority
 * context to evaluate (a bare receipt) — never a manufactured pass.
 */
export type AuthorityVerdict = "valid" | "expired" | "not_yet_valid" | "insufficient" | "unknown";

/** Revocation status. `unchecked` NEVER reads as "not revoked" — it is its own axis value. */
export type RevocationStatus = "fresh" | "stale" | "unchecked" | "revoked";

/**
 * The temporal basis a time-dependent axis was evaluated against. `clockless` =
 * no clock needed; `local_clock` = the verifier's own clock (first-person time,
 * self-borne risk); `ledger_anchored` = a chain slot/height — ORDERING, not
 * wall-clock (see docs/doctrine/verify-family-fail-closed.md).
 */
export type TemporalBasis = "clockless" | "local_clock" | "ledger_anchored";

/**
 * How a `RevocationStatus` was established, so an OFFLINE/P2P verifier can dial
 * its OWN staleness tolerance rather than accept a bare "stale" (co-designed
 * with consumer #2). `basis` is an agility axis — append a new value when a
 * consumer needs one (docs/doctrine/agility-as-role.md). `asOf` carries the
 * revocation set's wall-clock timestamp AND, when available, its deterministic
 * chain anchor (slot/height) — branch on the anchor, since chain time is
 * ordering, not wall-clock.
 *
 * `basis` is an evidence-grade ladder, weakest to strongest: `asserted` <
 * `stapled` < `ledger`. `asserted` = holder-asserted freshness with NO external
 * anchor ("we hold this set, refreshed at T, on our own say-so") — a consumer
 * SHOULD down-weight it relative to a `stapled` signed freshness proof or a
 * `ledger` chain root. The verdict carries the basis; it does NOT assign a
 * weight — the consumer holds the tolerance and sets where its acceptance line
 * falls. When `basis` is `asserted` the `asOf.anchor` is absent and the
 * `asOf.timestamp_ms` is a holder-asserted bound, not an orderable anchor.
 */
export interface RevocationFreshness {
  basis: "asserted" | "stapled" | "ledger";
  asOf: {
    /** Wall-clock ms the revocation set was current as of, when known. */
    timestamp_ms?: number;
    /** Deterministic chain anchor the set was current as of, when known. */
    anchor?: { chain: string; slot?: number; height?: number };
  };
}

export interface RevocationVerdict {
  status: RevocationStatus;
  /** Present when `status` derives from a freshness basis (a stapled proof or a ledger root). */
  freshness?: RevocationFreshness;
}

/**
 * Machine-readable repair instruction for a failing axis — first-class, not
 * optional-if-time (consumer #2). `code` is for programmatic branching; `fix` +
 * `canonical` are the legibility-on-contact pair ("learn the one axis you hit,"
 * not the whole verifier). Same shape-of-intent as the gate-repair contract
 * (scripts/lib/gate-report.ts), applied to verification.
 */
export interface RepairInstruction {
  /** Stable, machine-readable reason code (e.g. "revocation.unchecked", "identity.embedded_key_only"). */
  code: string;
  /** Which axis failed. */
  axis: "integrity" | "identityBinding" | "authority" | "revocation";
  /** One-line human summary of what's wrong. */
  summary: string;
  /** The canonical source of truth to consult or fix, when applicable. */
  canonical?: string;
  /** The concrete next step to establish the axis. */
  fix: string;
}

/**
 * What a `VerificationVerdict` is about.
 *
 * RESTATED here as an explicit closed literal union rather than derived from
 * crypto's `VerifyResult["type"]` (protocol has zero deps; the derivation
 * would be a cycle). Crypto's `ArtifactType` stays the derived form, with a
 * compile-time `ArtifactType extends VerdictSubject` assert as the drift lock
 * — a verify-result member missing here is a build error in crypto, not a
 * silent divergence.
 *
 * The first seven members mirror the auto-detected verify family plus its
 * `unknown` fallthrough; `delegation_token` covers the per-tick token/grant
 * path (not a top-level auto-detected artifact). The last four (2026-07-08,
 * EvalAttestation arc) name the Auditor's additional measurement subjects —
 * artifacts verified by explicit (non-auto-detected) laws. Widening is
 * additive: existing values are unchanged.
 */
export type VerdictSubject =
  | "identity"
  | "receipt"
  | "tool-invocation"
  | "credential"
  | "presentation"
  | "skill"
  | "unknown"
  | "delegation_token"
  | "succession"
  | "revocation"
  | "bond_commitment"
  | "solvency_proof";

/**
 * The structured verification verdict. DELIBERATELY carries no top-level `valid`
 * boolean: a consumer MUST branch on the axis it depends on, so an `unchecked` /
 * `stale` / `unverified` / `unknown` result cannot silently read as a pass.
 * `repair` is present whenever any axis is not in its passing state
 * (`integrity: "verified"`, `identityBinding` of sovereign/anchored/pinned,
 * `authority: "valid"`, `revocation.status: "fresh"`); its presence-on-failure
 * is enforced by the conformance corpus, not left to the implementer.
 */
export interface VerificationVerdict {
  /** What the verdict is about. */
  type: VerdictSubject;
  integrity: IntegrityVerdict;
  identityBinding: IdentityBindingVerdict;
  authority: AuthorityVerdict;
  revocation: RevocationVerdict;
  temporalBasis: TemporalBasis;
  evidenceBasis: readonly EvidenceRef[];
  /** Present whenever any axis is not passing; absent only on a clean pass. */
  repair?: RepairInstruction;
}
