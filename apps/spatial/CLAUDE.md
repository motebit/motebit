# apps/spatial — AR/VR/WebXR surface

Spatial rejects the panel metaphor. Porting 2D panels to a headset is cargo-cult parity and surrenders the medium's only advantage.

## Rules

1. **Functional HUD + spatial objects, never panels.** `src/hud.ts` is the non-negotiable safety floor — read-only essentials (connection state, balance, active task). Everything else expresses structured data as spatial objects (credentials as satellites orbiting the creature, other agents as creatures in the scene, memory as environment, goals as attractors).
2. **Doctrine is compile-time.** `src/spatial-expression.ts` declares `SpatialExpression = Satellite | Creature | Environment | Attractor`. Every structured-data module registers its kind via `registerSpatialDataModule<K extends SpatialKind>(...)`. Widening the union or passing `"panel"` / `"list"` / `"card"` is a `tsc` error, locked by `@ts-expect-error` assertions in `__tests__/spatial-expression.neg.test.ts`.
3. **Panel parity with desktop/web/mobile is explicitly an anti-goal.** Operators expecting to read a rectangular balance panel on a headset is the wrong expectation to satisfy. When vision documents (`vision_spatial_canvas.md`, `vision_endgame_interface.md`, `vision_interactive_artifacts.md`) say "the creature is the last interface," they mean spatial should stop imitating the web surface.
4. **Credentials are the first shipping expression.** `src/credential-satellites.ts` mounts a `CredentialSatelliteRenderer` under the creature group — a small glass orb per credential. The 2D credential list in settings stays for configuration; the canonical "I have N credentials from M issuers" lives in the scene.
5. **When in doubt, add a spatial expression, not a panel.** If you can't express a concept as a satellite, creature, environment, or attractor, that is a signal the concept belongs in configuration (settings) rather than the spatial surface.
