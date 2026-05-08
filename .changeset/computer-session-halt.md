---
"@motebit/runtime": minor
---

v1.2 of the virtual_browser arc: `ComputerSessionManager` halt / resume
primitive — fail-closed `user_preempted` boundary the user holds over
every dispatcher.

`computer-use-v1.md §3.3` declares the user-floor invariant: "When a
human user halts a session, in-flight atomic action MAY complete; no
new dispatch begins." Until v1.2 the runtime had no way to express
"halt." The slab plane gesture (two-finger hold per
`motebit-computer.md`) and the slash command and the AI's own future
"stop" tool all need to compose the same primitive — three triggers,
one boundary.

`createComputerSessionManager` now exposes `halt()`, `resume()`, and
`isHalted()`. While halted, every `executeAction` call returns
`{ outcome: "failure", reason: "user_preempted" }` BEFORE the session-
validity check, BEFORE governance classification, and BEFORE the
dispatcher runs. Halt is the user's stop button — it overrides every
other failure mode, including allow-classified actions on closed
sessions, so the manager is honest about _why_ the action did not
run.

In-flight actions complete naturally, per the spec carve-out: the
primitive's contract is "no new dispatch starts," not "abort current
call mid-flight" — Playwright and Tauri input-injection paths do not
support `AbortSignal` at every step, and the spec explicitly does
not require it. Seven new tests pin the semantics: idempotency, no-
dispatcher-call when halted, halt-preempts-governance, halt+resume
cycles, in-flight completion, halt+closed-session ordering.

Doctrine: `motebit-computer.md` §"The user's touch — supervised
agency" — gestures on items invoke typed primitives, not prompts.
Halt is the first primitive shaped by that doctrine that lives at
the runtime layer where every trigger surface meets it.
