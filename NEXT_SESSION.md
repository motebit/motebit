# Next Session

## Context

The endgame-patterns pass landed: rail custody split (GuestRail / SovereignRail, type-level enforcement), spec wire-format doctrine (discovery-v1 exemplar + `check-spec-coverage` probe as the tenth drift defense), and spatial HUD + panel-rejection doctrine. Eight drift gates pass clean. 237 spatial, 859 relay, 244 protocol, 38 wallet-solana tests all green.

## What to Build

### 1. Apply wire-vs-convention split to the remaining 11 specs

`check-spec-coverage` flagged 11 specs that haven't yet adopted the `#### Wire format (foundation law)` / `#### Storage` split: auth-token, credential-anchor, credential, delegation, dispute, execution-ledger, identity, market, migration, relay-federation, settlement.

**Pattern:** for each section that declares a binding artifact, add two subsections — wire format names the exact JSON shape and cross-references the `@motebit/protocol` type; storage (or similar, e.g. "Persistence," "Index") describes non-binding implementation conventions. See `spec/discovery-v1.md §5.1` for the exemplar.

**Enforcement:** the probe currently warns on unstructured specs. Promote it to hard-fail with `--strict` once all 11 are done. Add the `--strict` flag to the gate definition in `scripts/check.ts`.

### 2. Spatial HUD: wire the task field

The HUD exists and shows connection + balance live. The third field ("task") is currently hardcoded to "idle" because runtime task-state wiring isn't exposed. Find the cleanest hook in `@motebit/runtime` that emits the current in-flight task label (agentic loop iteration, goal step, or delegation target) and pump it through `hud.setTask(label)` in `apps/spatial/src/app.ts`. If no such hook exists, add one — "current task" is a Ring 1 capability.

### 3. Start expressing structured data as scene objects

The HUD is the doctrine floor. The doctrine's real payoff is that credentials become satellites orbiting the creature, agents become creatures in the scene, memory becomes environment. Pick one — credentials are the easiest first target because the credential list is small and stable — and render them as orbiting objects in the WebXR scene. The 2D credential list in the settings panel stays (operators still configure there), but the canonical expression of "I have 12 credentials from 5 issuers" is visible in-scene.

## Patterns to Follow

- Spec structure: `#### Wire format (foundation law)` + `#### Storage` subsections. Types named in the wire format must be exported from `@motebit/protocol` (enforced).
- Type-level doctrine: when a boundary matters, express it as a type, not prose (see `GuestRail` / `SovereignRail` custody discriminant).
- Spatial form: HUD for essentials, scene objects for structure. Never a panel.
- Drift gates: every new invariant gets a named check-\* script, a line in `scripts/check.ts`, and a cross-reference from CLAUDE.md.

## Verification

After all three:

1. `pnpm run typecheck` — all packages pass
2. `pnpm run test` — all suites pass
3. `pnpm run check` — all drift defenses green (currently 8; item 1 promotes `check-spec-coverage` to strict mode, no new gate count)
4. Spatial HUD shows a live task label during a delegation
5. At least one structured data class renders as scene objects in WebXR

## Non-goals

- Onchain escrow program (Solana Anchor)
- Multi-chain settlement (Solana only for now)
- Porting mobile/web panels to spatial — that is the anti-pattern the doctrine exists to prevent

Check memory: `architecture_rail_agnostic_actor.md` (economic model), `architecture_synchronization_invariants.md` (drift meta-principle + the ten named invariants), `vision_spatial_canvas.md` (the scene-as-canvas endgame).
