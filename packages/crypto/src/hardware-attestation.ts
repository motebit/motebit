/**
 * Hardware attestation — verify that a motebit's Ed25519 identity key
 * is bound to a hardware-backed ECDSA P-256 key held in a platform
 * trust anchor (Apple Secure Enclave today; TPM / Play Integrity /
 * DeviceCheck as future additive adapters).
 *
 * ## Why this exists
 *
 * Motebit's identity key is Ed25519, stored in the OS keyring on
 * desktop and in equivalent app-sandboxed stores on mobile/web. That
 * key is *software-custody*: the private bytes are readable by any
 * process running as the user. The moat thesis — "accumulated trust
 * that a third party can verify" — is categorically weaker without a
 * hardware root. Hardware attestation bridges the gap without forcing
 * a cryptosuite migration: a separate hardware-native keypair (Apple
 * Secure Enclave generates ECDSA P-256) signs a canonical claim that
 * binds itself to the Ed25519 identity. The identity stays where it
 * is; the hardware signature is *additional* evidence a verifier can
 * rank against.
 *
 * Same shape as FIDO / WebAuthn attestation — the platform root key
 * is distinct from the user-facing identity, and one attests the
 * other.
 *
 * ## Receipt format (`platform: "secure_enclave"`)
 *
 *   attestation_receipt = base64url(canonical_body_json) + "." +
 *                         base64url(ecdsa_p256_signature_der)
 *
 *   canonical_body_json = JCS-canonicalized JSON of:
 *     {
 *       version: "1",
 *       algorithm: "ecdsa-p256-sha256",
 *       motebit_id: string,
 *       device_id: string,
 *       identity_public_key: Ed25519 hex lowercase,
 *       se_public_key: P-256 compressed-point hex lowercase,
 *       attested_at: unix ms,
 *     }
 *
 * The P-256 signature is over `SHA-256(canonical_body_json)` — standard
 * ECDSA-on-SHA256. The verifier recovers the SE public key from
 * `body.se_public_key` (self-contained; zero relay contact), verifies
 * the signature, then checks that `body.identity_public_key` equals the
 * Ed25519 key the credential subject is claimed for.
 *
 * ## Non-goals in v1
 *
 *   - Other platforms (TPM / DeviceCheck / Play Integrity) — each
 *     returns `valid: false` + a named-missing-adapter error. Additive
 *     platform adapters plug in behind the same result shape.
 *   - Revocation — claims expire with their parent credential's
 *     expiry. No separate revocation channel.
 *   - Chain-of-trust verification — the SE public key is the
 *     self-asserted root in v1. Future platform adapters verify the
 *     platform's own attestation chain (Apple's root CA, Google's
 *     verified-boot chain, etc.) as glucose per the metabolic
 *     principle.
 *
 * MIT, no I/O, deterministic. Safe to run in any environment that
 * can parse UTF-8 JSON.
 */

import type { HardwareAttestationClaim } from "@motebit/protocol";

import { canonicalJson, fromBase64Url } from "./signing.js";
import { verifyP256EcdsaSha256 } from "./suite-dispatch.js";

/**
 * Platform identifier mirrored from `HardwareAttestationClaim.platform`.
 * Declared locally so hardware-attestation.ts isn't coupled to whether
 * protocol exports it as a named type — the union literal is the
 * contract.
 */
export type AttestationPlatform = HardwareAttestationClaim["platform"];

/**
 * One verification error in the result. Matches the shape used by the
 * other `@motebit/crypto` verify functions so callers can surface
 * errors uniformly.
 */
export interface HardwareAttestationError {
  readonly message: string;
}

/**
 * Result of verifying one `HardwareAttestationClaim`. `valid` reflects
 * only the platform-verification outcome for the receipt — identity-key
 * binding is checked separately via `expectedIdentityPublicKeyHex`.
 *
 * For the `secure_enclave` platform, a `valid: true` result asserts:
 *   1. The receipt is well-formed JWS-shape (body . signature).
 *   2. The body's algorithm field is `ecdsa-p256-sha256`.
 *   3. The P-256 signature verifies against the body bytes + the
 *      SE public key carried inside the body.
 *   4. The body's `identity_public_key` equals the expected Ed25519
 *      key the caller provided.
 *
 * Other platforms are not implemented in v1 and return
 * `valid: false, errors: [{message: "...adapter not shipped..."}]`.
 * Adapters plug in behind this same result shape; a verifier that
 * ignores the `se_public_key` field stays forward-compatible.
 */
export interface HardwareAttestationVerifyResult {
  readonly valid: boolean;
  readonly platform: AttestationPlatform | null;
  /** P-256 pubkey (compressed hex) recovered from a verified SE receipt. */
  readonly se_public_key?: string;
  /** Unix ms timestamp from a verified body, if any. */
  readonly attested_at?: number;
  readonly errors: readonly HardwareAttestationError[];
}

/**
 * Canonical body shape embedded inside `attestation_receipt` for
 * `platform: "secure_enclave"`. Kept internal — the field is the
 * wire contract only when we generate/verify, not an exported spec.
 */
interface SecureEnclaveBody {
  readonly version: string;
  readonly algorithm: string;
  readonly motebit_id: string;
  readonly device_id: string;
  readonly identity_public_key: string;
  readonly se_public_key: string;
  readonly attested_at: number;
}

/**
 * Context fields the dispatcher lifts out of the VC subject and hands
 * to the `deviceCheck` arm so it can re-derive the JCS body Apple
 * signed over. motebit_id / device_id / attested_at participate in
 * that body alongside identity_public_key; without them the verifier
 * cannot bind the receipt to the caller's identity. Each field is
 * optional at the type level so an older credential subject that
 * doesn't carry them flows through with `identity_bound: false`
 * rather than crashing the verifier.
 */
export interface DeviceCheckVerifierContext {
  readonly expectedMotebitId?: string;
  readonly expectedDeviceId?: string;
  readonly expectedAttestedAt?: number;
}

/**
 * Optional platform-verifier dispatch injected at call site by the
 * consumer. Each slot takes the claim + the expected Ed25519 identity
 * key (lowercase hex) and returns a verification result matching the
 * canonical shape.
 *
 * `@motebit/crypto` stays MIT-pure and dep-thin — it never imports a
 * platform adapter. Consumers (CLI, mobile, desktop, relay) wire the
 * leaf packages (`@motebit/crypto-appattest` for device_check;
 * future `@motebit/crypto-tpm`, `@motebit/crypto-play-integrity`) into
 * this object so that dispatch remains explicit, auditable, and
 * tree-shakable: a verifier that doesn't care about App Attest ships
 * zero App Attest code.
 *
 * `deviceCheck` takes an optional third `context` argument carrying
 * the VC-subject fields that participate in the JCS body the Swift
 * mint path signs over (motebit_id / device_id / attested_at). The
 * dispatcher populates this from the credential subject; direct
 * callers threading their own context can too. Older injected
 * verifiers that ignore the third argument still satisfy the type.
 */
export interface HardwareAttestationVerifiers {
  readonly deviceCheck?: (
    claim: HardwareAttestationClaim,
    expectedIdentityPublicKeyHex: string,
    context?: DeviceCheckVerifierContext,
  ) =>
    | HardwareAttestationVerifyResult
    | PromiseLike<HardwareAttestationVerifyResult>
    | { readonly valid: boolean; readonly errors: ReadonlyArray<{ readonly message: string }> }
    | PromiseLike<{
        readonly valid: boolean;
        readonly errors: ReadonlyArray<{ readonly message: string }>;
      }>;
  readonly tpm?: (
    claim: HardwareAttestationClaim,
    expectedIdentityPublicKeyHex: string,
  ) => HardwareAttestationVerifyResult | PromiseLike<HardwareAttestationVerifyResult>;
  readonly playIntegrity?: (
    claim: HardwareAttestationClaim,
    expectedIdentityPublicKeyHex: string,
  ) => HardwareAttestationVerifyResult | PromiseLike<HardwareAttestationVerifyResult>;
}

/**
 * Verify a hardware-attestation claim.
 *
 * - `claim` — the `HardwareAttestationClaim` taken from a credential's
 *   `credentialSubject.hardware_attestation`.
 * - `expectedIdentityPublicKeyHex` — the Ed25519 public key (hex) the
 *   verifier believes owns the credential. Comes from the credential
 *   issuance path (typically the subject's DID pubkey).
 * - `verifiers` — optional injection of platform-specific verifiers for
 *   claims other than `secure_enclave`. Consumers pass
 *   `{ deviceCheck: deviceCheckVerifier(...) }` from
 *   `@motebit/crypto-appattest` to enable App Attest verification. When
 *   a claim's platform has no verifier wired, the dispatcher returns a
 *   stub `valid: false, errors: [{message:"adapter not yet shipped"}]`
 *   so verification remains fail-closed by default.
 * - `deviceCheckContext` — VC-subject fields (motebit_id / device_id /
 *   attested_at) lifted from the credential subject; threaded to the
 *   injected `deviceCheck` verifier so it can re-derive the JCS body
 *   Apple signed over. Ignored for every other platform.
 *
 * Zero throws — every failure lands as `valid: false` with a structured
 * reason so callers can render consistent audit output. The
 * secure_enclave path remains synchronous; device_check (and any other
 * injected adapter) may return a Promise, so callers that dispatch
 * through the `verify()` entrypoint get `await`ed results.
 */
export function verifyHardwareAttestationClaim(
  claim: HardwareAttestationClaim,
  expectedIdentityPublicKeyHex: string,
  verifiers?: HardwareAttestationVerifiers,
  deviceCheckContext?: DeviceCheckVerifierContext,
): HardwareAttestationVerifyResult | Promise<HardwareAttestationVerifyResult> {
  const platform = claim.platform;
  const errors: HardwareAttestationError[] = [];

  switch (platform) {
    case "secure_enclave":
      return verifySecureEnclaveClaim(claim, expectedIdentityPublicKeyHex);
    case "software":
      // Truthful "this key is not hardware-backed" claim — valid in
      // the sense of "no deception," but offers no hardware signal. The
      // semiring scores it as `0.1` (see `@motebit/semiring`). Report
      // as `valid: false` for the hardware-verification channel: the
      // claim doesn't prove hardware, and the caller should score it
      // via the semiring, not treat it as attested.
      errors.push({
        message: "platform `software` is a no-hardware sentinel; no verification channel",
      });
      return { valid: false, platform: "software", errors };
    case "device_check":
      if (verifiers?.deviceCheck) {
        return dispatchInjected(
          platform,
          verifiers.deviceCheck(claim, expectedIdentityPublicKeyHex, deviceCheckContext),
        );
      }
      errors.push({
        message: `platform \`${platform}\` verifier not wired — pass { deviceCheck: deviceCheckVerifier(...) } from @motebit/crypto-appattest to enable`,
      });
      return { valid: false, platform, errors };
    case "tpm":
      if (verifiers?.tpm) {
        return dispatchInjected(platform, verifiers.tpm(claim, expectedIdentityPublicKeyHex));
      }
      errors.push({
        message: `platform \`${platform}\` verifier not wired — pass { tpm: ... } via the verifiers parameter to enable`,
      });
      return { valid: false, platform, errors };
    case "play_integrity":
      if (verifiers?.playIntegrity) {
        return dispatchInjected(
          platform,
          verifiers.playIntegrity(claim, expectedIdentityPublicKeyHex),
        );
      }
      errors.push({
        message: `platform \`${platform}\` verifier not wired — pass { playIntegrity: ... } via the verifiers parameter to enable`,
      });
      return { valid: false, platform, errors };
    default:
      errors.push({
        message: `unknown platform \`${claim.platform}\` — not in the declared enum`,
      });
      return { valid: false, platform: null, errors };
  }
}

/**
 * Normalize the injected verifier's return shape into the canonical
 * `HardwareAttestationVerifyResult`. Injected leaves may return a
 * richer shape (e.g. `@motebit/crypto-appattest`'s
 * `DeviceCheckVerifyResult` carries `attestation_detail`); the
 * canonical fields are lifted out here so the outer VC verify path
 * always sees the same shape.
 */
async function dispatchInjected(
  platform: AttestationPlatform,
  result:
    | HardwareAttestationVerifyResult
    | PromiseLike<HardwareAttestationVerifyResult>
    | { readonly valid: boolean; readonly errors: ReadonlyArray<{ readonly message: string }> }
    | PromiseLike<{
        readonly valid: boolean;
        readonly errors: ReadonlyArray<{ readonly message: string }>;
      }>,
): Promise<HardwareAttestationVerifyResult> {
  const awaited = await Promise.resolve(result);
  return {
    valid: awaited.valid,
    platform,
    errors: awaited.errors ?? [],
  };
}

// ── Secure Enclave path ──────────────────────────────────────────────

function verifySecureEnclaveClaim(
  claim: HardwareAttestationClaim,
  expectedIdentityPublicKeyHex: string,
): HardwareAttestationVerifyResult {
  const errors: HardwareAttestationError[] = [];
  const platform: AttestationPlatform = "secure_enclave";

  if (claim.key_exported === true) {
    // An exported hardware key no longer uniquely holds the material;
    // the signed receipt is historical evidence only. We still verify
    // the signature — it's still meaningful — but the result's caller
    // should score it with the lower semiring value (see
    // `scoreAttestation` in @motebit/semiring: exported → 0.5). We do
    // not short-circuit as invalid — that would conflate "key was
    // exported" with "attestation fraudulent."
  }

  if (!claim.attestation_receipt) {
    errors.push({
      message: "secure_enclave claim missing `attestation_receipt`",
    });
    return { valid: false, platform, errors };
  }

  const parts = claim.attestation_receipt.split(".");
  if (parts.length !== 2) {
    errors.push({
      message: `attestation_receipt must be 2 base64url parts separated by '.'; got ${parts.length}`,
    });
    return { valid: false, platform, errors };
  }
  const [bodyB64, sigB64] = parts as [string, string];

  let bodyBytes: Uint8Array;
  let sigBytes: Uint8Array;
  try {
    bodyBytes = fromBase64Url(bodyB64);
    sigBytes = fromBase64Url(sigB64);
  } catch (err) {
    errors.push({
      message: `base64url decode failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { valid: false, platform, errors };
  }

  let bodyJson: unknown;
  try {
    bodyJson = JSON.parse(new TextDecoder().decode(bodyBytes)) as unknown;
  } catch (err) {
    errors.push({
      message: `body JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { valid: false, platform, errors };
  }

  const bodyCheck = parseSecureEnclaveBody(bodyJson);
  if (bodyCheck.kind === "error") {
    errors.push({ message: bodyCheck.reason });
    return { valid: false, platform, errors };
  }
  const body = bodyCheck.body;

  if (body.version !== "1") {
    errors.push({
      message: `unsupported body version '${body.version}' (expected '1')`,
    });
    return { valid: false, platform, errors };
  }
  if (body.algorithm !== "ecdsa-p256-sha256") {
    errors.push({
      message: `unsupported body algorithm '${body.algorithm}' (expected 'ecdsa-p256-sha256')`,
    });
    return { valid: false, platform, errors };
  }

  // Re-canonicalize the body and hash — the signed bytes are what the
  // signer actually signed. The body we parsed is the source of truth
  // for *fields*, but the signed bytes must match the on-wire body
  // bytes exactly (JCS is deterministic, but the signer might have
  // produced the body with trailing whitespace etc. — we verify
  // against the as-received bytes, not our re-canonicalization).
  let sigValid: boolean;
  try {
    sigValid = verifyP256EcdsaSha256(body.se_public_key, bodyBytes, sigBytes);
  } catch (err) {
    errors.push({
      message: `p-256 verification crashed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { valid: false, platform, errors };
  }

  if (!sigValid) {
    errors.push({
      message: "p-256 signature does not verify against body + se_public_key",
    });
    return { valid: false, platform, errors };
  }

  // Identity-key binding check — the attestation body names which
  // Ed25519 key this hardware claim is for. The verifier has the
  // expected key from the credential's issuance context.
  if (body.identity_public_key.toLowerCase() !== expectedIdentityPublicKeyHex.toLowerCase()) {
    errors.push({
      message: `identity_public_key mismatch: body names ${body.identity_public_key.slice(0, 16)}…, expected ${expectedIdentityPublicKeyHex.slice(0, 16)}…`,
    });
    return { valid: false, platform, errors };
  }

  return {
    valid: true,
    platform,
    se_public_key: body.se_public_key,
    attested_at: body.attested_at,
    errors: [],
  };
}

type BodyParseResult = { kind: "ok"; body: SecureEnclaveBody } | { kind: "error"; reason: string };

function parseSecureEnclaveBody(raw: unknown): BodyParseResult {
  if (raw === null || typeof raw !== "object") {
    return { kind: "error", reason: "body is not a JSON object" };
  }
  const r = raw as Record<string, unknown>;
  const fields: Array<keyof SecureEnclaveBody> = [
    "version",
    "algorithm",
    "motebit_id",
    "device_id",
    "identity_public_key",
    "se_public_key",
    "attested_at",
  ];
  for (const f of fields) {
    if (!(f in r)) {
      return { kind: "error", reason: `body missing required field '${f}'` };
    }
  }
  if (
    typeof r.version !== "string" ||
    typeof r.algorithm !== "string" ||
    typeof r.motebit_id !== "string" ||
    typeof r.device_id !== "string" ||
    typeof r.identity_public_key !== "string" ||
    typeof r.se_public_key !== "string" ||
    typeof r.attested_at !== "number"
  ) {
    return { kind: "error", reason: "body field types invalid" };
  }
  return {
    kind: "ok",
    body: {
      version: r.version,
      algorithm: r.algorithm,
      motebit_id: r.motebit_id,
      device_id: r.device_id,
      identity_public_key: r.identity_public_key,
      se_public_key: r.se_public_key,
      attested_at: r.attested_at,
    },
  };
}

// ── Test helper — mint a valid SE receipt from an in-process P-256 key ─

/**
 * Test-only helper — encode a canonical body + signature into the
 * receipt format. Tests that have a P-256 private key (via
 * `@noble/curves/p256`) can call `signBytes` themselves, then hand the
 * resulting body + signature to this helper to produce a well-formed
 * receipt that `verifyHardwareAttestationClaim` will accept. Production
 * callers MUST mint receipts via the Rust Secure Enclave bridge —
 * never through this function.
 */
export function encodeSecureEnclaveReceiptForTest(
  bodyBytes: Uint8Array,
  sigBytes: Uint8Array,
): string {
  return `${toBase64Url(bodyBytes)}.${toBase64Url(sigBytes)}`;
}

/**
 * Test-only helper — build a canonical body JSON's bytes. Use with
 * `encodeSecureEnclaveReceiptForTest` to produce a full receipt for
 * verification tests. Canonicalization matches what production would
 * emit.
 */
export function canonicalSecureEnclaveBodyForTest(body: {
  readonly motebit_id: string;
  readonly device_id: string;
  readonly identity_public_key: string;
  readonly se_public_key: string;
  readonly attested_at: number;
}): Uint8Array {
  const full: SecureEnclaveBody = {
    version: "1",
    algorithm: "ecdsa-p256-sha256",
    ...body,
  };
  return new TextEncoder().encode(canonicalJson(full));
}

function toBase64Url(bytes: Uint8Array): string {
  // Match the conventions in signing.ts — base64url, no padding.
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
