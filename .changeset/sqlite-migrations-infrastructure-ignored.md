---
"@motebit/sqlite-migrations": minor
"@motebit/persistence": patch
---

Schema-version-tracked SQLite migration runner — phase 5-prep for the retention-policy ship.

Three SQLite surfaces (mobile expo-sqlite, desktop Tauri-IPC rusqlite, persistence better-sqlite3 / sql.js) had three independently-evolved migration ladders pre-prep with three version lines, three different error-swallow disciplines, and two of three lacked transaction wrapping. The new package `@motebit/sqlite-migrations` is the canonical source of truth; each surface registers its schema changes as `Migration` entries and consumes the shared runner.

```text
Migration { version: number; description: string; statements: readonly string[] }
runMigrations(driver, migrations[])      // sync — better-sqlite3, sql.js, expo-sqlite
runMigrationsAsync(driver, migrations[]) // async — Tauri IPC across the renderer/Rust boundary
```

Both runners apply each migration in its own transaction (sync uses the driver's typed `transaction` primitive; async uses explicit `BEGIN`/`COMMIT`/`ROLLBACK` strings). The runner's internal `migrateExec` swallows the narrow `duplicate column | already exists` error class — the only errors that fire when an `ALTER TABLE` re-runs against a fresh-DB at-rest `CREATE TABLE` that already declared the column. Every other error rolls back the migration and re-throws; the version pragma stays at the prior value, so the next boot retries cleanly. Registry validation (strict-monotonic versions starting at 1, no gaps) fires at startup.

`@motebit/persistence` consumes the runner: 33 inline `if (userVersion < N)` blocks collapsed into one declarative `PERSISTENCE_MIGRATIONS` array; `createMotebitDatabaseFromDriver` calls `runMigrations(driver, PERSISTENCE_MIGRATIONS)`. `apps/mobile/src/adapters/expo-sqlite.ts` ports its own 18-version registry into `MOBILE_MIGRATIONS` and wraps `expo-sqlite`'s sync API in a 30-line `expoSqliteDriver` shim. `apps/desktop` adds `runDesktopMigrations(invoke)` wired into the boot path before storage adapters are constructed; the desktop registry starts empty (the at-rest schema in `apps/desktop/src-tauri/src/main.rs` already covers the latest column shape), so phase 5-ship's `sensitivity` column is the first entry to land there.

Per-surface registries are intentional, not a unification gap — mobile and persistence have already-divergent histories and overlapping but non-identical tables. Phase 5-ship appends one `Migration` entry to all three registries simultaneously to land the `sensitivity` column across surfaces uniformly. Drift gate `check-sqlite-migration-runner` (invariant #66) locks the boundary: schema-version writes (`PRAGMA user_version = N`) only happen through the runner, never inline. Three driver-internal pragma sites are allowlisted with reasons.

100% test coverage on the runner: empty registry on fresh DB is a no-op, single migration on fresh DB advances to v1, re-running is idempotent, partial failure rolls back the migration with `user_version` unchanged, duplicate-column / already-exists errors are swallowed, non-duplicate errors propagate, registry validation rejects gaps and non-monotonic ordering.
