/**
 * Signed revocation evidence — `DelegationRevocationHead` and
 * `DelegationRevocationInclusionReceipt` sign/verify law, plus the two
 * relay-contradiction detectors (spec/standing-delegation-v1.md §5.2–§5.3,
 * standing-delegation@1.3; `@motebit/protocol` `delegation-revocation-head.ts`).
 *
 * Receipt family: subject = signer = relay (it records its own holdings).
 *
 * What a verified head establishes — exactly one sentence: "the relay whose key
 * the caller pinned said, at `as_of`, in answer to the caller's challenge, that
 * these are ALL the revocations it holds for this delegator up to
 * `seq_high_water`". It does NOT establish completeness against a relay that
 * omits a record it never receipted, nor non-equivocation (another consumer
 * may be shown a different head). It never confers authority: the head is an
 * AND-condition on top of a verified grant — a grant is refused when local ∪
 * head revocations revoke it, and refused when no acceptable head exists.
 *
 * Expectations are REQUIRED (docs/doctrine/verify-family-fail-closed.md):
 * there is no unpinned mode, no "skip freshness" mode, no "skip rollback"
 * mode. A missing expectation is `missing_expectation`.
 *
 * Verification order (spec §5.2, binding): schema → pinned key → signature →
 * challenge + delegator → order + seq ≤ high-water → count → records digest →
 * freshness → rollback. Each refusal carries a fine-grained `reason` and the
 * coarse money-path `refusal` code the runtime surfaces.
 */

import type {
  DelegationRevocation,
  DelegationRevocationHead,
  DelegationRevocationHeadEntry,
  DelegationRevocationInclusionReceipt,
} from "@motebit/protocol";
import {
  canonicalJson,
  canonicalJsonForSigning,
  canonicalSha256,
  fromBase64Url,
  hexToBytes,
  toBase64Url,
} from "./signing.js";
import { signBySuite, verifyBySuite } from "./suite-dispatch.js";

/** The one suite both artifacts sign under (JCS, Ed25519, base64url signature, hex keys). */
export const DELEGATION_REVOCATION_HEAD_SUITE = "motebit-jcs-ed25519-b64-v1" as const;

/**
 * Crypto-side mirrors of the protocol spec ids (crypto keeps ZERO runtime
 * monorepo deps; protocol is a type-only peer — the same mirroring reason as
 * `SYNC_HOLD_RECEIPT_SPEC_MIRROR`).
 */
export const DELEGATION_REVOCATION_HEAD_SPEC_MIRROR =
  "motebit/delegation-revocation-head@1.0" as const;
export const DELEGATION_REVOCATION_INCLUSION_RECEIPT_SPEC_MIRROR =
  "motebit/delegation-revocation-inclusion-receipt@1.0" as const;

/** Reference freshness window for a head's `as_of` (spec §5.2 RECOMMENDED 60 s). */
export const REFERENCE_REVOCATION_HEAD_MAX_AGE_MS = 60_000;
/** Reference clock-skew tolerance for a head's `as_of` (spec §5.2 RECOMMENDED ±60 s). */
export const REFERENCE_REVOCATION_HEAD_CLOCK_SKEW_MS = 60_000;

const HEX64 = /^[0-9a-f]{64}$/;
const UTF8 = new TextEncoder();

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}
function isPositiveSeq(n: unknown): n is number {
  return Number.isSafeInteger(n) && (n as number) > 0;
}
function isNonNegativeInt(n: unknown): n is number {
  return Number.isSafeInteger(n) && (n as number) >= 0;
}

/**
 * The records digest a head commits to: lowercase hex SHA-256 of the
 * JCS-canonical `entries` array (spec §5.2). Producer and verifier compute it
 * the same way; it excludes `challenge` and `as_of`, so two heads over the
 * same entries carry the same digest.
 */
export async function computeRevocationRecordsDigest(
  entries: readonly DelegationRevocationHeadEntry[],
): Promise<string> {
  return canonicalSha256(entries);
}

// ── Head ────────────────────────────────────────────────────────────────

/**
 * Sign a revocation head with the relay's identity key. The signer computes
 * `count` and `records_digest` from `entries` itself, so a producer cannot
 * commit to a digest or count that disagrees with what it serves. `entries`
 * MUST already be strictly ascending by `seq`, each `seq ≤ seq_high_water`,
 * each record's `delegator_id` equal to the head's — the signer refuses
 * (throws) otherwise rather than emit a head every verifier rejects.
 */
export async function signRevocationHead(
  body: Omit<DelegationRevocationHead, "signature" | "suite" | "spec" | "count" | "records_digest">,
  relayPrivateKey: Uint8Array,
): Promise<DelegationRevocationHead> {
  if (!HEX64.test(body.relay_public_key)) {
    throw new Error("signRevocationHead: relay_public_key must be canonical (64 lowercase hex)");
  }
  if (!isNonNegativeInt(body.seq_high_water)) {
    throw new Error("signRevocationHead: seq_high_water must be a non-negative safe integer");
  }
  let prev = 0;
  for (const e of body.entries) {
    if (!isPositiveSeq(e.seq) || e.seq <= prev || e.seq > body.seq_high_water) {
      throw new Error(
        "signRevocationHead: entries must be strictly ascending by seq, each 0 < seq <= seq_high_water",
      );
    }
    if (e.record.delegator_id !== body.delegator_id) {
      throw new Error("signRevocationHead: every entry's record must be for the head's delegator");
    }
    prev = e.seq;
  }
  const unsigned: Omit<DelegationRevocationHead, "signature"> = {
    spec: DELEGATION_REVOCATION_HEAD_SPEC_MIRROR,
    relay_id: body.relay_id,
    relay_public_key: body.relay_public_key,
    delegator_id: body.delegator_id,
    challenge: body.challenge,
    as_of: body.as_of,
    seq_high_water: body.seq_high_water,
    count: body.entries.length,
    entries: body.entries,
    records_digest: await computeRevocationRecordsDigest(body.entries),
    suite: DELEGATION_REVOCATION_HEAD_SUITE,
  };
  const message = UTF8.encode(canonicalJsonForSigning(unsigned));
  const sig = await signBySuite(DELEGATION_REVOCATION_HEAD_SUITE, message, relayPrivateKey);
  return { ...unsigned, signature: toBase64Url(sig) };
}

/** Coarse refusal codes a money-path consumer surfaces (the runtime adds `_unavailable` and `revocation_omission_detected`). */
export type RevocationHeadRefusal =
  "revocation_evidence_invalid" | "revocation_evidence_stale" | "revocation_evidence_rollback";

/** Fine-grained reason for a head refusal, in verification order. */
export type RevocationHeadFailureReason =
  | "missing_expectation"
  | "malformed_head"
  | "unsupported_suite"
  | "unsupported_spec"
  | "malformed_public_key"
  | "public_key_mismatch"
  | "malformed_signature"
  | "signature_invalid"
  | "challenge_mismatch"
  | "delegator_mismatch"
  | "entries_out_of_order"
  | "entry_seq_exceeds_high_water"
  | "count_mismatch"
  | "records_digest_mismatch"
  | "stale"
  | "future_as_of"
  | "rollback";

/** Structured head verdict — never a bare boolean. */
export type VerifyRevocationHeadResult =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly refusal: RevocationHeadRefusal;
      readonly reason: RevocationHeadFailureReason;
    };

/** What the caller expects. Every field is REQUIRED except the two window overrides. */
export interface VerifyRevocationHeadExpectations {
  /** The relay key the caller pins (hex). Resolved by the caller's pin store (succession-aware); mismatch fails. */
  readonly pinnedRelayPublicKey: string;
  /** The challenge the caller sent. The head must echo it exactly. */
  readonly challenge: string;
  /** The delegator the caller asked about. */
  readonly delegatorId: string;
  /** The caller's clock, Unix ms. */
  readonly now: number;
  /** The highest `seq_high_water` the caller has previously accepted from this relay key (0 when none). */
  readonly lastSeenSeq: number;
  /** Freshness window override (ms). Default {@link REFERENCE_REVOCATION_HEAD_MAX_AGE_MS}. */
  readonly maxAgeMs?: number;
  /** Clock-skew tolerance override (ms). Default {@link REFERENCE_REVOCATION_HEAD_CLOCK_SKEW_MS}. */
  readonly clockSkewMs?: number;
}

function invalid(reason: RevocationHeadFailureReason): VerifyRevocationHeadResult {
  return { valid: false, refusal: "revocation_evidence_invalid", reason };
}

function isRevocationShape(r: unknown): r is DelegationRevocation {
  if (typeof r !== "object" || r === null) return false;
  const o = r as Record<string, unknown>;
  return (
    isNonEmptyString(o.grant_id) &&
    isNonEmptyString(o.delegator_id) &&
    typeof o.delegator_public_key === "string" &&
    typeof o.revoked_at === "number" &&
    typeof o.suite === "string" &&
    isNonEmptyString(o.signature)
  );
}

function isEntryShape(e: unknown): e is DelegationRevocationHeadEntry {
  if (typeof e !== "object" || e === null) return false;
  const o = e as Record<string, unknown>;
  return isPositiveSeq(o.seq) && isNonNegativeInt(o.received_at) && isRevocationShape(o.record);
}

async function verifyRelaySignature(artifact: {
  suite: string;
  signature: string;
  relay_public_key: string;
}): Promise<"ok" | "malformed_signature" | "signature_invalid"> {
  let sigBytes: Uint8Array;
  try {
    sigBytes = fromBase64Url(artifact.signature);
  } catch {
    return "malformed_signature";
  }
  if (sigBytes.length !== 64) return "malformed_signature";
  const { signature: _sig, ...unsigned } = artifact;
  const message = UTF8.encode(canonicalJson(unsigned));
  try {
    const ok = await verifyBySuite(
      DELEGATION_REVOCATION_HEAD_SUITE,
      message,
      sigBytes,
      hexToBytes(artifact.relay_public_key),
    );
    return ok ? "ok" : "signature_invalid";
  } catch {
    return "signature_invalid";
  }
}

/**
 * Verify a revocation head against the caller's expectations, in the spec
 * §5.2 order. Fail-closed: every rejection returns a typed reason and refusal
 * code rather than throwing. Does NOT verify the embedded records' delegator
 * signatures — a record is authoritative over a grant only through
 * `findGrantRevocation`, which does; the head is accepted or refused as a
 * whole on the relay's accountability.
 */
export async function verifyRevocationHead(
  head: DelegationRevocationHead,
  expected: VerifyRevocationHeadExpectations,
): Promise<VerifyRevocationHeadResult> {
  // 0. Expectations — required, checked at runtime too (a JS caller, a cast).
  const exp = (expected ?? {}) as Partial<Record<keyof VerifyRevocationHeadExpectations, unknown>>;
  if (
    !isNonEmptyString(exp.pinnedRelayPublicKey) ||
    !isNonEmptyString(exp.challenge) ||
    !isNonEmptyString(exp.delegatorId) ||
    !Number.isSafeInteger(exp.now) ||
    !isNonNegativeInt(exp.lastSeenSeq) ||
    (exp.maxAgeMs !== undefined && !isNonNegativeInt(exp.maxAgeMs)) ||
    (exp.clockSkewMs !== undefined && !isNonNegativeInt(exp.clockSkewMs))
  ) {
    return invalid("missing_expectation");
  }
  const now = exp.now as number;
  const maxAgeMs = exp.maxAgeMs ?? REFERENCE_REVOCATION_HEAD_MAX_AGE_MS;
  const skewMs = exp.clockSkewMs ?? REFERENCE_REVOCATION_HEAD_CLOCK_SKEW_MS;

  // 1. Schema — suite, spec, and every field this law reads, typed.
  if (typeof head !== "object" || head === null) return invalid("malformed_head");
  if (head.suite !== DELEGATION_REVOCATION_HEAD_SUITE) return invalid("unsupported_suite");
  if (head.spec !== DELEGATION_REVOCATION_HEAD_SPEC_MIRROR) return invalid("unsupported_spec");
  if (
    !isNonEmptyString(head.relay_id) ||
    !isNonEmptyString(head.delegator_id) ||
    !isNonEmptyString(head.challenge) ||
    !isNonNegativeInt(head.as_of) ||
    !isNonNegativeInt(head.seq_high_water) ||
    !isNonNegativeInt(head.count) ||
    !Array.isArray(head.entries) ||
    !head.entries.every(isEntryShape) ||
    typeof head.records_digest !== "string" ||
    !HEX64.test(head.records_digest) ||
    typeof head.signature !== "string"
  ) {
    return invalid("malformed_head");
  }

  // 2. Pinned key — the embedded key proves only that someone signed.
  if (typeof head.relay_public_key !== "string" || !HEX64.test(head.relay_public_key)) {
    return invalid("malformed_public_key");
  }
  if (exp.pinnedRelayPublicKey.toLowerCase() !== head.relay_public_key) {
    return invalid("public_key_mismatch");
  }

  // 3. Signature over JCS(head minus signature), via suite dispatch.
  const sig = await verifyRelaySignature(head);
  if (sig !== "ok") return invalid(sig);

  // 4. Challenge + delegator (head and every entry).
  if (head.challenge !== exp.challenge) return invalid("challenge_mismatch");
  if (head.delegator_id !== exp.delegatorId) return invalid("delegator_mismatch");
  if (!head.entries.every((e) => e.record.delegator_id === head.delegator_id)) {
    return invalid("delegator_mismatch");
  }

  // 5. Strictly ascending seq; every seq ≤ high-water.
  let prev = 0;
  for (const e of head.entries) {
    if (e.seq <= prev) return invalid("entries_out_of_order");
    if (e.seq > head.seq_high_water) return invalid("entry_seq_exceeds_high_water");
    prev = e.seq;
  }

  // 6. Count.
  if (head.count !== head.entries.length) return invalid("count_mismatch");

  // 7. Records digest = SHA-256(JCS(entries)).
  if ((await computeRevocationRecordsDigest(head.entries)) !== head.records_digest) {
    return invalid("records_digest_mismatch");
  }

  // 8. Freshness: not older than window + skew, not newer than skew.
  if (now - head.as_of > maxAgeMs + skewMs) {
    return { valid: false, refusal: "revocation_evidence_stale", reason: "stale" };
  }
  if (head.as_of - now > skewMs) {
    return { valid: false, refusal: "revocation_evidence_stale", reason: "future_as_of" };
  }

  // 9. Rollback: never accept a head below one already accepted from this key.
  if (head.seq_high_water < exp.lastSeenSeq) {
    return { valid: false, refusal: "revocation_evidence_rollback", reason: "rollback" };
  }

  return { valid: true };
}

// ── Inclusion receipt ───────────────────────────────────────────────────

/**
 * Sign an inclusion receipt for a recorded revocation. The relay names the
 * record by copying its `grant_id`, `delegator_id` and `signature` from the
 * revocation it stored, so a receipt cannot describe a record it did not
 * receive.
 */
export async function signRevocationInclusionReceipt(
  body: {
    relay_id: string;
    relay_public_key: string;
    revocation: DelegationRevocation;
    seq: number;
    received_at: number;
  },
  relayPrivateKey: Uint8Array,
): Promise<DelegationRevocationInclusionReceipt> {
  if (!HEX64.test(body.relay_public_key)) {
    throw new Error(
      "signRevocationInclusionReceipt: relay_public_key must be canonical (64 lowercase hex)",
    );
  }
  if (!isPositiveSeq(body.seq)) {
    throw new Error("signRevocationInclusionReceipt: seq must be a positive safe integer");
  }
  const unsigned: Omit<DelegationRevocationInclusionReceipt, "signature"> = {
    spec: DELEGATION_REVOCATION_INCLUSION_RECEIPT_SPEC_MIRROR,
    relay_id: body.relay_id,
    relay_public_key: body.relay_public_key,
    grant_id: body.revocation.grant_id,
    delegator_id: body.revocation.delegator_id,
    revocation_signature: body.revocation.signature,
    seq: body.seq,
    received_at: body.received_at,
    suite: DELEGATION_REVOCATION_HEAD_SUITE,
  };
  const message = UTF8.encode(canonicalJsonForSigning(unsigned));
  const sig = await signBySuite(DELEGATION_REVOCATION_HEAD_SUITE, message, relayPrivateKey);
  return { ...unsigned, signature: toBase64Url(sig) };
}

/** Fine-grained reason for an inclusion-receipt refusal. */
export type RevocationInclusionReceiptFailureReason =
  | "missing_expectation"
  | "malformed_receipt"
  | "unsupported_suite"
  | "unsupported_spec"
  | "malformed_public_key"
  | "public_key_mismatch"
  | "malformed_signature"
  | "signature_invalid"
  | "revocation_mismatch";

/** Structured inclusion-receipt verdict. */
export type VerifyRevocationInclusionReceiptResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: RevocationInclusionReceiptFailureReason };

/** What the submitter expects. Both REQUIRED. */
export interface VerifyRevocationInclusionReceiptExpectations {
  /** The relay key the submitter pins (hex). */
  readonly pinnedRelayPublicKey: string;
  /** The revocation the submitter POSTed; the receipt must name exactly it. */
  readonly revocation: DelegationRevocation;
}

/**
 * Verify an inclusion receipt: shape, suite, spec, pinned key, signature, and
 * that it names exactly the revocation the submitter sent (grant, delegator,
 * signature). A verified receipt proves "the pinned relay said it recorded
 * this revocation at `seq`" — not that any other party accepted it.
 */
export async function verifyRevocationInclusionReceipt(
  receipt: DelegationRevocationInclusionReceipt,
  expected: VerifyRevocationInclusionReceiptExpectations,
): Promise<VerifyRevocationInclusionReceiptResult> {
  const exp = (expected ?? {}) as Partial<
    Record<keyof VerifyRevocationInclusionReceiptExpectations, unknown>
  >;
  if (!isNonEmptyString(exp.pinnedRelayPublicKey) || !isRevocationShape(exp.revocation)) {
    return { valid: false, reason: "missing_expectation" };
  }
  const rev = exp.revocation;
  if (typeof receipt !== "object" || receipt === null) {
    return { valid: false, reason: "malformed_receipt" };
  }
  if (receipt.suite !== DELEGATION_REVOCATION_HEAD_SUITE) {
    return { valid: false, reason: "unsupported_suite" };
  }
  if (receipt.spec !== DELEGATION_REVOCATION_INCLUSION_RECEIPT_SPEC_MIRROR) {
    return { valid: false, reason: "unsupported_spec" };
  }
  if (
    !isNonEmptyString(receipt.relay_id) ||
    !isNonEmptyString(receipt.grant_id) ||
    !isNonEmptyString(receipt.delegator_id) ||
    !isNonEmptyString(receipt.revocation_signature) ||
    !isPositiveSeq(receipt.seq) ||
    !isNonNegativeInt(receipt.received_at) ||
    typeof receipt.signature !== "string"
  ) {
    return { valid: false, reason: "malformed_receipt" };
  }
  if (typeof receipt.relay_public_key !== "string" || !HEX64.test(receipt.relay_public_key)) {
    return { valid: false, reason: "malformed_public_key" };
  }
  if (exp.pinnedRelayPublicKey.toLowerCase() !== receipt.relay_public_key) {
    return { valid: false, reason: "public_key_mismatch" };
  }
  const sig = await verifyRelaySignature(receipt);
  if (sig !== "ok") return { valid: false, reason: sig };
  if (
    receipt.grant_id !== rev.grant_id ||
    receipt.delegator_id !== rev.delegator_id ||
    receipt.revocation_signature !== rev.signature
  ) {
    return { valid: false, reason: "revocation_mismatch" };
  }
  return { valid: true };
}

// ── Relay-contradiction detectors ───────────────────────────────────────

/** True when an artifact's own embedded relay key verifies its own signature. */
async function selfSigned(artifact: {
  suite: string;
  signature: string;
  relay_public_key: string;
}): Promise<boolean> {
  if (artifact.suite !== DELEGATION_REVOCATION_HEAD_SUITE) return false;
  if (typeof artifact.relay_public_key !== "string" || !HEX64.test(artifact.relay_public_key)) {
    return false;
  }
  if (typeof artifact.signature !== "string") return false;
  return (await verifyRelaySignature(artifact)) === "ok";
}

/**
 * Omission proof (spec §5.3): `true` exactly when the same relay key signed
 * an inclusion receipt for a record at `receipt.seq` AND a head for the same
 * delegator whose `seq_high_water` covers that seq but which does not carry
 * that record at that seq. Both signatures are verified under their (equal)
 * embedded keys; a forged or mismatched pair yields `false`, never a proof.
 *
 * `false` does NOT mean "no omission": a relay that never issued a receipt
 * can omit a record undetectably (spec Security Considerations).
 */
export async function detectRevocationOmission(
  receipt: DelegationRevocationInclusionReceipt,
  head: DelegationRevocationHead,
): Promise<boolean> {
  if (receipt.spec !== DELEGATION_REVOCATION_INCLUSION_RECEIPT_SPEC_MIRROR) return false;
  if (head.spec !== DELEGATION_REVOCATION_HEAD_SPEC_MIRROR) return false;
  if (receipt.relay_public_key !== head.relay_public_key) return false;
  if (receipt.delegator_id !== head.delegator_id) return false;
  if (!isPositiveSeq(receipt.seq) || !isNonNegativeInt(head.seq_high_water)) return false;
  if (head.seq_high_water < receipt.seq) return false;
  if (!Array.isArray(head.entries)) return false;
  if (!(await selfSigned(receipt)) || !(await selfSigned(head))) return false;
  const carried = head.entries.some(
    (e) =>
      typeof e === "object" &&
      e !== null &&
      e.seq === receipt.seq &&
      typeof e.record === "object" &&
      e.record !== null &&
      e.record.signature === receipt.revocation_signature &&
      e.record.grant_id === receipt.grant_id,
  );
  return !carried;
}

/**
 * Equivocation proof (spec §5.2): `true` exactly when the same relay key
 * signed two heads for the same delegator at the same `seq_high_water` with
 * different `records_digest`s. Both signatures are verified; a forged head
 * yields `false`. Heads are comparable by digest because the digest excludes
 * `challenge` and `as_of`.
 */
export async function detectRevocationEquivocation(
  headA: DelegationRevocationHead,
  headB: DelegationRevocationHead,
): Promise<boolean> {
  if (headA.spec !== DELEGATION_REVOCATION_HEAD_SPEC_MIRROR) return false;
  if (headB.spec !== DELEGATION_REVOCATION_HEAD_SPEC_MIRROR) return false;
  if (headA.relay_public_key !== headB.relay_public_key) return false;
  if (headA.delegator_id !== headB.delegator_id) return false;
  if (!isNonNegativeInt(headA.seq_high_water)) return false;
  if (headA.seq_high_water !== headB.seq_high_water) return false;
  if (headA.records_digest === headB.records_digest) return false;
  if (!(await selfSigned(headA)) || !(await selfSigned(headB))) return false;
  return true;
}
