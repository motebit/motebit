---
"motebit": patch
---

Self-test probe gates its completion poll on whether the agent is serving. The shared `cmdSelfTest` submits a self-delegation task; device auth and the sybil defenses are proven the moment it submits and returns a `task_id`. The 30-second completion poll is a secondary "live network participant" check that can only resolve when a worker executes the task, so `cmdSelfTest` now takes a `serving` flag (default false) and returns a terminal `auth_verified` status on non-serving surfaces instead of polling to a guaranteed timeout. The CLI daemon's `--self-test` runs inside its serving registration, so it passes `serving: true` and its behavior is unchanged — it still polls for execution.
