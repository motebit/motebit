/**
 * The page's OWN check of the identity chain the relay served — the evidence
 * behind the PINNED rung and behind every sentence about how the signing key
 * relates to the motebit_id. `assess.ts` reads this, never the verifier's
 * `binding: "sovereign"`, because that one value covers two different checks
 * (the receipt-alone commitment and the time-windowed succession path), and
 * the page adds checks of its own (canonical id and key, chain root) that the
 * library does not make. The library no longer honours a guardian named only
 * by the file it verifies; the page strips that guardian anyway.
 *
 * Two rules, both fail-closed:
 *
 *   1. A guardian-recovery link never binds here. The guardian key's only
 *      source is the relay-served bundle — the same source as the chain it
 *      would authorize — so a relay (or anyone answering for it) could name a
 *      guardian of its own and "recover" any motebit to any key. The page has
 *      no guardian key with independent provenance, so it hands the verifier
 *      none: the identity is passed WITHOUT its `guardian`, and a recovery link
 *      fails the chain. A legitimately recovered motebit therefore reads below
 *      PINNED on this page — an under-claim, stated as such in the copy.
 *   2. For a self-certifying id (a UUIDv8 commitment or a `did:key`), the
 *      served chain must root at the key the id commits to. A chain rooted
 *      anywhere else is the relay's word against the id's own arithmetic.
 *      A legacy (UUIDv7/v4) id commits to no key, so its chain is the relay's
 *      record by construction — PINNED says "as served by the relay".
 *   3. Only an EXACTLY canonical id binds at all (`classifyId`): a lowercase
 *      UUIDv8, a lowercase `did:key:z…`, or a lowercase legacy UUIDv7/v4. The
 *      id is the signer's text and the relay echoes it back, so any other form
 *      (zero-width or bidi characters, a homoglyph, whitespace, upper case, a
 *      `urn:uuid:` prefix, braces, another UUID version) would otherwise fall
 *      through to the relay-record root and let a relay serve a chain for an id
 *      that renders identical to someone else's. Such an id binds nothing, and
 *      the copy says it is not in canonical form — never that it is forged.
 *   4. The same for the signing key: only exactly 64 lowercase hex binds or
 *      commits. The library decodes hex leniently, so a re-spelled key (an
 *      appended character, whitespace, a sign, upper case) verifies as the
 *      same bytes while a lookup keyed on its text misses (round 4, K1).
 *
 * The time is the receipt's CLAIMED time: `completed_at` is written by the
 * signer, so "bound" means the key fits the served window at the time the
 * receipt claims, not that the receipt was issued then. The window is only as
 * complete as the chain served: a later rotation the relay withheld cannot be
 * seen, which the PINNED copy says.
 */

import {
  verifyKeyBindingAtTime,
  verifySovereignBinding,
  type MotebitIdentityFile,
} from "@motebit/crypto";

/** The outcome of checking a relay-served chain against one receipt. */
export type ServedChainCheck =
  /** The key fits the window at the receipt's CLAIMED time in a chain verified without any guardian link. */
  | { readonly kind: "bound"; readonly root: "id-commitment" | "relay-record" }
  /** The chain is valid and names the key, but not as active at the receipt's claimed time. */
  | { readonly kind: "not_active" }
  /** The chain is valid and does not contain the key. */
  | { readonly kind: "not_in_chain" }
  /** The chain contains a guardian-recovery link, which this page cannot verify. */
  | { readonly kind: "recovery_unverifiable" }
  /** A self-certifying id, but the served chain roots at a different key. */
  | { readonly kind: "root_mismatch" }
  /** The served record is for another motebit_id. */
  | { readonly kind: "other_motebit" }
  /** The motebit_id is not in an exactly canonical form, so nothing binds to it. */
  | { readonly kind: "noncanonical_id" }
  /** The signing key is not written as exactly 64 lowercase hex characters, so nothing binds it. */
  | { readonly kind: "noncanonical_key" }
  /** The chain did not verify, or the receipt cannot be placed in time. */
  | { readonly kind: "invalid"; readonly reason: string };

/** How a motebit_id is written — and so what, if anything, it may bind through. */
export type IdForm = "uuidv8" | "did:key" | "legacy-uuid" | "noncanonical";

// Exact, lowercase, anchored. No `i` flag: an upper-case id is another string
// the relay can serve a chain for, not the same id.
const UUID_V8 = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_LEGACY = /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DID_KEY = /^did:key:z[1-9A-HJ-NP-Za-km-z]+$/;

/**
 * Classify `motebitId` by its exact text. Only the three canonical forms may
 * bind; everything else is `noncanonical` (rule 3 in the module comment).
 */
export function classifyId(motebitId: unknown): IdForm {
  if (typeof motebitId !== "string") return "noncanonical";
  if (UUID_V8.test(motebitId)) return "uuidv8";
  if (DID_KEY.test(motebitId)) return "did:key";
  if (UUID_LEGACY.test(motebitId)) return "legacy-uuid";
  return "noncanonical";
}

/** An id that commits to a key by itself: a canonical sovereign UUIDv8 or `did:key`. */
export function isSelfCertifyingId(motebitId: string): boolean {
  const form = classifyId(motebitId);
  return form === "uuidv8" || form === "did:key";
}

// The key's canonical form (canonical.ts `isCanonicalKeyHex`, inlined here so
// this module does not import the one that imports it): exactly 64 lowercase
// hex. The crypto library decodes hex leniently, so any other spelling of the
// same bytes would commit and bind just the same — and hide from a lookup
// keyed on the text (round 4, K1).
const KEY_HEX = /^[0-9a-f]{64}$/;

/**
 * True iff canonical `motebitId` is the self-certifying commitment to
 * `publicKeyHex`, itself in canonical form (never throws).
 */
export async function idCommitsToKey(motebitId: unknown, publicKeyHex: unknown): Promise<boolean> {
  if (typeof motebitId !== "string" || typeof publicKeyHex !== "string") return false;
  if (!KEY_HEX.test(publicKeyHex)) return false;
  if (!isSelfCertifyingId(motebitId)) return false;
  return verifySovereignBinding(motebitId, publicKeyHex);
}

/** Check `receipt`'s signing key against the relay-served `identity`. Never throws. */
export async function checkServedChain(
  receipt: {
    readonly motebit_id?: unknown;
    readonly public_key?: unknown;
    readonly completed_at?: unknown;
  },
  identity: MotebitIdentityFile,
): Promise<ServedChainCheck> {
  const { motebit_id: id, public_key: key, completed_at: at } = receipt;
  if (typeof id !== "string" || typeof key !== "string" || typeof at !== "number") {
    return { kind: "invalid", reason: "the receipt has no signing key or completion time" };
  }
  // Rule 3: a non-canonical id binds nothing, whatever the relay serves for it.
  const form = classifyId(id);
  if (form === "noncanonical") return { kind: "noncanonical_id" };
  // The same rule for the key: only its exact canonical spelling binds.
  if (!KEY_HEX.test(key)) return { kind: "noncanonical_key" };
  if (String(identity.motebit_id) !== id) return { kind: "other_motebit" };
  // Rule 1: no guardian key reaches the verifier — see the module comment.
  const { guardian: _fileNamedGuardian, ...withoutGuardian } = identity;
  try {
    const r = await verifyKeyBindingAtTime(withoutGuardian, key, at);
    if (r.bound) {
      if (form !== "legacy-uuid") {
        // Rule 2: the chain must root at the key the id commits to.
        return r.sovereign === true
          ? { kind: "bound", root: "id-commitment" }
          : { kind: "root_mismatch" };
      }
      return { kind: "bound", root: "relay-record" };
    }
    if ((identity.succession ?? []).some((s) => s.recovery === true)) {
      return { kind: "recovery_unverifiable" };
    }
    if (r.reason?.includes("not active") === true) return { kind: "not_active" };
    if (r.reason?.includes("not in this identity") === true) return { kind: "not_in_chain" };
    return { kind: "invalid", reason: r.reason ?? "the succession chain did not verify" };
  } catch (err) {
    return { kind: "invalid", reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Why a non-canonical motebit_id binds nothing — the same words wherever it is shown. */
export const NONCANONICAL_REASON =
  "this motebit_id is not in canonical form (a lowercase UUID or did:key with no extra, invisible or look-alike characters), so this page binds no key to it";

/** Why a served chain did not bind the key — one clause, for the copy. */
export function chainReason(kind: Exclude<ServedChainCheck["kind"], "bound">): string {
  switch (kind) {
    case "not_active":
      return "the key is in the chain but not active at the time this receipt claims (a signed rotation had moved it away, or it was not yet in use)";
    case "not_in_chain":
      return "the chain does not contain this key";
    case "recovery_unverifiable":
      return "the chain contains a guardian-recovery link, and the only source of its guardian key is the relay's own record, so this page does not honour it";
    case "root_mismatch":
      return "the chain does not root at the key this motebit_id commits to";
    case "noncanonical_id":
      return NONCANONICAL_REASON;
    case "noncanonical_key":
      return "the receipt's signing key is not in canonical form (exactly 64 lowercase hex characters)";
    case "other_motebit":
      return "the relay's record is for a different motebit_id";
    case "invalid":
      return "the chain did not verify";
  }
}
