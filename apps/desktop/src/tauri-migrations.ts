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
  {
    version: 2,
    description:
      "goals.budget_tokens + goal_outcomes.tokens_used — runtime-register budget envelope",
    statements: [
      // v1 axis of the goal's bounded-commitment envelope per
      // docs/doctrine/panel-temporal-registers.md §"Bounded commitment
      // is multi-dimensional." Sibling entries: web's localStorage
      // adapter rolls up `spent_tokens` on the goal record directly;
      // mobile lands the same column in expo-sqlite migration v22;
      // persistence has the column from #36 (already shipped). The
      // tokens_used column on goal_outcomes was referenced in
      // goal-scheduler.ts:523 since 7a52cd59 (2026-02) but never added
      // to the Tauri schema — INSERTs against it silently failed on
      // fresh desktop installs. This migration closes that gap.
      "ALTER TABLE goals ADD COLUMN budget_tokens INTEGER",
      "ALTER TABLE goal_outcomes ADD COLUMN tokens_used INTEGER",
    ],
  },
  {
    version: 3,
    description: "goal_outcomes.response_full — preserve the artifact bytes per goal fire",
    statements: [
      // Per `docs/doctrine/goal-results.md` §"The three categories":
      // every goal fire produces a **commitment** (the goal record), a
      // **receipt** (signed audit row), and an **artifact** (the
      // content motebit actually produced). Pre-Phase-3, the artifact
      // was stored only as a 500-char `summary` on the outcome row;
      // the full text was generated, surfaced through the slab's
      // `restItem` (motebit-runtime.ts:1908), and then lost from
      // durable storage. The `response_full` column closes that gap:
      // the artifact bytes are preserved alongside the receipt,
      // available to (1) the longer card-detail preview the panels
      // controller projects via `ScheduledGoal.last_response_full`,
      // (2) the cross-device sync surface, and (3) the
      // `ContentArtifactManifest` signing path (Phase-3 sibling
      // commit). NULL on pre-v3 rows — the runner's clear-on-error
      // semantic treats absence the same as a failed fire's null
      // summary. Sibling entries: mobile's expo-sqlite-migrations v23
      // lands the same column shape; persistence (cli) will inherit
      // via its own migration ladder when the cli scheduler grows
      // full-text preservation.
      "ALTER TABLE goal_outcomes ADD COLUMN response_full TEXT",
    ],
  },
  {
    version: 4,
    description: "goal_outcomes.signed_manifest — persisted ContentArtifactManifest per goal fire",
    statements: [
      // Closes the Phase-3 deferral named in
      // docs/doctrine/goal-results.md §"Deferred from Phase 3":
      // desktop's scheduler now wraps every successful fire's
      // `response_full` as a signed `ContentArtifactManifest`
      // (suite-dispatched via `@motebit/crypto`, currently
      // `motebit-jcs-ed25519-hex-v1`). The manifest JSON lands here
      // alongside the artifact bytes so the receipt-category surface
      // — the goal card's new collapsed-view receipt-summary row —
      // can render the "signed" indicator on the same wire shape as
      // web. NULL when identity wasn't loaded at fire-time / content
      // was empty / signer threw (calm-software degradation; no
      // placeholder signatures). The SQL projection in
      // `list_goals_with_meta` derives `last_manifest_signed` as
      // `(latest_outcome.signed_manifest IS NOT NULL)`. Sibling entry:
      // mobile's expo-sqlite-migrations v24 lands the same column.
      "ALTER TABLE goal_outcomes ADD COLUMN signed_manifest TEXT",
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
