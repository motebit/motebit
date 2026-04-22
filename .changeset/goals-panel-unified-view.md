---
"@motebit/web": minor
---

Goals panel becomes the single surface for all user-declared goals —
one-shot and recurring. Workstation drops its recurring-goals section.

**Goals panel:**

- Compose gains a cadence select (`once` / `hourly` / `daily` /
  `weekly`). Default is `once`, matching the prior one-shot UX.
- List shows every goal regardless of mode. Recurring rows get a
  cadence badge + countdown label; active recurring rows get Pause +
  Run-now controls; once rows keep the Execute button for pending state.
- Countdown refreshes every 30s while the panel is open.
- New CSS classes `.goal-cadence-badge` + `.goal-countdown`.

**Workstation panel:**

- Recurring-goals section removed (DOM, scaffold fields, consumer
  block, helper functions `buildGoalRow`, `buildRunRow`, `statusMark`,
  `statusColor`, `formatRelativePast`, and the `formatCountdownUntil`
  import). Workstation now holds only URL bar + live tool-call
  receipts + browser pane.

**Doctrine:**

- Records-vs-acts: panels hold records (user-declared goals); the
  Workstation plane shows live acts (current tool activity). Having
  recurring goals in two places was UI-layer drift that the data-layer
  unification already removed. This closes it.

All 178 web tests pass; all 28 drift gates pass.
