---
"motebit": patch
---

CLI: `motebit delegate` now also names its worker as `target_agent` (equal to the agent it posts to). With `MOTEBIT_API_TOKEN`, `MOTEBIT_SYNC_TOKEN` or a configured sync token set, the CLI submits with the master token, where the relay can verify no caller; naming the target pins the task even when the relay does not know the delegator's id.

A task submitted with `motebit delegate --target <agent>` is executed by that agent or by no one: a relay running this release never hands it to another worker when the target is offline. The task waits, expires or fails. Because the command now names its worker as `target_agent`, the relay prices a single-capability delegation at that capability's listed cost rather than the sum of everything the worker lists.
