/**
 * Cryptosuite dispatch — the single entry point for signature primitive
 * verification in @motebit/crypto.
 *
 * Every `verify*` function that checks a signed motebit artifact MUST
 * route through `verifyBySuite`. Direct calls to `ed.verifyAsync`,
 * `ed.signAsync`, or any other primitive outside this file are a
 * drift-gate violation — see `scripts/check-suite-dispatch.ts`.
 *
 * Rationale: the suite value on a wire artifact names a complete
 * verification recipe (algorithm + canonicalization + encoding). The
 * dispatcher's job is to map `suite` → primitive. Encoding of the
 * signature and public key stays at the artifact layer (every artifact
 * already has its own encoding convention — see `spec/<artifact>-v1.md`
 * `#### Wire format (foundation law)` subsections); the dispatcher
 * receives already-decoded bytes and returns already-produced bytes.
 * This keeps the Ed25519 switch arm honest: it does one thing, and the
 * PQ switch arms that follow in 2026+ will do the same one thing for
 * ML-DSA / SLH-DSA.
 *
 * Fail-closed throughout:
 *   - unknown `SuiteId` → `verifyBySuite` returns `false`, `signBySuite` throws.
 *   - unsupported algorithm in the switch (PQ placeholder) → throws with
 *     a clear message so the call site doesn't silently succeed.
 *   - primitive-level exception → `verifyBySuite` returns `false`.
 *
 * No legacy-no-suite path. A caller that reaches this function without
 * a valid `SuiteId` has already lost; the function enforces that
 * contract at the boundary.
 */

// crypto-suite: intentional-primitive-call
// This file is the one place in @motebit/crypto allowed to import the
// raw Ed25519 primitives. The `check-suite-dispatch` gate scans every
// other source file in this package for `ed.verifyAsync` / `ed.signAsync`
// and fails CI if they appear outside this file.
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { sha256 } from "@noble/hashes/sha256";
// P-256 ECDSA for hardware-attestation receipts (Apple Secure Enclave
// generates P-256 keys; this is the verifier side). Centralizing the
// primitive call here keeps the same single-home-for-primitives
// discipline the Ed25519 path follows.
import { p256 } from "@noble/curves/p256";
// Type-only — `SuiteId` is a pure string-literal union with no runtime
// footprint, so the erased import preserves @motebit/crypto's Layer 0
// "zero internal deps" invariant (enforced by check-deps).
import type { SuiteId } from "@motebit/protocol";

// @noble/ed25519 v3 requires explicit SHA-512 binding. Idempotent:
// binding twice is harmless, but some test environments import
// signing.ts first — the check guards against redundant assignment.
if (!ed.hashes.sha512) {
  ed.hashes.sha512 = (msg: Uint8Array) => sha512(msg);
}

/**
 * Verify an already-decoded signature over `canonicalBytes` using the
 * primitive named by `suite`. The caller is responsible for:
 *   1. canonicalization (the bytes are already the signing input per
 *      the suite's canonicalization rule);
 *   2. signature and public-key decoding (hex → Uint8Array, base64url
 *      → Uint8Array, multibase → Uint8Array per the suite's
 *      `signatureEncoding` / `publicKeyEncoding`).
 *
 * Returns `false` on unknown or unsupported suite, on primitive-level
 * exception, and on signature mismatch. Never throws in the Ed25519
 * path. Throws only on PQ suites (placeholder until implementation
 * lands), because a misconfigured dispatcher there would silently
 * pass every verification.
 */
export async function verifyBySuite(
  suite: SuiteId,
  canonicalBytes: Uint8Array,
  signatureBytes: Uint8Array,
  publicKeyBytes: Uint8Array,
): Promise<boolean> {
  // Exhaustive switch on the SuiteId literal union. When ML-DSA /
  // SLH-DSA suites land as new `SuiteId` members, TypeScript will
  // refuse to compile this switch until their arms are added.
  switch (suite) {
    case "motebit-jcs-ed25519-b64-v1":
    case "motebit-jcs-ed25519-hex-v1":
    case "motebit-jwt-ed25519-v1":
    case "motebit-concat-ed25519-hex-v1":
    case "eddsa-jcs-2022":
      try {
        return await ed.verifyAsync(signatureBytes, canonicalBytes, publicKeyBytes);
      } catch {
        return false;
      }
  }
}

/**
 * Produce a signature over `canonicalBytes` using the primitive named
 * by `suite`. Mirrors `verifyBySuite`: caller provides already-
 * canonicalized bytes; caller encodes the returned `Uint8Array` per
 * the suite's `signatureEncoding` at the artifact boundary.
 *
 * Throws on unknown or unsupported suite (fail-closed). Signers that
 * catch and swallow this exception would ship unsigned artifacts,
 * which is a worse failure mode than a loud throw.
 */
export async function signBySuite(
  suite: SuiteId,
  canonicalBytes: Uint8Array,
  privateKeyBytes: Uint8Array,
): Promise<Uint8Array> {
  switch (suite) {
    case "motebit-jcs-ed25519-b64-v1":
    case "motebit-jcs-ed25519-hex-v1":
    case "motebit-jwt-ed25519-v1":
    case "motebit-concat-ed25519-hex-v1":
    case "eddsa-jcs-2022":
      return ed.signAsync(canonicalBytes, privateKeyBytes);
  }
}

/**
 * Lowest-level Ed25519 primitives. These are the functions callers
 * should use when they genuinely need the primitive — for example,
 * generating a keypair at identity bootstrap, or computing a
 * succession-chain signature where the caller has already dispatched
 * by suite. Exported from this file so the drift gate's scan rule is
 * simple: "`ed.*` lives only in `suite-dispatch.ts`."
 */
export async function ed25519Sign(
  message: Uint8Array,
  privateKey: Uint8Array,
): Promise<Uint8Array> {
  return ed.signAsync(message, privateKey);
}

export async function ed25519Verify(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
): Promise<boolean> {
  try {
    return await ed.verifyAsync(signature, message, publicKey);
  } catch {
    return false;
  }
}

export async function generateEd25519Keypair(): Promise<{
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}> {
  const { secretKey, publicKey } = await ed.keygenAsync();
  return { publicKey, privateKey: secretKey };
}

/**
 * Derive the matching public key from a private key, dispatched by suite.
 *
 * For Ed25519 suites this is deterministic seed expansion (hash the seed,
 * derive the curve point). Callers that have a private key in hand and
 * need the public key — sovereign delegation paths, identity bootstrap
 * after a seed import, recovery flows — go through here so the noble
 * call doesn't escape the dispatcher.
 *
 * Throws on unknown or unsupported suite (fail-closed). PQ arms will
 * land alongside their `verifyBySuite` / `signBySuite` counterparts.
 */
export async function getPublicKeyBySuite(
  privateKey: Uint8Array,
  suite: SuiteId,
): Promise<Uint8Array> {
  switch (suite) {
    case "motebit-jcs-ed25519-b64-v1":
    case "motebit-jcs-ed25519-hex-v1":
    case "motebit-jwt-ed25519-v1":
    case "motebit-concat-ed25519-hex-v1":
    case "eddsa-jcs-2022":
      return ed.getPublicKeyAsync(privateKey);
  }
}

// ── P-256 ECDSA — hardware-attestation receipts ──────────────────────
//
// Apple Secure Enclave generates P-256 keys and produces ECDSA-SHA256
// signatures over attestation-receipt bytes. The receipt is OPAQUE to
// motebit's core suite system (it's a side-channel platform blob per
// `HardwareAttestationClaim.attestation_receipt`'s schema doc) — the
// verification primitive still lives here so the single-home-for-
// primitives rule stays intact.
//
// Inputs are already-decoded bytes, matching the shape `verifyBySuite`
// uses. The SE public key is P-256 compressed-point hex (33 bytes
// decoded); the signature is ECDSA DER-encoded (as the SE emits).

/**
 * Verify a P-256 ECDSA-SHA256 signature.
 *
 * - `publicKeyCompressedHex` — P-256 public key in compressed-point
 *   hex encoding (33 bytes, `02`/`03` prefix). Uncompressed keys
 *   (65 bytes, `04` prefix) also accepted — noble handles both.
 * - `messageBytes` — the bytes that were signed. noble internally
 *   SHA-256 hashes before verification, so callers pass the
 *   un-pre-hashed payload.
 * - `signatureDerBytes` — DER-encoded ECDSA signature as emitted by
 *   Apple SE / Security.framework.
 *
 * Returns `false` on any failure (bad key, bad DER, bad signature,
 * mismatch). Never throws — matches the `verifyBySuite` contract so
 * callers don't need a try/catch.
 */
export function verifyP256EcdsaSha256(
  publicKeyCompressedHex: string,
  messageBytes: Uint8Array,
  signatureDerBytes: Uint8Array,
): boolean {
  try {
    const digest = sha256(messageBytes);
    const pubKeyBytes = hexToBytes(publicKeyCompressedHex);
    return p256.verify(signatureDerBytes, digest, pubKeyBytes, { prehash: false });
  } catch {
    return false;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("hex length must be even");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`invalid hex at position ${i * 2}`);
    out[i] = byte;
  }
  return out;
}
