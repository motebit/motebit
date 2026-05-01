/**
 * Schema-version-tracked SQLite migrations for the three motebit SQLite
 * surfaces (mobile expo-sqlite, desktop Tauri-IPC rusqlite, persistence
 * better-sqlite3 / sql.js). One `Migration` shape, two runners — sync for
 * surfaces that hold a synchronous SQLite handle, async for surfaces that
 * route every statement through an IPC boundary.
 *
 * The runner is structurally typed so each surface adapts its own driver
 * into the minimal shape the runner needs. No package depends on a specific
 * SQLite implementation; this package has zero monorepo deps.
 */

/**
 * One schema-evolution step, applied at most once per database. Applied in
 * ascending `version` order; each migration's `statements` are executed in
 * a single transaction (sync runner) or under explicit BEGIN/COMMIT (async
 * runner). On success, `PRAGMA user_version` advances to `version`.
 *
 * `statements` may contain multiple SQL strings. Each is passed through the
 * built-in `migrateExec` helper which swallows "duplicate column" /
 * "already exists" errors only — the patterns produced when an
 * `ALTER TABLE ADD COLUMN` re-runs against a fresh DB whose CREATE TABLE
 * already declared the column. Any other error (disk full, syntax error,
 * permission denied) re-throws and rolls back the migration; the version
 * pragma stays at its prior value so the next boot retries cleanly.
 *
 * Empty `statements: []` is a legal no-op migration that exists only to
 * advance the version counter (placeholder slots from earlier
 * implementation-driven version bumps).
 */
export interface Migration {
  /** Strictly monotonic, starting at 1. Versions are durable and never reused. */
  readonly version: number;
  /** Free-form description recorded in the registry; never read at runtime. */
  readonly description: string;
  /** SQL statements executed in order; empty array = no-op version bump. */
  readonly statements: readonly string[];
}

/**
 * Minimal sync driver shape. Persistence's `DatabaseDriver` satisfies this
 * structurally; mobile wraps `expo-sqlite`'s synchronous API in a tiny
 * adapter; tests use an in-memory fake.
 */
export interface SyncSqliteDriver {
  exec(sql: string): void;
  /** Read or write `PRAGMA user_version`. Reads return `[{ user_version: number }]`. */
  pragma(sql: string): unknown;
  /** Run `fn` inside a transaction; rollback on throw, commit on return. */
  transaction<T>(fn: () => T): T;
}

/**
 * Minimal async driver shape. Desktop's Tauri renderer wraps `dbExecute` /
 * `dbQuery` (which round-trip through IPC) into this. No transaction
 * primitive — Tauri IPC has no typed transaction helper today; the runner
 * uses explicit BEGIN/COMMIT/ROLLBACK strings instead. Migration during
 * boot is single-caller, so cross-IPC interleaving is not a concern here;
 * if a later consumer needs transactional async migrations under
 * concurrent load, add a typed `transaction` to this interface and gate it
 * with a Rust-side IPC command.
 */
export interface AsyncSqliteDriver {
  exec(sql: string): Promise<void>;
  /** Read `PRAGMA user_version`. */
  getUserVersion(): Promise<number>;
  /** Write `PRAGMA user_version = N`. */
  setUserVersion(version: number): Promise<void>;
}

/**
 * Validate the registry shape. Caught at startup, never at production
 * migration time. Strict-monotonic with no gaps starting at 1; that
 * invariant lets the runner skip the simple `migration.version <= currentVersion`
 * check and trust the array order.
 */
function validateRegistry(migrations: readonly Migration[]): void {
  for (let i = 0; i < migrations.length; i++) {
    const expected = i + 1;
    const actual = migrations[i]!.version;
    if (actual !== expected) {
      throw new Error(
        `sqlite-migrations: registry must be strict-monotonic starting at 1; ` +
          `entry at index ${i} has version ${actual}, expected ${expected}`,
      );
    }
  }
}

// Both substrings come straight from libsqlite3's C source and are stable
// across every driver in scope (better-sqlite3, sql.js, expo-sqlite,
// rusqlite via Tauri IPC) — the wrappers propagate the SQLite error
// message verbatim. If a future driver normalizes errors into a different
// vocabulary, extend the regex; do not add per-driver branches.
const DUPLICATE_COLUMN_RE = /duplicate column|already exists/i;

/**
 * Execute a single statement, swallowing the narrow set of errors SQLite
 * raises when a migration's ALTER TABLE / CREATE INDEX races against a
 * fresh-DB at-rest CREATE TABLE that already declared the column / index.
 * All other errors propagate.
 */
function migrateExecSync(driver: SyncSqliteDriver, sql: string): void {
  try {
    driver.exec(sql);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (DUPLICATE_COLUMN_RE.test(msg)) return;
    throw err;
  }
}

async function migrateExecAsync(driver: AsyncSqliteDriver, sql: string): Promise<void> {
  try {
    await driver.exec(sql);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (DUPLICATE_COLUMN_RE.test(msg)) return;
    throw err;
  }
}

function readUserVersion(driver: SyncSqliteDriver): number {
  const result = driver.pragma("user_version") as { user_version: number }[];
  return result[0]?.user_version ?? 0;
}

/**
 * Apply pending migrations to a sync SQLite driver. Idempotent: re-running
 * after success is a no-op. Each migration runs in its own transaction;
 * partial failure rolls back atomically and the version pragma stays at the
 * prior value so the next call retries from the same point.
 */
export function runMigrations(
  driver: SyncSqliteDriver,
  migrations: readonly Migration[],
): { from: number; to: number; applied: number[] } {
  validateRegistry(migrations);
  const from = readUserVersion(driver);
  const applied: number[] = [];

  for (const migration of migrations) {
    if (migration.version <= from) continue;
    driver.transaction(() => {
      for (const sql of migration.statements) {
        migrateExecSync(driver, sql);
      }
      driver.exec(`PRAGMA user_version = ${migration.version}`);
    });
    applied.push(migration.version);
  }

  const to = readUserVersion(driver);
  return { from, to, applied };
}

/**
 * Apply pending migrations to an async SQLite driver. Same semantics as
 * `runMigrations`, but transactions use explicit BEGIN/COMMIT/ROLLBACK
 * strings (no typed primitive on the async surface). Single-caller during
 * boot is the assumption; see `AsyncSqliteDriver` for the contract.
 */
export async function runMigrationsAsync(
  driver: AsyncSqliteDriver,
  migrations: readonly Migration[],
): Promise<{ from: number; to: number; applied: number[] }> {
  validateRegistry(migrations);
  const from = await driver.getUserVersion();
  const applied: number[] = [];

  for (const migration of migrations) {
    if (migration.version <= from) continue;
    await driver.exec("BEGIN");
    try {
      for (const sql of migration.statements) {
        await migrateExecAsync(driver, sql);
      }
      await driver.setUserVersion(migration.version);
      await driver.exec("COMMIT");
    } catch (err) {
      await driver.exec("ROLLBACK");
      throw err;
    }
    applied.push(migration.version);
  }

  const to = await driver.getUserVersion();
  return { from, to, applied };
}
