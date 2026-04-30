---
"motebit": patch
---

Thread the local motebit's hardware-attestation score into the SkillSelector — published-runtime consumer half. Closes the documented-feature-doesn't-work gap where the bundled reference runtime hardcoded `hardwareAttestationScore: 0` regardless of what the local platform actually attested.

**The gap.** Skills can declare `hardware_attestation: { required: true, minimum_score: X }` in their manifest per `spec/skills-v1.md` §4. The selector enforces: if `required && minimum_score > localScore` → skip. Until this ship, every surface hardcoded `localScore: 0`, so any skill demanding any positive score silently failed to load — even on hardware-attested devices. The four-ship HA infrastructure that landed across April was scoring OTHER agents (peers); the LOCAL motebit's own attestation never made it to the gate.

**What ships.** `buildCliSkillSelectorHook` (in `apps/cli`, the published `motebit` runtime's CLI surface) now takes a `getHardwareAttestationScore: () => number` callback and reads it per-turn. The runtime-factory wires the closure to `runtime.getLocalHardwareAttestationScore()` and after construction calls `runtime.setLocalHardwareAttestationClaim({ platform: "software" })` — the truthful sentinel for a Node process with no hardware-attestation channel. Score resolves to 0.1 — distinguishes "agent honestly declared no-hardware" from "agent made no claim at all", per `docs/doctrine/hardware-attestation.md`. Skills declaring `minimum_score: 0.1` (a software-OK gate) now load on `motebit`; skills declaring `0.5+` still skip — correct behavior for a Node-process binary with no hardware-attestation channel.

`apps/cli` tests pass through unchanged (the new score is read from the runtime each turn). Runtime engine API ships in the sibling `@motebit/runtime` changeset (`local-hardware-attestation-score-ignored.md`).
