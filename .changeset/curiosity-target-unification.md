---
"@motebit/runtime": minor
---

Land curiosity-target unification — the consolidation cycle is now the only proactive maintenance loop, in code as well as in doctrine.

**The deferred-design question** that `docs/doctrine/proactive-interior.md` § "What's deferred" had been holding open: does curiosity belong in the cycle's `gather` phase or stay a separate signal the gradient manager subscribes to? The audit showed the framing was wrong. `housekeeping()` had been called only at runtime shutdown since the 2026-04-20 unification, firing at a soon-to-be-disposed gradient manager. Curiosity-target computation was effectively dead in production for eight days, and the gradient was being kept fresh only by interactive-turn paths (cold-start, every-fifth-turn reflection) — never during long idle windows. There was no design question to settle; there was finish work waiting on a label.

**Resolution**: curiosity is a `gather`-class operation and now lives in the cycle's `gather` phase. `findCuriosityTargets` runs over the same live-node set the rest of `gather` already loaded; result is pushed via the cycle's new `setCuriosityTargets` dep callback into `gradientManager.setCuriosityTargets`. The cycle gained a parallel `computeAndStoreGradient` dep callback so the post-prune gradient recompute runs once per cycle, restoring the periodic-during-idle gradient updates the shutdown-only housekeeping path never delivered.

**Deletions**:

- `packages/runtime/src/housekeeping.ts` (whole file — `runHousekeeping`, `HousekeepingDeps`, `HousekeepingResult`, `consolidateEpisodicMemories` — episodic consolidation is in the cycle's consolidate phase, prune+retention+decay in the cycle's prune phase)
- `packages/runtime/src/__tests__/housekeeping.test.ts` (8 tests of dead code; behaviors covered by cycle tests)
- `MotebitRuntime.housekeeping()` method
- `MotebitRuntime.housekeepingDeps` getter
- The shutdown-time `void this.housekeeping()` call in `stop()`
- `RuntimeConfig.episodicConsolidation` flag (zero callers, zero effect — never propagated into the cycle since the unification)

**Surface migrations**: `apps/{cli,web,mobile,spatial}` schedulers and goal-runners migrated their periodic-tick callers from `runtime.housekeeping()` to `runtime.consolidationCycle()`. Surface-internal wrapper methods (e.g., `WebApp.housekeeping()`, `SpatialApp.housekeeping()`) keep their names but now call the cycle internally — name choice is surface-internal, the doctrine-level rename is at the runtime boundary.

**Doctrine**: `docs/doctrine/proactive-interior.md` § "What's deferred" replaced with § "What was deferred and is now done", documenting the audit finding that the deferred-design framing was wrong. `scripts/check-consolidation-primitives.ts` allowlist trimmed (housekeeping.ts no longer exists).

**Net**: gate `check-private-deprecation-shape` (#59) now governs **0 markers** — the strongest possible state, since case-3 deferred-design was the only legitimate reason to keep `@deprecated` in a private package and the only such case in the workspace just retired.
