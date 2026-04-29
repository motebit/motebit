---
"@motebit/protocol": minor
"@motebit/crypto": minor
"motebit": minor
---

Add agentskills.io-compatible procedural-knowledge runtime per `spec/skills-v1.md`.

Skills are user-installable markdown files containing procedural knowledge — when to use a tool, in what order, with what verifications. Open standard from Anthropic adopted across Claude Code, Codex, Cursor, GitHub Copilot. This release layers motebit-namespaced extensions on top of the standard frontmatter, ignored by non-motebit runtimes.

**`@motebit/protocol`** — adds wire types for the new skill artifacts:

```text
SkillSensitivity            "none" | "personal" | "medical" | "financial" | "secret"
SkillPlatform               "macos" | "linux" | "windows" | "ios" | "android"
SkillSignature              { suite, public_key, value }
SkillHardwareAttestationGate { required?, minimum_score? }
SkillManifest               full parsed frontmatter
SkillEnvelope               content-addressed signed wrapper
SKILL_SENSITIVITY_TIERS, SKILL_AUTO_LOADABLE_TIERS, SKILL_PLATFORMS  frozen const arrays
```

**`@motebit/crypto`** — adds offline-verifiable sign/verify pipeline using the `motebit-jcs-ed25519-b64-v1` suite (sibling to execution receipts, NOT W3C `eddsa-jcs-2022`):

```text
canonicalizeSkillManifestBytes(manifest, body)  -> Uint8Array
canonicalizeSkillEnvelopeBytes(envelope)        -> Uint8Array
signSkillManifest / signSkillEnvelope
verifySkillManifest / verifySkillEnvelope (+ Detailed variants)
decodeSkillSignaturePublicKey(sig)              -> Uint8Array
SKILL_SIGNATURE_SUITE                           const
```

**`motebit`** (CLI) — adds the user-facing surface:

```text
motebit skills install <directory>
motebit skills list
motebit skills enable | disable <name>
motebit skills trust | untrust <name>
motebit skills verify <name>
motebit skills remove <name>
/skills                       (REPL slash — list with provenance badges)
/skill <name>                 (REPL slash — show full details)
```

Install is permissive (filesystem record, sibling to `mcp_trusted_servers` add); auto-load is provenance-gated (the act layer). The selector filters by enabled+trusted+platform+sensitivity+hardware-attestation before BM25 ranking on description. Manual trust grants emit signed audit events to `~/.motebit/skills/audit.log` without manufacturing cryptographic provenance.

Two new drift gates land alongside: `check-skill-corpus` (every committed reference skill verifies offline against its committed signature) and `check-skill-cli-coverage` (every public `SkillRegistry` method has a `motebit skills <verb>` dispatch arm).

Phase 1 ships frontmatter + envelope + signature scheme + sensitivity tiers + trust gate + the eight subcommands + REPL slashes + drift gates + one signed dogfood reference (`skills/git-commit-motebit-style/`). Phase 2: `SkillSelector` wired into the runtime context-injection path, plus `scripts/` quarantine + per-script approval. Phase 3: signed `SkillLoadReceipt` in `execution-ledger-v1`. Phase 4: sibling-surface skill browsers + curated registry.
