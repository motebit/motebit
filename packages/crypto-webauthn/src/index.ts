/**
 * @motebit/crypto-webauthn — W3C WebAuthn platform-authenticator
 * attestation adapter for motebit hardware-attestation claims.
 *
 * The metabolic leaf `@motebit/crypto` delegates to when a
 * `HardwareAttestationClaim` declares `platform: "webauthn"`. Dep-thin
 * `@motebit/crypto` stays MIT-pure; this BSL package metabolizes
 * `@peculiar/x509` + `cbor2` to judge whether the browser's platform
 * authenticator rooted the leaf that signed the caller's attestation
 * (full attestation), or whether the credential's own key witnessed
 * the challenge (self attestation).
 *
 * Wiring from a consumer:
 *
 * ```ts
 * import { verify } from "@motebit/crypto";
 * import { webauthnVerifier } from "@motebit/crypto-webauthn";
 *
 * const result = await verify(credential, {
 *   hardwareAttestation: { webauthn: webauthnVerifier({ expectedRpId: "motebit.com" }) },
 * });
 * ```
 *
 * This package exports no global state, no side-effect registrations;
 * the injection is call-site only.
 */

import type { HardwareAttestationClaim } from "@motebit/protocol";

import type { WebAuthnVerifyOptions, WebAuthnVerifyResult } from "./verify.js";
import { verifyWebAuthnAttestation } from "./verify.js";

export { parseWebAuthnAttestationObjectCbor } from "./cbor.js";
export type { WebAuthnAttestationObjectCbor } from "./cbor.js";
export {
  APPLE_WEBAUTHN_ROOT_PEM,
  YUBICO_FIDO_ROOT_PEM,
  MICROSOFT_TPM_ROOT_PEM,
  DEFAULT_FIDO_ROOTS,
  WEBAUTHN_FMT_PACKED,
} from "./fido-roots.js";
export { verifyWebAuthnAttestation } from "./verify.js";
export type { WebAuthnVerifyOptions, WebAuthnVerifyResult, WebAuthnVerifyError } from "./verify.js";

/**
 * Shape the optional verifier injected into `@motebit/crypto`'s
 * `HardwareAttestationVerifiers.webauthn` slot carries. Mirrors the
 * sync-or-async return shape the dispatcher supports, and extends the
 * canonical shape with the structured `attestation_detail` so callers
 * can introspect chain / signature / binding independently.
 */
export interface WebAuthnVerifyDispatchResult {
  readonly valid: boolean;
  readonly platform: "webauthn";
  readonly errors: ReadonlyArray<{ readonly message: string }>;
  readonly attestation_detail?: WebAuthnVerifyResult;
}

/**
 * Context fields the dispatcher lifts out of the credential subject and
 * threads through to the verifier. All three participate in the
 * canonical body the web mint path composes at WebAuthn challenge
 * time — the verifier re-derives the body from them and byte-compares
 * against the `challenge` field of clientDataJSON.
 *
 * All fields optional: a caller that omits one loses the identity-
 * binding channel but still gets chain / signature / rp binding
 * results — the verifier reports the missing channel explicitly rather
 * than silently passing.
 */
export interface WebAuthnVerifierContext {
  readonly expectedMotebitId?: string;
  readonly expectedDeviceId?: string;
  readonly expectedAttestedAt?: number;
}

export interface WebAuthnVerifierConfig {
  /** WebAuthn Relying Party ID the credential was minted for (e.g. "motebit.com"). */
  readonly expectedRpId: string;
  /** Optional: override the pinned FIDO root accept-set (tests fabricate their own). */
  readonly rootPems?: ReadonlyArray<string>;
  /** Optional: inject a fixed clock for deterministic chain-validity checks. */
  readonly now?: () => number;
  /** Optional: override the accepted attestation-format string. */
  readonly expectedFmt?: string;
}

/**
 * Factory — build a `webauthn` verifier bound to a specific RP ID and
 * (optionally) a test root set / clock / fmt. The returned function
 * matches the `HardwareAttestationVerifiers.webauthn` signature the
 * `@motebit/crypto` dispatcher expects.
 *
 * Third-parameter `context` carries motebit_id / device_id / attested_at
 * so the verifier can re-derive the canonical body the browser signed
 * over. Callers that omit it receive `identity_bound: false` in the
 * result (fail-closed).
 *
 * Kept as a factory rather than a free function so the consumer's RP
 * ID is captured once at wiring time, not repeated at every call site.
 */
export function webauthnVerifier(
  config: WebAuthnVerifierConfig,
): (
  claim: HardwareAttestationClaim,
  expectedIdentityHex: string,
  context?: WebAuthnVerifierContext,
) => Promise<WebAuthnVerifyDispatchResult> {
  return async (claim, expectedIdentityHex, context) => {
    const opts: WebAuthnVerifyOptions = {
      expectedRpId: config.expectedRpId,
      expectedIdentityPublicKeyHex: expectedIdentityHex,
      ...(config.rootPems !== undefined ? { rootPems: config.rootPems } : {}),
      ...(config.now !== undefined ? { now: config.now } : {}),
      ...(config.expectedFmt !== undefined ? { expectedFmt: config.expectedFmt } : {}),
      ...(context?.expectedMotebitId !== undefined
        ? { expectedMotebitId: context.expectedMotebitId }
        : {}),
      ...(context?.expectedDeviceId !== undefined
        ? { expectedDeviceId: context.expectedDeviceId }
        : {}),
      ...(context?.expectedAttestedAt !== undefined
        ? { expectedAttestedAt: context.expectedAttestedAt }
        : {}),
    };
    const detail = await verifyWebAuthnAttestation(claim, opts);
    return {
      valid: detail.valid,
      platform: "webauthn",
      errors: detail.errors,
      attestation_detail: detail,
    };
  };
}
