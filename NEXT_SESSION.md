# Next Session

## Context

The category-3 sprint landed. Three commits worth of work on `main` (unpushed):

1. **Wire-vs-storage split rolled across all 11 remaining specs** — auth-token, credential, credential-anchor, delegation, dispute, execution-ledger, identity, market, migration, relay-federation, settlement. `check-spec-coverage` is now **strict** (`scripts/check.ts` passes `--strict`); 24 wire-format type names validated against `@motebit/protocol` exports. The tenth synchronization invariant is locked at category 2 — a new spec MUST adopt `#### Wire format (foundation law)` or CI hard-fails.

2. **Spatial HUD task field wired to runtime activity.** `apps/spatial/src/activity.ts` derives a short activity label from `StreamChunk` / `PlanChunk` events; `ActivityTracker` publishes change events; `SpatialApp.sendMessage`, `sendAndSpeak`, `executeGoal`, and `resumeGoal` push labels at every transition; `app.ts` subscribes `app.activity.onChange(label => hud.setTask(label))`. Labels: `thinking`, `tool: name`, `delegating → tool`, `planning`, `step: description`, `approval: …`, `reflecting`. 15 unit tests lock the chunk-to-label mapping.

3. **Credentials as scene objects + SpatialExpression compile-time boundary (category-3).** New `apps/spatial/src/spatial-expression.ts` declares `SpatialExpression = Satellite | Creature | Environment | Attractor`. Every structured-data module registers via `registerSpatialDataModule<K extends SpatialKind>(...)` — `"panel"`, `"list"`, `"card"` fail to compile. Negative proof: `apps/spatial/src/__tests__/spatial-expression.neg.test.ts` with `@ts-expect-error` assertions (same pattern as `custody-boundary.test.ts` for rails). `apps/spatial/src/credential-satellites.ts` ships the first concrete expression — `CredentialSatelliteRenderer` mounts a glass orb per credential under the creature's THREE.Group, orbiting at 18s period. `WebXRThreeJSAdapter.getCreatureGroup()` is the new render-engine accessor that made this mountable.

All 8 drift gates green. 271 spatial, 861 relay, full 92-task typecheck all pass.

## What to Build

### 1. Adopt SpatialExpression for a second scene-object class

Category-3 enforcement gets stronger the more modules adopt it. Credentials shipped. The next target is either **memory as environment** (ambient scene density driven by the memory graph size/quality) or **federated agents as creatures** (discovered agents render as sibling creatures). Pick one, wire the renderer, register the module. Once three expressions ship concretely, the doctrine is unshakeable.

### 2. Audit the other surface apps for compile-time boundaries they could adopt

Spatial now has two compile-time boundaries (activity tracking isn't one, but SpatialExpression is). Services has one (`custody-boundary.test.ts` for rails). **Which other surfaces have a prose invariant that could become a type?** Candidates to look at:

- **Settings vs Sovereign panel split** (CLAUDE.md UI section) — can a `SettingsField` vs `SovereignField` type make it a compile error to put a balance in Settings?
- **Credential source precedence** (mcp-client) — could `CredentialSource` variants be type-level-ordered so the precedence rule is checked by tsc?
- **Boundary markers** (policy injection defense) — `[EXTERNAL_DATA]` and `[MEMORY_DATA]` are prose contracts; could a branded type force sanitization at the callsite?

Pick one where the prose has real teeth and promote it.

### 3. Promote remaining audit-trail prose into enforced invariants

The `architecture_synchronization_invariants.md` memory lists ten invariants at varying enforcement levels. After this session, invariant 10 is at category 2 (hard CI). The others to audit for promotion:

- **Invariant 1 (protocol primitives ↔ services)** — `check-service-primitives` is already hard. Could it go stricter?
- **Invariant 5 (sibling boundaries)** — still PR-scoped advisory. Could a test generator lock sibling parity for specific boundary classes?
- **Invariant 7 (capability rings)** — currently doctrine-only. A compile-time ring declaration per feature is ambitious but possible.

## Patterns to Follow

- **Category-3 enforcement template**: declare a discriminated type; add a `@ts-expect-error` negative-proof test; wire the type into the actual feature. See `spatial-expression.ts` + `spatial-expression.neg.test.ts` + `credential-satellites.ts` for the shape.
- **Activity labels** are short and transient. If a label needs context, the context belongs in the scene, not next to the HUD.
- **No new panels in spatial.** Hard rule, now compiler-enforced.

## Verification

1. `pnpm run typecheck` — 92 tasks, all green.
2. `pnpm run test` — 91 tasks, all green.
3. `pnpm run check` — 8 drift gates green (including strict `check-spec-coverage`).
4. On-device: a fresh spatial session should show a live "task" label that changes while the agent is executing, and credential satellites orbiting the creature when the relay returns a non-empty list.

## Non-goals

- Onchain escrow (Solana Anchor) — still deferred.
- Porting 2D panels to spatial — compile error now.
- New drift invariants before existing ten are all at category 2 or higher.

Check memory: `architecture_synchronization_invariants.md` (all ten invariants + current enforcement category), `architecture_rail_custody_split.md` (GuestRail/SovereignRail type boundary — same pattern SpatialExpression now follows), `vision_spatial_canvas.md` (the scene-as-canvas endgame).
