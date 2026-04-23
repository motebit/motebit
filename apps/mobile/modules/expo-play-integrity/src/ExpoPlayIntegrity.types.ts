import type { NativeModule } from "expo";

/**
 * Result of one atomic `playIntegrityMint` call — the raw JWT string
 * Google's Play Integrity API emitted. The TS caller passes this
 * directly through as the wire `attestation_receipt` (JWT is already
 * a three-segment `header.payload.signature` shape — no further
 * composition required).
 *
 * The `nonce_base64url` is returned for audit / test purposes — the
 * verifier re-derives it from the canonical body and compares against
 * `payload.nonce` inside the JWT, so the TS shim doesn't need it at
 * runtime, but surfacing it keeps the cross-stack binding auditable
 * at every layer.
 */
export interface PlayIntegrityMintResult {
  readonly jwt: string;
  readonly nonce_base64url: string;
}

/**
 * Structured reason for a Play Integrity failure — same taxonomy as
 * App Attest / Secure Enclave (`not_supported`, `permission_denied`,
 * `platform_blocked`). Keeps the mobile mint path's error-handling
 * shape uniform across every platform adapter.
 */
export type PlayIntegrityFailureReason = "not_supported" | "permission_denied" | "platform_blocked";

export interface ExpoPlayIntegrityModuleEvents {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- required by Expo EventsMap constraint
  [key: string]: (event: any) => void;
}

/**
 * Native-module surface. Two commands — symmetric with
 * ExpoAppAttest / ExpoSecureEnclave so mint-hardware-credential can
 * cascade AppAttest (iOS) / PlayIntegrity (Android) / SE (iOS fallback)
 * / software with parallel error handling.
 */
export declare class ExpoPlayIntegrityModuleType extends NativeModule<ExpoPlayIntegrityModuleEvents> {
  /**
   * Is Google Play Integrity available on this device?
   *
   * Android: uses the Play-services probe (Google Play Services + Play
   * Store must be present; `IntegrityManagerFactory.create` succeeds).
   * iOS: always `false` — Play Integrity is Android-only. iOS mint
   * path lives in `ExpoAppAttest`.
   */
  playIntegrityAvailable(): Promise<boolean>;

  /**
   * Atomic nonce-compose → `requestIntegrityToken` → return JWT.
   * Rejects with a typed error on any failure.
   */
  playIntegrityMint(args: {
    motebitId: string;
    deviceId: string;
    identityPublicKeyHex: string;
    attestedAt: number;
  }): Promise<PlayIntegrityMintResult>;
}
