---
"motebit": minor
---

History memory recall — the `recall_memories` tool gains an optional `include_history` flag to return every version of a belief at once (current and since-superseded), each labelled.

Completes the bi-temporal recall surface alongside `as_of`. Where `as_of` gives a point-in-time snapshot, `include_history` returns all versions with a per-entry `[current]` / `[superseded <date>]` label so a revised belief can never be read as current fact; the two modes are mutually exclusive. Also corrects the `rewrite_memory` tool description: a superseded memory is no longer described as "tombstoned" — it is kept and reconstructable via `as_of` / `include_history`, matching the actual (non-destructive) supersede behavior.
