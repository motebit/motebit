---
"@motebit/policy": minor
"@motebit/ai-core": minor
"@motebit/runtime": minor
"@motebit/persistence": minor
---

Durable unattended execution, increment 1 — intent before the call, completion after, and a run ledger the daemon recovers from instead of re-firing.

`@motebit/protocol`: `PolicyDecision.callId?` (additive) — the audit row the gate wrote the decision under, so the executor can close the same row.

`@motebit/policy`: `PolicyGate.validate` now returns the `callId` of the decision row it appends BEFORE execution; new `PolicyGate.recordResult(ctx, decision, tool, args, ok, durationMs)` closes that row after (the previously unused `AuditLogger.logResult`, now redacting args like the decision row). New pure helpers `findUnresolvedActions(entries)` (allowed, un-paused decisions with no completion — external effect UNKNOWN) and `countCompletedActions(entries)`.

`@motebit/ai-core`: the loop calls `recordResult` the moment `tools.execute` returns or throws; `approval_request` chunks carry `audit_call_id` + `turn_id` so an out-of-loop resume can close the same row.

`@motebit/runtime`: the resume-after-approval path and `invokeLocalTool` both record completions; `invokeLocalTool` gains `humanApproved` (an out-of-band human decision satisfies the approval band like a tap — never a hard deny, never R4_MONEY).

`@motebit/persistence`: migration #43 — `goal_runs` ledger (`SqliteGoalRunStore`, `goalRunBlocksGoal`) and `approval_queue.args_json` (the full arguments a post-restart decision executes exactly).

`motebit` (CLI daemon): every goal run is a persisted row from before its first model call. Shutdown no longer denies pending approvals and restart no longer denies "orphans" — a human's decision survives the process. On restart, runs the old process died inside become `interrupted`; the tool audit log says whether anything external happened (completed actions, or decision rows with no completion = unknown), and if so the goal is HELD until `motebit runs ack <run_id>`. A decision made after a restart applies to exactly the one approved call (args hash re-checked, same policy gate, R4 never) — the paused turn is not re-run. New `motebit runs [list|ack]`; `motebit ps` marks held goals.
