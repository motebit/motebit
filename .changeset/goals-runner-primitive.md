---
"@motebit/panels": minor
---

Add `createGoalsRunner` — the daemon-role primitive for surfaces that ARE
the daemon. Sibling to the existing `createGoalsController` (which reads
daemon-backed state through an adapter). Previously absent, which forced
web to ship its own `scheduled-agents.ts` runner out-of-band from the
panels layer.

**Additions:**

- `packages/panels/src/goals/types.ts` — lifts `ScheduledGoal`, `GoalMode`,
  `GoalStatus` out of the controller file. Adds runner-only shapes:
  `GoalRunRecord`, `GoalFireResult`. Adds optional runner-populated fields
  on `ScheduledGoal`: `next_run_at`, `last_response_preview`, `last_error`.
- `packages/panels/src/goals/runner.ts` — `createGoalsRunner(adapter)`.
  Owns in-memory goals + run records, ticks on a 30s cadence, fires due
  **recurring** goals sequentially through the adapter, reconciles status
  from the fire outcome. Once goals are skipped by the tick — they
  require explicit `runNow` — matching the Goals-panel UX where the user
  clicks Execute. One fire in flight at a time; `skipped` leaves
  `next_run_at` unchanged so the next tick retries.

**Doctrine:**

- `docs/doctrine/panels-pattern.md` — retires the "two-surface controller
  - different feature" example. Goals now spans all three surfaces. The
    original framing was a diagnosis of drift, not a legitimate shape.

**Tests:**

- 15 new runner tests: add/pause/runNow semantics, fire reconciliation
  (fired/skipped/error × once/recurring), tick skips once goals,
  dispose / start-stop lifecycle, onChunk forwarding.

**Not changed:**

- `createGoalsController` unchanged — desktop + mobile keep their
  daemon-backed CRUD path.
- `ScheduledGoal` gains only _optional_ fields — existing consumers read
  and write correctly without updates.
- No `strategy` field. Execution-strategy distinction (plan vs. simple)
  stays encoded by _which surface creates the goal_ on web; explicit
  strategy propagation is a separate cross-cutting concern, not bundled
  with this additive primitive.
