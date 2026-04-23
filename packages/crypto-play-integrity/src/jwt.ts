/**
 * Minimal JWT parser + ES256/RS256 signature verifier for Play Integrity
 * tokens.
 *
 * The verifier we expose is scoped tight: we decode exactly the fields
 * Google's Play Integrity API emits, dispatch ES256 to `@noble/curves`
 * (the same primitive `@motebit/crypto` uses for Apple Secure Enclave
 * receipts), and dispatch RS256 to Node's `node:crypto.createVerify`
 * (no extra dep — Play Integrity receipts are verified off-device, so
 * the Node-only RS256 path is acceptable; the same verifier runs in
 * the CLI, the relay, and third-party `motebit-verify` passes).
 *
 * Parsing is deliberately naive — we take the three base64url segments,
 * decode the header and payload as UTF-8 JSON, and hand the caller
 * typed access. A malformed token throws; the caller in `verify.ts`
 * catches and returns the structured `{ valid: false, errors: [...] }`
 * result.
 */

import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha256";
import { createVerify } from "node:crypto";

import { fromBase64Url } from "@motebit/crypto";

import type { GoogleJwk } from "./google-jwks.js";

/**
 * Decoded JWT. `signingInput` is the raw `header.payload` bytes the
 * caller verifies the signature over — we retain it so the RS256 path
 * (which uses Node's streaming Verify API) doesn't have to reassemble
 * it. `signature` is the already-decoded raw bytes.
 */
export interface DecodedJwt {
  readonly header: JwtHeader;
  readonly payload: PlayIntegrityPayload;
  readonly signature: Uint8Array;
  readonly signingInput: Uint8Array;
}

/**
 * Typed header view of the segments Google's Play Integrity emits.
 * Additional fields (typ, etc.) pass through unused.
 */
export interface JwtHeader {
  readonly alg: string;
  readonly kid?: string;
  readonly typ?: string;
}

/**
 * Typed payload view of the fields Google's Play Integrity emits.
 * Additional advisory fields (testToken, appRecognitionVerdict, etc.)
 * pass through — we read only what the verifier gates on.
 *
 * Shape documented at:
 * https://developer.android.com/google/play/integrity/verdicts
 */
export interface PlayIntegrityPayload {
  /** Caller-supplied challenge. We assert it byte-equals the motebit nonce. */
  readonly nonce: string;
  /** Signing package name — the Android app the verdict covers. */
  readonly packageName?: string;
  /** APK signing package (typically equal to `packageName`). */
  readonly apkPackageName?: string;
  /** SHA-256 of the APK as a hex or base64 string. Not gated today; kept for audit. */
  readonly apkDigestSha256?: string;
  /**
   * Device integrity verdict. Google emits `"MEETS_DEVICE_INTEGRITY"`
   * (strict), `"MEETS_BASIC_INTEGRITY"`, etc. Verifier compares against
   * the configured floor; the default floor is the strict one.
   */
  readonly deviceIntegrity?: string | { readonly deviceRecognitionVerdict?: readonly string[] };
  /** App integrity verdict (`"PLAY_RECOGNIZED"`, etc.). Not gated today. */
  readonly appIntegrity?: string | { readonly appRecognitionVerdict?: string };
  /**
   * Risk-assessment verdict. `"LOW_RISK"`, `"HIGH_RISK"`, etc. Not gated
   * today; kept for audit and future policy.
   */
  readonly appAccessRiskVerdict?: string | { readonly appAccessRiskVerdict?: string };
  /** Unix ms emitted by Google. */
  readonly timestampMillis?: number | string;
}

/**
 * Split and decode a Play Integrity JWT.
 *
 * Throws on malformed shape (wrong segment count, invalid base64url,
 * invalid UTF-8 JSON in either header or payload). Signature bytes are
 * returned raw — for ES256 that's the 64-byte (r,s) concat; for RS256
 * that's the RSA signature bytes.
 */
export function decodeJwt(token: string): DecodedJwt {
  const segments = token.split(".");
  if (segments.length !== 3) {
    throw new Error(`JWT must have 3 base64url segments separated by '.'; got ${segments.length}`);
  }
  const [headerB64, payloadB64, signatureB64] = segments as [string, string, string];

  let headerBytes: Uint8Array;
  let payloadBytes: Uint8Array;
  let signature: Uint8Array;
  try {
    headerBytes = fromBase64Url(headerB64);
    payloadBytes = fromBase64Url(payloadB64);
    signature = fromBase64Url(signatureB64);
  } catch (err) {
    throw new Error(
      `JWT base64url decode failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let header: JwtHeader;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(headerBytes)) as unknown;
    if (parsed === null || typeof parsed !== "object") {
      throw new Error("JWT header is not a JSON object");
    }
    const rec = parsed as Record<string, unknown>;
    if (typeof rec.alg !== "string") throw new Error("JWT header missing `alg`");
    header = {
      alg: rec.alg,
      ...(typeof rec.kid === "string" ? { kid: rec.kid } : {}),
      ...(typeof rec.typ === "string" ? { typ: rec.typ } : {}),
    };
  } catch (err) {
    throw new Error(`JWT header parse failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  let payload: PlayIntegrityPayload;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(payloadBytes)) as unknown;
    if (parsed === null || typeof parsed !== "object") {
      throw new Error("JWT payload is not a JSON object");
    }
    payload = parsed as PlayIntegrityPayload;
    if (typeof payload.nonce !== "string") {
      throw new Error("JWT payload missing `nonce`");
    }
  } catch (err) {
    throw new Error(
      `JWT payload parse failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // `header.payload` bytes — the signing input per RFC 7515 §5.
  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);

  return { header, payload, signature, signingInput };
}

/**
 * Verify a decoded JWT's signature against the selected JWK.
 *
 * Dispatches on `alg`:
 *   - `"ES256"` → `@noble/curves/p256` — deterministic primitive call,
 *     matches the same curve package the Secure Enclave verifier uses.
 *   - `"RS256"` → `node:crypto.createVerify("RSA-SHA256")` — Node-only;
 *     Play Integrity receipts are verified off-device, so binding this
 *     path to Node is acceptable (CLI / relay / third-party verifier
 *     contexts all have Node available).
 *
 * Returns `false` (never throws) on signature mismatch, unknown `alg`,
 * missing JWK fields, or primitive-level exception — fail-closed by
 * default so a malformed JWK in the pin never silently passes.
 */
export async function verifyJwtSignature(jwt: DecodedJwt, jwk: GoogleJwk): Promise<boolean> {
  try {
    if (jwt.header.alg !== jwk.alg) return false;

    if (jwt.header.alg === "ES256") {
      if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) return false;
      // ES256 raw signature is `r || s`, each 32 bytes. Reconstruct the
      // affine public point from (x, y), then verify over SHA-256 of the
      // signing input.
      if (jwt.signature.length !== 64) return false;
      const xBytes = fromBase64Url(jwk.x);
      const yBytes = fromBase64Url(jwk.y);
      if (xBytes.length !== 32 || yBytes.length !== 32) return false;
      // Uncompressed point: 0x04 || x || y.
      const uncompressed = new Uint8Array(65);
      uncompressed[0] = 0x04;
      uncompressed.set(xBytes, 1);
      uncompressed.set(yBytes, 33);
      const digest = sha256(jwt.signingInput);
      return p256.verify(jwt.signature, digest, uncompressed, { prehash: false });
    }

    if (jwt.header.alg === "RS256") {
      if (jwk.kty !== "RSA" || !jwk.n || !jwk.e) return false;
      // Build a SPKI-equivalent PEM from the (n, e) pair so Node's
      // createVerify accepts it. Instead of hand-rolling the ASN.1
      // SubjectPublicKeyInfo, use the `jwk` KeyObject form Node supports
      // directly (Node ≥ 16 accepts raw JWK).
      const { createPublicKey } = await import("node:crypto");
      const keyObj = createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" });
      const verifier = createVerify("RSA-SHA256");
      verifier.update(jwt.signingInput);
      verifier.end();
      return verifier.verify(keyObj, jwt.signature);
    }

    return false;
  } catch {
    return false;
  }
}
