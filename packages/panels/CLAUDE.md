# @motebit/panels

Surface-agnostic controllers for every cross-surface panel: Sovereign (credentials, execution ledger, budget, succession), Agents (trust + reputation + capability roster), Memory (graph nodes + decay + audit), Goals (declared outcomes + scheduled fires), Skills (installed agentskills.io-compatible procedural knowledge per spec/skills-v1.md), and Activity (the unified audit-log + event-log timeline that makes user-driven sovereignty visible — every signed deletion, consent, export, and intent event the privacy layer recorded). State derivation, adapter I/O, and action handlers live here. Rendering — DOM for desktop/web, React Native for mobile — stays at the surface.

Layer 5. BSL-1.1. Zero internal deps: the adapter inverts the dependency on `@motebit/runtime` so surfaces compose both without the package pulling runtime into its layer.

## The pattern

One controller per panel. Each exports:

- **Adapter interface** — the contract the host surface must implement (auth'd fetch, runtime accessors, local credential store).
- **State shape** — a plain record the host renders from.
- **Controller** — `subscribe(listener)`, action methods (`refresh`, `commitSweep`, `present`, `verify`, `loadLedgerDetail`, `setActiveTab`), `getState()`, `dispose()`.

The controller owns fetch orchestration, parallel coordination, deduplication, response-shape unification across surfaces that fetch different endpoints, error paths, and optimistic state mutation on commit. The host owns DOM elements, React hooks, styling, and affordance wiring.

## Rules

1. **No render.** The package does not import a UI framework. No `document`, no React, no `react-native`. Pure state + action + subscription.
2. **No runtime import.** `@motebit/runtime` is a Layer 5 sibling; importing would force a layer promotion. The adapter interface takes the three runtime accessors the Sovereign panel needs (`getSolanaAddress`, `getSolanaBalanceMicro`, `getLocalCredentials`) as plain function properties — the host wires its runtime instance into the adapter.
3. **Auth is adapter-supplied.** Desktop uses a static `syncMasterToken`, web uses a rotating `createSyncToken()`, mobile currently uses none. The controller asks the adapter for `fetch(path, init)` — the adapter embeds the auth choice. Never bake token strategy into the controller.
4. **Response shapes are canonicalized in the controller.** If mobile hits `/agent/{id}/ledger` (aggregated) and desktop/web hit `/agent/{id}/ledger/{goal_id}` (per-goal lazy), the controller normalizes to one state shape with both fetch paths available. Surfaces render from the unified state.
5. **Errors surface as state, not throws.** Fetch failures write to `state.error` and leave previous-good state intact. The renderer decides whether to show a toast or a system message per surface doctrine.
6. **No time formatting.** Each surface formats timestamps natively (desktop and mobile share a `formatTimeAgo` utility; web uses `formatDate`). Pushing a shared formatter into the controller would couple presentation to state.

## Consumers

- `apps/desktop` — first consumer, 2026-04-19.
- `apps/web` — follow-up migration.
- `apps/mobile` — follow-up migration.

Drift gate `check-panel-controllers` enforces the cross-surface contract for every registered panel family — sovereign, agents, memory, goals, skills, **activity** + **retention** (the sovereignty-visible pair shipped 2026-05-06: signed-action timeline + browser-verified operator retention manifest). Any file under `apps/<app>/src/{ui,components}/` whose name matches a family pattern AND hits the family's I/O signatures (relay endpoints, runtime accessors) must import from `@motebit/panels`. Surfaces that ship the panel UI but bypass the controller silently drift the per-family contract; the gate catches that in CI rather than at user encounter.
