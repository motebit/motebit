---
"@motebit/runtime": minor
"@motebit/protocol": minor
"@motebit/wire-schemas": minor
---

Close the three convergence items from goal-lifecycle-v1 §9 and both
from plan-lifecycle-v1 §8 — spec bumps to v1.1 on each.

**New primitive: `runtime.goals`** (`packages/runtime/src/goals.ts`).
Single authorship site for every `goal_*` event in the runtime
process. Five methods (`created / executed / progress / completed /
removed`) mirror the spec event types, each typed against
`@motebit/protocol`'s `Goal*Payload`. Migrates emission out of three
surfaces (`apps/cli/src/subcommands/{goals,up}.ts`,
`apps/cli/src/scheduler.ts`, `apps/desktop/src/goal-scheduler.ts`) into
one runtime-owned surface. Desktop and CLI both call
`runtime.goals.*`; no surface constructs goal event payloads inline.

**Failure-path emission (goal v1.1 additive).** `GoalExecutedPayload`
gains an optional `error` field. Failed goal runs in the CLI scheduler
now emit `goal_executed { error }` alongside the existing
`goal_outcomes` projection row, fixing the §1 "ledger is the semantic
source of truth" violation that left failures invisible to event-log
replay.

**Terminal-state guard.** The goals primitive accepts an optional
`getGoalStatus` resolver; when registered (the CLI scheduler does this
on start), `executed / progress / completed` calls against a goal in a
terminal state are dropped with a logger warning. `goal_removed` is
exempt — spec §3.4 explicitly permits defensive re-removal.

**Plan step-lifecycle state machine (plan v1.1 enforcement).**
`_logPlanChunkEvent` in `plan-execution.ts` tracks per-`step_id` state
(pending → started → (delegated)? → terminal) and rejects invalid
transitions inline. Out-of-order and double-delegation chunks log a
warning and are not appended to the event log.

**Payload-direct delegation correlation (plan v1.1 additive).**
`PlanStepCompletedPayload` and `PlanStepFailedPayload` gain an optional
`task_id` field. Terminal events that close a delegated step now carry
the `task_id` from the preceding `plan_step_delegated`, so receivers
reconstruct the delegation chain by payload join rather than
cross-referencing sibling events.

All wire changes are additive under `.passthrough()` envelopes — v1.0
implementations continue to validate v1.1 payloads. Drift defenses #9,
#22, #23, #31, #33 all pass; type parity between protocol / zod / JSON
Schema holds across all 12 payload types.
