import type { NativeModule } from "expo";

/**
 * Result of one atomic `appAttestMint` call — the three base64url
 * segments the TS caller concatenates with `.` to assemble the wire
 * `attestation_receipt`:
 *
 *   receipt = attestation_object_base64 + "." + key_id_base64 + "." + client_data_hash_base64
 *
 * `attestation_object_base64` decodes to the CBOR-encoded Apple
 * attestation object (`{fmt:"apple-appattest", attStmt:{x5c,receipt}, authData}`).
 * `key_id_base64` is the hardware-bound keypair identifier.
 * `client_data_hash_base64` is `SHA-256(canonical_body_json)` where the
 * body names motebit_id, device_id, identity_public_key, attested_at.
 *
 * Keys match the snake_case wire shape so the TS mint path assembles
 * receipts identically across desktop / SE / AppAttest mint paths.
 */
export interface AppAttestMintResult {
  readonly attestation_object_base64: string;
  readonly key_id_base64: string;
  readonly client_data_hash_base64: string;
}

/**
 * Structured reason for an App Attest failure — same taxonomy as
 * Secure Enclave (`not_supported`, `permission_denied`,
 * `platform_blocked`). Keeps the mobile mint path's error-handling
 * shape uniform across both platform adapters.
 */
export type AppAttestFailureReason = "not_supported" | "permission_denied" | "platform_blocked";

export interface ExpoAppAttestModuleEvents {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- required by Expo EventsMap constraint
  [key: string]: (event: any) => void;
}

/**
 * Native-module surface. Two commands — symmetric with
 * ExpoSecureEnclave so mint-hardware-credential can cascade AppAttest
 * → SE → software with parallel error handling.
 */
export declare class ExpoAppAttestModuleType extends NativeModule<ExpoAppAttestModuleEvents> {
  /**
   * Is Apple App Attest available on this device?
   * `DCAppAttestService.isSupported` — gates on device hardware (A11
   * or later) and iOS version. `false` on simulator, Android, and
   * older hardware. The underlying service is the authority; this
   * probe does not heuristically guess.
   */
  appAttestAvailable(): Promise<boolean>;

  /**
   * Atomic keygen → clientDataHash → attest. Returns all three
   * base64url segments the TS shim needs to assemble the wire
   * `attestation_receipt`. Rejects with a typed error on any failure.
   */
  appAttestMint(args: {
    motebitId: string;
    deviceId: string;
    identityPublicKeyHex: string;
    attestedAt: number;
  }): Promise<AppAttestMintResult>;
}
