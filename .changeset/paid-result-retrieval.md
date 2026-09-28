---
"motebit": minor
"@motebit/sdk": minor
---

**A paid delegation's result can now be fetched by task id, for free, after the session that paid for it is gone** (#874).

Before this, a delegation whose payment settled but whose result poll failed had no recovery path. Nothing fetched a result by task id, and the record of the unretrieved payment lived only in memory. After a restart, a user asking for "the result of task ed665235 — I already paid for it" got an agent whose only tool was `delegate_to_agent`: a second paid hire. Only a human "n" at the payment prompt stopped it.

`motebit` (CLI):

- `/result` lists the paid tasks whose results never arrived. `/result <task_id>` fetches one with a single authenticated `task:query` read. It never submits a task and never pays. A short id (the first 8 characters) works for an outstanding paid task. `/result <task_id> <owner_id>` reads a task filed under another motebit, which is what `motebit delegate`'s relay-mode path does. `/result dismiss <task_id>` clears an entry once the relay has reaped the task and the result is gone.
- The record of settled-but-unretrieved payments is now stored in `~/.motebit/motebit.db` (migration 49), per identity. A new session therefore still refuses to re-hire the same worker for the same capability, and points at `/result <task_id>` instead.
- When paid results are waiting, startup prints one line, e.g. `1 paid result not retrieved — /result ed665235`.
- The model gets a `retrieve_task_result` tool (read-only, api tier, R0). Its description tells the model to use it instead of delegating again. It returns typed fields: `status`, `already_paid`, `retrieval_cost`, `payment`, `result`.
- `motebit delegate --sovereign` now uses the durable ledger too. Before, it was the one paid path with no interlock. When its payment settles and the result does not arrive, it prints the `/result` command.
- `motebit delegate` used to print an unauthenticated `curl` hint on timeout, which could only ever 401. It now prints the `/result` command.
- `/serve` no longer advertises `discover_agents` or `retrieve_task_result` as network capabilities.

`@motebit/sdk`: this adds `PaidIntentRecord`, `PaidIntentStoreAdapter` and an optional `StorageAdapters.paidIntentStore`. The change is additive. A surface without the store keeps the in-memory interlock, which holds for one process only.
