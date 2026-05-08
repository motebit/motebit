---
"@motebit/protocol": minor
---

Co-browse Slice 2c-batching-1 — wheel input. The first continuous
event class on top of Slice 2c's discrete substrate.

**New `wheel` variant on `UserInputEvent`** — `{ kind: "wheel"; x,
y, dx, dy, event_count }`. Logical-pixel cursor anchor + CSS-pixel
scroll deltas matching `WheelEvent.deltaX`/`deltaY` axis convention
(positive `dy` scrolls down). `event_count` reports how many native
wheel events the capture surface coalesced into this one.

**Coalescing contract (foundation law).** Capture surfaces MUST
coalesce native wheel events at ≤60Hz — one wire event per ~16ms
window. Sustained scrolling at 100Hz native rate (modern trackpads)
must NOT produce 100 wire events/sec. Without this constraint
POST-per-event saturates the wire. The capture surface sums dx/dy
across the window and uses the LATEST cursor position so a swipe
that drifts mid-scroll lands at the user's actual cursor.

**Audit shape extension** — `UserInputForwardedDetail` gains a
`wheel` variant: `{ kind: "wheel"; x_norm, y_norm, dx, dy,
event_count }`. Anchor coords normalize to [0, 1] like clicks;
deltas pass through unchanged (CSS-pixel scroll amounts aren't
sensitivity-bearing content).

**Spec** — `spec/computer-use-v1.md` §5.5 documents the wire +
audit shapes and the coalescing contract.

Drag, continuous pointermove, selection-drag remain deferred —
they need either burst-aggregated audit (one entry per drag rather
than per frame) or a WebSocket-shaped substrate to sustain >60Hz.
This slice is wheel only; it ships the simplest continuous event
class that works on the existing POST substrate.
