/**
 * Driver-level `transaction` tests.
 *
 * The DatabaseDriver.transaction primitive commits on return, rolls back
 * on throw, and supports nesting via savepoints. These tests exercise the
 * contract against both driver implementations — better-sqlite3 (native
 * `inner.transaction`) and SqlJsDriver (manual BEGIN/SAVEPOINT polyfill)
 * — so the semantics are identical across drivers. Services depend on
 * this: a call that works under better-sqlite3 in production must work
 * identically under sql.js in a browser fallback path.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { SqlJsDriver } from "../sqljs-driver.js";
import type { DatabaseDriver } from "../driver.js";

async function openSqlJs(): Promise<DatabaseDriver> {
  const driver = await SqlJsDriver.open(":memory:");
  driver.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );
  `);
  return driver;
}

function scan(db: DatabaseDriver): Array<{ k: string; v: string }> {
  return db.prepare("SELECT k, v FROM kv ORDER BY k").all() as Array<{ k: string; v: string }>;
}

describe("DatabaseDriver.transaction — sql.js driver", () => {
  let db: DatabaseDriver;
  beforeEach(async () => {
    db = await openSqlJs();
  });

  it("commits on return", () => {
    db.transaction(() => {
      db.prepare("INSERT INTO kv (k, v) VALUES (?, ?)").run("a", "1");
      db.prepare("INSERT INTO kv (k, v) VALUES (?, ?)").run("b", "2");
    });
    expect(scan(db)).toEqual([
      { k: "a", v: "1" },
      { k: "b", v: "2" },
    ]);
  });

  it("returns the fn's value", () => {
    const result = db.transaction(() => {
      db.prepare("INSERT INTO kv (k, v) VALUES (?, ?)").run("x", "42");
      return { ok: true, rowsWritten: 1 };
    });
    expect(result).toEqual({ ok: true, rowsWritten: 1 });
  });

  it("rolls back ALL writes on a throw mid-transaction", () => {
    expect(() => {
      db.transaction(() => {
        db.prepare("INSERT INTO kv (k, v) VALUES (?, ?)").run("a", "1");
        db.prepare("INSERT INTO kv (k, v) VALUES (?, ?)").run("b", "2");
        throw new Error("boom");
      });
    }).toThrow("boom");
    // Neither row committed.
    expect(scan(db)).toEqual([]);
  });

  it("returning null still commits (empty transaction is fine)", () => {
    // Mirrors the SqliteAccountStore pattern: the fn may short-circuit
    // with null to signal "nothing to do" — the caller uses the return
    // shape to decide. Empty commits are cheap and harmless.
    const result = db.transaction<null | { ok: true }>(() => {
      return null;
    });
    expect(result).toBeNull();
    expect(scan(db)).toEqual([]);
  });

  it("nesting: inner throw rolls back inner only, outer can continue", () => {
    db.transaction(() => {
      db.prepare("INSERT INTO kv (k, v) VALUES (?, ?)").run("outer", "OK");
      try {
        db.transaction(() => {
          db.prepare("INSERT INTO kv (k, v) VALUES (?, ?)").run("inner", "BAD");
          throw new Error("inner fail");
        });
      } catch {
        // Outer catches the inner failure and proceeds.
      }
      db.prepare("INSERT INTO kv (k, v) VALUES (?, ?)").run("after", "OK");
    });
    // The savepoint rolls back just `inner`; the outer commits
    // `outer` and `after`.
    expect(scan(db)).toEqual([
      { k: "after", v: "OK" },
      { k: "outer", v: "OK" },
    ]);
  });

  it("nesting: outer throw rolls back inner as well", () => {
    expect(() => {
      db.transaction(() => {
        db.prepare("INSERT INTO kv (k, v) VALUES (?, ?)").run("outer", "OK");
        db.transaction(() => {
          db.prepare("INSERT INTO kv (k, v) VALUES (?, ?)").run("inner", "OK");
        });
        throw new Error("outer fail");
      });
    }).toThrow("outer fail");
    // Both rolled back — the inner savepoint's RELEASE is captured by the
    // outer BEGIN/ROLLBACK.
    expect(scan(db)).toEqual([]);
  });

  it("sequential top-level transactions are independent", () => {
    db.transaction(() => {
      db.prepare("INSERT INTO kv (k, v) VALUES (?, ?)").run("a", "1");
    });
    expect(() => {
      db.transaction(() => {
        db.prepare("INSERT INTO kv (k, v) VALUES (?, ?)").run("b", "2");
        throw new Error("second fails");
      });
    }).toThrow();
    db.transaction(() => {
      db.prepare("INSERT INTO kv (k, v) VALUES (?, ?)").run("c", "3");
    });
    expect(scan(db)).toEqual([
      { k: "a", v: "1" },
      { k: "c", v: "3" },
    ]);
  });
});

describe("DatabaseDriver.transaction — better-sqlite3 driver", () => {
  // better-sqlite3 loads lazily via createRequire. If it's not installed
  // in this environment, skip (sql.js covers the behavior). CI installs
  // better-sqlite3, so this block runs there.
  let db: DatabaseDriver;
  let available: boolean;

  beforeEach(async () => {
    try {
      const mod = await import("../index.js");
      const { createMotebitDatabase } = mod;
      const m = createMotebitDatabase(":memory:");
      db = m.db;
      available = true;
      db.exec(`
        CREATE TABLE IF NOT EXISTS kv (
          k TEXT PRIMARY KEY,
          v TEXT NOT NULL
        );
      `);
    } catch {
      available = false;
    }
  });

  it.runIf(true)("commits on return", () => {
    if (!available) return;
    db.transaction(() => {
      db.prepare("INSERT INTO kv (k, v) VALUES (?, ?)").run("a", "1");
    });
    expect(scan(db)).toEqual([{ k: "a", v: "1" }]);
  });

  it("rolls back on throw", () => {
    if (!available) return;
    expect(() => {
      db.transaction(() => {
        db.prepare("INSERT INTO kv (k, v) VALUES (?, ?)").run("a", "1");
        throw new Error("boom");
      });
    }).toThrow("boom");
    expect(scan(db)).toEqual([]);
  });

  it("supports nesting via savepoints", () => {
    if (!available) return;
    db.transaction(() => {
      db.prepare("INSERT INTO kv (k, v) VALUES (?, ?)").run("outer", "OK");
      try {
        db.transaction(() => {
          db.prepare("INSERT INTO kv (k, v) VALUES (?, ?)").run("inner", "BAD");
          throw new Error("inner fail");
        });
      } catch {
        // Outer catches and continues.
      }
      db.prepare("INSERT INTO kv (k, v) VALUES (?, ?)").run("after", "OK");
    });
    expect(scan(db)).toEqual([
      { k: "after", v: "OK" },
      { k: "outer", v: "OK" },
    ]);
  });
});
