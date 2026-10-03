---
"motebit": patch
---

**A task served by several bodies of one identity runs once.** The relay hands a task to every serving socket of an identity (the CLI daemon, the desktop app, a browser tab, a phone), and its claim grants exactly one of them — but every body used to send `task_claim` and run the task at once, so each serving body executed it. `motebit run` and `motebit serve` now route task frames through the shared `TaskClaimCoordinator` (`@motebit/runtime`, used by every surface): claim, run only on the relay's grant, drop the task on `task_claim_rejected`, and renew the claim's lease while running. A body that dies mid-task stops renewing; the relay's lease lapses and the task goes to the identity's other bodies, while a late result from the lapsed claimer is refused.
