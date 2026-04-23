# @motebit/verifier-hardware

Hardware-attestation-aware CLI + library companion to `@motebit/verifier`. BSL-1.1, Layer 6 (Applications). Bundles the four platform adapter leaves (`@motebit/crypto-appattest`, `@motebit/crypto-tpm`, `@motebit/crypto-play-integrity`, `@motebit/crypto-webauthn`) into a single `motebit-verify-hw` binary + a `buildHardwareVerifiers()` factory that produces the `HardwareAttestationVerifiers` record `@motebit/verifier::verifyFile` expects.

## Why this package exists

`@motebit/verifier` is MIT and dep-thin — it never imports the BSL platform leaves so it can be distributed as a standalone npm tool under MIT's license boundary. But that means `motebit-verify` on a credential carrying `platform: device_check | tpm | play_integrity | webauthn` returns `hardware: <platform> ✗ — adapter not yet shipped`. The self-attesting-system invariant says any third party should be able to verify any motebit artifact; that invariant was holding only for Secure-Enclave-attested credentials.

This package closes the gap. It's BSL because it pulls in the four BSL leaves; installing it gets you a `motebit-verify-hw` binary that verifies every platform end-to-end (chain + nonce + bundle + identity binding).

## Rules

1. **No new cryptographic logic.** This package only wires existing verifiers. Any crypto-specific code lands in the leaf packages; this one stays a thin bundle so the BSL surface area of the "full" verifier stays reviewable.
2. **Defaults match motebit's canonical identifiers.** `com.motebit.mobile` for iOS + Android bundles, `motebit.com` for WebAuthn Relying Party ID. Operators verifying credentials from a fork or federation peer override via CLI flags or `HardwareVerifierBundleConfig`.
3. **No global state, no implicit fetches, no network.** Every adapter pins its own trust anchor at package-bundle time; this package adds no additional runtime surface.
4. **`@motebit/verifier` (MIT) remains usable standalone.** Its API accepts an optional `HardwareAttestationVerifiers` record — passing one is what this package does. If a user wants the MIT-only path, they skip this package. If they want the complete verifier, they install both.
5. **Same sovereignty posture as the individual leaves.** The CLI rejects unknown platforms fail-closed, reports the exact failure channel per platform, and never silently accepts.

## Consumers

- Direct end users running `motebit-verify-hw <file>` on the command line against a hardware-attested credential.
- Programmatic callers wiring `buildHardwareVerifiers()` into `verifyFile({ hardwareAttestation })` from `@motebit/verifier`.
- Future relay / federation paths that want the full-platform verdict for trust-elevation decisions.
