# Motebit

Persistent embodied AI presence layer. A motebit is a droplet of intelligence under surface tension — a glass sphere that breathes, sags under gravity, orbits the user, and transmits its interior state through transparency.

Read `MOTEBIT.md` for the full design thesis. Every visual and behavioral decision derives from droplet physics. If it can't be traced to surface tension, it doesn't belong.

## Architecture

pnpm monorepo, Turborepo orchestration, TypeScript throughout. Node >= 20, pnpm 9.15.

```
apps/
  desktop/     Tauri (Rust + webview), Three.js creature, full identity/crypto/operator mode
  cli/         Node.js REPL, developer/debugging interface, same runtime
  mobile/      React Native + Expo, expo-gl + Three.js, early MVP (~30%)
  admin/       React + Vite dashboard, real-time state/memory/audit monitoring
  spatial/     AR/VR positioning library, body-relative orbital mechanics (stub runtime)

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
  policy-invariants/ Clamping rules, state bounds validation

services/
  api/             Sync relay server: REST + WebSocket, device auth (master token + Ed25519 signed tokens), fan-out
```

## Key Patterns

- **Adapter pattern everywhere.** All I/O abstracted — storage, rendering, AI providers, sync transport. In-memory for tests, SQLite/Tauri/Expo for production.
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

**Rendering:** Three.js glass droplet — MeshPhysicalMaterial (transmission 0.98, IOR 1.15, iridescence 0.3), breathing at ~0.3 Hz, gravity sag, Brownian drift, interior glow on processing.

## CLI App

`apps/cli/src/main.ts` — REPL with streaming. Commands: `/model`, `/memories`, `/state`, `/forget`, `/export`, `/sync`, `/clear`, `/help`. Hardcoded identity (`motebit-cli`), no keyring, no operator mode. Direct better-sqlite3 persistence.

## Mobile App

`apps/mobile/src/App.tsx` — React Native + Expo. Chat + 3D rendering via expo-gl. Full SQLite adapters (expo-sqlite), secure keychain (expo-secure-store). Ollama-only, no settings UI, no identity bootstrap yet.

## Admin Dashboard

`apps/admin/src/AdminApp.tsx` — React + Vite. 5 tabs: State Vector (Recharts trending), Memory Graph (D3-force), Behavior Cues (live preview), Event Log, Tool Audit Log. Polls API every 2s. Configured via `VITE_API_URL`, `VITE_MOTEBIT_ID`, `VITE_API_TOKEN`.

## State Vector (9 fields)

`attention`, `processing`, `confidence`, `affect_valence`, `affect_arousal`, `social_distance`, `curiosity` (0-1 floats) + `trust_mode` (TrustMode enum) + `battery_mode` (BatteryMode enum).

## Behavior Cues (5 outputs)

`hover_distance`, `drift_amplitude`, `glow_intensity`, `eye_dilation`, `smile_curvature` — computed deterministically from state vector by behavior-engine.

## Conventions

- All packages export from `src/index.ts`
- Tests live in `src/__tests__/` using vitest
- CSS is inline in HTML files (desktop, admin), not separate stylesheets
- Dialog/overlay pattern: backdrop with `.open` class toggling opacity + pointer-events
- Error handling: `catch (err: unknown) { const msg = err instanceof Error ? err.message : String(err); }`
- Secrets go in OS keyring (Tauri/expo-secure-store), never in config files
- Config file: `~/.motebit/config.json` for non-secret settings
- Database: `~/.motebit/motebit.db` (SQLite, WAL mode)
