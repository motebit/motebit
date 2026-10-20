/** Result from a mutating SQL statement. */
export interface RunResult {
  changes: number;
}

/** A prepared SQL statement that can be executed with parameters. */
export interface PreparedStatement {
  run(...params: unknown[]): RunResult;
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

/**
 * What an acknowledged write survives.
 *
 * - `"commit"` — every committed transaction is durable before the call
 *   returns (better-sqlite3: WAL + fsync on commit).
 * - `"snapshot"` — commits land in memory and reach disk as a whole-database
 *   snapshot some time later (sql.js: debounced atomic save, plus flush on
 *   close/exit/SIGINT/SIGTERM). A crash in between loses the writes since
 *   the last snapshot, never the snapshot itself.
 */
export type DriverDurability = "commit" | "snapshot";

/**
 * Abstract database driver interface.
 *
 * Matches the API surface used across all persistence adapter classes:
 * `exec`, `prepare`, `pragma`, `close`, `transaction`. Implementations
 * include better-sqlite3 (native, sync) and sql.js (WASM, async open).
 */
export interface DatabaseDriver {
  readonly driverName: string;
  /** The guarantee this driver gives an acknowledged write. Absent = unknown; treat as `"snapshot"`. */
  readonly durability?: DriverDurability;
  exec(sql: string): void;
  prepare(sql: string): PreparedStatement;
  pragma(sql: string): unknown;
  close(): void;
  /**
   * Run `fn` inside a transaction. On return, commit. On throw, roll back
   * and rethrow. Consumers of this driver MUST NOT call `exec("BEGIN")` /
   * `exec("COMMIT")` / `exec("ROLLBACK")` by hand — those strings leak
   * transaction state across stack frames and mis-interact with nested
   * calls. The primitive here is synchronous and composable: nested
   * `transaction()` calls use savepoints under better-sqlite3 and a
   * matching manual-savepoint polyfill under sql.js.
   *
   * NOT part of `AccountStore`. Cross-table atomicity at the ledger
   * interface belongs in compound methods (`debitAndEnqueuePending`),
   * not a generic `withTransaction` leak — see
   * `@motebit/virtual-accounts`'s CLAUDE.md. This primitive sits one
   * layer below, at the persistence boundary, so *services* can wrap
   * multi-statement writes without each reinventing BEGIN/COMMIT.
   */
  transaction<T>(fn: () => T): T;
}
