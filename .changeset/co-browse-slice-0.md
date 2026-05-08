---
"@motebit/protocol": minor
---

Co-browse Slice 0 — control-state primitive at the protocol layer.

Co-browse (the user driving inside motebit's isolated browser) is the
threshold UX motebit has been building toward: when the slab feels
like Chrome with motebit watching, helping, and able to take over with
permission, the product becomes obviously different from Cursor,
Claude Code, and normal browsers. Slice 0 lands the consent contract
_before_ the wire path — pointer/keyboard forwarding (Slice 1+) will
attach to a state machine that already encodes the trust model, not
the other way around.

The primitive is `ControlState`, a discriminated union over four
states the user named in their directive:

```ts
type ControlState =
  | { kind: "user" }
  | { kind: "motebit" }
  | { kind: "handoff_pending"; current: ControlHolder; requesting: ControlHolder }
  | { kind: "paused"; previousDriver: ControlHolder };
```

Plus `CO_BROWSE_TRANSITION_KINDS` (closed enum: `request_control`,
`grant_control`, `deny_control`, `reclaim_control`, `release_control`,
`pause`, `resume`, `disconnect`) and `CoBrowseControlChangedPayload`
for the audit-event shape.

Why a discriminated union, not a flat enum: `handoff_pending` needs to
know who currently holds and who's requesting (so a `deny` resolves to
the right side); `paused` needs to remember `previousDriver` so
`resume` restores continuity. Carrying that data in optional fields on
a flat enum would mean "remember to inspect this field when kind is
X." Discriminated union keeps the per-state shape a compile-time fact.

`EventType.CoBrowseControlChanged` enters the audit-event union. Every
transition emits one of these with full from/to state, so a verifier
replaying the log can independently rebuild the state machine without
re-running transition functions. Doctrine: the agent's awareness is
the integral of receipts over time — control transitions are
receipt-level events.

Runtime state machine and tests ship in the companion ignored
changeset.
