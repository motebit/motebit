---
"@motebit/protocol": minor
"@motebit/crypto": minor
---

Retention policy phase 2 — protocol algebra + signed `DeletionCertificate` verifier dispatcher + retention manifest wire schema.

Lands the typed surface for `docs/doctrine/retention-policy.md`'s ten phase-1 decisions. New types in `@motebit/protocol`: `RetentionShape` and `DeletionCertificate` discriminated unions (three arms each — `mutable_pruning`, `append_only_horizon`, `consolidation_flush`); `RetentionManifest` for the operator-published, signed declaration; `MAX_RETENTION_DAYS_BY_SENSITIVITY` interop-law ceiling and `REFERENCE_RETENTION_DAYS_BY_SENSITIVITY` reference defaults; `FederationGraphAnchor` and `MerkleInclusionProof` reservations for phase 4's quorum mechanism; per-arm signature blocks (`SubjectSignature`, `OperatorSignature`, `DelegateSignature`, `GuardianSignature`) keyed by the action-class table from decision 5.

New verifier dispatcher in `@motebit/crypto`: `verifyDeletionCertificate(cert, ctx)` routes by `kind`, checks the reason × signer × mode table for admissible signer composition, then verifies every present signature through `verifyBySuite`. Per-arm sign helpers (`signCertAsSubject`, `signCertAsOperator`, `signCertAsDelegate`, `signCertAsGuardian`, `signHorizonCertAsIssuer`, `signHorizonWitness`) construct the canonical signing bytes once per arm. Multi-signature certs sign identical canonical bytes (cert minus all `*_signature` fields) — same shape as identity-v1 §3.8.1 dual-signature succession. Witnesses on `append_only_horizon` certs sign the body minus `witnessed_by`, so co-signing is asynchronous; the issuer's separate signature commits to the assembled witness array, catching forgery or substitution.

The legacy unsigned `DeletionCertificate` in `@motebit/encryption` is marked `@deprecated`; the new union is the replacement. Phase 3 wires memory's prune phase to the signed cert path; phase 4 lands the federation co-witness handshake; phase 5 registers conversations and tool-audit under `consolidation_flush`; phase 6 ships `/.well-known/motebit-retention.json` plus the `check-retention-coverage` drift gate.

Backwards-compatible at the protocol surface — purely additive type and schema growth. The `@motebit/encryption` deprecation is private-package signal only; concrete callers (privacy-layer, runtime consolidation cycle) migrate in phase 3.
