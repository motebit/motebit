# Signed revocation evidence conformance corpus

Versioned, pinnable vectors for the signed revocation evidence of `standing-delegation@1.3` ([`standing-delegation-v1.md`](../../standing-delegation-v1.md) §5.2–§5.3): the relay-signed `DelegationRevocationSetAttestation`, the relay-signed `DelegationRevocationInclusionReceipt`, and the two relay-contradiction proofs. A second implementation runs **its** law over each case's `input` and must produce the identical `expected`.

## Families

- **`attestation`**: `verifyRevocationSetAttestation(attestation, expectations)`. `expectations` carries the pinned relay key, the challenge sent, the delegator asked about (`delegatorMotebitId`), the consumer clock (`now`) and the last accepted `seq_high_water` (`lastSeenSeq`). The expected value is `{ valid: true }` or `{ valid: false, refusal, reason }`, checked in the spec §5.2 order: schema, pinned key, signature, challenge and delegator, order and seq ≤ high-water, count, records digest, freshness (60 s window plus 60 s skew), rollback.
- **`receipt`**: `verifyRevocationInclusionReceipt(receipt, { pinnedRelayPublicKey, revocation })`. The expected value is `{ valid: true }` or `{ valid: false, reason }`.
- **`omission`**: `verifyRevocationOmissionProof(receipt, attestation)`. `{ valid: true }` (the proof holds) only when the same relay key signed a receipt at `seq` and a set attestation for the same delegator that covers `seq` without carrying the record there; otherwise `{ valid: false, reason }`.
- **`equivocation`**: `verifyRevocationEquivocationProof(attestationA, attestationB)`. `{ valid: true }` only when the same relay key signed two set attestations for the same delegator at the same `seq_high_water` with different `records_digest`; otherwise `{ valid: false, reason }`.

Set attestations that break a producer rule (out-of-order entries, wrong count, wrong digest, a foreign delegator's entry) are forged by signing the raw body, because the reference producer refuses to emit them.

## Deliberately NOT checked

- **Each entry's delegator signature.** An entry revokes a grant only through the §5.1 binding check (`findGrantRevocation`).
- **Completeness and non-equivocation.** A verified set attestation is not proof that the relay holds nothing else, nor that other consumers saw the same attestation (spec §8.1).

## Regenerating

All artifacts are signed with fixed test keys. Ed25519 is deterministic, so the corpus is byte-stable:

```
npx tsx scripts/gen-delegation-revocation-set-attestation-corpus.ts
```

The generator checks every expectation against the reference law before it writes. In-repo validation: `packages/crypto/src/__tests__/delegation-revocation-set-attestation-conformance.test.ts`.
