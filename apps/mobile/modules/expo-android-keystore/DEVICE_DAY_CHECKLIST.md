# Device-day round-trip checklist — `expo-android-keystore`

The TS shim, Kotlin native module, and mobile mint cascade are committed and compile-validated off-device. Validation against real hardware is one focused pass on a Pixel / Samsung / OEM Android device. This checklist is the smoke-test plan.

## Pre-flight (one-time)

- [ ] An Android device with a hardware-backed Keystore (TEE or StrongBox). Pixel 6+ recommended (StrongBox-equipped); any modern non-rooted device works.
- [ ] USB debugging enabled (Settings → System → Developer options → USB debugging).
- [ ] `adb devices` shows the device. ADB is part of the Android SDK; the Expo dev pipeline picks it up automatically.

## Round-trip flow (~10 min)

```bash
# 1. Install the dev build on the device.
cd apps/mobile
pnpm expo run:android --device <serial>

# 2. In the running app, trigger a fresh identity mint.
#    The flow that emits a `platform: "android_keystore"` claim is the
#    onboarding path that calls `mintHardwareCredential` from
#    `apps/mobile/src/mint-hardware-credential.ts`.
#    (If onboarding is already complete, clear app data:
#     `adb shell pm clear com.motebit.mobile`.)

# 3. Capture the credential.
#    The mint result lands in the app's identity store. Pull the
#    persisted credential JSON via `adb shell run-as com.motebit.mobile cat <path>`,
#    or surface it via a debug-only menu item.

# 4. Round-trip verify off-device.
#    Run the cli verify against the captured credential:
pnpm --filter '@motebit/verify' build
node packages/verify/dist/cli.js \
  --credential <path-to-captured-credential.json> \
  --android-keystore-package-id <captured attestationApplicationId in base64>
```

Expected outcome: `valid: true` if device boot is verified + signing-cert matches expected. If it's a userdebug / unlocked-bootloader Pixel (`verifiedBootState: SELF_SIGNED` or `UNVERIFIED`), the verifier will report `verifiedBootState not in allowlist [VERIFIED]` — pass `--allow-self-signed-boot` (or equivalent verifier option) to expand the allowlist.

## Likely failure modes (and where to look)

- **`AndroidKeystoreError: not_supported`** — device API < 24 (pre-Android-7), or Keystore provider missing. Cascade degrades to software automatically; check `adb logcat | grep ExpoAndroidKeystore`.
- **`AndroidKeystoreError: platform_blocked` with `KeyStoreException` in the message** — device denied attestation key generation. Common on heavily-locked-down enterprise MDM devices. Cascade degrades to software.
- **Verifier rejects with `attestation_extension_valid: false`** + "missing extension" — the device returned a software-only chain (no TEE backing). Look at `attestationSecurityLevel` in the leaf. If it says `SOFTWARE`, the device's Keystore implementation didn't reach the TEE — file under "device-specific bug" and check the device's Settings → Security → Encryption & credentials → Keystore.
- **Verifier rejects with `cert_chain_valid: false`** — the device's chain terminates at an unexpected root. Check `adb logcat` for the leaf cert's subject + issuer; compare against `DEFAULT_ANDROID_KEYSTORE_TRUST_ANCHORS` in `packages/crypto-android-keystore/src/google-roots.ts`. If the device chains to a vendor-OEM root not in motebit's pinned set, that's a doctrine-level decision (add the root or reject the device class).
- **Verifier rejects with `verifiedBootState not in allowlist`** — bootloader unlocked or userdebug build. Either lock the bootloader for the test, expand the allowlist via `verifiedBootStateAllowlist` option, or accept that this device is intentionally outside motebit's default trust class.

## What to commit on success

- Bump `apps/mobile`'s app version + changelog note "Android mint path migrated to Hardware-Backed Keystore Attestation".
- (Optional) Capture the round-trip's leaf cert + `attestationApplicationId` and add to `packages/crypto-android-keystore/src/__tests__/fixtures/` as a motebit-canonical real-device fixture (separate commit with privacy review).
- Delete `apps/mobile/modules/expo-play-integrity/` — once round-trip succeeds the old module is unambiguously dead code. (Defer the delete + `pod install` until the next non-iOS-build commit window.)
- Bump `apps/mobile/package.json` minSdk to 24 if not already there (required for `setAttestationChallenge`).
