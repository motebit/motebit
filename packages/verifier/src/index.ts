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
// Landing additive-first as the API contract a consumer types its integration
// against; the verify functions that RETURN it ship in the next increment.
// Re-exported so a consumer pinning @motebit/verifier reads the verdict shape
// from the same surface it already consumes.
export type {
  VerificationVerdict,
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
// The receipt-path verdict producer (Phase A.2.1) and the fail-closed collapse.
// `verifyReceiptVerdict` returns the structured verdict for a signed receipt;
// `isFullyVerified` collapses any verdict to the fail-closed boolean (true only
// when every load-bearing axis passes — stricter than the legacy booleans by
// design). The token/grant/revocation verdict path ships in the next increment.
export { verifyReceiptVerdict, isFullyVerified } from "@motebit/crypto";
