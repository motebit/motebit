/**
 * TS shim for the Expo Android Hardware-Backed Keystore Attestation
 * native module.
 *
 * Two high-level helpers callers actually import:
 *
 *   - `androidKeystoreAvailable()` → boolean.
 *   - `androidKeystoreMint(args)`  → `AndroidKeystoreMintResult`, or
 *                                    throws a typed `AndroidKeystoreError`.
 *
 * Sibling of `ExpoAppAttestModule.ts` / `ExpoSecureEnclaveModule.ts` /
 * the deprecated `ExpoPlayIntegrityModule.ts` — same error taxonomy,
 * same atomic-mint contract, same dependency-injection shape for tests.
 *
 * Replaces `ExpoPlayIntegrity` as the canonical Android mint path.
 * Play Integrity was structurally miscategorized as a sovereign-
 * verifiable leaf — see
 * `packages/crypto-play-integrity/CLAUDE.md` and
 * `docs/doctrine/hardware-attestation.md` § "Three architectural
 * categories". Android Hardware-Backed Keystore Attestation is the
 * architecturally-correct primitive: device attestation chains
 * terminate at Google's published Hardware Attestation roots, exactly
 * the FIDO/Apple-App-Attest pattern.
 *
 * iOS: every call rejects with `not_supported`. iOS mint path lives in
 * `ExpoAppAttest`.
 */

import { requireNativeModule } from "expo";

import type {
  AndroidKeystoreFailureReason,
  AndroidKeystoreMintResult,
  ExpoAndroidKeystoreModuleType,
} from "./ExpoAndroidKeystore.types";

/**
 * Typed error raised by `androidKeystoreMint`. `reason` is structured
 * so the mint path pattern-matches recovery instead of parsing opaque
 * messages — direct parallel to `AppAttestError` / `SecureEnclaveError`
 * / `PlayIntegrityError`.
 */
export class AndroidKeystoreError extends Error {
  constructor(
    public readonly reason: AndroidKeystoreFailureReason,
    message?: string,
  ) {
    super(message ?? reason);
    this.name = "AndroidKeystoreError";
  }
}

const KNOWN_REASONS: ReadonlySet<AndroidKeystoreFailureReason> =
  new Set<AndroidKeystoreFailureReason>(["not_supported", "permission_denied", "platform_blocked"]);

function toAndroidKeystoreError(err: unknown): AndroidKeystoreError {
  if (err instanceof AndroidKeystoreError) return err;
  const rec = err as { code?: unknown; message?: unknown } | null;
  const code = typeof rec?.code === "string" ? rec.code : undefined;
  const reason: AndroidKeystoreFailureReason =
    code && KNOWN_REASONS.has(code as AndroidKeystoreFailureReason)
      ? (code as AndroidKeystoreFailureReason)
      : "platform_blocked";
  const message =
    typeof rec?.message === "string"
      ? rec.message
      : err instanceof Error
        ? err.message
        : String(err);
  return new AndroidKeystoreError(reason, message);
}

const nativeModule = requireNativeModule<ExpoAndroidKeystoreModuleType>("ExpoAndroidKeystore");

/**
 * Test-injection handle. Matches `NativeAppAttest` /
 * `NativeSecureEnclave` / `NativePlayIntegrity` — a plain object with
 * `androidKeystoreAvailable` and `androidKeystoreMint`. Tests pass a
 * fake; production uses the default-loaded Expo module.
 */
export type NativeAndroidKeystore = Pick<
  ExpoAndroidKeystoreModuleType,
  "androidKeystoreAvailable" | "androidKeystoreMint"
>;

export async function androidKeystoreAvailable(
  native: NativeAndroidKeystore = nativeModule,
): Promise<boolean> {
  try {
    return await native.androidKeystoreAvailable();
  } catch {
    return false;
  }
}

export async function androidKeystoreMint(
  args: {
    readonly motebitId: string;
    readonly deviceId: string;
    readonly identityPublicKeyHex: string;
    readonly attestedAt: number;
  },
  native: NativeAndroidKeystore = nativeModule,
): Promise<AndroidKeystoreMintResult> {
  try {
    return await native.androidKeystoreMint(args);
  } catch (err) {
    throw toAndroidKeystoreError(err);
  }
}

export default nativeModule;
