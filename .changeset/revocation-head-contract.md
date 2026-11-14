---
"@motebit/protocol": minor
"@motebit/crypto": minor
---

Signed revocation evidence for standing grants (`standing-delegation@1.3`, spec §5.2–§5.3). Additive; nothing calls it on a money path yet.

- `@motebit/protocol`: `DelegationRevocationHead` (the relay's signed snapshot of every revocation it holds for one delegator up to `seq_high_water`, answering a consumer challenge, committing to its entries by `records_digest`), `DelegationRevocationHeadEntry`, `DelegationRevocationInclusionReceipt` (the relay's signed statement that it recorded one revocation at `seq`), and the spec ids `DELEGATION_REVOCATION_HEAD_SPEC_ID` / `DELEGATION_REVOCATION_INCLUSION_RECEIPT_SPEC_ID`.
- `@motebit/crypto`: `signRevocationHead` / `verifyRevocationHead` (required expectations: pinned relay key, challenge, delegator, clock, last accepted seq; checked in spec order; returns a structured verdict with a `revocation_evidence_invalid | _stale | _rollback` refusal and a fine-grained reason, never a bare boolean), `signRevocationInclusionReceipt` / `verifyRevocationInclusionReceipt`, `computeRevocationRecordsDigest`, `detectRevocationOmission` (receipt + later head from the same key that covers the seq but lacks the record), `detectRevocationEquivocation` (two heads, same key, same delegator, same `seq_high_water`, different digests), and the reference freshness defaults `REFERENCE_REVOCATION_HEAD_MAX_AGE_MS` / `REFERENCE_REVOCATION_HEAD_CLOCK_SKEW_MS` (60 s each).

A verified head guarantees integrity, freshness, no rollback and relay accountability. It does not guarantee completeness against omission or non-equivocation, and a receipt plus a later head proves relay self-contradiction, not independent acceptance (spec §8.1).
