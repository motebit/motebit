---
"@motebit/web": patch
---

v1.3 slice 2 hardening — duplicate-card suppression + first-frame
fallback contract.

Without this slice, every `computer` tool action emits a
`tool_call` slab card per spec §"audit register" — fine when the
slab has no live surface, but a perceptual duplicate when the live
screencast is also painting the cloud Chromium. Stills layered
over a continuous frame surface read as a slideshow over a movie.

`ScreencastFrameBus.hasFrame()` — predicate that flips false → true
on first publish, true → false on `reset()`. The slab uses this to
gate suppression: per-action cards stay visible until the first
frame lands (fallback contract — a screencast that fails to start
or stalls before frame 1 leaves per-action stills as the visible
content). Once frames flow, per-action cards become audit-only
(slab-hidden div, still emitted, still on the receipt chain).

`apps/web/src/ui/slab-items.ts` — module-scoped predicate wired by
`setLiveBrowserSuppressionPredicate(fn)`. The renderer's
`buildCardForKind` checks the predicate per-item BEFORE the kind
switch: `tool_call` items in `virtual_browser` mode that match a
truthy predicate render as `<div data-slab-hidden="true"
style="display: none">`. Other kinds and other modes are unaffected
— a `desktop_drive` `tool_call` keeps its card, a `live_browser`
slab item is itself never suppressed.

`apps/web/src/web-app.ts` — registers the predicate at `bootstrap`
entry: `() => liveBrowserItemId !== null && screencastBus.hasFrame()`.
Captures the WebApp's slot for the live item and the bus state via
closure, so the predicate fires correctly even as sessions open and
close.

Cleanup verified through reading: `closeAndEmit` runs surface
dissolve → stopScreencast → bus.reset → sessionManager.closeSession
in that order, so the live slab item is gone before the bus stops
publishing, and CDP teardown happens against a still-attached
session. Tab-close path: browser cancels the in-flight fetch →
server's `ReadableStream.cancel` runs → server-side
`stopScreencast` disposer fires; pool's idle reaper handles
anything that escapes that.

5 suppression tests + 4 hasFrame() tests. All 69 drift gates
green; 269 web tests pass.
