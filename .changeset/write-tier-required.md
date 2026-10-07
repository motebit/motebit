---
"motebit": patch
---

Every memory, goal and goal-outcome write carries the tier its content was produced at. A plan reflection's learnings are stamped with the tier of the run that reflected (previously always `none`, so a learning from a secret run could be recalled into a later request on an external provider). Goals created by `motebit goal add`, `motebit up` routines and the daemon's memory-maintenance goal are stamped at `personal` (owner-authored text written outside a session); only goals that pre-date the stamp column keep the legacy rule. A memory a remote caller stores without declaring a tier is stamped at the session's tier instead of `none`. Two goal runs that overlap no longer lower each other's tier when one finishes first.

On desktop, a sub-goal the model creates during a run is now written in one step with its tier (it previously could not be created at all, and a goal created before the runtime was up was left unstamped). A memory written from the desktop's first-run greeting, or stored by an attached surface or remote caller, carries the session's tier.
