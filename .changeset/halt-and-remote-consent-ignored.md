---
"@motebit/runtime": minor
"@motebit/persistence": minor
"@motebit/relay-client": minor
"@motebit/relay": minor
"@motebit/mobile": minor
"@motebit/wire-schemas": minor
---

Halt, and the consent root reaching the runtime — increment 2 of unattended execution.

`@motebit/runtime`: the halt verbs (`requestHalt` / `honorHalts` / `liftHalt` / `haltInForce` / `onHalt`), the `halt`, `resume` and `halt-status` commands, `approvals approve|deny <id>` on the existing `approvals` command, and `redactForRemoteDisclosure` — the credential-class membrane applied to approval arguments bound for a remote consent surface.

`@motebit/persistence`: migration #44 `halt_state` + `SqliteHaltStore`; `ApprovalItem`/`ApprovalStatus` now re-exported from the protocol.

`@motebit/relay-client`: `sendAgentCommand()` — the first production minter of an `agent-command/{motebit_id}` envelope.

`@motebit/relay`: `halt`, `resume` and `halt-status` added to the forwarded runtime-side command set. The relay still never decides: it verifies at ingress as defence in depth and forwards the envelope verbatim for the runtime to re-verify fail-closed.

`@motebit/mobile`: `sendRemoteCommand()` plus `/halt`, `/resume`, `/halted`, `/pending`, `/approve`, `/deny`. The approval card now renders arguments per field with middle-elision instead of a 120-character JSON slice — a cut that routinely landed before the destination, which made the card a prompt to trust the tool's name rather than to decide on the action.

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
