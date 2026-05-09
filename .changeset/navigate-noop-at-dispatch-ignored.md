---
"@motebit/ai-core": patch
---

navigate-noop-at-dispatch (ai-core companion) — new clause in the
PERCEPTION_DOCTRINE navigate-result bullet teaches the AI that
`already_there: true` means the dispatch short-circuited because
the page was already at the requested URL. The AI describes the
page as unchanged ("you're already on X") rather than narrating
a fresh navigation. Sibling of `slow_load`,
`visual_content_detected`, `blank_page_detected`,
`access_denied_detected` — typed-truth on the result, not
confabulation from conversation memory.

1 regression test in `prompt.test.ts` pinning the new doctrine
clause so a future prompt edit can't drop it silently.

Companion sandbox changeset: `navigate-noop-at-dispatch`
(`urlsAreEquivalent` + `doNavigate` short-circuit).
