/**
 * Migration framework tests.
 *
 * Verifies: empty DB setup, idempotent re-runs, version tracking,
 * partial failure rollback, duplicate version detection.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqlJsDriver, type DatabaseDriver } from "@motebit/persistence";
import { runMigrations, getSchemaVersion, type Migration } from "../migrations.js";

let db: DatabaseDriver;

beforeEach(async () => {
  db = await SqlJsDriver.open(":memory:");
  db.pragma("journal_mode = WAL");
});

afterEach(() => {
  db.close();
});

// Simple test migrations (not the real relay ones — isolated behavior tests)
const testMigrations: Migration[] = [
  {
    version: 1,
    name: "create_users",
    up: (d) => {
      d.exec("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
    },
  },
  {
    version: 2,
    name: "add_email",
    up: (d) => {
      d.exec("ALTER TABLE users ADD COLUMN email TEXT");
    },
  },
  {
    version: 3,
    name: "create_posts",
    up: (d) => {
      d.exec(
        "CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, body TEXT)",
      );
      d.exec("CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id)");
    },
  },
];

describe("migration framework", () => {
  it("starts at version 0 on empty database", () => {
    expect(getSchemaVersion(db)).toBe(0);
  });

  it("runs all migrations on empty database", () => {
    runMigrations(db, testMigrations);

    expect(getSchemaVersion(db)).toBe(3);

    // Tables should exist
    db.prepare("INSERT INTO users (name, email) VALUES (?, ?)").run("Alice", "alice@test.com");
    db.prepare("INSERT INTO posts (user_id, body) VALUES (?, ?)").run(1, "Hello");

    const user = db.prepare("SELECT * FROM users WHERE id = 1").get() as {
      name: string;
      email: string;
    };
    expect(user.name).toBe("Alice");
    expect(user.email).toBe("alice@test.com");
  });

  it("re-running migrations is idempotent", () => {
    runMigrations(db, testMigrations);
    expect(getSchemaVersion(db)).toBe(3);

    // Run again — should be a no-op
    runMigrations(db, testMigrations);
    expect(getSchemaVersion(db)).toBe(3);

    // Verify tracking table has exactly 3 entries
    const rows = db
      .prepare("SELECT * FROM relay_schema_migrations ORDER BY version")
      .all() as Array<{
      version: number;
      name: string;
      applied_at: number;
    }>;
    expect(rows).toHaveLength(3);
    expect(rows[0]!.version).toBe(1);
    expect(rows[0]!.name).toBe("create_users");
    expect(rows[1]!.version).toBe(2);
    expect(rows[2]!.version).toBe(3);
  });

  it("tracks applied_at timestamp", () => {
    const before = Date.now();
    runMigrations(db, testMigrations);
    const after = Date.now();

    const rows = db.prepare("SELECT applied_at FROM relay_schema_migrations").all() as Array<{
      applied_at: number;
    }>;
    for (const row of rows) {
      expect(row.applied_at).toBeGreaterThanOrEqual(before);
      expect(row.applied_at).toBeLessThanOrEqual(after);
    }
  });

  it("runs only pending migrations when some are already applied", () => {
    // Run first two
    runMigrations(db, testMigrations.slice(0, 2));
    expect(getSchemaVersion(db)).toBe(2);

    // Run all — should only apply migration 3
    runMigrations(db, testMigrations);
    expect(getSchemaVersion(db)).toBe(3);

    // posts table should exist
    const info = db.prepare("PRAGMA table_info(posts)").all() as Array<{ name: string }>;
    expect(info.map((c) => c.name)).toContain("user_id");
  });

  it("rolls back on failure and preserves previous state", () => {
    const failingMigrations: Migration[] = [
      testMigrations[0]!, // version 1: succeeds
      {
        version: 2,
        name: "will_fail",
        up: (d) => {
          d.exec("CREATE TABLE IF NOT EXISTS temp_ok (id INTEGER PRIMARY KEY)");
          // This will fail — referencing a nonexistent table for INSERT
          d.exec("INSERT INTO nonexistent_table VALUES (1)");
        },
      },
    ];

    expect(() => runMigrations(db, failingMigrations)).toThrow(/Migration 2 \(will_fail\) failed/);

    // Version should be 1 (only the first migration committed)
    expect(getSchemaVersion(db)).toBe(1);

    // users table exists (migration 1 committed)
    const usersInfo = db.prepare("PRAGMA table_info(users)").all();
    expect(usersInfo.length).toBeGreaterThan(0);

    // temp_ok table should NOT exist (migration 2 rolled back)
    const tempInfo = db.prepare("PRAGMA table_info(temp_ok)").all();
    expect(tempInfo).toHaveLength(0);
  });

  it("rejects duplicate migration versions", () => {
    const dupes: Migration[] = [
      { version: 1, name: "first", up: () => {} },
      { version: 1, name: "duplicate", up: () => {} },
    ];

    expect(() => runMigrations(db, dupes)).toThrow(/Duplicate migration version: 1/);
  });

  it("handles out-of-order migration array (sorts by version)", () => {
    const reversed = [...testMigrations].reverse();
    runMigrations(db, reversed);

    expect(getSchemaVersion(db)).toBe(3);

    // All tables should exist in correct order
    const usersInfo = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
    expect(usersInfo.map((c) => c.name)).toContain("email"); // email added by migration 2
  });
});
