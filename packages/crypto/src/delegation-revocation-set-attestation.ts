/**
 * Signed revocation evidence — `DelegationRevocationSetAttestation` and
 * `DelegationRevocationInclusionReceipt` sign/verify law, plus the two
 * relay-contradiction proof verifiers (spec/standing-delegation-v1.md
 * §5.2–§5.3, standing-delegation@1.3; `@motebit/protocol`
 * `delegation-revocation-set-attestation.ts`).
 *
 * The set attestation is an attestation (signer = relay ≠ subject = the
 * delegator's revocation set). The inclusion receipt is a receipt (signer =
 * subject: the relay records its own act of recording).
 *
 * What a verified set attestation establishes — exactly one sentence: "the
 * relay whose key the caller pinned said, at `as_of`, in answer to the
 * caller's challenge, that these are ALL the revocations it holds for this
 * delegator up to `seq_high_water`". It does NOT establish completeness
 * against a relay that omits a record it never receipted, nor non-equivocation
 * (another consumer may be shown a different attestation). It never confers
 * authority: it is an AND-condition on top of a verified grant — a grant is
 * refused when local ∪ attested revocations revoke it, and refused when no
 * acceptable attestation exists.
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
  DelegationRevocationSetAttestation,
  DelegationRevocationSetAttestationEntry,
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
export const DELEGATION_REVOCATION_EVIDENCE_SUITE = "motebit-jcs-ed25519-b64-v1" as const;

/**
 * Crypto-side mirrors of the protocol spec ids (crypto keeps ZERO runtime
 * monorepo deps; protocol is a type-only peer — the same mirroring reason as
 * `SYNC_HOLD_RECEIPT_SPEC_MIRROR`).
 */
export const DELEGATION_REVOCATION_SET_ATTESTATION_SPEC_MIRROR =
  "motebit/delegation-revocation-set-attestation@1.0" as const;
export const DELEGATION_REVOCATION_INCLUSION_RECEIPT_SPEC_MIRROR =
  "motebit/delegation-revocation-inclusion-receipt@1.0" as const;

/** Reference freshness window for a set attestation's `as_of` (spec §5.2 RECOMMENDED 60 s). */
export const REFERENCE_REVOCATION_SET_ATTESTATION_MAX_AGE_MS = 60_000;
/** Reference clock-skew tolerance for a set attestation's `as_of` (spec §5.2 RECOMMENDED ±60 s). */
export const REFERENCE_REVOCATION_SET_ATTESTATION_CLOCK_SKEW_MS = 60_000;

/**
 * Challenge length bounds (spec §5.2). A consumer MUST send a fresh,
 * unpredictable challenge of at least 128 bits of entropy per request (e.g. 32
 * random bytes as 64 hex characters); 32 characters is the floor at which a
 * hex challenge can carry 128 bits. 256 is the wire schema's maximum.
 */
export const REVOCATION_SET_ATTESTATION_CHALLENGE_MIN_LENGTH = 32;
export const REVOCATION_SET_ATTESTATION_CHALLENGE_MAX_LENGTH = 256;

const HEX64 = /^[0-9a-f]{64}$/;
const UTF8 = new TextEncoder();

/** The exact top-level keys of each artifact and of a set-attestation entry (the wire schemas are strict). */
const SET_ATTESTATION_KEYS: ReadonlySet<string> = new Set([
  "spec",
  "relay_motebit_id",
  "relay_public_key",
  "delegator_motebit_id",
  "challenge",
  "as_of",
  "seq_high_water",
  "count",
  "entries",
  "records_digest",
  "suite",
  "signature",
]);
const ENTRY_KEYS: ReadonlySet<string> = new Set(["seq", "received_at", "record"]);
const REVOCATION_KEYS: ReadonlySet<string> = new Set([
  "grant_id",
  "delegator_id",
  "delegator_public_key",
  "revoked_at",
  "suite",
  "signature",
]);
const INCLUSION_RECEIPT_KEYS: ReadonlySet<string> = new Set([
  "spec",
  "relay_motebit_id",
  "relay_public_key",
  "grant_id",
  "delegator_motebit_id",
  "revocation_signature",
  "seq",
  "received_at",
  "suite",
  "signature",
]);

/** True when every own key of `o` is in `allowed` (unknown fields are refused, as the wire schemas do). */
function hasOnlyKeys(o: unknown, allowed: ReadonlySet<string>): boolean {
  return typeof o === "object" && o !== null && Object.keys(o).every((k) => allowed.has(k));
}

function isChallenge(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.length >= REVOCATION_SET_ATTESTATION_CHALLENGE_MIN_LENGTH &&
    v.length <= REVOCATION_SET_ATTESTATION_CHALLENGE_MAX_LENGTH
  );
}

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
 * The records digest a set attestation commits to: lowercase hex SHA-256 of
 * the JCS-canonical `entries` array (spec §5.2). Producer and verifier compute
 * it the same way; it excludes `challenge` and `as_of`, so two attestations
 * over the same entries carry the same digest.
 */
export async function computeRevocationRecordsDigest(
  entries: readonly DelegationRevocationSetAttestationEntry[],
): Promise<string> {
  return canonicalSha256(entries);
}

// ── Set attestation ─────────────────────────────────────────────────────

/**
 * Sign a revocation set attestation with the relay's identity key. The signer
 * computes `count` and `records_digest` from `entries` itself, so a producer
 * cannot commit to a digest or count that disagrees with what it serves.
 * `entries` MUST already be strictly ascending by `seq`, each
 * `seq ≤ seq_high_water`, each record's `delegator_id` equal to the
 * attestation's `delegator_motebit_id` — the signer refuses (throws) otherwise
 * rather than emit an attestation every verifier rejects.
 */
export async function signRevocationSetAttestation(
  body: Omit<
    DelegationRevocationSetAttestation,
    "signature" | "suite" | "spec" | "count" | "records_digest"
  >,
  relayPrivateKey: Uint8Array,
): Promise<DelegationRevocationSetAttestation> {
  if (!HEX64.test(body.relay_public_key)) {
    throw new Error(
      "signRevocationSetAttestation: relay_public_key must be canonical (64 lowercase hex)",
    );
  }
  if (!isNonNegativeInt(body.seq_high_water)) {
    throw new Error(
      "signRevocationSetAttestation: seq_high_water must be a non-negative safe integer",
    );
  }
  let prev = 0;
  for (const e of body.entries) {
    if (!isPositiveSeq(e.seq) || e.seq <= prev || e.seq > body.seq_high_water) {
      throw new Error(
        "signRevocationSetAttestation: entries must be strictly ascending by seq, each 0 < seq <= seq_high_water",
      );
    }
    if (e.record.delegator_id !== body.delegator_motebit_id) {
      throw new Error(
        "signRevocationSetAttestation: every entry's record must be for the attested delegator",
      );
    }
    prev = e.seq;
  }
  const unsigned: Omit<DelegationRevocationSetAttestation, "signature"> = {
    spec: DELEGATION_REVOCATION_SET_ATTESTATION_SPEC_MIRROR,
    relay_motebit_id: body.relay_motebit_id,
    relay_public_key: body.relay_public_key,
    delegator_motebit_id: body.delegator_motebit_id,
    challenge: body.challenge,
    as_of: body.as_of,
    seq_high_water: body.seq_high_water,
    count: body.entries.length,
    entries: body.entries,
    records_digest: await computeRevocationRecordsDigest(body.entries),
    suite: DELEGATION_REVOCATION_EVIDENCE_SUITE,
  };
  const message = UTF8.encode(canonicalJsonForSigning(unsigned));
  const sig = await signBySuite(DELEGATION_REVOCATION_EVIDENCE_SUITE, message, relayPrivateKey);
  return { ...unsigned, signature: toBase64Url(sig) };
}

/** Coarse refusal codes a money-path consumer surfaces (the runtime adds `_unavailable` and `revocation_omission_detected`). */
export type RevocationSetAttestationRefusal =
  "revocation_evidence_invalid" | "revocation_evidence_stale" | "revocation_evidence_rollback";

/** Fine-grained reason for a set-attestation refusal, in verification order. */
export type RevocationSetAttestationFailureReason =
  | "missing_expectation"
  | "weak_challenge"
  | "malformed_attestation"
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

/** Structured set-attestation verdict — never a bare boolean. */
export type VerifyRevocationSetAttestationResult =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly refusal: RevocationSetAttestationRefusal;
      readonly reason: RevocationSetAttestationFailureReason;
    };

/** What the caller expects. Every field is REQUIRED except the two window overrides. */
export interface VerifyRevocationSetAttestationExpectations {
  /** The relay key the caller pins (hex). Resolved by the caller's pin store (succession-aware); mismatch fails. */
  readonly pinnedRelayPublicKey: string;
  /**
   * The challenge the caller sent. The attestation must echo it exactly. MUST
   * be fresh and unpredictable per request, with at least 128 bits of entropy
   * (e.g. 32 random bytes as hex); a challenge outside
   * [{@link REVOCATION_SET_ATTESTATION_CHALLENGE_MIN_LENGTH},
   * {@link REVOCATION_SET_ATTESTATION_CHALLENGE_MAX_LENGTH}] characters is
   * refused as `weak_challenge`. Replay protection holds only under that MUST:
   * a reused challenge lets any attestation answering it replay for the whole
   * freshness window.
   */
  readonly challenge: string;
  /** The delegator the caller asked about. */
  readonly delegatorMotebitId: string;
  /** The caller's clock, Unix ms. */
  readonly now: number;
  /**
   * The highest `seq_high_water` the caller has previously accepted from this
   * RELAY IDENTITY (`relay_motebit_id`), 0 when none. Track it per relay
   * identity, never per relay key: `seq` is relay-wide, and a relay key
   * succession must not reset the rollback floor.
   */
  readonly lastSeenSeq: number;
  /** Freshness window override (ms). Default {@link REFERENCE_REVOCATION_SET_ATTESTATION_MAX_AGE_MS}. */
  readonly maxAgeMs?: number;
  /** Clock-skew tolerance override (ms). Default {@link REFERENCE_REVOCATION_SET_ATTESTATION_CLOCK_SKEW_MS}. */
  readonly clockSkewMs?: number;
}

function invalid(
  reason: RevocationSetAttestationFailureReason,
): VerifyRevocationSetAttestationResult {
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

function isEntryShape(e: unknown): e is DelegationRevocationSetAttestationEntry {
  if (!hasOnlyKeys(e, ENTRY_KEYS)) return false;
  const o = e as Record<string, unknown>;
  return (
    isPositiveSeq(o.seq) &&
    isNonNegativeInt(o.received_at) &&
    isRevocationShape(o.record) &&
    hasOnlyKeys(o.record, REVOCATION_KEYS)
  );
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
      DELEGATION_REVOCATION_EVIDENCE_SUITE,
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
 * Verify a revocation set attestation against the caller's expectations, in
 * the spec §5.2 order. Fail-closed: every rejection returns a typed reason and
 * refusal code rather than throwing. Does NOT verify the embedded records'
 * delegator signatures — a record is authoritative over a grant only through
 * `findGrantRevocation`, which does; the attestation is accepted or refused as
 * a whole on the relay's accountability.
 */
export async function verifyRevocationSetAttestation(
  attestation: DelegationRevocationSetAttestation,
  expected: VerifyRevocationSetAttestationExpectations,
): Promise<VerifyRevocationSetAttestationResult> {
  // 0. Expectations — required, checked at runtime too (a JS caller, a cast).
  const exp = (expected ?? {}) as Partial<
    Record<keyof VerifyRevocationSetAttestationExpectations, unknown>
  >;
  if (
    !isNonEmptyString(exp.pinnedRelayPublicKey) ||
    !isNonEmptyString(exp.challenge) ||
    !isNonEmptyString(exp.delegatorMotebitId) ||
    !Number.isSafeInteger(exp.now) ||
    !isNonNegativeInt(exp.lastSeenSeq) ||
    (exp.maxAgeMs !== undefined && !isNonNegativeInt(exp.maxAgeMs)) ||
    (exp.clockSkewMs !== undefined && !isNonNegativeInt(exp.clockSkewMs))
  ) {
    return invalid("missing_expectation");
  }
  if (!isChallenge(exp.challenge)) return invalid("weak_challenge");
  const now = exp.now as number;
  const maxAgeMs = exp.maxAgeMs ?? REFERENCE_REVOCATION_SET_ATTESTATION_MAX_AGE_MS;
  const skewMs = exp.clockSkewMs ?? REFERENCE_REVOCATION_SET_ATTESTATION_CLOCK_SKEW_MS;
  const a = attestation;

  // 1. Schema — suite, spec, and every field this law reads, typed.
  if (typeof a !== "object" || a === null) return invalid("malformed_attestation");
  if (a.suite !== DELEGATION_REVOCATION_EVIDENCE_SUITE) return invalid("unsupported_suite");
  if (a.spec !== DELEGATION_REVOCATION_SET_ATTESTATION_SPEC_MIRROR) {
    return invalid("unsupported_spec");
  }
  if (
    !hasOnlyKeys(a, SET_ATTESTATION_KEYS) ||
    !isNonEmptyString(a.relay_motebit_id) ||
    !isNonEmptyString(a.delegator_motebit_id) ||
    !isChallenge(a.challenge) ||
    !isNonNegativeInt(a.as_of) ||
    !isNonNegativeInt(a.seq_high_water) ||
    !isNonNegativeInt(a.count) ||
    !Array.isArray(a.entries) ||
    !a.entries.every(isEntryShape) ||
    typeof a.records_digest !== "string" ||
    !HEX64.test(a.records_digest) ||
    typeof a.signature !== "string"
  ) {
    return invalid("malformed_attestation");
  }

  // 2. Pinned key — the embedded key proves only that someone signed.
  if (typeof a.relay_public_key !== "string" || !HEX64.test(a.relay_public_key)) {
    return invalid("malformed_public_key");
  }
  if (exp.pinnedRelayPublicKey.toLowerCase() !== a.relay_public_key) {
    return invalid("public_key_mismatch");
  }

  // 3. Signature over JCS(attestation minus signature), via suite dispatch.
  const sig = await verifyRelaySignature(a);
  if (sig !== "ok") return invalid(sig);

  // 4. Challenge + delegator (the attestation, and every entry's record).
  if (a.challenge !== exp.challenge) return invalid("challenge_mismatch");
  if (a.delegator_motebit_id !== exp.delegatorMotebitId) return invalid("delegator_mismatch");
  if (!a.entries.every((e) => e.record.delegator_id === a.delegator_motebit_id)) {
    return invalid("delegator_mismatch");
  }

  // 5. Strictly ascending seq; every seq ≤ high-water.
  let prev = 0;
  for (const e of a.entries) {
    if (e.seq <= prev) return invalid("entries_out_of_order");
    if (e.seq > a.seq_high_water) return invalid("entry_seq_exceeds_high_water");
    prev = e.seq;
  }

  // 6. Count.
  if (a.count !== a.entries.length) return invalid("count_mismatch");

  // 7. Records digest = SHA-256(JCS(entries)).
  if ((await computeRevocationRecordsDigest(a.entries)) !== a.records_digest) {
    return invalid("records_digest_mismatch");
  }

  // 8. Freshness: not older than window + skew, not newer than skew.
  if (now - a.as_of > maxAgeMs + skewMs) {
    return { valid: false, refusal: "revocation_evidence_stale", reason: "stale" };
  }
  if (a.as_of - now > skewMs) {
    return { valid: false, refusal: "revocation_evidence_stale", reason: "future_as_of" };
  }

  // 9. Rollback: never accept an attestation below one already accepted from this relay identity.
  if (a.seq_high_water < exp.lastSeenSeq) {
    return { valid: false, refusal: "revocation_evidence_rollback", reason: "rollback" };
  }

  return { valid: true };
}

// ── Inclusion receipt ───────────────────────────────────────────────────

/**
 * Sign an inclusion receipt for a recorded revocation. The relay names the
 * record by copying its `grant_id`, `delegator_id` (as `delegator_motebit_id`)
 * and `signature` from the revocation it stored, so a receipt cannot describe
 * a record it did not receive.
 */
export async function signRevocationInclusionReceipt(
  body: {
    relay_motebit_id: string;
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
    relay_motebit_id: body.relay_motebit_id,
    relay_public_key: body.relay_public_key,
    grant_id: body.revocation.grant_id,
    delegator_motebit_id: body.revocation.delegator_id,
    revocation_signature: body.revocation.signature,
    seq: body.seq,
    received_at: body.received_at,
    suite: DELEGATION_REVOCATION_EVIDENCE_SUITE,
  };
  const message = UTF8.encode(canonicalJsonForSigning(unsigned));
  const sig = await signBySuite(DELEGATION_REVOCATION_EVIDENCE_SUITE, message, relayPrivateKey);
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
  if (receipt.suite !== DELEGATION_REVOCATION_EVIDENCE_SUITE) {
    return { valid: false, reason: "unsupported_suite" };
  }
  if (receipt.spec !== DELEGATION_REVOCATION_INCLUSION_RECEIPT_SPEC_MIRROR) {
    return { valid: false, reason: "unsupported_spec" };
  }
  if (
    !hasOnlyKeys(receipt, INCLUSION_RECEIPT_KEYS) ||
    !isNonEmptyString(receipt.relay_motebit_id) ||
    !isNonEmptyString(receipt.grant_id) ||
    !isNonEmptyString(receipt.delegator_motebit_id) ||
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
    receipt.delegator_motebit_id !== rev.delegator_id ||
    receipt.revocation_signature !== rev.signature
  ) {
    return { valid: false, reason: "revocation_mismatch" };
  }
  return { valid: true };
}

// ── Relay-contradiction proofs ──────────────────────────────────────────

/** True when an artifact's own embedded relay key verifies its own signature. */
async function selfSigned(artifact: {
  suite: string;
  signature: string;
  relay_public_key: string;
}): Promise<boolean> {
  if (artifact.suite !== DELEGATION_REVOCATION_EVIDENCE_SUITE) return false;
  if (typeof artifact.relay_public_key !== "string" || !HEX64.test(artifact.relay_public_key)) {
    return false;
  }
  if (typeof artifact.signature !== "string") return false;
  return (await verifyRelaySignature(artifact)) === "ok";
}

/** Why an omission proof does not hold. */
export type RevocationOmissionProofFailureReason =
  | "unsupported_spec"
  | "malformed_artifact"
  | "relay_key_mismatch"
  | "delegator_mismatch"
  | "seq_not_covered"
  | "signature_invalid"
  | "record_carried";

/** `valid` means the omission proof HOLDS (the relay contradicted itself). */
export type VerifyRevocationOmissionProofResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: RevocationOmissionProofFailureReason };

/**
 * Omission proof (spec §5.3). `valid: true` exactly when the same relay key
 * signed an inclusion receipt for a record at `receipt.seq` AND a set
 * attestation for the same delegator whose `seq_high_water` covers that seq
 * but which does not carry that record at that seq. Both signatures are
 * verified under their (equal) embedded keys; a forged or mismatched pair
 * never yields a proof.
 *
 * `valid: false` does NOT mean "no omission": a relay that never issued a
 * receipt can omit a record undetectably (spec §8.1). Only a party holding
 * BOTH artifacts can run this check — in practice the device that submitted
 * the revocation; receipts are not propagated to the identity's other devices.
 */
export async function verifyRevocationOmissionProof(
  receipt: DelegationRevocationInclusionReceipt,
  attestation: DelegationRevocationSetAttestation,
): Promise<VerifyRevocationOmissionProofResult> {
  if (receipt.spec !== DELEGATION_REVOCATION_INCLUSION_RECEIPT_SPEC_MIRROR) {
    return { valid: false, reason: "unsupported_spec" };
  }
  if (attestation.spec !== DELEGATION_REVOCATION_SET_ATTESTATION_SPEC_MIRROR) {
    return { valid: false, reason: "unsupported_spec" };
  }
  if (
    !isPositiveSeq(receipt.seq) ||
    !isNonNegativeInt(attestation.seq_high_water) ||
    !Array.isArray(attestation.entries)
  ) {
    return { valid: false, reason: "malformed_artifact" };
  }
  if (receipt.relay_public_key !== attestation.relay_public_key) {
    return { valid: false, reason: "relay_key_mismatch" };
  }
  if (receipt.delegator_motebit_id !== attestation.delegator_motebit_id) {
    return { valid: false, reason: "delegator_mismatch" };
  }
  if (attestation.seq_high_water < receipt.seq) {
    return { valid: false, reason: "seq_not_covered" };
  }
  if (!(await selfSigned(receipt)) || !(await selfSigned(attestation))) {
    return { valid: false, reason: "signature_invalid" };
  }
  const carried = attestation.entries.some(
    (e) =>
      typeof e === "object" &&
      e !== null &&
      e.seq === receipt.seq &&
      typeof e.record === "object" &&
      e.record !== null &&
      e.record.signature === receipt.revocation_signature &&
      e.record.grant_id === receipt.grant_id,
  );
  if (carried) return { valid: false, reason: "record_carried" };
  return { valid: true };
}

/** Why an equivocation proof does not hold. */
export type RevocationEquivocationProofFailureReason =
  | "unsupported_spec"
  | "malformed_artifact"
  | "relay_key_mismatch"
  | "delegator_mismatch"
  | "seq_high_water_differs"
  | "same_records_digest"
  | "signature_invalid";

/** `valid` means the equivocation proof HOLDS (the relay signed two different sets at one seq). */
export type VerifyRevocationEquivocationProofResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: RevocationEquivocationProofFailureReason };

/**
 * Equivocation proof (spec §5.2). `valid: true` exactly when the same relay
 * key signed two set attestations for the same delegator at the same
 * `seq_high_water` with different `records_digest`s. Both signatures are
 * verified; a forged attestation never yields a proof. Attestations are
 * comparable by digest because the digest excludes `challenge` and `as_of`.
 * Sound only against a relay that assigns `seq` and commits the record
 * atomically (spec §5.2 relay atomicity); otherwise two honest attestations
 * at one `seq_high_water` could differ.
 */
export async function verifyRevocationEquivocationProof(
  a: DelegationRevocationSetAttestation,
  b: DelegationRevocationSetAttestation,
): Promise<VerifyRevocationEquivocationProofResult> {
  if (
    a.spec !== DELEGATION_REVOCATION_SET_ATTESTATION_SPEC_MIRROR ||
    b.spec !== DELEGATION_REVOCATION_SET_ATTESTATION_SPEC_MIRROR
  ) {
    return { valid: false, reason: "unsupported_spec" };
  }
  if (!isNonNegativeInt(a.seq_high_water) || typeof a.records_digest !== "string") {
    return { valid: false, reason: "malformed_artifact" };
  }
  if (a.relay_public_key !== b.relay_public_key) {
    return { valid: false, reason: "relay_key_mismatch" };
  }
  if (a.delegator_motebit_id !== b.delegator_motebit_id) {
    return { valid: false, reason: "delegator_mismatch" };
  }
  if (a.seq_high_water !== b.seq_high_water) {
    return { valid: false, reason: "seq_high_water_differs" };
  }
  if (a.records_digest === b.records_digest) {
    return { valid: false, reason: "same_records_digest" };
  }
  if (!(await selfSigned(a)) || !(await selfSigned(b))) {
    return { valid: false, reason: "signature_invalid" };
  }
  return { valid: true };
}
