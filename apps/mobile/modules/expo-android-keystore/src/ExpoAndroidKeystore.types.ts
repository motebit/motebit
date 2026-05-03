import type { NativeModule } from "expo";

/**
 * Result of one atomic `androidKeystoreMint` call — the receipt the
 * caller passes through as the wire `attestation_receipt` for a
 * `platform: "android_keystore"` claim. Wire format mirrors the
 * verifier's expectation in `@motebit/crypto-android-keystore`:
 *
 *   `{leafCertB64}.{intermediatesJoinedB64}`
 *
 * — leaf-first DER chain, comma-joined intermediates, root cert
 * dropped (the verifier supplies it from the pinned trust anchors).
 *
 * `challenge_base64url` is the SHA-256 of the canonical body the
 * Kotlin side composed and passed to `setAttestationChallenge`. The
 * verifier re-derives it from the caller's identity fields and
 * byte-compares against the leaf cert's `attestationChallenge`
 * extension field — surfacing it here keeps the cross-stack binding
 * auditable at every layer (same pattern as Play Integrity's
 * `nonce_base64url`).
 */
export interface AndroidKeystoreMintResult {
  readonly receipt: string;
  readonly challenge_base64url: string;
}

/**
 * Structured reason for an Android Keystore failure — same taxonomy
 * as App Attest / Secure Enclave / Play Integrity (`not_supported`,
 * `permission_denied`, `platform_blocked`). Keeps the mobile mint
 * path's error-handling shape uniform across every platform adapter.
 *
 * `not_supported` fires on iOS (Android Keystore is Android-only) and
 * on Android-without-TEE (rare but possible — software-only
 * attestation is rejected at the verifier side, so failing here keeps
 * the cascade simple).
 *
 * `platform_blocked` covers Keystore exceptions: device disallowed
 * key generation, TEE busy, attestation challenge too large, etc.
 *
 * `permission_denied` fires only if device policy / MDM bars
 * application-attested key generation — uncommon in the consumer
 * fleet but real on managed enterprise devices.
 */
export type AndroidKeystoreFailureReason =
  | "not_supported"
  | "permission_denied"
  | "platform_blocked";

export interface ExpoAndroidKeystoreModuleEvents {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- required by Expo EventsMap constraint
  [key: string]: (event: any) => void;
}

/**
 * Native-module surface. Two commands — symmetric with
 * `ExpoAppAttest` / `ExpoSecureEnclave` so `mint-hardware-credential.ts`
 * can cascade `androidKeystore` (Android) / `appAttest` (iOS) /
 * `secureEnclave` (iOS fallback) / software with parallel error handling.
 */
export declare class ExpoAndroidKeystoreModuleType extends NativeModule<ExpoAndroidKeystoreModuleEvents> {
  /**
   * Is Android Hardware-Backed Keystore Attestation available on this
   * device?
   *
   * Android: KeyStore is part of the platform since API 18; the actual
   * gate is whether the device has a hardware-backed Keystore (TEE or
   * StrongBox). Returns true on every modern Android device — the
   * Keystore-availability probe is `KeyStore.getInstance("AndroidKeyStore")`
   * which never throws. The hardware-backing gate is enforced at the
   * VERIFIER side via `attestationSecurityLevel ≥ TRUSTED_ENVIRONMENT`,
   * not here.
   *
   * iOS: always `false` — Android Keystore is Android-only. iOS mint
   * path lives in `ExpoAppAttest`.
   */
  androidKeystoreAvailable(): Promise<boolean>;

  /**
   * Atomic challenge-compose →
   * `KeyPairGenerator.setAttestationChallenge` → return cert chain
   * encoded as motebit's wire format. Rejects with a typed error on
   * any failure.
   */
  androidKeystoreMint(args: {
    motebitId: string;
    deviceId: string;
    identityPublicKeyHex: string;
    attestedAt: number;
  }): Promise<AndroidKeystoreMintResult>;
}
