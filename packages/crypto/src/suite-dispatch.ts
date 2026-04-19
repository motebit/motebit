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
