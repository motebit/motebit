---
"@motebit/runtime": minor
---

Co-browse Slice 2c-batching-1 — wheel redaction + dispatcher
passthrough.

`buildUserInputAuditDetail` gains a wheel branch: anchor coords
normalize to [0, 1] against the cloud Chromium viewport, deltas
and event_count pass through unchanged. Symmetric to the click
branch (same divisor logic + zero-width defensive fallback).

`forwardUserInput` accepts the new wire kind transparently —
ComputerSessionManager doesn't need a wheel-specific code path.
Gate ordering, audit emission, transport-error handling all stay
identical to the discrete-event path.

`CloudBrowserDispatcher.forwardInput` accepts the wheel event
shape directly (the wire envelope `{event}` is variant-agnostic).
Server-side dispatch is `page.mouse.move(x, y) + page.mouse.wheel(
dx, dy)` — same Playwright primitive the existing motebit-side
`scroll` action uses.

Tests cover audit redaction (positive deltas, negative deltas,
zero-width defensive fallback) and exhaustive type-surface
discrimination (the wheel variant joins click/key/paste in the
union).
