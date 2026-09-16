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

Review round (`/code-review 677 high`, 9 findings) — all fixed:

- **Raw arguments no longer ride beside the redacted text.** The live-turn fallback returned `data.args` unredacted while redacting only the display string, and `data` is serialized whole through the relay — the exact leak the redaction exists to prevent.
- **Scope travels structurally, never inside the reason.** A `goal <id> <reason>` grammar read `--reason "goal cleanup done"` as halting a goal named "cleanup": nothing was halted and the response said a goal had been stopped. A stop command that reports stopping something must have stopped something.
- **A halt can interrupt work in progress.** Honoring ran inside the scheduler's single-flight guard, which a goal run holds for its whole duration (up to ten minutes), so a locally-written halt could not abort the run it was for. Phase 0 now runs outside the guard.
- **A goal-scoped halt is genuinely scoped.** Both approval drains checked only the motebit-wide halt, so a narrow halt still executed that goal's approved call.
- **The local CLI path emits its events.** `halt_requested` and `halt_lifted` were reachable only via `--remote`; the default path left no record of who asked or who lifted.
- **Truncation is measured, not guessed.** A `length >= 500` threshold reported the 200-char previews most producers store as complete, so the phone saw a preview cut before the destination with nothing saying so. Now compared against the stored full arguments, with `null` for rows that predate them.
- **The relay routes these verbs to a runtime that can serve them.** Every surface answers `command_request`, so a halt could be answered by the phone that sent it ("this surface cannot be halted") while the daemon kept running — indistinguishable from a refusal. They now go to a peer announcing `background`, or fail as undelivered.
- Trailing text on an approve is no longer written as a denial reason, and a halt another actor acknowledged first is read from the record rather than inferred from a return value.

A follow-on found in the fix itself: moving halt-honoring outside the scheduler's single-flight guard made concurrent entry ordinary (the daemon's interval and an inline remote `halt` overlap), and `honorHalts` emitted `HaltAcknowledged` unconditionally — two "it stopped" events for one stop, in the log that exists to be the honest record of exactly that. Honoring is now serialized, with callers queuing rather than sharing a result so a halt written mid-pass still gets a pass of its own.

Second review round (`/code-review 677 high`) — eight findings, two of which meant the feature never worked at all:

- **Every remote command was rejected with a 401 before the envelope was examined.** `/api/v1/agents/*` sits behind the agent auth middleware and this path is not public; the client sent no bearer, and the phone minted the `sync` audience where the route requires `admin:query`. Both paths now authenticate, and the CLI supplies a device key. The relay tests missed it because they authenticate with the operator master token, which takes a bypass branch; the mobile tests stubbed `fetch`.
- **The phone's 401 handler gave a confident wrong diagnosis** — it blamed the device key for what was an audience mismatch. It now carries the relay's own reason and offers the key as a possibility.
- **Routing by `background` did not select the daemon.** The desktop app announces it and wires neither store, so a halt could be answered "this surface cannot be halted" while the daemon kept running. New `DeviceCapability.UnattendedRuntime`, announced only by a surface that wired the halt and approval stores.
- **Mutating verbs had no replay defence.** Freshness alone was enough while the vocabulary was read-only; a captured `resume` replayed inside the window would lift a halt. `CommandReplayGuard` (`@motebit/runtime`) refuses a repeated envelope signature.
- **Moving halt-honoring above the tick body also moved it outside that body's try/catch**, turning a busy SQLite write into an unhandled rejection that would end the daemon. Phase 0 has its own guard, and a stopper that never settles is now bounded rather than wedging every later halt.
- "No unattended runtime is connected" returns 404 rather than 500, so a consent surface can read it as "not delivered".
- The structured halt scope requires a `goal_id` marker, so a reason like `{"deploy":"done"}` is no longer parsed and silently discarded.
- The `args_hash` claim is narrowed to what is true: the remote surface carries it forward, it cannot verify it.

And the test that would have caught it, added at the layer that defines the contract: the relay now pins that this route refuses a request with no bearer, refuses the `sync` audience (the exact mistake that made every phone command fail), and accepts `admin:query` — with `packages/relay-client` asserting the other half, that the client sends one. The two halves meet at the real middleware rather than at a stub that agreed with them.

Third review round (`/code-review 677 high`) — six findings, all fixed:

- **`motebit halt goal <prefix>` halted nothing while reporting a stop.** The docs prescribe the 8-character prefix `motebit goal list` prints, and the scope check is an exact match — the same class of failure as the reason-parsed-as-scope one, one layer along. The id is now resolved before anything is recorded or sent, and an id matching no goal is refused.
- **The acknowledgement overclaimed.** It said "aborted run X" the moment the signal was raised, but the signal is observed between steps, so a tool call already dispatched runs to its end. It now says the abort was signalled and that an in-flight call finishes — the same honesty the two timestamps exist for, one layer down.
- **A halt spent the goal's retry budget.** The abort surfaced as a run failure, so three stops over a week would auto-pause the goal, and lifting the halt would silently not be enough to start it again. A stop the human asked for is no longer counted as a failure.
- **`motebit serve` wired the halt store but could neither be reached nor stopped.** It did not announce `unattended_runtime`, so the relay refused to route a halt to it; and with no goal scheduler nothing honored a local halt, so the row sat un-acknowledged while the worker kept accepting tasks. It now announces the capability, refuses relay-dispatched work while halted, and acknowledges on its own cadence.
- Approvals keep expiring while halted, so the queue is not frozen overnight and then expired all at once on resume; and the stopper timeout is cleared rather than left pending, which would hang a short-lived process for ten seconds on exit.

And the structural fix the pattern called for. Three rounds found three ways to record a halt whose scope matched nothing — a reason parsed as a goal name, an unresolved 8-character prefix, an id that did not exist — each producing the one failure a stop command must never have: the record said a goal was halted, `halt-status` listed it as in force, and the goal kept firing. Fixing the fourth call site would have been the fourth fix. `SqliteHaltStore.request` now refuses a goal-scoped halt whose goal does not exist for that motebit, so no caller — CLI, command layer, phone, or one not written yet — can record one.
