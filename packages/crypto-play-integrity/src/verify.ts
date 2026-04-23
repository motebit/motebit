/**
 * Play Integrity token verifier — the core judgment function this
 * package exports.
 *
 * Flow (matches Google's published Play Integrity verdict recipe, plus
 * the motebit-specific identity-key binding step):
 *
 *   1. Decode the JWT into (header, payload, signature, signingInput).
 *   2. Select the pinned JWK whose `kid` matches `header.kid`. The
 *      JWKS is pinned in `google-jwks.ts` — no dynamic fetch.
 *   3. Verify the signature using the chosen alg (ES256 via
 *      `@noble/curves/p256`; RS256 via `node:crypto`). Fail-closed on
 *      missing fields, unknown alg, or primitive-level exception.
 *   4. Re-derive the motebit nonce as `base64url(SHA256(canonicalBody))`
 *      where `canonicalBody` is the byte-identical JCS body the Kotlin
 *      mint path composes in `apps/mobile/modules/expo-play-integrity/`.
 *      Byte-compare against `payload.nonce`. This is the cross-stack
 *      identity binding — without it, every other step would prove only
 *      that *some* Android device did something, not that the Ed25519
 *      key the credential subject claims is on that device.
 *   5. Assert `payload.packageName === expectedPackageName`.
 *   6. Assert `payload.deviceIntegrity` (or its nested
 *      `deviceRecognitionVerdict` array) contains the required level.
 *      Default floor is the strict `"MEETS_DEVICE_INTEGRITY"`.
 *
 * Google's own inner attestation-refresh fields are NOT verified here —
 * that requires Google's Play-side fresh-attestation endpoint and is
 * out of scope for v1. Outer JWT signature + nonce binding + package
 * binding + device-integrity floor + motebit identity binding is
 * enough for third-party self-verification.
 */

import type { HardwareAttestationClaim } from "@motebit/protocol";
import { canonicalJson, toBase64Url } from "@motebit/crypto";
import { sha256 } from "@noble/hashes/sha256";

import { GOOGLE_PLAY_INTEGRITY_JWKS, type GoogleJwk, type GoogleJwks } from "./google-jwks.js";
import { decodeJwt, verifyJwtSignature } from "./jwt.js";

export interface PlayIntegrityVerifyOptions {
  /** Android package name the verdict must bind to (e.g. "com.motebit.mobile"). */
  readonly expectedPackageName: string;
  /**
   * Ed25519 identity key (lowercase hex) the motebit VC claims. The
   * attested body MUST name this key (via the nonce derivation).
   */
  readonly expectedIdentityPublicKeyHex: string;
  /**
   * motebit_id from the credential subject. Participates in the
   * canonical body that derives the nonce.
   */
  readonly expectedMotebitId?: string;
  /** device_id from the credential subject. Same binding role. */
  readonly expectedDeviceId?: string;
  /** `attested_at` (unix ms) from the credential subject. Same binding role. */
  readonly expectedAttestedAt?: number;
  /**
   * Override the pinned JWKS — tests fabricate their own JWKS so every
   * verify branch exercises the same code path without needing a real
   * Google-signed fixture. Defaults to `GOOGLE_PLAY_INTEGRITY_JWKS`.
   */
  readonly pinnedJwks?: GoogleJwks;
  /**
   * Minimum device-integrity level the verifier accepts. Defaults to
   * the strict Play Integrity floor. Callers targeting a broader
   * fleet (dev builds, sideloaded APKs) may relax to
   * `"MEETS_BASIC_INTEGRITY"`.
   */
  readonly requiredDeviceIntegrity?: string;
}

export interface PlayIntegrityVerifyError {
  readonly message: string;
}

export interface PlayIntegrityVerifyResult {
  readonly valid: boolean;
  readonly signature_valid: boolean;
  readonly nonce_bound: boolean;
  readonly package_bound: boolean;
  readonly identity_bound: boolean;
  /**
   * The device-integrity string the payload declared, or null if the
   * payload didn't carry one (or the verifier couldn't extract it).
   * Exposed so callers can surface it in an audit UI alongside the
   * pass/fail verdict.
   */
  readonly device_integrity_level: string | null;
  readonly errors: readonly PlayIntegrityVerifyError[];
}

/** Default strict integrity floor. Matches Google's "verified Play" tier. */
const DEFAULT_REQUIRED_DEVICE_INTEGRITY = "MEETS_DEVICE_INTEGRITY";

/**
 * Google Play Integrity token verifier.
 *
 * Pure-ish: JWT decode and ES256 verify are synchronous; RS256 verify
 * hits `node:crypto`, which is local and deterministic. No network.
 *
 * `claim.attestation_receipt` is expected to be the raw JWT string
 * Google emits (three base64url segments separated by `.`). The mobile
 * mint path constructs it; see
 * `apps/mobile/modules/expo-play-integrity/` for the Kotlin side.
 */
export async function verifyPlayIntegrityToken(
  claim: HardwareAttestationClaim,
  opts: PlayIntegrityVerifyOptions,
): Promise<PlayIntegrityVerifyResult> {
  const errors: PlayIntegrityVerifyError[] = [];
  let signature_valid = false;
  let nonce_bound = false;
  let package_bound = false;
  let identity_bound = false;
  let device_integrity_level: string | null = null;

  if (!claim.attestation_receipt) {
    errors.push({ message: "play_integrity claim missing `attestation_receipt`" });
    return fail(errors, {
      signature_valid,
      nonce_bound,
      package_bound,
      identity_bound,
      device_integrity_level,
    });
  }

  // ── Step 1: decode ──
  let jwt;
  try {
    jwt = decodeJwt(claim.attestation_receipt);
  } catch (err) {
    errors.push({ message: `JWT decode: ${messageOf(err)}` });
    return fail(errors, {
      signature_valid,
      nonce_bound,
      package_bound,
      identity_bound,
      device_integrity_level,
    });
  }

  // ── Step 2: select JWK by kid ──
  const jwks = opts.pinnedJwks ?? GOOGLE_PLAY_INTEGRITY_JWKS;
  let selectedJwk: GoogleJwk | undefined;
  if (jwt.header.kid) {
    selectedJwk = jwks.keys.find((k) => k.kid === jwt.header.kid);
  } else {
    // No kid in header — accept only if the pinned set has exactly one
    // key matching the alg. Fail-closed when ambiguous.
    const matches = jwks.keys.filter((k) => k.alg === jwt.header.alg);
    if (matches.length === 1) selectedJwk = matches[0];
  }
  if (!selectedJwk) {
    errors.push({
      message: `JWT kid \`${jwt.header.kid ?? "<none>"}\` not found in pinned Google JWKS (${jwks.keys.length} key(s) pinned)`,
    });
    // Continue into the rest of the checks so the result is maximally
    // descriptive, but signature_valid stays false and thus the overall
    // valid stays false.
  }

  // ── Step 3: signature verify ──
  if (selectedJwk) {
    try {
      signature_valid = await verifyJwtSignature(jwt, selectedJwk);
      if (!signature_valid) {
        errors.push({
          message: `JWT signature does not verify under pinned JWK kid=${selectedJwk.kid} alg=${selectedJwk.alg}`,
        });
      }
    } catch (err) {
      errors.push({ message: `JWT signature verify crashed: ${messageOf(err)}` });
    }
  }

  // ── Step 4: nonce (identity) binding ──
  try {
    if (
      typeof opts.expectedIdentityPublicKeyHex !== "string" ||
      opts.expectedIdentityPublicKeyHex.length === 0
    ) {
      errors.push({
        message: "identity_bound: expectedIdentityPublicKeyHex not supplied",
      });
    } else if (typeof opts.expectedMotebitId !== "string" || opts.expectedMotebitId.length === 0) {
      errors.push({
        message: "identity_bound: expectedMotebitId not supplied (required for body re-derivation)",
      });
    } else if (typeof opts.expectedDeviceId !== "string" || opts.expectedDeviceId.length === 0) {
      errors.push({
        message: "identity_bound: expectedDeviceId not supplied (required for body re-derivation)",
      });
    } else if (
      typeof opts.expectedAttestedAt !== "number" ||
      !Number.isFinite(opts.expectedAttestedAt)
    ) {
      errors.push({
        message:
          "identity_bound: expectedAttestedAt not supplied (required for body re-derivation)",
      });
    } else {
      const bodyJson = canonicalJson({
        attested_at: opts.expectedAttestedAt,
        device_id: opts.expectedDeviceId,
        identity_public_key: opts.expectedIdentityPublicKeyHex.toLowerCase(),
        motebit_id: opts.expectedMotebitId,
        platform: "play_integrity",
        version: "1",
      });
      const derivedNonce = toBase64Url(sha256(new TextEncoder().encode(bodyJson)));
      if (derivedNonce === jwt.payload.nonce) {
        nonce_bound = true;
        identity_bound = true;
      } else {
        errors.push({
          message:
            "identity_bound: reconstructed base64url(SHA256(canonical body)) does not equal JWT nonce — body naming the caller's identity was not the body that Google signed over",
        });
      }
    }
  } catch (err) {
    errors.push({ message: `identity binding crashed: ${messageOf(err)}` });
  }

  // ── Step 5: package binding ──
  try {
    if (typeof jwt.payload.packageName !== "string") {
      errors.push({ message: "package_bound: JWT payload missing `packageName`" });
    } else if (jwt.payload.packageName !== opts.expectedPackageName) {
      errors.push({
        message: `package_bound: JWT payload packageName=\`${jwt.payload.packageName}\`; expected \`${opts.expectedPackageName}\``,
      });
    } else {
      package_bound = true;
    }
  } catch (err) {
    errors.push({ message: `package binding crashed: ${messageOf(err)}` });
  }

  // ── Step 6: device integrity floor ──
  // Google emits `deviceIntegrity` either as a string (legacy shape) or
  // as `{ deviceRecognitionVerdict: [...] }` (v1 schema). Accept either,
  // then assert the required level appears in the declared set.
  try {
    const required = opts.requiredDeviceIntegrity ?? DEFAULT_REQUIRED_DEVICE_INTEGRITY;
    const declared = extractDeviceIntegrityLevels(jwt.payload.deviceIntegrity);
    device_integrity_level = declared.length > 0 ? declared.join(",") : null;
    if (!declared.includes(required)) {
      errors.push({
        message: `device_integrity: required \`${required}\` not present; payload declared [${declared.join(", ") || "<none>"}]`,
      });
    }
  } catch (err) {
    errors.push({ message: `device integrity check crashed: ${messageOf(err)}` });
  }

  const deviceIntegrityOk = errors.every((e) => !e.message.startsWith("device_integrity:"));
  return {
    valid: signature_valid && nonce_bound && package_bound && identity_bound && deviceIntegrityOk,
    signature_valid,
    nonce_bound,
    package_bound,
    identity_bound,
    device_integrity_level,
    errors,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Normalize Google's two schemas for device integrity into a flat
 * string list. Legacy shape is a single string; v1 schema is an object
 * carrying `deviceRecognitionVerdict: string[]`. Any other shape is an
 * empty list, which fails the floor check.
 */
function extractDeviceIntegrityLevels(
  raw: PlayIntegrityPayloadDeviceIntegrityInput,
): readonly string[] {
  if (typeof raw === "string") return [raw];
  if (raw && typeof raw === "object" && Array.isArray(raw.deviceRecognitionVerdict)) {
    return raw.deviceRecognitionVerdict.filter((s): s is string => typeof s === "string");
  }
  return [];
}

type PlayIntegrityPayloadDeviceIntegrityInput =
  | string
  | { readonly deviceRecognitionVerdict?: readonly string[] }
  | undefined;

function fail(
  errors: PlayIntegrityVerifyError[],
  partial: Omit<PlayIntegrityVerifyResult, "valid" | "errors">,
): PlayIntegrityVerifyResult {
  return {
    valid: false,
    signature_valid: partial.signature_valid,
    nonce_bound: partial.nonce_bound,
    package_bound: partial.package_bound,
    identity_bound: partial.identity_bound,
    device_integrity_level: partial.device_integrity_level,
    errors,
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
