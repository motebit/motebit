/**
 * Fallback-driver safety. A fallback persistence driver never destroys the
 * last valid committed database snapshot, never initializes over an
 * existing database it could not read, and never claims stronger
 * durability than it provides.
 *
 * Faults are injected deterministically through the driver's `fs` and
 * `process` seams — never by racing a timer.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { SqlJsDriver, type SqlJsFs, type SqlJsProcess } from "../sqljs-driver.js";
import {
  openMotebitDatabase,
  isNativeModuleLoadFailure,
  sqlJsLockPath,
  type NativeDatabaseCtor,
} from "../index.js";
import type { SqlJsStatic } from "sql.js";

let SQL: SqlJsStatic;
let tmpDir: string;
let dbPath: string;
const open: SqlJsDriver[] = [];

beforeAll(async () => {
  SQL = await (await import("sql.js")).default();
});

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "motebit-sqljs-durability-"));
  dbPath = path.join(tmpDir, "motebit.db");
});

afterEach(() => {
  for (const d of open.splice(0)) {
    try {
      d.abandon();
    } catch {
      /* already closed */
    }
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function track(p: Promise<SqlJsDriver>): Promise<SqlJsDriver> {
  const d = await p;
  open.push(d);
  return d;
}

function codeError(code: string, message = code): NodeJS.ErrnoException {
  const e = new Error(message) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

/** Rows of `t` and the integrity verdict, read straight from disk bytes. */
function readDisk(p: string): { integrity: unknown; rows: number[] } {
  const db = new SQL.Database(new Uint8Array(fs.readFileSync(p)));
  try {
    const integrity = db.exec("PRAGMA integrity_check")[0]?.values[0]?.[0];
    const rows = (db.exec("SELECT x FROM t ORDER BY x")[0]?.values ?? []).map(
      (r) => r[0] as number,
    );
    return { integrity, rows };
  } finally {
    db.close();
  }
}

type Op = keyof SqlJsFs;

/** Real fs, with one armed fault. `fsyncNth` picks which fsync faults (1 = file, 2 = dir). */
class FaultFs implements SqlJsFs {
  armed: { op: Op; err: NodeJS.ErrnoException; partial?: boolean; nth?: number } | null = null;
  private seen = 0;
  failUnlink = false;
  readFails = new Map<string, NodeJS.ErrnoException>();

  arm(op: Op, err: NodeJS.ErrnoException, extra: { partial?: boolean; nth?: number } = {}): void {
    this.armed = { op, err, ...extra };
    this.seen = 0;
  }

  private hit(op: Op): NodeJS.ErrnoException | null {
    if (!this.armed || this.armed.op !== op) return null;
    this.seen++;
    if (this.seen !== (this.armed.nth ?? 1)) return null;
    const err = this.armed.err;
    this.armed = null;
    return err;
  }

  readFileSync(p: string, encoding?: "utf-8"): Buffer | string {
    const f = this.readFails.get(p);
    if (f) throw f;
    return encoding ? fs.readFileSync(p, encoding) : fs.readFileSync(p);
  }
  openSync(p: string, flags: string, mode?: number): number {
    const e = this.hit("openSync");
    if (e) throw e;
    return fs.openSync(p, flags, mode);
  }
  writeSync(fd: number, buf: Uint8Array, off: number, len: number): number {
    if (this.armed?.op === "writeSync" && this.armed.partial) {
      const err = this.armed.err;
      this.armed = null;
      fs.writeSync(fd, buf, off, Math.floor(len / 2));
      throw err;
    }
    const e = this.hit("writeSync");
    if (e) throw e;
    return fs.writeSync(fd, buf, off, len);
  }
  fsyncSync(fd: number): void {
    const e = this.hit("fsyncSync");
    if (e) throw e;
    fs.fsyncSync(fd);
  }
  closeSync(fd: number): void {
    const e = this.hit("closeSync");
    if (e) throw e;
    fs.closeSync(fd);
  }
  renameSync(a: string, b: string): void {
    const e = this.hit("renameSync");
    if (e) throw e;
    fs.renameSync(a, b);
  }
  unlinkSync(p: string): void {
    if (this.failUnlink && !p.endsWith(".sqljs-lock")) throw codeError("EIO");
    fs.unlinkSync(p);
  }
  statSync(p: string): { size: number; mode: number } {
    return fs.statSync(p);
  }
  readdirSync(p: string): string[] {
    return fs.readdirSync(p);
  }
}

/** Committed snapshot A = [1] on disk; [1, 2] pending in memory. */
async function snapshotThenPending(ffs: FaultFs): Promise<SqlJsDriver> {
  const d = await track(SqlJsDriver.open(dbPath, { fs: ffs }));
  d.exec("CREATE TABLE t (x INTEGER)");
  d.exec("INSERT INTO t VALUES (1)");
  d.flush();
  d.exec("INSERT INTO t VALUES (2)");
  return d;
}

function tempsIn(dir: string): string[] {
  return fs.readdirSync(dir).filter((n) => n.includes(".tmp-"));
}

// ── (a) atomic save ───────────────────────────────────────────────────

describe("(a) a fault during save never tears the database", () => {
  const preRename: Array<[string, (f: FaultFs) => void]> = [
    [
      "ENOSPC after a partial write",
      (f) => f.arm("writeSync", codeError("ENOSPC"), { partial: true }),
    ],
    ["EIO on the file fsync", (f) => f.arm("fsyncSync", codeError("EIO"), { nth: 1 })],
    ["EIO on close", (f) => f.arm("closeSync", codeError("EIO"))],
    ["EIO on rename", (f) => f.arm("renameSync", codeError("EIO"))],
    ["EACCES creating the temp file", (f) => f.arm("openSync", codeError("EACCES"))],
  ];

  for (const [name, inject] of preRename) {
    it(`${name}: disk keeps exactly the previous snapshot, temp removed, still dirty`, async () => {
      const ffs = new FaultFs();
      const d = await snapshotThenPending(ffs);
      inject(ffs);
      expect(() => d.flush()).toThrow(/failed to save .*previous snapshot is intact/);

      // Crash here: nothing after the fault runs.
      expect(readDisk(dbPath)).toEqual({ integrity: "ok", rows: [1] });
      expect(tempsIn(tmpDir)).toEqual([]);

      // Still dirty: the next save succeeds and carries the pending write.
      d.flush();
      expect(readDisk(dbPath)).toEqual({ integrity: "ok", rows: [1, 2] });
    });
  }

  it("fault after rename (directory fsync): disk holds the new snapshot, intact", async () => {
    const ffs = new FaultFs();
    const d = await snapshotThenPending(ffs);
    ffs.arm("fsyncSync", codeError("EIO"), { nth: 2 });
    expect(() => d.flush()).toThrow(/failed to save/);
    expect(readDisk(dbPath)).toEqual({ integrity: "ok", rows: [1, 2] });
  });

  it("a crash that leaves a temp behind: next open ignores and removes it", async () => {
    const ffs = new FaultFs();
    const d = await snapshotThenPending(ffs);
    ffs.failUnlink = true;
    ffs.arm("writeSync", codeError("ENOSPC"), { partial: true });
    expect(() => d.flush()).toThrow(/failed to save/);
    expect(tempsIn(tmpDir).length).toBe(1);
    d.abandon();

    const again = await track(SqlJsDriver.open(dbPath));
    expect(tempsIn(tmpDir)).toEqual([]);
    expect(again.prepare("SELECT x FROM t ORDER BY x").all()).toEqual([{ x: 1 }]);
  });

  it("never opens the database file itself for writing", async () => {
    const ffs = new FaultFs();
    const writes: string[] = [];
    const spy: SqlJsFs = Object.assign(Object.create(ffs) as FaultFs, {
      openSync: (p: string, flags: string, mode?: number) => {
        if (flags !== "r") writes.push(p);
        return ffs.openSync(p, flags, mode);
      },
    });
    const d = await track(SqlJsDriver.open(dbPath, { fs: spy }));
    d.exec("CREATE TABLE t (x INTEGER)");
    d.flush();
    expect(writes.length).toBeGreaterThan(0);
    expect(writes).not.toContain(dbPath);
  });
});

// ── (b) open refuses an existing database it could not read ───────────

describe("(b) open never starts empty over an unreadable database", () => {
  async function seed(): Promise<Buffer> {
    const d = await SqlJsDriver.open(dbPath);
    d.exec("CREATE TABLE t (x INTEGER)");
    d.exec("INSERT INTO t VALUES (7)");
    d.close();
    return fs.readFileSync(dbPath);
  }

  for (const code of ["EACCES", "EIO", "EPERM"]) {
    it(`${code} on read refuses, and the file is untouched`, async () => {
      const before = await seed();
      const ffs = new FaultFs();
      ffs.readFails.set(dbPath, codeError(code));
      await expect(SqlJsDriver.open(dbPath, { fs: ffs })).rejects.toThrow(
        /cannot read existing database/,
      );
      expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
      expect(fs.existsSync(sqlJsLockPath(dbPath))).toBe(false);
    });
  }

  it("a directory at the database path refuses", async () => {
    fs.mkdirSync(dbPath);
    await expect(SqlJsDriver.open(dbPath)).rejects.toThrow(/cannot read existing database/);
  });

  it("a truncated database refuses rather than loading a partial one", async () => {
    const full = await seed();
    // Large enough to need more than one page.
    const d = await SqlJsDriver.open(dbPath);
    d.exec(
      "INSERT INTO t SELECT value FROM (WITH RECURSIVE c(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM c WHERE value < 5000) SELECT value FROM c)",
    );
    d.close();
    const big = fs.readFileSync(dbPath);
    expect(big.length).toBeGreaterThan(full.length);
    fs.writeFileSync(dbPath, big.subarray(0, Math.floor(big.length / 2)));
    await expect(SqlJsDriver.open(dbPath)).rejects.toThrow(/integrity|unreadable/);
  });

  it("a non-database file refuses", async () => {
    fs.writeFileSync(dbPath, Buffer.from("not a database ".repeat(100)));
    await expect(SqlJsDriver.open(dbPath)).rejects.toThrow(/unreadable|integrity/);
  });

  it("ENOENT is the only 'absent': a fresh path opens empty", async () => {
    const d = await track(SqlJsDriver.open(dbPath));
    expect(d.prepare("SELECT count(*) AS n FROM sqlite_master").get()).toEqual({ n: 0 });
  });
});

// ── (c) openMotebitDatabase falls back only on a module-load failure ──

describe("(c) openMotebitDatabase never falls back on a database failure", () => {
  function nativeThatThrows(
    where: "construct" | "pragma" | "exec",
    err: Error,
  ): NativeDatabaseCtor {
    return class {
      constructor() {
        if (where === "construct") throw err;
      }
      pragma(): unknown {
        if (where === "pragma") throw err;
        return [];
      }
      exec(): void {
        if (where === "exec") throw err;
      }
      prepare(): unknown {
        if (where === "exec") throw err;
        return { run: () => ({ changes: 0 }), all: () => [], get: () => undefined };
      }
      close(): void {}
      transaction(fn: () => unknown) {
        return () => fn();
      }
    } as unknown as NativeDatabaseCtor;
  }

  const cases: Array<[string, NativeDatabaseCtor]> = [
    [
      "SQLITE_BUSY (locked)",
      nativeThatThrows("pragma", codeError("SQLITE_BUSY", "database is locked")),
    ],
    [
      "corrupt header",
      nativeThatThrows("pragma", codeError("SQLITE_NOTADB", "file is not a database")),
    ],
    ["migration throw", nativeThatThrows("exec", new Error("migration 42 failed"))],
    [
      "SQLITE_CANTOPEN",
      nativeThatThrows("construct", codeError("SQLITE_CANTOPEN", "unable to open database file")),
    ],
  ];

  for (const [name, Ctor] of cases) {
    it(`${name}: rethrows, never opens sql.js on the file`, async () => {
      fs.writeFileSync(dbPath, "");
      await expect(
        openMotebitDatabase(dbPath, { durability: "snapshot", loadNative: () => Ctor }),
      ).rejects.toThrow(/locked|not a database|migration 42|unable to open/);
      expect(fs.existsSync(sqlJsLockPath(dbPath))).toBe(false);
    });
  }

  it("real native driver on a corrupt file: rethrows the native error", async () => {
    fs.writeFileSync(dbPath, Buffer.from("garbage header ".repeat(200)));
    const before = fs.readFileSync(dbPath);
    await expect(openMotebitDatabase(dbPath, { durability: "snapshot" })).rejects.toThrow(
      /not a database/,
    );
    expect(fs.existsSync(sqlJsLockPath(dbPath))).toBe(false);
    expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
  });

  it("a non-load error from require is rethrown with cause", async () => {
    const boom = new Error("unexpected");
    await expect(
      openMotebitDatabase(dbPath, {
        durability: "snapshot",
        loadNative: () => {
          throw boom;
        },
      }),
    ).rejects.toMatchObject({ cause: boom });
  });

  it("module-load failure + snapshot accepted: falls back to sql.js, which says so", async () => {
    const mdb = await openMotebitDatabase(dbPath, {
      durability: "snapshot",
      loadNative: () => {
        throw codeError("MODULE_NOT_FOUND", "Cannot find module 'better-sqlite3'");
      },
    });
    try {
      expect(mdb.db.driverName).toBe("sql.js");
      expect(mdb.db.durability).toBe("snapshot");
    } finally {
      mdb.close();
    }
  });

  it("module-load failure + commit required (the default): refuses the fallback", async () => {
    await expect(
      openMotebitDatabase(dbPath, {
        loadNative: () => {
          throw new Error("Could not locate the bindings file. Tried: ...");
        },
      }),
    ).rejects.toThrow(/commit-durable/);
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it("native driver declares commit durability", async () => {
    const mdb = await openMotebitDatabase(dbPath);
    try {
      expect(mdb.db.driverName).toBe("better-sqlite3");
      expect(mdb.db.durability).toBe("commit");
    } finally {
      mdb.close();
    }
  });

  it("classifies module-load failures narrowly", () => {
    expect(isNativeModuleLoadFailure(codeError("MODULE_NOT_FOUND"))).toBe(true);
    expect(isNativeModuleLoadFailure(codeError("ERR_DLOPEN_FAILED"))).toBe(true);
    expect(isNativeModuleLoadFailure(new Error("invalid ELF header"))).toBe(true);
    expect(
      isNativeModuleLoadFailure(
        new Error("was compiled against a different Node.js version using NODE_MODULE_VERSION 127"),
      ),
    ).toBe(true);
    expect(isNativeModuleLoadFailure(codeError("SQLITE_BUSY", "database is locked"))).toBe(false);
    expect(isNativeModuleLoadFailure(codeError("SQLITE_CORRUPT", "malformed"))).toBe(false);
    expect(isNativeModuleLoadFailure(new Error("migration failed"))).toBe(false);
  });
});

// ── (d) never opens a native WAL with uncheckpointed frames ───────────

describe("(d) the fallback never reads around a native -wal", () => {
  it("refuses while the -wal holds frames, and leaves both files untouched", async () => {
    const require = createRequire(import.meta.url);
    const Native = require("better-sqlite3") as new (p: string) => {
      pragma(s: string): unknown;
      exec(s: string): void;
      close(): void;
    };
    const native = new Native(dbPath);
    try {
      native.pragma("journal_mode = WAL");
      native.pragma("wal_autocheckpoint = 0");
      native.exec("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);");
      expect(fs.statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);
      const main = fs.readFileSync(dbPath);
      const wal = fs.readFileSync(`${dbPath}-wal`);

      await expect(SqlJsDriver.open(dbPath)).rejects.toThrow(/uncheckpointed/);
      await expect(
        openMotebitDatabase(dbPath, {
          durability: "snapshot",
          loadNative: () => {
            throw codeError("MODULE_NOT_FOUND", "Cannot find module 'better-sqlite3'");
          },
        }),
      ).rejects.toThrow(/uncheckpointed/);

      expect(fs.readFileSync(dbPath).equals(main)).toBe(true);
      expect(fs.readFileSync(`${dbPath}-wal`).equals(wal)).toBe(true);
      expect(fs.existsSync(sqlJsLockPath(dbPath))).toBe(false);
    } finally {
      native.close();
    }
    // After the native driver checkpoints on close, the fallback may open it.
    const d = await track(SqlJsDriver.open(dbPath));
    expect(d.prepare("SELECT x FROM t").all()).toEqual([{ x: 1 }]);
  });
});

// ── (e) single writer ─────────────────────────────────────────────────

describe("(e) one writer per database on the fallback path", () => {
  it("a second open of the same file is refused until the first closes", async () => {
    const a = await track(SqlJsDriver.open(dbPath));
    await expect(SqlJsDriver.open(dbPath)).rejects.toThrow(/already open by pid/);
    a.close();
    const b = await track(SqlJsDriver.open(dbPath));
    expect(b.durability).toBe("snapshot");
  });

  function fakeProc(pid: number, dead: Set<number>): SqlJsProcess {
    const ee = new EventEmitter();
    return Object.assign(ee, {
      pid,
      platform: process.platform,
      kill: (p: number) => {
        if (dead.has(p)) throw codeError("ESRCH");
        return true;
      },
    }) as unknown as SqlJsProcess;
  }

  const stale = (pid: number, hostname: string) =>
    JSON.stringify({ pid, hostname, token: "old", acquired_at: 0 });

  it("recovers a lock whose pid is dead on this host", async () => {
    fs.writeFileSync(sqlJsLockPath(dbPath), stale(999_001, "h1"));
    const d = await track(
      SqlJsDriver.open(dbPath, { process: fakeProc(5, new Set([999_001])), hostname: "h1" }),
    );
    expect(JSON.parse(fs.readFileSync(sqlJsLockPath(dbPath), "utf-8")).pid).toBe(5);
    d.close();
    expect(fs.existsSync(sqlJsLockPath(dbPath))).toBe(false);
  });

  it("refuses a lock whose pid is alive, held on another host, or unreadable", async () => {
    fs.writeFileSync(sqlJsLockPath(dbPath), stale(999_002, "h1"));
    await expect(
      SqlJsDriver.open(dbPath, { process: fakeProc(5, new Set()), hostname: "h1" }),
    ).rejects.toThrow(/already open by pid 999002/);

    fs.writeFileSync(sqlJsLockPath(dbPath), stale(999_002, "other-host"));
    await expect(
      SqlJsDriver.open(dbPath, { process: fakeProc(5, new Set([999_002])), hostname: "h1" }),
    ).rejects.toThrow(/already open/);

    fs.writeFileSync(sqlJsLockPath(dbPath), "");
    await expect(
      SqlJsDriver.open(dbPath, { process: fakeProc(5, new Set()), hostname: "h1" }),
    ).rejects.toThrow(/unknown holder/);
  });

  it("a writer that lost its lock refuses to save", async () => {
    const d = await track(SqlJsDriver.open(dbPath));
    d.exec("CREATE TABLE t (x INTEGER)");
    d.flush();
    const before = fs.readFileSync(dbPath);
    fs.writeFileSync(sqlJsLockPath(dbPath), stale(process.pid, os.hostname()));
    d.exec("INSERT INTO t VALUES (1)");
    expect(() => d.flush()).toThrow(/lost the single-writer lock/);
    expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
  });

  it("another OS process is refused while one holds the database", async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
    const tsx = path.join(root, "node_modules/.bin/tsx");
    const script = path.join(tmpDir, "holder.mts");
    const driverUrl = new URL("../sqljs-driver.ts", import.meta.url).href;
    fs.writeFileSync(
      script,
      `const { SqlJsDriver } = await import(${JSON.stringify(driverUrl)});\n` +
        `const d = await SqlJsDriver.open(${JSON.stringify(dbPath)});\n` +
        `d.exec("CREATE TABLE t (x INTEGER)"); d.exec("INSERT INTO t VALUES (9)");\n` +
        `process.stdout.write("OPEN " + process.pid + "\\n");\n` +
        `setInterval(() => {}, 1 << 30);\n`,
    );
    const child = spawn(tsx, [script], { stdio: ["ignore", "pipe", "inherit"] });
    try {
      // tsx runs the script in its own child; the holder reports its pid.
      const holderPid = await new Promise<string>((resolve, reject) => {
        child.stdout.on("data", (b: Buffer) => {
          const m = /OPEN (\d+)/.exec(b.toString());
          if (m) resolve(m[1]!);
        });
        child.on("exit", (c) => reject(new Error(`holder exited early (${String(c)})`)));
      });
      await expect(SqlJsDriver.open(dbPath)).rejects.toThrow(
        new RegExp(`already open by pid ${holderPid}`),
      );
    } finally {
      const exited = new Promise((r) => child.once("exit", r));
      child.kill("SIGTERM");
      await exited;
    }
    // SIGTERM flushed and released: the row is on disk and the lock is free.
    const d = await track(SqlJsDriver.open(dbPath));
    expect(d.prepare("SELECT x FROM t").all()).toEqual([{ x: 9 }]);
  }, 30_000);
});

// ── (f) flush on exit and signals ─────────────────────────────────────

describe("(f) exit and SIGINT/SIGTERM save the pending snapshot", () => {
  function fakeProc(): SqlJsProcess & EventEmitter & { kills: Array<[number, unknown]> } {
    const ee = new EventEmitter();
    const kills: Array<[number, unknown]> = [];
    return Object.assign(ee, {
      pid: 4242,
      platform: process.platform,
      kills,
      kill: (pid: number, sig?: unknown) => {
        if (sig !== 0) kills.push([pid, sig]);
        return true;
      },
    }) as unknown as SqlJsProcess & EventEmitter & { kills: Array<[number, unknown]> };
  }

  async function pending(proc: SqlJsProcess): Promise<SqlJsDriver> {
    const d = await track(SqlJsDriver.open(dbPath, { process: proc }));
    d.exec("CREATE TABLE t (x INTEGER)");
    d.exec("INSERT INTO t VALUES (1)");
    d.flush();
    d.exec("INSERT INTO t VALUES (2)");
    return d;
  }

  it("exit saves and releases the lock (synchronously, before any timer)", async () => {
    const proc = fakeProc();
    await pending(proc);
    proc.emit("exit", 0);
    expect(readDisk(dbPath).rows).toEqual([1, 2]);
    expect(fs.existsSync(sqlJsLockPath(dbPath))).toBe(false);
  });

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    it(`${sig} as the only listener: saves, releases, re-raises the default`, async () => {
      const proc = fakeProc();
      await pending(proc);
      proc.emit(sig);
      expect(readDisk(dbPath).rows).toEqual([1, 2]);
      expect(fs.existsSync(sqlJsLockPath(dbPath))).toBe(false);
      expect(proc.kills).toEqual([[4242, sig]]);
      expect(proc.listenerCount(sig)).toBe(0);
    });

    it(`${sig} with the app's own handler: saves, keeps running, re-raises nothing`, async () => {
      const proc = fakeProc();
      proc.on(sig, () => {});
      const d = await pending(proc);
      proc.emit(sig);
      expect(readDisk(dbPath).rows).toEqual([1, 2]);
      expect(proc.kills).toEqual([]);
      d.exec("INSERT INTO t VALUES (3)");
      d.close();
      expect(readDisk(dbPath).rows).toEqual([1, 2, 3]);
      expect(proc.listenerCount(sig)).toBe(1);
      expect(proc.listenerCount("exit")).toBe(0);
    });
  }

  it("N open databases share one listener per signal", async () => {
    const proc = fakeProc();
    await track(SqlJsDriver.open(dbPath, { process: proc }));
    await track(SqlJsDriver.open(path.join(tmpDir, "second.db"), { process: proc }));
    expect(proc.listenerCount("SIGINT")).toBe(1);
    expect(proc.listenerCount("exit")).toBe(1);
  });
});
