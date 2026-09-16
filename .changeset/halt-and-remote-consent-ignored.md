---
"@motebit/runtime": minor
"@motebit/persistence": minor
"@motebit/relay-client": minor
"@motebit/relay": minor
"@motebit/mobile": minor
---

Halt, and the consent root reaching the runtime — increment 2 of unattended execution.

`@motebit/runtime`: the halt verbs (`requestHalt` / `honorHalts` / `liftHalt` / `haltInForce` / `onHalt`), the `halt`, `resume` and `halt-status` commands, `approvals approve|deny <id>` on the existing `approvals` command, and `redactForRemoteDisclosure` — the credential-class membrane applied to approval arguments bound for a remote consent surface.

`@motebit/persistence`: migration #44 `halt_state` + `SqliteHaltStore`; `ApprovalItem`/`ApprovalStatus` now re-exported from the protocol.

`@motebit/relay-client`: `sendAgentCommand()` — the first production minter of an `agent-command/{motebit_id}` envelope.

`@motebit/relay`: `halt`, `resume` and `halt-status` added to the forwarded runtime-side command set. The relay still never decides: it verifies at ingress as defence in depth and forwards the envelope verbatim for the runtime to re-verify fail-closed.

`@motebit/mobile`: `sendRemoteCommand()` plus `/halt`, `/resume`, `/halted`, `/pending`, `/approve`, `/deny`. The approval card now renders arguments per field with middle-elision instead of a 120-character JSON slice — a cut that routinely landed before the destination, which made the card a prompt to trust the tool's name rather than to decide on the action.
