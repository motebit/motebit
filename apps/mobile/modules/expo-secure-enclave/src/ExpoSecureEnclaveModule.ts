/**
 * TS shim for the Expo Secure Enclave native module.
 *
 * Two high-level helpers callers actually import:
 *
 *   - `seAvailable()`         → resolves with a boolean.
 *   - `seMintAttestation(a)`  → resolves with `SeMintResult`, or throws
 *                               a typed `SecureEnclaveError`.
 *
 * The module is a direct sibling of `apps/desktop/src/secure-enclave-bridge.ts`
 * — same error taxonomy, same atomic-mint contract. The desktop bridge
 * calls a Rust/Tauri command; this one calls a Swift/Expo native module.
 * Everything downstream (claim composition, VC envelope, verification)
 * is shared through `@motebit/encryption`'s
 * `composeHardwareAttestationCredential`, so the two surfaces produce
 * byte-identical credentials given the same inputs.
 *
 * Android: every call rejects with `not_supported`. Play Integrity lands
 * in a later pass behind the same result shape.
 */

import { requireNativeModule } from "expo";

import type {
  ExpoSecureEnclaveModuleType,
  SecureEnclaveFailureReason,
  SeMintResult,
} from "./ExpoSecureEnclave.types";

/**
 * Typed error thrown by `seMintAttestation` (and therefore by the
 * native module's rejected promises, once this shim normalizes them).
 * `reason` is structured so the mint path pattern-matches recovery
 * instead of parsing opaque messages — a direct sibling of
 * `apps/desktop/src/secure-enclave-bridge.ts::SecureEnclaveError`.
 *
 * Kept local to this module rather than extracted to a shared package
 * because v1 has two surface-specific error shapes (Tauri's
 * FailureEnvelope and Expo's rejection) feeding the same semantic
 * taxonomy. Extraction is deferred until a third surface lands.
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

const KNOWN_REASONS: ReadonlySet<SecureEnclaveFailureReason> = new Set<SecureEnclaveFailureReason>([
  "not_supported",
  "permission_denied",
  "platform_blocked",
]);

/**
 * Expo native-module rejections come through as an `Error` whose
 * `code` property carries the structured reason (Expo surfaces
 * `Exception(code:description:)` this way). We lift the code back into
 * a typed `SecureEnclaveError`; unknown codes fall through to
 * `platform_blocked` — fail-closed is correct for an unclassified SE
 * error.
 */
function toSecureEnclaveError(err: unknown): SecureEnclaveError {
  if (err instanceof SecureEnclaveError) return err;
  const rec = err as { code?: unknown; message?: unknown } | null;
  const code = typeof rec?.code === "string" ? rec.code : undefined;
  const reason: SecureEnclaveFailureReason =
    code && KNOWN_REASONS.has(code as SecureEnclaveFailureReason)
      ? (code as SecureEnclaveFailureReason)
      : "platform_blocked";
  const message =
    typeof rec?.message === "string"
      ? rec.message
      : err instanceof Error
        ? err.message
        : String(err);
  return new SecureEnclaveError(reason, message);
}

// This call loads the native module object from the JSI.
const nativeModule = requireNativeModule<ExpoSecureEnclaveModuleType>("ExpoSecureEnclave");

/**
 * Wrapper layer that normalizes native errors to `SecureEnclaveError`
 * and exposes the two commands as free functions. Following the
 * desktop bridge's free-function shape — each function takes a
 * "native module" parameter for dependency injection in tests.
 *
 * Default export is the plain native module; named exports wrap it.
 * Tests pass a fake `NativeModule` to exercise the same code paths
 * without linking the real iOS framework.
 */
export type NativeSecureEnclave = Pick<
  ExpoSecureEnclaveModuleType,
  "seAvailable" | "seMintAttestation"
>;

export async function seAvailable(native: NativeSecureEnclave = nativeModule): Promise<boolean> {
  try {
    return await native.seAvailable();
  } catch {
    // Defensive: a native-module failure on the availability probe means
    // "no SE path available" — never an error surfaced to the user.
    return false;
  }
}

export async function seMintAttestation(
  args: {
    readonly motebitId: string;
    readonly deviceId: string;
    readonly identityPublicKeyHex: string;
    readonly attestedAt: number;
  },
  native: NativeSecureEnclave = nativeModule,
): Promise<SeMintResult> {
  try {
    return await native.seMintAttestation(args);
  } catch (err) {
    throw toSecureEnclaveError(err);
  }
}

export default nativeModule;
