import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import * as nodeOs from "node:os";
import { randomBytes } from "node:crypto";
import type { DatabaseDriver, DriverDurability, PreparedStatement, RunResult } from "./driver.js";
import type { SqlJsDatabase } from "sql.js";

/** Flush delay (ms) for file-backed databases after mutations. */
const FLUSH_DELAY_MS = 1000;

/**
 * The filesystem calls the driver makes. Injectable so tests can fault the
 * save at every step (partial write, fsync, rename, ENOSPC) deterministically.
 */
export interface SqlJsFs {
  readFileSync(path: string, encoding?: "utf-8"): Buffer | string;
  openSync(path: string, flags: string, mode?: number): number;
  writeSync(fd: number, buffer: Uint8Array, offset: number, length: number): number;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  renameSync(from: string, to: string): void;
  unlinkSync(path: string): void;
  statSync(path: string): { size: number; mode: number };
  readdirSync(path: string): string[];
}

/** The process surface the driver uses for liveness probes and exit/signal flush. */
export interface SqlJsProcess {
  readonly pid: number;
  readonly platform: string;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
  listenerCount(event: string): number;
  kill(pid: number, signal?: string | number): boolean;
}

export interface SqlJsDriverOptions {
  /** Filesystem seam. Default: `node:fs`. */
  fs?: SqlJsFs;
  /** Process seam (pid, liveness, exit/signal hooks). Default: the real `process`. */
  process?: SqlJsProcess;
  /** Host name written into the lock. Default: `os.hostname()`. */
  hostname?: string;
  /** Where a failed background flush is reported. Default: `console.warn`. */
  logger?: (message: string) => void;
}

interface LockBody {
  pid: number;
  hostname: string;
  token: string;
  acquired_at: number;
}

function errCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err ? String(err.code) : undefined;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Lock file path for a sql.js-backed database. */
export function sqlJsLockPath(dbPath: string): string {
  return `${dbPath}.sqljs-lock`;
}

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
 *
 * Durability is `"snapshot"`, never `"commit"`: the whole database lives in
 * memory and is saved as one snapshot, debounced by FLUSH_DELAY_MS after a
 * mutation and flushed on close, process exit, SIGINT and SIGTERM. A crash,
 * SIGKILL or power loss inside that window loses the writes acknowledged in
 * it. What it never loses is the last saved snapshot:
 *
 * - Save is atomic: export → unique temp file in the same directory → write
 *   all bytes → fsync → close → rename over the database → fsync the parent
 *   directory → only then clean. Any fault leaves the previous snapshot (or
 *   the new one) on disk, never a torn file; the temp is removed and the
 *   driver stays dirty.
 * - Open refuses rather than starting empty: only ENOENT means "absent";
 *   any other read error, a file that fails `PRAGMA quick_check`, or a
 *   non-empty `-wal` beside it (uncheckpointed native-driver frames this
 *   engine cannot read) throws.
 * - Single writer: an exclusive `<db>.sqljs-lock` (pid, host, token) is held
 *   from open to close. A second opener — another process or the same one —
 *   is refused. A lock whose pid is dead on this host is recovered; every
 *   save re-checks the token first, so a lost lock refuses to write.
 */
export class SqlJsDriver implements DatabaseDriver {
  readonly driverName = "sql.js";
  readonly durability: DriverDurability = "snapshot";

  private db: SqlJsDatabase;
  private dbPath: string | null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private closed = false;
  /**
   * Nested-transaction counter. sql.js has no native `db.transaction()`
   * helper, so we issue `BEGIN` on the outermost entry and `SAVEPOINT s_N`
   * for each subsequent nested call — matching better-sqlite3's shape.
   */
  private txnDepth = 0;
  private readonly fs: SqlJsFs;
  private readonly proc: SqlJsProcess;
  private readonly logger: (message: string) => void;
  private lockToken: string | null;

  private constructor(
    db: SqlJsDatabase,
    dbPath: string | null,
    fs: SqlJsFs,
    proc: SqlJsProcess,
    logger: (message: string) => void,
    lockToken: string | null,
  ) {
    this.db = db;
    this.dbPath = dbPath;
    this.fs = fs;
    this.proc = proc;
    this.logger = logger;
    this.lockToken = lockToken;
  }

  /**
   * Open a sql.js database, loading WASM and reading existing file if present.
   *
   * @param dbPath - File path for persistence, or `:memory:` for in-memory only.
   */
  static async open(dbPath: string, options: SqlJsDriverOptions = {}): Promise<SqlJsDriver> {
    const initSqlJs = (await import("sql.js")).default;
    const SQL = await initSqlJs();

    const fs = options.fs ?? nodeFs;
    const proc = options.process ?? process;
    // eslint-disable-next-line no-console -- runtime convention: default logger is console.warn
    const logger = options.logger ?? ((m: string) => console.warn(m));

    if (dbPath === ":memory:") {
      return new SqlJsDriver(new SQL.Database(), null, fs, proc, logger, null);
    }

    const hostname = options.hostname ?? nodeOs.hostname();
    const token = acquireLock(fs, proc, hostname, dbPath);
    try {
      refuseNonEmptyWal(fs, dbPath);
      removeStaleTemps(fs, dbPath);

      let data: Uint8Array | undefined;
      try {
        data = new Uint8Array(fs.readFileSync(dbPath) as Buffer);
      } catch (err) {
        if (errCode(err) !== "ENOENT") {
          throw new Error(
            `sql.js: cannot read existing database at ${dbPath} (${errMessage(err)}); ` +
              `refusing to start empty over it. Fix the file's permissions or path, then retry.`,
            { cause: err },
          );
        }
        // ENOENT only — the database will be created on first flush.
      }

      const db = new SQL.Database(data);
      if (data !== undefined) {
        let verdict: unknown;
        try {
          verdict = db.exec("PRAGMA quick_check")[0]?.values[0]?.[0];
        } catch (err) {
          db.close();
          throw new Error(
            `sql.js: existing database at ${dbPath} is unreadable (${errMessage(err)}); ` +
              `refusing to open it. Restore it from a backup or move it aside.`,
            { cause: err },
          );
        }
        if (verdict !== "ok") {
          db.close();
          throw new Error(
            `sql.js: existing database at ${dbPath} fails integrity check (${String(verdict)}); ` +
              `refusing to open it. Restore it from a backup or move it aside.`,
          );
        }
      }

      const driver = new SqlJsDriver(db, dbPath, fs, proc, logger, token);
      registerShutdown(proc, driver);
      return driver;
    } catch (err) {
      releaseLock(fs, dbPath, token);
      throw err;
    }
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

  /**
   * Save the current snapshot now (atomically). Throws if the save fails;
   * the previous snapshot stays on disk and the driver stays dirty.
   */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.dirty) {
      this.flushToFile();
    }
  }

  close(): void {
    if (this.closed) return;
    // Flush immediately on close. A failed flush keeps the lock released
    // and the error surfaced — the previous snapshot is intact on disk.
    try {
      this.flush();
    } finally {
      this.closed = true;
      unregisterShutdown(this.proc, this);
      if (this.dbPath && this.lockToken) releaseLock(this.fs, this.dbPath, this.lockToken);
      this.lockToken = null;
      this.db.close();
    }
  }

  /**
   * Release without saving — for an open that failed part-way (e.g. a
   * migration threw). The on-disk snapshot is left exactly as it was.
   */
  abandon(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    unregisterShutdown(this.proc, this);
    if (this.dbPath && this.lockToken) releaseLock(this.fs, this.dbPath, this.lockToken);
    this.lockToken = null;
    this.db.close();
  }

  /** Exit/signal hook: best-effort final save, then drop the lock. Never throws. */
  shutdownForExit(release: boolean): void {
    if (this.closed) return;
    try {
      this.flush();
    } catch (err) {
      this.logger(
        `sql.js: final save of ${this.dbPath ?? ":memory:"} failed (${errMessage(err)}); ` +
          `the previous snapshot is intact, writes since it are lost`,
      );
    }
    if (release) {
      this.closed = true;
      if (this.dbPath && this.lockToken) releaseLock(this.fs, this.dbPath, this.lockToken);
      this.lockToken = null;
    }
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
      if (!this.dirty || this.closed) return;
      try {
        this.flushToFile();
      } catch (err) {
        // Stay dirty; the next mutation, close, or exit retries.
        this.logger(`sql.js: background save failed (${errMessage(err)}); will retry`);
      }
    }, FLUSH_DELAY_MS);
  }

  private flushToFile(): void {
    if (!this.dbPath) return;
    const dbPath = this.dbPath;
    const fs = this.fs;
    assertLockHeld(fs, dbPath, this.lockToken);

    const data = this.db.export();
    const dir = nodePath.dirname(dbPath);
    const tmp = nodePath.join(
      dir,
      `${nodePath.basename(dbPath)}.tmp-${this.proc.pid}-${randomBytes(6).toString("hex")}`,
    );
    let mode = 0o600;
    try {
      mode = fs.statSync(dbPath).mode & 0o777;
    } catch {
      // New database — private by default.
    }

    let fd: number | null = null;
    let renamed = false;
    try {
      fd = fs.openSync(tmp, "wx", mode);
      let offset = 0;
      while (offset < data.length) {
        const n = fs.writeSync(fd, data, offset, data.length - offset);
        if (n <= 0) throw new Error(`short write to ${tmp}`);
        offset += n;
      }
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tmp, dbPath);
      renamed = true;
      fsyncDir(fs, this.proc, dir);
    } catch (err) {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // already failing
        }
      }
      if (!renamed) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          // best-effort; removed on next open
        }
      }
      throw new Error(
        `sql.js: failed to save ${dbPath} (${errMessage(err)}); ` +
          (renamed
            ? "the new snapshot is in place but its directory entry is not yet durable"
            : "the previous snapshot is intact"),
        { cause: err },
      );
    }
    this.dirty = false;
  }
}

function fsyncDir(fs: SqlJsFs, proc: SqlJsProcess, dir: string): void {
  // Windows cannot open a directory for fsync; NTFS rename is journaled.
  if (proc.platform === "win32") return;
  const fd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function refuseNonEmptyWal(fs: SqlJsFs, dbPath: string): void {
  let size = 0;
  try {
    size = fs.statSync(`${dbPath}-wal`).size;
  } catch (err) {
    if (errCode(err) === "ENOENT") return;
    throw new Error(`sql.js: cannot inspect ${dbPath}-wal (${errMessage(err)}); refusing to open`, {
      cause: err,
    });
  }
  if (size > 0) {
    throw new Error(
      `sql.js: ${dbPath}-wal holds ${size} bytes of uncheckpointed native-SQLite writes that the ` +
        `sql.js fallback cannot read; opening would load a stale snapshot and its save would ` +
        `strand the WAL. Repair: open the database once with the native driver (rebuild ` +
        `better-sqlite3, e.g. \`pnpm rebuild better-sqlite3\`), or run ` +
        `\`sqlite3 ${dbPath} "PRAGMA wal_checkpoint(TRUNCATE)"\`, then retry.`,
    );
  }
}

function removeStaleTemps(fs: SqlJsFs, dbPath: string): void {
  // Leftovers of a save interrupted by a crash. Safe: we hold the lock, and
  // a temp is never the database until renamed over it.
  const dir = nodePath.dirname(dbPath);
  const prefix = `${nodePath.basename(dbPath)}.tmp-`;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    try {
      fs.unlinkSync(nodePath.join(dir, name));
    } catch {
      // best-effort
    }
  }
}

function readLock(fs: SqlJsFs, lockPath: string): string | null {
  try {
    return String(fs.readFileSync(lockPath, "utf-8"));
  } catch (err) {
    if (errCode(err) === "ENOENT") return null;
    throw err;
  }
}

function parseLock(raw: string): LockBody | null {
  try {
    const v = JSON.parse(raw) as Partial<LockBody>;
    if (typeof v.pid === "number" && typeof v.hostname === "string" && typeof v.token === "string")
      return v as LockBody;
  } catch {
    // fall through
  }
  return null;
}

function pidAlive(proc: SqlJsProcess, pid: number): boolean {
  try {
    proc.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: exists, owned by someone else. Only ESRCH proves it is gone.
    return errCode(err) !== "ESRCH";
  }
}

function acquireLock(fs: SqlJsFs, proc: SqlJsProcess, hostname: string, dbPath: string): string {
  const lockPath = sqlJsLockPath(dbPath);
  const token = randomBytes(16).toString("hex");
  const body = Buffer.from(
    JSON.stringify({ pid: proc.pid, hostname, token, acquired_at: Date.now() } satisfies LockBody),
  );
  // Two attempts: the second only after removing a lock proven stale.
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
    } catch (err) {
      if (errCode(err) !== "EEXIST") {
        throw new Error(`sql.js: cannot create lock ${lockPath} (${errMessage(err)})`, {
          cause: err,
        });
      }
      const raw = readLock(fs, lockPath);
      if (raw === null) continue; // released between our create and read
      const held = parseLock(raw);
      const stale =
        held !== null && held.hostname === hostname && !pidAlive(proc, held.pid) && attempt === 0;
      if (!stale) {
        const who = held ? `pid ${held.pid} on ${held.hostname}` : "an unknown holder";
        throw new Error(
          `sql.js: ${dbPath} is already open by ${who} (lock ${lockPath}). The sql.js fallback ` +
            `allows one writer; close the other motebit process and retry. If none is running, ` +
            `delete ${lockPath}.`,
        );
      }
      // Proven stale (same host, pid gone). Remove it only if it is still
      // byte-identical to what we judged, then race for it with O_EXCL.
      if (readLock(fs, lockPath) === raw) {
        try {
          fs.unlinkSync(lockPath);
        } catch (e) {
          if (errCode(e) !== "ENOENT") throw e;
        }
      }
      continue;
    }
    try {
      let off = 0;
      while (off < body.length) off += fs.writeSync(fd, body, off, body.length - off);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return token;
  }
  throw new Error(`sql.js: could not acquire lock ${lockPath}; retry`);
}

function assertLockHeld(fs: SqlJsFs, dbPath: string, token: string | null): void {
  const raw = token ? readLock(fs, sqlJsLockPath(dbPath)) : null;
  if (raw === null || parseLock(raw)?.token !== token) {
    throw new Error(
      `sql.js: lost the single-writer lock for ${dbPath}; refusing to overwrite a database ` +
        `another process may own`,
    );
  }
}

function releaseLock(fs: SqlJsFs, dbPath: string, token: string): void {
  const lockPath = sqlJsLockPath(dbPath);
  try {
    const raw = readLock(fs, lockPath);
    if (raw !== null && parseLock(raw)?.token === token) fs.unlinkSync(lockPath);
  } catch {
    // best-effort; a dead pid's lock is recovered on next open
  }
}

// ── Exit / signal flush ────────────────────────────────────────────────
//
// One set of listeners per process, shared by every open driver, so N open
// databases never mean N signal listeners (each would suppress the others'
// default-termination re-raise).

interface ShutdownRegistry {
  drivers: Set<SqlJsDriver>;
  onExit: () => void;
  onSignal: Map<string, () => void>;
}

const SIGNALS = ["SIGINT", "SIGTERM"] as const;
const registries = new WeakMap<SqlJsProcess, ShutdownRegistry>();

function registerShutdown(proc: SqlJsProcess, driver: SqlJsDriver): void {
  let reg = registries.get(proc);
  if (!reg) {
    const drivers = new Set<SqlJsDriver>();
    const onSignal = new Map<string, () => void>();
    const created: ShutdownRegistry = {
      drivers,
      onExit: () => {
        for (const d of [...drivers]) d.shutdownForExit(true);
      },
      onSignal,
    };
    for (const sig of SIGNALS) {
      const handler = (): void => {
        // If we are the only listener, Node's default (terminate) was
        // suppressed by our presence: save, release, detach, re-raise.
        const alone = proc.listenerCount(sig) <= 1;
        for (const d of [...drivers]) d.shutdownForExit(alone);
        if (alone) {
          detach(proc, created);
          proc.kill(proc.pid, sig);
        }
      };
      onSignal.set(sig, handler);
      proc.on(sig, handler);
    }
    proc.on("exit", created.onExit);
    registries.set(proc, created);
    reg = created;
  }
  reg.drivers.add(driver);
}

function detach(proc: SqlJsProcess, reg: ShutdownRegistry): void {
  proc.removeListener("exit", reg.onExit);
  for (const [sig, handler] of reg.onSignal) proc.removeListener(sig, handler);
  registries.delete(proc);
}

function unregisterShutdown(proc: SqlJsProcess, driver: SqlJsDriver): void {
  const reg = registries.get(proc);
  if (!reg) return;
  reg.drivers.delete(driver);
  if (reg.drivers.size === 0) detach(proc, reg);
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
