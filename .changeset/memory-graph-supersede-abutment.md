---
"@motebit/memory-graph": patch
---

Fix bi-temporal supersede abutment: stamp `valid_until`/`valid_from` from a single clock read.

Both supersede paths (`consolidateAndForm` UPDATE, `supersedeMemoryByNodeId`) read `Date.now()` twice across an `await` — once for the superseded node's `valid_until`, once (inside `formMemory`) for the new node's `valid_from` — so under scheduling jitter the intervals diverged: a temporal **gap** (no belief valid) or **overlap** (two beliefs valid) instead of abutting exactly. `formMemory` now accepts an optional `atMs` stamp; both supersede paths pass a single `now`, so `new.valid_from === old.valid_until` by construction. Surfaced as a flaky CI failure on the consolidation eval (the abutment assertion) that never reproduced on slower hardware; a deterministic jitter test now guards both paths.
