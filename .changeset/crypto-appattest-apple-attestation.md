---
"@motebit/crypto-appattest": minor
"@motebit/crypto": patch
"@motebit/mobile": patch
---

Ship `@motebit/crypto-appattest` — the Apple App Attest chain verifier. Verifies a `HardwareAttestationClaim` with `platform: "device_check"` by decoding Apple's CBOR attestation object, chain-verifying the leaf + intermediate against the pinned Apple App Attestation Root CA, checking the `1.2.840.113635.100.8.2` nonce-binding extension against `SHA256(authData || clientDataHash)`, and asserting `authData.rpIdHash === SHA256(bundleId)`. BSL-1.1 Layer 2 — metabolizes `@peculiar/x509` + `cbor2` so `@motebit/crypto` stays MIT-pure.

`@motebit/crypto::verifyHardwareAttestationClaim` now accepts an optional `HardwareAttestationVerifiers` record; consumers wire `deviceCheckVerifier(...)` from `@motebit/crypto-appattest` into `verify(cred, { hardwareAttestation: { deviceCheck } })` to enable App Attest verification. Unwired platforms fail-closed with a named-missing-adapter error. The dispatcher's return type is now `HardwareAttestationVerifyResult | Promise<HardwareAttestationVerifyResult>` — the SE path remains synchronous; injected adapters may return a Promise.

Mobile mint path now cascades App Attest → Secure Enclave → software via the new `expo-app-attest` native module (iOS `DCAppAttestService`, Android stub). The canonical composer `composeHardwareAttestationCredential` and the drift gates stay unchanged — every surface still delegates VC envelope + eddsa-jcs-2022 signing to the single source of truth.
