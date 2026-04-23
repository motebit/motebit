# @motebit/verify

The canonical motebit artifact verifier. BSL-1.1, Layer 6 (Applications). Ships a `motebit-verify` CLI that handles every signed motebit artifact — identity files, execution receipts, credentials, presentations — including credentials carrying hardware-attestation claims under any of the four platforms (Apple App Attest, Google Play Integrity, TPM 2.0, WebAuthn).

## The three-package lineage

```
@motebit/verify     this package  BSL L6  CLI `motebit-verify` — the tool a human installs
@motebit/verifier                 MIT L6  Library — file I/O, human formatting helpers
@motebit/crypto                   MIT L0  Primitives — verify, sign, suite dispatch
```

Same shape as the lineages that survive for decades: `git` / `libgit2`, `cargo` / `tokio`, `npm` / `@npm/arborist`. The verb-named tool gets the short name and the BSL license because it aggregates; the library underneath stays MIT and dep-thin so third parties can build their own verifiers without accepting motebit's license terms.

## Why this package exists as the aggregator

`@motebit/verifier` (MIT, L6 library) could have shipped a CLI itself, but that would have forced a choice: either carry the four platform adapter leaves as dependencies (breaking the MIT-only discipline of library consumers) or leave hardware-attestation claims perpetually unverifiable (breaking the self-attesting-system thesis).

Splitting gave us both properties at once. The library stays MIT; the CLI carries the BSL dependencies that end users don't care about at install time. When a third-party auditor wants to reproduce motebit's verification decision in their own MIT-licensed code, they compose `@motebit/crypto` and wire their own verifier adapters. When a human runs `motebit-verify cred.json`, they install one package, get every platform, and type six characters.

## Rules

1. **No new cryptographic logic lives in this package.** It only bundles. Chain verification, signature primitives, semiring scoring, canonical body derivation — all live in their respective leaves. This package's job is wiring. Keeping the BSL surface thin keeps audit cost low.
2. **Defaults match motebit's canonical identifiers.** `com.motebit.mobile` for iOS + Android bundles, `motebit.com` for WebAuthn Relying Party ID. Operators verifying credentials from a fork or federation peer override via CLI flags (`--bundle-id`, `--android-package`, `--rp-id`) or the `HardwareVerifierBundleConfig` object.
3. **No global state, no implicit fetches, no network.** Every adapter pins its own trust anchor at package-bundle time. The Play Integrity JWKS is fail-closed by default until an operator lands real bytes (see `@motebit/crypto-play-integrity`'s CLAUDE.md for the design-gap note).
4. **Dispatch is automatic, not flagged.** `motebit-verify cred.json` routes on the credential's declared platform and runs the right adapter. No `--hardware` flag to remember. A credential without a hardware claim skips the adapters entirely; a credential with `platform: "device_check"` auto-invokes `@motebit/crypto-appattest`. The user just verifies.
5. **Fail-closed, structured errors.** Unknown platform → named error. Missing adapter context → named error. Signature mismatch → named error. Never silent acceptance, never uncaught throw. The CLI's exit codes (0 / 1 / 2) distinguish verified / invalid-but-detected / usage-or-IO.

## Migration from the deprecated `@motebit/verify@0.x`

The original `@motebit/verify@0.7.0` on npm was a zero-dep library with a single `verify()` function. It was deprecated and split:

- The MIT `verify()` library primitive moved to `@motebit/crypto`.
- The CLI and adapter bundling that users wanted is now THIS package (`@motebit/verify@1.0.0`).

Users running `npm install @motebit/verify` in 2026 want the CLI. The new 1.x line delivers that. The old 0.x line stays deprecated on npm with a pointer to both `@motebit/crypto` (library) and `@motebit/verify@1` (CLI).

## Consumers

- Direct end users running `motebit-verify <file>` on the command line.
- Programmatic callers that want the full adapter bundle: `import { buildHardwareVerifiers } from "@motebit/verify"; verifyFile(path, { hardwareAttestation: buildHardwareVerifiers() })`.
- Future relay / federation paths that want the full-platform verdict for trust-elevation decisions.
