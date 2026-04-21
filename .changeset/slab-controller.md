---
"@motebit/runtime": minor
---

Add `SlabController` — the runtime-side event-translation layer for the
"Motebit Computer" slab primitive. See docs/doctrine/motebit-computer.md
for the semantic contract.

The controller owns the bridge between the runtime's internal event
streams (LLM tokens, tool calls, plan steps, shell output, fetches,
inference) and the typed lifecycle events renderers consume via
`@motebit/render-engine`'s `SlabItem*` types. Kept runtime-layer (not
render-engine layer) because deciding _what_ is a slab item, _when_ it
opens, _when_ it pinches vs dissolves is a judgment the runtime is
uniquely positioned to make — renderers just know how to draw a plane.

New exports from `@motebit/runtime`:

- `createSlabController(deps)` factory + `SlabController` interface.
- `SlabState` + `SlabAmbient` (`idle | active | recessed`) + `SlabItem`.
- `SlabItemOutcome` (`completed | interrupted | failed`) + `DetachPolicy`
  / `DetachDecision` / `defaultDetachPolicy`.
- `TimeoutHandle` for test-injectable scheduling.

The `MotebitRuntime` class now instantiates the controller and exposes
it as `runtime.slab`. Runtime-path wiring (stream tokens, tool calls,
plan steps → slab items) lands in a follow-up commit; until then
subscribers see the idle ambient and an empty items map.

Test coverage: 22 tests covering emerge/active/pinch/detach/dissolve
lifecycles, ambient-state transitions through recession, default vs
injected detach policies, idempotent duplicate-id handling, terminal-
phase update/end rejection, subscriber exception isolation, dispose
cleanup. All 606 runtime tests pass.
