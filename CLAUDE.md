# Motebit

A motebit is a droplet of intelligence under surface tension. You own the identity. The intelligence is pluggable. The body is yours.

The body is passive. The interior is active. Memory, trust, identity, tool use are interior structures. The policy gate, the privacy layer, the governance are the surface tension. Maximum interiority, minimum display.

Read `DROPLET.md` for the physics of form. Read `THE_SOVEREIGN_INTERIOR.md` for the identity thesis. Read `THE_METABOLIC_PRINCIPLE.md` for what to build vs. absorb. Every decision traces to droplet physics or it doesn't belong.

## The three things no one else is building together

1. **Persistent sovereign identity** — a cryptographic entity across time and devices, not a session token
2. **Accumulated trust** — memory, state history, audit trails that make the agent more capable the longer it runs
3. **Governance at the boundary** — sensitivity-aware privacy and policy controlling what crosses the surface

MCP defines capability but not identity. A2A defines communication but has no trust accumulation. x402/AP2 defines payment but has no identity. Motebit is the missing layer underneath. The relay bridges all four at a single economic checkpoint — identity resolved, execution verified, money finalized.

## Architecture

pnpm monorepo, Turborepo, TypeScript. Node ≥ 20, pnpm 9.15. 37 packages on a 7-layer DAG enforced by `pnpm check-deps`. 5 surfaces + 3 supporting apps, 8 services, 14 open protocol specs.

Layout and per-package roles: [`README.md`](README.md), [`apps/docs/content/docs/operator/architecture.mdx`](apps/docs/content/docs/operator/architecture.mdx) (canonical; enforced by `check-docs-tree`).

Per-directory doctrine loads lazily (every sub-`CLAUDE.md` must appear here; enforced by `check-claude-md`):

- [`packages/protocol/CLAUDE.md`](packages/protocol/CLAUDE.md) — MIT purity, types/algebra only
- [`packages/crypto/CLAUDE.md`](packages/crypto/CLAUDE.md) — suite-dispatch is the only Ed25519 caller
- [`packages/circuit-breaker/CLAUDE.md`](packages/circuit-breaker/CLAUDE.md) — per-peer three-state engine, no I/O, injected clock
- [`packages/evm-rpc/CLAUDE.md`](packages/evm-rpc/CLAUDE.md) — JSON-RPC behind a motebit-shaped interface; one error shape out
- [`packages/deposit-detector/CLAUDE.md`](packages/deposit-detector/CLAUDE.md) — single `eth_getLogs` per cycle; dedup is the consumer's atomic write
- [`packages/virtual-accounts/CLAUDE.md`](packages/virtual-accounts/CLAUDE.md) — per-motebit ledger in micro-units; atomic credit/debit
- [`packages/settlement-rails/CLAUDE.md`](packages/settlement-rails/CLAUDE.md) — three guest rails + registry; custody split at the type level
- [`packages/wallet-solana/CLAUDE.md`](packages/wallet-solana/CLAUDE.md) — sovereign rail, identity key = address
- [`packages/self-knowledge/CLAUDE.md`](packages/self-knowledge/CLAUDE.md) — committed BM25 corpus over self-description docs; zero runtime deps
- [`packages/mcp-client/CLAUDE.md`](packages/mcp-client/CLAUDE.md) — `CredentialSource`, `ServerVerifier`, OAuth
- [`services/api/CLAUDE.md`](services/api/CLAUDE.md) — the relay
- [`apps/spatial/CLAUDE.md`](apps/spatial/CLAUDE.md) — no panels

Cross-cutting doctrine (read on demand):

- [`docs/doctrine/protocol-model.md`](docs/doctrine/protocol-model.md) — MIT/BSL/state, cryptosuite agility
- [`docs/doctrine/security-boundaries.md`](docs/doctrine/security-boundaries.md) — sybil, injection, token binding
- [`docs/doctrine/settlement-rails.md`](docs/doctrine/settlement-rails.md) — custody split, rails, withdrawals
- [`docs/doctrine/operator-transparency.md`](docs/doctrine/operator-transparency.md) — declared posture vs proven posture
- [`docs/doctrine/self-attesting-system.md`](docs/doctrine/self-attesting-system.md) — every claim is user-verifiable
- [`docs/doctrine/surface-determinism.md`](docs/doctrine/surface-determinism.md) — affordances invoke capabilities, not prompts
- [`docs/doctrine/readme-as-glass.md`](docs/doctrine/readme-as-glass.md) — README is a surface; interior links out
- [`docs/drift-defenses.md`](docs/drift-defenses.md) — synchronization invariants inventory (32 today)

## Principles

Architectural invariants. Violating them breaks CI, the product, or the thesis.

- **Metabolic.** Absorb solved problems (VAD, STT, embeddings, inference) through adapters with fallback. Build enzymes (identity, memory, trust, governance), not glucose. See `THE_METABOLIC_PRINCIPLE.md`.
- **Adapter pattern everywhere.** All I/O abstracted. In-memory for tests, SQLite/Tauri/Expo/IndexedDB in production. The interior must not bind to a provider.
- **Fail-closed privacy.** Deny on error. Sensitivity levels (none/personal/medical/financial/secret) enforced at storage, retrieval, sync, and context boundaries. Medical/financial/secret never reach external AI. Retention enforced via deletion certificates.
- **Proof composability.** Canonical JSON → SHA-256 → Ed25519 verify. Always. External anchoring is additive, never gatekeeping. `@motebit/crypto` works standalone with zero monorepo deps.
- **Semiring algebra for routing.** Algebra in MIT `@motebit/protocol` (`Semiring<T>`, `WeightedDigraph<T>`, traversal). Judgment in BSL `@motebit/semiring` (agent graph, ranking, provenance). Swap the semiring to change what "best path" means — no new algorithm.
- **Economic loop.** Relay is the ledger. Rails are the membrane. Agents circulate inside via virtual accounts — allocate, execute, settle, earn. 5% fee at each settlement checkpoint. Rails are on/off ramps only; deposits and withdrawals are edge operations. Everything between is agent-to-agent.
- **Adversarial onboarding.** Embed adversarial probes in the happy path. `--self-test` submits the self-delegation sybil vector through the live relay. If the security boundary breaks, onboarding breaks.
- **Sibling boundary rule.** When you fix one boundary (auth, policy, validation, rendering), audit all siblings in the same pass. Docs are siblings of code.
- **One-pass delivery.** When a core primitive ships, implement across all surfaces in the same pass. Do not defer UI if the package boundary is stable.
- **Deletion policy.** Three classifications before removing. (1) Internal workspace deps (`@motebit/*`): never remove from import analysis alone — they encode layer membership. (2) Published API, vocabulary, or sibling-surface scaffolding: preserve. (3) Dead code: remove only when zero callers, not intended API, typecheck/tests pass. `check-deps` (hard) governs architecture; `check-unused` (soft) governs dep hygiene — do not conflate.
- **Synchronization invariants are the meta-principle.** Every drift has the same shape: canonical truth invisible or unenforced, siblings drifted. On a new drift pattern: name it, identify canonical source, name sync owner and trigger, add a defense (CI/lint/doctrine), cross-reference. Never let spec and code diverge. Inventory: [`docs/drift-defenses.md`](docs/drift-defenses.md).
- **Protocol primitives belong in packages, never inline in services.** Before writing protocol-shaped plumbing (signing, token minting, MCP transport, receipt construction, relay submission, verification, delegation) in a service, audit the package layer in order: `@motebit/protocol` → `crypto` → `encryption` → `mcp-client` → `mcp-server` → `runtime` → `core-identity` → `identity-file`. No match means a primitive is missing — pause, add it to the right package with tests, consume from the service. `check-service-primitives` enforces.
- **Surface affordances are deterministic.** Explicit UI affordances (chip tap, button, slash command, scene-object click, voice opt-in) MUST invoke the runtime's typed `invokeCapability(capability, args)`, never route through the AI loop via a constructed prompt. Enforced at protocol (`invocation_origin`), runtime (`invokeCapability` vs `sendMessageStreaming`), and statically (`check-affordance-routing`). Failures degrade honestly, not gracefully. See [`docs/doctrine/surface-determinism.md`](docs/doctrine/surface-determinism.md).
- **Capability rings, not feature parity.** Ring 1 (identical everywhere): runtime, sdk, crypto, policy. Ring 2 (platform adapters): persistence, keyring, voice. Ring 3 (platform capabilities): MCP stdio, 3D creature, daemon. Ring 1 is about capability, not form — a surface may express the same capability through a different medium-native form.

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
