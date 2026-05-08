---
"@motebit/protocol": minor
---

Co-browse Slice 2c — protocol additions for user-driven input forwarding.

The driveability substrate. With Slice 2c wired the user can click,
type, and paste inside the cloud Chromium when `controlState.kind ===
"user"`; Slice 1's gate continues to deny motebit dispatch unless
state === motebit. The consent loop opened by Slice 2b's slab band +
the AI-side `request_control` tool now has both sides.

**New wire format** — `UserInputEvent` discriminated union (click |
key | paste). Carries the raw data Chromium needs to dispatch (text,
logical-pixel coordinates, modifier flags). Coordinate system
matches the existing `ComputerAction.click` shape — logical pixels
against the cloud Chromium viewport. The capture surface is
responsible for translating CSS rect → logical pixels before
forwarding.

**Discrete events only.** Click + key + paste only. Wheel, drag,
continuous pointermove, selection-drag, and file-drag are
explicitly out of v1 — POST-per-event cannot sustain 50+ events/sec
at 30-100ms RTT; those classes require batching/coalescing or a
WebSocket-shaped substrate, deferred to a follow-up slice.

**New audit shape** — `UserInputForwardedPayload`, redacted by
construction:

- Keys log as `character_class` (letter / digit / punct / whitespace
  / control / modifier / unknown) plus `key_role` (enter / tab /
  escape / backspace / arrow / shortcut / printable / unknown).
  Raw key value NEVER logged. Multi-char unrecognized key names
  (IME composition strings) MUST collapse to `character_class:
"unknown"` rather than being classified by their first character.
- Pastes log `length`, `line_count`, `looks_like_url`. Content
  NEVER logged.
- Pointer events log normalized [0, 1] coordinates against the
  rendered screencast rect. Raw pixels NEVER logged.

`control_state_at_forwarding` mirrors the `control_state_at_denial`
field on motebit-side denials (Slice 1) — verifiers reconstruct
context without cross-referencing adjacent control events.

**New `EventType.UserInputForwarded`** entry on the audit-event
enum. Emitted on every forward attempt — successes and rejections
both — so the audit trail records who tried to drive when.

**Closed-set rejection reasons** (`UserInputRejectionReason`):
`not_in_user_state` | `session_closed` | `transport_error` |
`not_supported`. Verifiers discriminate exhaustively.

**Spec** — `spec/computer-use-v1.md` §5.5 documents both wire and
audit formats, codifies the discrete-events-only scope, and pins
the sensitivity-boundary deferral (user-driven frames are still
observations; existing classification policy applies; medical /
financial / secret co-browse use requires an explicit policy pass
on the screencast surface itself).

Surface scope: `virtual_browser` only. `desktop_drive` has no
co-browse machine to drive — the user's real OS is the source —
and surfaces without a `ControlState` machine MUST NOT register
the affordance.
