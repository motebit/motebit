---
"@motebit/protocol": minor
"@motebit/wire-schemas": minor
"@motebit/runtime": patch
---

Ship `spec/goal-lifecycle-v1.md` and `spec/plan-lifecycle-v1.md` —
event-shaped wire-format specs for the goal and plan event families
already emitted by `@motebit/runtime` and its CLI / desktop callers.

Pattern matches `memory-delta-v1.md` (landed 2026-04-19): each event
type gets a `#### Wire format (foundation law)` block, a payload type
in `@motebit/protocol`, a zod schema in `@motebit/wire-schemas` with
`.passthrough()` envelope + `_TYPE_PARITY` compile-time assertion, a
committed JSON Schema artifact at a stable `$id` URL, and a roundtrip
case in `drift.test.ts`.

**Goal-lifecycle (5 events):**

- `goal_created` — initial declaration or yaml-driven revision
- `goal_executed` — one run's terminal outcome
- `goal_progress` — mid-run narrative note
- `goal_completed` — goal's terminal transition
- `goal_removed` — tombstone via user command or yaml pruning

**Plan-lifecycle (7 events):**

- `plan_created` — plan materialized with N steps
- `plan_step_started` / `_completed` / `_failed` / `_delegated`
- `plan_completed` / `plan_failed` — plan-level terminal transitions

`@motebit/runtime` now declares implementation of both specs in its
`motebit.implements` array (enforced by `check-spec-impl-coverage`,
invariant #31). Cross-spec correlation with memory-delta and future
reflection/trust specs is via `goal_id` on plan events.
