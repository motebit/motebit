# Changelog

All notable changes to the published packages are documented here. This project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- W3C `did:key` DID interoperability across all identity surfaces — every Ed25519 public key now derives a self-resolving Decentralized Identifier
- `motebit id` CLI subcommand — display identity card (motebit_id, did:key, public key, device) without file verification
- `did` field in `VerifyResult` (verify), `AgentCapabilities` (SDK), MCP `motebit_identity` tool, and API capabilities/discover endpoints
- DID display in desktop settings, mobile settings, and admin dashboard
- Spec §10: DID Interoperability section in `identity-v1.md`
- **Memory compounding** — reinforced memories gain stability (half-life ×1.5 per reinforcement, capped at 365 days), making important knowledge durable instead of just louder
- **Hebbian co-retrieval** — memories retrieved together automatically form `Related` edges (opt-in via `strengthenCoRetrieved`), building associative structure through natural use
- **Retrieval recency** — `retrieve()` now updates `last_accessed` on returned nodes, keeping frequently-used memories fresh in future rankings
- **Synthesis lineage** — episodic consolidation creates `PartOf` edges from synthesized semantic memories to their source nodes before tombstoning, preserving the "Eureka" trail
- **CLI `/memories` enhanced** — shows memory type, half-life (days), edge count, compounding indicator (arrow for reinforced memories), and pinned status
- **CLI `/graph` command** — memory graph health summary: node/edge counts, type breakdown, avg half-life, compounded count, edge density, intelligence gradient
- **Admin Memory Graph** — edge colors by relation type (green=reinforces, blue=related, purple=part_of, yellow=supersedes), compounding ring on reinforced nodes, half-life and type in tooltip
- **Mobile memory browser** — half-life durability indicator with compounding arrow
- **MCP `motebit_recall`** — returns `half_life_days`, `memory_type`, and `created_at` alongside existing fields
- **Curiosity-driven memory maintenance** — agent notices fading memories (confidence decaying below threshold) and surfaces them for user confirmation before they expire
- **Conversation-path curiosity** — fading memories injected into AI context pack so the agent can organically reference what it's about to forget
- **Intelligence gradient** — composite 0-1 score from 8 sub-metrics (knowledge density, knowledge quality, graph connectivity, temporal stability, retrieval quality, interaction efficiency, tool efficiency, curiosity pressure) computed during housekeeping
- **Behavioral metrics** — interaction efficiency (iterations per turn) and tool efficiency (success ratio) tracked per housekeeping cycle and fed into the intelligence gradient
- **SDK type-split** — `MemoryContent` (wire type for sync/API) separated from `MemoryNode` (internal with embeddings), preventing embedding leakage across boundaries
- **Continuous reputation scoring** — Beta-binomial smoothed reputation for agent trust, replacing raw success/fail counts with Bayesian posterior estimates
- **Bicameral trust model** — curiosity pressure (epistemic drive) + Beta-binomial reputation (pragmatic trust) as dual signals for agent evaluation, with audit-derived behavioral stats and cost attribution
- **Agent trust wired to all surfaces** — trust levels, reputation scores, and task history visible in CLI (`/agents`), desktop, mobile, admin dashboard, and web app
- **Branded ID types** — `MotebitId`, `DeviceId`, `NodeId`, `GoalId`, `EventId`, `ConversationId`, `PlanId`, `AllocationId`, `SettlementId`, `ListingId`, `ProposalId` enforce compile-time safety at API boundaries
- **Error cause chains** — all rethrows use `{ cause: err }` for full stack trace preservation across fail-closed boundaries
- **Platform convergence** — web app gains MCP HTTP connections, one-shot goal execution, IDB-persisted plans/trust/gradient; browser-persistence gaps closed
- **Cross-device goal delegation** — Temporal-style capability routing: relay matches task requirements to agent capabilities, routes delegated steps to capable remote agents
- **Reconnect recovery** — orphaned delegated steps automatically resume on WebSocket reconnection
- **Cross-device plan sync** — plan visibility across devices without orchestrator election; centralized plan event logging in runtime with step query indexing
- **Delegation E2E tests** — full relay pipeline integration tests: submit task, route, execute, receipt, trust accumulation
- **Execution ledger** — `motebit/execution-ledger@1.0` spec: cryptographic proof-of-execution with `replayGoal()` for deterministic replay from signed receipts
- **Capability market** — `@motebit/market` package: `scoreCandidate()` with 6 weighted sub-scores (trust, success rate, latency, price efficiency, capability match, availability), `rankCandidates()` with configurable top-N selection, `allocateBudget()`, `estimateCost()`, `settleOnReceipt()` with pluggable settlement adapters
- **Market reputation** — `computeServiceReputation()` unifies Beta-binomial smoothing from policy with market-level reputation snapshots
- **Scored routing** — relay uses `rankCandidates()` instead of broadcast for task delegation; best-fit agent selected by composite score
- **Collaborative planning** — cross-motebit plan proposals with negotiation protocol: propose, accept/reject/counter, coordinated execution, step-result fan-out, proposal expiry; 6 new relay endpoints, 3 relay tables, WebSocket fan-out for all proposal lifecycle events
- **Active inference precision** — `computePrecision()` maps intelligence gradient to precision weights via sigmoid; gradient feeds back into curiosity (state vector), retrieval (memory graph scoring weights), and routing (market config exploration weight). Closes the loop: model evidence → confidence → action selection
- **Self-model summary** — `summarizeGradientHistory()` produces natural-language self-assessment from gradient snapshots: trajectory, strengths, weaknesses, and active inference posture. No LLM calls — the agent narrates its own growth from the numbers alone
- **Self-evidencing thesis test** — integration test proving the complete feedback loop: empty agent → memory accumulates → gradient rises → precision tightens → retrieval weights shift → quality improves → gradient rises further → agent narrates its own growth

### Fixed

- Dead `hasExplicitChoice` variable in web and desktop theme (sibling boundary)
- Schema drift: migration-added columns moved out of base `SCHEMA_TABLES` definitions
- Missing `TurnResult` behavioral fields in plan-execution test mock
- CLI `--help` missing `/graph` and `/curious` commands (sibling boundary)
- Relay auth: listing ownership check, proposal withdraw initiator check, proposal list scoped to caller, step-result participant check
- MCP server: `personal` sensitivity now correctly excluded from external callers (was leaking through)
- Execution ledger event types added to relay `planEventTypes` (were causing unrecognized-type errors)

### Changed

- Default model updated to `claude-sonnet-4-5-20250929` across tests and docs
- Prompt tuning: internal stats stripped from maintenance context, natural tone anchored
- Trust context packing: agent trust records included in AI context for trust-aware responses

## [0.2.2] - 2026-03-12

### Fixed

- Desktop build: removed unused variable that broke CI typecheck

## [0.2.0] - 2026-03-10

### Added

- `motebit` CLI published to npm — REPL, daemon mode, operator console, MCP server mode
- `@motebit/sdk` published to npm — core protocol types (MIT)
- Documentation site at docs.motebit.com — 13 guide pages covering identity, governance, memory, delegation, architecture
- Social preview banner for GitHub repository
- Public repo infrastructure: CONTRIBUTING.md, SECURITY.md, issue templates, CODEOWNERS

### Fixed

- Three security bugs: salted PIN hash, stale caller identity cache, WebSocket fan-out guard
- Mobile app entry point and Metro config
- Sync relay Docker deployment (sql.js fallback)
- GitHub URLs unified under motebit org after repo transfer

### Changed

- Dual-license structure: BSL 1.1 (implementation) + MIT (protocol layer)
- Full codebase formatted with Prettier
- All lint errors resolved (down to ~466 warnings)

## [0.1.2] - 2026-03-09

### Fixed

- `create-motebit`: fixed dependency on unpublished package; use `@motebit/verify` directly

## [0.1.1] - 2026-03-09

### Fixed

- `create-motebit`: corrected license from Community License to MIT

## [0.1.0] - 2026-03-08

### Added

- `@motebit/verify`: Ed25519 signature verification for `motebit.md` identity files
- `create-motebit`: CLI scaffolder (`npm create motebit`) for generating signed agent identities
- `spec/identity-v1.md`: open specification for the `motebit/identity@1.0` file format
- npm provenance enabled for supply chain transparency
