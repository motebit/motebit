---
"@motebit/render-engine": patch
---

live-browser-disable-native-image-drag — fix the actual root
cause of the click+hold+drag → screen disappears bug.

The earlier `attachSlabGestures` carve-out
(live-browser-gesture-carveout) correctly removed the slab's
swipe-to-dismiss from `live_browser` cards, but the screen kept
vanishing — that wasn't the unmount path. The real path,
traced from first principles:

1. `<img>` is `draggable=true` by default in HTML. The
   screencast img in `buildLiveBrowserElement` never set this
   to false.
2. User click+hold on the frame → browser starts a NATIVE
   drag operation. The "captures the image" feel is the
   browser's drag-ghost preview.
3. User releases → `drop` event fires on `document`.
4. `apps/web/src/ui/drop.ts` is a document-level drop handler
   that classifies drops via `classifyDropEvent`. The dragged
   img's `dataTransfer.text/uri-list` is the JPEG data: URI
   of the current frame — that classifies as `kind: "url"`.
5. `runtime.feedPerception(payload)` fires.
   `defaultUrlHandler` in `packages/runtime/src/perception.ts`
   opens a new `kind: "fetch"` slab item with the data URI as
   the URL. That displaces the visible surface; the
   live_browser card vanishes.

**Fix.** The screencast IS an interactive surface, not a
saveable image. The browser's default `<img>` drag semantics
conflict with our usage. In `buildLiveBrowserElement`:

- `img.draggable = false` — disables the standard HTML drag
  affordance.
- `img.style.userSelect = "none"` — prevents the screencast
  being interpreted as text content.
- `img.style.setProperty("-webkit-user-drag", "none")` —
  legacy WebKit fallback for older Safari versions that don't
  fully honor `draggable=false` on data: URIs.

Closes the cascade at the source. No native drag → no drop
event → no `feedPerception` hijack → no card displacement.
The earlier swipe-gesture carve-out remains correct — it
prevents the slab's own dismiss path on horizontal pointer
drags that aren't native browser drags (trackpad swipes,
touch). Both fixes compose.

Pinned by a regression test in
`packages/render-engine/src/__tests__/live-browser.test.ts`.
