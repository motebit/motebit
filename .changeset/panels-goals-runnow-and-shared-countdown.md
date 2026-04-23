---
"@motebit/panels": minor
---

Goals — optional `runNow` on the fetch-adapter contract + a shared
`formatCountdownUntil` utility.

Additive only. Existing `GoalsFetchAdapter` implementations keep
working unchanged; surfaces that can fire a goal on demand opt in by
implementing the new method.

**New API:**

- `GoalsFetchAdapter.runNow?(goalId: string): Promise<void>` — optional.
  Surfaces whose daemon can bypass cadence and fire a goal immediately
  implement this. Surfaces without a direct-fire path (the package's
  own runner owns its user-facing equivalent; mobile's adapter hasn't
  wired one yet) omit it.
- `GoalsController.runNow?(goalId: string): Promise<void>` — surfaces
  on the controller only when the adapter implements it (conditional
  spread on the returned object). UIs gate the "Run now" affordance
  with `if (ctrl.runNow)`; the optional method is TypeScript-idiomatic
  at both ends of the contract.
- `formatCountdownUntil(targetMs, nowMs?)` — human-readable countdown
  formatter (`"any moment"` / `"in Ns"` / `"in Nm"` / `"in Nh Nm"` /
  `"in Nd Nh"`). Previously duplicated in two places inside
  `apps/web/src`; a third copy was about to land in `apps/desktop/src`
  when the Goals panel grew a countdown label. Lifting into the
  package makes the package the single source of truth.

**Why:** both additions close gaps between `ScheduledGoal`'s data
shape (it already carries `next_run_at` and has since the primitive
shipped) and the UI affordances surfaces could render. The daemon-
facing `runNow` had no standard hook; the countdown formatter had no
shared home. This commit fixes both in one place so every surface
renders the same countdown grammar and every daemon-backed surface
can expose the same bypass-cadence action without reinventing the
contract.

**Scope:** `@motebit/panels` is the only package with a public-API
change. Consumer updates (desktop's Goals panel gets Run-now +
countdown, web's two local formatter copies collapse onto the shared
export) ship in the same commit but don't change any published surface
— `@motebit/desktop` is private; `@motebit/web` is private.
