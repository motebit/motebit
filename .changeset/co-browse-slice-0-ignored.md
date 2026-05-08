---
"@motebit/runtime": minor
---

Co-browse Slice 0 — `CoBrowseControlMachine` runtime primitive.
Companion to the published-side changeset in `@motebit/protocol`.

`createCoBrowseControlMachine({sessionId, motebitId, onTransition,
now})` returns a state machine in `{kind: "user"}` (sessions always
open with the user holding control — motebit must explicitly request).
Eight typed transitions (`requestControl`, `grantControl`,
`denyControl`, `reclaimControl`, `releaseControl`, `pause`, `resume`,
`disconnect`); rejections return
`{ok: false, reason: "invalid_from_state" | "wrong_party"}` rather
than throw, so callers can act on the rejection without try/catch.

Disconnect is the load-bearing fail-closed branch: from any state
`!== "user"`, drop reverts to user. The user is the always-trusted
party, and a connection drop could mean they've actively stopped or
closed the tab — the motebit cannot continue acting on a page the
user can no longer observe. Disconnect from `user` is a no-op AND
does not emit an audit event (no state change), so the transport
layer can call `disconnect()` unconditionally on observed drops
without polluting the log with redundant events.

User reclaim is unilateral — no approval, no handoff_pending step.
The user's identity is the trust root; they never need to ask the
motebit for permission to take their own browser back. Motebit-side
transitions (request, release) go through approval or yield; the
asymmetry is the point.

`CoBrowseControlMachine.getState()` is the read surface the slab and
the (future) executeAction gate will consume. Slice 0 explicitly does
NOT touch `ComputerSessionManager.executeAction` — that's Slice 1,
where motebit-driven dispatch becomes gated on
`controlState.kind === "motebit"`.

25 tests cover every transition × per-state legality, the four
disconnect branches, wrong-party rejections, and the
no-emit-on-rejection invariant (audit log stays clean across any
number of refused transitions).
