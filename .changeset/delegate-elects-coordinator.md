---
"motebit": patch
---

`motebit delegate --plan` now runs the runtime-host election before touching shared state (daemon-desktop unification follow-up — closes the "one-shot subcommands" residual). The plan run constructs a transient runtime over the shared `~/.motebit` database and, in sovereign mode, signs with the identity key — a full authority while it lives, however briefly. It is now coordinator-role for its lifetime: it binds `~/.motebit/runtime.sock` before opening the database and releases the bind when the plan completes, or refuses honestly — naming the live coordinator's pid — when another motebit process already coordinates the machine. A delegate run can no longer race a running daemon as a second signing authority over the same key and database.

With no coordinator running, `motebit delegate` behaves exactly as before.
