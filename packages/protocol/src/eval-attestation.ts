/**
 * EvalAttestation — the signed third-party-measurement artifact.
 *
 * Promoted 2026-07-08 per [`docs/doctrine/evals-as-attestations.md`](../../../docs/doctrine/evals-as-attestations.md)
 * (trigger #1: the Auditor archetype is a second motebit emitting signed
 * evals against another motebit over the relay's standard task transport,
 * and the wire shape must be canonical). The category law: **subject ≠
 * signer** — a receipt is first-person provenance ("I did this"), an
 * attestation is third-party measurement ("I observed this about you").
 * Self-issued attestations (subject == issuer) are permitted as the
 * doctrine's floor, but the SIGNER is always the issuer; the signature
 * never speaks for the subject.
 *
 * Each measurement embeds a whole per-axis `VerificationVerdict` — never a
 * flattened boolean — so the verdict family's no-silent-true discipline
 * carries into the attestation unchanged: an `unchecked` revocation axis or
 * an `unverified` binding rung cannot read as a pass inside an eval either.
 *
 * Verification law lives in `@motebit/crypto` (`verifyEvalAttestation`):
 * it establishes "this issuer said this about this subject" and
 * deliberately never the TRUTH of the measurements — a skeptical consumer
 * re-runs the underlying laws over the cited evidence
 * (`verifyEvidenceProvenance` per ref, receipt verdicts over re-fetched
 * receipts). Issuer authority (who counts as a trusted auditor) is
 * app-layer, exactly like `EvidenceProvenance.binding`.
 */

import type { DigestRef, EvidenceRef } from "./evidence-provenance.js";
import type { VerificationVerdict } from "./verification-verdict.js";

// === EvalKind — closed registry (eleventh registered registry) ===

/**
 * The measurement FAMILY a consumer dispatches on to interpret `results[]`.
 * Closed registry — an unknown `eval_kind` fails closed at wire intake
 * (`verifyEvalAttestation` rejects it), because a consumer that cannot
 * interpret the measurement family must not act on its verdicts.
 *
 * Contrast with `EvalResult.check`, which stays FREE-FORM: the per-check
 * name is the issuer's catalog label. Freezing check names into protocol
 * would make motebit the authority over every third-party scorer's
 * measurement menu — the same document-format-authority trap
 * `EvidenceProvenance.projection` deliberately avoids. The closed/free
 * split mirrors listing capabilities (free-form) vs `SettlementMode`
 * (closed): registries own what verifiers must dispatch on, conventions
 * own what issuers may invent.
 *
 * `verification_audit` — the Auditor archetype's family: measurements of
 * another agent's public verification surface (identity binding,
 * succession, revocation, receipt spot-checks, bond integrity, solvency),
 * each result an embedded `VerificationVerdict`.
 */
export type EvalKind = "verification_audit";

/** Frozen mirror of the `EvalKind` union — locked by `check-eval-kind-canonical`. */
export const ALL_EVAL_KINDS: readonly EvalKind[] = Object.freeze(["verification_audit"]);

/** Type guard for wire intake — unknown kinds fail closed. */
export function isEvalKind(value: unknown): value is EvalKind {
  return typeof value === "string" && (ALL_EVAL_KINDS as readonly string[]).includes(value);
}

// === The attestation shape ===

/**
 * One named measurement inside an attestation.
 */
export interface EvalResult {
  /**
   * Measurement identifier. Free-form snake_case BY CONVENTION (an
   * issuer-owned check-catalog label, like `EvidenceRef.kind`) — NOT a
   * closed registry; the embedded verdict carries the interop-law value
   * vocabulary, the check name says which measurement produced it.
   */
  readonly check: string;
  /** The measured value — the whole per-axis verdict, evidence and repair intact. */
  readonly verdict: VerificationVerdict;
}

/**
 * The signed third-party-measurement artifact. See the module doc for the
 * category law and the verification split (envelope law in crypto; truth
 * of measurements deliberately out of scope).
 *
 * JCS discipline: optional fields are ABSENT, never `undefined`-valued —
 * producers build them via conditional spread so `canonicalJson` bytes are
 * stable.
 */
export interface EvalAttestation {
  /** UUIDv7, issuer-generated. */
  readonly attestation_id: string;
  /** Measurement family — closed `EvalKind` registry; unknown fails closed. */
  readonly eval_kind: EvalKind;
  /** The measured party. `subject.motebit_id` MAY equal the issuer's (self-issued floor). */
  readonly subject: {
    readonly motebit_id: string;
    /**
     * Content addresses of the subject artifacts the measurement consumed
     * (listing bytes, sampled receipts, bond commitment) — the audit's
     * evidence closure, re-fetchable and re-checkable.
     */
    readonly artifact_digests?: readonly DigestRef[];
  };
  /**
   * The measuring party — the SIGNER. Self-describing like
   * `ContentArtifactManifest`: the public key rides in the artifact;
   * binding that key to the issuer's motebit_id is the consumer's
   * `verifySovereignBinding`-shaped responsibility.
   */
  readonly issuer: {
    readonly motebit_id: string;
    /** Issuer's Ed25519 public key, lowercase hex (32 bytes / 64 chars). */
    readonly public_key: string;
  };
  /** Unix ms — when the measurement was signed. */
  readonly issued_at: number;
  /**
   * Unix ms — optional issuer-declared staleness bound. Carried,
   * consumer-policied; the verify law does NOT enforce it (an expired
   * attestation still verifies — the consumer holds the tolerance).
   */
  readonly expires_at?: number;
  /**
   * The evidence-read basis: wall-clock ms the public reads were performed,
   * plus a deterministic chain anchor when one was consulted. The verdict
   * family's temporal honesty (`RevocationFreshness.asOf`) lifted to the
   * envelope: an attestation says WHAT WAS TRUE AS-OF, never timelessly.
   */
  readonly as_of: {
    readonly timestamp_ms: number;
    readonly anchor?: { readonly chain: string; readonly slot?: number; readonly height?: number };
  };
  /** The measurements. Non-empty — an attestation that measured nothing is rejected. */
  readonly results: readonly EvalResult[];
  /**
   * Attestation-level evidence — unsigned observations (listing bytes,
   * ranking output) that informed the audit but are not measurements
   * (unsigned bytes cannot honestly produce an integrity verdict). Each
   * MAY carry `EvidenceProvenance` for local re-check down to the fetched
   * bytes.
   */
  readonly evidence?: readonly EvidenceRef[];
  /** Optional cross-reference into the issuer's execution ledger (the audit task that produced this). */
  readonly invocation?: { readonly task_id?: string; readonly relay_task_id?: string };
  /**
   * Pinned signature suite literal (wire-schemas Rule 6 — the literal,
   * never the `SuiteId` union). PQ migration = a new suite entry + a new
   * dispatch arm, not a wire break.
   */
  readonly suite: "motebit-jcs-ed25519-b64-v1";
  /** Ed25519 over `canonicalJson({...attestation minus signature})`, base64url. */
  readonly signature: string;
}
