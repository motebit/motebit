/**
 * TS shim for the Expo Play Integrity native module.
 *
 * Two high-level helpers callers actually import:
 *
 *   - `playIntegrityAvailable()` → boolean.
 *   - `playIntegrityMint(args)`  → `PlayIntegrityMintResult`, or throws
 *                                  a typed `PlayIntegrityError`.
 *
 * Sibling of `ExpoAppAttestModule.ts` / `ExpoSecureEnclaveModule.ts` —
 * same error taxonomy, same atomic-mint contract, same
 * dependency-injection shape for tests.
 *
 * iOS: every call rejects with `not_supported`. iOS mint path lives in
 * `ExpoAppAttest`.
 */

import { requireNativeModule } from "expo";

import type {
  ExpoPlayIntegrityModuleType,
  PlayIntegrityFailureReason,
  PlayIntegrityMintResult,
} from "./ExpoPlayIntegrity.types";

/**
 * Typed error raised by `playIntegrityMint`. `reason` is structured so
 * the mint path pattern-matches recovery instead of parsing opaque
 * messages — direct parallel to `AppAttestError` / `SecureEnclaveError`.
 */
export class PlayIntegrityError extends Error {
  constructor(
    public readonly reason: PlayIntegrityFailureReason,
    message?: string,
  ) {
    super(message ?? reason);
    this.name = "PlayIntegrityError";
  }
}

const KNOWN_REASONS: ReadonlySet<PlayIntegrityFailureReason> = new Set<PlayIntegrityFailureReason>([
  "not_supported",
  "permission_denied",
  "platform_blocked",
]);

function toPlayIntegrityError(err: unknown): PlayIntegrityError {
  if (err instanceof PlayIntegrityError) return err;
  const rec = err as { code?: unknown; message?: unknown } | null;
  const code = typeof rec?.code === "string" ? rec.code : undefined;
  const reason: PlayIntegrityFailureReason =
    code && KNOWN_REASONS.has(code as PlayIntegrityFailureReason)
      ? (code as PlayIntegrityFailureReason)
      : "platform_blocked";
  const message =
    typeof rec?.message === "string"
      ? rec.message
      : err instanceof Error
        ? err.message
        : String(err);
  return new PlayIntegrityError(reason, message);
}

const nativeModule = requireNativeModule<ExpoPlayIntegrityModuleType>("ExpoPlayIntegrity");

/**
 * Test-injection handle. Matches `NativeAppAttest` / `NativeSecureEnclave`
 * — a plain object with `playIntegrityAvailable` and `playIntegrityMint`.
 * Tests pass a fake; production uses the default-loaded Expo module.
 */
export type NativePlayIntegrity = Pick<
  ExpoPlayIntegrityModuleType,
  "playIntegrityAvailable" | "playIntegrityMint"
>;

export async function playIntegrityAvailable(
  native: NativePlayIntegrity = nativeModule,
): Promise<boolean> {
  try {
    return await native.playIntegrityAvailable();
  } catch {
    return false;
  }
}

export async function playIntegrityMint(
  args: {
    readonly motebitId: string;
    readonly deviceId: string;
    readonly identityPublicKeyHex: string;
    readonly attestedAt: number;
  },
  native: NativePlayIntegrity = nativeModule,
): Promise<PlayIntegrityMintResult> {
  try {
    return await native.playIntegrityMint(args);
  } catch (err) {
    throw toPlayIntegrityError(err);
  }
}

export default nativeModule;
