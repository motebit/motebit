---
"@motebit/ai-core": patch
---

navigate-noop-when-already-there — perception doctrine teaches
the AI to no-op when the user asks to "open X" but the [Now]
block already reports the browser is at X.

**The bug Daniel surfaced.** Three sequential screenshots from
production /computer:

1. User: "open nba.com" → AI navigates, page loads, AI says
   "NBA.com is open on your slab."
2. User: "open nba.com" (same request) → AI fires
   `request_control` → "asks to drive" Grant/Deny prompt
   appears in the slab chrome.
3. User grants → AI fires `navigate` → "browser · waiting
   for first frame…" placeholder shows on the slab → page
   re-renders → AI says "NBA.com is open."

Same URL, same outcome — but with a control-request prompt,
a slab reset to the placeholder, and a redundant render in
between. Friction for zero outcome change.

**Root cause.** The [Now] block already surfaces
`Browser: open at <url>` (`packages/ai-core/src/prompt.ts:252`).
The AI just had no rule that said "compare the requested URL
to current state, no-op if equal." Every "open X" message got
treated as a fresh navigation.

**Fix.** New bullet in `PERCEPTION_DOCTRINE`: if the [Now]
block reports the browser is open at the URL the user is asking
to open (same scheme + host + path; trailing slash or
default-port differences are equal), the request is a no-op —
acknowledge without calling `request_control` or `navigate`.
"Reload" or "refresh" are the explicit re-fetch verbs.

This is the same shape as the other typed-truth doctrine rules
shipped this session (bytes_omitted staleness when consent is
session, navigate ok:true with slow_load is success): typed
state in [Now] is the answer; the AI reads it instead of
re-running the action.

1 regression test in `prompt.test.ts` pinning the rule.
