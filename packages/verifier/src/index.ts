/**
 * @motebit/verifier — MIT library for verifying every signed Motebit
 * artifact.
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
 * like `git` / `libgit2` or `cargo` / `tokio`: MIT library underneath,
 * BSL verb-named CLI on top. Third parties building MIT-only verifiers
 * compose this package and `@motebit/crypto` freely.
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
 *     `play_integrity` / `webauthn` claims. MIT consumers can supply
 *     their own; `@motebit/verify` wires the canonical bundle.
 */

export { verifyFile, verifyArtifact, formatHuman } from "./lib.js";
export type { VerifyFileOptions } from "./lib.js";
export type { VerifyResult, ArtifactType } from "@motebit/crypto";
