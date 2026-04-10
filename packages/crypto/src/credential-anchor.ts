/**
 * Credential anchor leaf computation — motebit/credential-anchor@1.0 §3.
 *
 * MIT: the leaf hash format is part of the open protocol. Any implementation
 * can compute and verify credential leaves using this function.
 *
 * SHA-256(canonicalJson(credential)) — includes the proof field so the
 * leaf binds the credential to its issuer's Ed25519 signature.
 */

import { canonicalJson, sha256 } from "./signing.js";

/** Hex-encode a Uint8Array. */
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Compute a credential leaf hash for Merkle anchoring.
 *
 * The input is the full W3C VC 2.0 credential including its `proof` field.
 * The proof is included because it binds the credential to its issuer's
 * signature — without it, anyone could claim arbitrary credential content.
 *
 * @param credential - Full verifiable credential object (with proof)
 * @returns Hex-encoded SHA-256 hash
 */
export async function computeCredentialLeaf(credential: Record<string, unknown>): Promise<string> {
  const canonical = canonicalJson(credential);
  const hash = await sha256(new TextEncoder().encode(canonical));
  return toHex(hash);
}
