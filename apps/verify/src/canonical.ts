/**
 * Exact canonical form for every identity-bearing field the receipt's signer
 * writes. The signer chooses the TEXT of `motebit_id`, `public_key`,
 * `signature` and `suite`; the verifier decodes the key and the signature
 * leniently (an appended character, whitespace, a sign, upper case, padding or
 * the standard base64 alphabet can all decode to the same bytes), so a
 * re-spelled field still verifies — while anything keyed on the text (a
 * revocation lookup, a relay record, a comparison) sees a different string.
 *
 * The rule, for the whole field class: a field not in its exact canonical form
 * earns no binding and no revocation verdict above "not established". The copy
 * says the field is "not in canonical form" (or, for the suite, "suite not
 * recognized") — never that it is forged: a re-spelled field may be honest.
 *
 *   motebit_id   a lowercase UUIDv8, `did:key:z…`, or legacy UUIDv7/v4
 *                (`classifyId` in served-chain.ts)
 *   public_key   exactly 64 lowercase hex characters (the spec's "hex, 64
 *                characters"; the producer writes lowercase)
 *   signature    exactly unpadded base64url of 64 bytes (RFC 4648 §5, no
 *                padding, as the receipt suite encodes it): 86 characters
 *                whose last carries no stray low bits
 *   suite        exactly `motebit-jcs-ed25519-b64-v1` — the only suite an
 *                execution receipt is signed and verified under; the
 *                verifier ignores the field, so any other value is the
 *                signer's unchecked text
 */

import { bytesToHex, didKeyToPublicKey } from "@motebit/crypto";
import { classifyId, NONCANONICAL_REASON } from "./served-chain.js";

/** The one suite an execution receipt is signed under (spec/execution-ledger-v1.md). */
export const RECEIPT_SUITE = "motebit-jcs-ed25519-b64-v1";

/** The identity-bearing fields the signer writes, in the order the copy names them. */
export type FormField = "motebit_id" | "public_key" | "signature" | "suite";

const KEY_HEX = /^[0-9a-f]{64}$/;
// 86 base64url characters = 516 bits for 512: the last character's low 4 bits
// must be zero, so it is one of A, Q, g, w.
const SIG_B64URL = /^[A-Za-z0-9_-]{85}[AQgw]$/;

/** `public_key` is exactly 64 lowercase hex characters. */
export function isCanonicalKeyHex(v: unknown): v is string {
  return typeof v === "string" && KEY_HEX.test(v);
}

/** `signature` is exactly the unpadded base64url encoding of 64 bytes. */
export function isCanonicalSignature(v: unknown): boolean {
  return typeof v === "string" && SIG_B64URL.test(v);
}

/** `suite` is exactly the receipt suite. */
export function isRecognizedSuite(v: unknown): boolean {
  return v === RECEIPT_SUITE;
}

/** Every identity-bearing field of `receipt` not in exact canonical form (fixed order). */
export function noncanonicalFields(receipt: unknown): FormField[] {
  const r = (typeof receipt === "object" && receipt !== null ? receipt : {}) as Record<
    string,
    unknown
  >;
  const out: FormField[] = [];
  if (classifyId(r["motebit_id"]) === "noncanonical") out.push("motebit_id");
  if (!isCanonicalKeyHex(r["public_key"])) out.push("public_key");
  if (!isCanonicalSignature(r["signature"])) out.push("signature");
  if (!isRecognizedSuite(r["suite"])) out.push("suite");
  return out;
}

/** Why a field not in canonical form binds nothing — one clause per field, for the copy. */
export function formReason(field: FormField): string {
  switch (field) {
    case "motebit_id":
      return NONCANONICAL_REASON;
    case "public_key":
      return "this receipt's signing key (public_key) is not in canonical form (exactly 64 lowercase hex characters), so this page binds no key to it and establishes no revocation status for it";
    case "signature":
      return "this receipt's signature is not in canonical form (unpadded base64url of 64 bytes, the encoding its suite specifies), so this page binds no key to it and establishes no revocation status for it";
    case "suite":
      return `suite not recognized — this receipt names a suite other than ${RECEIPT_SUITE}, the suite execution receipts are signed under, so this page binds no key to it and establishes no revocation status for it`;
  }
}

/**
 * The canonical lowercase hex of the key the signature actually verified
 * under, read back from the verifier's `did:key` (derived from the DECODED key
 * bytes) — so a lookup keyed on it finds the key's memos however the receipt
 * spelled `public_key`. Undefined when there is no usable did:key.
 */
export function canonicalKeyHexOfDid(did: string | undefined): string | undefined {
  if (did === undefined) return undefined;
  try {
    const key = didKeyToPublicKey(did);
    return key.length === 32 ? bytesToHex(key) : undefined;
  } catch {
    return undefined;
  }
}
