---
"@motebit/web": minor
"@motebit/desktop": minor
---

Workstation becomes a navigable "window to the internet" — user and
motebit share one gaze, both drive the same reader-mode browser surface.

**Phase 1 scope — reader-mode interactive navigation:**

- Links inside the browser pane now click through to `read_url` via
  `invokeLocalTool`, so both model-driven and user-driven navigation
  flow through the same signed `ToolInvocationReceipt` pipeline.
- New Back button in the browser strip (disabled when history is
  empty). Maintains per-panel-instance history stack; standard browser
  semantics (forward history truncates on new navigation).
- URL-bar Enter now pushes to history alongside link-click-through.
- Every navigation is auditable via the existing receipt stream —
  nothing new to wire; governance + sensitivity gates apply as-is.

**What did NOT change:**

- Backend stays `read_url` reader-mode (server-side fetch + HTML-strip
  - markdown render). Phase 2 swaps the backend for real interactive
    browsing — embedded WebView on desktop, relay-hosted cloud browser
    on web/mobile/spatial — without changing this UX contract.
- No new protocol primitive. `BrowserSession` is deferred until Phase
  2 infra actually requires session state (cookies, tabs, auth).
  Premature protocol shape locks in the wrong abstraction.

**Phase 2 roadmap (not in this commit):**

- Desktop: embed a real WebView, forward input, stream DOM events
  through the same navigation pipeline. Workstation becomes the
  motebit's actual web browser.
- Web/mobile/spatial: relay-hosted cloud browser (sovereign-via-relay,
  fits the 5% relay-business model; BYO headless supported for
  sovereign tier).
- Desktop-only: computer use via OS accessibility APIs + signed
  `screen.observe` / `screen.act` tools.

All 28 drift gates pass; all 178 web tests pass.
