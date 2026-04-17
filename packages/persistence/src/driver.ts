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
 * Abstract database driver interface.
 *
 * Matches the API surface used across all persistence adapter classes:
 * `exec`, `prepare`, `pragma`, `close`, `transaction`. Implementations
 * include better-sqlite3 (native, sync) and sql.js (WASM, async open).
 */
export interface DatabaseDriver {
  readonly driverName: string;
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
