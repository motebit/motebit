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
export {
  verifyDelegation,
  verifyStandingDelegation,
  verifyTokenAgainstGrant,
  verifyDelegationRevocation,
  findGrantRevocation,
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
} from "@motebit/crypto";
