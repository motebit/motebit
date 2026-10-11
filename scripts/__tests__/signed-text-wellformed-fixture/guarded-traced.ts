/**
 * FIXTURE — guarded signers the data-flow trace must follow (none may be
 * flagged): a namespace import, local variables, a digest, and a buffer
 * assembled only from guarded digests. `Math.sign` is not a signer.
 */
import * as C from "@motebit/crypto";
import { canonicalJsonForSigning, ed25519Sign } from "@motebit/crypto";

declare function sha256(bytes: Uint8Array): Promise<Uint8Array>;

export async function signGuardedNamespace(body: object, key: Uint8Array): Promise<Uint8Array> {
  return C.signBySuite(
    "motebit-jcs-ed25519-b64-v1",
    new TextEncoder().encode(C.canonicalJsonForSigning(body)),
    key,
  );
}

export async function signGuardedViaVariables(body: object, key: Uint8Array): Promise<Uint8Array> {
  const payload = canonicalJsonForSigning(body);
  const message = new TextEncoder().encode(payload);
  return ed25519Sign(message, key);
}

export async function signGuardedConcat(
  a: object,
  b: object,
  key: Uint8Array,
): Promise<Uint8Array> {
  const ha = await sha256(new TextEncoder().encode(canonicalJsonForSigning(a)));
  const hb = await sha256(new TextEncoder().encode(canonicalJsonForSigning(b)));
  const combined = new Uint8Array(ha.length + hb.length);
  combined.set(ha);
  combined.set(hb, ha.length);
  return ed25519Sign(combined, key);
}

export function notASigner(x: number): number {
  return Math.sign(x);
}
