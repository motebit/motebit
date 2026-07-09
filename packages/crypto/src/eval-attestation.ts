/**
 * EvalAttestation signing + verification — the envelope laws for the signed
 * third-party-measurement artifact (`@motebit/protocol`
 * `eval-attestation.ts`; docs/doctrine/evals-as-attestations.md, promoted
 * 2026-07-08 with the Auditor archetype as consumer #1).
 *
 * The category law is subject ≠ signer: a receipt is first-person
 * provenance, an attestation is third-party measurement. The verify law
 * here establishes exactly one sentence — "this issuer said these
 * measurements about this subject, as of this basis" — and DELIBERATELY
 * nothing more:
 *
 *   - NOT the truth of the measurements. The embedded per-axis verdicts
 *     are the issuer's claims; a skeptical consumer re-runs the underlying
 *     laws over the cited evidence (`verifyEvidenceProvenance` per ref,
 *     receipt verdicts over re-fetched receipts).
 *   - NOT issuer authority or reputation — who counts as a trusted auditor
 *     is app-layer, exactly like `EvidenceProvenance.binding`.
 *   - NOT the issuer key → motebit_id binding — the consumer's
 *     `verifySovereignBinding`-shaped responsibility, as with bonds.
 *   - NOT `expires_at` / `as_of` freshness — carried, consumer-policied
 *     (the consumer holds the staleness tolerance; the verdict family's
 *     temporal-honesty discipline).
 *   - Subject == issuer is NOT rejected — self-issued evals are the
 *     doctrine's floor, a different trust grade, never a malformed artifact.
 *
 * Fail-closed at every step it DOES own: unknown suite, unknown eval_kind
 * (closed-registry wire intake), malformed key/signature, empty results,
 * signature mismatch.
 */

import type { EvalAttestation } from "@motebit/protocol";
import { canonicalJson, hexToBytes, toBase64Url, fromBase64Url } from "./signing.js";
import { signBySuite, verifyBySuite } from "./suite-dispatch.js";

/**
 * The pinned suite for EvalAttestation signing (JCS canonicalization,
 * Ed25519, base64url signature encoding). PQ migration = a new `SuiteId`
 * in `@motebit/protocol` + a new dispatch arm in `suite-dispatch.ts`, not
 * a wire break.
 */
export const EVAL_ATTESTATION_SUITE = "motebit-jcs-ed25519-b64-v1" as const;

/**
 * Crypto-side mirror of the protocol `EvalKind` registry. Crypto keeps
 * ZERO runtime monorepo deps (protocol is a type-only devDependency), so
 * the fail-closed `unknown_eval_kind` check cannot import
 * `ALL_EVAL_KINDS` at runtime — the same reason `SuiteId` values are
 * mirrored into the dispatch table (crypto CLAUDE.md rule 3). Locked
 * against the protocol registry as the FOURTH site of
 * `check-eval-kind-canonical`; adding an eval kind = protocol union +
 * frozen array + this mirror + the gate's reference, one commit.
 */
export const EVAL_KINDS_MIRROR: readonly string[] = Object.freeze(["verification_audit"]);

/** Canonical bytes used for signing — the attestation without its own signature field. */
function canonicalizeForSigning(unsigned: Omit<EvalAttestation, "signature">): Uint8Array {
  return new TextEncoder().encode(canonicalJson(unsigned));
}

/**
 * Sign an eval attestation with the issuer's identity key. The body must
 * already carry `issuer.public_key` (lowercase hex of the key that pairs
 * with `issuerPrivateKey`) — the artifact is self-describing, like
 * `ContentArtifactManifest`.
 *
 * JCS discipline: build optional fields by conditional spread upstream;
 * this primitive signs the body it is given, byte-stably.
 */
export async function signEvalAttestation(
  body: Omit<EvalAttestation, "signature" | "suite">,
  issuerPrivateKey: Uint8Array,
): Promise<EvalAttestation> {
  const unsigned: Omit<EvalAttestation, "signature"> = {
    ...body,
    suite: EVAL_ATTESTATION_SUITE,
  };
  const message = canonicalizeForSigning(unsigned);
  const sig = await signBySuite(EVAL_ATTESTATION_SUITE, message, issuerPrivateKey);
  return { ...unsigned, signature: toBase64Url(sig) };
}

/** Verification outcome with a structured failure reason for audit logging. */
export interface VerifyEvalAttestationResult {
  readonly valid: boolean;
  /** Structured failure reason when `valid === false`. */
  readonly reason?:
    | "unsupported_suite"
    | "unknown_eval_kind"
    | "empty_results"
    | "malformed_public_key"
    | "malformed_signature"
    | "signature_invalid";
}

/**
 * Verify an eval attestation's envelope. See the module doc for what this
 * law deliberately does NOT check (measurement truth, issuer authority,
 * key→id binding, freshness). Fail-closed: every rejection returns a typed
 * reason rather than throwing.
 */
export async function verifyEvalAttestation(
  attestation: EvalAttestation,
): Promise<VerifyEvalAttestationResult> {
  // 1. Suite — fail-closed on unknown/missing (crypto CLAUDE.md rule 3).
  if (attestation.suite !== EVAL_ATTESTATION_SUITE) {
    return { valid: false, reason: "unsupported_suite" };
  }

  // 2. eval_kind — closed-registry wire intake. A consumer that cannot
  //    interpret the measurement family must not act on its verdicts.
  if (!EVAL_KINDS_MIRROR.includes(attestation.eval_kind)) {
    return { valid: false, reason: "unknown_eval_kind" };
  }

  // 3. Non-empty results — an attestation that measured nothing is not an
  //    attestation.
  if (!Array.isArray(attestation.results) || attestation.results.length === 0) {
    return { valid: false, reason: "empty_results" };
  }

  // 4. Issuer key shape.
  if (!/^[0-9a-f]{64}$/i.test(attestation.issuer.public_key)) {
    return { valid: false, reason: "malformed_public_key" };
  }
  const publicKey = hexToBytes(attestation.issuer.public_key);

  // 5. Signature bytes.
  let sigBytes: Uint8Array;
  try {
    sigBytes = fromBase64Url(attestation.signature);
  } catch {
    return { valid: false, reason: "malformed_signature" };
  }
  if (sigBytes.length !== 64) {
    return { valid: false, reason: "malformed_signature" };
  }

  // 6. Signature over canonical bytes, via suite dispatch.
  const { signature: _sig, ...unsigned } = attestation;
  const message = canonicalizeForSigning(unsigned);
  let valid: boolean;
  try {
    valid = await verifyBySuite(attestation.suite, message, sigBytes, publicKey);
  } catch {
    return { valid: false, reason: "signature_invalid" };
  }
  if (!valid) {
    return { valid: false, reason: "signature_invalid" };
  }
  return { valid: true };
}
