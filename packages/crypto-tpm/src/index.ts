/**
 * @motebit/crypto-tpm — TPM 2.0 quote chain-verification adapter for
 * motebit hardware-attestation claims.
 *
 * The metabolic leaf `@motebit/crypto` delegates to when a
 * `HardwareAttestationClaim` declares `platform: "tpm"`. Dep-thin
 * `@motebit/crypto` stays MIT-pure; this BSL package metabolizes
 * `@peculiar/x509` plus a minimal hand-rolled TPM parser to judge
 * whether a vendor-published Endorsement-Key CA rooted the Attestation
 * Key that signed the caller's TPM2_Quote.
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
 * These are captured at factory time (via `TpmVerifierConfig.context`)
 * because the current `HardwareAttestationVerifiers.tpm` dispatcher
 * signature passes only `(claim, expectedIdentityHex)` — not the full
 * VC-subject context. Binding at wiring keeps identity verification
 * load-bearing without requiring a dispatcher signature change.
 * Consumers that route directly through `verifyTpmQuote` can thread
 * per-call fields via `TpmVerifyOptions` instead.
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
   * Optional: VC-subject context captured at wiring time. See
   * `TpmVerifierContext`. For end-to-end verification through
   * `@motebit/crypto::verify`, the caller wires this once with the
   * credential's motebit_id / device_id / attested_at — the
   * dispatcher's two-arg calling convention is preserved, and identity
   * binding lands at the cost of per-credential factory invocation.
   */
  readonly context?: TpmVerifierContext;
}

/**
 * Factory — build a `tpm` verifier bound to an optional test-root /
 * clock / context override. The returned function matches the
 * `HardwareAttestationVerifiers.tpm` two-arg signature the
 * `@motebit/crypto` dispatcher calls.
 */
export function tpmVerifier(
  config?: TpmVerifierConfig,
): (claim: HardwareAttestationClaim, expectedIdentityHex: string) => Promise<TpmVerifierResult> {
  return async (claim, expectedIdentityHex) => {
    const opts: TpmVerifyOptions = {
      expectedIdentityPublicKeyHex: expectedIdentityHex,
      ...(config?.rootPems !== undefined ? { rootPems: config.rootPems } : {}),
      ...(config?.now !== undefined ? { now: config.now } : {}),
      ...(config?.context?.expectedMotebitId !== undefined
        ? { expectedMotebitId: config.context.expectedMotebitId }
        : {}),
      ...(config?.context?.expectedDeviceId !== undefined
        ? { expectedDeviceId: config.context.expectedDeviceId }
        : {}),
      ...(config?.context?.expectedAttestedAt !== undefined
        ? { expectedAttestedAt: config.context.expectedAttestedAt }
        : {}),
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
