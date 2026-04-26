---
"@motebit/protocol": minor
"@motebit/crypto": minor
"@motebit/crypto-android-keystore": minor
---

Ship `@motebit/crypto-android-keystore` — the canonical Apache-2.0 verifier for Android Hardware-Backed Keystore Attestation. Sibling of `crypto-appattest` / `crypto-tpm` / `crypto-webauthn` in the permissive-floor crypto-leaf set; replaces `crypto-play-integrity` as the sovereign-verifiable Android primitive.

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
