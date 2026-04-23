# @motebit/verify

The canonical motebit artifact verifier. BSL-1.1, Layer 6 (Applications). Ships a `motebit-verify` CLI that handles every signed motebit artifact — identity files, execution receipts, credentials, presentations — including credentials carrying hardware-attestation claims under any of the four platforms (Apple App Attest, Google Play Integrity, TPM 2.0, WebAuthn).

## The three-package lineage

```
@motebit/verify     this package  BSL         L6  CLI `motebit-verify` — the tool a human installs
@motebit/verifier                 Apache-2.0  L6  Library — file I/O, human formatting helpers
@motebit/crypto                   Apache-2.0  L0  Primitives — verify, sign, suite dispatch
```

Same shape as the lineages that survive for decades: `git` / `libgit2`, `cargo` / `tokio`, `npm` / `@npm/arborist`. The verb-named tool gets the short name and the BSL license because it carries motebit-canonical aggregation — the opinionated defaults (bundle IDs, RP ID, integrity floor) and CLI ergonomics that represent motebit's particular composition of the permissive-floor leaves. The library underneath stays dep-thin Apache-2.0, and the four platform verifiers are themselves Apache-2.0 (each answers "how is this artifact verified?" against a published public trust anchor — the permissive side of the protocol-model boundary test).

## Why this package exists as the aggregator

`@motebit/verifier` (Apache-2.0, L6 library) stays dep-thin on purpose: file I/O, `formatHuman`, and the injection point for an optional hardware-attestation verifier. Pulling the four platform adapters into it would force every permissive-floor-library consumer to accept the `cbor2` / `@peculiar/x509` dep surface and motebit's specific root-pin choices, even when the consumer just wants to verify software identity files.

Splitting lets the library stay a deterministic primitive and lets this package carry the motebit-canonical wiring — default bundle IDs `com.motebit.mobile`, default RP ID `motebit.com`, default integrity floor `MEETS_DEVICE_INTEGRITY`, CLI argument shape. A third-party auditor who wants to reproduce motebit's verification decision in their own Apache-2.0-licensed code composes `@motebit/crypto` + `@motebit/verifier` + any subset of the four Apache-2.0 `@motebit/crypto-*` leaves — and pins the roots they trust. A human running `motebit-verify cred.json` installs one BSL package and gets motebit's opinionated composition out of the box.

## Rules

1. **No new cryptographic logic lives in this package.** It only bundles. Chain verification, signature primitives, semiring scoring, canonical body derivation — all live in their respective leaves. This package's job is wiring. Keeping the BSL surface thin keeps audit cost low.
2. **Defaults match motebit's canonical identifiers.** `com.motebit.mobile` for iOS + Android bundles, `motebit.com` for WebAuthn Relying Party ID. Operators verifying credentials from a fork or federation peer override via CLI flags (`--bundle-id`, `--android-package`, `--rp-id`) or the `HardwareVerifierBundleConfig` object.
3. **No global state, no implicit fetches, no network.** Every adapter pins its own trust anchor at package-bundle time. The Play Integrity JWKS is fail-closed by default until an operator lands real bytes (see `@motebit/crypto-play-integrity`'s CLAUDE.md for the design-gap note).
4. **Dispatch is automatic, not flagged.** `motebit-verify cred.json` routes on the credential's declared platform and runs the right adapter. No `--hardware` flag to remember. A credential without a hardware claim skips the adapters entirely; a credential with `platform: "device_check"` auto-invokes `@motebit/crypto-appattest`. The user just verifies.
5. **Fail-closed, structured errors.** Unknown platform → named error. Missing adapter context → named error. Signature mismatch → named error. Never silent acceptance, never uncaught throw. The CLI's exit codes (0 / 1 / 2) distinguish verified / invalid-but-detected / usage-or-IO.

## Migration from the deprecated `@motebit/verify@0.x`

The original `@motebit/verify@0.7.0` on npm was a zero-dep library with a single `verify()` function. It was deprecated and split:

- The permissive-floor `verify()` library primitive moved to `@motebit/crypto` (Apache-2.0).
- The CLI and adapter bundling that users wanted is now THIS package (`@motebit/verify@1.0.0`).

Users running `npm install @motebit/verify` in 2026 want the CLI. The new 1.x line delivers that. The old 0.x line stays deprecated on npm with a pointer to both `@motebit/crypto` (library) and `@motebit/verify@1` (CLI).

## Consumers

- Direct end users running `motebit-verify <file>` on the command line.
- Programmatic callers that want the full adapter bundle: `import { buildHardwareVerifiers } from "@motebit/verify"; verifyFile(path, { hardwareAttestation: buildHardwareVerifiers() })`.
- Future relay / federation paths that want the full-platform verdict for trust-elevation decisions.
