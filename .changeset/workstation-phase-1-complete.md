---
"@motebit/web": minor
"@motebit/desktop": minor
---

Close the remaining Phase 1 gaps on the Workstation browser pane.

**Added:**

- **Forward button** (`›`) next to Back. Disabled when no forward
  history; standard browser semantics (new navigation truncates
  forward history).
- **In-memory page cache** keyed by URL. Back/Forward render cached
  reader-mode content instantly without re-firing `read_url`. The
  cache populates from the controller's `state.currentPage` stream
  on every successful navigation, so both motebit-initiated and
  user-driven reads get cached once. Re-visiting a cached URL skips
  the tool call — no double-signed receipt for content the audit
  trail already has.
- **Relative URL resolution** — `<a href="/path">` now resolves
  against the current page via `new URL(href, currentUrl)`. Links
  with bare paths or `../` segments navigate correctly instead of
  getting silently dropped.
- Non-http(s) schemes still filtered after resolution (mailto,
  javascript, data, etc.).

**Phase 1 now complete.** The Workstation is a navigable reader-mode
browser window: forward, back, link click-through, cache, relative
URLs, URL-bar navigation, all through one `read_url` signed pipeline
with user and motebit sharing one gaze.

**Phase 2 targets** (infrastructure work, deferred — protocol
primitives for a real interactive browser + computer use land next
as dedicated cross-cutting pass):

- Desktop: embedded WebView (Tauri WKWebView/WebView2).
- Web/mobile/spatial: relay-hosted cloud browser with frame streaming.
- Desktop-only: computer use via OS accessibility APIs.

All 28 drift gates pass; 178 web tests green.
