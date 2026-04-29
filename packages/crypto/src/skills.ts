/**
 * Skill manifest + envelope signing and verification — spec/skills-v1.md.
 *
 * Skills are motebit-internal protocol artifacts. They install locally,
 * verify on motebit runtimes, and are signed by their author's motebit
 * identity using `motebit-jcs-ed25519-b64-v1` — the same suite used for
 * execution receipts, tool invocation receipts, settlement anchors, and
 * migration artifacts. NOT W3C `eddsa-jcs-2022` (that suite is reserved for
 * credentials, identity files, and presentations needing third-party W3C
 * interop).
 *
 * Signature recipe (spec §5.1):
 *
 *   manifest_bytes = JCS(manifest_with_signature_value_removed) || 0x0A || lf_body
 *   envelope_bytes = JCS(envelope_with_signature_value_removed)
 *   signature = Ed25519.sign(bytes, privateKey)  -- routed through verifyBySuite
 *
 * Verification is offline: no relay, no registry, no external service. Per
 * @motebit/crypto/CLAUDE.md rule 4, third-party verifiers using only this
 * package and the signer's public key can validate any motebit-signed skill.
 */

import type { SkillEnvelope, SkillManifest, SkillSignature } from "@motebit/protocol";

import {
  canonicalJson,
  fromBase64Url,
  hexToBytes,
  signBySuite,
  toBase64Url,
  verifyBySuite,
} from "./signing.js";

/** The suite skills sign under in v1. Mirrors EXECUTION_RECEIPT_SUITE. */
export const SKILL_SIGNATURE_SUITE = "motebit-jcs-ed25519-b64-v1" as const;

/** Failure reasons surfaced by `verifySkillManifestDetailed` / `verifySkillEnvelopeDetailed`. */
export type SkillVerifyReason =
  | "ok"
  | "no_signature"
  | "wrong_suite"
  | "bad_public_key"
  | "bad_signature_value"
  | "ed25519_mismatch";

export interface SkillVerifyDetail {
  valid: boolean;
  reason: SkillVerifyReason;
}

// ---------------------------------------------------------------------------
// Canonicalization — pure, deterministic, dependency-free
// ---------------------------------------------------------------------------

/**
 * Strip `signature.value` from a SkillSignature, preserving `suite` and
 * `public_key` (those ARE part of the signed canonical form per spec §5.1).
 */
function signatureWithoutValue(sig: SkillSignature): { suite: string; public_key: string } {
  return { suite: sig.suite, public_key: sig.public_key };
}

/**
 * Compute the canonical bytes that a SkillManifest signature is computed over.
 * `body` is the LF-normalized SKILL.md body bytes (everything after the
 * closing `---` delimiter), with CRLF/CR converted to LF, no BOM, UTF-8.
 *
 * Caller is responsible for body normalization. The reference parser in
 * @motebit/skills (BSL) does the normalization at file-read time.
 *
 * The manifest's `motebit.signature.value` is removed before canonicalization;
 * `suite` and `public_key` are preserved (they are signature-bound).
 */
export function canonicalizeSkillManifestBytes(
  manifest: SkillManifest,
  body: Uint8Array,
): Uint8Array {
  const motebitForCanonical = manifest.motebit.signature
    ? {
        ...manifest.motebit,
        signature: signatureWithoutValue(manifest.motebit.signature),
      }
    : manifest.motebit;

  const manifestForCanonical = { ...manifest, motebit: motebitForCanonical };
  const canonical = canonicalJson(manifestForCanonical);
  const manifestBytes = new TextEncoder().encode(canonical);

  const out = new Uint8Array(manifestBytes.length + 1 + body.length);
  out.set(manifestBytes, 0);
  out[manifestBytes.length] = 0x0a; // LF separator
  out.set(body, manifestBytes.length + 1);
  return out;
}

/**
 * Compute the canonical bytes that a SkillEnvelope signature is computed
 * over. Sibling to manifest canonicalization; envelope is pure JSON so no
 * body concatenation.
 */
export function canonicalizeSkillEnvelopeBytes(envelope: SkillEnvelope): Uint8Array {
  const envelopeForCanonical = {
    ...envelope,
    signature: signatureWithoutValue(envelope.signature),
  };
  const canonical = canonicalJson(envelopeForCanonical);
  return new TextEncoder().encode(canonical);
}

// ---------------------------------------------------------------------------
// Signing — for skill authors
// ---------------------------------------------------------------------------

/**
 * Sign a SkillManifest, returning the signed manifest with `motebit.signature`
 * populated. Caller provides the LF-normalized body bytes; signing recipe is
 * spec §5.1.
 *
 * The returned manifest's `motebit.signature.public_key` is hex-encoded and
 * `motebit.signature.value` is base64url-encoded, matching the suite contract.
 */
export async function signSkillManifest(
  unsigned: Omit<SkillManifest, "motebit"> & {
    motebit: Omit<SkillManifest["motebit"], "signature">;
  },
  privateKey: Uint8Array,
  publicKey: Uint8Array,
  body: Uint8Array,
): Promise<SkillManifest> {
  const publicKeyHex = bytesToLowerHex(publicKey);

  // Stamp the unsigned signature block (suite + public_key) so it participates
  // in canonicalization at sign time.
  const unsignedWithSig: SkillManifest = {
    ...unsigned,
    motebit: {
      ...unsigned.motebit,
      signature: {
        suite: SKILL_SIGNATURE_SUITE,
        public_key: publicKeyHex,
        value: "", // placeholder; stripped by canonicalize
      },
    },
  };

  const message = canonicalizeSkillManifestBytes(unsignedWithSig, body);
  const sig = await signBySuite(SKILL_SIGNATURE_SUITE, message, privateKey);

  return {
    ...unsigned,
    motebit: {
      ...unsigned.motebit,
      signature: {
        suite: SKILL_SIGNATURE_SUITE,
        public_key: publicKeyHex,
        value: toBase64Url(sig),
      },
    },
  };
}

/**
 * Sign a SkillEnvelope, returning the signed envelope. Sibling to
 * `signSkillManifest`. Envelope canonicalization is pure JSON (§5.1).
 */
export async function signSkillEnvelope(
  unsigned: Omit<SkillEnvelope, "signature">,
  privateKey: Uint8Array,
  publicKey: Uint8Array,
): Promise<SkillEnvelope> {
  const publicKeyHex = bytesToLowerHex(publicKey);
  const unsignedWithSig: SkillEnvelope = {
    ...unsigned,
    signature: {
      suite: SKILL_SIGNATURE_SUITE,
      public_key: publicKeyHex,
      value: "", // placeholder; stripped by canonicalize
    },
  };
  const message = canonicalizeSkillEnvelopeBytes(unsignedWithSig);
  const sig = await signBySuite(SKILL_SIGNATURE_SUITE, message, privateKey);
  return {
    ...unsigned,
    signature: {
      suite: SKILL_SIGNATURE_SUITE,
      public_key: publicKeyHex,
      value: toBase64Url(sig),
    },
  };
}

// ---------------------------------------------------------------------------
// Verification — fail-closed on every error path
// ---------------------------------------------------------------------------

/**
 * Verify a SkillManifest's signature against the provided public key and
 * LF-normalized body bytes. Returns `false` on any failure path:
 *
 *  - manifest is unsigned (`motebit.signature` absent)
 *  - suite mismatch (only `motebit-jcs-ed25519-b64-v1` accepted in v1)
 *  - public_key in the signature doesn't match the supplied public key
 *  - signature value fails base64url decode
 *  - Ed25519 verification fails
 *
 * Per CLAUDE.md rule 4, this is the third-party self-verification entry
 * point. Only this package + the signer's public key are required.
 */
export async function verifySkillManifest(
  manifest: SkillManifest,
  body: Uint8Array,
  publicKey: Uint8Array,
): Promise<boolean> {
  return (await verifySkillManifestDetailed(manifest, body, publicKey)).valid;
}

/**
 * Companion to `verifySkillManifest` that returns a categorized failure
 * reason for observability. Same recipe; same fail-closed behavior.
 */
export async function verifySkillManifestDetailed(
  manifest: SkillManifest,
  body: Uint8Array,
  publicKey: Uint8Array,
): Promise<SkillVerifyDetail> {
  const sig = manifest.motebit.signature;
  if (!sig) return { valid: false, reason: "no_signature" };
  if (sig.suite !== SKILL_SIGNATURE_SUITE) return { valid: false, reason: "wrong_suite" };

  const publicKeyHex = bytesToLowerHex(publicKey);
  if (sig.public_key.toLowerCase() !== publicKeyHex) {
    return { valid: false, reason: "bad_public_key" };
  }

  let sigBytes: Uint8Array;
  try {
    sigBytes = fromBase64Url(sig.value);
  } catch {
    return { valid: false, reason: "bad_signature_value" };
  }

  const message = canonicalizeSkillManifestBytes(manifest, body);
  const valid = await verifyBySuite(SKILL_SIGNATURE_SUITE, message, sigBytes, publicKey);
  return { valid, reason: valid ? "ok" : "ed25519_mismatch" };
}

/**
 * Verify a SkillEnvelope's signature. Sibling to `verifySkillManifest` —
 * same suite, same fail-closed semantics. Note: envelope verification does
 * NOT cross-check `body_hash` or `files[].hash` against on-disk bytes; the
 * caller (install-time logic in the registry) is responsible for that pass
 * after signature verification succeeds.
 */
export async function verifySkillEnvelope(
  envelope: SkillEnvelope,
  publicKey: Uint8Array,
): Promise<boolean> {
  return (await verifySkillEnvelopeDetailed(envelope, publicKey)).valid;
}

export async function verifySkillEnvelopeDetailed(
  envelope: SkillEnvelope,
  publicKey: Uint8Array,
): Promise<SkillVerifyDetail> {
  const sig = envelope.signature;
  if (sig.suite !== SKILL_SIGNATURE_SUITE) return { valid: false, reason: "wrong_suite" };

  const publicKeyHex = bytesToLowerHex(publicKey);
  if (sig.public_key.toLowerCase() !== publicKeyHex) {
    return { valid: false, reason: "bad_public_key" };
  }

  let sigBytes: Uint8Array;
  try {
    sigBytes = fromBase64Url(sig.value);
  } catch {
    return { valid: false, reason: "bad_signature_value" };
  }

  const message = canonicalizeSkillEnvelopeBytes(envelope);
  const valid = await verifyBySuite(SKILL_SIGNATURE_SUITE, message, sigBytes, publicKey);
  return { valid, reason: valid ? "ok" : "ed25519_mismatch" };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Hex-encode a 32-byte public key as 64 lowercase hex chars. */
function bytesToLowerHex(bytes: Uint8Array): string {
  let hex = "";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return hex;
}

/** Decode a hex public key from a SkillSignature for caller convenience. */
export function decodeSkillSignaturePublicKey(sig: SkillSignature): Uint8Array {
  return hexToBytes(sig.public_key);
}
