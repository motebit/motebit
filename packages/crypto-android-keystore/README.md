# @motebit/crypto-android-keystore

Offline Apache-2.0 verifier for Android Hardware-Backed Keystore Attestation hardware-attestation credentials.

```bash
npm i @motebit/crypto-android-keystore
```

Plugs into [`@motebit/crypto`](https://www.npmjs.com/package/@motebit/crypto)'s `HardwareAttestationVerifiers` dispatcher as the `androidKeystore` verifier — called when a credential declares `platform: "android_keystore"` (Android devices with KeyMaster 3+ / KeyMint 1+ — every modern Android device since Android 7).

## Usage

```ts
import { verify } from "@motebit/crypto";
import { androidKeystoreVerifier } from "@motebit/crypto-android-keystore";

const result = await verify(credential, {
  hardwareAttestation: {
    androidKeystore: androidKeystoreVerifier({
      // Bytes of the registered Android package's `attestationApplicationId`,
      // captured at registration time. Must byte-equal what the leaf
      // attestation extension reports.
      expectedAttestationApplicationId,
    }),
  },
});
```

## What it verifies

1. **Cert chain to a pinned Google Hardware Attestation root.** Two roots ship pinned: the legacy RSA-4096 root (for factory-provisioned devices) and the modern ECDSA P-384 root (for RKP-provisioned devices). Verifiers MUST pin both — Google rotated from RSA to ECDSA between Feb–Apr 2026, so a verifier pinning only one drops half its install base.
2. **The Android Key Attestation extension** (OID `1.3.6.1.4.1.11129.2.1.17`) on the leaf — `attestationVersion ≥ 3` (Keymaster 3 / Android 7+), `attestationSecurityLevel ≥ TRUSTED_ENVIRONMENT` (rejects software-only fallback), `hardwareEnforced.rootOfTrust.verifiedBootState` in caller's allowlist (default `[VERIFIED]`), `hardwareEnforced.attestationApplicationId` byte-equals the registered package binding.
3. **Optional revocation snapshot.** Caller-supplied snapshot keyed by lowercase-hex serial number, mirroring Google's published shape at `https://android.googleapis.com/attestation/status`. Defaults to empty (no revocation enforcement). The verifier never fetches at runtime — `@motebit/verify` ships an embedded snapshot at release time.
4. **Identity binding.** The leaf's `attestationChallenge` must byte-equal `SHA-256(canonicalJson({ attested_at, device_id, identity_public_key, motebit_id, platform: "android_keystore", version: "1" }))` — the same body the Kotlin `expo-android-keystore` mint path composes. A malicious client that substitutes any other body fails here.

## Why pinned

A verifier that dynamically fetched Google's attestation roots has no sovereign story. The pinned roots are the self-attesting contract — third parties audit `DEFAULT_ANDROID_KEYSTORE_TRUST_ANCHORS` and know which trust anchors this library accepts. Source of truth: `roots.json` in [`android/keyattestation`](https://github.com/android/keyattestation), Google's canonical Kotlin reference verifier.

## Why a hand-rolled DER walker

The `KeyDescription` ASN.1 structure has ~50 optional context-tagged fields in `AuthorizationList`, two of which carry policy-relevant material (`[704] rootOfTrust` and `[709] attestationApplicationId`). A schema-driven parser would have to declare all 50 fields just to skip past the ones we ignore. Walking the DER directly costs ~150 lines and stays scoped to exactly what verification needs — same trade-off [`@motebit/crypto-tpm`](https://www.npmjs.com/package/@motebit/crypto-tpm) made for `TPMS_ATTEST` parsing.

## Privacy posture

Closer to FIDO Yubico-batch than to TPM EK. The leaf X.509 subject is the fixed string `CN=Android Keystore Key` — not device-identifying. The optional ID-attestation family (`attestationIdSerial`, `attestationIdImei`, etc.) only fires when the caller invokes `setDevicePropertiesAttestationIncluded(true)`; motebit does not. Default `setAttestationChallenge()` produces batch-shareable chains with the device-identifying material confined to (a) the caller-controlled challenge and (b) `verifiedBootKey` (boot-image identity, not user identity).

## Related

- [`@motebit/crypto`](https://www.npmjs.com/package/@motebit/crypto) — dispatcher (pure permissive-floor; zero deps)
- [`@motebit/crypto-appattest`](https://www.npmjs.com/package/@motebit/crypto-appattest) — iOS sibling
- [`@motebit/crypto-tpm`](https://www.npmjs.com/package/@motebit/crypto-tpm) — Windows / Linux TPM sibling
- [`@motebit/crypto-webauthn`](https://www.npmjs.com/package/@motebit/crypto-webauthn) — browser sibling
- [`@motebit/verify`](https://www.npmjs.com/package/@motebit/verify) — canonical CLI bundling all four leaves with motebit defaults

## License

Apache-2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

"Motebit" is a trademark. The Apache License grants rights to this software, not to any Motebit trademarks, logos, or branding. You may not use Motebit branding in a way that suggests endorsement or affiliation without written permission.
