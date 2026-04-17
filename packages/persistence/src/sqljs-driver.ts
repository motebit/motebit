import * as fs from "node:fs";
import type { DatabaseDriver, PreparedStatement, RunResult } from "./driver.js";
import type { SqlJsDatabase } from "sql.js";

/** Flush delay (ms) for file-backed databases after mutations. */
const FLUSH_DELAY_MS = 1000;

/**
 * SqlJsDriver — pure WASM SQLite driver using sql.js.
 *
 * Implements the DatabaseDriver interface so all persistence adapters
 * work identically whether backed by better-sqlite3 or sql.js.
 *
 * Key differences from better-sqlite3 that this driver bridges:
 * - sql.js statements are stateful cursors, not reusable — we create
 *   a fresh statement per run/all/get call.
 * - File persistence is manual — we debounce `db.export()` writes.
 * - WAL mode is a no-op (sql.js runs in-memory with optional file flush).
 * - `pragma("user_version")` returns `[{ user_version: N }]` to match
 *   the better-sqlite3 format.
 */
export class SqlJsDriver implements DatabaseDriver {
  readonly driverName = "sql.js";

  private db: SqlJsDatabase;
  private dbPath: string | null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  /**
   * Nested-transaction counter. sql.js has no native `db.transaction()`
   * helper, so we issue `BEGIN` on the outermost entry and `SAVEPOINT s_N`
   * for each subsequent nested call — matching better-sqlite3's shape.
   */
  private txnDepth = 0;

  private constructor(db: SqlJsDatabase, dbPath: string | null) {
    this.db = db;
    this.dbPath = dbPath;
  }

  /**
   * Open a sql.js database, loading WASM and reading existing file if present.
   *
   * @param dbPath - File path for persistence, or `:memory:` for in-memory only.
   */
  static async open(dbPath: string): Promise<SqlJsDriver> {
    const initSqlJs = (await import("sql.js")).default;
    const SQL = await initSqlJs();

    const isMemory = dbPath === ":memory:";
    let data: Uint8Array | undefined;

    if (!isMemory) {
      try {
        data = new Uint8Array(fs.readFileSync(dbPath));
      } catch {
        // File doesn't exist yet — will be created on first flush
      }
    }

    const db = new SQL.Database(data);
    return new SqlJsDriver(db, isMemory ? null : dbPath);
  }

  exec(sql: string): void {
    this.db.run(sql);
    this.scheduleDirtyFlush();
  }

  prepare(sql: string): PreparedStatement {
    return new SqlJsPreparedStatement(this.db, sql, () => this.scheduleDirtyFlush());
  }

  pragma(sql: string): unknown {
    // Parse common pragma patterns
    const trimmed = sql.trim();

    // journal_mode = WAL → no-op for sql.js (in-memory engine)
    if (/^journal_mode\s*=/i.test(trimmed)) {
      return undefined;
    }

    // foreign_keys = ON/OFF → execute directly
    if (/^foreign_keys\s*=/i.test(trimmed)) {
      this.db.run(`PRAGMA ${trimmed}`);
      return undefined;
    }

    // user_version = N → set pragma
    const setUserVersion = trimmed.match(/^user_version\s*=\s*(\d+)$/i);
    if (setUserVersion) {
      this.db.run(`PRAGMA user_version = ${setUserVersion[1]}`);
      this.scheduleDirtyFlush();
      return undefined;
    }

    // user_version (get) → return [{user_version: N}] to match better-sqlite3
    if (/^user_version$/i.test(trimmed)) {
      const result = this.db.exec("PRAGMA user_version");
      const value =
        result.length > 0 && result[0]!.values.length > 0
          ? (result[0]!.values[0]![0] as number)
          : 0;
      return [{ user_version: value }];
    }

    // Generic pragma — execute and return raw result
    const result = this.db.exec(`PRAGMA ${trimmed}`);
    if (result.length === 0) return undefined;
    const cols = result[0]!.columns;
    return result[0]!.values.map((row) => {
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < cols.length; i++) {
        obj[cols[i]!] = row[i];
      }
      return obj;
    });
  }

  close(): void {
    // Flush immediately on close
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.dirty) {
      this.flushToFile();
    }
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    // Outer call issues BEGIN; nested calls use named savepoints so a
    // throw in an inner call can roll back to its own boundary without
    // aborting the outer. Matches better-sqlite3's composition shape.
    const depth = this.txnDepth;
    this.txnDepth = depth + 1;
    const useSavepoint = depth > 0;
    const label = useSavepoint ? `motebit_sp_${depth}` : null;

    if (useSavepoint) {
      this.db.run(`SAVEPOINT ${label!}`);
    } else {
      this.db.run("BEGIN");
    }

    try {
      const result = fn();
      if (useSavepoint) {
        this.db.run(`RELEASE ${label!}`);
      } else {
        this.db.run("COMMIT");
        this.scheduleDirtyFlush();
      }
      return result;
    } catch (err) {
      if (useSavepoint) {
        // Roll back just this savepoint, then release it to clear state.
        this.db.run(`ROLLBACK TO ${label!}`);
        this.db.run(`RELEASE ${label!}`);
      } else {
        this.db.run("ROLLBACK");
      }
      throw err;
    } finally {
      this.txnDepth = depth;
    }
  }

  private scheduleDirtyFlush(): void {
    this.dirty = true;
    if (!this.dbPath) return; // :memory: mode, no file I/O

    if (this.flushTimer) return; // Already scheduled
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.dirty) {
        this.flushToFile();
      }
    }, FLUSH_DELAY_MS);
  }

  private flushToFile(): void {
    if (!this.dbPath) return;
    const data = this.db.export();
    fs.writeFileSync(this.dbPath, Buffer.from(data));
    this.dirty = false;
  }
}

/**
 * Wraps sql.js's stateful cursor API to match better-sqlite3's
 * `stmt.run()` / `stmt.all()` / `stmt.get()` interface.
 *
 * Each call creates a fresh sql.js statement to avoid cursor state issues.
 */
class SqlJsPreparedStatement implements PreparedStatement {
  constructor(
    private db: SqlJsDatabase,
    private sql: string,
    private onMutate: () => void,
  ) {}

  run(...params: unknown[]): RunResult {
    const flatParams = flattenParams(params);
    this.db.run(this.sql, flatParams);
    this.onMutate();
    return { changes: this.db.getRowsModified() };
  }

  all(...params: unknown[]): unknown[] {
    const flatParams = flattenParams(params);
    const stmt = this.db.prepare(this.sql);
    try {
      stmt.bind(flatParams);
      const rows: Record<string, unknown>[] = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject());
      }
      return rows;
    } finally {
      stmt.free();
    }
  }

  get(...params: unknown[]): unknown {
    const flatParams = flattenParams(params);
    const stmt = this.db.prepare(this.sql);
    try {
      stmt.bind(flatParams);
      if (stmt.step()) {
        return stmt.getAsObject();
      }
      return undefined;
    } finally {
      stmt.free();
    }
  }
}

/**
 * Flatten variadic params into a single array.
 * better-sqlite3 calls look like `stmt.run(a, b, c)` (spread args),
 * so we receive `[a, b, c]`. Pass them through as-is for sql.js bind().
 * Returns undefined (no params) when the array is empty.
 */
function flattenParams(params: unknown[]): unknown[] | undefined {
  if (params.length === 0) return undefined;
  return params;
}
