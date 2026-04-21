---
"@motebit/runtime": minor
"motebit": patch
---

Rename `createGoalsController` / `GoalsController` / `GoalsControllerDeps` in
`@motebit/runtime` to `createGoalsEmitter` / `GoalsEmitter` / `GoalsEmitterDeps`.

The runtime's goals primitive is a goal-lifecycle event emitter — it authors
`goal_*` events against the event log. The previous name collided with the
completely different `createGoalsController` in `@motebit/panels`, which is a
subscribable UI state machine for rendering a goals panel. Two functions with
the same name, same return-type name, different signatures, different
semantics, different layers.

The panels pattern (`createSovereignController`, `createAgentsController`,
`createMemoryController`, `createGoalsController`) is a consistent 4-family
UI-state-controller convention and should keep its name. The runtime primitive
is the outlier; renamed to reflect its actual role (an emitter, which is also
how it is already described in the `runtime.goals` doc comment and in
`spec/goal-lifecycle-v1.md §9`).

### Migration

```ts
// before
import { createGoalsController, type GoalsController } from "@motebit/runtime";
// after
import { createGoalsEmitter, type GoalsEmitter } from "@motebit/runtime";
```

`runtime.goals` retains the same type shape (only the name changed).
No wire-format or event-log impact; this is a type-surface rename only.
`@motebit/panels` exports are unchanged.
