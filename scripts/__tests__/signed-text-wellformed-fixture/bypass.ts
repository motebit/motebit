/**
 * FIXTURE — planted signers that sidestep the guarded canonicalizer.
 *
 * Scanned only via `check-signed-text-wellformed --fixture`; the real scan
 * skips `__tests__/`. Each function here must be flagged.
 */
import { canonicalJson, ed25519Sign, sign as productSign } from "@motebit/encryption";

declare function signBySuite(
  suite: string,
  bytes: Uint8Array,
  key: Uint8Array,
): Promise<Uint8Array>;
declare function opaqueBytes(body: unknown): Uint8Array;

/** Signs canonicalJson bytes directly — the bypass the gate exists for. */
export async function signPlantedReceipt(body: object, key: Uint8Array): Promise<Uint8Array> {
  const message = new TextEncoder().encode(canonicalJson(body));
  return signBySuite("motebit-jcs-ed25519-b64-v1", message, key);
}

/** Same bypass through the `sign` product alias. */
export async function signPlantedAlias(body: object, key: Uint8Array): Promise<Uint8Array> {
  return productSign(new TextEncoder().encode(canonicalJson(body)), key);
}

/** Bytes from a helper the gate cannot trace to the guard. */
export async function signPlantedUntraced(body: object, key: Uint8Array): Promise<Uint8Array> {
  return ed25519Sign(opaqueBytes(body), key);
}
