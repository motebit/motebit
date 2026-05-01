import { describe, it, expect } from "vitest";
import {
  runMigrations,
  runMigrationsAsync,
  type Migration,
  type SyncSqliteDriver,
  type AsyncSqliteDriver,
} from "../index.js";

/**
 * Minimal in-memory fake. Records every exec call; tracks user_version;
 * supports fault injection by throwing from a configurable hook.
 */
function makeFakeSyncDriver(
  opts: {
    failOn?: (sql: string) => Error | undefined;
    initialVersion?: number;
  } = {},
): SyncSqliteDriver & { calls: string[]; getVersion(): number } {
  const calls: string[] = [];
  let userVersion = opts.initialVersion ?? 0;

  const exec = (sql: string): void => {
    calls.push(sql);
    const fault = opts.failOn?.(sql);
    if (fault) throw fault;
    const m = sql.match(/^PRAGMA user_version\s*=\s*(\d+)/i);
    if (m) userVersion = parseInt(m[1]!, 10);
  };

  return {
    exec,
    pragma(sql: string) {
      if (/^user_version$/i.test(sql.trim())) {
        return [{ user_version: userVersion }];
      }
      return [];
    },
    transaction<T>(fn: () => T): T {
      const saved = userVersion;
      const savedCallCount = calls.length;
      try {
        return fn();
      } catch (err) {
        userVersion = saved;
        // Mark rollback in the call log so tests can assert it.
        calls.push(`__ROLLBACK__:${savedCallCount}`);
        throw err;
      }
    },
    calls,
    getVersion: () => userVersion,
  };
}

function makeFakeAsyncDriver(
  opts: {
    failOn?: (sql: string) => Error | undefined;
    initialVersion?: number;
  } = {},
): AsyncSqliteDriver & { calls: string[]; getVersion(): number } {
  const calls: string[] = [];
  let userVersion = opts.initialVersion ?? 0;

  return {
    async exec(sql: string): Promise<void> {
      calls.push(sql);
      const fault = opts.failOn?.(sql);
      if (fault) throw fault;
    },
    async getUserVersion(): Promise<number> {
      return userVersion;
    },
    async setUserVersion(version: number): Promise<void> {
      calls.push(`SET user_version = ${version}`);
      userVersion = version;
    },
    calls,
    getVersion: () => userVersion,
  };
}

const SAMPLE_MIGRATIONS: Migration[] = [
  { version: 1, description: "add foo column", statements: ["ALTER TABLE t ADD COLUMN foo TEXT"] },
  { version: 2, description: "no-op slot", statements: [] },
  {
    version: 3,
    description: "create index",
    statements: ["CREATE INDEX IF NOT EXISTS idx_t_foo ON t(foo)"],
  },
];

describe("runMigrations (sync)", () => {
  it("on a fresh DB, applies every migration and lands at the latest version", () => {
    const driver = makeFakeSyncDriver();
    const result = runMigrations(driver, SAMPLE_MIGRATIONS);

    expect(result).toEqual({ from: 0, to: 3, applied: [1, 2, 3] });
    expect(driver.getVersion()).toBe(3);
    expect(driver.calls).toEqual([
      "ALTER TABLE t ADD COLUMN foo TEXT",
      "PRAGMA user_version = 1",
      "PRAGMA user_version = 2",
      "CREATE INDEX IF NOT EXISTS idx_t_foo ON t(foo)",
      "PRAGMA user_version = 3",
    ]);
  });

  it("on a partially-migrated DB, applies only pending migrations", () => {
    const driver = makeFakeSyncDriver({ initialVersion: 1 });
    const result = runMigrations(driver, SAMPLE_MIGRATIONS);

    expect(result).toEqual({ from: 1, to: 3, applied: [2, 3] });
    expect(driver.calls).toEqual([
      "PRAGMA user_version = 2",
      "CREATE INDEX IF NOT EXISTS idx_t_foo ON t(foo)",
      "PRAGMA user_version = 3",
    ]);
  });

  it("on a fully-migrated DB, is a no-op", () => {
    const driver = makeFakeSyncDriver({ initialVersion: 3 });
    const result = runMigrations(driver, SAMPLE_MIGRATIONS);

    expect(result).toEqual({ from: 3, to: 3, applied: [] });
    expect(driver.calls).toEqual([]);
  });

  it("running twice is idempotent", () => {
    const driver = makeFakeSyncDriver();
    runMigrations(driver, SAMPLE_MIGRATIONS);
    const callsAfterFirst = driver.calls.length;
    const result = runMigrations(driver, SAMPLE_MIGRATIONS);

    expect(result.applied).toEqual([]);
    expect(driver.calls.length).toBe(callsAfterFirst);
  });

  it("swallows duplicate-column errors (ALTER TABLE racing fresh-DB CREATE TABLE)", () => {
    const driver = makeFakeSyncDriver({
      failOn: (sql) =>
        sql.startsWith("ALTER TABLE")
          ? new Error("SQLITE_ERROR: duplicate column name: foo")
          : undefined,
    });
    const result = runMigrations(driver, SAMPLE_MIGRATIONS);

    expect(result.applied).toEqual([1, 2, 3]);
    expect(driver.getVersion()).toBe(3);
  });

  it("swallows already-exists errors (CREATE INDEX / CREATE TABLE racing at-rest schema)", () => {
    const driver = makeFakeSyncDriver({
      failOn: (sql) =>
        sql.startsWith("CREATE INDEX")
          ? new Error("SQLITE_ERROR: index idx_t_foo already exists")
          : undefined,
    });
    const result = runMigrations(driver, SAMPLE_MIGRATIONS);

    expect(result.applied).toEqual([1, 2, 3]);
  });

  it("rethrows non-duplicate errors and rolls back the migration", () => {
    const driver = makeFakeSyncDriver({
      failOn: (sql) =>
        sql.startsWith("CREATE INDEX") ? new Error("SQLITE_ERROR: disk I/O error") : undefined,
    });

    expect(() => runMigrations(driver, SAMPLE_MIGRATIONS)).toThrow(/disk I\/O error/);
    // Version should reflect the last successful migration only.
    expect(driver.getVersion()).toBe(2);
    // Rollback marker must be present from the failed migration's transaction.
    expect(driver.calls.some((c) => c.startsWith("__ROLLBACK__"))).toBe(true);
  });

  it("rethrows non-Error throws (string) and rolls back", () => {
    const driver = makeFakeSyncDriver({
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      failOn: (sql) =>
        sql.startsWith("ALTER TABLE") ? ("string-fault" as unknown as Error) : undefined,
    });

    expect(() => runMigrations(driver, SAMPLE_MIGRATIONS)).toThrow();
    expect(driver.getVersion()).toBe(0);
  });

  it("rejects a registry with non-monotonic versions", () => {
    const bad: Migration[] = [
      { version: 1, description: "a", statements: [] },
      { version: 3, description: "skip 2", statements: [] },
    ];
    expect(() => runMigrations(makeFakeSyncDriver(), bad)).toThrow(
      /strict-monotonic starting at 1.*expected 2/,
    );
  });

  it("rejects a registry that does not start at 1", () => {
    const bad: Migration[] = [{ version: 0, description: "zero", statements: [] }];
    expect(() => runMigrations(makeFakeSyncDriver(), bad)).toThrow(/expected 1/);
  });

  it("treats an empty registry as a no-op", () => {
    const driver = makeFakeSyncDriver();
    const result = runMigrations(driver, []);
    expect(result).toEqual({ from: 0, to: 0, applied: [] });
    expect(driver.calls).toEqual([]);
  });

  it("treats a missing user_version pragma row as version 0", () => {
    const driver: SyncSqliteDriver = {
      exec: () => {},
      pragma: () => [],
      transaction: <T>(fn: () => T) => fn(),
    };
    const result = runMigrations(driver, []);
    expect(result.from).toBe(0);
  });
});

describe("runMigrationsAsync", () => {
  it("on a fresh DB, applies every migration with explicit BEGIN/COMMIT", async () => {
    const driver = makeFakeAsyncDriver();
    const result = await runMigrationsAsync(driver, SAMPLE_MIGRATIONS);

    expect(result).toEqual({ from: 0, to: 3, applied: [1, 2, 3] });
    expect(driver.calls).toEqual([
      "BEGIN",
      "ALTER TABLE t ADD COLUMN foo TEXT",
      "SET user_version = 1",
      "COMMIT",
      "BEGIN",
      "SET user_version = 2",
      "COMMIT",
      "BEGIN",
      "CREATE INDEX IF NOT EXISTS idx_t_foo ON t(foo)",
      "SET user_version = 3",
      "COMMIT",
    ]);
  });

  it("on a fully-migrated DB, is a no-op", async () => {
    const driver = makeFakeAsyncDriver({ initialVersion: 3 });
    const result = await runMigrationsAsync(driver, SAMPLE_MIGRATIONS);
    expect(result.applied).toEqual([]);
    expect(driver.calls).toEqual([]);
  });

  it("swallows duplicate-column errors", async () => {
    const driver = makeFakeAsyncDriver({
      failOn: (sql) =>
        sql.startsWith("ALTER TABLE") ? new Error("duplicate column name: foo") : undefined,
    });
    const result = await runMigrationsAsync(driver, SAMPLE_MIGRATIONS);
    expect(result.applied).toEqual([1, 2, 3]);
    expect(driver.getVersion()).toBe(3);
  });

  it("on non-duplicate error, issues ROLLBACK and stops at last successful version", async () => {
    const driver = makeFakeAsyncDriver({
      failOn: (sql) => (sql.startsWith("CREATE INDEX") ? new Error("disk I/O error") : undefined),
    });

    await expect(runMigrationsAsync(driver, SAMPLE_MIGRATIONS)).rejects.toThrow(/disk I\/O error/);
    expect(driver.getVersion()).toBe(2);
    expect(driver.calls.filter((c) => c === "ROLLBACK")).toHaveLength(1);
  });

  it("rethrows non-Error throws (string) and rolls back", async () => {
    const driver = makeFakeAsyncDriver({
      failOn: (sql) =>
        sql.startsWith("ALTER TABLE") ? ("string-fault" as unknown as Error) : undefined,
    });
    await expect(runMigrationsAsync(driver, SAMPLE_MIGRATIONS)).rejects.toBeDefined();
    expect(driver.getVersion()).toBe(0);
    expect(driver.calls).toContain("ROLLBACK");
  });

  it("rejects a registry with version gaps", async () => {
    const bad: Migration[] = [
      { version: 1, description: "a", statements: [] },
      { version: 3, description: "skip 2", statements: [] },
    ];
    await expect(runMigrationsAsync(makeFakeAsyncDriver(), bad)).rejects.toThrow(
      /strict-monotonic starting at 1/,
    );
  });

  it("treats an empty registry as a no-op", async () => {
    const driver = makeFakeAsyncDriver();
    const result = await runMigrationsAsync(driver, []);
    expect(result).toEqual({ from: 0, to: 0, applied: [] });
    expect(driver.calls).toEqual([]);
  });
});
