---
"@motebit/runtime": minor
---

Co-browse Slice 1 — control-state gate on `executeAction`.

`ComputerSessionManagerDeps` gains optional `coBrowseControl?:
CoBrowseControlMachine`. When provided, `executeAction` denies
dispatch with `not_in_control` whenever the machine reports
`state.kind !== "motebit"`, and stamps the literal `ControlState`
on the per-action ledger entry's `control_state_at_denial` field
so the signed `actions_hash` covers it (tampering breaks the
session receipt's signature).

`coBrowseControl` is only present for `virtual_browser` co-browse
sessions; `desktop_drive` is exempt because its control/consent
model is separate (the user's real OS is the source; there's no
isolated browser to hand off). When the dep is undefined, the gate
is a no-op — preserves desktop_drive and any existing
non-co-browse path unchanged.

Gate ordering inside `executeAction`:

1. `halted` → `user_preempted` (user-floor)
2. session-validity → `session_closed` (sanity)
3. **co-browse control → `not_in_control`** (new)
4. governance classify → `policy_denied` / `approval_required`
5. dispatcher.execute

Halt is "stop everything"; session-validity is "is there a session
to act on"; control is "who is allowed to act"; governance is "what
acts are allowed." The new gate sits at the third position because
a closed session has no meaningful control state, but a controlled
session has nothing to do with what governance allows.

`recordOutcome` accepts an optional `controlStateAtDenial` second
arg; only the new gate passes it. Other denial paths
(user_preempted, session_closed, policy_denied, etc.) leave the
field absent — the protocol type's `iff` invariant holds at the
runtime side.

10 new tests cover: user/handoff_pending/paused all denying with
correct stamped state, motebit allowing existing path, undefined
dep preserving existing behavior, user-reclaim from motebit
blocking the next action, disconnect from motebit/handoff/paused
all reverting and blocking, and the actions_hash tamper test
(swapping `control_state_at_denial` value on a signed receipt body
produces a different hash → signature would fail). All 69 drift
gates green; full workspace lint clean.

Slice 2+ (pointer/keyboard wire forwarding into the cloud Chromium)
sits on top of this gate, not behind it. The contract is now
load-bearing: motebit-driven dispatch goes through this check; user
drive on the slab will route around it. Wire forwarding can ship
when Fly redeploys make the screencast endpoint live.
