---
"@motebit/protocol": minor
"motebit": minor
---

Durable unattended execution, increment 1 — intent before the call, completion after, and a run ledger the daemon recovers from instead of re-firing.

`@motebit/protocol`: `PolicyDecision.callId?` (additive) — the audit row the gate wrote the decision under, so the executor can close the same row.

`@motebit/policy`: `PolicyGate.validate` now returns the `callId` of the decision row it appends BEFORE execution; new `PolicyGate.recordResult(ctx, decision, tool, args, ok, durationMs)` closes that row after (the previously unused `AuditLogger.logResult`, now redacting args like the decision row). New pure helpers `findUnresolvedActions(entries)` (allowed, un-paused decisions with no completion — external effect UNKNOWN) and `countCompletedActions(entries)`.

`@motebit/ai-core`: the loop calls `recordResult` the moment `tools.execute` returns or throws; `approval_request` chunks carry `audit_call_id` + `turn_id` so an out-of-loop resume can close the same row.

`@motebit/runtime`: the resume-after-approval path and `invokeLocalTool` both record completions; `invokeLocalTool` gains `humanApproved` (an out-of-band human decision satisfies the approval band like a tap — never a hard deny, never R4_MONEY).

`@motebit/persistence`: migration #43 — `goal_runs` ledger (`SqliteGoalRunStore`, `goalRunBlocksGoal`) and `approval_queue.args_json` (the full arguments a post-restart decision executes exactly).

`motebit` (CLI daemon): every goal run is a persisted row from before its first model call. Shutdown no longer denies pending approvals and restart no longer denies "orphans" — a human's decision survives the process. On restart, runs the old process died inside become `interrupted`; the tool audit log says whether anything external happened (completed actions, or decision rows with no completion = unknown), and if so the goal is HELD until `motebit runs ack <run_id>`. A decision made after a restart applies to exactly the one approved call (args hash re-checked, same policy gate, R4 never) — the paused turn is not re-run. New `motebit runs [list|ack]`; `motebit ps` marks held goals.

Review follow-up in the same increment: recovery is itself an interruption point. Both out-of-loop execution paths (the daemon's live drain and its post-restart apply) now move the run to `running` BEFORE the call, and the executor appends an allowed, un-paused `approval_satisfied:<by>` row under the same `callId` (`PolicyGate.recordApprovalSatisfied`, called by `invokeLocalTool` for taps and human-approved recoveries and by the resume path) — so a death after the approved call reads as "prepared; effect unknown" and holds, never "nothing happened", and the approval is never executed twice. `invokeLocalTool` gains `runId` so the row is classifiable by run. The recovered outcome states the goal's remaining work was not resumed; `motebit runs ack` states the next run starts from scratch and may repeat effects.

Second review follow-up: a decision applied after a restart closes its run and outcome as the new structural status `partial` (`GoalOutcome.status` / `GoalRunStatus`), never `completed` — the one approved action ran or was refused, the goal's remaining work was not resumed, and no projection may count it as goal success. `motebit runs ack` now requires `--allow-fresh-run`: the consequence (the next run starts from scratch and may repeat listed effects) is printed BEFORE anything is released, and the flag is the acceptance. A real-crash test (child process, file-backed SQLite, SIGKILL after the recovered call's effect and before its record) proves the next process holds the action as unknown and does not execute the approval again.

PE review round (`/code-review 674 high`, 9 confirmed findings) — the recovery path had real defects, all fixed here:

- **An approval whose paused turn was already voided is no longer executed out of band.** The runtime's own approval timeout (10 min) is shorter than the scheduler's TTL (1 h), so a human approving at minute 20 hit a drain that logged "nothing to resume" and then let the recovered-approval path run the tool anyway, long after the conversation recorded the call as failed. Both "not resuming" branches now close the run (`closeVoidedRun`); the recovered drain also refuses while any other approval is pending in the shared runtime.
- **The 1-hour TTL now bounds the decision, not the sweep.** `motebit approvals approve|deny` refuses an approval past `expires_at` (and sweeps it), and the recovered drain refuses one whose `resolved_at` is past it — closing the daemon-was-down hole where a 3-day-old call executed.
- **Every `running` transition has a failure transition.** A live resume that throws is caught: the run closes `failed` with an outcome, instead of sticking `running` forever (un-ackable, holding the goal until a restart).
- **Restart recovery can no longer clobber a real outcome.** The live paths write the run-status transition before the outcome row, and the recovery outcome gets its own id instead of reusing `run_id` (`INSERT OR REPLACE` was overwriting a completed outcome with "interrupted").
- **A graceful `stop()` mid-run closes the run** (abort + `failed`) instead of leaving it `running` for the next start to classify as interrupted and hold behind a human ack.
- **Goal-scoped tools are registered while a recovered approval executes**, so an approved `create_sub_goal` / `complete_goal` / `report_progress` is not refused as "not available".
- **`motebit runs ack` resolves by indexed id** (blocking runs first), so a held run stays ackable past 200 newer rows; **`motebit ps`** shows a live run as `running now`, not `HELD (interrupted …)`.
- **One audit entry per call.** `recordResult` was appending a second full entry, which keyed sinks upsert but the browser IndexedDB and mobile Expo sinks duplicated — double-counting `queryStatsSince` and skewing the gradient. New optional `AuditLogSink.complete(entry)` writes `result` + `timestamp` onto the recorded entry (decision preserved); implemented on all six sinks, with the chain still recording both links.
- Restored the four `#462` approval-binding tests the first cut had deleted, plus the resolved-approvals-untouched test.
