---
"@motebit/verifier": minor
---

Expose `verifyEvidenceProvenance` (and its `EvidenceProvenance` / `EvidenceProvenanceResult` / `DigestRef` / `DigestAlgorithm` types) through `@motebit/verifier`.

The verdict surface already flows through the aggregator — a `VerificationVerdict`'s `evidenceBasis: EvidenceRef[]` carries optional re-verifiable `provenance` (the evidence-provenance arc: verifiable-locality extended from signatures to _evidence_). But the **law that re-checks** that provenance lived only in `@motebit/crypto`, so a consumer pinning `@motebit/verifier` could read the provenance pointer yet could not re-verify it without reaching past the aggregator into a second dependency — breaking the agency-proof-integration contract (consume the verifier, never fork it).

This closes that gap: `verifyEvidenceProvenance` is now re-exported from the same surface the verdict family is. The law is unchanged — the named `span` is an exact substring of `projection(bytes)` where the bytes content-address to `digest` (re-verifiable presence, never truth), with the projection recipe an injected, app-owned seam (absent ⇒ raw bytes; present-with-no-resolver ⇒ fail-closed `projection_unresolved`). A new test proves the law is reachable and behaves through the verifier surface without adding `@motebit/crypto` as a second dependency.

Still deferred-with-trigger (agency's side, consumer-forces-shape): a published byte-deterministic projection recipe + its cross-implementation conformance fixture, and the wire spec — both gated on agency's real recipe. Doctrine: `docs/doctrine/evidence-provenance.md`.
