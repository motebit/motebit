# motebit CLI Changelog

## 1.2.0

### Minor Changes

- 9b4a296: Add agentskills.io-compatible procedural-knowledge runtime per `spec/skills-v1.md`.

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

### Patch Changes

- 34c73ca: Replace inline `require("node:os")` with a top-of-file `import * as os from "node:os"` in `runtime-factory.ts`. Pre-push lint surfaced four errors (`no-require-imports` + `no-unsafe-*`) on the CommonJS-style require — ESM imports keep the type info and pass the published-package-source eslint preset.
- 57c0e45: Skills v1 phase 2: wire `SkillSelector` into the runtime context-injection path so installed skills actually inject per-turn (spec/skills-v1.md §7).

  **`@motebit/sdk`** — adds the developer-contract surface for the runtime ↔ skill-runtime adapter boundary:

  ```text
  SkillInjection         { name, version, body, provenance }
  SkillSelectorHook      { selectForTurn(turn) -> Promise<SkillInjection[]> }
  ContextPack            new optional `selectedSkills` field
  ```

  The `SkillSelectorHook` is the abstraction the runtime binds to. Surfaces (CLI / desktop / mobile) provide concrete implementations behind this interface; the runtime stays unaware of the BSL `@motebit/skills` package per the adapter-pattern doctrine.

  **`motebit`** (CLI) — wires `NodeFsSkillStorageAdapter + SkillRegistry + SkillSelector` behind the `SkillSelectorHook` interface. Each turn the runtime calls `selectForTurn(text)`; the hook reads `~/.motebit/skills/` fresh (so `install`/`trust`/`remove` propagate without restart), runs the BM25-ranked selector with `sessionSensitivity: "none"` and `hardwareAttestationScore: 0` defaults appropriate to the CLI today, maps the result to `SkillInjection[]`, and returns top-K. `process.platform` maps to `SkillPlatform` for the OS gate.

  Selected skill bodies inject into the system prompt as labeled blocks per spec §7.3:

  ```text
  [skill: git-commit-motebit-style@1.0.0 — verified]
  <body>
  ```

  Verified skills get `verified` tag; operator-attested unsigned skills get `operator-trusted (unsigned)` tag — the agent sees provenance posture and can factor it into reasoning.

  Fail-closed: a hook that throws is logged via `runtime._logger.warn("skill_selector_failed", ...)` and treated as an empty result. Selector failures never block the AI loop.

  Phase 2 remaining work: `scripts/` quarantine + per-script approval (deferred until a skill bearing scripts/ ships; will use the existing tool-approval gate per the saved project memory). Phase 3: signed `SkillLoadReceipt` in `execution-ledger-v1`.

- 3dd5c54: Update phase 2 ai-core prompt-test fixtures to include the new `score` and `signature` fields on `SkillInjection` (added in phase 3). No behavior change — the prompt builder still ignores both fields, the renderings asserted by the tests are unchanged.
- 2a48142: Skills v1 phase 3: per-skill audit entries in the execution ledger (spec/skills-v1.md §7.4).

  Every skill the runtime's `SkillSelector` pulls into context now produces one `EventType.SkillLoaded` event-log entry, immediately after the selector returns and before the AI loop receives the system prompt. The audit trail lets a user prove later: _"the obsidian skill ran on date X with this exact signature value at session sensitivity Y."_

  **`@motebit/protocol`** — adds the wire-format type and event:

  ```text
  SkillLoadPayload  { skill_id, skill_name, skill_version, skill_signature,
                      provenance, score, run_id?, session_sensitivity }
  EventType.SkillLoaded
  ```

  **`@motebit/sdk`** — extends `SkillInjection` with two audit-only fields the runtime threads into the ledger entry:

  ```text
  SkillInjection.score      BM25 relevance — surfaces selection rationale
  SkillInjection.signature  Envelope signature.value — content-addressed pointer
                            to the exact bytes loaded; empty for trusted_unsigned
  ```

  The AI loop's prompt builder ignores both fields (rendering stays unchanged). They ride only into the `SkillLoaded` event payload.

  **`motebit`** (CLI) — runtime-factory's hook now passes `score` + `signature` through from the BSL `SkillSelector` result.

  Best-effort emission: a failed `eventStore.append` is logged via `runtime._logger.warn("skill_load_event_append_failed", ...)` and the AI loop proceeds. Audit absence (skill loaded without matching event) is preferable to a turn blocked on a transient storage error.

  Skill_signature audit utility: a stale ledger entry whose signature does not resolve in the current registry is itself a useful signal — the skill was re-signed (legitimate update) or removed (less common). Both provable from the audit trail without retaining the original bytes.

  Wire-schema artifact: `spec/schemas/skill-load-payload-v1.json` ships under Apache-2.0 alongside the existing skills schemas.

  4 new runtime tests cover: emit-with-payload, empty-selector, selector-throw (loop continues), no-hook-wired. 683/683 runtime, all 54 drift gates green.

- a1077e9: Drop the redundant default `name` field in the `makeSummary` test helper for the new SkillsController test suite. The helper signature already requires `overrides.name`, so the inline default `name: "placeholder"` was unreachable and tripped TS2783 ("'name' is specified more than once, so this usage will be overwritten") under tsc — runtime semantics unchanged, tsc-strict was the only rejector.
- 4d6dd80: Skills v1 phase 4.1: surface-agnostic `SkillsController` in `@motebit/panels`. State + actions for the cross-surface skills panel (browse / install / enable-disable / trust-untrust / verify / remove / search / detail-view) — the foundation for desktop / mobile / web renderers in subsequent slices (4.2 / 4.3 / 4.4).

  The controller follows the established `@motebit/panels` pattern: one adapter the host implements, one state shape, one controller exposing `subscribe + actions + getState + dispose`. Zero internal deps preserved — wire-format types (`SkillSensitivity`, `SkillPlatform`, `SkillProvenanceStatus`) are inlined to avoid layer promotion against `@motebit/protocol`. The host wires its `SkillRegistry` instance into the adapter; the controller is registry-unaware.

  ```text
  SkillsPanelAdapter      listSkills | readSkillDetail | installFromSource |
                          enableSkill | disableSkill | trustSkill | untrustSkill |
                          removeSkill | verifySkill
  SkillsController        refresh | install | enable-disable | trust-untrust |
                          removeSkill | verifySkill | selectSkill | setSearch |
                          filteredSkills | dispose
  SkillSummary            list-row payload (frontmatter + state, no body bytes)
  SkillDetail             detail-view payload (summary + body + author/category/tags)
  ```

  Optimistic state mutations:
  - `enable / disable` flip `enabled` locally without a full refresh (cheap, immediate UX feedback).
  - `trust / untrust / remove` trigger a full refresh — provenance status recompute lives on the registry side, not the panel.
  - `verifySkill` mutates only the affected row's `provenance_status` (no full refresh).
  - Removing the currently-selected skill clears `selectedSkill` automatically.

  Errors surface in `state.error` and leave previous-good state intact; the renderer decides toast vs system-message per surface doctrine. 21 new tests cover refresh / install / enable-disable / trust-untrust / remove / verify / selectSkill / setSearch / dispose / error paths. 132/132 panels tests green.

  Phase 4 remaining: 4.2 (desktop renderer), 4.3 (mobile renderer + ExpoFsSkillStorageAdapter), 4.4 (web renderer + IndexedDBSkillStorageAdapter or relay-mediated browse), 4.5 (`motebit/awesome-skills` curated registry).

- 2ae06ab: Add `motebit skills publish <directory>` — sign a skill with the user's CLI identity key, write back the signed `SKILL.md` + `skill-envelope.json` byte-stable, and POST the bundle to the relay-hosted registry's `/api/v1/skills/submit` endpoint. Closes the author-side loop opened by phase 4.5a (`spec/skills-registry-v1.md`).

  The publish flow is fail-closed in two places before going to the network:
  1. **Local re-verify after sign.** A tampered private key or a dependency drift in the signing chain surfaces as `Local re-verify failed after signing` rather than at the relay's 400.
  2. **Idempotent re-publish.** Re-running `publish` on the same directory with the same identity key produces byte-identical envelope + body, so the relay returns 200 (idempotent) instead of 409 `version_immutable`. Authors can re-run the command without bumping SemVer.

  Usage:

  ```text
  motebit skills publish skills/git-commit-motebit-style
  ```

  Output names the resolved address so the author can immediately install elsewhere:

  ```text
    published
    git-commit-motebit-style v1.0.0
    address:    did:key:z6Mk…/git-commit-motebit-style@1.0.0
    submitter:  did:key:z6Mk…
    content:    7f313f44…

    Install elsewhere with: motebit skills install did:key:z6Mk…/git-commit-motebit-style@1.0.0
  ```

  Also seeds a second motebit-canonical skill, `motebit-spec-writer`, at `skills/motebit-spec-writer/`. Procedural knowledge for drafting `motebit/<name>@<version>` specifications: header conventions, foundation-law markers, wire-format triple-sync (protocol type → zod schema → JSON Schema), drift-gate discipline. Build via `pnpm --filter @motebit/skills build-spec-writer-skill`.

  The reference corpus now ships two signed skills (`git-commit-motebit-style`, `motebit-spec-writer`) — operators can `motebit skills publish skills/<name>` against any deployed relay to seed the curated index.

  Drift gate `check-skill-cli-coverage` learns about network-side verbs: `publish` is intentionally not backed by a `SkillRegistry` method (it's a relay-client operation, not a local-disk one). Future network-side verbs add a one-line waiver in the gate's `INTENTIONAL_NON_REGISTRY_VERBS` set.

- 8bab218: Skills v1 phase 4.5a — CLI install via the relay-hosted registry.

  `motebit skills install` now accepts a relay address shape:

  ```text
  motebit skills install did:key:z6Mk…/example-skill@1.0.0
  ```

  The CLI fetches the bundle from the relay's `GET /api/v1/skills/:submitter/:name/:version` endpoint, re-verifies the envelope signature locally, asserts the relay-returned submitter matches the requested DID, then installs via the existing in-memory source path. Existing directory installs (`motebit skills install /path/to/skill`) are unchanged.

  The local re-verify is the trust boundary — the relay is a convenience surface, never a trust root. A tampering relay returns bytes that fail verification on the consumer.

  Spec: `spec/skills-registry-v1.md`.

- 556468d: Replace inner `switch (provenance_status)` with an if/else chain in `slash-commands.ts`. The provenance-status branches were being misclassified as fake slash commands by `command-registry.test.ts`, whose regex scans every `^\s+case "X":` pattern in the handler source. No behavior change — identical badges returned for the same statuses.

## 1.1.1

### Patch Changes

- 1502cfc: Internal: workspace-private `@motebit/api` package and `services/api/` directory renamed to `@motebit/relay` and `services/relay/` for naming coherence with the rest of the codebase (CLI command `motebit relay up`, doctrine docs, README, and the published container at `ghcr.io/motebit/relay`).

  Per `docs/doctrine/release-versioning.md`: "Patch = repaired promise. Same public contract, better implementation." The motebit CLI's commands, flags, exit codes, `~/.motebit/` layout, MCP server tool list, and federation handshake protocol are all unchanged. Only bundle-internal source organization moved — the inlined workspace package the tsup `noExternal: [/.*/]` config bundles into `motebit/dist/index.js` is now sourced from `services/relay/` instead of `services/api/`.

  Operators upgrading from `motebit@1.1.0` see no behavioural difference. No env vars, no flags, no commands, no DB layout, no protocol surface changed.

  The companion container release ships as `ghcr.io/motebit/relay:1.0.1` (cut as a `relay-v1.0.1` git tag in the same change). The relay's contract — HTTP endpoints, env vars, volume layout, federation handshake, wire formats — is byte-identical to `relay-v1.0.0` (which published only to the now-deprecated `ghcr.io/motebit/api` namespace). Only the registry pull URL and the OCI `image.title` label differ. Per the same release-versioning doctrine, "the dev contract moved is at most additive" — the registry path is not a contract break, and a major bump here would be a "phantom major" the doctrine explicitly warns against.

  Explicitly unchanged for separate operational migrations: Fly.io app names (`motebit-sync`, `motebit-sync-stg`, `motebit-sync-stg-b` — DNS+federation-peer cutover required), Prometheus metric prefix (`motebit_api_*` — would orphan historical time-series), all CHANGELOG entries (historical record), `docs/drift-defenses.md` (incident history).

## 1.1.0

### Minor Changes

- 454f329: Scaffolded agents are now self-contained, and `--direct` mode produces a minimal tool surface.

  A cold-walk of the published `create-motebit@1.1.2` against the README's "What you see:" block surfaced two architectural drifts that this changeset closes.

  **`create-motebit` — agent identity is local, not global.** The `--agent` scaffold path now writes the encrypted private key to `<agent>/.motebit/config.json` instead of the operator's global `~/.motebit/`. The scaffolded entrypoint pins `MOTEBIT_CONFIG_DIR=<agent>/.motebit` on the spawned `motebit serve` so the runtime reads THIS agent's identity, not whatever sits at the operator's path. The agent directory becomes portable: copy it to another machine, set `MOTEBIT_PASSPHRASE`, run. The identity-clobber gate moves from "global ~/.motebit has an identity" to "this agent dir already has its own .motebit/config.json" — same safety property, scoped correctly. `.gitignore` template now excludes `.motebit/` since it carries the encrypted key.

  **`motebit` — `CONFIG_DIR` honours `MOTEBIT_CONFIG_DIR`.** The runtime previously hardcoded `~/.motebit/`; it now reads `process.env["MOTEBIT_CONFIG_DIR"]` first and falls back to `~/.motebit/` when unset. Operator usage (`motebit relay up`, `motebit run`, etc.) doesn't set the env var, so behavior is unchanged for them. The scaffolded-agent flow above sets it explicitly.

  **`motebit` — `--direct` skips runtime-injected builtin tools.** `buildToolRegistry` previously registered ~12 builtins (memory, fs, web search, time, ...) regardless of mode. With `--direct`, the user has declared "no AI loop, run only my tools" — injecting builtins on top of that breaks the principle of least surprise and means a freshly scaffolded agent advertises a 12-tool MCP surface where the README claims 2. The factory now returns an empty registry when `config.direct` is true; the daemon's `--tools <path>` loader is the only thing that adds entries. Operator console doesn't pass `--direct`, so it keeps all builtins.

  **`create-motebit` — onboarding chain actually loads `.env` at runtime.** The scaffolded `package.json`'s `dev`/`start`/`self-test` scripts now use `node --env-file=.env` (Node ≥ 20.6 native, no dependency added). Without this flag, the `.env` file the user creates from `.env.example` was wallpaper — Node never read it, so `MOTEBIT_PASSPHRASE` set there never reached the runtime, decrypt failed, `motebit_task` stayed disabled. The `.env.example` template's `MOTEBIT_PASSPHRASE` field now leads with a `REQUIRED` comment naming the failure mode. Scaffold success message and the per-agent README's "First run" snippet both call out the passphrase step explicitly. Engines floor moved to `>=20.6.0` so npm warns at install time when Node is too old.

  **Existing 1.1.2-scaffolded agents continue to work** — their identity sits in `~/.motebit` and the runtime's fallback resolves there when the env var is unset. New scaffolds use the local pattern. The two coexist; no migration required for in-the-wild agents. (1.1.2-scaffolded agents that lacked the `--env-file=.env` flag will continue to expect `MOTEBIT_PASSPHRASE` in the shell rather than `.env` — same as before; this fix improves only newly-scaffolded agents.)

  **Migration note (motebit @ minor bump).** `--direct` mode previously exposed a runtime tool registry of ~12 builtins (memory, fs, web search, time, ...). That surface was an accident of `buildToolRegistry` running unconditionally — never documented in the README, never appeared in `--help`, never specified. `--direct` now returns an empty registry; the only tools an agent in direct mode sees are those it loaded explicitly via `--tools <path>`. If you were unwittingly relying on the old 12-tool surface, drop `--direct` to run with the full AI-loop runtime (which keeps all builtins, including write/exec tools when `--operator` is also set).

  **Verified end-to-end** with a _user-following-README_ cold-walk (no shell env exports beyond `MOTEBIT_PASSPHRASE` at scaffold creation; `cp .env.example .env`, edit passphrase value in `.env`, `npm run dev`): scaffold succeeds, `.motebit/` lands in the agent dir, global `~/.motebit/config.json` mtime untouched, `npm run dev` produces output that matches the README's "What you see:" block exactly:

  ```
  Identity: 019d...
  Tool loaded: fetch_url
  Tool loaded: echo
  Agent task handler enabled (direct mode — no LLM)
  Tools loaded: fetch_url, echo
  MCP server running on http://localhost:3100 (StreamableHTTP). 2 tools exposed.
  Policy: ambient mode.
  ```

  **`motebit` — self-sovereign agent registration finally works.** The relay's `/api/v1/agents/*` middleware always accepted two auth shapes: an operator master token, OR a self-signed device token verified against the agent's own registered public key (`audience: "admin:query"`). The `.env.example` claim "Anonymous agents can register and serve for free" was always architecturally correct — the implementation gap was that `daemon.ts` only sent `Bearer ${masterToken}` when a master token existed, never minting the self-signed alternative even though `createSignedToken` was already imported and used elsewhere in the same file (self-test, WebSocket auth). The fix is two coordinated steps the relay already supports: call `/api/v1/agents/bootstrap` first (unauthenticated, idempotent — registers the agent's `(motebit_id, device_id, public_key)` so the relay knows which key to verify against), then mint a 24h `admin:query` signed token and use it as Bearer for `/register` and the heartbeat setInterval. Operator master token, when present, still wins. Result: `Registered with relay: https://relay.motebit.com` lands on first run for every cold-walked scaffolded agent, no `MOTEBIT_API_TOKEN` required. The 24h expiry is wider than the per-call 5-min default to cover the heartbeat window; agents running longer than 24h need restart (or a follow-up to mint per-heartbeat tokens).

  **Three of three architectural claims now hold under the user-following-README cold-walk** — tools count, decrypt-success, relay-registration. The path from `npm create motebit my-agent --agent` → `cd my-agent && npm install` → `cp .env.example .env` → set `MOTEBIT_PASSPHRASE` → `npm run dev` produces output that matches the README's "What you see:" block exactly, with no relay 401, no decrypt-failed warning, no surplus runtime tools. Self-containment, self-sovereign auth, and minimal tool surface are all real properties of the v1 scaffold instead of partially-true ones.

## 1.0.1

### Patch Changes

- bda4de1: First-run UX repair: canonical signing-key resolver + actionable doctor probes.

  ## Why

  A live walkthrough of the golden path (`fund → delegate → settle`) on a real install surfaced that the CLI fails silently on every common first-run gap:
  - `~/.motebit/config.json` with no `cli_encrypted_key` (clobber, partial setup, fresh install) → `motebit balance` errors with "no relay URL", `motebit wallet` errors with "No private key found", `motebit fund` never gets that far. None of these messages tell the user what to do.
  - Identity not registered with the relay (`/agent/{id}/capabilities` → 404) → discovery, peer-trust pulls, and capability advertisement silently miss the user. Doctor reports all-ok.
  - `sync_url` missing from config → every economic flow short-circuits before its first network call. Doctor reports all-ok.
  - The same `if (config.cli_encrypted_key) { try / catch passphrase decrypt }` block was inlined across **five** call sites (register, daemon × 2, \_helpers, wallet) with subtly different error handling and prompt labels. Future contributors had no guard against adding a sixth.

  None of this was hypothetical — it's exactly what a live `motebit doctor; motebit fund 1.00` run produced on a real installed identity that had been through the 2026-04-25 config-clobber-refusal flow (`85fb31f0`).

  ## What ships

  ### `loadActiveSigningKey(config, options?)` — canonical signing-key resolver

  `apps/cli/src/identity.ts`. Single read site for `cli_encrypted_key` and the deprecated `cli_private_key`. Replaces five inline blocks; wires register, daemon (× 2), `getRelayAuthHeaders`, and `motebit wallet` through one helper.

  Resolution order:

  ```text
  1. cli_encrypted_key — passphrase from MOTEBIT_PASSPHRASE env or interactive prompt
  2. cli_private_key — legacy plaintext (deprecated since 1.0.0, removed at 2.0.0); warns on use
  ```

  **Defense the inline copies didn't have:** the helper re-derives the public key from the private bytes and verifies it byte-equals `config.device_public_key`. Fail-closed on mismatch. Inline copies would silently sign under the wrong identity — a downstream verifier rejecting the signature is an obvious failure, but signing as someone else is a silent one. The mismatch case is the load-bearing test.

  Sources NOT supported (deliberate):
  - **`~/.motebit/dev-keyring.json`.** Written by the desktop Tauri app's Keychain-failure fallback (`apps/desktop/src/identity-manager.ts:124`). Cross-surface keystore unification is a real architectural pass; a silent fallback chain is the wrong shape for it. The right shape is an explicit `IdentityKeyAdapter` per surface, same family as the storage adapter pattern. That's a separate commit.
  - **Raw private-key bytes from environment variables.** Sovereign identity is not an env-friendly secret — env leaks through shell history, CI logs, process inspection, debug dumps. The passphrase env IS supported because the on-disk ciphertext is the actual secret; the passphrase is a scrypt-stretching factor, not the secret itself.

  `IdentityKeyError` is a structured failure type carrying `kind` (`missing` / `decrypt-failed` / `malformed-private-key` / `public-key-mismatch`) and `remedy` (a one-line actionable next-step). Each call site catches the error and surfaces the remedy — `register` and `daemon` downgrade to unsigned / disabled with a warning that names the kind; `wallet` exits with the remedy printed; `_helpers.getRelayAuthHeaders` proceeds unauthenticated for read-only flows.

  ### `motebit doctor` — first-run actionable probes

  Pre-1.0 doctor checked structural readiness only (Node, sqlite, identity-id-present). All-green doctor + every economic flow failing was the wrong signal. The expanded doctor adds three probes that run unconditionally and three that run when `sync_url` is set:

  ```text
  Identity key         present + shape (cli_encrypted_key | cli_private_key | missing)
  Public key           device_public_key present + 32-byte hex
  Sync URL             configured in config or MOTEBIT_SYNC_URL env
  Relay reachable      GET /health/ready returns 2xx (5s timeout)
  Identity registered  GET /agent/:id/capabilities returns 200 (5s timeout)
  ```

  Each failure carries a concrete remedy: `restore from ~/.motebit/config.json.clobbered-{date}` (when a clobbered backup is detected on disk), `run motebit init`, `run motebit register`, etc. Probes are best-effort with timeouts so doctor stays unattended-friendly — a misconfigured URL or network failure doesn't hang the command.

  ### Promoted `getPublicKeyBySuite` to `@motebit/encryption`

  The helper needed to derive a public key from a private seed to verify the device-public match. Per `check-app-primitives` doctrine, apps consume product vocabulary (`@motebit/encryption`), not Layer-0 protocol primitives (`@motebit/crypto`). `getPublicKeyBySuite` was already exported from `@motebit/crypto`'s `signing.ts` re-exports; this commit re-exports it from `@motebit/encryption`'s barrel as the product-vocabulary pair to `generateKeypair` for "I have a private seed, give me the public."

  ## What's deliberately NOT in this commit
  - **Cross-surface keystore unification.** `IdentityKeyAdapter` interface across CLI / desktop / mobile / web. The dev-keyring fallback question feeds into this; the right answer is per-surface adapters with explicit type, not a fallback chain at any single read site. Separate architectural pass.
  - **Restoring Daniel's specific environment.** This commit fixes the code so that future first-run users hit `doctor` and see what to do. Daniel's existing `~/.motebit/config.json` still needs `cli_encrypted_key` restored from the clobbered backup (or a fresh `motebit init`); doctor now points at that exact remedy.
  - **Running real `motebit fund` / `delegate` / `settle`.** Those require Daniel's Stripe interaction and decrypted signing key; doctor's job is to surface gaps, not move money.

  ## Verification
  - 9 new unit tests in `identity-load-active-signing-key.test.ts` — happy path, env passphrase, legacy plaintext (with deprecation warn), missing key, wrong passphrase, public-key mismatch (fail-closed), skipped-mismatch escape hatch, malformed bytes, missing-public-key edge.
  - 3 boundary tests in `relay-auth-passphrase.test.ts` (rewritten to match new helper boundary): resolver invoked when no master token, master token shortcuts resolver entirely, resolver throw downgrades to unauthenticated.
  - All 199 CLI tests pass; all 42 drift defenses pass.
  - Live run on a real broken config produced two clear `FAIL` lines with correct remedies pointing at a clobbered backup that exists on disk and at `motebit register`.

  Operator-facing surface unchanged: subcommands, flags, exit codes, `~/.motebit/` layout, relay HTTP routes all preserve their 1.0.0 contract.

- 8c2426a: Add `motebit migrate-keyring` — recovery path that re-encrypts a plaintext `~/.motebit/dev-keyring.json` private key under a passphrase and writes it as `cli_encrypted_key` in `~/.motebit/config.json`.

  ## Why

  A live golden-path walkthrough turned up a class of users with a valid private key on disk under `~/.motebit/dev-keyring.json` (written by the desktop Tauri app's Keychain-failure fallback in `apps/desktop/src/identity-manager.ts:124`, or by older scaffold flows) but no `cli_encrypted_key` in `config.json`. The CLI's only response in this state was "no private key found" — the path of least resistance was to run the interactive setup again, which silently created a brand new identity and abandoned everything signed under the old `motebit_id`. That's the wrong escape valve for a sovereign-identity product whose moat is accumulated trust.

  A check on one real install surfaced **three motebit identities** in `~/.motebit/`, accumulated over a month — each one created because there was no recovery doctrine for "I have the key, I just don't have it where the CLI looks." The CLI was treating identity creation as cheap and recovery as undocumented. Inverted priorities.

  ## What ships

  `motebit migrate-keyring [--force]` does exactly one thing: takes the existing private key on disk, encrypts it under a passphrase you choose, and writes it as `cli_encrypted_key`. The current `motebit_id` is preserved. Nothing else changes.

  The load-bearing defense is **fail-closed on key/public mismatch**. Before encrypting, the subcommand re-derives the public key from the private bytes and verifies it byte-equals `config.device_public_key`. If they don't match, the dev-keyring belongs to a different identity than your config — silently binding it would produce signed artifacts under one motebit_id but with a private key for another (the silent-corruption case `loadActiveSigningKey` already defends against at the read path). The error explains the orphaned-key situation and points at three concrete next moves: remove the orphaned keyring, restore from a `~/.motebit/config.json.clobbered-*` backup, or run a fresh `motebit init`.

  Honors `MOTEBIT_PASSPHRASE` env for unattended / scripted use, matching the convention in `_helpers.getRelayAuthHeaders`, `register`, and `daemon`. Refuses to overwrite an existing `cli_encrypted_key` without `--force` (rotating the passphrase has a separate intent shape).

  After successful migration, the plaintext `dev-keyring.json` is overwritten with zeros and unlinked — leaving plaintext keys on disk after the encrypted version exists is a security regression.

  6 unit tests pin: happy path (migrate + remove plaintext), fail-closed on key/public mismatch (the load-bearing case — refuses to bind an orphaned key), refuses overwrite without --force, requires identity in config, refuses on passphrase mismatch, plus a sanity round-trip on `getPublicKeyBySuite` to catch suite-dispatch regressions that would silently break the match check.

  ## What this leaves on the table

  The deeper architectural smell behind the multi-identity drift — `motebit` (no args) silently creating a new identity when config is partial-but-not-empty, scaffold tools and operator tools sharing `~/.motebit/`, no doctor probe for "you have N orphaned identities" — is named in the original audit but not addressed here. That's a sibling pass.

- edced5e: Fix two production bugs surfaced by a live golden-path run.

  ## 1. CLI signed money-path requests with the wrong audience

  `apps/cli/src/subcommands/market.ts` — `handleBalance`, `handleFund`, `handleWithdraw` all called `getRelayAuthHeaders(config)` which defaults the signed-token audience to `"admin:query"`. The relay's `dualAuth` middleware (`services/api/src/middleware.ts:631-645`) requires per-route audiences:

  ```text
  GET  /api/v1/agents/:id/balance     → account:balance
  POST /api/v1/agents/:id/checkout    → account:checkout
  POST /api/v1/agents/:id/withdraw    → account:withdraw
  ```

  Result: **every `motebit balance / fund / withdraw` since 1.0.0 has failed with `401 AUTH_INVALID_TOKEN` against any relay running the dual-auth middleware**. The bug was invisible to `motebit doctor` (which doesn't call these routes) and to the published-package CI (which has no live-relay smoke). Caught only when running the full economic flow against a real relay.

  Fix: each call site pins its own aud. `handleFund` mints two tokens (one for `/checkout`, one for the balance-poll loop on `/balance`) since a signed token can only carry one aud.

  ## 2. Relay `/checkout` returned opaque 500 on Stripe errors

  `services/api/src/budget.ts:662` had zero error handling around the Stripe SDK call. Any thrown `StripeError` became `{"error":"Internal server error","status":500}` from Hono's default uncaught-exception handler — the actual Stripe message ("Your account cannot currently make live charges", "Your card was declined", etc.) only existed in fly.io logs. Operators of every motebit relay had to dig logs to debug their own users' fund flows.

  Fix: new `mapStripeError(c, ...)` helper (in `budget.ts`, top of file) catches Stripe SDK exceptions and returns a structured 502:

  ```json
  {
    "error": "STRIPE_ACCOUNT_NOT_ACTIVATED",
    "message": "Your account cannot currently make live charges.",
    "stripe_type": "StripeInvalidRequestError",
    "stripe_code": null,
    "status": 502
  }
  ```

  The motebit-shaped `error` code is mapped from common Stripe error patterns:

  ```text
  "cannot currently make live charges" → STRIPE_ACCOUNT_NOT_ACTIVATED
  StripeAuthenticationError             → STRIPE_API_KEY_INVALID
  StripeRateLimitError                  → STRIPE_RATE_LIMITED
  StripeConnectionError                 → STRIPE_CONNECTION_FAILED
  (everything else)                     → STRIPE_<TYPE>
  ```

  Per `services/api/CLAUDE.md` rule 14 — external medium plumbing speaks motebit vocabulary. Provider-shaped errors (Stripe's deep nested raw object) collapse here into a closed motebit shape. Server-side logs still capture the full Stripe response (request ID, headers) for operator debugging; the client never sees raw Stripe internals.

  The CLI side (`market.ts handleFund`) parses the new structured shape and prints both the motebit code and Stripe's human message. For `STRIPE_ACCOUNT_NOT_ACTIVATED` specifically, it adds a one-line pointer at the Stripe onboarding URL — the most common path to recovery.

  ## What this leaves on the table

  A drift defense that catches the audience-mismatch class of bug at lint time would be valuable — `check-aud-binding` could grep middleware aud strings, grep CLI aud strings, and require any motebit-signed POST to a route in the middleware list to use the matching aud. Filed as a follow-up; not in this commit because it requires walking Hono middleware definitions, which is non-trivial.

- 16e450b: `motebit` CLI now honors `MOTEBIT_PASSPHRASE` for relay-auth token minting.

  **Bump level**: patch. This is a repaired promise, not an expanded one — `MOTEBIT_PASSPHRASE` is a generic-sounding env var the user reasonably expects to work everywhere a passphrase is needed. The previous behavior (env var works for `--yes` and rotate/export/attest, silently ignored by relay-auth) was internal inconsistency, not a deliberate restriction. Fixing it brings behavior in line with the env var's documented role.

  Gap #6 from the 2026-04-25 first-time-user walkthrough. `getRelayAuthHeaders()` (the function that mints a signed device token when no `MOTEBIT_API_TOKEN` master token is present) called `promptPassphrase()` unconditionally — it didn't read `MOTEBIT_PASSPHRASE` the way every other unlock prompt in the CLI does. Result: any scripted use of `motebit credentials`, `motebit export`, `motebit attest`, etc. silently hung waiting on a hidden TTY prompt. The exact reproduction was running `MOTEBIT_PASSPHRASE=x npx motebit credentials` and watching it block on `Passphrase (for relay auth):` despite the env var being set.

  What changed:
  - `apps/cli/src/subcommands/_helpers.ts::getRelayAuthHeaders()` now reads `process.env["MOTEBIT_PASSPHRASE"]` before falling back to the interactive prompt. Same pattern as `apps/cli/src/index.ts:401`, `subcommands/rotate.ts:104`, `subcommands/export.ts:44`, `subcommands/attest.ts:97` — those already honored the env var; only `getRelayAuthHeaders` didn't.
  - The prompt label drops the `(for relay auth)` parenthetical and is now just `Passphrase: ` to match every other unlock prompt. The previous label implied a separate passphrase concept that doesn't exist — the relay-auth token is signed by the same Ed25519 private key encrypted under `cli_encrypted_key`, unlocked by the same passphrase the user set during `create-motebit`.
  - New `apps/cli/src/__tests__/relay-auth-passphrase.test.ts` regression test asserts: env var skips the prompt, no env var falls back to prompting with the new `Passphrase: ` label, and `MOTEBIT_API_TOKEN` master token shortcuts the passphrase path entirely (existing behavior preserved).

  Migration: scripts that piped a passphrase via stdin to `motebit` commands as a workaround for the silent prompt no longer need the workaround — set `MOTEBIT_PASSPHRASE` in the environment instead. Interactive use is unchanged except for the simpler prompt text.

  Architectural note for future readers: the auth strategy in `getRelayAuthHeaders` is a 2-tier fallback — `MOTEBIT_API_TOKEN`/`MOTEBIT_SYNC_TOKEN` master token first, signed device token second. The signed device token is JWT-shaped (5-minute expiry, audience-scoped) and minted from the local key. There is no third "relay auth secret" concept; that misimpression was created by the prompt label.

- 6c2f8f5: Add `@hono/node-ws` to runtime dependencies. The `motebit relay up` path imports `@motebit/api` (bundled via `tsup noExternal: [/^@motebit\//]`), which uses `@hono/node-ws` for WebSocket upgrades. The CLI's `tsup.config.ts` correctly marks it `external` (CJS-era init code that doesn't survive ESM bundling), but it was never declared as a runtime dependency of the `motebit` package itself.

  In a workspace dev environment, pnpm's hoisting resolved the transitive dependency through `services/api`'s declaration. On a fresh `npm install motebit`, the package tries to load `@hono/node-ws` and exits with `ERR_MODULE_NOT_FOUND` on first boot.

  Caught by `check-dist-smoke` (drift defense #12) on first push of the relay-up commit (`0e924976`) — exactly the regression class the gate was built for: a build that compiles clean but the dist binary crashes on startup. Same shape as the prior `@noble/hashes × @solana/web3.js` bundling break (2026-04-13).

  Fix: declare `@hono/node-ws@^1.3.0` in `apps/cli/package.json` dependencies, matching the version pin already used by `services/api`.

- 21875ed: Tighten the published-package README so the runtime/CLI distinction is precise, and align spec/package counts with reality.

  ## Why

  The `motebit` package is the bundled reference runtime — relay, policy engine, sync engine, MCP server, and wallet adapters inlined into a single binary. The CLI is its primary operator-facing surface, not the artifact itself. The prior README opener ("the motebit CLI is published as a binary") was an elegant one-sentence framing that read accurately to someone scanning, but understated what the package actually contains and slipped against the package's own description field ("Reference runtime and operator console").

  A reviewer pulling on the framing surfaced the imprecision in two rounds. Fixing it locally without auditing siblings would have left the published-artifact prose drifting from the npm metadata it ships beside, so the cleanup also re-checked counts and package-table coverage at the same time.

  ## What shipped
  - `apps/cli/README.md` — new "How it ships" section opens with `motebit` as the bundled reference runtime and reframes the CLI as one of its surfaces. Restates the public-promise sentence: subcommands, flags, exit codes, `~/.motebit/` layout, relay HTTP routes, and MCP server tool list — not the internal workspace package graph.
  - Root `README.md` — package table expanded from 7 rows to 11 so all four hardware-attestation Apache-2.0 leaves (`crypto-appattest`, `crypto-play-integrity`, `crypto-tpm`, `crypto-webauthn`) are visible alongside the rest of the published surface in one place. New "Versioning" section adjacent to "Licensing" makes the published-vs-private split explicit.
  - Spec count: `12` → `19` across root README (×4), `CLAUDE.md`, and `apps/docs/content/docs/operator/architecture.mdx`. The seven specs missing from earlier enumerations (`agent-settlement-anchor`, `consolidation-receipt`, `device-self-registration`, `goal-lifecycle`, `memory-delta`, `plan-lifecycle`, `computer-use`) are real specs with reference implementations; the prose just hadn't been updated.
  - Package count: `36` / `40` / `37` → `46` across the same three surfaces. `pnpm check-docs-tree` validates the new numbers.
  - Five empty `auto-generated patch bump` changeset stubs deleted so they don't pollute the next CHANGELOG entry with content-free lines.

  ## Impact

  Zero runtime change. Zero API change. The `motebit` patch bump exists because `apps/cli/README.md` is in the package's `files` array — the README that ships to npm changes, so the published version should reflect it. Smoke test (`npm install motebit@1.0.0 && motebit doctor` from a clean tmp directory) passes all six checks including Secure Enclave detection on Apple Silicon hosts; the cleanup is purely textual.

  Three follow-ups are tracked separately: a `check-cli-surface` drift gate to bring CLI-surface rigor up to the protocol-floor `check-api-surface` standard, sentinel versioning on the 35 private workspace packages so their `0.x` numbers stop carrying unintended semver social meaning, and a CI gate that rejects empty changeset bodies at the source.

- 53a2783: License metadata correction: `package.json` `license` field flipped from
  `BSL-1.1` to `BUSL-1.1` — the SPDX-canonical identifier for Business Source
  License 1.1.

  `BSL-1.1` is not on the SPDX license list and silently collides with `BSL-1.0`
  (Boost Software License 1.0) in some scanners; npm warns on non-SPDX values.
  The legal terms are unchanged. This is a metadata-only correction; the
  published package's license text and obligations are identical.

  Prose continues to use "BSL" / "BSL-1.1" everywhere humans read (the BSL FAQ,
  HashiCorp, CockroachDB, Sentry all use "BSL"); `BUSL-1.1` appears only in
  `package.json` `license` fields where tooling parses a token.

- 6e5b1f2: Internal-only: silence `@typescript-eslint/no-require-imports` on three
  `require()` calls inside `vi.hoisted()` in
  `src/__tests__/migrate-keyring.test.ts`. The pattern is idiomatic vitest
  (vi.hoisted runs before ES module imports resolve, so `require()` is the
  only way to reach Node built-ins from inside the hoisted block). Targeted
  `eslint-disable-next-line` comments with an explanation; rule remains in
  force on the rest of the file. No runtime behavior change; tests
  unaffected.
- 5e7a192: Wire the hardware-attestation peer flow in the CLI runtime.

  The runtime hook in `packages/runtime/src/agent-trust.ts:258` (Phase 1 + Phase 2, shipped earlier) was dormant in production: `bumpTrustFromReceipt` gates on `if (getRemoteHardwareAttestations && updated.public_key)`, and no surface had ever called `setHardwareAttestationFetcher` or `setHardwareAttestationVerifiers`. The peer-attestation issuance loop existed only in the relay-side E2E tests; in the actual CLI runtime, hardware claims published by workers were never pulled, never verified, never folded into peer trust credentials, and never visible to routing.

  ## What shipped
  1. **`createRelayCapabilitiesFetcher`** — new export on `@motebit/runtime`. Production fetcher that hits `GET /agent/:motebitId/capabilities`, parses the `hardware_attestations` array, and returns it shaped for the runtime's `HardwareAttestationFetcher` slot. Best-effort: every error surface (network throw, non-2xx, malformed JSON, missing fields, wrong types) returns `[]` so the existing reputation-credential path proceeds unchanged. 8 unit tests pin each error surface plus the success path.
  2. **CLI wiring** at both runtime construction sites — `apps/cli/src/runtime-factory.ts` (REPL, `motebit delegate`, `motebit serve` paths) and `apps/cli/src/daemon.ts` site 1 (long-running daemon mode where `motebit run --price` workers + delegators accumulate trust). After `runtime.connectSync(...)`:

     ```ts
     runtime.setHardwareAttestationFetcher(createRelayCapabilitiesFetcher({ baseUrl: syncUrl }));
     runtime.setHardwareAttestationVerifiers(buildHardwareVerifiers());
     ```

     Adds `@motebit/verify` (Apache-2.0) as a CLI dep — which is what bundles the four canonical platform adapters (App Attest, Android Hardware-Backed Keystore Attestation, TPM 2.0, WebAuthn) plus the deprecated Play Integrity adapter into the CLI binary. Per `motebit-runtime.ts:2462`, `@motebit/verify` is intentionally NOT a runtime dep — surfaces own that choice.

  ## Why a patch and not a minor

  Operator-facing surface (subcommands, flags, exit codes, `~/.motebit/` layout, relay HTTP routes, MCP server tool list) is unchanged. The change is internal: peer trust credentials now carry a hardware-attestation block at delegation time when the worker has published a verifiable claim, which the routing aggregator scores at `HW_ATTESTATION_HARDWARE` (1.0) instead of the software sentinel's `HW_ATTESTATION_SOFTWARE` (0.1). Per `apps/cli/README.md`'s public-promise paragraph, that's not a breaking change.

  ## What's still deferred

  The other four surfaces — `@motebit/desktop`, `@motebit/mobile`, `@motebit/web`, `@motebit/spatial` — construct `MotebitRuntime` and may benefit from the same wiring. Mechanical follow-on (one-pass-delivery candidate); separated from this commit because each surface has its own sync-URL resolution pattern and adding `@motebit/verify` to four more workspaces is best reviewed in its own diff. The runtime hook stays dormant on those surfaces until the same two setters are called there.

- cdfaf18: Same-pass surface wiring for the hardware-attestation peer flow.

  The CLI landed with `5e7a1922` (runtime-hardware-attestation-fetcher-cli-wiring). This commit closes one-pass delivery across the four other surfaces — `@motebit/desktop`, `@motebit/mobile`, `@motebit/web`, `@motebit/spatial` — so peer hardware claims fold into routing trust regardless of which surface the user delegates from.

  ## Why a lazy resolver

  The CLI's sync URL was a constant the moment we constructed `MotebitRuntime`. The other four surfaces resolve it through cached fields that get repopulated on config changes:
  - **Desktop** — `_proxySyncUrlCache` (cached at bootstrap from Tauri config)
  - **Mobile** — `_proxySyncUrlCache` (cached at bootstrap from AsyncStorage)
  - **Web** — `loadSyncUrl()` reads `localStorage` on each call
  - **Spatial** — same `localStorage` accessor as the ProxySessionAdapter

  Threading the URL into the runtime at construction would have meant runtime reconstruction every time the user changed relay settings. So `createRelayCapabilitiesFetcher` now accepts either a static string OR a synchronous resolver:

  ```text
  baseUrl: string | (() => string | undefined | null)
  ```

  If the resolver returns `undefined` / `null` / `""`, the fetcher returns `[]` without touching the network — matches the no-claim-observed semantics the runtime hook already handles. Three new unit tests pin the lazy branch (resolver yields, resolver returns undefined, resolver returns empty string); the static-string path is unchanged.

  ## Surface choice — why spatial gets the wiring

  `apps/spatial/CLAUDE.md` rejects the panel metaphor, but the hardware-attestation peer flow isn't a panel — it's a runtime hook that fires on the same `MotebitRuntime.bumpTrustFromReceipt` path every other surface uses. The creature in spatial dispatches receipts through the same delegation engine; if a worker is running a hardware-backed identity, that should score at `HW_ATTESTATION_HARDWARE` (1.0) regardless of which surface the user delegated from. Skipping spatial would have introduced a routing asymmetry — same workers, same claims, different scores depending on the delegator's surface.

  ## What's now load-bearing

  Each surface's runtime, on every successful delegation, pulls `GET /agent/:remote_motebit_id/capabilities`, parses the worker's self-published `hardware_attestation` credential, runs the embedded claim through the bundled platform adapter (App Attest / Android Hardware-Backed Keystore Attestation / TPM 2.0 / WebAuthn / + the deprecated Play Integrity), and on `valid: true` issues a peer `AgentTrustCredential` carrying the verified claim. The routing aggregator scores the result at `HW_ATTESTATION_HARDWARE` (1.0) — 10× the software sentinel's 0.1 — visible across every routing decision the user's motebit makes from now on.

  ## Why patch

  Operator-facing surface (subcommands, flags, `~/.motebit/` layout, relay HTTP routes, MCP server tool list, web/desktop/mobile/spatial UI) is unchanged. The behavior change is visible only inside the routing semiring's edge weights.

## 1.0.0

### Major Changes

- 009f56e: Add cryptosuite discriminator to every signed wire-format artifact.

  `@motebit/protocol` now exports `SuiteId`, `SuiteEntry`, `SuiteStatus`,
  `SuiteAlgorithm`, `SuiteCanonicalization`, `SuiteSignatureEncoding`,
  `SuitePublicKeyEncoding`, `SUITE_REGISTRY`, `ALL_SUITE_IDS`, `isSuiteId`,
  `getSuiteEntry`. Every signed artifact type gains a required `suite:
SuiteId` field alongside `signature`. Four Ed25519 suites enumerated
  (`motebit-jcs-ed25519-b64-v1`, `motebit-jcs-ed25519-hex-v1`,
  `motebit-jwt-ed25519-v1`, `motebit-concat-ed25519-hex-v1`) plus the
  existing W3C `eddsa-jcs-2022` for Verifiable Credentials.

  Verifiers reject missing or unknown `suite` values fail-closed. No
  legacy compatibility path. Signers emit `suite` on every new artifact.

  Identity file signature format changed:
  - Old: `<!-- motebit:sig:Ed25519:{hex} -->`
  - New: `<!-- motebit:sig:motebit-jcs-ed25519-hex-v1:{hex} -->`

  The `identity.algorithm` frontmatter field is deprecated (ignored with
  a warning when present; no longer emitted on export).

  Post-quantum migration becomes a new `SuiteId` entry + dispatch arm in
  `@motebit/crypto/suite-dispatch.ts`, not a wire-format change.

  ## Migration

  This release is breaking for every consumer that constructs, signs, or verifies a motebit signed artifact. The change is mechanical — add one field on construction, pass one argument on sign, re-sign identity files once — but there is no legacy acceptance path, so every caller must update in lockstep. Verifiers reject unsuited or unknown-suite artifacts fail-closed. Migration steps follow, grouped by the consumer surface.

  ### For consumers of `@motebit/protocol` types

  Every signed-artifact type now has a required `suite: SuiteId` field.
  Anywhere you construct one (tests, mocks, fixtures), add the correct
  suite value for that artifact class — see `SUITE_REGISTRY`'s
  `description` field for the per-artifact assignment, or consult
  `spec/<artifact>-v1.md §N.N` for the binding wire format.

  ```ts
  // Before
  const receipt: ExecutionReceipt = {
    task_id, motebit_id, ...,
    signature: sigHex,
  };

  // After
  import type { SuiteId } from "@motebit/protocol";
  const receipt: ExecutionReceipt = {
    task_id, motebit_id, ...,
    suite: "motebit-jcs-ed25519-b64-v1" satisfies SuiteId,
    signature: sigHex,
  };
  ```

  ### For consumers of `@motebit/crypto` sign/verify helpers

  Sign helpers that previously accepted just keys now require a `suite`
  parameter constrained to the suites valid for the artifact class:

  ```ts
  // Before
  const receipt = await signExecutionReceipt(body, privateKey);

  // After
  const receipt = await signExecutionReceipt(body, privateKey, {
    suite: "motebit-jcs-ed25519-b64-v1",
  });
  ```

  Verify helpers route through the internal `verifyBySuite` dispatcher;
  direct calls are unchanged at the boundary, but behavior now rejects
  artifacts without a `suite` field (legacy-no-suite path is deleted).

  ### For consumers of `motebit.md` identity files

  Identity files signed before this release will fail to parse. Re-sign
  by running `motebit export --regenerate` (or the CLI equivalent) after
  upgrading. The `identity.algorithm` YAML field is ignored on new
  parses and no longer emitted on export.

  ### For consumers of `DelegationToken` (`@motebit/crypto`)

  `DelegationToken` carries two breaking changes beyond the suite addition.
  Public keys are now **hex-encoded** (64 chars, lowercase) instead of
  base64url — consistent with every other Ed25519-key-carrying motebit
  artifact. And `signDelegation` takes `Omit<DelegationToken, "signature"
| "suite">` (the signer stamps the suite).

  ```ts
  // Before
  const token = await signDelegation(
    {
      delegator_id,
      delegator_public_key: toBase64Url(kp.publicKey),
      delegate_id,
      delegate_public_key: toBase64Url(otherKp.publicKey),
      scope,
      issued_at,
      expires_at,
    },
    kp.privateKey,
  );

  // After
  const token = await signDelegation(
    {
      delegator_id,
      delegator_public_key: bytesToHex(kp.publicKey),
      delegate_id,
      delegate_public_key: bytesToHex(otherKp.publicKey),
      scope,
      issued_at,
      expires_at,
    },
    kp.privateKey,
  );
  // token.suite is stamped as "motebit-jcs-ed25519-b64-v1"
  ```

  Verifiers reject tokens without `suite` (or with any value other than
  `"motebit-jcs-ed25519-b64-v1"`) fail-closed, and decode `delegator_public_key`
  from hex. Base64url-encoded tokens issued before this release do not
  verify — pre-launch, no migration tool is provided; re-issue tokens
  after upgrading.

  ### Running the new drift gates locally

  `pnpm run check` now runs ten drift gates (previously eight). Two new
  gates — `check-suite-declared` and `check-suite-dispatch` — enforce
  that every signed Wire-format spec section names a `suite` field and
  that every verifier in `@motebit/crypto` dispatches via the shared
  `verifyBySuite` function (no direct primitive calls).

- e17bf47: Publish the four hardware-attestation platform verifier leaves as first-class
  Apache-2.0 packages, joining the fixed-group release at 1.0.0.

  Stop-ship finding from the 1.0 pre-publish audit: `@motebit/verify@1.0.0`
  declared runtime dependencies on four `@motebit/crypto-*` adapters marked
  `"private": true`, which would have caused `npm install @motebit/verify` to
  404 on the adapters. The root `LICENSE`, `README.md`, `LICENSING.md`, and the
  hardware-attestation doctrine all claim these adapters as public Apache-2.0
  permissive-floor packages — the `"private": true` markers were doctrine drift
  left behind from scaffolding.

  This changeset closes the drift by publishing the adapters and wiring them
  into the fixed group so they bump in lockstep with the rest of the protocol
  surface:
  - `@motebit/crypto-appattest` — Apple App Attest chain verifier (pinned
    Apple root)
  - `@motebit/crypto-play-integrity` — Google Play Integrity JWT verifier
    (pinned Google JWKS; structurally complete, fail-closed by default pending
    operator key wiring)
  - `@motebit/crypto-tpm` — TPM 2.0 Endorsement-Key chain verifier (pinned
    vendor roots)
  - `@motebit/crypto-webauthn` — WebAuthn packed-attestation verifier (pinned
    FIDO roots)

  Each carries the standard permissive-floor manifest (description, `exports`,
  `files`, `sideEffects: false`, `NOTICE`, keywords, homepage/repository/bugs,
  `publishConfig: public`, `lint:pack` with `publint` + `attw`, focused README
  showing how to wire the verifier into `@motebit/crypto`'s
  `HardwareAttestationVerifiers` dispatcher).

  Also in this changeset:
  - `engines.node` aligned to `>=20` across `@motebit/protocol`, `@motebit/sdk`,
    and `@motebit/crypto` — matches the rest of the fixed group and removes
    downstream consumer confusion (a `@motebit/verify` consumer on Node 18
    previously got inconsistent engines-check signals between libraries).
  - `NOTICE` added to `motebit` (the bundled CLI's tarball, required by Apache
    §4(d) because the bundle inlines Apache-licensed code from the permissive
    floor).

  No code changes — all four adapter implementations and public APIs are
  unchanged. The flip is manifest + metadata + README + fixed-group wiring.

  ## Migration

  **For `@motebit/verify` consumers:** no action required. `npm install -g @motebit/verify@1.0.0` now correctly pulls the four platform adapter packages from npm instead of failing on unpublished `workspace:*` refs. Before this changeset, `npm install @motebit/verify@1.0.0` would have 404'd on `@motebit/crypto-appattest@1.0.0` et al.

  **For direct library consumers (new capability):** the four platform adapters can now be imported independently when a third party wants only one platform's verifier without pulling the full CLI. Wiring into `@motebit/crypto`'s dispatcher:

  ```ts
  // Before (1.0.0-rc and earlier — adapters not installable from npm):
  // only possible via @motebit/verify's bundled verifyFile():
  import { verifyFile } from "@motebit/verifier";
  import { buildHardwareVerifiers } from "@motebit/verify";
  const result = await verifyFile("cred.json", {
    hardwareAttestation: buildHardwareVerifiers(),
  });

  // After (1.0.0 — fine-grained composition):
  import { verify } from "@motebit/crypto";
  import { deviceCheckVerifier } from "@motebit/crypto-appattest";
  import { webauthnVerifier } from "@motebit/crypto-webauthn";

  const result = await verify(credential, {
    hardwareAttestation: {
      deviceCheck: deviceCheckVerifier({ expectedBundleId: "com.example.app" }),
      webauthn: webauthnVerifier({ expectedRpId: "example.com" }),
      // tpm / playIntegrity omitted — verifier returns `adapter-not-configured` for those platforms
    },
  });
  ```

  **For Node 18 consumers of `@motebit/protocol`, `@motebit/sdk`, or `@motebit/crypto`:** the `engines.node` field now declares `>=20` across the entire fixed group (previously drifted: protocol/sdk/crypto said `>=18`, other packages said `>=20`). npm does not hard-enforce `engines` by default, so installs continue to succeed — but teams running strict-engine linters should upgrade to Node 20 LTS. Node 18 entered maintenance-only status April 2025.

  **For third-party protocol implementers:** no wire-format changes. The four platform attestation wire formats (`AppAttestCbor`, Play Integrity JWT, `TPMS_ATTEST`, WebAuthn packed attestation) are unchanged — this changeset only publishes the reference TypeScript verifiers for each.

- 58c6d99: **@motebit/verify resurrected as the canonical CLI, three-package lineage locked in.**

  The entire published protocol surface bumps to 1.0.0 in a coordinated release. What changes at npm:
  - **`@motebit/verify@1.0.0`** — fresh lineage superseding the deprecated `0.7.0` zero-dep library. Ships the `motebit-verify` CLI binary with every hardware-attestation platform bundled (Apple App Attest, Google Play Integrity, TPM 2.0, WebAuthn) and motebit-canonical defaults pre-wired (bundle IDs, RP ID, integrity floor). Network-free, self-attesting. License: Apache-2.0 — the aggregator encodes no motebit-proprietary judgment (defaults are overridable flags, not trust scoring or economics), so it sits on the permissive floor alongside the underlying leaves. Runs `npm install -g @motebit/verify` to get the tool, no license friction in CI pipelines or enterprise audit tooling.
  - **`@motebit/verifier@1.0.0`** — library-only. The `motebit-verify` CLI that used to live here has moved to `@motebit/verify` (above). This package now ships only the Apache-2.0 helpers (`verifyFile`, `verifyArtifact`, `formatHuman`, `VerifyFileOptions` with the optional `hardwareAttestation` injection point). Third parties writing Apache-2.0-only TypeScript verifiers compose this with `@motebit/crypto` — and optionally any subset of the four Apache-2.0 `@motebit/crypto-*` platform leaves — without pulling BSL code.
  - **`@motebit/crypto@1.0.0`** — role unchanged; version bump marks 1.0 maturity of the primitive substrate. Apache-2.0 (upgraded from MIT in the same release; the floor flip gives every contributor's work an explicit patent grant and litigation-termination clause), zero monorepo deps.
  - **`@motebit/protocol@1.0.0`** — wire types + algebra. Apache-2.0 permissive floor. 1.0 signals the protocol surface is stable enough to implement against.
  - **`@motebit/sdk@1.0.0`** — stable developer-contract surface. 1.0 locks the provider-resolver / preset / config vocabulary for integrators.
  - **`create-motebit@1.0.0`** — scaffolder bumps to match.
  - **`motebit@1.0.0`** — operator console CLI bumps to match.

  The three-package lineage for verification tooling follows the pattern that survives decades — git / libgit2, cargo / tokio, npm / @npm/arborist:

  ```
  @motebit/verify                Apache-2.0  the CLI motebit-verify + motebit-canonical defaults over the bundled leaves
  @motebit/verifier              Apache-2.0  library: verifyFile, verifyArtifact, formatHuman
  @motebit/crypto                Apache-2.0  primitives: verify, sign, suite dispatch
  @motebit/crypto-appattest      Apache-2.0  Apple App Attest chain verifier (pinned Apple root)
  @motebit/crypto-play-integrity Apache-2.0  Google Play Integrity JWT verifier (pinned Google JWKS)
  @motebit/crypto-tpm            Apache-2.0  TPM 2.0 EK chain verifier (pinned vendor roots)
  @motebit/crypto-webauthn       Apache-2.0  WebAuthn packed-attestation verifier (pinned FIDO roots)
  ```

  All seven packages in the verification lineage ship Apache-2.0 — the full verification surface lives on the permissive floor. Each answers "how is this artifact verified?" against a published public trust anchor, the permissive side of the protocol-model boundary test. The BSL line holds at `motebit` (the operator console) and everything below it, where the actual reference-implementation judgment lives (daemon, MCP server, delegation routing, market integration, federation wiring). See the separate `permissive-floor-apache-2-0` and `verify-cli-apache-2-0` changesets for the rationale behind the floor licensing.

  ## Migration

  The 1.0 release is a coordinated major bump across the fixed release group. The APIs exported by `@motebit/protocol`, `@motebit/sdk`, `@motebit/crypto`, `create-motebit`, and `motebit` have NOT broken — this major marks endgame-pattern maturity, not a code-shape change. The actual behavioral shifts are confined to the verification-tooling lineage:

  **1. `@motebit/verifier` bin removed (breaking).**

  ```ts
  // Before — @motebit/verifier@0.8.x shipped a `motebit-verify` binary.
  // After  — @motebit/verifier@1.0.0 is library-only.
  // Install `@motebit/verify@^1.0.0` for the CLI:
  //   npm install -g @motebit/verify
  //   motebit-verify cred.json
  // The programmatic library surface is unchanged:
  import { verifyFile, formatHuman } from "@motebit/verifier"; // ← still works
  ```

  **2. `@motebit/verify@0.7.0` (deprecated library) → `@motebit/verify@1.0.0` (resurrected CLI).**

  | You were using (0.7.0)                               | Migrate to                                                                          |
  | ---------------------------------------------------- | ----------------------------------------------------------------------------------- |
  | `verify()` function in TypeScript                    | `import { verify } from "@motebit/crypto"` — same shape, more features              |
  | `verifyFile` / `formatHuman` / programmatic wrappers | `import { verifyFile } from "@motebit/verifier"`                                    |
  | Running `motebit-verify` on the command line         | `npm install -g @motebit/verify` at `^1.0.0` — same command, full platform coverage |

  Users pinned to `"@motebit/verify": "^0.7.0"` stay on the deprecated 0.x line automatically — semver prevents auto-bumps to 1.0.0. The 0.x tarballs remain immutable on npm; archaeology is preserved.

  ## Rationale

  The entire published protocol surface hits 1.0 together as the endgame-pattern milestone. The three-package lineage for verification tooling (verify / verifier / crypto) follows the shape long-lived tool families use — git / libgit2, cargo / tokio, npm / @npm/arborist. The coordinated major signals that this is the architecture intended to hold long-term.

  **Operator follow-up — run immediately after `pnpm changeset publish` returns:**

  ```bash
  npm deprecate @motebit/verify@0.7.0 \
    "Superseded by @motebit/verify@1.x — the canonical CLI. For the library, see @motebit/crypto."
  ```

  The current deprecation message on `0.7.0` dates from the 2026-04-09 package rename and still claims "Same MIT license" — factually correct then, stale the moment 1.0.0 ships (the permissive floor is now Apache-2.0). The replacement message points at both migration paths — the CLI (`@motebit/verify@1.x`) and the library (`@motebit/crypto`) — and makes no license claim that can age. Running it immediately after publish keeps the stale-message window down to minutes, not days.

### Minor Changes

- e897ab0: Ship the three-tier answer engine.

  Every query now routes through a knowledge hierarchy with one shared
  citation shape: **interior → (federation) → public web**. The motebit's
  own answer to "what is Motebit?" now comes from the corpus it ships with,
  not from a Brave index that returns Motobilt (Jeep parts) because
  open-web signal for a new product is near-zero.

  ### Ship-today scope
  - **Interior tier:** new `@motebit/self-knowledge` package — a committed
    BM25 index over `README.md`, `DROPLET.md`, `THE_SOVEREIGN_INTERIOR.md`,
    `THE_METABOLIC_PRINCIPLE.md`. Zero runtime dependencies, zero network,
    zero tokens. Build script `scripts/build-self-knowledge.ts` regenerates
    the corpus deterministically; source hash is deterministic so the file
    is diff-stable when sources don't change.
  - **`recall_self` builtin tool** in `@motebit/tools` (web-safe), mirroring
    `recall_memories` shape. Registered alongside existing builtins in
    `apps/web` and `apps/cli`. (Spatial surface intentionally deferred — it
    doesn't register builtin tools today; `recall_self` would be ahead of
    the parity line.)
  - **Site biasing:** new `BiasedSearchProvider` wrapper in `@motebit/tools`
    composes with `FallbackSearchProvider`. `services/web-search` wraps its
    Brave→DuckDuckGo chain with the default motebit bias rule —
    `"motebit"` queries are rewritten to include
    `site:motebit.com OR site:docs.motebit.com OR site:github.com/motebit`.
    Word-boundary matching prevents "Motobilt" from tripping the rule.
  - **`CitedAnswer` + `Citation` wire types** in `@motebit/protocol`
    (Apache-2.0 permissive floor). Universal shape for grounded answers
    across tiers: interior citations are self-attested (corpus locator,
    no receipt); web and federation citations bind to a signed
    `ExecutionReceipt.task_id` in the outer receipt's `delegation_receipts`
    chain. A new step in `permissive-client-only-e2e.test.ts` proves an
    auditor with only the permissive-floor surface (`@motebit/protocol` +
    `@motebit/crypto`) can verify the chain.
  - **`services/research` extended with the interior tier.** New
    `motebit_recall_self` tool runs locally inside the Claude tool-use
    loop (no MCP atom, no delegation receipt — interior is self-attested).
    System prompt instructs recall-self-first for motebit-related
    questions. `ResearchResult` adds `citations` and `recall_self_count`
    fields alongside existing `delegation_receipts` / `search_count` /
    `fetch_count`.
  - **`IDENTITY` prompt augmented** in `@motebit/ai-core` with one concrete
    sentence about Motebit-the-platform. New `KNOWLEDGE_DOCTRINE` constant
    in the static prefix instructs: "try recall_self first for self-queries;
    never fabricate; say you don't know when sources come up empty."

  ### Deferred
  - **Agent-native search provider** — a follow-up PR adds an adapter for
    a search index with long-tail recall better suited to niche / new
    domains than the current generic web index. Slots into
    `FallbackSearchProvider` as the primary; current chain stays as
    fallback. Separate from this change so the biasing-wrapper impact is
    measurable in isolation.
  - **Federation tier** (`answerViaFederation`): blocked on peer density.
  - **Multi-step synthesis loop** (fact-check pass over draft answers):
    orthogonal quality improvement.
  - **`recall_self` on spatial surface:** comes when spatial's builtin-tool
    suite lands; today it has no `web_search` / `recall_memories` parity
    either.

  ### Drift-gate infrastructure

  `scripts/check-deps.ts` gains an `AUTO-GENERATED`/`@generated` banner
  exception to its license-in-source rule — the committed
  `packages/self-knowledge/src/corpus-data.ts` carries verbatim doc content
  that incidentally includes BSL/Apache license tokens (from README badges).
  Banner skip is the generic pattern; future generated modules benefit.

- 4aad6eb: Add `motebit lsp` — a Language Server for `motebit.yaml`. Ships three
  features derived from the live zod schema in `apps/cli/src/yaml-config.ts`:
  diagnostics (every `parseMotebitYaml` error mapped to an LSP Diagnostic),
  hover (`.describe()` text for the field under the cursor), and completion
  (field names + enum values). Because it speaks LSP, Cursor, Vim/Neovim,
  and JetBrains IDEs pick it up without a per-editor plugin; a thin VS Code
  extension (`apps/vscode`) spawns `motebit lsp` over stdio for VS Code /
  Cursor users.

  New drift defense #20 (`yaml-config.test.ts`) enumerates every schema
  field and asserts each has a non-empty `.describe()` — a new field shipped
  without hover documentation fails CI.

- a51147d: Add `motebit verify <kind> <path>` — a CLI subcommand that validates a
  wire-format artifact against the published `@motebit/wire-schemas`
  contract AND verifies its Ed25519 signature using the embedded
  public key. Three kinds today: `receipt`, `token`, `listing`.

  This is the proof point that closes the wire-schemas loop. A non-motebit
  developer building a Python or Go worker can now check protocol
  compliance with one command:

  ```sh
  motebit verify receipt my-emitted-receipt.json
  ```

  Output is structured per-check — schema, suite, signature (and time
  window for tokens) each report independently, so a failure tells you
  exactly what's wrong:

  ```
  ✓ OK  receipt  /path/to/receipt.json
    ✓ json       parsed 636 bytes
    ✓ schema     ExecutionReceipt v1
    ✓ suite      recognized: motebit-jcs-ed25519-b64-v1
    ✓ signature  Ed25519 over JCS body — verified with embedded public_key
  ```

  `--json` flag emits a structured report for programmatic consumers.

  Backward-compatible with existing `motebit verify <path>` for identity
  files. Two-arg form (`verify <kind> <path>`) discriminates on the
  kind keyword; one-arg form (or explicit `verify identity <path>`) goes
  to the existing identity-file verifier.

  Self-attesting in action: the verifier doesn't require trust in the
  motebit runtime, just in the published schema and Ed25519 math.

- 96bc311: Publish `motebit-yaml-v1.json` — the JSON Schema for `motebit.yaml` is now
  a committed protocol artifact at `apps/cli/schema/motebit-yaml-v1.json`,
  generated from the same zod source the CLI parser and LSP consume.

  Third-party validators (VS Code's Red Hat YAML extension, CI actions,
  the dashboard) can reference it via its stable `$id` — no `motebit`
  install required. Users who want an inline yaml-language-server pragma:

  ```yaml
  # yaml-language-server: $schema=https://raw.githubusercontent.com/motebit/motebit/main/apps/cli/schema/motebit-yaml-v1.json
  version: 1
  # ...
  ```

  New subcommand `motebit schema` emits the same schema to stdout for
  vendoring into air-gapped workspaces. Drift defense #21 regenerates the
  schema in-process on every test run and fails CI if the committed file
  has drifted from the zod source.

### Patch Changes

- 699ba41: Rewrite three fixed-group `@deprecated` annotations to the four-field
  contract from `docs/doctrine/deprecation-lifecycle.md`:
  `OLLAMA_SUGGESTED_MODELS` and `OllamaSuggestedModel` in `@motebit/sdk`,
  and `cli_private_key` on `motebit`'s `FullConfig` shape. Each marker
  now carries `since`, `removed in`, a replacement pointer, and a reason
  — downstream consumers see a consistent deprecation format across the
  entire fixed-group publish surface, and the planned
  `check-deprecation-discipline` drift gate has a clean starting line
  when it lands post-1.0.

  No behavior change — JSDoc-only edits.

- bce38b7: Complete the four-field-contract classification pass on every remaining
  `@deprecated` annotation in motebit's source: 14 markers across
  `@motebit/ai-core`, `@motebit/market`, `@motebit/mcp-client`,
  `services/api`, `apps/web`, and `apps/cli` now name `since`,
  `removed in`, replacement, and reason — matching the contract codified
  in `docs/doctrine/deprecation-lifecycle.md`.

  Two small takes-own-medicine fixes landed with the pass:
  `apps/desktop` dropped its re-export of the deprecated
  `OllamaDetectionResult` alias, and `services/api`'s federation-e2e
  tests migrated from the deprecated `PeerRateLimiter` alias to
  `FixedWindowLimiter` directly. The `authToken` field on
  `McpClientConfig` keeps its internal callers intentionally — the
  `StaticCredentialSource` wrapper is the documented deprecation-window
  bridge, matching the doctrine's "wrap + warn + strip at named sunset"
  pattern.

  No runtime behavior change. The post-1.0 `check-deprecation-discipline`
  drift gate (named in the doctrine) will scan a uniform shape across
  the entire codebase with no grandfathered exceptions.

- 9dc5421: Internal hygiene: migrate motebit's own callers off the `verifyIdentityFile`
  legacy shim (`@motebit/crypto`). Every `create-motebit` and `motebit` call
  site now uses the unified `verify()` dispatcher, so the fixed-group 1.0
  publish no longer ships code that consumes its own `@deprecated` API.

  The `verifyIdentityFile` and `LegacyVerifyResult` exports remain published
  from `@motebit/crypto` for external pre-0.4.0 consumers through the
  deprecation window, with their `@deprecated` annotations rewritten to the
  four-field contract (`since 1.0.0, removed in 2.0.0, Use verify(content)
instead, …reason`) required by `docs/doctrine/deprecation-lifecycle.md`.

- 1690469: Wire `BalanceWaiver` producer + verifier (spec/migration-v1.md §7.2). `@motebit/crypto` adds `signBalanceWaiver` / `verifyBalanceWaiver` / `BALANCE_WAIVER_SUITE` alongside the existing artifact signers; `@motebit/encryption` re-exports them so apps stay on the product-vocabulary surface. `@motebit/virtual-accounts` gains a `"waiver"` `TransactionType` so the debit carries a dedicated audit-trail category. The relay's `/migrate/depart` route now accepts an optional `balance_waiver` body — balance > 0 requires either a confirmed withdrawal (prior behavior) or a valid signed waiver for at least the current balance; the persisted waiver JSON is stored verbatim on the migration row for auditor reverification. The `motebit migrate` CLI gains a `--waive` flag that signs the waiver with the identity key and attaches it to the depart call, with a destructive-action confirmation prompt. Closes the one-pass-delivery gap left over from commit `7afce18c` (wire artifact without consumers).
- 3e8e7ec: Close H3 from the `cd70d3d8..HEAD` security audit — add a
  `transaction<T>(fn): T` primitive to `DatabaseDriver` and migrate the
  two raw-`BEGIN`/`ROLLBACK` call sites off hand-rolled strings.

  The prior pattern in `SqliteAccountStore.debitAndEnqueuePending` and
  in `buildCreditOnDepositCallback` issued `db.exec("BEGIN")` /
  `db.exec("COMMIT")` / `db.exec("ROLLBACK")` directly. That's brittle
  under nesting (a second BEGIN throws), under ROLLBACK-after-BEGIN-fail
  (masks the original error), and under driver swap (sql.js has no
  native helper; better-sqlite3 does).

  The new primitive lives at the persistence boundary — one layer below
  `@motebit/virtual-accounts`'s `AccountStore`, where the rule
  "no `withTransaction(fn)` on the ledger interface" still stands.
  Services that need multi-statement atomicity no longer reinvent
  BEGIN/COMMIT.

  Driver implementations:
  - **BetterSqliteDriver** delegates to native `inner.transaction(fn)()`,
    which handles savepoint-based nesting automatically.
  - **SqlJsDriver** runs `BEGIN`/`COMMIT`/`ROLLBACK` on the outer call
    and `SAVEPOINT`/`RELEASE`/`ROLLBACK TO` for nested calls, matching
    the better-sqlite3 shape exactly.

  Call-site migration:
  - `SqliteAccountStore.debitAndEnqueuePending`: wraps the three-statement
    debit + ledger + pending insert in `db.transaction`. The
    insufficient-funds path now returns `null` from the fn (empty
    transaction commits harmlessly); any other throw rolls back.
  - `buildCreditOnDepositCallback` in `services/api/src/deposit-detector.ts`:
    same shape — the credit + dedup-insert pair runs inside `db.transaction`.

  Tests: 10 new in `packages/persistence/src/__tests__/transaction.test.ts`
  covering commit-on-return, rollback-on-throw, null-return semantics,
  nesting (inner throw vs outer throw), and sequential top-level
  independence. Exercised against **both** driver implementations. All
  862 services/api tests and 165 persistence tests still pass. 15 drift
  gates green.

- c3a3e7d: Narrow the fail-open surface in `SqliteAccountStore.getUnwithdrawableHold`
  and `getSweepConfig` (H2 from the `cd70d3d8..HEAD` security audit).

  Before this change, both methods wrapped the real query in a bare
  `try/catch` that returned `0` (no hold) or the null sweep pair on ANY
  SQL error — schema drift, DB locked, malformed state, anything — not
  only the "table absent in minimal test setups" case the comment
  claimed. That opens a withdrawal path the dispute window is supposed
  to gate. Silent money-path fallbacks violate the root `CLAUDE.md`
  fail-closed doctrine ("Deny on error").

  The new shape probes `sqlite_master` explicitly for the expected
  tables before running the real query:
  - **Tables missing** (test setups that skip those migrations) →
    degraded mode preserved (0 / null-pair).
  - **Tables present** → the real query runs unhedged; any error
    propagates to the caller, which is what the withdrawal path needs
    to refuse loudly.

  `scripts/check-deps.ts` gains an `isAutoGenerated(file)` helper that
  skips committed `AUTO-GENERATED` files for both the license-in-source
  check (existing) and the undeclared-deps check (new) — the
  `@motebit/self-knowledge` corpus embeds README code fences containing
  verbatim `import` strings that the regex-based scanner would
  otherwise flag.

  10 new regression tests in
  `services/api/src/__tests__/account-store-fail-closed.test.ts` pin the
  three branches via a mock `DatabaseDriver`: missing-tables degraded
  mode, happy-path real-query execution, and error propagation. The
  existing 7 `withdrawal-hold.test.ts` assertions are unchanged and
  still pass.

- 28c46dd: `getPublicKeyBySuite(privateKey, suite)` — new permissive-floor (Apache-2.0) primitive for suite-dispatched public-key derivation. Closes a real protocol-primitive-blindness violation in the CLI and plugs the regex hole that let it slip past `check-suite-dispatch`.

  A surface-parity audit on 2026-04-18 found that `apps/cli/src/subcommands/delegate.ts` was calling `ed.getPublicKeyAsync(privateKey)` directly via dynamic import — protocol-primitive-blindness as defined in `feedback_protocol_primitive_blindness.md` and the `@motebit/crypto/CLAUDE.md` Rule 1 ("`src/suite-dispatch.ts` is the ONLY file permitted to call `@noble/ed25519` primitives directly"). The violation slipped past `check-suite-dispatch` because its FORBIDDEN_PATTERNS regex `/\bed\.getPublicKey\b/` does not match `ed.getPublicKeyAsync` — `\b` requires a word/non-word transition, and `K` followed by `A` (both word chars) is not a boundary.

  This pass:
  - **`getPublicKeyBySuite(privateKey: Uint8Array, suite: SuiteId): Promise<Uint8Array>`** added to `packages/crypto/src/suite-dispatch.ts`. Sibling to `verifyBySuite` / `signBySuite` / `generateEd25519Keypair` — same exhaustive switch on the `SuiteId` literal union so the TypeScript compiler refuses to compile when ML-DSA / SLH-DSA suites land without an explicit arm. Re-exported through `signing.ts` so it surfaces from `@motebit/crypto`.
  - **Permissive export allowlist updated.** `getPublicKeyBySuite` added to `PERMISSIVE_ALLOWED_FUNCTIONS["@motebit/crypto"]` in `scripts/check-deps.ts`.
  - **CLI delegate path routed through the dispatcher.** `apps/cli/src/subcommands/delegate.ts` now imports `getPublicKeyBySuite` from `@motebit/crypto` instead of dynamically importing `@noble/ed25519`. PQ-ready by construction — when ML-DSA suites land, only the dispatcher arm changes. `apps/cli/package.json` declares `@motebit/crypto` directly (was previously consumed only transitively through `@motebit/runtime`).
  - **Regex hole patched.** `scripts/check-suite-dispatch.ts` adds `\bed\.getPublicKeyAsync\b` to FORBIDDEN_PATTERNS and tightens the existing `\bed\.getPublicKey\b` to `\b...\b(?!Async)` matching the established convention used by `verify` / `sign` (every primitive name has both a sync rule and an explicit Async rule). The next time anyone tries to call `ed.getPublicKeyAsync` outside the dispatcher, CI fails immediately.

  The Ring 1 doctrine ("capability, not form") is unchanged — surfaces correctly continue to consume crypto through `@motebit/encryption` (which re-exports from `@motebit/crypto`) where appropriate. Adding `check-surface-primitives` to mandate dep declarations was considered and rejected: the existing `check-suite-dispatch` already covers the real failure mode (direct `@noble` calls); the dep-declaration question is style, not architecture.

- a792355: Close the idempotency contract on `debitAndEnqueuePending`.

  The `AccountStore.debitAndEnqueuePending` interface documented an
  idempotency key for "external replay protection" that neither
  implementation honored — a second call with the same `(motebitId,
idempotencyKey)` would silently debit the account a second time and
  insert a duplicate `relay_pending_withdrawals` row. The parameter was
  live wiring (plumbed through `enqueuePendingWithdrawal` and the sweep
  loop) waiting for a consumer to discover the gap.

  Fix mirrors the sibling `requestWithdrawal` + `insertWithdrawal`
  pattern that already exists for user-initiated withdrawals: a replay
  pre-check inside the compound primitive, plus a schema-level partial
  UNIQUE INDEX as belt-and-suspenders.
  - `packages/virtual-accounts`: both `InMemoryAccountStore` and the
    interface contract doc describe the replay semantics — on
    `idempotencyKey !== null` match, return the existing `pendingId` and
    current balance without debiting or inserting again. `null` keys are
    never deduplicated.
  - `services/api`: `SqliteAccountStore.debitAndEnqueuePending` gains the
    same pre-check. Migration v12 adds
    `idx_pending_withdrawals_idempotency` — a partial UNIQUE INDEX on
    `(motebit_id, idempotency_key) WHERE idempotency_key IS NOT NULL` —
    so a direct INSERT that skips the primitive still hits the guard.
    Mirrors `idx_relay_withdrawals_idempotency` byte-for-byte.

- c757777: Rename `createGoalsController` / `GoalsController` / `GoalsControllerDeps` in
  `@motebit/runtime` to `createGoalsEmitter` / `GoalsEmitter` / `GoalsEmitterDeps`.

  The runtime's goals primitive is a goal-lifecycle event emitter — it authors
  `goal_*` events against the event log. The previous name collided with the
  completely different `createGoalsController` in `@motebit/panels`, which is a
  subscribable UI state machine for rendering a goals panel. Two functions with
  the same name, same return-type name, different signatures, different
  semantics, different layers.

  The panels pattern (`createSovereignController`, `createAgentsController`,
  `createMemoryController`, `createGoalsController`) is a consistent 4-family
  UI-state-controller convention and should keep its name. The runtime primitive
  is the outlier; renamed to reflect its actual role (an emitter, which is also
  how it is already described in the `runtime.goals` doc comment and in
  `spec/goal-lifecycle-v1.md §9`).

  ### Migration

  ```ts
  // before
  import { createGoalsController, type GoalsController } from "@motebit/runtime";
  // after
  import { createGoalsEmitter, type GoalsEmitter } from "@motebit/runtime";
  ```

  `runtime.goals` retains the same type shape (only the name changed).
  No wire-format or event-log impact; this is a type-surface rename only.
  `@motebit/panels` exports are unchanged.

- be2dba3: Add Tavily as an agent-tuned primary search provider in `@motebit/tools`
  and slot it at the head of the `services/web-search` fallback chain.

  Motivation: generic open-web indexes (Brave, DuckDuckGo) rank by
  backlink density and ad-supported signals. For niche or new domains —
  like first-party content on motebit.com today — recall is
  disproportionately poor. The three-tier answer engine already biases
  self-queries via `BiasedSearchProvider`, but the underlying index
  matters once the query escapes first-party domains. Tavily is tuned
  for agent RAG: structured JSON response, no HTML to parse, ranking
  designed around what an agent actually reads.

  Provider chain after this change, in `services/web-search`:

  BiasedSearchProvider
  └─ FallbackSearchProvider
  ├─ Tavily (if TAVILY_API_KEY set — primary)
  ├─ Brave (if BRAVE_SEARCH_API_KEY set — fallback)
  └─ DuckDuckGo (always — last resort)

  Each tier is opt-in via env var; a deploy with neither paid key runs
  on DuckDuckGo alone. No interface change on `SearchProvider`, so the
  relay's browser-side `ProxySearchProvider` sees the upgrade transparently.

  Package surface:
  - `TavilySearchProvider` + `TavilySearchProviderOptions` exported from
    `@motebit/tools` root and `@motebit/tools/web-safe`.
  - Constructor accepts an injected `fetch` for tests; defaults to
    `globalThis.fetch`.
  - Constructor accepts `searchDepth: "basic" | "advanced"` (default
    "basic"). `include_answer` is forced off — synthesis happens in
    `services/research`, not in the provider.

  Tests: 9 in `packages/tools/src/providers/__tests__/tavily-search.test.ts`
  covering wire shape (POST + body fields), searchDepth override,
  content→snippet mapping, defensive filtering of incomplete results,
  empty responses, HTTP error propagation (401 / 429 / large-body
  truncation), and fetch-level network errors. Service wiring in
  `services/web-search/src/index.ts` reorders the chain Tavily →
  Brave → DuckDuckGo, `.env.example` documents the new var.

  All 151 @motebit/tools tests + 15 drift gates pass.

- 1e07df5: Ship `@motebit/verifier` — offline third-party verifier for every signed Motebit artifact (identity files, execution receipts, W3C verifiable credentials, presentations). Exposes `verifyFile` / `verifyArtifact` / `formatHuman` as a library and the `motebit-verify` CLI with POSIX exit codes (0 valid · 1 invalid · 2 usage/IO). Zero network, zero deps beyond `@motebit/crypto`. Joins the fixed public-surface version group.

## 0.8.0

### Minor Changes

- b231e9c: MIT/BSL protocol boundary, credential anchoring, unified Solana anchoring
  - **@motebit/crypto** — new package (replaces @motebit/verify). First npm publish. Sign and verify all artifacts with zero runtime deps. New: `computeCredentialLeaf`, `verifyCredentialAnchor` (4-step self-verification).
  - **@motebit/protocol** — new types: `CredentialAnchorBatch`, `CredentialAnchorProof`, `ChainAnchorSubmitter`, `CredentialChainAnchor`. Semiring algebra moved to MIT.
  - **@motebit/sdk** — re-exports new protocol types.
  - **create-motebit** — no API changes.
  - **motebit** — sovereign delegation (`--sovereign` flag), credential anchoring admin panel, unified Solana anchoring for settlement + credential streams.

  New specs: settlement@1.0, auth-token@1.0, credential-anchor@1.0, delegation@1.0 (4 new, 9 total).

## 0.7.0

### Minor Changes

- 9b6a317: Move trust algebra from MIT sdk to BSL semiring — enforce IP boundary.

  **Breaking:** The following exports have been removed from `@motebit/sdk`:
  - `trustLevelToScore`, `trustAdd`, `trustMultiply`, `composeTrustChain`, `joinParallelRoutes`
  - `evaluateTrustTransition`, `composeDelegationTrust`
  - `TRUST_LEVEL_SCORES`, `DEFAULT_TRUST_THRESHOLDS`, `TRUST_ZERO`, `TRUST_ONE`

  These are trust algebra algorithms that belong in the BSL-licensed runtime, not the MIT-licensed type vocabulary. Type definitions (`TrustTransitionThresholds`, `DelegationReceiptLike`, `AgentTrustLevel`, `AgentTrustRecord`) remain in the SDK unchanged.

  Also adds CI enforcement (checks 9-10 in check-deps) preventing algorithm code from leaking into MIT packages in the future.

### Patch Changes

- Typed relay errors, storage parity, deletion policy, dead code cleanup.
  - Wire `SettlementError` and `FederationError` into relay paths (previously generic `Error`)
  - Pluggable logger in sync-engine encrypted adapter (replaces `console.warn`)
  - Scope knip to external deps (`@motebit/*` excluded from dead-code analysis)
  - Remove dead `@noble/ciphers` (Web Crypto API replaced it)
  - Remove dead code: `termWidth`, web error banner cluster (JS + CSS + HTML)
  - Encode deletion policy as architectural invariant in CLAUDE.md
  - Full storage parity: all surfaces wire complete `StorageAdapters` interface
  - Mark `verifyIdentityFile()` as deprecated in verify README
  - Override `@xmldom/xmldom` to >=0.8.12 (GHSA-wh4c-j3r5-mjhp)

## 0.6.11

### Patch Changes

- [`4f40061`](https://github.com/motebit/motebit/commit/4f40061bdd13598e3bf8d95835106e606cd8bb17) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`0cf07ea`](https://github.com/motebit/motebit/commit/0cf07ea7fec3543b041edd2e793abee75180f9e9) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`49d8037`](https://github.com/motebit/motebit/commit/49d8037a5ed45634c040a74206f57117fdb69842) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.6.10

### Patch Changes

- [`d64c5ce`](https://github.com/motebit/motebit/commit/d64c5ce0ae51a8a78578f49cfce854f9b5156470) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`ae0b006`](https://github.com/motebit/motebit/commit/ae0b006bf8a0ec699de722efb471d8a9003edd61) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`94f716d`](https://github.com/motebit/motebit/commit/94f716db4b7b25fed93bb989a2235a1d5efa1421) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`fc765f6`](https://github.com/motebit/motebit/commit/fc765f68f104abafe17754d0e82290e03cae1440) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`d1607ac`](https://github.com/motebit/motebit/commit/d1607ac9da58da7644bd769a95253bd474bcfe3f) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`6907bba`](https://github.com/motebit/motebit/commit/6907bba938c4eaa340b7d3fae7eb0b36a8694c6f) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`067bc39`](https://github.com/motebit/motebit/commit/067bc39401ae91a183fe184c5674a0a563bc59c0) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`3ce137d`](https://github.com/motebit/motebit/commit/3ce137da4efbac69262a1a61a79486989342672f) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`d2f39be`](https://github.com/motebit/motebit/commit/d2f39be1a5e5b8b93418e043fb9b9e3aecc63c05) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`2273ac5`](https://github.com/motebit/motebit/commit/2273ac5581e62d696676eeeb36aee7ca70739df7) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`e3d5022`](https://github.com/motebit/motebit/commit/e3d5022d3a2f34cd90a7c9d0a12197a101f02052) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`dc8ccfc`](https://github.com/motebit/motebit/commit/dc8ccfcb51577498cbbaaa4cf927d7e1a10add26) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`587cbb8`](https://github.com/motebit/motebit/commit/587cbb80ea84581392f2b65b79588ac48fa8ff72) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`21aeecc`](https://github.com/motebit/motebit/commit/21aeecc30a70a8358ebb7ff416a9822baf1fbb17) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`ac2db0b`](https://github.com/motebit/motebit/commit/ac2db0b18fd83c3261e2a976e962b432b1d0d4a9) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`b63c6b8`](https://github.com/motebit/motebit/commit/b63c6b8efcf261e56f84754312d51c8c917cf647) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`fc765f6`](https://github.com/motebit/motebit/commit/fc765f68f104abafe17754d0e82290e03cae1440) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.6.9

### Patch Changes

- [`0563a0b`](https://github.com/motebit/motebit/commit/0563a0bb505583df75766fcbfc2c9a49295f309e) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.6.8

### Patch Changes

- [`6df1778`](https://github.com/motebit/motebit/commit/6df1778caec68bc47aeeaa00cae9ee98631896f9) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`c8928d6`](https://github.com/motebit/motebit/commit/c8928d6e700918fa3ea2bce8714a72eb5d4bfc80) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`c8928d6`](https://github.com/motebit/motebit/commit/c8928d6e700918fa3ea2bce8714a72eb5d4bfc80) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`c8928d6`](https://github.com/motebit/motebit/commit/c8928d6e700918fa3ea2bce8714a72eb5d4bfc80) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`4ae74fe`](https://github.com/motebit/motebit/commit/4ae74fefb4c2f249deafe044052d53c8679c2bf4) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`4ae74fe`](https://github.com/motebit/motebit/commit/4ae74fefb4c2f249deafe044052d53c8679c2bf4) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`c8928d6`](https://github.com/motebit/motebit/commit/c8928d6e700918fa3ea2bce8714a72eb5d4bfc80) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.6.7

### Patch Changes

- [`62cda1c`](https://github.com/motebit/motebit/commit/62cda1cca70562f2f54de6649eae070548a97389) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.6.6

### Patch Changes

- [`349939f`](https://github.com/motebit/motebit/commit/349939f7533ac2a73ef99cf4cc2413cd78849ce7) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`349939f`](https://github.com/motebit/motebit/commit/349939f7533ac2a73ef99cf4cc2413cd78849ce7) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.6.5

### Patch Changes

- [`e3173f0`](https://github.com/motebit/motebit/commit/e3173f0de119d4c0dd3fbe91de185f075ad0df99) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.6.4

### Patch Changes

- [`a58cc9a`](https://github.com/motebit/motebit/commit/a58cc9a6e79fc874151cb7044b4846acd855fbb2) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.6.3

### Patch Changes

- [`15a81c5`](https://github.com/motebit/motebit/commit/15a81c5d4598cacd551b3024db49efb67455de94) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`8899fcd`](https://github.com/motebit/motebit/commit/8899fcd55def04c9f2b6e34a182ed1aa8c59bf71) Thanks [@hakimlabs](https://github.com/hakimlabs)! - Wrong passphrase: calm reset guide instead of jargon error

## 0.6.2

### Patch Changes

- [`f246433`](https://github.com/motebit/motebit/commit/f2464332f3ec068aeb539202bd32f081b23c35b0) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`4a152f0`](https://github.com/motebit/motebit/commit/4a152f029f98145778a2e84b46b379fa811874cb) Thanks [@hakimlabs](https://github.com/hakimlabs)! - First-launch passphrase: explain identity before prompting

## 0.6.1

### Patch Changes

- [`1bdd3ae`](https://github.com/motebit/motebit/commit/1bdd3ae35d2d7464dce1677d07af39f5b0026ba1) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`2c5a6a9`](https://github.com/motebit/motebit/commit/2c5a6a98754a625db8c13bc0b5a686e5198de34d) Thanks [@hakimlabs](https://github.com/hakimlabs)! - First-run UX: calm setup guide instead of raw API key error

## 0.6.0

### Minor Changes

- [`ca36ef3`](https://github.com/motebit/motebit/commit/ca36ef3d686746263ac0216c7f6e72a63248cc12) Thanks [@hakimlabs](https://github.com/hakimlabs)! - v0.6.0: zero-dep verify, memory calibration, CLI republish
  - @motebit/sdk: Core types for the motebit protocol — state vectors, identity, memory, policy, tools, agent delegation, trust algebra, execution ledger, credentials. Zero deps, MIT
  - @motebit/crypto: Verify any motebit artifact — identity files, execution receipts, verifiable credentials, presentations. One function, zero runtime deps (noble bundled), MIT
  - create-motebit: Scaffold signed identity and runnable agent projects. Key rotation with signed succession. --agent mode for MCP-served agents. Zero runtime deps, MIT
  - motebit: Operator console — REPL, daemon, MCP server mode, delegation, identity export/verify/rotate, credential management, budget/settlement. BSL-1.1 (converts to Apache-2.0)
  - Memory system: calibrated tagging prompt, consolidation dedup (REINFORCE no longer creates nodes), self-referential filter, valid_until display filtering across all surfaces
  - Empty-response guard: re-prompt when tag stripping yields no visible text after tool calls
  - Governor fix: candidate modifications (confidence cap, sensitivity reclassification) now respected in turn loop

## 0.5.3

### Patch Changes

- [`268033b`](https://github.com/motebit/motebit/commit/268033b7c7163949ab2510a7d599f60b5279009b) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`8efad8d`](https://github.com/motebit/motebit/commit/8efad8d77a5c537df3866771e28a9123930cf3f8) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`61eca71`](https://github.com/motebit/motebit/commit/61eca719ab4c6478be62fb9d050bdb8a56c8fc88) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`cb26e1d`](https://github.com/motebit/motebit/commit/cb26e1d5848d69e920b59d903c8ccdd459434a6f) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`758efc2`](https://github.com/motebit/motebit/commit/758efc2f29f975aedef04fa8b690e3f198d093e3) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`95c69f1`](https://github.com/motebit/motebit/commit/95c69f1ecd3a024bb9eaa321bd216a681a52d69c) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`c3e76c9`](https://github.com/motebit/motebit/commit/c3e76c9d375fc7f8dc541d514c4d5c8812ee63ff) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`518eaf1`](https://github.com/motebit/motebit/commit/518eaf1f30beab0bd0cad741dfb0d4fb186f5027) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`8eecda1`](https://github.com/motebit/motebit/commit/8eecda1fa7dc087ecaef5f9fdccd8810b77d5170) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`03b3616`](https://github.com/motebit/motebit/commit/03b3616cda615a2239bf8d18d755e0dab6a66a1a) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`ed84cc3`](https://github.com/motebit/motebit/commit/ed84cc332a24b592129160ab7d95e490f26a237f) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`518eaf1`](https://github.com/motebit/motebit/commit/518eaf1f30beab0bd0cad741dfb0d4fb186f5027) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`ba2140f`](https://github.com/motebit/motebit/commit/ba2140f5f8b8ce760c5b526537b52165c08fcd64) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`e8643b0`](https://github.com/motebit/motebit/commit/e8643b00eda79cbb373819f40f29008346b190c8) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`6fa9d8f`](https://github.com/motebit/motebit/commit/6fa9d8f87a4d356ecb280c513ab30648fe02af50) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`10226f8`](https://github.com/motebit/motebit/commit/10226f809c17d45bd8a785a0a62021a44a287671) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`0624e99`](https://github.com/motebit/motebit/commit/0624e99490e313f33bd532eadecbab7edbd5f2cf) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`c4646b5`](https://github.com/motebit/motebit/commit/c4646b5dd382465bba72251e1a2c2e219ab6d7b4) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`0605dfa`](https://github.com/motebit/motebit/commit/0605dfae8e1644b84227d386863ecf5afdb18b87) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`c832ce2`](https://github.com/motebit/motebit/commit/c832ce2155959ef06658c90fd9d7dc97257833fa) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`813ff2e`](https://github.com/motebit/motebit/commit/813ff2e45a0d91193b104c0dac494bf814e68f6e) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`35d92d0`](https://github.com/motebit/motebit/commit/35d92d04cb6b7647ff679ac6acb8be283d21a546) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`b8f7871`](https://github.com/motebit/motebit/commit/b8f78711734776154fa723cbb4a651bcb2b7018d) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`916c335`](https://github.com/motebit/motebit/commit/916c3354f82caf55e2757e4519e38a872bc8e72a) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`401e814`](https://github.com/motebit/motebit/commit/401e8141152eafa67fc8877d8268b02ba41b8462) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`70986c8`](https://github.com/motebit/motebit/commit/70986c81896c337d99d3da8b22dff3eb3df0a52c) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`8632e1d`](https://github.com/motebit/motebit/commit/8632e1d74fdb261704026c4763e06cec54a17dba) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`5427d52`](https://github.com/motebit/motebit/commit/5427d523d7a8232b26e341d0a600ab97b190b6cf) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`78dfb4f`](https://github.com/motebit/motebit/commit/78dfb4f7cfed6c487cb8113cee33c97a3d5d608c) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`dda8a9c`](https://github.com/motebit/motebit/commit/dda8a9cb605a1ceb25d81869825f73077c48710c) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`dd2f93b`](https://github.com/motebit/motebit/commit/dd2f93bcacd99439e2c6d7fb149c7bfdf6dcb28b) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.5.2

### Patch Changes

- [`daa55b6`](https://github.com/motebit/motebit/commit/daa55b623082912eb2a7559911bccb9a9de7052f) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`1d06551`](https://github.com/motebit/motebit/commit/1d06551bff646336aa369b3c126bbd40aa13b806) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`1d06551`](https://github.com/motebit/motebit/commit/1d06551bff646336aa369b3c126bbd40aa13b806) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`fd9c3bd`](https://github.com/motebit/motebit/commit/fd9c3bd496c67394558e608c89af2b43df005fdc) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`5d285a3`](https://github.com/motebit/motebit/commit/5d285a32108f97b7ce69ef70ea05b4a53d324c64) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`54f846d`](https://github.com/motebit/motebit/commit/54f846d066c416db4640835f8f70a4eedaca08e0) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`2b9512c`](https://github.com/motebit/motebit/commit/2b9512c8ba65bde88311ee99ea6af8febed83fe8) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`2ecd003`](https://github.com/motebit/motebit/commit/2ecd003cdb451b1c47ead39e945898534909e8b1) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`fd24d60`](https://github.com/motebit/motebit/commit/fd24d602cbbaf668b65ab7e1c2bcef5da66ed5de) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`7cc64a9`](https://github.com/motebit/motebit/commit/7cc64a90bccbb3ddb8ba742cb0c509c304187879) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`5653383`](https://github.com/motebit/motebit/commit/565338387f321717630f154771d81c3fc608880c) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`753e7f2`](https://github.com/motebit/motebit/commit/753e7f2908965205432330c7f17a93683644d719) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`10a4764`](https://github.com/motebit/motebit/commit/10a4764cd35b74bf828c31d07ece62830bc047b2) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.5.1

### Patch Changes

- [`9cd8d46`](https://github.com/motebit/motebit/commit/9cd8d4659f8e9b45bf8182f5147e37ccda304606) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`d7ca110`](https://github.com/motebit/motebit/commit/d7ca11015e1194c58f7a30d653b2e6a9df93149e) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`48d2165`](https://github.com/motebit/motebit/commit/48d21653416498f2ff83ea7ba570cc9254a4d29b) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`f275b4c`](https://github.com/motebit/motebit/commit/f275b4cccfa4c72e58baf595a8abc231882a13fc) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`8707f90`](https://github.com/motebit/motebit/commit/8707f9019d5bbcaa7ee7013afc3ce8061556245f) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`a20eddd`](https://github.com/motebit/motebit/commit/a20eddd579b47dda7a0f75903dfd966083edb1ea) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`8eef02c`](https://github.com/motebit/motebit/commit/8eef02c777ae6e00ca58f0d0bf92011463d4d3e7) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`a742b1e`](https://github.com/motebit/motebit/commit/a742b1e762a97e520633083d669df2affa132ddf) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`04b9038`](https://github.com/motebit/motebit/commit/04b9038d23dcadec083ae970d4c05b2f3ce27c3f) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`bfafe4d`](https://github.com/motebit/motebit/commit/bfafe4d72a5854db551888a4264058255078eab1) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`527c672`](https://github.com/motebit/motebit/commit/527c672e43b6f389259413f440fb3510fa9e1de0) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

All notable changes to the `motebit` CLI are documented here. For full project history, see the [root changelog](../../CHANGELOG.md).

## [0.3.0] - 2026-03-13

### Added

- `motebit id` subcommand — display identity card (motebit_id, did:key, public key, device)
- `motebit credentials` subcommand — list and inspect W3C Verifiable Credentials
- `motebit ledger <goalId>` subcommand — view execution ledger for a goal
- `/graph` command — memory graph health summary
- `/curious` command — show fading memories the agent has noticed
- `/agents` enhanced — trust levels, Beta-binomial reputation, task history
- Intelligence gradient display in `/state`
- Curiosity-driven memory maintenance during conversations
- `motebit export` expanded — writes full bundle directory (identity + credentials + presentation + budget + gradient)
- `motebit verify <dir>` expanded — validates identity files, VC proofs, VP integrity, and bundle cross-references

## [0.2.0] - 2026-03-10

### Added

- Published to npm as `motebit`
- REPL chat, daemon mode, operator console, MCP server mode
- Subcommands: `id`, `export`, `verify`, `run`, `goal`, `approvals`
- Slash commands: `/model`, `/memories`, `/graph`, `/curious`, `/state`, `/forget`, `/export`, `/sync`, `/clear`, `/tools`, `/mcp`, `/agents`, `/operator`, `/help`, `/summarize`, `/conversations`, `/conversation`, `/goals`, `/goal`, `/approvals`, `/reflect`, `/discover`
- MCP server mode (`motebit --serve`) with stdio and HTTP transport
