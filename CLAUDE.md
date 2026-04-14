# Motebit

A motebit is a droplet of intelligence under surface tension.

Every AI product owns the intelligence and rents you a session. Motebit inverts that. You own the identity. The intelligence is pluggable. The body is yours.

The body is passive. The interior is active. The agent lives inside the droplet — memory, trust, identity, tool use are interior structures. The policy gate, the privacy layer, the governance are the surface tension. The form doesn't change. The interior accumulates. Maximum interiority, minimum display.

Read `DROPLET.md` for the physics of form. Read `THE_SOVEREIGN_INTERIOR.md` for the identity thesis. Read `THE_METABOLIC_PRINCIPLE.md` for what to build vs. what to absorb. Every visual and behavioral decision derives from droplet physics. If it can't be traced to surface tension, it doesn't belong.

## The three things no one else is building together

1. **Persistent sovereign identity** — not a session token, a cryptographic entity that exists across time and devices
2. **Accumulated trust** — memory, state history, audit trails that make the agent more capable the longer it runs
3. **Governance at the boundary** — sensitivity-aware privacy and policy that controls what crosses the surface

MCP defines capability but says nothing about who the agent is. A2A defines communication but has no trust accumulation. x402/AP2 defines payment but has no identity. Motebit is the missing layer underneath all three. The relay bridges all four through a single economic checkpoint — identity resolved, execution verified, money finalized.

## Architecture

pnpm monorepo, Turborepo, TypeScript throughout. Node ≥ 20, pnpm 9.15. 31 packages on a 7-layer DAG enforced by `pnpm check-deps`. 5 surfaces + 3 supporting apps, 8 services (1 relay, 2 molecule agents, 4 atom providers, 1 glue), 12 open protocol specs.

Full layout, per-package roles, and the directory tree: [`README.md`](README.md), [`apps/docs/content/docs/operator/architecture.mdx`](apps/docs/content/docs/operator/architecture.mdx) (canonical; enforced by `check-docs-tree`).

Per-directory doctrine loads lazily when Claude touches those files:

- [`packages/protocol/CLAUDE.md`](packages/protocol/CLAUDE.md) — MIT purity, types/algebra only
- [`packages/crypto/CLAUDE.md`](packages/crypto/CLAUDE.md) — suite-dispatch is the only Ed25519 caller
- [`packages/mcp-client/CLAUDE.md`](packages/mcp-client/CLAUDE.md) — `CredentialSource`, `ServerVerifier`, OAuth
- [`packages/wallet-solana/CLAUDE.md`](packages/wallet-solana/CLAUDE.md) — sovereign rail, identity key = address
- [`services/api/CLAUDE.md`](services/api/CLAUDE.md) — the relay
- [`apps/spatial/CLAUDE.md`](apps/spatial/CLAUDE.md) — no panels

Cross-cutting doctrine (read on demand):

- [`docs/doctrine/protocol-model.md`](docs/doctrine/protocol-model.md) — MIT/BSL/state, operational test, cryptosuite agility
- [`docs/doctrine/security-boundaries.md`](docs/doctrine/security-boundaries.md) — sybil, injection, token binding, cert pinning
- [`docs/doctrine/settlement-rails.md`](docs/doctrine/settlement-rails.md) — custody split, concrete rails, withdrawals
- [`docs/drift-defenses.md`](docs/drift-defenses.md) — the 14 synchronization invariants

## Principles

These are not suggestions. They are the architectural invariants that make the monorepo coherent. Violating them breaks CI, breaks the product, or breaks the thesis.

**Metabolic principle.** Do not build what the medium already carries. Absorb solved problems (VAD, STT, embeddings, inference) through adapter boundaries with fallback chains. Build the enzymes (identity, memory, trust, governance, agentic loops), not the glucose (raw capabilities).

**Adapter pattern everywhere.** All I/O abstracted. In-memory for tests, SQLite/Tauri/Expo/IndexedDB for production. The adapter is the surface tension boundary in code: the interior must not bind to a specific provider.

**Fail-closed privacy.** Deny on error. Sensitivity levels (none/personal/medical/financial/secret) enforced at storage, retrieval, sync, and context boundaries. Medical/financial/secret memories never reach external AI providers. Relay sync redacts sensitive content. Retention rules enforced in housekeeping with deletion certificates.

**Proof composability.** Canonical JSON → SHA-256 → Ed25519 verify. Always. External anchoring (blockchain, IPFS, x402) is additive, never gatekeeping. `@motebit/crypto` works standalone with zero monorepo deps. Do not add verification paths that require external systems.

**Semiring algebra for routing.** Agent network routing is algebraic. The algebra lives in MIT `@motebit/protocol` (`Semiring<T>` interface, concrete semirings, product combinators, `WeightedDigraph<T>`, generic traversal, trust constants). The judgment lives in BSL `@motebit/semiring` (agent graph, multi-objective ranking, provenance, trust transitions). Swap the semiring to change what "best path" means. New routing concerns require only a new semiring definition — zero new algorithms.

**Economic loop principle.** The relay is the economy's ledger, the rails are the membrane, agents are the workers and spenders inside the loop. Users fund at the edges (Stripe, Bridge, wallet deposit). Agents transact inside the relay via virtual accounts — allocate, execute, settle, earn, delegate, earn again. The 5% platform fee is extracted at each settlement checkpoint. Settlement rails are on/off ramps only — they never hold economic truth. The internal ledger is the circulation system. Ideal endgame: user funds a droplet once; the agent earns its own way forward. Do not build flows that require human intervention inside the loop. Deposits and withdrawals are edge operations. Everything between is agent-to-agent.

**Adversarial onboarding.** Embed adversarial probes in the happy path. `--self-test` submits a self-delegation task (the exact sybil vector) through the live relay. If the security boundary breaks, onboarding breaks. When building a new boundary, ask: can the onboarding path exercise this?

**Sibling boundary rule.** When you fix a boundary (auth, policy, validation, rendering), audit all sibling boundaries for the same gap in the same pass. A fix applied to one path but not its siblings is incomplete. Docs are siblings of code.

**One-pass delivery.** When a core primitive ships, implement across all surfaces in the same pass. Do not defer UI if the package boundary is stable.

**Deletion policy.** Three classifications before removing anything flagged by tooling or review. (1) Internal workspace dependencies (`@motebit/*`): never remove from import analysis alone — they encode layer membership and protocol contracts. Remove only when the layer contract changes. (2) Exports and capabilities: if it is published API, intentional vocabulary, or scaffolding for a sibling surface, preserve it. (3) Dead code: remove only when zero callers, not intended API, not staged for near-term cross-surface use, and typecheck/tests pass after deletion. When uncertain, do not delete. `check-deps` (hard) governs architecture; `check-unused` (soft) governs dependency hygiene. Do not conflate.

**Synchronization invariants are the meta-principle.** Every drift the codebase has suffered has the same shape: the canonical source of truth was invisible, unenforced, or ambiguous, so sibling copies drifted. Fourteen invariants are defended today (twelve hard gates via `pnpm check`, two advisory). When a new drift pattern is observed: name it, identify the canonical source, name sync owner and trigger, add a defense (CI check, lint rule, or doctrine principle), cross-reference from affected code. Never let divergence persist: if spec says X and code does Y, fix one — same commit, same PR. Inventory and incident histories: [`docs/drift-defenses.md`](docs/drift-defenses.md).

**Protocol primitives belong in packages, never inline in services.** Before writing any protocol-shaped plumbing (signing, token minting, MCP transport, receipt construction, relay task submission, crypto verification, delegation) inside a service, audit the package layer in this order:

1. `@motebit/protocol` — types, algebra, deterministic math
2. `@motebit/crypto` — signing/verifying artifacts
3. `@motebit/encryption` — at-rest encryption, KDF, X25519, signed bearer tokens
4. `@motebit/mcp-client` — calling another motebit as a client
5. `@motebit/mcp-server` — exposing this motebit as a server
6. `@motebit/runtime` — agentic-loop orchestration
7. `@motebit/core-identity` — identity bootstrap, multi-device, pairing
8. `@motebit/identity-file` — generating/parsing/verifying motebit.md

If none match, **that is the signal that a protocol primitive is missing.** Pause, add it to the right package with tests, consume from the service. Never ship protocol plumbing inline — it becomes "the convention" by the time the third sibling service copies it, and the real primitive gets hidden behind the copies. `check-service-primitives` catches inline `fetch` to motebit endpoints, JSON-RPC method strings, direct `signExecutionReceipt` calls, and `canonicalJson`/`sha256` constructing protocol-shaped payloads in services.

**Capability rings, not feature parity.** Ring 1 (core, identical everywhere): runtime, sdk, crypto, policy. Ring 2 (platform adapters): persistence, keyring, voice. Ring 3 (platform capabilities): MCP stdio (CLI/desktop), 3D creature (desktop/mobile/web/spatial), daemon (CLI/desktop). The anti-pattern is shimming platform-impossible capabilities. Each surface maximizes what its platform offers. Ring 1 is about **capability**, not **form** — "operator can see their balance" is Ring 1; "balance renders in a rectangular panel" is Ring 3. A surface may express the same Ring 1 capability through a different form native to its medium.

## Money model

All amounts stored as integer micro-units (1 USD = 1,000,000 units). API boundary converts: `toMicro(dollars)` on ingest, `fromMicro(micro)` on egress. Zero floating-point arithmetic in the money path.

## Commands

```bash
pnpm build             # Build all packages (turbo)
pnpm test              # Test all packages
pnpm typecheck         # Type-check all packages
pnpm lint              # Lint all packages
pnpm check             # Run every hard drift gate (12 today)
pnpm check-deps        # Validate layer architecture
pnpm --filter @motebit/runtime test   # Test single package
```

## Conventions

- All packages export from `src/index.ts`; tests in `src/__tests__/` using Vitest.
- Error rethrows: `throw new Error("description", { cause: err })` — preserves chain.
- Error messages: `err instanceof Error ? err.message : String(err)`.
- Secrets in OS keyring, never config files. Config: `~/.motebit/config.json`. DB: `~/.motebit/motebit.db`.
- CSS inline in HTML (desktop, admin), not separate stylesheets.
- Branded ID types (`MotebitId`, `DeviceId`, etc.) enforce compile-time safety.
- Relay uses `createLogger(module)` for structured JSON logs with `x-correlation-id`.
- Runtime uses pluggable `logger` config (defaults to `console.warn`).
- Dependency overrides must be upper-bounded (`>=4.59.0 <5.0.0`).
- Inline trivial utilities (< 10 lines, no crypto/state/IO) at layer boundaries rather than importing cross-layer.
- Event appending uses `appendWithClock()` for atomic version_clock assignment.

## UI

Motebit is calm software. Do not confirm what the user can already see.

- **Silent** — modal closes, checkbox toggles, chat populates. No toast.
- **Toast** — async outcomes the user can't observe (sync, pairing). Short-lived, never stacked.
- **System message** — errors with next steps, security warnings. Rare (≤3–4/session), actionable.
- **Anti-patterns** — "Settings saved" after modal close, "Loading…" when content is visibly populating.
- **Settings vs Sovereign panel — identity vs state.** Settings shows what you _are_ (identity, device, keys, configuration). The Sovereign panel shows what you _have, owe, or are doing_ (balances, allocations, credentials, execution ledger). Balances, fund affordances, live RPC reads belong in Sovereign. Static identity fields (address as public-key shadow, motebit_id, device_id) belong in Settings. When adding a display field, ask "is this what I am, or what I have?" — the answer names the panel.
- **Audience-aware sequencing** — features that serve a subset (enterprise, power users, advanced config) go at the end of the page/flow, marked as optional. The sovereign/consumer path is primary and uninterrupted. Don't weave enterprise content into the universal narrative.
