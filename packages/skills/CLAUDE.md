# @motebit/skills

User-installable procedural-knowledge layer per `spec/skills-v1.md`. BSL-1.1, Layer 1. The runtime surface for agentskills.io-compatible skills with motebit's sovereign extensions: cryptographic provenance, sensitivity-tiered loading, hardware-attestation gating, and a separate provenance gate for trust-promoted unsigned skills.

## Rules

1. **Install is permissive; auto-load is provenance-gated.** Per spec §7.1, install writes bytes to disk regardless of signature status; the selector NEVER auto-loads unsigned skills until the operator promotes them via `motebit skills trust <name>`. Failed signature verification at install-time is fail-closed (different from absent-signature, which is permitted).
2. **Sensitivity describes data, not provenance.** The two are orthogonal axes (spec §4 + §7.1). A skill's tier rules its data exposure; its signature/trust status rules whether it gets injected. Both must pass for auto-load.
3. **YAML parses here, JSON canonicalizes in `@motebit/crypto`.** This package owns frontmatter parsing (uses the `yaml` library — BSL allowed). The wire format that crosses signature boundaries is canonical JSON; `canonicalizeSkillManifestBytes` lives in crypto.
4. **Adapter pattern for storage.** `SkillStorageAdapter` is the abstract surface; `InMemorySkillStorageAdapter` for tests, real-fs adapter for runtime (slips into the apps/cli runtime-factory layer in a sibling turn). The registry binds to the interface, never to the filesystem directly.
5. **No I/O in the selector.** `SkillSelector` is pure — given the candidate list and the turn context, it ranks. Tests are deterministic on inputs alone.
6. **Trust grants are audit events, not cryptographic provenance.** `registry.trust(name)` records that the operator manually attested to an unsigned skill; the resulting trust does not propagate, does not produce a signed artifact, and the skill remains marked `[unverified]` everywhere it surfaces. Display surfaces MUST distinguish `verified` (signature passed) from `trusted_unsigned` (operator promoted).

## Consumers

- `apps/cli` — `motebit skills install/list/enable/disable/remove/trust/untrust/verify` subcommands and `/skills` + `/skill <name>` REPL slashes.
- `services/relay` — phase 4 only, when `motebit/awesome-skills` discovery lands.
