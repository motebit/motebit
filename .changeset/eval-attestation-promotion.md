---
"@motebit/protocol": minor
"@motebit/crypto": minor
"@motebit/verifier": minor
"@motebit/sdk": minor
---

Promote `EvalAttestation` — the signed third-party-measurement artifact (subject ≠ signer; `docs/doctrine/evals-as-attestations.md` trigger #1 fired: the Auditor archetype is consumer #1).

- `@motebit/protocol`: `EvalAttestation` / `EvalResult` wire types; `EvalKind` closed registry (eleventh registered registry — `ALL_EVAL_KINDS`, `isEvalKind`; single member `verification_audit`). Each result embeds a whole per-axis `VerificationVerdict` — no flattened booleans.
- `@motebit/crypto`: `signEvalAttestation` / `verifyEvalAttestation` (JCS + Ed25519 + base64url under the pinned `EVAL_ATTESTATION_SUITE`). The verify law establishes "this issuer said this about this subject" and deliberately never measurement truth, issuer authority, key→id binding, or freshness; subject == issuer is valid (self-issued floor). Fail-closed structured reasons incl. closed-registry `unknown_eval_kind` intake via the crypto-side `EVAL_KINDS_MIRROR` (zero-runtime-deps discipline; four-way locked by `check-eval-kind-canonical`).
- `@motebit/wire-schemas`: `EvalAttestationSchema` (+ `EvalResultSchema`, `VerificationVerdictSchema`, `RepairInstructionSchema`, `RevocationVerdictSchema`) with committed JSON Schema `spec/schemas/eval-attestation-v1.json`; spec `spec/eval-attestation-v1.md`; conformance corpus `spec/conformance/eval-attestation/`.
- `@motebit/verifier`: re-exports the EvalAttestation family and widens the aggregator with the public-verification-surface laws an auditor composes (`verifySovereignBinding`, `verifyKeySuccession`, `verifySuccessionChain`, `verifyBondCommitment`, `verifyMerkleInclusion`) — services consume only the aggregator, never `@motebit/crypto` directly.
- `@motebit/sdk`: the new protocol types ride the existing star re-export.
