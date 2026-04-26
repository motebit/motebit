---
"@motebit/verify": minor
---

Add `--android-attestation-application-id <path>` CLI flag — closes the gap between the README's four-platform parity claim and what `motebit-verify` actually wired.

## Why

Surfaced by a published-READMEs audit on 2026-04-26 (same shape as the `verifier↔verify` 2026-04-09 swap that was caught later in this session): `packages/verify/README.md` advertised CLI parity for the four canonical sovereign-verifiable platforms, but the CLI exposed flags only for App Attest (`--bundle-id`), the deprecated Play Integrity (`--android-package`), and WebAuthn (`--rp-id`). The new canonical Android primitive — `crypto-android-keystore`, shipped 2026-04-26 (commit `a428cf9c`) — requires `androidKeystoreExpectedAttestationApplicationId` (raw bytes) at wiring time, and `buildHardwareVerifiers` only wires the `androidKeystore` arm if those bytes are supplied. So a user verifying an `android_keystore` credential via `motebit-verify` was hitting "verifier not wired" with no flag-level recourse — published-surface claim that the implementation didn't satisfy.

## What shipped

- `--android-attestation-application-id <path>` flag accepts a path to a binary file containing the raw bytes of the leaf cert's `attestationApplicationId` extension. Operators capture this once at build time (deterministic from the registered Android package name + signing-cert SHA-256) and commit the file alongside other pinned config. File-only intentionally — the typical AAID is 50–200 bytes and unwieldy on the command line as hex.
- CLI threads the read bytes through `buildHardwareVerifiers({ androidKeystoreExpectedAttestationApplicationId })`. Without the flag, the Android Keystore arm stays unwired (passing a placeholder would false-reject every real claim); the dispatcher reports `"verifier not wired"`. With the flag, `android_keystore` credentials verify end-to-end against the production-pinned Google Hardware Attestation roots.
- I/O errors (missing path, unreadable file) emit a clear stderr message and exit code 2.
- Help text reframed: `PLATFORMS WIRED (canonical)` lists App Attest / TPM / Android Keystore / WebAuthn; `PLATFORMS WIRED (deprecated)` lists Play Integrity with the structural-mismatch reason. The `--android-package` flag is documented as configuring the deprecated path.
- Updated CLI module-doc comment + README usage example to reflect the new flag and the four-canonical-plus-one-deprecated framing.

## Plus two cosmetic README fixes (same audit pass)

- `packages/verifier/README.md` — programmatic-usage example showed `result.receipt?.signer`; `signer` is on the top-level `ReceiptVerifyResult`, not nested under `receipt`. Wouldn't typecheck under strict TS. Corrected.
- `apps/cli/README.md` — Windows troubleshooting recommended `npm install -g windows-build-tools`; that package was deprecated by its maintainer in 2018 and doesn't function on Node 18+ (motebit requires Node ≥ 20). Replaced with current Microsoft guidance (Visual Studio Build Tools installer + "Desktop development with C++" workload).

Additive. No public-API surface change beyond the new optional flag. All existing invocations continue to work unchanged.
