---
"motebit": patch
---

A goal whose last run left a paid outcome unknown no longer re-fires into a second payment (#890). A plan step whose delegation ends undetermined (the relay never confirmed the submission) or whose process died mid-submit now stays held: its plan is resumed, never re-planned, and the step settles only from the relay's signed receipt for its task — completed or failed — without a second submission. The goal scheduler reports such a run as awaiting its result (`partial`, pointing at `/result`), not as a failure, so it no longer burns the retry budget or auto-pauses. A goal whose run hired through `delegate_to_agent` and left a payment owed in the paid-intent ledger is held until that result is retrieved or dismissed with `/result`.
