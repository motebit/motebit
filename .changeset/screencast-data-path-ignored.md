---
"@motebit/runtime": minor
---

v1.3 slice 1 — live screencast data path.

`@motebit/browser-sandbox`:

- New `screencast.ts` — wraps Playwright's `context.newCDPSession(page)`
  and drives CDP `Page.startScreencast` (JPEG, 60% quality, 1280×800
  max, every-2nd-frame). Each frame is decoded into a
  `ScreencastFrame` and acked back to CDP (`Page.screencastFrameAck`)
  so the stream keeps flowing.
- New `GET /sessions/:id/screencast` route — streams NDJSON frames
  over the standard bearer-auth boundary. One screencast per session
  (double-start returns `policy_denied`); the `ReadableStream.cancel`
  hook on consumer disconnect tears down the CDP session cleanly,
  and `closeSession` runs the screencast disposer before
  `BrowserContext.close()` so teardown order is deterministic.
- Pool: `BrowserSession.stopScreencast` slot tracks the active
  disposer; cleared when a screencast ends.

`@motebit/runtime`:

- `CloudBrowserDispatcher.openScreencast({onFrame, onError})` —
  fetch + `Authorization: Bearer <token>` + `Response.body.getReader()`
  - newline-split decode. Handles frames split across read chunks,
    surfaces transport errors via `onError`, and returns an idempotent
    disposer that aborts the read. Service-side double-start surfaces
    as a `ComputerDispatcherError` with the structured envelope's
    reason.

8 server-side screencast unit tests + 3 route lifecycle tests + 5
dispatcher tests. UI integration is slice 2.
