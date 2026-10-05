/**
 * SyncHoldReceipt signing + verification (`@motebit/protocol`
 * `sync-hold-receipt.ts`; spec/sync-hold-receipt-v1.md).
 *
 * The category law is subject = signer: the relay signs a record of its OWN
 * act of holding events, so the receipt is receipt-family first-person
 * provenance (docs/doctrine/receipts-unified.md), not an attestation. The
 * verify law establishes exactly one sentence — "the relay whose key the
 * caller pinned said, at `issued_at`, in answer to the nonce the caller sent,
 * that it holds these event ids for this motebit with these digests" — and
 * DELIBERATELY nothing more (NOT durability: a relay may later delete under
 * its retention policy; the receipt records what it held when it signed).
 *
 * The three expectations are REQUIRED (docs/doctrine/verify-family-fail-closed.md):
 * the pinned relay key, the nonce the caller sent, and the motebit the caller
 * asked about. A receipt carries its own key, so a check without a pin would
 * accept any attacker's self-consistent receipt; a receipt without the
 * caller's nonce answers no request of the caller's; a receipt for another
 * motebit describes someone else's events. There is no unpinned mode — a
 * missing, empty or non-string expectation is `missing_expectation`.
 *
 * Fail-closed at every step: missing expectation, unknown suite or spec,
 * malformed shape, an event list inconsistent with the page range it claims,
 * motebit mismatch, key mismatch, nonce mismatch, malformed key/signature,
 * signature mismatch.
 */

import type { SyncHoldReceipt, SyncHeldEvent } from "@motebit/protocol";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import {
  bytesToHex,
  canonicalJson,
  canonicalSha256,
  hexToBytes,
  toBase64Url,
  fromBase64Url,
} from "./signing.js";
import { signBySuite, verifyBySuite } from "./suite-dispatch.js";

/**
 * The pinned suite for SyncHoldReceipt signing (JCS canonicalization,
 * Ed25519, base64url signature encoding). PQ migration = a new `SuiteId` in
 * `@motebit/protocol` + a new dispatch arm in `suite-dispatch.ts`.
 */
export const SYNC_HOLD_RECEIPT_SUITE = "motebit-jcs-ed25519-b64-v1" as const;

/**
 * Crypto-side mirror of the protocol spec id (crypto keeps ZERO runtime
 * monorepo deps; protocol is a type-only devDependency — the same mirroring
 * reason as `ROUTING_TRANSCRIPT_SPEC_MIRROR`).
 */
export const SYNC_HOLD_RECEIPT_SPEC_MIRROR = "motebit/sync-hold-receipt@1.0" as const;

/**
 * The digest a SyncHoldReceipt lists for one event: lowercase hex SHA-256 of
 * the JCS-canonical entry, exactly as the relay serves it (without `seq`).
 * Producer and verifier compute it the same way.
 */
export async function computeSyncEventDigest(entry: unknown): Promise<string> {
  return canonicalSha256(entry);
}

const UTF8 = new TextEncoder();

/** A synchronous SHA-256 over bytes (raw 32-byte digest). */
export type SyncDigestHash = (bytes: Uint8Array) => Uint8Array;

/**
 * The same digest as {@link computeSyncEventDigest}, computed synchronously —
 * for a producer that digests a whole pull page per request, where one
 * awaited `crypto.subtle` call per event dominates the cost. `hash` defaults
 * to `@noble/hashes` SHA-256; a host with a native synchronous SHA-256 (Node's
 * `node:crypto`) may inject it. The value is identical either way (pinned by
 * test against the async form).
 */
export function computeSyncEventDigestSync(
  entry: unknown,
  hash: SyncDigestHash = nobleSha256,
): string {
  return bytesToHex(hash(UTF8.encode(canonicalJson(entry))));
}

/** Canonical bytes used for signing — the receipt without its own signature field. */
function canonicalizeForSigning(unsigned: Omit<SyncHoldReceipt, "signature">): Uint8Array {
  return new TextEncoder().encode(canonicalJson(unsigned));
}

/**
 * Sign a sync hold receipt with the relay's identity key. The body must
 * already carry `relay_public_key` (lowercase hex of the key that pairs with
 * `relayPrivateKey`) — the artifact is self-describing.
 *
 * JCS discipline: build optional fields (`nonce`, `page`, `seq`) by
 * conditional spread upstream; this primitive signs the body it is given.
 */
export async function signSyncHoldReceipt(
  body: Omit<SyncHoldReceipt, "signature" | "suite">,
  relayPrivateKey: Uint8Array,
): Promise<SyncHoldReceipt> {
  const unsigned: Omit<SyncHoldReceipt, "signature"> = {
    ...body,
    suite: SYNC_HOLD_RECEIPT_SUITE,
  };
  const message = canonicalizeForSigning(unsigned);
  const sig = await signBySuite(SYNC_HOLD_RECEIPT_SUITE, message, relayPrivateKey);
  return { ...unsigned, signature: toBase64Url(sig) };
}

/** Verification outcome with a structured failure reason for audit logging. */
export interface VerifySyncHoldReceiptResult {
  readonly valid: boolean;
  /** Structured failure reason when `valid === false`. */
  readonly reason?:
    | "missing_expectation"
    | "unsupported_suite"
    | "unsupported_spec"
    | "malformed_receipt"
    | "page_mismatch"
    | "motebit_id_mismatch"
    | "public_key_mismatch"
    | "nonce_mismatch"
    | "malformed_public_key"
    | "malformed_signature"
    | "signature_invalid";
}

/**
 * What the caller expects. All three are REQUIRED — there is no unpinned
 * mode; a missing or empty value is rejected (`missing_expectation`).
 */
export interface VerifySyncHoldReceiptExpectations {
  /** The relay key the caller pins (lowercase or uppercase hex). Mismatch fails. */
  readonly expectedPublicKey: string;
  /** The nonce the caller sent. The receipt must echo it exactly. */
  readonly expectedNonce: string;
  /** The motebit the caller pushed or pulled for. The receipt's `motebit_id` must equal it. */
  readonly expectedMotebitId: string;
}

function isExpectation(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

const HEX64 = /^[0-9a-f]{64}$/;

function isHeldEvent(e: unknown): e is SyncHeldEvent {
  if (typeof e !== "object" || e === null) return false;
  const r = e as Record<string, unknown>;
  if (typeof r.event_id !== "string" || r.event_id.length === 0) return false;
  if (typeof r.digest !== "string" || !HEX64.test(r.digest)) return false;
  if (typeof r.redacted !== "boolean") return false;
  if (r.seq !== undefined && !(Number.isSafeInteger(r.seq) && (r.seq as number) > 0)) return false;
  return true;
}

function isSeq(n: unknown): n is number {
  return Number.isSafeInteger(n) && (n as number) >= 0;
}

/**
 * Verify a sync hold receipt. See the module doc for what this law
 * deliberately does NOT check. Fail-closed: every rejection returns a typed
 * reason rather than throwing.
 */
export async function verifySyncHoldReceipt(
  receipt: SyncHoldReceipt,
  expected: VerifySyncHoldReceiptExpectations,
): Promise<VerifySyncHoldReceiptResult> {
  // 0. Expectations — required, checked at runtime too (a JS caller, a cast).
  const exp = (expected ?? {}) as Partial<Record<keyof VerifySyncHoldReceiptExpectations, unknown>>;
  if (
    !isExpectation(exp.expectedPublicKey) ||
    !isExpectation(exp.expectedNonce) ||
    !isExpectation(exp.expectedMotebitId)
  ) {
    return { valid: false, reason: "missing_expectation" };
  }

  // 1. Suite — fail-closed on unknown/missing (crypto CLAUDE.md rule 3).
  if (receipt.suite !== SYNC_HOLD_RECEIPT_SUITE) {
    return { valid: false, reason: "unsupported_suite" };
  }

  // 2. Spec — the domain-separating discriminator.
  if (receipt.spec !== SYNC_HOLD_RECEIPT_SPEC_MIRROR) {
    return { valid: false, reason: "unsupported_spec" };
  }

  // 3. Shape — every field this law reads, typed.
  const events: readonly unknown[] = Array.isArray(receipt.events) ? receipt.events : [];
  if (
    !Array.isArray(receipt.events) ||
    typeof receipt.motebit_id !== "string" ||
    typeof receipt.relay_motebit_id !== "string" ||
    !Number.isSafeInteger(receipt.issued_at) ||
    typeof receipt.nonce !== "string" ||
    !events.every(isHeldEvent)
  ) {
    return { valid: false, reason: "malformed_receipt" };
  }
  const held: readonly SyncHeldEvent[] = events;
  if (new Set(held.map((e) => e.event_id)).size !== held.length) {
    return { valid: false, reason: "malformed_receipt" };
  }

  // 4. Page consistency — a page receipt lists seq-carrying events inside its
  //    range, in order; a push receipt lists none with a seq. A page receipt
  //    may list a SUBSET of the page: the relay omits an event whose
  //    redaction status it cannot establish (spec §4.5), so the last listed
  //    seq may sit below `next_seq`. An omitted event is simply not credited.
  const page = receipt.page;
  if (page !== undefined) {
    if (
      typeof page !== "object" ||
      page === null ||
      !isSeq(page.after_seq) ||
      !isSeq(page.next_seq) ||
      !isSeq(page.latest_seq) ||
      typeof page.has_more !== "boolean"
    ) {
      return { valid: false, reason: "malformed_receipt" };
    }
    if (page.next_seq < page.after_seq) return { valid: false, reason: "page_mismatch" };
    let prev = page.after_seq;
    for (const e of held) {
      if (e.seq === undefined || e.seq <= prev || e.seq > page.next_seq) {
        return { valid: false, reason: "page_mismatch" };
      }
      prev = e.seq;
    }
  } else if (held.some((e) => e.seq !== undefined)) {
    return { valid: false, reason: "page_mismatch" };
  }

  // 5. Subject — the motebit the caller asked about.
  if (receipt.motebit_id !== exp.expectedMotebitId) {
    return { valid: false, reason: "motebit_id_mismatch" };
  }

  // 6. Relay key shape + pin.
  if (typeof receipt.relay_public_key !== "string" || !HEX64.test(receipt.relay_public_key)) {
    return { valid: false, reason: "malformed_public_key" };
  }
  if (exp.expectedPublicKey.toLowerCase() !== receipt.relay_public_key) {
    return { valid: false, reason: "public_key_mismatch" };
  }

  // 7. Nonce echo — a receipt without the caller's nonce answers no request of its.
  if (receipt.nonce !== exp.expectedNonce) {
    return { valid: false, reason: "nonce_mismatch" };
  }

  // 8. Signature bytes.
  let sigBytes: Uint8Array;
  try {
    sigBytes = fromBase64Url(receipt.signature);
  } catch {
    return { valid: false, reason: "malformed_signature" };
  }
  if (sigBytes.length !== 64) {
    return { valid: false, reason: "malformed_signature" };
  }

  // 9. Signature over canonical bytes, via suite dispatch.
  const { signature: _sig, ...unsigned } = receipt;
  const message = canonicalizeForSigning(unsigned);
  let valid: boolean;
  try {
    valid = await verifyBySuite(
      receipt.suite,
      message,
      sigBytes,
      hexToBytes(receipt.relay_public_key),
    );
  } catch {
    return { valid: false, reason: "signature_invalid" };
  }
  if (!valid) {
    return { valid: false, reason: "signature_invalid" };
  }
  return { valid: true };
}
