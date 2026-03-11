# Motebit

A motebit is a droplet of intelligence under surface tension.

Every AI product today owns the intelligence and rents you a session. Motebit inverts that. You own the identity. The intelligence is pluggable. The body is yours.

A motebit is a persistent, cryptographically-anchored, sovereign agent — a vessel that connects to any intelligence provider, any tool ecosystem (MCP), and any device. The intelligence is a commodity. The identity, with its accumulated memory, trust, and governance, is the asset.

**The body is passive. The interior is active.** `DROPLET.md` derives the form from physics: the body has no agency, it breathes because droplets oscillate, it orbits because it is captured by the user's attentional field. But the thesis also establishes that glass transmits — the interior is visible without being added to the surface. The agent lives inside the droplet. Memory, trust, identity, tool use — these are interior structures. The policy gate, the privacy layer, the governance — these are the surface tension. The form doesn't change. The interior accumulates. Maximum interiority, minimum display. The physics of form and the architecture of function are the same principle operating at different scales.

**Position in the agentic economy.** MCP defines capability — what tools an agent can reach — but says nothing about who the agent is. There is no trust accumulation, no audit trail, no governance. Motebit is the missing layer: cryptographic identity (Ed25519 keypairs, device registration, signed tokens) that can prove who it is to any service, persistent memory that compounds instead of resetting, and policy governance that controls what crosses the surface.

**The three things no one else is building together:**

1. **Persistent sovereign identity** — not a session token, a cryptographic entity that exists across time and devices
2. **Accumulated trust** — memory, state history, audit trails that make the agent more capable the longer it runs
3. **Governance at the boundary** — sensitivity-aware privacy and policy that controls what crosses the surface

**Where the implementation stands.** The desktop app is the flagship (100%): identity bootstrap, operator mode, tool approval, sync relay, voice input, audio-reactive rendering, conversation summarization, memory retention enforcement, deletion certificates, goal execution, multi-device pairing, MCP discovery with manifest pinning. The CLI is the full operator console (100%): REPL chat, daemon mode with goal scheduling, tool approval queue, operator mode, `/summarize`, AI auto-titling, periodic housekeeping, and the `motebit export`/`verify` commands. The API sync relay (100%): event sync, conversation sync, device auth (master token + Ed25519 signed tokens), pairing protocol, plus admin query endpoints for state/memory/goals/conversations/devices/audit/plans. The admin dashboard (100%): 10-tab real-time monitoring (state, memory graph, behavior, events, audit, goals, plans, conversations, devices, intelligence gradient). Mobile is at full parity (100%): dual providers (Anthropic + Ollama + Hybrid fallback), plan-based goal execution, goal tools, /summarize, periodic housekeeping, approval queue UI, MCP per-server trust with manifest pinning. The public-facing standard ships as `create-motebit` (npm create motebit) and `@motebit/verify` — lightweight, zero-monorepo-dep packages that let anyone create and verify signed agent identities. The infrastructure (identity, crypto, policy, memory, sync) is built. The agentic surface that exposes it is next.

Read `DROPLET.md` for the full design thesis on form. Read `THE_SOVEREIGN_INTERIOR.md` for the identity thesis. Read `LIQUESCENTIA.md` for the world. Read `THE_MUSIC_OF_THE_MEDIUM.md` for the acoustic interface. Read `THE_METABOLIC_PRINCIPLE.md` for what to build vs. what to absorb. Every visual and behavioral decision derives from droplet physics. If it can't be traced to surface tension, it doesn't belong.

## Architecture

pnpm monorepo, Turborepo orchestration, TypeScript throughout. Node >= 20, pnpm 9.15.

```
apps/
  desktop/     Tauri (Rust + webview), Three.js creature, full identity/crypto/operator mode
  cli/         Node.js REPL, developer/debugging interface, same runtime
  mobile/      React Native + Expo, expo-gl + Three.js, full-featured
  admin/       React + Vite dashboard, real-time state/memory/audit monitoring
  spatial/     AR/VR positioning library, body-relative orbital mechanics, WebXR audio reactivity

packages/
  sdk/             Core types: MotebitState, BehaviorCues, MemoryNode, EventLogEntry, PolicyDecision, RenderSpec
  runtime/         MotebitRuntime orchestrator — wires all engines, exposes sendMessage/sendMessageStreaming
  ai-core/         Pluggable providers (CloudProvider, OllamaProvider, HybridProvider), agentic turn loop, context packing
  behavior-engine/ computeRawCues(state) → BehaviorCues, EMA smoothing, species constraints, rate limiting
  state-vector/    StateVectorEngine: tick-based EMA smoothing, hysteresis, interpolation for 60 FPS rendering
  memory-graph/    Semantic memory with cosine similarity retrieval, half-life decay (7d default), graph edges
  event-log/       Append-only event sourcing with version clocks, compaction, replay
  core-identity/   UUID v7 identity, multi-device registration, Ed25519 public key binding
  crypto/          AES-256-GCM encryption, Ed25519 signing, PBKDF2 derivation, signed tokens (5 min expiry)
  policy/          PolicyGate (tool approval, budgets, audit), MemoryGovernor (sensitivity-aware), injection defense
  privacy-layer/   Retention rules by sensitivity, deletion certificates, data export manifests
  sync-engine/     Multi-device sync: HTTP/WebSocket adapters, conflict detection, retry backoff
  render-engine/   RenderSpec (droplet geometry, glass material), ThreeJSAdapter (organic noise, breathing, sag)
  persistence/     SQLite schema (WAL mode), adapters for events/memories/identities/audit/state/devices
  tools/           InMemoryToolRegistry, builtin tools, MCP tool merge
  mcp-client/      MCP stdio client, tool discovery, external data boundary marking
  mcp-server/      MCP server adapter — exposes motebit as callable agent, synthetic tools, HTTP bearer auth
  identity-file/   Generate, parse, verify motebit.md — cryptographically signed agent identity files (internal)
  verify/          Standalone public verifier for motebit.md — zero monorepo deps, MIT licensed
  create-motebit/  Public CLI: `npm create motebit` — generates + verifies signed identity files
  browser-persistence/ Browser SQLite adapters, sql.js
  planner/           PlanEngine: goal decomposition, reflection, plan adjustment
  voice/             Voice pipeline: VAD, STT, TTS adapters
  github-action/     GitHub Action for identity verification
  policy-invariants/ Clamping rules, state bounds validation

spec/
  identity-v1.md   motebit/identity@1.0 specification — file format, signing algorithm, verification

services/
  api/             Sync relay server: REST + WebSocket, device auth (master token + Ed25519 signed tokens), fan-out
  summarize/       Conversation summarization service
  web-search/      Reference service: web search + URL reading via MCP
```

## Key Patterns

- **Metabolic principle.** Do not build what the medium already carries. If the field has solved a problem (VAD, STT, TTS, embeddings, inference), absorb the best available implementation through an adapter boundary and keep a fallback chain for graceful degradation. Build the enzymes (identity, memory, trust, governance, agentic loops), not the glucose (raw capabilities). See `THE_METABOLIC_PRINCIPLE.md`.
- **Adapter pattern everywhere.** All I/O abstracted — storage, rendering, AI providers, sync transport. In-memory for tests, SQLite/Tauri/Expo for production. The adapter is the surface tension boundary in code: the interior must not bind to a specific provider.
- **Event sourcing.** Immutable append-only log with version clocks. Multi-device ordering, conflict detection, compaction after snapshot.
- **Fail-closed privacy.** Deny on error. Sensitivity levels (none/personal/medical/financial/secret) with retention rules. Deletion certificates with SHA-256 hashes.
- **Streaming first.** AI loops yield text chunks, tool status events, approval requests, injection warnings.
- **Pure computation.** State-to-cues, tag parsing, action extraction are deterministic and stateless.

## Commands

```bash
pnpm run build          # Build all packages (turbo)
pnpm run test           # Test all packages
pnpm run typecheck      # Type-check all packages
pnpm run lint           # Lint all packages
pnpm --filter @motebit/desktop build   # Build single package
pnpm --filter @motebit/desktop test    # Test single package
```

## Desktop App (Flagship)

Tauri app. Two key files for the UI layer:

- `apps/desktop/index.html` — all HTML + CSS (chat, settings panel, PIN dialog, welcome overlay)
- `apps/desktop/src/main.ts` — DOM wiring, bootstrap, settings save, PIN flow
- `apps/desktop/src/index.ts` — DesktopApp class: identity bootstrap, AI init, streaming, operator mode

**Identity flow:** First launch shows welcome consent overlay → generates Ed25519 keypair → stores private key in OS keyring → registers device → optionally registers with sync relay using signed JWT.

**Operator mode:** PIN-protected (4-6 digits, SHA-256 hash in keyring). Gates high-risk tools. Tool calls produce audit log entries (allowed/denied/requires_approval).

**Rendering:** Three.js glass droplet — MeshPhysicalMaterial (transmission 0.94, IOR 1.22, iridescence 0.4), breathing at 2.0-3.5 Hz, gravity sag, Brownian drift, interior glow on processing.

## CLI App (Operator Console)

`apps/cli/src/` — Full operator console. Entry point in `index.ts`, split into modules: `config.ts`, `args.ts`, `identity.ts`, `runtime-factory.ts`, `stream.ts`, `slash-commands.ts`, `subcommands.ts`, `daemon.ts`, `utils.ts`. Published to npm as `motebit`. Bundled with tsup — all workspace packages inlined, native deps external.

**Subcommands:** `motebit export`, `motebit verify <path>`, `motebit run --identity <path>` (daemon), `motebit goal add/list/remove/pause/resume`, `motebit approvals list/show/approve/deny`. Default (no subcommand) enters interactive REPL.

**REPL commands:** `/model`, `/memories`, `/state`, `/forget`, `/export`, `/sync`, `/clear`, `/tools`, `/mcp list/trust/untrust/add/remove`, `/operator`, `/help`, `/summarize`, `/conversations`, `/conversation`, `/goals`, `/goal`, `/approvals`, `/reflect`, `/discover`.

**Identity:** Ed25519 keypair generated on first launch, private key encrypted with PBKDF2 (passphrase-protected), stored in `~/.motebit/config.json`. Supports operator mode via `--operator` flag.

**Daemon mode:** Reads governance thresholds from `motebit.md`, runs goal scheduler (60s tick), suspends on approval requests, fail-closed on invalid governance.

**Dependencies:** 13 workspace packages (runtime, ai-core, persistence, crypto, etc.). Direct better-sqlite3 persistence.

**MCP server mode:** `motebit --serve` exposes the motebit as an MCP server. Supports stdio and HTTP (StreamableHTTP) transport. Synthetic tools: `motebit_query` (AI response with memory), `motebit_remember` (store memory, sensitivity-capped at "personal" for external callers), `motebit_recall` (semantic search, privacy-filtered), `motebit_task` (autonomous execution with signed `ExecutionReceipt`), `motebit_identity` (identity file or JSON), `motebit_tools` (capability discovery). All synthetic and proxied tools pass through PolicyGate. Optional HTTP bearer auth (`authToken` config). All results identity-tagged via `formatResult()`. Deps are optional — synthetic tools only registered when their backend callback is provided.

## Mobile App

`apps/mobile/src/App.tsx` — React Native + Expo. Chat + 3D rendering via expo-gl. Full SQLite adapters (expo-sqlite), secure keychain (expo-secure-store). Triple providers (Anthropic + Ollama + Hybrid fallback), 7-tab settings UI, identity bootstrap, voice input (VAD + Whisper + TTS), multi-device pairing, goal scheduling with PlanEngine, MCP HTTP support with per-server trust and manifest pinning, approval queue UI (chat-inline + goal approvals), /summarize, periodic housekeeping, conversation management, memory browser.

## Admin Dashboard

`apps/admin/src/AdminApp.tsx` — React + Vite. 10 tabs: State Vector (Recharts trending), Memory Graph (D3-force), Behavior Cues (live preview), Event Log, Tool Audit Log, Goals, Plans, Conversations (with message drill-down), Devices, Intelligence Gradient (hero score, sub-metric bars, trend chart). Polls API every 2s. All endpoints wired to API relay. Configured via `VITE_API_URL`, `VITE_MOTEBIT_ID`, `VITE_API_TOKEN`.

## State Vector (9 fields)

`attention`, `processing`, `confidence`, `affect_valence`, `affect_arousal`, `social_distance`, `curiosity` (0-1 floats) + `trust_mode` (TrustMode enum) + `battery_mode` (BatteryMode enum).

## Behavior Cues (5 outputs)

`hover_distance`, `drift_amplitude`, `glow_intensity`, `eye_dilation`, `smile_curvature` — computed deterministically from state vector by behavior-engine.

## UI Feedback Rules

Motebit is calm software. Do not confirm what the user can already see.

- **Silent** (state is the confirmation) — modal closes, checkbox toggles, chat clears/populates, model changes. No toast, no message.
- **Toast** (async/background outcomes the user can't directly observe) — sync results, pairing status, device linking. Short-lived, non-blocking, never stacked.
- **Persistent system message** (requires attention) — errors with next steps, security warnings, first-launch milestones, background task failures. Rare (≤3-4 per session), actionable, clearly styled as system.
- **Background autonomy** — background agents may only emit persistent messages for user-blocking failures or user-requested notifications. All other background events go to toast or internal log.
- **Anti-patterns** — "Settings saved" after modal close, "Model switched" when dropdown shows it, "Loading…" when content is visibly populating, using chat as a continuous system log.

## Conventions

### Code structure
- All packages export from `src/index.ts`
- Tests live in `src/__tests__/` using vitest
- CSS is inline in HTML files (desktop, admin), not separate stylesheets
- Dialog/overlay pattern: backdrop with `.open` class toggling opacity + pointer-events
- Error handling: `catch (err: unknown) { const msg = err instanceof Error ? err.message : String(err); }`
- Secrets go in OS keyring (Tauri/expo-secure-store), never in config files
- Config file: `~/.motebit/config.json` for non-secret settings
- Database: `~/.motebit/motebit.db` (SQLite, WAL mode)

- **Sibling boundary rule.** When you fix a boundary (auth, policy, validation, rendering), audit all sibling boundaries for the same gap in the same pass. A fix applied to one path but not its siblings is incomplete. Docs are siblings of code — when implementation changes, sync CLAUDE.md, docs site, and spec in the same commit.
- Dependency overrides in `package.json` must be upper-bounded (`>=4.59.0 <5.0.0`), especially for 0.x semver.
