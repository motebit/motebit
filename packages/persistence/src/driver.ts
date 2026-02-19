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
 * `exec`, `prepare`, `pragma`, `close`. Implementations include
 * better-sqlite3 (native, sync) and sql.js (WASM, async open).
 */
export interface DatabaseDriver {
  readonly driverName: string;
  exec(sql: string): void;
  prepare(sql: string): PreparedStatement;
  pragma(sql: string): unknown;
  close(): void;
}
