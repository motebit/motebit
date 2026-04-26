/**
 * @motebit/crypto-tpm — TPM 2.0 quote chain-verification adapter for
 * motebit hardware-attestation claims.
 *
 * The metabolic leaf `@motebit/crypto` delegates to when a
 * `HardwareAttestationClaim` declares `platform: "tpm"`. Dep-thin
 * `@motebit/crypto` stays permissive-floor-pure; this package, also on
 * the permissive floor (Apache-2.0), metabolizes `@peculiar/x509` plus
 * a minimal hand-rolled TPM parser to judge whether a vendor-published
 * Endorsement-Key CA rooted the Attestation Key that signed the caller's
 * TPM2_Quote.
 *
 * Wiring from a consumer:
 *
 * ```ts
 * import { verify } from "@motebit/crypto";
 * import { tpmVerifier } from "@motebit/crypto-tpm";
 *
 * const result = await verify(credential, {
 *   hardwareAttestation: { tpm: tpmVerifier() },
 * });
 * ```
 *
 * This package exports no global state, no side-effect registrations;
 * the injection is call-site only. Pinned vendor roots live in
 * `./tpm-roots.ts` and are the self-attesting audit surface.
 */

import type { HardwareAttestationClaim } from "@motebit/protocol";

import { verifyTpmQuote } from "./verify.js";
import type { TpmVerifyOptions, TpmVerifyResult } from "./verify.js";

export { verifyTpmQuote } from "./verify.js";
export type { TpmVerifyOptions, TpmVerifyResult, TpmVerifyError } from "./verify.js";
export {
  parseTpmsAttest,
  composeTpmsAttestForTest,
  TPM_GENERATED_VALUE,
  TPM_ST_ATTEST_QUOTE,
  type TpmsAttest,
} from "./tpm-parse.js";
export {
  DEFAULT_PINNED_TPM_ROOTS,
  INFINEON_TPM_EK_ROOT_PEM,
  NUVOTON_TPM_EK_ROOT_PEM,
  STMICRO_TPM_EK_RSA_ROOT_PEM,
  STMICRO_TPM_EK_ECC_ROOT_PEM,
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- maintained for one minor cycle; consumers should migrate to the explicit RSA / ECC constants. Removed in 2.0.0.
  STMICRO_TPM_EK_ROOT_PEM,
  INTEL_PTT_EK_ROOT_PEM,
  TPM_PLATFORM,
} from "./tpm-roots.js";

/**
 * Shape the optional verifier injected into `@motebit/crypto`'s
 * `HardwareAttestationVerifiers.tpm` slot carries — mirrors the
 * sync-or-async return shape the dispatcher supports.
 */
export interface TpmVerifierResult {
  readonly valid: boolean;
  readonly platform: "tpm";
  readonly errors: ReadonlyArray<{ readonly message: string }>;
  readonly attestation_detail?: TpmVerifyResult;
}

/**
 * VC-subject fields that participate in the JCS body the TPM's
 * extraData binds. motebit_id / device_id / attested_at participate
 * alongside identity_public_key; without them the verifier cannot tie
 * the quote to the caller's Ed25519 identity.
 *
 * All fields optional: a caller that omits one loses the
 * identity-binding channel but still gets chain / signature / shape
 * results — the verifier reports the missing channel explicitly
 * rather than silently passing.
 *
 * The canonical path threads these per-credential through the
 * `@motebit/crypto::verify` dispatcher: the dispatcher lifts them from
 * `credentialSubject` and passes them as the third argument to the
 * `tpm` verifier slot. Consumers wiring `tpmVerifier()` into
 * `hardwareAttestation.tpm` get identity binding for free. An
 * alternative path — baking a context into the factory via
 * `TpmVerifierConfig.context` — is retained for direct callers and
 * tests; the dispatcher-supplied context wins when both are present.
 */
export interface TpmVerifierContext {
  readonly expectedMotebitId?: string;
  readonly expectedDeviceId?: string;
  readonly expectedAttestedAt?: number;
}

export interface TpmVerifierConfig {
  /** Optional: override the pinned vendor roots (tests fabricate their own). */
  readonly rootPems?: readonly string[];
  /** Optional: inject a fixed clock for deterministic chain-validity checks. */
  readonly now?: () => number;
  /**
   * Optional: VC-subject context pre-baked at wiring time. See
   * `TpmVerifierContext`. Useful for direct callers of the returned
   * function that skip the `@motebit/crypto::verify` dispatcher. When
   * the dispatcher passes a per-credential context, its fields take
   * precedence over the pre-baked ones — per-credential always wins.
   */
  readonly context?: TpmVerifierContext;
}

/**
 * Factory — build a `tpm` verifier bound to an optional test-root /
 * clock / context override. The returned function matches the
 * `HardwareAttestationVerifiers.tpm` three-arg signature the
 * `@motebit/crypto` dispatcher calls — `(claim, expectedIdentityHex,
 * context?)`.
 */
export function tpmVerifier(
  config?: TpmVerifierConfig,
): (
  claim: HardwareAttestationClaim,
  expectedIdentityHex: string,
  context?: TpmVerifierContext,
) => Promise<TpmVerifierResult> {
  return async (claim, expectedIdentityHex, context) => {
    // Per-call context (from the dispatcher) wins over factory-time
    // context. Either can be omitted; the verifier reports the missing
    // fields in `errors` rather than passing silently.
    const motebitId = context?.expectedMotebitId ?? config?.context?.expectedMotebitId;
    const deviceId = context?.expectedDeviceId ?? config?.context?.expectedDeviceId;
    const attestedAt = context?.expectedAttestedAt ?? config?.context?.expectedAttestedAt;
    const opts: TpmVerifyOptions = {
      expectedIdentityPublicKeyHex: expectedIdentityHex,
      ...(config?.rootPems !== undefined ? { rootPems: config.rootPems } : {}),
      ...(config?.now !== undefined ? { now: config.now } : {}),
      ...(motebitId !== undefined ? { expectedMotebitId: motebitId } : {}),
      ...(deviceId !== undefined ? { expectedDeviceId: deviceId } : {}),
      ...(attestedAt !== undefined ? { expectedAttestedAt: attestedAt } : {}),
    };
    const detail = await verifyTpmQuote(claim, opts);
    return {
      valid: detail.valid,
      platform: "tpm",
      errors: detail.errors,
      attestation_detail: detail,
    };
  };
}
