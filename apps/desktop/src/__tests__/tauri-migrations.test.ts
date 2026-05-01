/**
 * Smoke tests for the desktop Tauri renderer's migration runner.
 *
 * Covers the IPC driver shim (db_query / db_execute round-trips) and
 * the runDesktopMigrations entry point. The renderer is a Chromium
 * webview, not Node — so the test mocks `invoke` over an in-memory
 * better-sqlite3 database the same way `tauri-storage.test.ts` does.
 */
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DESKTOP_MIGRATIONS, runDesktopMigrations } from "../tauri-migrations.js";
import type { InvokeFn } from "../tauri-storage.js";

function createMockInvoke(db: Database.Database): InvokeFn {
  return async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    if (cmd === "db_query") {
      const sql = args!.sql as string;
      const params = (args!.params as unknown[]) ?? [];
      const rows = db.prepare(sql).all(...params);
      return rows as T;
    }
    if (cmd === "db_execute") {
      const sql = args!.sql as string;
      const params = (args!.params as unknown[]) ?? [];
      const result = db.prepare(sql).run(...params);
      return result.changes as T;
    }
    throw new Error(`unexpected invoke cmd in test mock: ${cmd}`);
  };
}

describe("tauri-migrations — DESKTOP_MIGRATIONS registry", () => {
  it("declares the v1 phase-5-ship sensitivity migration", () => {
    expect(DESKTOP_MIGRATIONS).toHaveLength(1);
    const v1 = DESKTOP_MIGRATIONS[0]!;
    expect(v1.version).toBe(1);
    expect(v1.statements).toContain(
      "ALTER TABLE conversation_messages ADD COLUMN sensitivity TEXT",
    );
    expect(v1.statements).toContain("ALTER TABLE tool_audit_log ADD COLUMN sensitivity TEXT");
  });
});

describe("tauri-migrations — runDesktopMigrations over Tauri IPC mock", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    // Pre-create the tables the v1 migration ALTERs (the Tauri Rust
    // backend creates these at boot per src-tauri/src/main.rs; the
    // mock re-creates them to give the migration something to alter).
    db.exec(`
      CREATE TABLE conversation_messages (
        message_id TEXT PRIMARY KEY,
        turn_id TEXT,
        content TEXT
      );
      CREATE TABLE tool_audit_log (
        call_id TEXT PRIMARY KEY,
        turn_id TEXT,
        tool TEXT
      );
    `);
  });

  afterEach(() => {
    db.close();
  });

  it("runs migrations from version 0 to 1 — applies the sensitivity ALTERs", async () => {
    const invoke = createMockInvoke(db);
    const result = await runDesktopMigrations(invoke);

    expect(result.from).toBe(0);
    expect(result.to).toBe(1);
    expect(result.applied).toEqual([1]);

    // Verify the sensitivity columns now exist.
    const convCols = db.prepare("PRAGMA table_info(conversation_messages)").all() as Array<{
      name: string;
    }>;
    expect(convCols.some((c) => c.name === "sensitivity")).toBe(true);

    const toolCols = db.prepare("PRAGMA table_info(tool_audit_log)").all() as Array<{
      name: string;
    }>;
    expect(toolCols.some((c) => c.name === "sensitivity")).toBe(true);

    // PRAGMA user_version was bumped to 1.
    const version = db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(version.user_version).toBe(1);
  });

  it("is idempotent — second run is a no-op (already at v1)", async () => {
    const invoke = createMockInvoke(db);
    await runDesktopMigrations(invoke);
    const second = await runDesktopMigrations(invoke);

    expect(second.from).toBe(1);
    expect(second.to).toBe(1);
    expect(second.applied).toEqual([]);
  });
});
