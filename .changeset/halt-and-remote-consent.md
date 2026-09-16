---
"@motebit/protocol": minor
"motebit": minor
---

Halt, and the consent root reaching the runtime — increment 2 of unattended execution.

Increment 1 made a motebit's unattended work survivable across a crash. This one answers the other two clauses: **reach me when it needs authority, stop when I withdraw it.**

**Halt is durable state, not a message.** A message a stopped process never receives is not a stop, and a stop a restart forgets is not a stop either. `HaltRequest` + `HaltStoreAdapter` (protocol) and migration #44's `halt_state` (persistence) keep `requested_at` and `acknowledged_at` as separate facts, because they are: a daemon that is offline has been ASKED to stop and has not stopped. No surface may render the first as the second, and the CLI waits a few seconds then says plainly which happened.

**Three verbs, deliberately not one.** `runtime.requestHalt()` records that someone asked — any process may, including a one-shot CLI that is not the thing doing the work. `runtime.honorHalts()` is the executor stopping and saying what stopping entailed; it is idempotent, and a stopper that throws still acknowledges with the failure in the record rather than looking like "still running" forever. `runtime.liftHalt()` is a human giving the permission back.

**The scheduler consults it in four places**: before a tick does anything, before each goal fires (a goal-scoped halt stops only that goal), before a recovered approval executes, and before idle consolidation runs — and the in-flight run is aborted. A halt outranks an approval granted before it: the later word wins, and the approval is kept rather than thrown away.

**The first mutating verbs in the remote-command vocabulary**, and the first production minter of an `agent-command/{motebit_id}` envelope — the fail-closed verification stack has shipped on all five surfaces since the unification arc with nothing signing for it. `RelayClient.sendAgentCommand()` mints and sends; `motebit halt|resume|halt-status --remote` and the phone's `/halt`, `/resume`, `/halted` use it. No privilege is added: the envelope is signed by the motebit's own identity key, so the caller already holds sovereign authority. What is added is reach.

**The phone can decide an approval.** `/pending`, `/approve <id>`, `/deny <id>` list and resolve the daemon's queue over the same signed channel; the daemon picks the verdict up on its next tick through the same policy gate (a money action is still never executed from a recovered run). What the phone is shown goes through the same credential-class redaction as any egress to a non-sovereign party — destination, path and amount visible so the decision is real, secrets masked, full arguments never leaving the machine — alongside a hash over the _whole_ argument set, so a truncated preview is detectable rather than merely trusted. `ApprovalItem` moves to `@motebit/protocol` (re-exported from persistence) because it now crosses a wire, and `ApprovalStoreAdapter` gains optional `listPending` / `get` / `resolve` so a consent surface can read and decide rather than only vote on quorum.

**Not in this increment, and named rather than half-built:** the daemon's event log never leaves the machine, so "reach me" is pull (the phone asks) and not push (the motebit notifies). That gap is cross-surface — desktop and web have it too — and a push notification arc belongs on its own. A disconnected runtime also cannot receive a remote halt at all; the command says "not delivered" rather than pretending, and bounding that window with a contact lease is deferred.
