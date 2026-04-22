---
"@motebit/runtime": minor
"@motebit/web": minor
---

Fix two of the three honest limitations on scheduled agents:

**Priority yield now retries on next tick.** Previous behaviour:
when a scheduled fire collided with an in-flight user turn, the
runner skipped the fire AND advanced `next_run_at` by a full cadence
— so a missed fire waited up to `interval_ms` before trying again.
Now: the `fire()` contract returns `fired | skipped | error`.
`skipped` leaves `next_run_at` alone; the next 30s tick retries.
`error` advances once (one backoff) so a failing fire doesn't
loop every 30s. `fired` advances normally.

**Scheduled runs no longer pollute the chat transcript.** New
`RuntimeConfig` / `sendMessageStreaming` / `processStream` option:
`suppressHistory`. When true, the turn runs the normal pipeline
(signed receipts, tool calls, activity events all emit as usual)
but neither `pushExchange` nor `pushActivation` fires — the
conversation stays focused on user ↔ motebit dialogue. The web
app's scheduler opts in; receipts from scheduled runs still land
in the workstation's audit log.

**Recent runs view.** The runner now tracks the last 50 runs
(in-memory). Each run record:

- `run_id`, `agent_id`, `prompt`, `started_at`, `completed_at`
- `status`: `running` | `fired` | `skipped` | `error`
- `responsePreview`: 160-char truncation for the inline UI
- `errorMessage`: set on `error`

Workstation panel renders the last 10 runs below the agent list —
one row per run with status mark (✓ / … / ⏸ / ✗), relative
time, and preview. Live-updates as runs progress through states.
Separate from the main receipt log below; receipts stay canonical
for audit, runs are the UX lens.

**Remaining limitation (deferred).** Tab-local firing — runs only
happen while motebit.com is open. The fix is relay-side scheduling
(new endpoint + DB + scheduler + push), a multi-session effort.
Today's data shape + runner contract match the endgame: swapping
the tab-local runner for a relay subscription doesn't change the
UI or the storage format.

All 28 drift gates pass. Runtime + web tests green. Full workspace
build clean.
