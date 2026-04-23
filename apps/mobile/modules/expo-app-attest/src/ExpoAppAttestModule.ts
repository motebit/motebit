/**
 * TS shim for the Expo App Attest native module.
 *
 * Two high-level helpers callers actually import:
 *
 *   - `appAttestAvailable()`     → boolean.
 *   - `appAttestMint(args)`      → `AppAttestMintResult`, or throws
 *                                  a typed `AppAttestError`.
 *
 * Sibling of `ExpoSecureEnclaveModule.ts` — same error taxonomy, same
 * atomic-mint contract, same dependency-injection shape for tests.
 *
 * Android: every call rejects with `not_supported`. Play Integrity
 * lands in a later pass as its own metabolic leaf
 * (`@motebit/crypto-play-integrity` + `expo-play-integrity`).
 */

import { requireNativeModule } from "expo";

import type {
  AppAttestFailureReason,
  AppAttestMintResult,
  ExpoAppAttestModuleType,
} from "./ExpoAppAttest.types";

/**
 * Typed error raised by `appAttestMint`. `reason` is structured so the
 * mint path pattern-matches recovery instead of parsing opaque
 * messages — direct parallel to `SecureEnclaveError`.
 */
export class AppAttestError extends Error {
  constructor(
    public readonly reason: AppAttestFailureReason,
    message?: string,
  ) {
    super(message ?? reason);
    this.name = "AppAttestError";
  }
}

const KNOWN_REASONS: ReadonlySet<AppAttestFailureReason> = new Set<AppAttestFailureReason>([
  "not_supported",
  "permission_denied",
  "platform_blocked",
]);

function toAppAttestError(err: unknown): AppAttestError {
  if (err instanceof AppAttestError) return err;
  const rec = err as { code?: unknown; message?: unknown } | null;
  const code = typeof rec?.code === "string" ? rec.code : undefined;
  const reason: AppAttestFailureReason =
    code && KNOWN_REASONS.has(code as AppAttestFailureReason)
      ? (code as AppAttestFailureReason)
      : "platform_blocked";
  const message =
    typeof rec?.message === "string"
      ? rec.message
      : err instanceof Error
        ? err.message
        : String(err);
  return new AppAttestError(reason, message);
}

const nativeModule = requireNativeModule<ExpoAppAttestModuleType>("ExpoAppAttest");

/**
 * Test-injection handle. Matches `NativeSecureEnclave`'s shape — a
 * plain object with `appAttestAvailable` and `appAttestMint`. Tests
 * pass a fake; production uses the default-loaded Expo module.
 */
export type NativeAppAttest = Pick<ExpoAppAttestModuleType, "appAttestAvailable" | "appAttestMint">;

export async function appAttestAvailable(native: NativeAppAttest = nativeModule): Promise<boolean> {
  try {
    return await native.appAttestAvailable();
  } catch {
    return false;
  }
}

export async function appAttestMint(
  args: {
    readonly motebitId: string;
    readonly deviceId: string;
    readonly identityPublicKeyHex: string;
    readonly attestedAt: number;
  },
  native: NativeAppAttest = nativeModule,
): Promise<AppAttestMintResult> {
  try {
    return await native.appAttestMint(args);
  } catch (err) {
    throw toAppAttestError(err);
  }
}

export default nativeModule;
