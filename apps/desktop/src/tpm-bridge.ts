/**
 * Tauri bridge for the Rust TPM 2.0 commands (Windows / Linux).
 *
 * Thin wrapper — converts the Tauri rejection shape (`FailureEnvelope`
 * with `reason`/`message`) into typed `TpmError`s so the high-level
 * `mintTpmAttestationClaim` path can pattern-match on structured
 * failure reasons (`not_supported` → fall back to `platform:
 * "software"` claim; `permission_denied` → surface to user;
 * `platform_blocked` → log + fail closed).
 *
 * Mirrors `secure-enclave-bridge.ts` shape so the TS side has ONE
 * failure taxonomy across every hardware-attestation platform adapter.
 */

import type { InvokeFn } from "./tauri-storage.js";

export interface TpmMintResult {
  readonly tpms_attest_base64: string;
  readonly signature_base64: string;
  readonly ak_cert_der_base64: string;
  readonly intermediates_comma_joined_base64: string;
}

export type TpmFailureReason = "not_supported" | "permission_denied" | "platform_blocked";

/**
 * Typed error thrown when the Rust TPM bridge reports a structured
 * failure. Callers pattern-match on `reason` to decide recovery —
 * `not_supported` is expected on macOS / Linux without `/dev/tpm0` /
 * Windows without TPM 2.0, so the mint path downgrades to a
 * `platform: "software"` claim rather than surfacing an error to
 * the user.
 */
export class TpmError extends Error {
  constructor(
    public readonly reason: TpmFailureReason,
    message?: string,
  ) {
    super(message ?? reason);
    this.name = "TpmError";
  }
}

interface FailureEnvelope {
  readonly reason: string;
  readonly message: string;
}

const KNOWN_REASONS: ReadonlySet<TpmFailureReason> = new Set<TpmFailureReason>([
  "not_supported",
  "permission_denied",
  "platform_blocked",
]);

function isFailureEnvelope(value: unknown): value is FailureEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    "reason" in value &&
    typeof (value as Record<string, unknown>).reason === "string"
  );
}

function toTpmError(err: unknown): TpmError {
  if (isFailureEnvelope(err)) {
    const reason = KNOWN_REASONS.has(err.reason as TpmFailureReason)
      ? (err.reason as TpmFailureReason)
      : "platform_blocked";
    return new TpmError(reason, err.message);
  }
  const message = err instanceof Error ? err.message : String(err);
  return new TpmError("platform_blocked", message);
}

/**
 * Is a TPM 2.0 available on this device? `true` on Windows / Linux
 * with a probed TPM; `false` on macOS (Secure Enclave is the macOS
 * path) and on hosts without `tss-esapi` linked.
 *
 * Today's ship returns `false` on every platform until the operator
 * wires `tss-esapi` in the Rust build graph — see the Rust module
 * docstring in `apps/desktop/src-tauri/src/tpm.rs`.
 */
export async function tpmAvailable(invoke: InvokeFn): Promise<boolean> {
  try {
    return await invoke<boolean>("tpm_available");
  } catch {
    return false;
  }
}

/**
 * Atomic mint — asks the Rust side to (1) generate or fetch the TPM's
 * Attestation Key, (2) compose a `TPMS_ATTEST` structure binding the
 * motebit canonical body via extraData, (3) sign with AK, and (4)
 * return the attest bytes, signature, AK cert (DER), and any
 * intermediate certs. The TS caller assembles the wire
 * `attestation_receipt` as the 4-part base64url JWS-shape.
 *
 * Throws `TpmError` on any failure with a typed `reason` so the mint
 * path can gracefully degrade to a `platform: "software"` claim.
 */
export async function tpmMintQuote(
  invoke: InvokeFn,
  args: {
    readonly motebitId: string;
    readonly deviceId: string;
    readonly identityPublicKeyHex: string;
    readonly attestedAt: number;
  },
): Promise<TpmMintResult> {
  try {
    return await invoke<TpmMintResult>("tpm_mint_quote", args);
  } catch (err) {
    throw toTpmError(err);
  }
}
