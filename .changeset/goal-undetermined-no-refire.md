---
"motebit": patch
---

A goal whose last run left a paid outcome unknown no longer re-fires into a second payment (#890). A plan step whose delegation ends undetermined (the relay never confirmed the submission) or whose process died mid-submit now stays held: its plan is resumed, never re-planned, and the step settles only from the relay's signed receipt for its task — completed or failed — without a second submission. The goal scheduler reports such a run as awaiting its result (`partial`, pointing at `/result`), not as a failure, so it no longer burns the retry budget or auto-pauses. A goal whose run hired through `delegate_to_agent` and left a payment owed in the paid-intent ledger is held until that result is retrieved or dismissed with `/result`. `motebit delegate --plan` prints "Awaiting result" for such a plan instead of nothing.

A plan is driven by at most one driver at a time: a goal scheduler's resume and a reconnect's recovery no longer both settle a held step and both submit the next one (the second yields `plan_busy`), and a plan step's relay Idempotency-Key is now derived from the plan, step and attempt, so overlapping submissions admit one task. Every goal run records its start before it can pay, so a run that pays and then dies still holds its goal.

A plan step held because its submission never left the device (offline at submit) is no longer wedged: resuming re-posts it under the same derived Idempotency-Key while that key is inside the relay's idempotency window, and a 409 that names the task (#888) now hands over that task. Desktop "Run now" honours the owed-payment hold, and a run that paid after overrunning its wall clock still holds its goal.
