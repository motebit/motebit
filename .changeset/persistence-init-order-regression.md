---
"@motebit/persistence": patch
---

Fix relay crash on startup: `Error: no such column: routine_id` in
`initSchema`. Commit 2293c7ed (2026-04-17) added an `idx_goals_routine`
index to `SCHEMA_INDEXES` referencing the migration-added `routine_id`
column. But `initSchema` runs **before** migrations (line 2515 vs 2517),
so on any production DB at user_version < 31 the index creation tripped
on a column that migration #31 hadn't yet added. Migration #31 creates
the column AND its own copy of the index correctly — the
SCHEMA_INDEXES entry was redundant-and-broken.

Motebit-sync on Fly has been crashloop-restarting since the 2026-04-17
deploy because of this. Some CI deploys reported success anyway due to
smoke-check timing variance.

Fix: remove the duplicate index from `SCHEMA_INDEXES`. The migration
retains ownership. Regression test added in `sqljs-driver.test.ts`
simulates a pre-migration DB (drop index + column + rewind
user_version to 30) and confirms `createMotebitDatabaseFromDriver` no
longer crashes.

**Architectural invariant reaffirmed** (the comment on line 243 that
2293c7ed violated): indexes on migration-added columns live
**exclusively** inside their migration's `if (userVersion < N)` block.
SCHEMA_INDEXES references only columns declared in SCHEMA_TABLES. The
regression test pins this at runtime.
