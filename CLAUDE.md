# Motebit

A motebit is a droplet of intelligence under surface tension. You own the identity. The intelligence is pluggable. The body is yours.

The body is passive. The interior is active. Memory, trust, identity, tool use are interior structures. The policy gate, the privacy layer, the governance are the surface tension. Maximum interiority, minimum display.

See [`DOCTRINE.md`](DOCTRINE.md) for the foundational derivation chain — nine documents from droplet physics through sovereign interior, metabolic boundary, and self-signing body to multi-agent conferencing. Every decision traces to droplet physics or it doesn't belong.

## The three things no one else is building together

1. **Persistent sovereign identity** — a cryptographic entity across time and devices, not a session token
2. **Accumulated trust** — memory, state history, audit trails that make the agent more capable the longer it runs
3. **Governance at the boundary** — sensitivity-aware privacy and policy controlling what crosses the surface

MCP defines capability but not identity. A2A defines communication but has no trust accumulation. x402/AP2 defines payment but has no identity. Motebit is the missing layer underneath. The relay bridges all four at a single economic checkpoint — identity resolved, execution verified, money finalized.

## Architecture

pnpm monorepo, Turborepo, TypeScript. Node ≥ 20, pnpm 9.15. 50 packages on a 7-layer DAG enforced by `pnpm check-deps`. 5 surfaces + 5 supporting apps, 8 services, 24 open protocol specs.

Layout and per-package roles: [`README.md`](README.md), [`apps/docs/content/docs/operator/architecture.mdx`](apps/docs/content/docs/operator/architecture.mdx) (canonical; enforced by `check-docs-tree`).

Per-directory doctrine loads lazily (every sub-`CLAUDE.md` must appear here; enforced by `check-claude-md`):

- [`packages/protocol/CLAUDE.md`](packages/protocol/CLAUDE.md) — permissive-floor purity, types/algebra only
- [`packages/sdk/CLAUDE.md`](packages/sdk/CLAUDE.md) — stable developer-contract surface; independent semver from the protocol
- [`packages/crypto/CLAUDE.md`](packages/crypto/CLAUDE.md) — suite-dispatch is the only Ed25519 caller
- [`packages/wire-schemas/CLAUDE.md`](packages/wire-schemas/CLAUDE.md) — BSL zod sources; generates committed JSON Schemas into the Apache-2.0 `spec/schemas/` tree
- [`packages/crypto-appattest/CLAUDE.md`](packages/crypto-appattest/CLAUDE.md) — iOS App Attest chain verifier; pinned Apple root, injected at call site
- [`packages/crypto-android-keystore/CLAUDE.md`](packages/crypto-android-keystore/CLAUDE.md) — Android Hardware-Backed Keystore Attestation verifier; pinned Google roots (RSA + ECDSA P-384); the canonical sovereign-verifiable Android primitive (replaces the removed `crypto-play-integrity`)
- [`packages/crypto-tpm/CLAUDE.md`](packages/crypto-tpm/CLAUDE.md) — Windows / Linux TPM 2.0 EK chain verifier; pinned vendor roots, injected at call site
- [`packages/crypto-webauthn/CLAUDE.md`](packages/crypto-webauthn/CLAUDE.md) — WebAuthn platform-authenticator packed-attestation verifier; pinned FIDO roots (Apple, Yubico, Microsoft)
- [`packages/verify/CLAUDE.md`](packages/verify/CLAUDE.md) — canonical `motebit-verify` CLI; Apache-2.0 aggregator that bundles the canonical Apache-2.0 platform leaves with motebit-canonical defaults
- [`packages/state-export-client/CLAUDE.md`](packages/state-export-client/CLAUDE.md) — browser-safe verifier for `X-Motebit-Content-Manifest`; trust-on-first-use bootstrap from `/.well-known/motebit-transparency.json`; the consumer-side counterpart to the relay's state-export-signed producer surface
- [`packages/circuit-breaker/CLAUDE.md`](packages/circuit-breaker/CLAUDE.md) — per-peer three-state engine, no I/O, injected clock
- [`packages/evm-rpc/CLAUDE.md`](packages/evm-rpc/CLAUDE.md) — JSON-RPC behind a motebit-shaped interface; one error shape out
- [`packages/deposit-detector/CLAUDE.md`](packages/deposit-detector/CLAUDE.md) — single `eth_getLogs` per cycle; dedup is the consumer's atomic write
- [`packages/treasury-reconciliation/CLAUDE.md`](packages/treasury-reconciliation/CLAUDE.md) — operator-treasury observability for relay-mediated x402 fees; recorded-fee-sum vs onchain `balanceOf` comparison; sibling of deposit-detector but watches the operator's fee-collection address, never an agent wallet (must not unify)
- [`packages/virtual-accounts/CLAUDE.md`](packages/virtual-accounts/CLAUDE.md) — per-motebit ledger in micro-units; atomic credit/debit
- [`packages/settlement-rails/CLAUDE.md`](packages/settlement-rails/CLAUDE.md) — three guest rails + registry; custody split at the type level
- [`packages/wallet-solana/CLAUDE.md`](packages/wallet-solana/CLAUDE.md) — sovereign rail, identity key = address
- [`packages/self-knowledge/CLAUDE.md`](packages/self-knowledge/CLAUDE.md) — committed BM25 corpus over self-description docs; zero runtime deps
- [`packages/skills/CLAUDE.md`](packages/skills/CLAUDE.md) — agentskills.io-compatible procedural-knowledge runtime; install permissive, auto-load provenance-gated, sensitivity orthogonal to provenance
- [`packages/mcp-client/CLAUDE.md`](packages/mcp-client/CLAUDE.md) — `CredentialSource`, `ServerVerifier`, OAuth
- [`packages/panels/CLAUDE.md`](packages/panels/CLAUDE.md) — surface-agnostic panel controllers; state+actions here, render per surface
- [`services/relay/CLAUDE.md`](services/relay/CLAUDE.md) — the relay
- [`apps/spatial/CLAUDE.md`](apps/spatial/CLAUDE.md) — proto AR-glasses companion; five primitives (creature, satellite, environment, attractor, presentation), never disconnected window-manager panels

Cross-cutting doctrine (read on demand):

- [`docs/doctrine/protocol-primacy.md`](docs/doctrine/protocol-primacy.md) — **constitutional invariant**: motebit is a protocol with a company on top, not a company with a protocol on the side. The protocol functions identically whether the user pays motebit-cloud, brings their own keys, or runs on-device. Motebit-cloud sells convenience-margin on a substrate that works without it. Five other doctrines ([`protocol-model`](docs/doctrine/protocol-model.md), [`agility-as-role`](docs/doctrine/agility-as-role.md), [`relay/CLAUDE.md` rule 6](services/relay/CLAUDE.md), and memory anchors `strategy_open_source_moat` + `feedback_sovereignty_orthogonal` + `feedback_intelligence_commodity`) encode this principle from different angles. The protocol-first audit ("does this work identically for a user who never subscribes?") gates every business-side artifact — pitch language, tier descriptions, motebit-cloud feature proposals
- [`docs/doctrine/receipts-unified.md`](docs/doctrine/receipts-unified.md) — three receipt types (`ExecutionReceipt`, `ToolInvocationReceipt`, `ContentArtifactManifest`) form one family unified by JCS+Ed25519+suite-dispatch+independent-verification-via-`@motebit/verifier`. Different signers (agent vs relay), different granularity (per-call / per-task / per-bundle), different attestation roles — three types so the trust boundary stays compile-time-enforceable. The discoverability surface is this doctrine; the `@motebit/receipts` facade package is deferred to a real-consumer trigger
- [`docs/doctrine/delegation.md`](docs/doctrine/delegation.md) — delegation is the architectural connector that turns identity / trust / receipts / settlement / policy from a catalog of static primitives into a dynamic system. Two layers of invariants: cryptographic (Ed25519-signed via `SuiteId` registry + JCS-canonicalized + independently verifiable via `@motebit/verifier`) and semantic (scope-bounded via canonical capability vocabulary + time-bounded via TTL → terminal `expired` state + chain-traceable to max depth 10 with per-hop settlement). Motebit's delegation differs from OAuth/SSO: auth root is the user's `MotebitId` keypair (not a platform issuer), revocation is by the user (not the platform), chains terminate at sovereign identity (not platform auth server), delegations survive vendor switches. This is the moat in cryptographic form — incumbents can't replicate without dismantling their own business per `protocol-primacy.md`. Tagline word that should replace "permissions" in motebit's positioning sentence
- [`docs/doctrine/protocol-model.md`](docs/doctrine/protocol-model.md) — permissive-floor / BSL / accumulated-state, cryptosuite agility
- [`docs/doctrine/agility-as-role.md`](docs/doctrine/agility-as-role.md) — name the role in code/gates/types; treat the instance as a registry entry; migration is a registry append, not a wire-format break or codebase rewrite. Three instances: cryptosuite (`SuiteId`), license-floor ("permissive floor"), settlement-rail (`GuestRail`/`SovereignRail`)
- [`docs/doctrine/security-boundaries.md`](docs/doctrine/security-boundaries.md) — sybil, injection, token binding
- [`docs/doctrine/settlement-rails.md`](docs/doctrine/settlement-rails.md) — custody split, rails, withdrawals
- [`docs/doctrine/treasury-custody.md`](docs/doctrine/treasury-custody.md) — receive-vs-outbound phase split for relay treasury; phase 1 = hardware wallet + confirmation horizon (no hot key), phase 2 = MPC / multi-sig / program-authority decision deferred until volume, partner, or protocol forces it
- [`docs/doctrine/operator-transparency.md`](docs/doctrine/operator-transparency.md) — declared posture vs proven posture
- [`docs/doctrine/self-attesting-system.md`](docs/doctrine/self-attesting-system.md) — every claim is user-verifiable
- [`docs/doctrine/hardware-attestation.md`](docs/doctrine/hardware-attestation.md) — software identity is the floor; hardware attestation is additive scoring, never a gate; one canonical body format + one verifier (`@motebit/crypto`) + one `HardwareAttestationSemiring` across Apple SE / App Attest / TPM / Android Keystore / WebAuthn; new platform = one `platform` union entry
- [`docs/doctrine/surface-determinism.md`](docs/doctrine/surface-determinism.md) — affordances invoke capabilities, not prompts
- [`docs/doctrine/typed-truth-perception.md`](docs/doctrine/typed-truth-perception.md) — typed semantic fields on tool results; prompt teaches reading; dispatch enforces structurally; the pair travels together
- [`docs/doctrine/always-already-slab.md`](docs/doctrine/always-already-slab.md) — the slab precedes content; content embeds into the slab's slots, never adjacent; empty states are READY, not absent — the slab inherits sufficiency through the substrate (body → medium → slab), generalizes by inheritance not by reclassifying surfaces as bodies
- [`docs/doctrine/chrome-as-state-render.md`](docs/doctrine/chrome-as-state-render.md) — slab chrome is `render(controlState × embodimentMode)`, not a fixed layout; cobrowser-shaped chrome today is the `user × virtual_browser` cell universalized as if it were the only register; pivot inverts default to `motebit × virtual_browser` with task-step narration, cobrowse becomes an entered mode; hybrid narration source (model proposes, runtime validates) is the third graduation of `runtime-invariants-over-prompt-rules`; spatial-as-endgame test validates registers as information shapes not UI components
- [`docs/doctrine/auto-routing-as-protocol-primitive.md`](docs/doctrine/auto-routing-as-protocol-primitive.md) — auto-routing is `f(TaskShape × ProviderCapability × Constraints) → RoutingDecision`; pure dispatcher in BSL `@motebit/policy`, closed-registry types in Apache-2.0 `@motebit/protocol`. `TaskShape` is the role (7th agility-as-role instance); routing-policy is a consumer-side function, not a role. Three-instance endgame: motebit-cloud (PR 1) / BYOK (PR 2 deferred) / on-device (PR 3 deferred); mirror of chrome-as-state-render's web/mobile/spatial rollout. Drift gate `check-routing-decision-coverage` (#95) enforces consumer registry; TaskShape coverage is TypeScript-enforced via exhaustive switch, not gate-enforced
- [`docs/doctrine/panels-pattern.md`](docs/doctrine/panels-pattern.md) — four shapes for multi-surface panel state; what's shipped, what's evaluated, what's open
- [`docs/doctrine/records-vs-acts.md`](docs/doctrine/records-vs-acts.md) — body shows acts; panels hold records; the category test before any new mount
- [`docs/doctrine/goals-vs-tasks.md`](docs/doctrine/goals-vs-tasks.md) — goal = user-declared outcome; task = emergent plan step
- [`docs/doctrine/motebit-computer.md`](docs/doctrine/motebit-computer.md) — the slab: liquid-glass plane beside the creature, first-person perceptual field made visible. Six embodiment modes unified on one surface (mind / tool_result / virtual_browser / shared_gaze / desktop_drive / peer_viewport), three organs (eye / hand / mind), three end states (dissolve / rest / detach) rooted in droplet physics, supervised agency via gestures on items. Contract is Ring 1; renderer is Ring 3
- [`docs/doctrine/spatial-as-endgame.md`](docs/doctrine/spatial-as-endgame.md) — spatial is the prototype of the AR-glasses companion (the form factor that, on a 5–10 year horizon, replaces the phone). Five spatial primitives (creature, satellite, environment, attractor, **presentation**) replace the original "no panels" rule with the calm-AR rule: surfaces emerge from the motebit's gesture and recede when work ends. Motebit on glasses = sovereign extension of the user's life, agent layer mediating between user and OS (Apple visionOS / Meta Horizon OS / future glasses OS)
- [`docs/doctrine/liquescentia-as-substrate.md`](docs/doctrine/liquescentia-as-substrate.md) — Liquescentia is the medium every render surface inherits, not a feature of any single one. Five properties (spectral gradient, quiescence, luminous density, cohesive permeability, persistence) map to canonical code primitives (`ENV_LIGHT`, 0.3 Hz breathing, `CANONICAL_MATERIAL`, `PolicyGate`, identity + memory). Deepest coherence: on AR glasses, the user's real world _becomes_ Liquescentia — `WebXRThreeJSAdapter`'s comment names this as the endgame; promoting from `ENV_LIGHT` to `xr.getEstimatedLight()` is blocked on a real-device test surface. The body's physics is universal; the medium becomes literal
- [`docs/doctrine/dissolution-spectrum.md`](docs/doctrine/dissolution-spectrum.md) — persistence's multi-axis physics. Five decay constants in code (memory recency 24h half-life, trust 90-day half-life, credential `validUntil` cliff, retention 30/90/365/Inf-day sensitivity ceilings, audit FIFO at 10,000) resolve into three structural forms (exponential / cliff / capacity), aligning with `retention-policy.md`'s three retention shapes. Closes the asymmetry where dissolution pressure was metaphor while breathing rhythm was Rayleigh-derived
- [`docs/doctrine/coverage-graduation.md`](docs/doctrine/coverage-graduation.md) — money/identity packages below 80 carry a raise-by date; soft signal via `pnpm coverage-graduation`
- [`docs/doctrine/proactive-interior.md`](docs/doctrine/proactive-interior.md) — presence mode + 4-phase consolidation cycle + fail-closed proactive tool scope; `runtime.consolidationCycle()` is the only loop
- [`docs/doctrine/retention-policy.md`](docs/doctrine/retention-policy.md) — three retention shapes (mutable pruning / append-only horizon / consolidation flush), one signed `DeletionCertificate` discriminated union, sensitivity ceilings as interop law + reference defaults; closes the asymmetry where memory enforces retention and three sibling stores don't
- [`docs/doctrine/readme-as-glass.md`](docs/doctrine/readme-as-glass.md) — README is a surface; interior links out
- [`docs/doctrine/migration-cleanup.md`](docs/doctrine/migration-cleanup.md) — state-holder analysis for migrations + legacy-compat paths; pre-GA is when you reduce holder counts, not when you slogan-strip
- [`docs/doctrine/deprecation-lifecycle.md`](docs/doctrine/deprecation-lifecycle.md) — partner to migration-cleanup; three signals (major / deprecate+sunset / forbidden-silent-compat), four-field `@deprecated` contract (`since`, `removed in`, replacement, reason), minimum windows adapted from Kubernetes
- [`docs/doctrine/promoting-private-to-public.md`](docs/doctrine/promoting-private-to-public.md) — when to flip `0.0.0-private` → `1.0.0` (real-consumer-shaped trigger, five conditions); 7-step playbook locked to the api-extractor + changeset gates
- [`docs/doctrine/release-versioning.md`](docs/doctrine/release-versioning.md) — versions are promises; no `fixed`, no `linked`, packages version on their own merit; `updateInternalDependencies: "patch"` handles cascade; major bumps mean a real break in that package's own contract
- [`docs/doctrine/the-stack-one-layer-up.md`](docs/doctrine/the-stack-one-layer-up.md) — hosted agent platforms and motebit converge on the same five primitives (identity, memory, capability bundle, autonomous execution, governance gate); the difference is who owns the identity layer; the architectural map is not a roadmap
- [`docs/doctrine/nist-alignment.md`](docs/doctrine/nist-alignment.md) — NIST alignment as derivation, not certification: the protocol surface is the integration surface; the April 2 NCCoE submission is the frozen artifact, this doctrine is the living version; eight asks shipped + one (C2PA content provenance) deferred until a real consumer exists; co-authorship of NCCoE Agent Identity, not certification against rolling federal mandates; structurally bound to code via `check-doctrine-citations` so claims here cannot rot
- [`docs/doctrine/runtime-invariants-over-prompt-rules.md`](docs/doctrine/runtime-invariants-over-prompt-rules.md) — make illegal states unrepresentable at the runtime; the prompt teaches what's true about the world, not what to do or not do. Extends `THE_EMERGENT_INTERIOR` §4 from "no economic pressure" to "no conformance-shaped pressure of any kind." Five-question audit before each new prompt clause; periodic prompt-prune cadence; `synthesizeClosingFallback` as the exemplar
- [`docs/drift-defenses.md`](docs/drift-defenses.md) — synchronization invariants inventory (34 today)

## Principles

Architectural invariants. Violating them breaks CI, the product, or the thesis.

- **Metabolic.** Absorb solved problems (VAD, STT, embeddings, inference) through adapters with fallback. Build enzymes (identity, memory, trust, governance), not glucose. See `THE_METABOLIC_PRINCIPLE.md`.
- **Adapter pattern everywhere.** All I/O abstracted. In-memory for tests, SQLite/Tauri/Expo/IndexedDB in production. The interior must not bind to a provider.
- **Fail-closed privacy.** Deny on error. Sensitivity levels (none/personal/medical/financial/secret) enforced at storage, retrieval, sync, and context boundaries. Medical/financial/secret never reach external AI. Retention enforced via deletion certificates.
- **Proof composability.** Canonical JSON → SHA-256 → Ed25519 verify. Always. External anchoring is additive, never gatekeeping. `@motebit/crypto` works standalone with zero monorepo deps.
- **Semiring algebra for routing.** Algebra in Apache-2.0 `@motebit/protocol` (`Semiring<T>`, `WeightedDigraph<T>`, traversal). Judgment in BSL `@motebit/semiring` (agent graph, ranking, provenance). Swap the semiring to change what "best path" means — no new algorithm.
- **Economic loop.** Relay is the ledger. Rails are the membrane. Agents circulate inside via virtual accounts — allocate, execute, settle, earn. 5% fee at each settlement checkpoint. Rails are on/off ramps only; deposits and withdrawals are edge operations. Everything between is agent-to-agent.
- **Adversarial onboarding.** Embed adversarial probes in the happy path. `--self-test` submits the self-delegation sybil vector through the live relay. If the security boundary breaks, onboarding breaks.
- **Sibling boundary rule.** When you fix one boundary (auth, policy, validation, rendering), audit all siblings in the same pass. Docs are siblings of code.
- **One-pass delivery.** When a core primitive ships, implement across all surfaces in the same pass. Do not defer UI if the package boundary is stable.
- **Deletion policy.** Three classifications before removing. (1) Internal workspace deps (`@motebit/*`): never remove from import analysis alone — they encode layer membership. (2) Published API, vocabulary, or sibling-surface scaffolding: preserve. (3) Dead code: remove only when zero callers, not intended API, typecheck/tests pass. `check-deps` (hard) governs architecture; `check-unused` (soft) governs dep hygiene — do not conflate.
- **Synchronization invariants are the meta-principle.** Every drift has the same shape: canonical truth invisible or unenforced, siblings drifted. On a new drift pattern: name it, identify canonical source, name sync owner and trigger, add a defense (CI/lint/doctrine), cross-reference. Never let spec and code diverge. Inventory: [`docs/drift-defenses.md`](docs/drift-defenses.md).
- **Protocol primitives belong in packages, never inline in services.** Before writing protocol-shaped plumbing (signing, token minting, MCP transport, receipt construction, relay submission, verification, delegation) in a service, audit the package layer in order: `@motebit/protocol` → `crypto` → `encryption` → `mcp-client` → `mcp-server` → `runtime` → `core-identity` → `identity-file`. No match means a primitive is missing — pause, add it to the right package with tests, consume from the service. `check-service-primitives` enforces.
- **Surface affordances are deterministic.** Explicit UI affordances (chip tap, button, slash command, scene-object click, voice opt-in) MUST invoke the runtime's typed `invokeCapability(capability, args)`, never route through the AI loop via a constructed prompt. Enforced at protocol (`invocation_origin`), runtime (`invokeCapability` vs `sendMessageStreaming`), and statically (`check-affordance-routing`). Failures degrade honestly, not gracefully. See [`docs/doctrine/surface-determinism.md`](docs/doctrine/surface-determinism.md).
- **Proactive interior is one cycle, fail-closed by default.** Idle-time work flows through `runtime.consolidationCycle()` (orient → gather → consolidate → prune) — no parallel "background tasks" loops. Presence (`responsive | tending | idle`) is a typed state machine surfaces subscribe to. Proactive tool scope is fail-closed: empty by default, intersected with a runtime allowlist of memory-mutation tools so a misclick on the user's allowlist still cannot fire a side-effecting tool proactively. Enforced by `check-consolidation-primitives` (#34). See [`docs/doctrine/proactive-interior.md`](docs/doctrine/proactive-interior.md).
- **Capability rings, not feature parity.** Ring 1 (identical everywhere): runtime, sdk, crypto, policy. Ring 2 (platform adapters): persistence, keyring, voice. Ring 3 (platform capabilities): MCP stdio, 3D creature, daemon. Ring 1 is about capability, not form — a surface may express the same capability through a different medium-native form.
- **Hybrid engine, structural preference.** When multiple tool tiers could satisfy the same intent, the registry sorts `api → ax → pixels → undeclared` and the AI defaults to the first-listed. Pixels are the universal fallback, not the default — a screenshot costs ~30k tokens and crosses the whole-screen privacy surface; MCP / web_search / memory tools cost KBs. Every `ToolDefinition` declares `mode: "api" | "ax" | "pixels"`. `check-tool-modes` enforces (#36).
- **Hardware-rooted identity is additive.** Software identity is the floor; Secure Enclave / TPM / StrongBox / DeviceCheck signatures raise the `HardwareAttestationSemiring` score. Every claim is a hierarchical binding — the hardware attestor key attests the Ed25519 identity key, it doesn't replace it. Claims are scoring dimensions, never admission gates. New platform adapter = one `platform` union entry + one minting path; the verifier and the rank are closed under additions. See [`docs/doctrine/hardware-attestation.md`](docs/doctrine/hardware-attestation.md).
- **Typed truth on results, prompt for interpretation.** Tool results carry semantic-intent fields the AI branches on (`already_there`, `not_in_control`, `text_appeared`, `slow_load`, `bytes_omitted_reason`, `visual_content_detected` / `blank_page_detected` / `access_denied_detected`). `PERCEPTION_DOCTRINE` in `@motebit/ai-core` teaches reading them; the dispatch enforces the same condition structurally — `urlsAreEquivalent` short-circuits same-URL navigates with `already_there: true`; the runtime session manager's gate refuses `computer({...})` from non-motebit control state with `not_in_control`. The prompt is the ergonomics; the dispatch is the floor. New typed-truth fields ship with all three commitments — wire field, prompt clause, dispatch enforcement — or they don't compose. See [`docs/doctrine/typed-truth-perception.md`](docs/doctrine/typed-truth-perception.md).
- **The slab is always-already there.** The slab precedes content; content embeds INTO the slab's typed slots, never adjacent; empty states are READY, not absent. A slab whose existence is contingent on content is two surfaces stitched together, not one slab in two registers. The lineage: body ([`DROPLET.md`](DROPLET.md) §VIII proves sufficiency — the body's existence is sufficient unto itself, not contingent on content) → substrate ([`liquescentia-as-substrate.md`](docs/doctrine/liquescentia-as-substrate.md) — the medium the body inhabits, always-already present) → slab (the act-surface the substrate carries; inherits sufficiency through the substrate, not by being a body itself — the slab is the body's first-person perceptual field per [`motebit-computer.md`](docs/doctrine/motebit-computer.md), an organ of the body). The slab is alive the moment the user lands on /computer — `WebApp.bootstrapComputer` eagerly calls `registration.ensureDefaultSession()` at app boot, and within 1-2s the live_browser slab item mounts via `onSessionLive`. Content embeds via the slab item's typed slots — chrome inside `controlBandSlot`, screencast inside the screen mesh, ghost-ready affordance inside `stageEl` — never adjacent (no `setSlabControlBand` viewport-top fallback, no off-slab overlays). Empty register: sympathetic-breathing pulsing mark + caption (`type a URL · or ask motebit`) fills the slab during cold-start and post-session-close, breathing at the same 0.3 Hz the body does, slab-coherent through the substrate. Generalizes through inheritance to future act-surfaces (mobile's surface analog, spatial's primitive analog, viewport-grade `peer_viewport`) — never through reclassifying them as bodies. Compounds with [`records-vs-acts.md`](docs/doctrine/records-vs-acts.md) (acts pass through the slab, records sit alongside; the slab persists between acts). See [`docs/doctrine/always-already-slab.md`](docs/doctrine/always-already-slab.md).

## Money model

Integer micro-units (1 USD = 1,000,000). Convert at API boundary: `toMicro(dollars)` in, `fromMicro(micro)` out. Zero floating-point in the money path.

## Commands

```bash
pnpm build             # Build all packages
pnpm test              # Test all packages
pnpm typecheck         # Type-check all packages
pnpm lint              # Lint all packages
pnpm check             # Run every hard drift gate
pnpm check-deps        # Validate layer architecture
pnpm --filter @motebit/runtime test   # Test single package
```

## Conventions

- Export from `src/index.ts`; tests in `src/__tests__/` using Vitest.
- Error rethrows: `throw new Error("description", { cause: err })`.
- Error messages: `err instanceof Error ? err.message : String(err)`.
- Secrets in OS keyring. Config: `~/.motebit/config.json`. DB: `~/.motebit/motebit.db`.
- CSS inline in HTML (desktop, admin).
- Branded ID types (`MotebitId`, `DeviceId`) for compile-time safety.
- Relay: `createLogger(module)` with `x-correlation-id`. Runtime: pluggable `logger` (default `console.warn`).
- Dependency overrides upper-bounded (`>=4.59.0 <5.0.0`).
- Inline trivial utilities (< 10 lines, no crypto/state/IO) at layer boundaries rather than cross-layer import.
- Event appending uses `appendWithClock()` for atomic `version_clock`.

## UI

Motebit is calm software. Do not confirm what the user can already see.

- **Silent** — modal closes, toggles, chat populates. No toast.
- **Toast** — async outcomes the user can't observe (sync, pairing). Short, never stacked.
- **System message** — errors with next steps, security warnings. Rare (≤3–4/session), actionable.
- **Anti-patterns** — "Settings saved" after modal close; "Loading…" when content visibly populates.
- **Settings vs Sovereign — identity vs state.** Settings: what you _are_ (identity, device, keys, config). Sovereign: what you _have, owe, or are doing_ (balances, allocations, credentials, execution ledger). Ask: "is this what I am, or what I have?"
- **Audience-aware sequencing.** Enterprise/power-user features go at the end of the flow, marked optional. The sovereign/consumer path is primary.
