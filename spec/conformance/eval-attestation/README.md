# EvalAttestation conformance corpus

Versioned, pinnable vectors for `verifyEvalAttestation` — the envelope law of the signed third-party-measurement artifact (`motebit/eval-attestation@1.0`; [`docs/doctrine/evals-as-attestations.md`](../../../docs/doctrine/evals-as-attestations.md)). A second implementation runs **its** verifier over each `input.attestation` and asserts the same structured `expected`. "Done" is both sides emitting identical results with neither author in the room.

## The law

`verifyEvalAttestation` establishes exactly one sentence — _"this issuer said these measurements about this subject, as of this basis"_ — fail-closed on everything it owns:

1. `suite` must be the pinned `motebit-jcs-ed25519-b64-v1` (`unsupported_suite`).
2. `eval_kind` must be a member of the closed EvalKind registry (`unknown_eval_kind`) — a consumer that cannot interpret the measurement family must not act on its verdicts.
3. `results` must be non-empty (`empty_results`).
4. `issuer.public_key` must be 32-byte lowercase-hex Ed25519 (`malformed_public_key`).
5. `signature` must be base64url of 64 bytes (`malformed_signature`) and verify over `canonicalJson({...attestation minus signature})` against the embedded issuer key (`signature_invalid`).

## Deliberately NOT checked

- **Truth of the measurements** — the embedded per-axis `VerificationVerdict`s are the issuer's claims; skeptical consumers re-run the underlying laws over the cited evidence (`verifyEvidenceProvenance` per ref, receipt verdicts over re-fetched receipts).
- **Issuer authority/reputation** — who counts as a trusted auditor is app-layer.
- **Issuer key → motebit_id binding** — the consumer's `verifySovereignBinding`-shaped responsibility.
- **`expires_at` / `as_of` freshness** — carried, consumer-policied (the `expired-still-verifies` vector pins this).
- **Subject ≠ issuer** — self-issued evals are the doctrine's floor (the `self-issued-valid` vector pins this); a trust grade, never a malformed artifact.

## Regenerating

All artifacts are minted from fixed test keys; Ed25519 is deterministic, so the corpus is byte-stable:

```
npx tsx scripts/gen-eval-attestation-corpus.ts
```

The generator asserts each case's hand-coded expectation against the producer's own verifier before writing — a verifier regression cannot be silently frozen into the corpus.
