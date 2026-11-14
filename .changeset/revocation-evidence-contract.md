---
"@motebit/protocol": minor
"@motebit/crypto": minor
---

Signed revocation evidence for standing grants (`standing-delegation@1.3`, spec §5.2–§5.3). Additive; nothing calls it on a money path yet.

- `@motebit/protocol`: `DelegationRevocationSetAttestation` (the relay's signed attestation of every revocation it holds for one delegator up to `seq_high_water`, answering a consumer challenge, committing to its entries by `records_digest`), `DelegationRevocationSetAttestationEntry`, `DelegationRevocationInclusionReceipt` (the relay's signed receipt that it recorded one revocation at `seq`), and the spec ids `DELEGATION_REVOCATION_SET_ATTESTATION_SPEC_ID` / `DELEGATION_REVOCATION_INCLUSION_RECEIPT_SPEC_ID`.
- `@motebit/crypto`: `signRevocationSetAttestation` / `verifyRevocationSetAttestation` (required expectations: pinned relay key, challenge, delegator, clock, last accepted seq; checked in spec order; returns a structured verdict with a `revocation_evidence_invalid | _stale | _rollback` refusal and a fine-grained reason, never a bare boolean), `signRevocationInclusionReceipt` / `verifyRevocationInclusionReceipt`, `computeRevocationRecordsDigest`, `verifyRevocationOmissionProof` (receipt + later set attestation from the same key that covers the seq but lacks the record), `verifyRevocationEquivocationProof` (two set attestations, same key, same delegator, same `seq_high_water`, different digests); both return `{ valid, reason? }` where `valid` means the proof holds, and the reference freshness defaults `REFERENCE_REVOCATION_SET_ATTESTATION_MAX_AGE_MS` / `REFERENCE_REVOCATION_SET_ATTESTATION_CLOCK_SKEW_MS` (60 s each).

The verifiers are strict like the wire schemas (unknown top-level, entry and record fields refused). The consumer's challenge MUST be fresh per request with at least 128 bits of entropy; `verifyRevocationSetAttestation` refuses a caller challenge outside `REVOCATION_SET_ATTESTATION_CHALLENGE_MIN_LENGTH`–`REVOCATION_SET_ATTESTATION_CHALLENGE_MAX_LENGTH` (32–256 characters) as `weak_challenge`, and `lastSeenSeq` is tracked per relay identity, never per key.

A verified set attestation guarantees integrity, freshness, no rollback and relay accountability; no replay holds only under the challenge MUST. It does not guarantee completeness against omission or non-equivocation, and a receipt plus a later set attestation proves relay self-contradiction, not independent acceptance (spec §8.1).
