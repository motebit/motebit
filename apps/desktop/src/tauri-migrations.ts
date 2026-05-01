/**
 * Schema-version registry for the desktop Tauri renderer. Empty today —
 * the at-rest schema baked into `apps/desktop/src-tauri/src/main.rs` already
 * declares the post-v33 column shape, so no historical ladder exists for
 * desktop installs to walk through. Phase 5-ship's `sensitivity` column on
 * `conversation_messages` is the first entry to land here, applied via
 * `runMigrationsAsync` over Tauri IPC at boot.
 *
 * The renderer is a Chromium webview, not Node — every database statement
 * round-trips through `db_query` / `db_execute` IPC commands. The async
 * driver shim below adapts those into the runner's minimal shape.
 */

import {
  runMigrationsAsync,
  type AsyncSqliteDriver,
  type Migration,
} from "@motebit/sqlite-migrations";

import type { InvokeFn } from "./tauri-storage.js";

export const DESKTOP_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: "conversation_messages.sensitivity + tool_audit_log.sensitivity",
    statements: [
      // Phase 5-ship — registers conversations + tool-audit under the
      // `consolidation_flush` retention shape per
      // docs/doctrine/retention-policy.md. Pre-phase-5 rows leave
      // sensitivity NULL and the flush phase lazy-classifies on read
      // per decision 6b. Sibling entries land in persistence (v34) and
      // mobile (v19) the same release.
      "ALTER TABLE conversation_messages ADD COLUMN sensitivity TEXT",
      "ALTER TABLE tool_audit_log ADD COLUMN sensitivity TEXT",
    ],
  },
];

interface UserVersionRow {
  user_version: number;
}

function tauriIpcDriver(invoke: InvokeFn): AsyncSqliteDriver {
  return {
    async exec(sql: string): Promise<void> {
      await invoke<number>("db_execute", { sql, params: [] });
    },
    async getUserVersion(): Promise<number> {
      const rows = await invoke<UserVersionRow[]>("db_query", {
        sql: "PRAGMA user_version",
        params: [],
      });
      return rows[0]?.user_version ?? 0;
    },
    async setUserVersion(version: number): Promise<void> {
      // PRAGMA user_version = N must be a literal — bind parameters aren't
      // accepted for PRAGMA. The version number is registry-controlled, not
      // user-controlled, so the inline interpolation has no injection
      // surface. Validate defensively anyway.
      if (!Number.isInteger(version) || version < 0) {
        throw new Error(
          `tauri-migrations: refusing to set non-integer user_version ${String(version)}`,
        );
      }
      await invoke<number>("db_execute", {
        sql: `PRAGMA user_version = ${version}`,
        params: [],
      });
    },
  };
}

/**
 * Apply pending migrations against the Tauri-hosted SQLite database. Call
 * once at boot, after the IPC bridge is ready and before constructing any
 * storage adapters that read/write the affected tables.
 */
export async function runDesktopMigrations(
  invoke: InvokeFn,
): Promise<{ from: number; to: number; applied: number[] }> {
  return runMigrationsAsync(tauriIpcDriver(invoke), DESKTOP_MIGRATIONS);
}
