# Motebit

A motebit is a droplet of intelligence under surface tension.

Every AI product owns the intelligence and rents you a session. Motebit inverts that. You own the identity. The intelligence is pluggable. The body is yours.

The body is passive. The interior is active. The agent lives inside the droplet — memory, trust, identity, tool use are interior structures. The policy gate, the privacy layer, the governance — these are the surface tension. The form doesn't change. The interior accumulates. Maximum interiority, minimum display.

Read `DROPLET.md` for the physics of form. Read `THE_SOVEREIGN_INTERIOR.md` for the identity thesis. Read `THE_METABOLIC_PRINCIPLE.md` for what to build vs. what to absorb. Every visual and behavioral decision derives from droplet physics. If it can't be traced to surface tension, it doesn't belong.

## The Three Things No One Else Is Building Together

1. **Persistent sovereign identity** — not a session token, a cryptographic entity that exists across time and devices
2. **Accumulated trust** — memory, state history, audit trails that make the agent more capable the longer it runs
3. **Governance at the boundary** — sensitivity-aware privacy and policy that controls what crosses the surface

MCP defines capability but says nothing about who the agent is. A2A defines communication but has no trust accumulation. x402/AP2 defines payment but has no identity. Motebit is the missing layer underneath all three. The relay bridges all four protocols (MCP, A2A, x402, AP2) through a single economic checkpoint — identity resolved, execution verified, money finalized.

## Architecture

pnpm monorepo, Turborepo orchestration, TypeScript throughout. Node >= 20, pnpm 9.15.

**7-layer dependency enforcement** validated by `pnpm check-deps` in CI. Layer violations break the build.

```
apps/
  cli/         Operator console (npm: motebit). REPL, daemon, delegation, MCP server mode
  desktop/     Tauri glass droplet. Three.js creature, identity, operator mode
  mobile/      React Native + Expo. Full-featured, tab-based UI
  web/         Browser entry point. IndexedDB identity, free proxy, zero install
  admin/       React + Vite dashboard. 15-tab real-time monitoring
  spatial/     AR/VR. 6DOF orbital dynamics, WebXR, gesture recognition
  docs/        Next.js documentation portal (docs.motebit.com)
  identity/    Identity management app. Vite, TypeScript

packages/
  protocol/           Network protocol types (Layer 0, MIT, 0 deps)
  sdk/                Full type vocabulary, re-exports protocol (Layer 0, MIT)
  verify/             Standalone identity verifier (Layer 0, MIT, 0 deps)
  create-motebit/     CLI scaffolder: npm create motebit (Layer 0, MIT)
  crypto/             Ed25519, AES-256-GCM, PBKDF2, signed tokens, W3C VC 2.0
  gradient/           Self-measurement: "What am I?" Pure narrative from gradient data (Layer 1, BSL)
  semiring/           Trust Semiring Algebra — generic computation graph for routing
  policy/             PolicyGate, MemoryGovernor, injection defense
  policy-invariants/  Clamping rules, state bounds validation
  event-log/          Append-only event sourcing with version clocks
  tools/              ToolRegistry, builtin tools, MCP tool merge
  core-identity/      UUID v7, multi-device registration, Ed25519 binding
  memory-graph/       Semantic memory, cosine similarity, half-life decay, graph edges
  state-vector/       Tick-based EMA smoothing, hysteresis, 60 FPS interpolation
  behavior-engine/    State → BehaviorCues (deterministic, pure)
  render-engine/      Droplet geometry, glass material, ThreeJS adapter
  sync-engine/        Multi-device sync: HTTP/WebSocket, conflict detection, backoff
  mcp-client/         MCP stdio/HTTP client, tool discovery
  mcp-server/         MCP server adapter, synthetic tools, bearer auth
  identity-file/      Generate, parse, verify motebit.md identity files
  ai-core/            Pluggable providers (Cloud, Ollama, Hybrid), agentic turn loop
  privacy-layer/      Retention rules, deletion certificates, data export
  persistence/        SQLite (WAL mode), adapters for all storage types
  browser-persistence/ IndexedDB adapters for web/spatial
  planner/            PlanEngine: goal decomposition, plan-level reflection
  reflection/         Adaptive intelligence: "What should I change?" LLM reflection engine (Layer 4, BSL)
  voice/              VAD, STT, TTS adapters
  runtime/            Agent orchestrator: agentic turn loop, delegation, execution ledger (BSL)
  market/             Budget, settlement, graph-based routing, credential weighting
  github-action/      GitHub Action for identity verification

spec/
  identity-v1.md           motebit/identity@1.0 — file format, signing, succession
  execution-ledger-v1.md   motebit/execution-ledger@1.0 — timeline, signed manifests
  relay-federation-v1.md   motebit/relay-federation@1.0 — peering, discovery, routing
  market-v1.md             motebit/market@1.0 — budget, settlement, fees, trust, routing
  credential-v1.md         motebit/credential@1.0 — W3C VC 2.0, issuance, weighting, revocation

services/
  api/          Relay server (modules: index, federation, task-routing,
                credentials, pairing, data-sync, accounts, a2a-bridge, logger)
  code-review/  Code review agent ($0.50/review, Claude-powered, signed receipts)
  web-search/   Reference MCP service (single-hop + multi-hop delegation proof)
  read-url/     Minimal read-url service (second hop in multi-hop proof)
  proxy/        Vercel edge CORS proxy for web app (Anthropic API, fetch, embed)
  summarize/    Conversation summarization
  embed/        ONNX embedding service
```

## Principles

These are not suggestions. They are the architectural invariants that make the monorepo coherent. Violating them breaks CI, breaks the product, or breaks the thesis.

**Metabolic principle.** Do not build what the medium already carries. Absorb solved problems (VAD, STT, embeddings, inference) through adapter boundaries with fallback chains. Build the enzymes (identity, memory, trust, governance, agentic loops), not the glucose (raw capabilities).

**Adapter pattern everywhere.** All I/O abstracted. In-memory for tests, SQLite/Tauri/Expo/IndexedDB for production. The adapter is the surface tension boundary in code: the interior must not bind to a specific provider.

**Fail-closed privacy.** Deny on error. Sensitivity levels (none/personal/medical/financial/secret) enforced at storage, retrieval, sync, and context boundaries. Medical/financial/secret memories never reach external AI providers. Relay sync redacts sensitive content. Retention rules enforced in housekeeping with deletion certificates.

**Proof composability.** Canonical JSON → SHA-256 → Ed25519 verify. Always. External anchoring (blockchain, IPFS, x402) is additive, never gatekeeping. `@motebit/verify` works standalone with zero monorepo deps. Do not add verification paths that require external systems.

**Semiring algebra for routing.** Agent network routing is algebraic. `Semiring<T>` interface, concrete semirings (Trust, Cost, Latency, Reliability, RegulatoryRisk), product combinators, `WeightedDigraph<T>`, generic traversal. Swap the semiring to change what "best path" means. New routing concerns require only a new semiring definition — zero new algorithms. Provenance tracks why a route was chosen, signed into the execution ledger.

**Economic loop principle.** The relay is the economy's ledger, the rails are the membrane, and agents are the workers and spenders inside the loop. Users fund at the edges (Stripe, Bridge, wallet deposit). Agents transact inside the relay via virtual accounts — allocate, execute, settle, earn, delegate, earn again. The 5% platform fee is extracted at each settlement checkpoint. Settlement rails (fiat, protocol, direct asset, orchestration) are on/off ramps only — they never hold economic truth. The internal ledger is the circulation system. The ideal endgame: user funds a droplet once, the agent earns its own way forward. Not every agent will be self-sustaining immediately, but the architecture must never prevent it. Do not build flows that require human intervention inside the loop. Deposits and withdrawals are edge operations. Everything between is agent-to-agent.

**Adversarial onboarding.** Embed adversarial probes in the happy path. `--self-test` submits a self-delegation task (the exact sybil attack vector) through the live relay. If the security boundary breaks, onboarding breaks. When building new boundaries, ask: can the onboarding path exercise this?

**Sibling boundary rule.** When you fix a boundary (auth, policy, validation, rendering), audit all sibling boundaries for the same gap in the same pass. A fix applied to one path but not its siblings is incomplete. Docs are siblings of code.

**One-pass delivery.** When a core primitive ships, implement across all surfaces in the same pass. Do not defer UI if the package boundary is stable.

**Capability rings, not feature parity.** Ring 1 (core, identical everywhere): runtime, sdk, crypto, policy. Ring 2 (platform adapters): persistence, keyring, voice. Ring 3 (platform capabilities): MCP stdio (CLI/desktop only), 3D creature (desktop/mobile/web/spatial), daemon (CLI/desktop). The anti-pattern is shimming platform-impossible capabilities. Each surface maximizes what its platform offers.

**Deletion policy.** Three classifications before removing anything flagged by tooling or review. (1) Internal workspace dependencies (`@motebit/*`): never remove from import analysis alone — they encode layer membership and protocol contracts, not just usage. Remove only when the layer contract itself changes. (2) Exports and capabilities: if it is published API, intentional vocabulary (e.g. semantic color aliases), or scaffolding for a sibling surface, preserve it. (3) Dead code: remove only when there are zero callers, it is not part of an intended API surface, it is not staged for near-term cross-surface use, and typecheck/tests pass after deletion. When uncertain, do not delete. `check-deps` (hard CI gate) governs architecture. `check-unused` (soft signal) governs external dependency hygiene. The two tools govern different domains and must not be conflated.

## Security Boundaries

**Sybil defense (five layers).** Self-delegation must not farm trust. Layer 1: skip trust record update when delegator === worker. Layer 2: aggregation ignores self-issued credentials. Layer 3: minimum issuer trust threshold (0.05) excludes new sybil identities. Layer 4: credential revocation check excludes compromised issuers. Layer 5: reject self-issued credentials at submission endpoint. Self-delegation executes and settles budget — it just produces no trust signal.

**Memory injection defense (two layers).** Layer 1 — formation gate: `ContentSanitizer` scans candidates, injection-flagged get confidence capped to 0.3 (fast decay, not rejected outright). Layer 2 — context boundary: `[MEMORY_DATA]...[/MEMORY_DATA]` wrapping with escape prevention. System prompt treats memory data identically to external data.

**Receipt economic binding.** `relay_task_id` in every `ExecutionReceipt`, inside the Ed25519 signature. Relay verifies binding at settlement. Prevents cross-task replay. Required — no legacy fallback.

**Token audience binding.** `expectedAudience` is required on all `verifySignedTokenForDevice` calls. Tokens without `aud` are rejected. Prevents cross-endpoint replay.

**Budget-gated delegation.** estimateCost → allocateBudget → settleOnReceipt. HTTP 402 if insufficient. Per-submitter task queue limit (1000/agent, HTTP 429) prevents fair-share starvation. Multi-hop: each hop settled independently from nested `delegation_receipts`.

**Rate limiting.** 5-tier fixed-window per IP (auth 30/min, read 60/min, write 30/min, public 20/min, expensive 10/min). Per-connection WebSocket (100 msg/10s). Per-peer federation (30 req/min). Task queue hard-capped at 100K.

**PBKDF2 iterations.** 600K for user-provided passphrases (CLI identity, relay key encryption). 100K for operator PIN (rate-limiting is primary defense, PIN entry is frequent).

**Signed succession.** Key rotation without centralized revocation. Old keypair signs tombstone declaring new keypair. Both keys sign canonical payload. Chains verify end-to-end. Succession records must be within 15-minute freshness window (±1 min clock skew) at the relay.

**Guardian attestation.** Organizational custody via Ed25519 guardian key. Guardian key MUST NOT equal identity key (enforced at generation and registration). Registration with `guardian_public_key` requires `guardian_attestation` — a signature by the guardian's private key over `{action:"guardian_attestation",guardian_public_key,motebit_id}`. Prevents fake organizational claims. Same guardian key = organizational trust baseline (0.35) in semiring routing — identity is necessary, not sufficient.

**Federation circuit breaker.** Per-peer forward tracking with automatic suspension at 50% failure rate over 6+ samples. Heartbeat handles liveness (3 missed → suspend, 5 → remove). Circuit breaker handles forward-path health.

**Credential source boundary.** Third-party MCP server auth uses `CredentialSource` adapter (`getCredential(CredentialRequest) → string | null`), not static bearer tokens. Credentials resolve **per HTTP request** via custom `fetch` injection — not at connect time. JSON-RPC body is parsed to extract `toolName` from `tools/call` requests, enabling per-tool scoped credentials. `CredentialRequest` carries `serverUrl`, `toolName?`, `scope?`, `agentId?`. Two built-in implementations: `StaticCredentialSource` (wraps legacy `authToken`), `KeyringCredentialSource` (reads from `KeyringAdapter` at call time, default key `mcp_credential:{hostname}:{port}`). Fail-closed: thrown errors propagate per-request, null skips auth header. Motebit-to-motebit auth (`createCallerToken`) uses static `requestInit` — highest precedence, unaffected. Interface + implementations live in `mcp-client` (Layer 2). Vault implementations belong in higher-layer adapters. The MCP client does not persist, rotate, or cache credentials.

**Server verification boundary.** Third-party MCP servers are verified via `ServerVerifier` adapter (`verify(config, tools) → VerificationResult`), run automatically during `connect()` after tool discovery. Fail-closed: `ok:false` or thrown errors disconnect. Four built-in implementations: `ManifestPinningVerifier` (fail-closed, rejects on manifest change), `AdvisoryManifestVerifier` (always accepts, revokes trust on change — used by desktop/web/mobile/spatial), `TlsCertificateVerifier` (pins server TLS cert SHA-256 fingerprint, Node-only via `node:tls` probe, separate file `tls-verifier.ts`), `CompositeServerVerifier` (chains multiple verifiers, all must pass, merges `configUpdates`). `tlsCertFingerprint` on `McpServerConfig` stores the pinned value. Cert lifecycle doctrine: (1) trust-on-first-use is acceptable only for first contact — once pinned, the pin is law; (2) unexpected cert change must never silently pass — fail-closed, always; (3) continuity of trust after rotation requires explicit operator approval, alternate cryptographic proof, or a defined grace rule — never automatic silent repin; (4) certificate rotation is an operational continuity event, not an identity reset — the server's accumulated trust survives rotation if the operator attests continuity; (5) policy must be explicit and auditable per integration — no global "trust all rotations" escape hatch. Exact repin mechanism, grace semantics, and operator UX crystallize when real production rotation forces the final shape. Proven end-to-end against GitHub's remote MCP server (`api.githubcopilot.com`). All 5 surface apps use ServerVerifier instead of manual `checkManifest()` boilerplate.

**WebSocket post-connect auth.** Sync-engine WebSocket adapter sends auth tokens as a post-connect frame (`{ type: "auth", token }`) instead of URL query params. Relay validates and responds with `{ type: "auth_result", ok }`. Fail-closed: rejection or 5-second timeout disconnects. Legacy `?token=` query param still accepted by relay for backwards compat. Unauthenticated connections (no token configured) skip the auth frame.

**MCP server credential verification.** Inbound non-motebit auth uses `CredentialVerifier` adapter (`verify(token) → boolean`), not hardcoded string comparison. `StaticTokenVerifier` wraps legacy `authToken` for backwards compat. `credentialVerifier` takes precedence over `authToken`. Fail-closed: false or thrown error = 401. Motebit signed token path (`verifySignedToken`, `resolveCallerKey`, `onCallerVerified`) is untouched.

**Sync-engine credential source.** All 4 sync adapters (HTTP, WebSocket, PlanSync, ConversationSync) accept `credentialSource?: CredentialSource` alongside legacy `authToken`. HTTP adapters resolve per-request via async `headers()`. WebSocket resolves on each connect/reconnect. Interface inlined in sync-engine to avoid cross-layer dep on mcp-client.

**Settlement rails boundary.** External money movement uses `SettlementRail` adapter interface in `@motebit/protocol` (Layer 0). Four rail types classify how money moves, not which vendor moves it: `fiat` (traditional processor — Stripe Checkout), `protocol` (HTTP-native agent payment protocols — MPP, x402), `direct_asset` (direct onchain stablecoin transfer — USDC on Tempo/Base/Solana), `orchestration` (fiat↔crypto bridging — Bridge). The relay's internal ledger (virtual accounts, micro-units) handles real-time balance tracking. The rail handles withdrawals and payment proof. `PaymentProof` carries reference, railType, network, confirmedAt for audit. Not all rails support deposits: `SettlementRail` is the base interface (withdraw, attachProof, isAvailable). `DepositableSettlementRail extends SettlementRail` adds `deposit()` for rails that accept proactive deposits (Stripe, future onchain). `supportsDeposit` boolean discriminant enables runtime narrowing; `isDepositableRail()` type guard in `@motebit/protocol`. Protocol rails (x402, MPP) are pay-per-request — money moves at the HTTP boundary, not through the rail, so they implement only the base interface. `DepositResult` may return a redirectUrl for interactive flows (Stripe Checkout). The relay picks the rail at routing time based on what the counterparty accepts — protocol, provider, and network are properties of the implementation, not the interface. Three concrete implementations: `StripeSettlementRail` (fiat, depositable, Stripe Checkout + webhook), `X402SettlementRail` (protocol, non-depositable, x402 facilitator), `BridgeSettlementRail` (orchestration, non-depositable, Bridge.xyz transfers). Stripe and x402 registered in `SettlementRailRegistry` at relay startup. Bridge registered when Bridge API key is configured.

**BridgeSettlementRail.** First orchestration rail. Wraps Bridge.xyz transfer API behind `SettlementRail`. `railType: "orchestration"`, `name: "bridge"`, `supportsDeposit: false`. Two withdrawal paths: (1) crypto→crypto with wallet destination — polls briefly for `payment_processed`, returns confirmed `WithdrawalResult` with `destination_tx_hash` as proof. (2) crypto→fiat or slow paths — returns pending `WithdrawalResult` with `confirmedAt: 0` and Bridge transfer ID as reference (same pattern as Stripe pending withdrawals). Completion via webhook. `BridgeClient` interface injected (glucose): `createTransfer()`, `getTransfer()`, `isReachable()`. Configurable poll attempts and interval. Lives in `services/api/src/settlement-rails/bridge-rail.ts`.

**X402SettlementRail.** Wraps x402 facilitator behind `SettlementRail` interface. `railType: "protocol"`, `name: "x402"`, `supportsDeposit: false`. x402 is pay-per-request: deposits happen at the HTTP boundary via x402 middleware, not the rail — the base `SettlementRail` interface has no `deposit()` method, so no throwing stub needed. `withdraw()` settles via the facilitator client — constructs payment payload, calls `facilitator.settle()`, returns `WithdrawalResult` with tx hash proof. `isAvailable()` checks facilitator `/supported` endpoint. `attachProof()` records x402 tx hash + CAIP-2 network — called by the task submission handler after x402 auto-deposit succeeds, achieving sibling parity with the Stripe webhook → `stripeRail.attachProof()` flow. Constructor takes `X402FacilitatorClient` interface (satisfied by `HTTPFacilitatorClient` from `@x402/core/server`). Lives in `services/api/src/settlement-rails/x402-rail.ts`.

**Settlement proof persistence.** `attachProof()` on both rails persists proofs to `relay_settlement_proofs` table via an `onProofAttached` callback injected at construction. The relay owns storage; rails are adapters. Table schema: `(settlement_id, reference, rail_type, rail_name, network, confirmed_at, created_at)` with composite PK `(settlement_id, reference)`. `storeSettlementProof()` is idempotent (INSERT OR IGNORE). `getSettlementProofs()` queries by settlement ID. Reconciliation check #6: every completed withdrawal with a `payout_reference` must have a matching proof in `relay_settlement_proofs`.

**Withdrawal through rails.** Withdrawals flow through the rail boundary at two points. (1) Admin-complete: when admin marks a withdrawal completed, the admin-complete endpoint accepts optional `rail` and `network` fields — if provided, calls `rail.attachProof()` with the payout reference. Manual/off-rail payouts omit the field; the signed relay receipt is the audit trail. (2) Automated x402 withdrawal: when an agent requests withdrawal to a wallet address (`/^0x[0-9a-fA-F]{40}$/`) and the x402 rail is available, the relay attempts immediate settlement via `x402Rail.withdraw()`. On success, auto-completes the withdrawal with signed receipt and proof attachment. On failure, falls back to manual pending (fail-safe — funds already held by `requestWithdrawal`). This achieves full money-flow parity: deposits, proofs, and withdrawals all flow through the rail boundary.

**VaultCredentialSource.** Implements `CredentialSource` for enterprise deployments where secrets live in external vaults (HashiCorp Vault, AWS Secrets Manager, 1Password Connect). Constructor takes `VaultClient` interface (`{ get(key: string): Promise<string | null> }`) — the vault is glucose, the adapter is the enzyme. Default key format: `mcp/{serverName}`. Custom key resolver injectable. Resolves per-request, never caches. Fail-closed: vault errors propagate. Lives in `packages/mcp-client` alongside `StaticCredentialSource` and `KeyringCredentialSource`. Four built-in `CredentialSource` implementations: `StaticCredentialSource` (static token), `KeyringCredentialSource` (OS keyring), `VaultCredentialSource` (external vault), `OAuthCredentialSource` (OAuth 2.0 with token lifecycle).

**OAuthCredentialSource.** First `CredentialSource` with internal mutable state. Manages the OAuth 2.0 token lifecycle: initial acquisition via `OAuthTokenProvider.getToken()`, refresh via `refresh()`, expiry tracking, refresh-ahead (configurable buffer, default 60s). Concurrent callers share a single in-flight refresh (dedup via promise). Fail-closed: refresh errors propagate. When no refresh token is available, falls back to re-acquisition via `getToken()`. The `OAuthTokenProvider` interface is injected — GitHub OAuth, Stripe Connect, generic OIDC implement it. The source manages lifecycle only; it does not know about authorization endpoints, client IDs, or scopes. `OAuthToken` carries `accessToken`, optional `refreshToken`, and `expiresAt` (absolute ms timestamp). Lives in `packages/mcp-client` alongside siblings. First concrete provider: `GitHubOAuthTokenProvider` (`github-oauth.ts`) — wraps GitHub's `POST /login/oauth/access_token` endpoint with refresh token rotation (old token invalidated on each refresh). Converts `expires_in` to absolute `expiresAt`. Injected `fetch` for testability. Config: `clientId`, optional `clientSecret` (not required for device flow), `initialRefreshToken`. Exported from barrel.

## Commands

```bash
pnpm run build          # Build all packages (turbo)
pnpm run test           # Test all packages
pnpm run typecheck      # Type-check all packages
pnpm run lint           # Lint all packages
pnpm run check-deps     # Validate layer architecture
pnpm --filter @motebit/runtime test   # Test single package
```

## CLI Market Commands

Two-sided market: any motebit can pay for tasks and earn from them.

```bash
# Pay side
motebit fund <amount>                  # Deposit via Stripe Checkout (opens browser)
motebit delegate "<prompt>"            # Discover worker, submit task, get result
  --capability <cap>                   #   Required capability (default: web_search)
  --target <id>                        #   Skip discovery, delegate to specific agent
  --budget <amount>                    #   Max spend in USD
  --plan                               #   Decompose into steps, delegate each to specialists
motebit balance                        # Show account balance + recent transactions
motebit withdraw <amount>              # Request withdrawal

# Earn side
motebit run --price 0.50               # Accept tasks at $0.50/task (daemon mode)
motebit serve --price 0.50             # Accept tasks at $0.50/task (MCP server mode)
```

**Money model.** All amounts stored as integer micro-units (1 USD = 1,000,000 units). API boundary converts: `toMicro(dollars)` on ingest, `fromMicro(micro)` on egress. Zero floating-point arithmetic in the money path.

## Conventions

- All packages export from `src/index.ts`
- Tests in `src/__tests__/` using vitest
- Error rethrows: `throw new Error("description", { cause: err })` — preserves chain
- Error messages: `err instanceof Error ? err.message : String(err)`
- Secrets in OS keyring, never config files. Config: `~/.motebit/config.json`. DB: `~/.motebit/motebit.db`
- CSS inline in HTML (desktop, admin), not separate stylesheets
- Branded ID types (`MotebitId`, `DeviceId`, etc.) enforce compile-time safety
- Relay uses `createLogger(module)` for structured JSON logs with `x-correlation-id`
- Runtime uses pluggable `logger` config (defaults to `console.warn`)
- Dependency overrides must be upper-bounded (`>=4.59.0 <5.0.0`)
- Inline trivial utilities (< 10 lines, no crypto/state/IO) at layer boundaries rather than importing cross-layer
- Event appending uses `appendWithClock()` for atomic version_clock assignment

## UI

Motebit is calm software. Do not confirm what the user can already see.

- **Silent** — modal closes, checkbox toggles, chat populates. No toast.
- **Toast** — async outcomes the user can't observe (sync, pairing). Short-lived, never stacked.
- **System message** — errors with next steps, security warnings. Rare (≤3-4/session), actionable.
- **Anti-patterns** — "Settings saved" after modal close, "Loading…" when content is visibly populating.
- **Audience-aware sequencing** — Features that serve a subset (enterprise, power users, advanced config) go at the end of the page/flow, marked as optional. The sovereign/consumer path is primary and uninterrupted. Don't weave enterprise content into the universal narrative.

## Published Packages

Five npm packages: four MIT (types + verification), one BSL (runtime):

- `@motebit/protocol` — Network protocol types (identity, receipts, credentials, settlement, trust algebra). MIT, 0 deps.
- `@motebit/sdk` — Full type vocabulary (re-exports protocol + product types). MIT, depends on protocol.
- `@motebit/verify` — Standalone identity verifier. MIT, 0 deps (noble bundled).
- `create-motebit` — Scaffold signed identity. MIT, zero-deps CLI. `npm create motebit`, `--agent` for runnable project.
- `motebit` — Operator console. BSL-1.1. REPL, daemon, MCP server, delegation, export/verify/rotate.
