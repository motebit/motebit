---
"@motebit/crypto-android-keystore": patch
---

Add real Pixel 9a Hardware Keystore Attestation fixtures (TEE + StrongBox variants) and an end-to-end test that runs `verifyAndroidKeystoreAttestation` against them under the production-pinned Google Hardware Attestation root accept-set.

## Why

The package shipped at 1.0.0 with comprehensive synthetic tests — every code path covered by in-process fabricated chains. That proves the LOGIC is correct. It does not, on its own, prove the verifier agrees with what real Android hardware emits in the wild. Closing the real-device fixture deferral on the second public-anchor leaf (after `crypto-webauthn`'s YubiKey ceremony) makes the moat-claim provable across both browser and mobile-Android attestation surfaces.

## What shipped

- `src/__tests__/fixtures/tegu_sdk36_TEE_EC_2026_ROOT.json` — real attestation chain captured from a Google-internal preproduction Pixel 9a (TEE-backed). Lifted from `github.com/android/keyattestation@f39ec0d5` (Apache-2.0; `testdata/tegu/sdk36/TEE_EC_2026_ROOT.{pem,json}`). Chain terminates at motebit's pinned ECDSA P-384 root (`6d9db4ce…`) directly — no `rootPems` override needed.
- `src/__tests__/fixtures/tegu_sdk36_SB_EC_2026_ROOT.json` — same device, StrongBox-backed variant. Exercises `attestationSecurityLevel = STRONG_BOX` (the highest hardware-attestation-semiring-score path).
- `src/__tests__/verify-real-ceremony.test.ts` — four new tests:
  - validates the TEE chain + extension constraints + reports `TRUSTED_ENVIRONMENT` security level + `VERIFIED` boot state;
  - rejects a wrong-`attestationApplicationId` binding;
  - rejects a future-clock validity-window mismatch;
  - validates the StrongBox chain + reports `STRONG_BOX` security level (proves the strongest-tier path against real hardware).

## Privacy posture

Google publishes these captures specifically for downstream verifier consumption. The signing identity (`com.google.android.attestation`, signing-cert SHA-256 `EDk47kU35Z6O55L2VFBPuDRvxrNG0LvEQV/DOfz8jsE=`) is a known shared Google-internal test signer. The devices are pre-production handsets Google explicitly published. Net privacy leak beyond what Google ships in their Apache-2.0 testdata: 0 bits. This is the same pattern as the `crypto-webauthn` Yubico ceremony fixture lifted from `kanidm/webauthn-rs` — first-party, license-clean, intentionally publishable.

## Verifier softwareEnforced fall-through (compatible)

Per AOSP convention since Keymaster 4 (2018), `attestationApplicationId` lives in `softwareEnforced`, not `hardwareEnforced` (the framework computes the package signing-cert hash, not the TEE). Verifier now reads from either list — fall-through is additive; existing synthetic tests that put it in `hardwareEnforced` continue to pass.

Identity-binding (`attestationChallenge === SHA256(motebit canonical body)`) is by design unsatisfiable for a third-party-captured ceremony and is asserted false in the real-ceremony tests. The synthetic suite continues to cover identity-binding semantics.

Test-only addition + a small verifier compatibility tweak. No public-API change. Patch.
