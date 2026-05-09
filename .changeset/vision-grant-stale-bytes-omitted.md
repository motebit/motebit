---
"@motebit/ai-core": patch
---

vision-grant-stale-bytes-omitted — close the seam where
`/vision grant` flipped consent state but the AI kept reading
the prior `bytes_omitted_reason: "consent_required"` tool result
from conversation history.

**The bug Daniel surfaced.** On `/computer`:

1. User typed "open google.com" → AI called `computer({kind:
"screenshot"})` while `pixelConsent` was still `"denied"`.
2. The screenshot's bytes were stripped at the projection step
   (`packages/ai-core/src/loop.ts:181`) and the result landed
   in conversation history with
   `bytes_omitted_reason: "consent_required"`.
3. User typed `/vision grant` → runtime state flipped to
   `"session"`. ✓
4. User asked "can you see the page?" — AI re-read the _prior_
   tool result (still in history with omitted bytes) and
   replied "the screenshot came back but pixel content was
   omitted, type /vision grant".
5. User asked "what about now" — AI took a _fresh_ screenshot,
   this one passed all three gates, AI saw the page.

The "two commands required" appearance was an illusion —
`/vision` (no arg) is a status query that does no functional
work; the second user message was what triggered the AI to
re-capture.

**Fix.** New rule in `PERCEPTION_DOCTRINE`
(`packages/ai-core/src/prompt.ts`): when the [Now] block reports
`Pixel passthrough: session` but a prior tool result in
conversation history shows `bytes_omitted_reason: "consent_required"`,
that result is **stale** — the user has granted passthrough since
that capture. Re-take the screenshot before answering. Same
shape for `bytes_omitted_reason: "sensitivity_blocked"` once the
session sensitivity has been lowered.

The rule anchors on already-typed truth (the [Now] block already
surfaces `Pixel passthrough: <state>`; the bytes_omitted directive
already carries a structured reason) — no new state, no synthetic
messages, no transient channels. One bullet, one invariant.

Pinned by a regression test in `prompt.test.ts`.
