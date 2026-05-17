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
    expect(DESKTOP_MIGRATIONS.length).toBeGreaterThanOrEqual(1);
    const v1 = DESKTOP_MIGRATIONS[0]!;
    expect(v1.version).toBe(1);
    expect(v1.statements).toContain(
      "ALTER TABLE conversation_messages ADD COLUMN sensitivity TEXT",
    );
    expect(v1.statements).toContain("ALTER TABLE tool_audit_log ADD COLUMN sensitivity TEXT");
  });

  it("declares the v2 runtime-register budget envelope migration", () => {
    const v2 = DESKTOP_MIGRATIONS.find((m) => m.version === 2);
    expect(v2).toBeDefined();
    expect(v2!.statements).toContain("ALTER TABLE goals ADD COLUMN budget_tokens INTEGER");
    expect(v2!.statements).toContain("ALTER TABLE goal_outcomes ADD COLUMN tokens_used INTEGER");
  });

  it("declares the v4 goal-results Phase-3 deferral close migration (signed_manifest)", () => {
    const v4 = DESKTOP_MIGRATIONS.find((m) => m.version === 4);
    expect(v4).toBeDefined();
    expect(v4!.statements).toContain("ALTER TABLE goal_outcomes ADD COLUMN signed_manifest TEXT");
  });

  it("declares the v5 settlement-lane migration (settlement_mode)", () => {
    const v5 = DESKTOP_MIGRATIONS.find((m) => m.version === 5);
    expect(v5).toBeDefined();
    expect(v5!.statements).toContain(
      "ALTER TABLE settlements ADD COLUMN settlement_mode TEXT DEFAULT 'relay'",
    );
  });
});

describe("tauri-migrations — runDesktopMigrations over Tauri IPC mock", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    // Pre-create the tables every migration ALTERs (the Tauri Rust
    // backend creates these at boot per src-tauri/src/main.rs; the
    // mock re-creates them to give the migrations something to alter).
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
      CREATE TABLE goals (
        goal_id TEXT PRIMARY KEY,
        motebit_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        interval_ms INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE goal_outcomes (
        outcome_id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL,
        ran_at INTEGER NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE settlements (
        settlement_id TEXT PRIMARY KEY,
        allocation_id TEXT NOT NULL,
        receipt_hash TEXT NOT NULL,
        amount_settled INTEGER NOT NULL
      );
    `);
  });

  afterEach(() => {
    db.close();
  });

  it("runs migrations from 0 to the latest declared version", async () => {
    const invoke = createMockInvoke(db);
    const latest = Math.max(...DESKTOP_MIGRATIONS.map((m) => m.version));
    const result = await runDesktopMigrations(invoke);

    expect(result.from).toBe(0);
    expect(result.to).toBe(latest);

    // v1 columns
    const convCols = db.prepare("PRAGMA table_info(conversation_messages)").all() as Array<{
      name: string;
    }>;
    expect(convCols.some((c) => c.name === "sensitivity")).toBe(true);

    const toolCols = db.prepare("PRAGMA table_info(tool_audit_log)").all() as Array<{
      name: string;
    }>;
    expect(toolCols.some((c) => c.name === "sensitivity")).toBe(true);

    // v2 columns — budget envelope foundation
    const goalCols = db.prepare("PRAGMA table_info(goals)").all() as Array<{ name: string }>;
    expect(goalCols.some((c) => c.name === "budget_tokens")).toBe(true);

    const outcomeCols = db.prepare("PRAGMA table_info(goal_outcomes)").all() as Array<{
      name: string;
    }>;
    expect(outcomeCols.some((c) => c.name === "tokens_used")).toBe(true);
    // v3 + v4 columns — artifact preservation + Phase-3 deferral close
    expect(outcomeCols.some((c) => c.name === "response_full")).toBe(true);
    expect(outcomeCols.some((c) => c.name === "signed_manifest")).toBe(true);

    // v5 column — settlement lane discriminant
    const settlementCols = db.prepare("PRAGMA table_info(settlements)").all() as Array<{
      name: string;
    }>;
    expect(settlementCols.some((c) => c.name === "settlement_mode")).toBe(true);

    const version = db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(version.user_version).toBe(latest);
  });

  it("is idempotent — second run is a no-op", async () => {
    const invoke = createMockInvoke(db);
    const first = await runDesktopMigrations(invoke);
    const second = await runDesktopMigrations(invoke);

    expect(second.from).toBe(first.to);
    expect(second.to).toBe(first.to);
    expect(second.applied).toEqual([]);
  });
});
