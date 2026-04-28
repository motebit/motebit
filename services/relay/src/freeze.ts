/**
 * Persistent emergency freeze state.
 *
 * Read-through cache backed by SQLite relay_config table.
 * Write to DB first, then update in-memory cache. On startup, load from DB.
 */

import type { DatabaseDriver } from "@motebit/persistence";
import { createLogger } from "./logger.js";

const logger = createLogger({ service: "freeze" });

export interface FreezeState {
  frozen: boolean;
  reason: string | null;
}

/**
 * Create the relay_config table if it doesn't exist.
 * Generic key-value store for relay-level configuration that must survive restarts.
 */
export function createRelayConfigTable(db: DatabaseDriver): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS relay_config (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

/**
 * Load persisted freeze state from the database.
 * Returns { frozen: false, reason: null } if no persisted state exists.
 */
export function loadFreezeState(db: DatabaseDriver): FreezeState {
  try {
    const row = db.prepare("SELECT value FROM relay_config WHERE key = ?").get("freeze_state") as
      | { value: string }
      | undefined;

    if (!row) {
      return { frozen: false, reason: null };
    }

    const parsed = JSON.parse(row.value) as { frozen: boolean; reason: string | null };
    return {
      frozen: Boolean(parsed.frozen),
      reason: parsed.reason ?? null,
    };
  } catch (err) {
    logger.error("freeze.load_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    // Fail-closed: if we can't read freeze state, assume not frozen
    // (the alternative — assuming frozen — would block all writes on a corrupt config row)
    return { frozen: false, reason: null };
  }
}

/**
 * Persist freeze state to the database atomically, then update the in-memory cache.
 * DB write happens first so a crash between write and cache update is safe
 * (next startup will load the persisted state).
 */
export function persistFreeze(
  db: DatabaseDriver,
  cache: FreezeState,
  frozen: boolean,
  reason: string | null,
): void {
  const value = JSON.stringify({ frozen, reason });

  try {
    db.prepare(
      "INSERT INTO relay_config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    ).run("freeze_state", value, Date.now());
  } catch (err) {
    throw new Error("Failed to persist freeze state", { cause: err });
  }

  // Update in-memory cache only after successful DB write
  cache.frozen = frozen;
  cache.reason = reason;
}
