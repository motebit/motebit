---
"motebit": minor
---

As-of memory recall — the `recall_memories` tool gains an optional `as_of` (ISO date) parameter to reconstruct what the agent believed at a past point in time.

Bi-temporal recall was already in the memory graph but unreachable by the agent. Passing `as_of` now filters memories to those valid `[valid_from, valid_until)` around that instant, and the result is framed as a historical snapshot (superseded beliefs are reported as past belief, never current fact). Omitting `as_of` is unchanged current recall. An unparseable date is a hard error rather than a silent fall-back to current recall.
