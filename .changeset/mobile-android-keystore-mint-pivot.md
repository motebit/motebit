---
"@motebit/mobile": patch
---

Pivot the Android mint path from Google Play Integrity to Android Hardware-Backed Keystore Attestation. New native module `expo-android-keystore` calls `KeyPairGenerator + setAttestationChallenge(SHA256(canonical body))` and emits motebit's `{leaf}.{intermediates}` wire format. Mobile cascade on Android: `android_keystore → software` (replaces `play_integrity → software`).

## Why

The verifier-side migration (commit `a428cf9c`) replaced `@motebit/crypto-play-integrity` with `@motebit/crypto-android-keystore` because Play Integrity is structurally per-app-key + Google-API-mediated and cannot satisfy motebit's public-anchor third-party-verifiability invariant. This is the corresponding mint-side change: the mobile app now emits credentials that the new canonical verifier can actually accept.

Until this commit, the deprecation was conceptually shipped but mechanically incomplete — new credentials minted in production were still using the deprecated `platform: "play_integrity"` discriminator. This commit closes that gap.

## What shipped

- `apps/mobile/modules/expo-android-keystore/` — new Expo native module:
  - Kotlin: `KeyPairGenerator + KeyGenParameterSpec.setAttestationChallenge(SHA256 canonical body) + keyStore.getCertificateChain(alias)` flow. Drops the root cert (verifier supplies it from pinned anchors), encodes leaf-first per motebit's wire format. Min SDK 24.
  - iOS stub: rejects with `not_supported` (Android Keystore is Android-only; iOS mint path lives in `expo-app-attest`).
  - TS shim with `AndroidKeystoreError` taxonomy mirroring `AppAttestError` / `SecureEnclaveError`.
- `apps/mobile/src/mint-hardware-credential.ts` — Android cascade switches to `androidKeystoreAvailable + androidKeystoreMint`. Emits `platform: "android_keystore"` (was `"play_integrity"`). iOS cascade unchanged.
- Mobile test fakes / mocks updated accordingly. 354/354 mobile tests pass.

## Compile-validated, runtime-validation pending

The Kotlin and TS code compile clean off-device (TS via `pnpm --filter mobile typecheck`; Kotlin via the standard Expo Android build pipeline). Round-trip validation against a real Pixel / Samsung / OEM Android device is the one remaining step — see `apps/mobile/modules/expo-android-keystore/DEVICE_DAY_CHECKLIST.md` for the smoke-test plan (~10 min on-device).

The old `apps/mobile/modules/expo-play-integrity/` is now dead code (no source consumer). Removing it requires regenerating `ios/Podfile.lock` via `pod install`; deferred to the same commit window as the npm package's 2.0.0 unpublish to avoid touching iOS build infrastructure twice.

Patch — internal mobile-app surface change with no public-API delta beyond what the package-side commit (`a428cf9c`) already captured.
