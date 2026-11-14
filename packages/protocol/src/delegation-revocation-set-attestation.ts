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
 *   - {@link DelegationRevocationSetAttestation} — the relay's signed
 *     statement of EVERY revocation it holds for one delegator up to
 *     `seq_high_water`, over a challenge the consumer chose, with
 *     `records_digest` committing to the entries. Signer (relay) ≠ subject
 *     (the delegator's revocation set), so it is an attestation. It is the
 *     only source of "absent as of `as_of`". It never confers authority: a
 *     grant is honoured only if the grant verifies AND no known revocation
 *     (local ∪ attestation) revokes it.
 *   - {@link DelegationRevocationInclusionReceipt} — the relay's signed record
 *     of its own act of recording one revocation at `seq` (signer = subject,
 *     a receipt). Paired with a later set attestation from the same relay key
 *     that covers `seq` but lacks the record, it proves the relay contradicted
 *     itself (omission). It is NOT independent evidence that anyone else
 *     accepted the revocation — the same key signs both.
 *
 * Each is domain-separated from the other and from every other artifact by
 * its `spec` field. Sign/verify law lives in `@motebit/crypto`.
 *
 * JCS discipline: no optional fields, so canonical bytes are stable (RFC 8785).
 */

import type { DelegationRevocation } from "./index.js";

/** Spec discriminator of a {@link DelegationRevocationSetAttestation}. */
export const DELEGATION_REVOCATION_SET_ATTESTATION_SPEC_ID =
  "motebit/delegation-revocation-set-attestation@1.0" as const;

/** Spec discriminator of a {@link DelegationRevocationInclusionReceipt}. */
export const DELEGATION_REVOCATION_INCLUSION_RECEIPT_SPEC_ID =
  "motebit/delegation-revocation-inclusion-receipt@1.0" as const;

/** One revocation the relay holds, at the sequence number it assigned. */
export interface DelegationRevocationSetAttestationEntry {
  /** The relay's receipt sequence number for this record (positive integer). Entries are strictly ascending by `seq`. */
  seq: number;
  /** Unix ms, the relay's receipt clock (never the signer-asserted `revoked_at`). */
  received_at: number;
  /** The `DelegationRevocation` exactly as the delegator signed it (its own frozen `delegator_id` field). Authoritative over a grant only via `findGrantRevocation`. */
  record: DelegationRevocation;
}

/**
 * The relay's signed statement of every `DelegationRevocation` it holds for
 * one delegator with `seq <= seq_high_water`, answering one consumer
 * challenge. Guarantees integrity, freshness (`as_of` + the consumer's
 * challenge) and relay accountability for "this is all I hold for this
 * delegator at this seq". Does NOT guarantee completeness against a relay that
 * omits a record it never receipted, nor non-equivocation (a relay can sign
 * different attestations for different consumers; `records_digest` makes two
 * such attestations comparable). See spec/standing-delegation-v1.md §5.2 and §8.1.
 */
export interface DelegationRevocationSetAttestation {
  /** Always {@link DELEGATION_REVOCATION_SET_ATTESTATION_SPEC_ID}. */
  spec: "motebit/delegation-revocation-set-attestation@1.0";
  /** The relay's motebit identity. */
  relay_motebit_id: string;
  /** The relay's Ed25519 public key, hex (64 lowercase). Verifiers compare it to the key they PIN; the embedded key alone proves nothing. */
  relay_public_key: string;
  /** The delegator whose revocation set this attests. Every entry's `record.delegator_id` equals it. */
  delegator_motebit_id: string;
  /** The consumer-chosen challenge, echoed (32–256 chars). The consumer MUST make it fresh and unpredictable per request, ≥ 128 bits of entropy; replay protection holds only then. */
  challenge: string;
  /** Unix ms at which the relay assembled the attestation. Consumers enforce a freshness window. */
  as_of: number;
  /** The relay's highest receipt sequence number of a COMMITTED, visible record at `as_of` (non-negative integer; the relay assigns and commits atomically). Every entry's `seq` is ≤ it. Consumers track the rollback floor per `relay_motebit_id`, never per key. */
  seq_high_water: number;
  /** Number of entries. MUST equal `entries.length`. */
  count: number;
  /** Every held revocation for `delegator_motebit_id` with `seq <= seq_high_water`, strictly ascending by `seq`. */
  entries: DelegationRevocationSetAttestationEntry[];
  /** hex(SHA-256(JCS(entries))), 64 lowercase. Excludes `challenge`/`as_of`, so two attestations at the same `seq_high_water` are comparable by digest. */
  records_digest: string;
  /** Cryptosuite discriminator. Always `"motebit-jcs-ed25519-b64-v1"`. */
  suite: "motebit-jcs-ed25519-b64-v1";
  /** Base64url Ed25519 signature over JCS(this object minus `signature`), by `relay_public_key`. */
  signature: string;
}

/**
 * The relay's signed record that it recorded one `DelegationRevocation` at
 * `seq`. The POST revocation response carries it; a revocation counts as
 * propagated only when the submitter verifies one against the pinned relay
 * key. Paired with a later set attestation (same relay key, same delegator,
 * `seq_high_water >= seq`) that lacks the record, it proves relay
 * self-contradiction — never independent acceptance (same signer). See spec §5.3.
 */
export interface DelegationRevocationInclusionReceipt {
  /** Always {@link DELEGATION_REVOCATION_INCLUSION_RECEIPT_SPEC_ID}. */
  spec: "motebit/delegation-revocation-inclusion-receipt@1.0";
  /** The relay's motebit identity. */
  relay_motebit_id: string;
  /** The relay's Ed25519 public key, hex (64 lowercase). Verifiers compare it to the key they PIN. */
  relay_public_key: string;
  /** The revoked grant (the record's `grant_id`). */
  grant_id: string;
  /** The revoking delegator (the record's `delegator_id`). */
  delegator_motebit_id: string;
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
