---
"@motebit/crypto": minor
"@motebit/verifier": minor
"@motebit/verify": minor
---

`motebit-verify` now verifies skills end-to-end. Any agentskills.io-shaped skill — directory or single envelope JSON — runs through the same canonical verifier with no motebit setup required.

**Why this exists.** The CLI install path (`packages/skills/src/registry.ts`) has re-verified envelope signature + body/file hashes since skills v1 shipped, but a non-motebit user who downloaded a skill from anywhere had no one-command way to answer "is this signed AND do the bytes match what the publisher signed?" `motebit-verify` already covered identity / receipt / credential / presentation; this ship extends it to skills, the artifact type with the largest external ecosystem (agentskills.io / VoltAgent's awesome-skills / skillsmp.com / Cursor users).

**Three-package shape, all Apache-2.0:**

`@motebit/crypto` — adds `SkillVerifyResult` + `SkillFileVerifyResult` to the `VerifyResult` union, extends `ArtifactType` with `"skill"`, extends `detectArtifactType` to recognize the canonical `SkillEnvelope` shape (`spec_version` + `skill` + `manifest` + `body_hash` + `signature`), wires the unified `verify()` dispatcher to call the existing envelope-signature primitive. Bare-envelope verify returns `valid: false` with body/files steps unattempted — full verification needs on-disk bytes, and this layer is honest about what it checked.

`@motebit/verifier` — adds `verifySkillDirectory(path)` that reads `<dir>/skill-envelope.json`, `<dir>/SKILL.md`, and every entry in `envelope.files[]`, recomputes `sha256` against `envelope.body_hash` and per-file hashes, calls `verify()` for sig, composes the unified `SkillVerifyResult` with all three steps populated. `verifyFile(path)` now path-shape-dispatches: directory → skill walker; file → existing detector. `formatHuman` learns a `"skill"` arm.

`@motebit/verify` — adds `"skill"` to `EXPECT_VALUES` so `motebit-verify <skill-dir> --expect skill` honors the type pin; updates help text to document directory + envelope-JSON inputs.

**Result discipline.** `valid: true` iff envelope sig verifies AND body hash matches AND every declared file hash matches. Step-level details on the `steps` field distinguish the three failure modes:

- `steps.envelope: { valid, reason }` — `wrong_suite`, `bad_public_key`, `bad_signature_value`, `ed25519_mismatch`, or `ok`.
- `steps.body_hash: { valid, expected, actual } | null` — `null` when only sig was checked.
- `steps.files: SkillFileVerifyResult[]` — per-file `{ path, valid, expected, actual, reason: "ok" | "hash_mismatch" | "missing" }`.

`--json` already wired surfaces all three axes in structured form for CI pipelines and third-party verifiers.

**Faithful to the lineage.** `@motebit/crypto` (primitives, Apache-2.0 floor) → `@motebit/verifier` (file-I/O library, Apache-2.0) → `@motebit/verify` (binary aggregator, Apache-2.0). No new cryptographic logic in the binary; no new BSL-line concerns. The aggregator stays thin so an Apache-2.0-only audit pipeline composes the three packages without license friction.

Tests: 6 crypto-layer cases (skill detector + dispatch + tamper detection), 9 verifier-layer cases (directory walker happy path + 5 tamper modes + missing file + verifyFile dispatch + formatHuman). All passing.
