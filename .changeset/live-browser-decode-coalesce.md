---
"@motebit/render-engine": patch
---

live-browser-decode-coalesce — eliminate the per-frame
flicker / "flashing" pattern Daniel surfaced on heavy
auto-animating pages (NBA.com cookie modal, ad rotation,
hero-video carousel).

**Two compounding root causes**

1. **The page itself.** NBA.com runs auto-animations the
   moment it loads — modal slide-in, carousel cycling, ad
   rotation. The CDP screencast at `everyNthFrame: 2`
   (~15-30 fps) faithfully captures every change. When the
   user clicks on the screencast, the click forwards to
   the cloud Chromium → most ad-heavy pages pause auto-
   rotation on user-interaction signals → "flashing"
   slows. Honest behavior of a busy page through an honest
   screencast — but it reads as chaos in the calm-software
   register.
2. **Frame-swap rendering pattern (the part we control).**
   `pushFrame` did `img.src = dataURI` synchronously per
   frame. Each src reassignment triggers a decode + paint
   on the visible img; on heavy content, the previous
   frame can briefly tear/blank during the decode of the
   next one, and bursts stack paints back-to-back. World-
   class screen-share clients pre-decode each frame on a
   hidden Image, then swap atomically once decode resolves.
   We didn't.

**Fix at the source**

- Pre-decode every incoming frame on a hidden `Image`
  using `Image.decode()` (Chrome 60+, Safari 11+, Firefox
  63+). The browser caches by data URI, so swapping the
  visible img's `src` to the same URI after decode
  resolves serves from cache — effectively atomic, no
  per-frame tear.
- Generation counter: each `pushFrame` increments
  `pendingGeneration` and snapshots its own value into
  `myGen`. When decode resolves, the paint callback drops
  if `myGen <= lastPaintedGeneration` — a newer frame
  already painted, this stale decode skips. Prevents the
  back-and-forth churn when frames arrive in bursts faster
  than they decode.
- Fallback path: `Image.prototype.decode` isn't defined in
  jsdom and other test envs. The sync paint path stays as
  the fallback — existing tests work unmodified, and
  real-browser code gets the smooth path.

**Tests**

- 2 new regression tests in
  `packages/render-engine/src/__tests__/live-browser.test.ts`:
  coalescing via the timestamp guard (sync path), and the
  decode-await pattern (stubs `Image.prototype.decode` to
  capture resolvers, asserts the visible img doesn't swap
  src until decode resolves).
- 12 live-browser tests pass; 388 render-engine tests pass.

Doesn't change the screencast frame rate or pause page
animations — those are separate calls if a future tuning
slice wants them. This commit makes the rendering pipeline
itself smooth so frame-rate is the only remaining lever.
