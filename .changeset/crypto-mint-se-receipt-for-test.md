---
"@motebit/crypto": minor
---

Add `mintSecureEnclaveReceiptForTest` test helper.

## Why

Phase 2 of the hardware-attestation peer flow adds end-to-end coverage for the `secure_enclave` platform — proving the same protocol loop the Phase 1 software-sentinel test exercises also works with a real (verified) hardware claim. The existing test helpers (`canonicalSecureEnclaveBodyForTest`, `encodeSecureEnclaveReceiptForTest`) require the caller to supply a P-256 keypair and run ECDSA-SHA256 signing themselves — meaning every cross-workspace test that exercises the SE path has to pull `@noble/curves` into its own dep tree.

`mintSecureEnclaveReceiptForTest` packages the keypair-generate + sign + encode steps into one call. The helper lives behind a lazy import of `@noble/curves/p256` so it's not pulled into the production verifier's import graph.

## What shipped

- New exported test helper `mintSecureEnclaveReceiptForTest({motebit_id, device_id, identity_public_key, attested_at}) => Promise<{claim, sePublicKeyHex}>` produces a `HardwareAttestationClaim` with `platform: "secure_enclave"` whose `attestation_receipt` verifies via `verifyHardwareAttestationClaim` without injected verifiers.
- Production callers MUST still mint receipts via the Rust Secure Enclave bridge — the function name carries `ForTest` for that reason.

Additive; consumers that don't reach for the helper are unaffected. Marked `minor` per semver.
