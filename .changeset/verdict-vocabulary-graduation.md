---
"@motebit/protocol": minor
"@motebit/crypto": minor
---

Graduate the structured verification-verdict vocabulary (`IntegrityVerdict`, `IdentityBindingVerdict`, `AuthorityVerdict`, `RevocationStatus`, `RevocationFreshness`, `RevocationVerdict`, `TemporalBasis`, `RepairInstruction`, `VerdictSubject`, `VerificationVerdict`) from `@motebit/crypto` to `@motebit/protocol` — the closed verdict vocabulary's home, and the prerequisite for `EvalAttestation` (which embeds whole verdicts per measurement and whose wire schema can only see protocol).

`@motebit/crypto` re-exports every name type-only, so its public surface is name-identical (the `EvidenceRef` graduation precedent); a compile-time `ArtifactType extends VerdictSubject` assert locks the two packages against drift. `VerdictSubject` is restated in protocol as an explicit closed literal union and widened additively with four new measurement subjects: `succession`, `revocation`, `bond_commitment`, `solvency_proof`. Consumers with exhaustive switches over `VerdictSubject` should add arms for the new members; no existing values changed.
