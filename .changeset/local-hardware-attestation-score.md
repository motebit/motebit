---
"@motebit/runtime": patch
"motebit": patch
---

Thread the local motebit's hardware-attestation score into the SkillSelector. Closes the documented-feature-doesn't-work gap where the CLI hardcoded `hardwareAttestationScore: 0` regardless of what the local platform actually attested.

**The gap.** Skills can declare `hardware_attestation: { required: true, minimum_score: X }` in their manifest per `spec/skills-v1.md` §4. The selector enforces: if `required && minimum_score > localScore` → skip. Until this ship, every surface hardcoded `localScore: 0`, so any skill demanding any positive score silently failed to load — even on hardware-attested devices. The four-ship HA infrastructure that landed across April was scoring OTHER agents (peers); the LOCAL motebit's own attestation never made it to the gate.

**What ships:**

`@motebit/runtime` — adds `setLocalHardwareAttestationClaim(claim | null)` and `getLocalHardwareAttestationScore()` on `MotebitRuntime`. Sibling to `setHardwareAttestationFetcher` (peer claims) and `setHardwareAttestationVerifiers` (peer-claim verifiers): the three together cover the runtime's full HA-aware decision surface. Score routes through `scoreAttestation` from `@motebit/semiring` — same canonical 0/0.1/0.5/1.0 mapping the routing path uses, so every consumer (skill selector today, sensitivity-aware delegation tomorrow) sees one number with one definition.

`apps/cli` — `buildCliSkillSelectorHook` now takes a `getHardwareAttestationScore: () => number` callback and reads it per-turn. The runtime-factory wires the closure to `runtime.getLocalHardwareAttestationScore()` and after construction calls `runtime.setLocalHardwareAttestationClaim({ platform: "software" })` — the truthful sentinel for a Node process with no hardware-attestation channel. Score resolves to 0.1 — distinguishes "agent honestly declared no-hardware" from "agent made no claim at all", per `docs/doctrine/hardware-attestation.md`. Skills declaring `minimum_score: 0.1` (a software-OK gate) now load on the CLI; skills declaring `0.5+` still skip — correct behavior for a CLI.

**The architectural shape.** Surfaces with real attestation channels (desktop sidecar verifying Secure Enclave, mobile via App Attest, server-side TPM) override by calling `setLocalHardwareAttestationClaim` with the verified platform claim from their attestor at boot. Same setter, different claim, same score-resolution path. No per-surface fork of the gate logic.

Tests: 6 runtime cases covering the default-zero / software-sentinel / hardware-1.0 / exported-0.5 / clear-back-to-zero / every-platform paths. CLI tests pass through unchanged (the new score is read from the runtime each turn).
