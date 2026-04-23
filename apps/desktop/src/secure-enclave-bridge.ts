/**
 * Tauri bridge for the Rust Secure Enclave commands.
 *
 * Thin wrapper — converts the Tauri rejection shape (`FailureEnvelope`
 * with `reason`/`message`) into typed `SecureEnclaveError`s so the
 * high-level `secure-enclave-attest` mint path can pattern-match on
 * structured failure reasons (`not_supported` → fall back to
 * `platform: "software"` claim; `permission_denied` → surface to
 * user; `platform_blocked` → log + fail closed).
 */

import type { InvokeFn } from "./tauri-storage.js";

export interface SeMintResult {
  readonly body_base64: string;
  readonly signature_der_base64: string;
}

export type SecureEnclaveFailureReason = "not_supported" | "permission_denied" | "platform_blocked";

/**
 * Typed error thrown when the Rust SE bridge reports a structured
 * failure. Callers pattern-match on `reason` to decide recovery —
 * `not_supported` is expected on non-Apple Silicon or non-macOS, so
 * the mint path downgrades to a `platform: "software"` claim rather
 * than surfacing an error to the user.
 */
export class SecureEnclaveError extends Error {
  constructor(
    public readonly reason: SecureEnclaveFailureReason,
    message?: string,
  ) {
    super(message ?? reason);
    this.name = "SecureEnclaveError";
  }
}

interface FailureEnvelope {
  readonly reason: string;
  readonly message: string;
}

const KNOWN_REASONS: ReadonlySet<SecureEnclaveFailureReason> = new Set<SecureEnclaveFailureReason>([
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

function toSecureEnclaveError(err: unknown): SecureEnclaveError {
  if (isFailureEnvelope(err)) {
    const reason = KNOWN_REASONS.has(err.reason as SecureEnclaveFailureReason)
      ? (err.reason as SecureEnclaveFailureReason)
      : "platform_blocked";
    return new SecureEnclaveError(reason, err.message);
  }
  const message = err instanceof Error ? err.message : String(err);
  return new SecureEnclaveError("platform_blocked", message);
}

/**
 * Is a Secure Enclave available on this device? `true` on macOS
 * builds; `false` elsewhere. The Rust side's v1 heuristic is
 * platform-gated — a more precise probe (attempt a throwaway keygen)
 * is a follow-up.
 */
export async function seAvailable(invoke: InvokeFn): Promise<boolean> {
  try {
    return await invoke<boolean>("se_available");
  } catch {
    // If the Tauri invoke itself fails, we have no SE path. Treat as
    // "not available" — graceful degradation, no user-facing error.
    return false;
  }
}

/**
 * Atomic mint — asks the Rust side to (1) generate a fresh SE P-256
 * key, (2) compose the canonical attestation body including the key,
 * (3) sign with SE, and (4) return `(body_base64, signature_der_base64)`.
 * The TS caller concatenates the two with `.` to assemble the wire
 * `attestation_receipt`.
 *
 * Atomic because the SE is ephemeral in v1 — "generate then sign"
 * as separate calls would produce two different keys. Keeping the
 * key lifetime scoped to one Rust function call avoids the
 * bootstrapping round-trip.
 *
 * Throws `SecureEnclaveError` on any failure with a typed `reason`
 * so the mint path can gracefully degrade to a `platform: "software"`
 * claim.
 */
export async function seMintAttestation(
  invoke: InvokeFn,
  args: {
    readonly motebitId: string;
    readonly deviceId: string;
    readonly identityPublicKeyHex: string;
    readonly attestedAt: number;
  },
): Promise<SeMintResult> {
  try {
    return await invoke<SeMintResult>("se_mint_attestation", args);
  } catch (err) {
    throw toSecureEnclaveError(err);
  }
}
