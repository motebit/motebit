/**
 * @motebit/verifier — Apache-2.0 permissive-floor library for verifying every
 * signed Motebit artifact.
 *
 * The moat: anything a motebit signs (identity file, execution receipt,
 * credential, presentation) is third-party verifiable with only this
 * package and the signer's public key — no relay contact, no motebit
 * runtime, no network. This module is the smallest public library
 * surface of that promise.
 *
 * Library-only as of v1.0. The `motebit-verify` CLI moved to the BSL
 * `@motebit/verify` package, which layers bundled hardware-attestation
 * adapters (Apple App Attest, TPM 2.0, Google Play Integrity, WebAuthn)
 * on top of this library. The split mirrors long-lived tool lineages
 * like `git` / `libgit2` or `cargo` / `tokio`: permissive-floor library
 * underneath, BSL verb-named CLI on top. Third parties building
 * permissive-floor-only verifiers compose this package and
 * `@motebit/crypto` freely — Apache-2.0 carries an explicit patent grant.
 *
 * Composition:
 *
 *   - `verifyFile(path, opts?)` — read an artifact off disk, detect its
 *     kind, return the typed `VerifyResult` from `@motebit/crypto`.
 *   - `verifyArtifact(content, opts?)` — same, but accept the artifact
 *     already-loaded (string for identity, object or JSON string for
 *     JSON artifacts).
 *   - `formatHuman(result)` — render a `VerifyResult` as the
 *     multi-line human-readable output a CLI would print.
 *   - `VerifyFileOptions.hardwareAttestation` — optional injection of
 *     platform-specific verifiers for `device_check` / `tpm` /
 *     `play_integrity` / `webauthn` claims. Permissive-floor consumers can
 *     supply their own; `@motebit/verify` wires the canonical bundle.
 */

export { verifyFile, verifyArtifact, verifySkillDirectory, formatHuman } from "./lib.js";
export type { VerifyFileOptions, VerifyResultWithBinding } from "./lib.js";
// Re-exported from the browser-safe `@motebit/crypto` primitive so consumers
// already depending on this library can verify a human-consent decision (the
// "approve" governance band) without adding a second dependency. `ApprovalDecision`
// is NOT an auto-detected artifact type (it has no `motebit_id → key` binding
// ladder — see docs/developer/governance-triad.mdx); it is verified explicitly
// against a pinned approver key, never against its own embedded key alone.
export { verifyApprovalDecision } from "@motebit/crypto";
// The delegation family (delegation@1.0 + standing-delegation@1.0). Like
// `verifyApprovalDecision`, these are NOT auto-detected artifact types: a
// delegation's authority is the scope/chain + (for a standing grant) the
// signed revocation feed, not a `motebit_id → key` binding ladder resolvable
// from the artifact alone. They are verified explicitly. Re-exported here so a
// consumer already pinning `@motebit/verifier` can validate a standing
// monitor's authorization root, every per-tick token (against its grant), and
// a revocation without adding `@motebit/crypto` as a second dependency.
//   - verifyDelegation          — a standalone or per-tick token's own signature + expiry
//   - verifyStandingDelegation  — the grant (signature, activation, expiry, injected revocation seam)
//   - verifyTokenAgainstGrant   — a per-tick token IS a valid tick of its grant
//   - verifyDelegationRevocation — a revocation's signature (caller binds it to the grant)
//   - findGrantRevocation       — the consumer-side revocation check done right (binds revocation→grant; build `isRevoked` from it)
//   - subjectBindingDigest      — canonical digest of a detached subject-scope artifact (standing-delegation@1.1)
//   - verifySubjectBinding      — the presented scope artifact matches the grant's signed `subject_binding`, fail-closed
export {
  verifyDelegation,
  verifyStandingDelegation,
  verifyTokenAgainstGrant,
  verifyDelegationRevocation,
  findGrantRevocation,
  subjectBindingDigest,
  verifySubjectBinding,
} from "@motebit/crypto";
// Signed request envelope (signed-request-envelope@1.0). Explicitly re-exported
// like the delegation family — verified against the identity's REGISTERED key
// (resolved by the caller from `motebit_id`), never a key the request carries.
export { signRequestEnvelope, verifyRequestEnvelope } from "@motebit/crypto";
export type { SignedRequestEnvelope } from "@motebit/crypto";
// Settlement invoice (settlement-invoice@1.0). Explicitly re-exported like the
// delegation family — both artifacts are verified against the ISSUER's registered
// key (the carried key, if present, must match it), never a key the artifact alone
// vouches for. The two digest helpers are mandated so a consumer's receipt_digest /
// cost_attestation_digest bindings reproduce by construction.
export {
  executionReceiptDigest,
  costAttestationDigest,
  verifyCostAttestation,
  verifyInvoice,
} from "@motebit/crypto";
// Completed-withdrawal receipt verification — an external consumer with the
// market-v1 §2.9 wire record can confirm a completed withdrawal offline,
// through the pinned aggregate (never a crypto fork). See the withdrawal
// arm of `check-signed-artifact-verifiers`.
export { verifyWithdrawalReceipt } from "@motebit/crypto";
export type { WithdrawalReceiptPayload } from "@motebit/protocol";
export type {
  CostAttestationV1,
  InvoiceV1,
  CostAttestationVerdict,
  InvoiceVerdict,
} from "@motebit/crypto";
export type {
  VerifyResult,
  ArtifactType,
  SkillVerifyResult,
  SkillFileVerifyResult,
  ApprovalDecision,
  DelegationToken,
  StandingDelegation,
  DelegationRevocation,
  SubjectBindingV1,
} from "@motebit/crypto";
// The structured verification verdict (the VerificationVerdict arc — see
// docs/doctrine/verify-family-fail-closed.md § "The VerificationVerdict arc").
// The verdict shape a consumer types its integration against, re-exported so a
// consumer pinning @motebit/verifier reads it from the same surface it already
// consumes.
export type {
  VerificationVerdict,
  VerdictSubject,
  IntegrityVerdict,
  IdentityBindingVerdict,
  AuthorityVerdict,
  RevocationStatus,
  RevocationVerdict,
  RevocationFreshness,
  TemporalBasis,
  EvidenceRef,
  RepairInstruction,
} from "@motebit/crypto";
// Evidence provenance (docs/doctrine/evidence-provenance.md) — verifiable-locality
// extended from signatures to EVIDENCE. A verdict's `evidenceBasis: EvidenceRef[]`
// carries optional `provenance`; `verifyEvidenceProvenance` is the law that
// re-checks it (the named `span` is an exact substring of `projection(bytes)`,
// bytes content-addressed by `digest` — PRESENCE, never truth). Re-exported here
// so a consumer pinning @motebit/verifier can re-check evidence from the SAME
// surface it consumes — never reaching past the aggregator into @motebit/crypto
// (the agency-proof-integration contract: consume the verifier, never fork it).
export type {
  EvidenceProvenance,
  EvidenceProvenanceResult,
  DigestRef,
  DigestAlgorithm,
  // The projection assurance class a consumer reads off `provenance.projectionClass`
  // to policy on re-verifiability (`spec-reproducible` vs `tool-pinned`; absent ⇒
  // spec-reproducible). Surfaced from the SAME aggregator the consumer pins.
  ProjectionClass,
} from "@motebit/crypto";
// The verdict producers and the fail-closed collapse. `verifyReceiptVerdict`
// (A.2.1) returns the structured verdict for a signed receipt;
// `verifyDelegationTokenVerdict` (A.2.2) does so for a per-tick token against
// its standing grant (authority + revocation orthogonal; temporalMode selects
// the temporal basis); `isFullyVerified` collapses any verdict to the
// fail-closed boolean (true only when every load-bearing axis passes — stricter
// than the legacy booleans by design).
export {
  verifyReceiptVerdict,
  verifyDelegationTokenVerdict,
  isFullyVerified,
} from "@motebit/crypto";
// The evidence-provenance re-check law (pure, I/O-free; the projection recipe is
// an injected, app-owned seam, so a present projection with no resolver fails
// closed). Paired with the verdict's `EvidenceRef.provenance` above.
export { verifyEvidenceProvenance } from "@motebit/crypto";

// The public-verification-surface laws (widened 2026-07-08 for the Auditor
// archetype — services consume ONLY this aggregator, never @motebit/crypto
// directly, per check-service-primitives; the consume-never-fork contract
// extends to every law an auditor composes). NOT auto-detected — each is
// verified explicitly against artifacts the caller fetched:
//   - verifySovereignBinding: the identity rung law (motebit_id commits to
//     the genesis key; offline, no operator).
//   - verifyKeySuccession / verifySuccessionChain: key-lineage laws over the
//     self-signed succession chain a relay serves publicly.
//   - verifyBondCommitment: the anti-sybil address-binding + self-signature
//     law (bonded_address MUST equal the bonded key's Solana address).
//   - verifyMerkleInclusion: RFC 6962-shaped inclusion proofs (settlement
//     anchors, identity-transparency bundles).
export {
  verifySovereignBinding,
  verifyKeySuccession,
  verifySuccessionChain,
  verifyBondCommitment,
  verifyMerkleInclusion,
} from "@motebit/crypto";

// EvalAttestation — the signed third-party-measurement artifact the Auditor
// issues (subject ≠ signer; docs/doctrine/evals-as-attestations.md, promoted
// 2026-07-08; spec/eval-attestation-v1.md). The sign side is re-exported for
// issuer services (the signRequestEnvelope precedent); the verify law
// establishes "this issuer said this about this subject" and deliberately
// never measurement truth / issuer authority / key→id binding / freshness —
// consumers re-check the cited evidence via verifyEvidenceProvenance and the
// verdict producers above.
export {
  signEvalAttestation,
  verifyEvalAttestation,
  EVAL_ATTESTATION_SUITE,
} from "@motebit/crypto";
export type { VerifyEvalAttestationResult } from "@motebit/crypto";
export type { EvalAttestation, EvalResult, EvalKind } from "@motebit/protocol";
