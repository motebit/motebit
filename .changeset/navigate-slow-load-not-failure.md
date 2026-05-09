---
"@motebit/browser-sandbox": patch
"@motebit/ai-core": patch
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

**Companion AI-side rule** in `PERCEPTION_DOCTRINE`
(`packages/ai-core/src/prompt.ts`): a new bullet teaches the
AI to read the navigate metadata before describing the
result. Specifically: a `navigate` `ok: true` is the truth —
do NOT say "didn't load" or "timed out" when ok:true came
back, because the user's slab is showing the page.
`slow_load: true` with `visual_content_detected: true` means
"loaded, took a moment" — not "failed."

**Tests.**

- 3 new tests in
  `services/browser-sandbox/src/__tests__/action-executor.test.ts`:
  timeout from goto returns ok:true + slow_load:true;
  Playwright TimeoutError class instance same shape;
  successful goto leaves slow_load:false.
- 1 new regression in
  `packages/ai-core/src/__tests__/prompt.test.ts` pinning
  the navigate-doctrine bullet so a future prompt edit
  can't drop it silently.
- The existing "throws not_supported when goto fails"
  test now asserts non-timeout DNS errors still propagate
  (renamed to `with a non-timeout error` for clarity).

39 action-executor / 402 ai-core tests pass; all 69 drift
defenses clean.
