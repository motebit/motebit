---
"@motebit/render-engine": minor
"@motebit/web": patch
"@motebit/desktop": patch
---

v1.2b of the virtual_browser arc: two-finger-hold-on-plane gesture and
`/halt` / `/resume` slash commands — the user-floor primitive
(`ComputerSessionManager.halt()` from v1.2) is now reachable from a
touch surface and a keyboard surface, with a single fail-closed
`user_preempted` boundary per `computer-use-v1.md §3.3`.

`@motebit/render-engine` ships:

- `slab-plane-gesture.ts` — pure two-finger-hold detector. State
  machine is DOM-free; the `attachPlaneGestureToTarget` helper wires
  pointer events on a real `EventTarget`. Filters to
  `pointerType === "touch"` so trackpad and mouse never spuriously
  arm. Hold threshold 700ms, movement tolerance 12px CSS — calibrated
  from the Material long-press default and iOS contextual-menu hold.
  Twenty-two tests covering arming, completion, cancellation,
  fired-state lockout, progress dedup, and DOM-wiring filters.
- `SlabManager` integration. The detector runs inside the manager,
  ticked from the same `update()` loop the creature's
  sympathetic-breathing uses (no parallel rAF). Visual: emissive
  intensity ramps with hold progress; on halt the slab holds a
  sustained ~0.5× peak glow until `setHalted(false)` is called.
- `RenderAdapter.setSlabHaltGestureHandler` and
  `RenderAdapter.setSlabHalted` — optional surface methods so adapters
  that don't render a touch surface (XR's `WebXRThreeJSAdapter`)
  simply omit them. `ThreeJSAdapter` implements both.

`@motebit/web` and `@motebit/desktop` wire two trigger surfaces:

- The slab's two-finger-hold fires `sessionManager.halt()` directly;
  the slab self-marks halted as the gesture completes.
- `/halt` and `/resume` slash commands dispatch
  `motebit:halt` / `motebit:resume` `CustomEvent`s; both apps subscribe
  in their bootstrap path and call `sessionManager.halt()` /
  `.resume()` plus `adapter.setSlabHalted(...)` so the visual mirrors
  the manager's state. Listeners are tracked and torn down in `stop()`
  so a teardown leaves no live event handlers behind.

Doctrine: `motebit-computer.md` §"The user's touch — supervised
agency". Three triggers (touch gesture, keyboard, AI's own future
"stop" tool) compose the same primitive — that's the point of the
v1.2 split.
