---
"@motebit/protocol": minor
---

Co-browse Slice 1 — protocol additions for the executeAction gate.

`COMPUTER_FAILURE_REASONS` gains `not_in_control` — fired when a
session's optional `coBrowseControl` machine reports
`state.kind !== "motebit"` at dispatch time. Distinct from
`user_preempted` (active halt) and `policy_denied` (governance):
this is "who is allowed to act" rather than "what acts are
allowed."

`ComputerSessionActionRecord` gains optional
`control_state_at_denial?: ControlState`. Present iff
`failure_reason === "not_in_control"` — control state at non-control
denials would be category noise. The runtime stamps the literal
state on the per-action ledger; the field flows through
`actions_hash` into the session receipt's signed commitment, so any
retroactive edit to the recorded state breaks the signature. The
audit answers "what state were we in" without cross-referencing
adjacent `co_browse_control_changed` events.

@alpha — same release status as the rest of computer-use.ts.
