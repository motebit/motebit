---
"@motebit/protocol": minor
"@motebit/crypto": minor
---

Evidence provenance — verifiable locality extended from signatures to EVIDENCE (agency.computer co-design).

A `VerificationVerdict`'s `evidenceBasis` was a list of `{ kind, ref }` POINTERS — naming what a verdict used, but not independently re-checkable. This additive arc makes that pointer resolve to a re-verifiable provenance, so a verdict's evidence axis becomes locally re-checkable down to the primary record.

`@motebit/protocol` (additive, back-compat by absence): `EvidenceRef` graduates here from `@motebit/crypto`'s free `{kind,ref}` (re-exported from crypto, so the verify-family surface is unchanged) and gains an optional `provenance?: EvidenceProvenance` — `{ digest: { algorithm, value }, projection?, span, locator?, binding? }`. `DigestAlgorithm` (`sha-256` today) rides its own role — a content digest is hashed, not signed, so it does NOT reuse `SuiteId`; a new hash is a registry append, not a wire break.

`@motebit/crypto` (additive): `verifyEvidenceProvenance(bytes, provenance, { resolveProjection? }) → EvidenceProvenanceResult`, pure and I/O-free. The law: the named `span` is an exact substring of `projection(bytes)`, where the bytes content-address to `digest`. Re-verifies PRESENCE, never truth, no oracle. The projection is an INJECTED SEAM (same shape as `verifyStandingDelegation`'s `isRevoked`) so motebit stays domain-blind — projection absent → checks the raw bytes directly (re-verifiable by construction); projection present + injected resolver → apply, then check; projection present + no resolver → fails closed (`projection_unresolved`). `binding` is carried but NOT verified (issuer authority is app-layer); `locator` is advisory.

Hostile corpus locks the law (span-absent, digest-mismatch, projection-unresolved fail-closed, raw-byte-happy, projection-applied, projection-divergence, binding-carried-not-verified). Deferred to agency's side (consumer-forces-shape): a published byte-deterministic projection recipe + its committed reference fixture (the real cross-implementation projection-divergence case), and the wire spec. Doctrine: `docs/doctrine/evidence-provenance.md`.
