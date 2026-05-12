---
"@motebit/protocol": minor
---

Add `frame_stale` to `COMPUTER_FAILURE_REASONS` — typed-truth reason for the Playwright navigation race during action dispatch.

Additive (new union member). Before this entry, Playwright's "Execution context was destroyed" / "frame was detached" / "Target closed" / "Target page, context or browser has been closed" errors fell through the browser-sandbox route handler's general catch into `platform_blocked` (HTTP 500). The AI received an opaque server-fault and verbally interpreted it as "the platform is blocking key presses" — prose interpretation of a typed event.

`frame_stale` is the proper typed reason for "the page navigated underneath the action; the executor's frame reference is stale." Distinct from `session_closed` (the session is still open; only the frame changed) and `platform_blocked` (OS-level synthetic-input block). Paired with one-shot retry in `services/browser-sandbox` and a `PERCEPTION_DOCTRINE` clause in `@motebit/ai-core` so the AI surfaces the recovery path ("the page changed — let me re-read") instead of confabulating about platform failure.
