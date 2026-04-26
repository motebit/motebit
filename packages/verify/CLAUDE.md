# @motebit/verify

The canonical `motebit-verify` command-line tool. Apache-2.0 (permissive floor), Layer 6 (Applications). Ships the `motebit-verify` binary that handles every signed motebit artifact — identity files, execution receipts, credentials, presentations — including credentials carrying hardware-attestation claims under any of the four canonical sovereign-verifiable platforms (Apple App Attest, Android Hardware-Backed Keystore Attestation, TPM 2.0, WebAuthn). The deprecated Google Play Integrity adapter is also bundled for one minor cycle so already-minted credentials continue to verify; new mobile builds emit `platform: "android_keystore"` and Play Integrity will be removed at `@motebit/crypto-play-integrity@2.0.0`. See `docs/doctrine/hardware-attestation.md` § "Three architectural categories" for the structural reason.

The `-er`-suffixed sibling [`@motebit/verifier`](../verifier/) is the _library_; this package is the _binary_. Same lineage as `git`/`libgit2`, `cargo`/`tokio`, `npm`/`@npm/arborist` — verb = tool a human installs, agent-noun = library code links against.

## The three-package lineage

```
@motebit/verify     this package  Apache-2.0  L6  CLI `motebit-verify` — the tool a human installs
@motebit/verifier                 Apache-2.0  L6  Library — file I/O, human formatting helpers
@motebit/crypto                   Apache-2.0  L0  Primitives — verify, sign, suite dispatch
```

Same shape as the lineages that survive for decades: `git` / `libgit2`, `cargo` / `tokio`, `npm` / `@npm/arborist`. The verb-named tool gets the short name and carries motebit-canonical aggregation — the default bundle IDs, RP ID, integrity floor, and CLI ergonomics that represent motebit's particular composition of the permissive-floor leaves. The license stays permissive because the aggregation is structurally thin: flag defaults, adapter wiring, argument parsing. No trust scoring, no economics, no federation routing — none of motebit's actual moats live here. The platform verifiers and the library underneath are Apache-2.0 for the same reason: each one answers "how is this artifact verified?" against a published public trust anchor (Apple App Attest root, Google Hardware Attestation roots, TPM vendor roots, FIDO roots).

## Why this package exists as the aggregator

`@motebit/verifier` (Apache-2.0, L6 library) stays dep-thin on purpose: file I/O, `formatHuman`, and the injection point for an optional hardware-attestation verifier. Pulling the platform adapters into it would force every library consumer to accept the `cbor2` / `@peculiar/x509` dep surface and motebit's specific root-pin choices, even when the consumer just wants to verify software identity files.

Splitting lets the library stay a deterministic primitive and lets this package carry the motebit-canonical wiring — default bundle IDs `com.motebit.mobile`, default RP ID `motebit.com`, default integrity floor `MEETS_DEVICE_INTEGRITY`, CLI argument shape. A third-party auditor who wants to reproduce motebit's verification decision in their own Apache-2.0-licensed code composes `@motebit/crypto` + `@motebit/verifier` + any subset of the `@motebit/crypto-*` platform leaves (`crypto-appattest`, `crypto-android-keystore`, `crypto-tpm`, `crypto-webauthn`, plus the deprecated `crypto-play-integrity` for one minor cycle) and pins the roots they trust. A human running `motebit-verify cred.json` installs one permissive-floor package and gets motebit's opinionated composition out of the box — no license friction in CI pipelines, enterprise audit tooling, or third-party verifier integrations.

The BSL line holds at `motebit` (the operator console) and everything below it: daemon, MCP server, delegation routing, market integration, federation wiring — where the actual reference-implementation judgment lives. `motebit verify <path>` inside the operator console covers identity files + VCs + VPs as a convenience for operators who already have the runtime. This package covers hardware-attestation claims end-to-end for users who don't want the full runtime.

## Rules

1. **No new cryptographic logic lives in this package.** It only bundles. Chain verification, signature primitives, semiring scoring, canonical body derivation — all live in their respective leaves. This package's job is wiring. Keeping the aggregator surface thin keeps audit cost low and keeps the package on the permissive floor.
2. **Defaults match motebit's canonical identifiers.** `com.motebit.mobile` for iOS + Android bundles, `motebit.com` for WebAuthn Relying Party ID. Operators verifying credentials from a fork or federation peer override via CLI flags (`--bundle-id`, `--android-package`, `--rp-id`) or the `HardwareVerifierBundleConfig` object. The defaults are conveniences, not doctrine.
3. **No global state, no implicit fetches, no network.** Every adapter pins its own trust anchor at package-bundle time. The Play Integrity JWKS is fail-closed by default until an operator lands real bytes (see `@motebit/crypto-play-integrity`'s CLAUDE.md for the design-gap note).
4. **Dispatch is automatic, not flagged.** `motebit-verify cred.json` routes on the credential's declared platform and runs the right adapter. No `--hardware` flag to remember. A credential without a hardware claim skips the adapters entirely; a credential with `platform: "device_check"` auto-invokes `@motebit/crypto-appattest`. The user just verifies.
5. **Fail-closed, structured errors.** Unknown platform → named error. Missing adapter context → named error. Signature mismatch → named error. Never silent acceptance, never uncaught throw. The CLI's exit codes (0 / 1 / 2) distinguish verified / invalid-but-detected / usage-or-IO.

## Migration from the deprecated `@motebit/verify@0.x`

The original `@motebit/verify@0.7.0` on npm was a zero-dep MIT library with a single `verify()` function. It was deprecated and split:

- The permissive-floor `verify()` library primitive moved to `@motebit/crypto` (Apache-2.0).
- The CLI and adapter bundling that users wanted is now THIS package (`@motebit/verify@1.0.0`, Apache-2.0).

Users running `npm install @motebit/verify` in 2026 want the CLI. The new 1.x line delivers that under Apache-2.0, giving the same permissive footing the original 0.x line had plus an explicit patent grant. The old 0.x line stays deprecated on npm with a pointer to both `@motebit/crypto` (library) and `@motebit/verify@1` (CLI).

## Consumers

- Direct end users running `motebit-verify <file>` on the command line.
- CI pipelines and enterprise audit tooling that install `@motebit/verify` as a one-shot verifier.
- Programmatic callers that want the full adapter bundle: `import { buildHardwareVerifiers } from "@motebit/verify"; verifyFile(path, { hardwareAttestation: buildHardwareVerifiers() })`.
- Future relay / federation paths that want the full-platform verdict for trust-elevation decisions.
