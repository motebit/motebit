---
"motebit": minor
"@motebit/sdk": minor
"@motebit/protocol": minor
---

**A paid delegation's result can now be fetched by task id, for free, after the session that paid for it is gone** (#874).

Before this, a delegation whose payment settled but whose result poll failed had no recovery path. Nothing fetched a result by task id, and the record of the unretrieved payment lived only in memory. After a restart, a user asking for "the result of task ed665235 — I already paid for it" got an agent whose only tool was `delegate_to_agent`: a second paid hire. Only a human "n" at the payment prompt stopped it.

`motebit` (CLI):

- `/result` lists the paid tasks whose results have not arrived. `/result <task_id>` fetches one with a single authenticated `task:query` read. It never submits a task and never pays. A short id (the first 8 characters) works for an outstanding paid task. `/result <task_id> <owner_id>` reads a task filed under another motebit, which is what `motebit delegate`'s relay-mode path does. `/result dismiss <task_id>` clears an entry once the relay has reaped the task and the result is gone. With nothing recorded, it says "No paid result is known on this device". That is not a claim that nothing is owed anywhere.
- A paid delegation is written to `~/.motebit/motebit.db` (migration 49) the moment the relay accepts it. It is written as **in flight** and tagged with the current runtime session. While that session is still polling, the entry locks nothing: concurrent hires, including two of the same worker and capability, proceed exactly as before. It becomes **unretrieved** in two cases: the poll ends without the result, or a different session reads it because the process that was polling died. Only unretrieved entries refuse a re-hire of the same worker and capability, or suspend paid hiring once two are owed. A delivered result resolves the entry. A ledger write that fails (for example SQLITE_BUSY) is logged with the task id and tx, and never aborts the hire, the poll or the settlement facts returned on failure. The record is per identity. Entries are keyed by task, not by worker and capability. The old in-memory ledger keyed them by worker and capability, so two lost results of the same pair overwrote each other and the two-owed suspension never fired. It now does.

One limit: two processes on one database (the REPL and a daemon) each see the other's in-flight hires as unretrieved. Normally that lasts until the poll ends. If the delivery's resolve write itself fails, the entry stays for the other process, and for the next session, until `/result <task>` retrieves it. Running `/result dismiss` on a hire that another process is still polling clears the entry.

- When paid results are waiting, startup prints one line, e.g. `1 paid result not retrieved — /result ed665235`.
- The model gets a `retrieve_task_result` tool (read-only, api tier, R0). Its description tells the model to use it instead of delegating again. It returns typed fields: `status`, `already_paid`, `retrieval_cost`, `payment`, `result`. It refuses while the runtime is running another principal's task, so a customer's prompt cannot read this motebit's paid tasks. In that situation `delegate_to_agent`'s duplicate-payment refusal also omits the owner's task id, tx and `/result` pointer.
- `motebit delegate --sovereign` now uses the same durable ledger. Before, it was the one paid path with no interlock. When its payment settles and the result does not arrive, it prints the `/result` command.
- `motebit delegate` used to print an unauthenticated `curl` hint on timeout, which could only ever 401. It now prints the `/result` command.
- `/serve` no longer offers `delegate_to_agent`, `discover_agents` or `retrieve_task_result` to callers.

`@motebit/protocol`: `ToolDefinition` gains an optional `localOnly` flag, an exposure axis. A tool that sets it acts for the motebit's owner against its own interior. No MCP server built on `@motebit/mcp-server` lists it or executes it as a direct tool call, and no surface advertises it. The flag does not remove the tool from the agent loop that `motebit_task` runs; a tool that must be unreachable there guards its own handler. Absent means unchanged behavior.

`@motebit/sdk`: this adds `PaidIntentRecord`, `PaidIntentStoreAdapter` and an optional `StorageAdapters.paidIntentStore`. The change is additive. A surface without the store keeps the in-memory interlock, which holds for one process only.
