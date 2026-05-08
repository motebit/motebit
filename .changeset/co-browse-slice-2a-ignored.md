---
"@motebit/web": patch
---

Co-browse Slice 2a — apps wire activates the Slice 1 gate.

Until this slice landed, Slice 1's `not_in_control` gate was tested
but dormant: no app constructed a `CoBrowseControlMachine`, so
`coBrowseControl` was undefined everywhere and the no-op branch
fired. 2a flips that. `apps/web/src/computer-tool.ts` now:

1. **Constructs the machine at registration time** — well before any
   `openScreencast.onError` could fire. The transport-failure
   handler references the machine by closure; constructing here
   keeps the order stable so a stream error during early session
   setup never references an undefined machine.
2. **Wires `onTransition` into the audit log.** Each accepted
   transition lands as one `co_browse_control_changed` event with
   the typed `CoBrowseControlChangedPayload`. Same fail-soft shape
   as the existing `ComputerSessionOpened/Closed/Summarized`
   appends.
3. **Passes the machine into `createComputerSessionManager` as
   `coBrowseControl`.** Slice 1's gate now fires in production for
   the first time: motebit-driven `executeAction` denies with
   `not_in_control` whenever `state.kind !== "motebit"`, stamping
   the literal `ControlState` on the per-action ledger.
4. **Calls `machine.disconnect()` on transport failure** —
   `dispatcher.openScreencast`'s `onError` handler reverts to user.
   A dead screencast means we've lost our window into the page; if
   motebit was driving, it must yield.
5. **Calls `machine.disconnect()` in `closeAndEmit`** — covers
   programmatic close, dispose, and the page-unload-equivalent
   path. jsdom doesn't fire `beforeunload` reliably, so the wire
   shape is exercised via direct `dispose()` test.
6. **Exposes `coBrowseControl` on the registration handle.** Slice
   2b (slab UI affordances) reads `getState()` and drives
   transitions; Slice 2c (pointer/keyboard wire forwarding) reads
   the same surface to know when to capture user input vs forward
   to the dispatcher.

The gate now denies by default — the existing default state is
`{kind: "user"}`, which means every motebit-driven action is denied
until the user grants. Existing computer-tool tests that expected
the dispatcher to fire have been updated to call a new
`grantMotebit(reg)` helper before the action, simulating the
production UX (slab gesture or slash command granting the request).

5 new Slice 2a tests cover: handle exposes the machine in user
state; gate fires through the registration; dispatcher executes
once motebit holds; transitions land on the audit log; dispose
reverts to user (the page-unload-equivalent wire shape).

Slice 2b (slab UI affordances for the control band + gestures) and
Slice 2c (pointer/keyboard wire forwarding) sit on top of this.
Fly redeploy lights up Slice 2c's screencast endpoint in prod.
