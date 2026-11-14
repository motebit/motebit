/**
 * Signed revocation evidence for standing grants (standing-delegation@1.3,
 * spec/standing-delegation-v1.md §5.2–§5.3).
 *
 * The §5.1 GET feed is unsigned: it propagates `DelegationRevocation` records
 * (each signed by its delegator, so a record served there is authoritative
 * over its grant), but it cannot prove ABSENCE. A consumer that reads "no
 * revocation for grant G" from an unsigned feed has read nothing — any server
 * answering the relay's URL can serve an empty list. These two relay-signed
 * artifacts make the relay accountable for what it holds:
 *
 *   - {@link DelegationRevocationHead} — the relay's signed snapshot of EVERY
 *     revocation it holds for one delegator up to `seq_high_water`, over a
 *     challenge the consumer chose, with `records_digest` committing to the
 *     entries. It is the only source of "absent as of `as_of`". It never
 *     confers authority: a grant is honoured only if the grant verifies AND no
 *     known revocation (local ∪ head) revokes it.
 *   - {@link DelegationRevocationInclusionReceipt} — the relay's signed
 *     statement that it recorded one revocation at `seq`. Paired with a later
 *     head from the same relay key that covers `seq` but lacks the record, it
 *     proves the relay contradicted itself (omission). It is NOT independent
 *     evidence that anyone else accepted the revocation — the same key signs
 *     both.
 *
 * Both are receipt-family (subject = signer = relay: the relay records its own
 * holdings), domain-separated from each other and every other artifact by
 * their `spec` field. Sign/verify law lives in `@motebit/crypto`.
 *
 * JCS discipline: no optional fields, so canonical bytes are stable (RFC 8785).
 */

import type { DelegationRevocation } from "./index.js";

/** Spec discriminator of a {@link DelegationRevocationHead}. */
export const DELEGATION_REVOCATION_HEAD_SPEC_ID = "motebit/delegation-revocation-head@1.0" as const;

/** Spec discriminator of a {@link DelegationRevocationInclusionReceipt}. */
export const DELEGATION_REVOCATION_INCLUSION_RECEIPT_SPEC_ID =
  "motebit/delegation-revocation-inclusion-receipt@1.0" as const;

/** One revocation the relay holds, at the sequence number it assigned. */
export interface DelegationRevocationHeadEntry {
  /** The relay's receipt sequence number for this record (positive integer). Entries are strictly ascending by `seq`. */
  seq: number;
  /** Unix ms, the relay's receipt clock (never the signer-asserted `revoked_at`). */
  received_at: number;
  /** The `DelegationRevocation` exactly as the delegator signed it. Authoritative over a grant only via `findGrantRevocation`. */
  record: DelegationRevocation;
}

/**
 * The relay's signed snapshot of every `DelegationRevocation` it holds for one
 * delegator with `seq <= seq_high_water`, answering one consumer challenge.
 * Guarantees integrity, freshness (`as_of` + the consumer's challenge) and
 * relay accountability for "this is all I hold for this delegator at this
 * seq". Does NOT guarantee completeness against a relay that omits a record it
 * never receipted, nor non-equivocation (a relay can sign different heads for
 * different consumers; `records_digest` makes two such heads comparable).
 * See spec/standing-delegation-v1.md §5.2 and Security Considerations.
 */
export interface DelegationRevocationHead {
  /** Always {@link DELEGATION_REVOCATION_HEAD_SPEC_ID}. */
  spec: "motebit/delegation-revocation-head@1.0";
  /** The relay's motebit identity. */
  relay_id: string;
  /** The relay's Ed25519 public key, hex (64 lowercase). Verifiers compare it to the key they PIN; the embedded key alone proves nothing. */
  relay_public_key: string;
  /** The delegator whose revocations this head covers. Every entry's `record.delegator_id` equals it. */
  delegator_id: string;
  /** The consumer-chosen challenge, echoed. A head without the consumer's challenge answers no request of theirs (replay defence). */
  challenge: string;
  /** Unix ms at which the relay assembled the head. Consumers enforce a freshness window. */
  as_of: number;
  /** The relay's highest assigned receipt sequence number at `as_of` (non-negative integer). Every entry's `seq` is ≤ it. */
  seq_high_water: number;
  /** Number of entries. MUST equal `entries.length`. */
  count: number;
  /** Every held revocation for `delegator_id` with `seq <= seq_high_water`, strictly ascending by `seq`. */
  entries: DelegationRevocationHeadEntry[];
  /** hex(SHA-256(JCS(entries))), 64 lowercase. Excludes `challenge`/`as_of`, so two heads at the same `seq_high_water` are comparable by digest. */
  records_digest: string;
  /** Cryptosuite discriminator. Always `"motebit-jcs-ed25519-b64-v1"`. */
  suite: "motebit-jcs-ed25519-b64-v1";
  /** Base64url Ed25519 signature over JCS(this object minus `signature`), by `relay_public_key`. */
  signature: string;
}

/**
 * The relay's signed statement that it recorded one `DelegationRevocation` at
 * `seq`. The POST revocation response carries it; a revocation counts as
 * propagated only when the submitter verifies one against the pinned relay
 * key. Paired with a later head (same relay key, same delegator, `seq_high_water
 * >= seq`) that lacks the record, it proves relay self-contradiction — never
 * independent acceptance (same signer). See spec §5.3.
 */
export interface DelegationRevocationInclusionReceipt {
  /** Always {@link DELEGATION_REVOCATION_INCLUSION_RECEIPT_SPEC_ID}. */
  spec: "motebit/delegation-revocation-inclusion-receipt@1.0";
  /** The relay's motebit identity. */
  relay_id: string;
  /** The relay's Ed25519 public key, hex (64 lowercase). Verifiers compare it to the key they PIN. */
  relay_public_key: string;
  /** The revoked grant (the record's `grant_id`). */
  grant_id: string;
  /** The revoking delegator (the record's `delegator_id`). */
  delegator_id: string;
  /** The recorded `DelegationRevocation.signature`, verbatim — the record's identity (the relay is idempotent on it). */
  revocation_signature: string;
  /** The receipt sequence number the relay assigned to the record (positive integer). */
  seq: number;
  /** Unix ms, the relay's receipt clock. */
  received_at: number;
  /** Cryptosuite discriminator. Always `"motebit-jcs-ed25519-b64-v1"`. */
  suite: "motebit-jcs-ed25519-b64-v1";
  /** Base64url Ed25519 signature over JCS(this object minus `signature`), by `relay_public_key`. */
  signature: string;
}
