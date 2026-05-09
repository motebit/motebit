---
"@motebit/ai-core": patch
---

navigate-slow-load-not-failure (ai-core companion) — new bullet
in `PERCEPTION_DOCTRINE` (`packages/ai-core/src/prompt.ts`)
teaches the AI to read navigate metadata before describing the
result. The key invariant: a `navigate` `ok: true` is the truth
— do NOT say "didn't load" or "timed out" when ok:true came
back, because the user's slab is showing the page.
`slow_load: true` with `visual_content_detected: true` means
"loaded, took a moment" — hedge, don't reject.

Sibling of the browser-sandbox-side fix in
`navigate-slow-load-not-failure.md` which adds the
`slow_load` field to the `navigate` result envelope.

1 regression test in `prompt.test.ts` pinning the navigate
doctrine bullet so a future prompt edit can't drop it
silently.
