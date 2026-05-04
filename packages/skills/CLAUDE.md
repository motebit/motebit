# @motebit/skills

User-installable procedural-knowledge layer per `spec/skills-v1.md`. BSL-1.1, Layer 1. The runtime surface for agentskills.io-compatible skills with motebit's sovereign extensions: cryptographic provenance, sensitivity-tiered loading, hardware-attestation gating, and a separate provenance gate for trust-promoted unsigned skills.

## Rules

1. **Install is permissive; auto-load is provenance-gated.** Per spec §7.1, install writes bytes to disk regardless of signature status; the selector NEVER auto-loads unsigned skills until the operator promotes them via `motebit skills trust <name>`. Failed signature verification at install-time is fail-closed (different from absent-signature, which is permitted).
2. **Sensitivity describes data, not provenance.** The two are orthogonal axes (spec §4 + §7.1). A skill's tier rules its data exposure; its signature/trust status rules whether it gets injected. Both must pass for auto-load.
3. **YAML parses here, JSON canonicalizes in `@motebit/crypto`.** This package owns frontmatter parsing (uses the `yaml` library — BSL allowed). The wire format that crosses signature boundaries is canonical JSON; `canonicalizeSkillManifestBytes` lives in crypto.
4. **Adapter pattern for storage; one adapter per surface family.** `SkillStorageAdapter` is the abstract surface. Implementations:
   - `InMemorySkillStorageAdapter` — in-package, for tests.
   - `NodeFsSkillStorageAdapter` — in-package, for desktop's Tauri Node sidecar (`~/.motebit/skills/`) and the CLI.
   - `IdbSkillStorageAdapter` — in `@motebit/browser-persistence`, for web (and desktop's dev-mode fallback when the Tauri shell is absent).
   - `ExpoSqliteSkillStorageAdapter` — in `apps/mobile/src/adapters/expo-sqlite.ts`, for mobile.

   Each platform-specific adapter lives next to its surface's existing storage family (`IdbSkillStorageAdapter` joins `IdbEventStore` / `IdbConversationStore`; `ExpoSqliteSkillStorageAdapter` joins `ExpoSqliteEventStore` / `ExpoSqliteMemoryStorage`). The registry binds to the `SkillStorageAdapter` interface, never to a specific backend directly. Drift gate `check-skills-cross-surface` (#73) enforces that every shipping surface wires a `SkillRegistry`.

5. **Privilege boundary is a per-surface contract.** Desktop in production runs install + verification + signature handling in a Tauri-isolated Node sidecar (`src-tauri/sidecar/skills.js`); the Chromium webview never sees envelope bytes or `~/.motebit/skills/` writes (see `feedback_privilege_boundary_probe`). Web, mobile, and desktop's dev-mode fallback (`vite dev` without Tauri) run install + verification in the same renderer context as the panel UI — there is no sidecar analogue in browsers, React Native runtimes, or a bare Vite dev server, so the platform sandbox is the only boundary.

   This is structural, not aspirational: skill verification math (`@motebit/crypto`) is pure and runs identically on every surface; the difference is what an attacker who compromised the renderer could _reach_. Cross-device installs through `/credentials/submit` carry the same Ed25519 envelope, but a surface's trust posture is platform-bound — reasoning that holds on desktop's sidecar may not hold on web.

   `medical`/`financial`/`secret`-tier skills SHOULD route through additional consent gates on weaker-isolation surfaces. **Status:** the reference implementation does not yet enforce this — the consent-gate UI is a future delivery for the web/mobile install flow. The selector still gates auto-load by sensitivity tier (rule 2), so a sensitive-tier skill can be installed on a weak-isolation surface today but cannot be auto-loaded against an external AI provider.

   **Bundle-size guidance:** Skill bundles SHOULD stay below 10 MB for cross-surface portability. Browsers enforce IndexedDB quotas (typically 50–90% of available disk, variable by vendor and free-space conditions) and SQLite blob inserts have practical performance limits; bundles above 10 MB MAY work on desktop FS storage but quota-fail or perform poorly on web/mobile.

6. **No I/O in the selector.** `SkillSelector` is pure — given the candidate list and the turn context, it ranks. Tests are deterministic on inputs alone.
7. **Trust grants are audit events, not cryptographic provenance.** `registry.trust(name)` records that the operator manually attested to an unsigned skill; the resulting trust does not propagate, does not produce a signed artifact, and the skill remains marked `[unverified]` everywhere it surfaces. Display surfaces MUST distinguish `verified` (signature passed) from `trusted_unsigned` (operator promoted).

## Consumers

- `apps/cli` — `motebit skills install/list/enable/disable/remove/trust/untrust/verify` subcommands and `/skills` + `/skill <name>` REPL slashes.
- `apps/desktop` — phase 4.2 wraps the registry inside a Node sidecar (`src-tauri/sidecar/skills.js`); dev-mode falls through to `IdbSkillStorageAdapter` per rule 5.
- `apps/web` — full lifecycle over `IdbSkillStorageAdapter`; install-from-URL fetches signed bundles from `/api/v1/skills/:submitter/:name/:version`.
- `apps/mobile` — `ExpoSqliteSkillStorageAdapter` (storage adapter ships ahead of UI; panel UI deferred to a focused mobile session).
- `services/relay` — phase 4 only, when `motebit/awesome-skills` discovery lands.
