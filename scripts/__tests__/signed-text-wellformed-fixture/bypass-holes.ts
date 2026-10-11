/**
 * FIXTURE — the two holes a cold review found in the first version of the
 * gate. Scanned only via `check-signed-text-wellformed --fixture`; each
 * function here must be flagged.
 *
 *   (a) a primitive reached through a property access — a namespace import,
 *       noble's `ed.signAsync`, an element access, a re-bound method — which a
 *       visitor matching only bare identifiers never saw;
 *   (b) a DECOY guard: the function calls canonicalJsonForSigning, but the
 *       bytes it signs do not come from it — "guard called anywhere in the
 *       function" passed them.
 */
import * as C from "@motebit/crypto";
import { canonicalJson, canonicalJsonForSigning, ed25519Sign } from "@motebit/crypto";
import * as ed from "@noble/ed25519";

const SUITE = "motebit-jcs-ed25519-b64-v1";
declare function opaqueBytes(body: unknown): Uint8Array;

/** (a) `C.signBySuite` over canonicalJson bytes, via a namespace import. */
export async function signPlantedNamespace(body: object, key: Uint8Array): Promise<Uint8Array> {
  return C.signBySuite(SUITE, new TextEncoder().encode(C.canonicalJson(body)), key);
}

/** (a) noble's `ed.signAsync` over canonicalJson bytes. */
export async function signPlantedNoble(body: object, key: Uint8Array): Promise<Uint8Array> {
  const message = new TextEncoder().encode(canonicalJson(body));
  return ed.signAsync(message, key);
}

/** (a) An element access: `C["ed25519Sign"](…)`. */
export async function signPlantedElementAccess(body: object, key: Uint8Array): Promise<Uint8Array> {
  return C["ed25519Sign"](new TextEncoder().encode(canonicalJson(body)), key);
}

/** (a) A method re-bound to a local name. */
export async function signPlantedRebound(body: object, key: Uint8Array): Promise<Uint8Array> {
  const s = C.ed25519Sign;
  return s(new TextEncoder().encode(canonicalJson(body)), key);
}

/** (b) Decoy: the guard runs, its output is discarded, canonicalJson bytes are signed. */
export async function signPlantedDecoy(body: object, key: Uint8Array): Promise<Uint8Array> {
  const checked = canonicalJsonForSigning(body);
  void checked;
  return C.signBySuite(SUITE, new TextEncoder().encode(canonicalJson(body)), key);
}

/** (b) Decoy: the guard runs, but the signed bytes come from an untraceable helper. */
export async function signPlantedDecoyUntraced(body: object, key: Uint8Array): Promise<Uint8Array> {
  canonicalJsonForSigning(body);
  return ed25519Sign(opaqueBytes(body), key);
}

/** (b) Decoy: the signed variable is reassigned from canonicalJson after the guard. */
export async function signPlantedReassigned(body: object, key: Uint8Array): Promise<Uint8Array> {
  let payload = canonicalJsonForSigning(body);
  payload = canonicalJson(body);
  return ed25519Sign(new TextEncoder().encode(payload), key);
}
