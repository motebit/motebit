/**
 * FIXTURE — signers that go through the guarded canonicalizer. Scanned only
 * via `check-signed-text-wellformed --fixture`; none may be flagged.
 */
import { canonicalJson, canonicalJsonForSigning, signBySuite } from "@motebit/crypto";

function bodyBytes(body: unknown, canonicalize: (v: unknown) => string): Uint8Array {
  return new TextEncoder().encode(canonicalize(body));
}

export async function signGuardedDirect(body: object, key: Uint8Array): Promise<Uint8Array> {
  const message = new TextEncoder().encode(canonicalJsonForSigning(body));
  return signBySuite("motebit-jcs-ed25519-b64-v1", message, key);
}

export async function signGuardedViaHelper(body: object, key: Uint8Array): Promise<Uint8Array> {
  return signBySuite("motebit-jcs-ed25519-b64-v1", bodyBytes(body, canonicalJsonForSigning), key);
}

/** A verifier twin may keep canonicalJson — it never signs. */
export function verifyBytes(body: object): Uint8Array {
  return bodyBytes(body, canonicalJson);
}
