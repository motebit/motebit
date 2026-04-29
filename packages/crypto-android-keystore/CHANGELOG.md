# @motebit/crypto-android-keystore

## 1.1.1

### Patch Changes

- Updated dependencies [c8c6312]
- Updated dependencies [2a48142]
- Updated dependencies [cabf61d]
- Updated dependencies [9b4a296]
  - @motebit/protocol@1.2.0
  - @motebit/crypto@1.2.0

## 1.1.0

### Minor Changes

- a428cf9: Ship `@motebit/crypto-android-keystore` — the canonical Apache-2.0 verifier for Android Hardware-Backed Keystore Attestation. Sibling of `crypto-appattest` / `crypto-tpm` / `crypto-webauthn` in the permissive-floor crypto-leaf set; replaces `crypto-play-integrity` as the sovereign-verifiable Android primitive.

  ## Why

  Hardware attestation has three architectural categories — see `docs/doctrine/hardware-attestation.md` § "Three architectural categories". `crypto-play-integrity` was scaffolded as a sovereign-verifiable leaf, but Google's Play Integrity API is per-app-key / network-mediated by deliberate design — verification cannot satisfy motebit's invariant of public-anchor third-party verifiability. Android Hardware-Backed Keystore Attestation IS the architecturally-correct Android primitive: device chains terminate at Google's published Hardware Attestation roots, exactly the FIDO/Apple-App-Attest pattern.

  Time-sensitive: Google rotated the attestation root family between Feb 1 and Apr 10, 2026. The legacy RSA-4096 root stays valid for factory-provisioned devices; new RKP-provisioned devices switched exclusively to ECDSA P-384 after 2026-04-10. Verifiers shipping today MUST pin both — `crypto-android-keystore` does.

  ## What shipped

  ```text
  @motebit/crypto-android-keystore@1.0.0  (initial release)
    src/google-roots.ts            both Google roots pinned with SHA-256 fingerprints + source attribution
    src/asn1.ts                    hand-rolled DER walker for the AOSP KeyDescription extension
    src/verify.ts                  X.509 chain validation + KeyDescription constraint enforcement
    src/index.ts                   androidKeystoreVerifier(...) factory + public types
    src/__tests__/google-roots.test.ts   trust-anchor attestation (parse, fingerprint, validity)
    src/__tests__/verify.test.ts         25 tests covering happy path + every rejection branch
  ```

  Verification: 28/28 tests pass; coverage 86.01% statements / 74.41% branches / 100% functions / 86.01% lines (thresholds 85/70/100/85); typecheck + lint + build clean; `check-deps`, `check-claude-md`, `check-hardware-attestation-primitives` all pass.

  ## Protocol surface threading
  - `@motebit/protocol` — adds `"android_keystore"` to `HardwareAttestationClaim.platform` union.
  - `@motebit/wire-schemas` — adds to the zod enum + regenerates committed JSON schemas.
  - `@motebit/crypto` — adds `androidKeystore` slot to `HardwareAttestationVerifiers` interface + dispatcher case.
  - `@motebit/semiring` — adds `android_keystore` to the hardware-platform scoring case (same `1.0` floor as siblings).

  All additive; no breaking changes. Consumers that don't emit or accept the new platform are unaffected.

  ## Real-fixture coverage

  Synthetic chain coverage exercises every verifier branch via in-process fabricated certs with the AOSP KeyDescription extension. A real-device fixture (matching the WebAuthn moat-claim pass) ships in a follow-up — privacy review needed because Android Keystore chains carry `verifiedBootKey` and `attestationApplicationId` data that may be device-identifying.

### Patch Changes

- 745b22f: Add real Pixel 9a Hardware Keystore Attestation fixtures (TEE + StrongBox variants) and an end-to-end test that runs `verifyAndroidKeystoreAttestation` against them under the production-pinned Google Hardware Attestation root accept-set.

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

- Updated dependencies [a428cf9]
- Updated dependencies [26f38c4]
- Updated dependencies [8405782]
- Updated dependencies [950555c]
- Updated dependencies [9923185]
- Updated dependencies [9858c14]
  - @motebit/protocol@1.1.0
  - @motebit/crypto@1.1.0
