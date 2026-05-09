---
"@motebit/browser-sandbox": patch
---

navigate-slow-load-not-failure — fix the AI saying "didn't load"
while the slab clearly showed the page loaded.

**The bug Daniel surfaced.** On production /computer:

open google → ✓ loaded
open yahoo → ✓ loaded
open nba.com → AI: "NBA.com timed out — too heavy for the
browser." But seconds later the slab streamed frames
showing nba.com fully rendered.
try google.com → AI: "Timed out — Google didn't load."
Slab clearly showed Google's homepage with search bar
and buttons.

The AI was honest about its tool result; the tool result was
wrong. `services/browser-sandbox`'s navigate handler called
`page.goto(url, { waitUntil: "domcontentloaded", timeout:
15_000 })` and rethrew on timeout as a `ServiceError`. But
goto's 15s timeout is the _DOMContentLoaded readiness ceiling_,
not the navigation's actual outcome — heavy SPAs and slow CDNs
commonly commit the navigation, paint partial-then-full content,
and would settle a few seconds later. Throwing told the AI
"navigate failed" while the screencast kept showing the page.

**Fix at the source.** `executeAction` for `navigate` now
catches Playwright's `TimeoutError` specifically (matched on
`/timeout|TimeoutError/i`), continues into the heuristic +
inline-screenshot path, and marks `slow_load: true` on the
result envelope. The 15s ceiling stays — the
"honest-failure-faster" intent is preserved — but the failure
shape now matches reality:

- `slow_load: true` + `visual_content_detected: true` →
  page loaded, took longer than expected.
- `slow_load: true` + `blank_page_detected: true` →
  navigation committed, page is still empty (the AI
  describes this honestly).
- Non-timeout errors (`ERR_NAME_NOT_RESOLVED`,
  `ERR_CONNECTION_REFUSED`, etc.) still propagate as real
  failures — the navigation didn't commit, the slab has
  nothing to show.

3 new tests in `services/browser-sandbox/src/__tests__/action-executor.test.ts`:
timeout from goto returns ok:true + slow_load:true;
Playwright TimeoutError class instance same shape;
successful goto leaves slow_load:false. The companion
ai-core prompt-doctrine update lives in
`navigate-slow-load-not-failure-ignored.md`.
