import type { NativeModule } from "expo";

/**
 * Result of one atomic `seMintAttestation` call — matches the shape the
 * Rust Secure Enclave bridge emits on desktop
 * (`apps/desktop/src-tauri/src/secure_enclave.rs::SeMintResult`). The TS
 * caller concatenates the two fields with `.` to assemble the wire
 * `attestation_receipt`:
 *
 *   receipt = body_base64 + "." + signature_der_base64
 *
 * `body_base64` decodes to a JCS-canonicalized JSON body with fields:
 *
 *   {
 *     "algorithm": "ecdsa-p256-sha256",
 *     "attested_at": <unix-ms>,
 *     "device_id": "...",
 *     "identity_public_key": "<ed25519-hex-lowercase>",
 *     "motebit_id": "...",
 *     "se_public_key": "<p256-compressed-hex>",
 *     "version": "1"
 *   }
 *
 * `signature_der_base64` is an X9.62 DER-encoded ECDSA P-256 signature
 * over `SHA-256(body_bytes)`, produced by a Secure Enclave-bound key.
 *
 * Keys match the snake_case on-wire shape so the TS mint path can
 * assemble receipts identically on desktop and mobile.
 */
export interface SeMintResult {
  readonly body_base64: string;
  readonly signature_der_base64: string;
}

/**
 * Structured reason for a Secure Enclave failure. Mirrors the desktop
 * `SecureEnclaveError` taxonomy one-for-one so callers can pattern-match
 * the same set of recovery paths regardless of surface.
 *
 *   - `not_supported`     — no SE hardware on this device (every
 *                           iOS simulator, iPhone 5s-era + A7 without
 *                           Secure Enclave, every Android target).
 *                           Mint path degrades to `platform: "software"`.
 *   - `permission_denied` — the user declined a biometric / passcode
 *                           prompt the SE required. Treated as non-fatal;
 *                           also degrades to software.
 *   - `platform_blocked`  — anything else (OOM, unexpected Apple error,
 *                           corrupted keychain state). Degraded the
 *                           same way — a truthful software claim is
 *                           always better than a fake hardware one.
 */
export type SecureEnclaveFailureReason = "not_supported" | "permission_denied" | "platform_blocked";

export interface ExpoSecureEnclaveModuleEvents {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- required by Expo EventsMap constraint
  [key: string]: (event: any) => void;
}

/**
 * Native-module surface. Two commands — symmetric with the desktop Rust
 * bridge so `apps/mobile/src/mint-hardware-credential.ts` and
 * `apps/desktop/src/mint-hardware-credential.ts` can share composition
 * logic via `composeHardwareAttestationCredential` from
 * `@motebit/encryption`.
 */
export declare class ExpoSecureEnclaveModuleType extends NativeModule<ExpoSecureEnclaveModuleEvents> {
  /**
   * Is a Secure Enclave available on this device? `true` on iOS +
   * physical device with a Secure Enclave chip (A7 and later);
   * `false` on simulators, Android, or any device where a throwaway
   * key-gen probe fails. The underlying implementation does a real
   * `SecKeyCreateRandomKey` with `kSecAttrTokenIDSecureEnclave` to
   * avoid lying about capability.
   */
  seAvailable(): Promise<boolean>;

  /**
   * Atomic mint — generate a fresh SE P-256 key, compose the
   * JCS-canonical attestation body (naming the just-generated key),
   * sign with the SE, return both. The key lifetime is scoped to this
   * one native call so "gen then sign as separate calls produces a
   * body that names a different key than the one that signed" cannot
   * happen — exactly the guarantee the Rust desktop path makes.
   *
   * Rejects with a `SecureEnclaveError` (see
   * `./ExpoSecureEnclaveModule.ts`) on any failure. The mint path
   * catches every reason and degrades to a truthful
   * `platform: "software"` claim — the fallback IS the failure mode,
   * by design.
   */
  seMintAttestation(args: {
    motebitId: string;
    deviceId: string;
    identityPublicKeyHex: string;
    attestedAt: number;
  }): Promise<SeMintResult>;
}
