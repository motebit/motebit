# apps/spatial — AR/VR/WebXR surface

Spatial rejects the panel metaphor. Porting 2D panels to a headset is cargo-cult parity and surrenders the medium's only advantage.

## Rules

1. **Functional HUD + spatial objects, never panels.** `src/hud.ts` is the non-negotiable safety floor — read-only essentials (connection state, balance, active task). Everything else expresses structured data as spatial objects (credentials as satellites orbiting the creature, other agents as creatures in the scene, memory as environment, goals as attractors).
2. **Doctrine is compile-time.** The `SpatialExpression = Satellite | Creature | Environment | Attractor` union + `registerSpatialDataModule<K>()` live in `@motebit/render-engine` (shared with every surface that renders a creature). Spatial keeps the doctrinal enforcement: widening the union or passing `"panel"` / `"list"` / `"card"` is a `tsc` error, locked by `@ts-expect-error` assertions in `__tests__/spatial-expression.neg.test.ts`. Scene primitives live in the package, the "no panels" rule lives here.
3. **Panel parity with desktop/web/mobile is explicitly an anti-goal.** Operators expecting to read a rectangular balance panel on a headset is the wrong expectation to satisfy. When vision documents (`vision_spatial_canvas.md`, `vision_endgame_interface.md`, `vision_interactive_artifacts.md`) say "the creature is the last interface," they mean spatial should stop imitating the web surface.
4. **Credentials are the first shipping expression.** `CredentialSatelliteRenderer` (in `@motebit/render-engine`) mounts a small glass orb per credential under the creature group — consumed by both spatial and web. The 2D credential list in sovereign/settings stays for configuration; the canonical "I have N credentials from M issuers" lives in the scene.
5. **When in doubt, add a spatial expression, not a panel.** If you can't express a concept as a satellite, creature, environment, or attractor, that is a signal the concept belongs in configuration (settings) rather than the spatial surface.
