---
"@motebit/runtime": patch
---

Thread the local motebit's hardware-attestation score into the SkillSelector — runtime engine half.

Adds `setLocalHardwareAttestationClaim(claim | null)` and `getLocalHardwareAttestationScore()` on `MotebitRuntime`. Sibling to `setHardwareAttestationFetcher` (peer claims) and `setHardwareAttestationVerifiers` (peer-claim verifiers): the three together cover the runtime engine's full HA-aware decision surface. Score routes through `scoreAttestation` from `@motebit/semiring` — same canonical 0/0.1/0.5/1.0 mapping the routing path uses, so every consumer (skill selector today, sensitivity-aware delegation tomorrow) sees one number with one definition.

Surfaces with real attestation channels (desktop sidecar verifying Secure Enclave, mobile via App Attest, server-side TPM) override by calling `setLocalHardwareAttestationClaim` with the verified platform claim from their attestor at boot. Same setter, different claim, same score-resolution path. No per-surface fork of the gate logic.

Tests: 6 runtime cases covering the default-zero / software-sentinel / hardware-1.0 / exported-0.5 / clear-back-to-zero / every-platform paths.

Consumer wiring (`buildCliSkillSelectorHook` in `apps/cli`, the published `motebit` runtime's CLI surface) ships in the sibling `local-hardware-attestation-score.md` changeset.
