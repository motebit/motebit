---
"@motebit/web": minor
---

Web adopts the unified Goals primitive from `@motebit/panels`. The two
parallel web models are gone: `ScheduledAgent` (recurring simple) and
the in-panel `WebGoal` (one-shot plan) now share one runner + one
store.

**Replaces:**

- `apps/web/src/scheduled-agents.ts` (391 lines) — deleted. The
  tab-local runner + storage + cadence helpers are now provided by
  `createGoalsRunner` from `@motebit/panels/goals`. The web-side
  wrapper in `apps/web/src/goals-runner.ts` owns the localStorage
  adapter + the fire() routing:
  - `mode: "once"` → `app.executeGoal` plan stream (Goals panel)
  - `mode: "recurring"` → `app.sendMessageStreaming` single turn
    with `suppressHistory: true` (Workstation)
    The dispatch rule keeps prior behavior without needing an explicit
    `strategy` field on the goal — execution style is encoded by which
    surface creates the goal.

**WebApp changes:**

- `WebApp.getScheduledAgents()` → `WebApp.getGoalsRunner()`.
- Private `_scheduledAgents` → `_goalsRunner`.

**Workstation panel:**

- The "scheduled" section's underlying type is now `ScheduledGoal`,
  filtered to `mode: "recurring"`. One-shot goals live in the Goals
  panel. UI label and layout unchanged.
- `setPaused` replaces `setEnabled`; terminal states skip pause by
  design.

**Goals panel:**

- Reads from the shared runner, filtered to `mode: "once"`. Add /
  execute / delete all go through the runner API. The runner
  forwards plan chunks via an optional `onChunk` callback so the
  panel still renders step-by-step progress during execution — UI
  fidelity unchanged.
- Subscription attaches on first `openGoals()` (runner is built
  during `app.bootstrap`, which runs after panel init).

**Storage:**

- Unified key `motebit.goals` (array of `ScheduledGoal`) + runs under
  `motebit.goals_runs`. No migration from the old `motebit:goals` /
  `motebit.scheduled_agents` keys — solo-dev pre-launch, no users with
  data in those formats.

All 178 web tests pass; all 28 drift gates pass.
