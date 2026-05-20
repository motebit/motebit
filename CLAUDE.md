# Motebit

A motebit is a droplet of intelligence under surface tension: identity forms the boundary, intelligence fills the interior, governance maintains the surface that prevents diffusion. You own the identity. The intelligence is pluggable. The body is yours.

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

- [`docs/doctrine/primitive-vocabulary.md`](docs/doctrine/primitive-vocabulary.md) — discoverability anchor for the five primitive vocabularies (positioning, architectural, comparative, hero, metabolic) + translation table; read first when authoring any founder-surface artifact that enumerates primitives
- [`docs/doctrine/protocol-primacy.md`](docs/doctrine/protocol-primacy.md) — constitutional invariant: protocol with a company on top, not a company with a protocol on the side. Protocol-first audit ("does this work identically for a non-subscriber?") gates every business-side artifact
- [`docs/doctrine/receipts-unified.md`](docs/doctrine/receipts-unified.md) — three receipt types (`ExecutionReceipt`, `ToolInvocationReceipt`, `ContentArtifactManifest`) form one family unified by JCS + Ed25519 + suite-dispatch + `@motebit/verifier`
- [`docs/doctrine/delegation.md`](docs/doctrine/delegation.md) — the architectural connector turning identity / trust / receipts / settlement / policy into a dynamic system; cryptographic (Ed25519+JCS+verifier) and semantic (scope+TTL+chain≤10) invariants; supersedes "permissions" in positioning
- [`docs/doctrine/protocol-model.md`](docs/doctrine/protocol-model.md) — permissive-floor / BSL / accumulated-state, cryptosuite agility
- [`docs/doctrine/agility-as-role.md`](docs/doctrine/agility-as-role.md) — name the role in code/gates/types; migration is a registry append, not a wire-format break. Eight instances today (cryptosuite, license-floor, settlement-rail, settlement-asset, TaskShape, …)
- [`docs/doctrine/security-boundaries.md`](docs/doctrine/security-boundaries.md) — sybil, injection, token binding
- [`docs/doctrine/settlement-rails.md`](docs/doctrine/settlement-rails.md) — custody split, rails, withdrawals
- [`docs/doctrine/off-ramp-as-user-action.md`](docs/doctrine/off-ramp-as-user-action.md) — out-flow paths 0/1/3; Arc 2 P2P fee leg shipped (atomic multi-output Solana tx); Arc 3 ships in-flow type scaffolding (`WritableSettlementMode` + disjunctive `SettlementEligibility`); Arc 3.5 submission gate deferred behind E2E migration; relay user-funds transmitter surface is structurally zero
- [`docs/doctrine/treasury-custody.md`](docs/doctrine/treasury-custody.md) — receive-vs-outbound phase split; phase 1 hardware wallet + confirmation horizon; phase 2 (MPC / multi-sig / program-authority) deferred until forced
- [`docs/doctrine/operator-transparency.md`](docs/doctrine/operator-transparency.md) — declared posture vs proven posture
- [`docs/doctrine/self-attesting-system.md`](docs/doctrine/self-attesting-system.md) — every claim is user-verifiable
- [`docs/doctrine/identity-restore.md`](docs/doctrine/identity-restore.md) — three-layer restore split; two entry points (motebit.md + recovery seed); seed-only mints new motebit_id; v1 hard-overwrite; preserveMemories re-key migration deferred to v1.x
- [`docs/doctrine/hardware-attestation.md`](docs/doctrine/hardware-attestation.md) — software identity is the floor; hardware attestation is additive scoring via `HardwareAttestationSemiring`, never a gate; new platform = one `platform` union entry
- [`docs/doctrine/surface-determinism.md`](docs/doctrine/surface-determinism.md) — affordances invoke capabilities, not prompts
- [`docs/doctrine/typed-truth-perception.md`](docs/doctrine/typed-truth-perception.md) — typed semantic fields on tool results; prompt teaches reading; dispatch enforces structurally; ship all three together
- [`docs/doctrine/intent-gated-slab.md`](docs/doctrine/intent-gated-slab.md) — slab precedes content; content embeds into typed slots, never adjacent; empty states are READY; sufficiency inherits body → medium → slab
- [`docs/doctrine/chrome-as-state-render.md`](docs/doctrine/chrome-as-state-render.md) — slab chrome is `render(controlState × embodimentMode)`; pivot default to `motebit × virtual_browser` with task-step narration; cobrowse is an entered mode
- [`docs/doctrine/auto-routing-as-protocol-primitive.md`](docs/doctrine/auto-routing-as-protocol-primitive.md) — `f(TaskShape × ProviderCapability × Constraints) → RoutingDecision`; pure dispatcher in BSL `@motebit/policy`, closed types in Apache-2.0 `@motebit/protocol`; drift gate `check-routing-decision-coverage` (#95)
- [`docs/doctrine/intelligence-pluggability-contract.md`](docs/doctrine/intelligence-pluggability-contract.md) — connector between `protocol-primacy` and `runtime-invariants-over-prompt-rules`: runtime invariants constant, prompt/tools/budgets adapt to selected model. Three commitments (pre-flight admission, model-aware prompt assembly, move invariants out of prompt). Drift gate `check-prompt-budget` (#103)
- [`docs/doctrine/panels-pattern.md`](docs/doctrine/panels-pattern.md) — four shapes for multi-surface panel state; what's shipped, what's evaluated, what's open
- [`docs/doctrine/panel-presentation-modes.md`](docs/doctrine/panel-presentation-modes.md) — third axis on flat-surface panels: `PanelPresentationMode` (rail / immersive); rail absent on mobile; panels do not exist in spatial (translate to Presentation primitive); modals structurally unrepresentable — rotate interior register instead
- [`docs/doctrine/records-vs-acts.md`](docs/doctrine/records-vs-acts.md) — body shows acts; panels hold records; the category test before any new mount
- [`docs/doctrine/panel-temporal-registers.md`](docs/doctrine/panel-temporal-registers.md) — six side-rail panels split identity (retrospective) vs runtime (prospective); governance has no panel; Settings is config not interior. Substrate-vs-accumulation test for Settings-vs-capability placement
- [`docs/doctrine/goals-vs-tasks.md`](docs/doctrine/goals-vs-tasks.md) — goal = user-declared outcome; task = emergent plan step
- [`docs/doctrine/goal-results.md`](docs/doctrine/goal-results.md) — three-category split per goal fire: commitment / receipt / artifact; artifacts wrap as signed `ContentArtifactManifest`, render as slab items now, Presentation primitives later
- [`docs/doctrine/motebit-computer.md`](docs/doctrine/motebit-computer.md) — the slab: six embodiment modes, three organs (eye / hand / mind), three end states (dissolve / rest / detach). Contract is Ring 1; renderer is Ring 3
- [`docs/doctrine/spatial-as-endgame.md`](docs/doctrine/spatial-as-endgame.md) — spatial prototypes the AR-glasses companion. Five primitives (creature, satellite, environment, attractor, presentation) replace "no panels" with calm-AR: surfaces emerge from the motebit's gesture
- [`docs/doctrine/liquescentia-as-substrate.md`](docs/doctrine/liquescentia-as-substrate.md) — the medium every render surface inherits; five properties map to canonical code primitives; on AR glasses the real world _becomes_ Liquescentia
- [`docs/doctrine/attention-is-directional.md`](docs/doctrine/attention-is-directional.md) — body is omnidirectional, attention is directional. Face in front hemisphere by geometry; anti-patterns forbidden (camera-facing eyes, 360° face texture, back-view eye glow)
- [`docs/doctrine/dissolution-spectrum.md`](docs/doctrine/dissolution-spectrum.md) — persistence's multi-axis physics: five decay constants resolve into three structural forms (exponential / cliff / capacity) aligned with `retention-policy.md`
- [`docs/doctrine/coverage-graduation.md`](docs/doctrine/coverage-graduation.md) — money/identity packages below 80 carry a raise-by date; soft signal via `pnpm coverage-graduation`
- [`docs/doctrine/proactive-interior.md`](docs/doctrine/proactive-interior.md) — presence mode + 4-phase consolidation cycle + fail-closed proactive tool scope; `runtime.consolidationCycle()` is the only loop
- [`docs/doctrine/retention-policy.md`](docs/doctrine/retention-policy.md) — three retention shapes (mutable pruning / append-only horizon / consolidation flush), one signed `DeletionCertificate`, sensitivity ceilings as interop law
- [`docs/doctrine/readme-as-glass.md`](docs/doctrine/readme-as-glass.md) — README is a surface; interior links out
- [`docs/doctrine/migration-cleanup.md`](docs/doctrine/migration-cleanup.md) — state-holder analysis for migrations + legacy-compat paths
- [`docs/doctrine/deprecation-lifecycle.md`](docs/doctrine/deprecation-lifecycle.md) — three signals (major / deprecate+sunset / forbidden-silent-compat); four-field `@deprecated` contract; Kubernetes-adapted minimum windows
- [`docs/doctrine/promoting-private-to-public.md`](docs/doctrine/promoting-private-to-public.md) — when to flip `0.0.0-private` → `1.0.0`; five conditions + 7-step playbook
- [`docs/doctrine/release-versioning.md`](docs/doctrine/release-versioning.md) — versions are promises; no `fixed`, no `linked`; `updateInternalDependencies: "patch"` cascade; major bumps mean a real break
- [`docs/doctrine/the-stack-one-layer-up.md`](docs/doctrine/the-stack-one-layer-up.md) — hosted agent platforms and motebit converge on the same five primitives; difference is who owns the identity layer
- [`docs/doctrine/nist-alignment.md`](docs/doctrine/nist-alignment.md) — alignment as derivation, not certification; NCCoE Agent Identity co-authorship; structurally bound to code via `check-doctrine-citations`
- [`docs/doctrine/runtime-invariants-over-prompt-rules.md`](docs/doctrine/runtime-invariants-over-prompt-rules.md) — make illegal states unrepresentable at the runtime; the prompt teaches what's true, not what to do. Five-question audit before each new prompt clause
- [`docs/doctrine/registry-pattern-canonical.md`](docs/doctrine/registry-pattern-canonical.md) — eight-artifact set per typed vocabulary; meta-gate `check-closed-registry-canonical.ts` (#98) locks the gates that lock the registries
- [`docs/drift-defenses.md`](docs/drift-defenses.md) — synchronization invariants inventory (34 today)

## Principles

This file indexes the doctrine — on conflict between a principle here and its named doctrine doc, the doctrine doc is canonical.

Architectural invariants. Violating them breaks CI, the product, or the thesis.

- **Metabolic.** Absorb solved problems (VAD, STT, embeddings, inference) through adapters with fallback. Build enzymes (identity, memory, trust, governance), not glucose. See `THE_METABOLIC_PRINCIPLE.md`.
- **Adapter pattern everywhere.** All I/O abstracted. In-memory for tests, SQLite/Tauri/Expo/IndexedDB in production. The interior must not bind to a provider.
- **Fail-closed privacy.** Deny on error. Sensitivity levels (none/personal/medical/financial/secret) enforced at storage, retrieval, sync, and context boundaries. Medical/financial/secret never reach external AI. Retention enforced via deletion certificates.
- **Proof composability.** Canonical JSON → SHA-256 → Ed25519 verify. Always. External anchoring is additive, never gatekeeping. `@motebit/crypto` works standalone with zero monorepo deps.
- **Semiring algebra for routing.** Algebra in Apache-2.0 `@motebit/protocol` (`Semiring<T>`, `WeightedDigraph<T>`, traversal). Judgment in BSL `@motebit/semiring` (agent graph, ranking, provenance). Swap the semiring to change what "best path" means — no new algorithm.
- **Economic loop.** Relay is the ledger. Rails are the membrane. Agents circulate inside via virtual accounts — allocate, execute, settle, earn. 5% fee at each settlement checkpoint. The relay records all settlement, custodies only guest-rail settlement, coordinates regardless of custody. Graduation removes custody, never coordination. On relay-custody the fee deducts at the virtual-account boundary; on P2P the fee composes as a direct delegator→treasury leg in the same atomic Solana multi-output tx. Money out: Path 0 (sovereign Solana return-of-custody) / Path 1 (x402 to user-held EVM) / Path 3 (user-initiated Bridge, user as KYC'd customer); relay's out-flow user-funds transmitter surface is structurally zero. See [`docs/doctrine/settlement-rails.md`](docs/doctrine/settlement-rails.md) and [`docs/doctrine/off-ramp-as-user-action.md`](docs/doctrine/off-ramp-as-user-action.md).
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
- **Typed truth on results, prompt for interpretation.** Tool results carry semantic-intent fields (`already_there`, `not_in_control`, `text_appeared`, `slow_load`, `bytes_omitted_reason`, `visual_content_detected`, …). `PERCEPTION_DOCTRINE` teaches reading; dispatch enforces structurally. New typed-truth fields ship with all three (wire field + prompt clause + dispatch enforcement) or they don't compose. See [`docs/doctrine/typed-truth-perception.md`](docs/doctrine/typed-truth-perception.md).
- **The slab is always-already there.** Slab precedes content; content embeds into typed slots (`controlBandSlot`, screen mesh), never adjacent; empty states are READY. Slab is intent-gated — `WebApp.invokeComputer()` is the single idempotent entry. Sufficiency inherits body → substrate → slab; generalizes by inheritance, never by reclassifying surfaces as bodies. See [`docs/doctrine/intent-gated-slab.md`](docs/doctrine/intent-gated-slab.md).

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
