/**
 * Idempotency key support for financial operations.
 *
 * Prevents double-charges and double-settlements when clients retry on network failure.
 * Standard pattern: client sends `Idempotency-Key: <uuid>` header. First request proceeds,
 * replays return cached response, concurrent requests get 409 Conflict.
 *
 * Records are scoped to (idempotency_key, motebit_id) — different agents can reuse the same key.
 * Records older than 24 hours are cleaned up by the existing cleanup interval.
 */

import type { DatabaseDriver } from "@motebit/persistence";
import { createLogger } from "./logger.js";

const logger = createLogger({ service: "idempotency" });

/** How long idempotency records are retained (24 hours). */
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export interface IdempotencyRecord {
  key: string;
  motebit_id: string;
  status: "processing" | "completed";
  response_status: number | null;
  response_body: string | null;
  created_at: number;
  completed_at: number | null;
}

export type IdempotencyCheckResult =
  | { action: "proceed" }
  | { action: "replay"; status: number; body: string }
  | { action: "conflict" };

/** Create the idempotency keys table. Idempotent. */
export function createIdempotencyTable(db: DatabaseDriver): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS relay_idempotency_keys (
      idempotency_key TEXT NOT NULL,
      motebit_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'processing',
      response_status INTEGER,
      response_body TEXT,
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      PRIMARY KEY (idempotency_key, motebit_id)
    );
  `);
}

/**
 * Check an idempotency key and atomically claim it if unclaimed.
 *
 * - If key exists and status='completed': returns cached response (replay).
 * - If key exists and status='processing': returns 409 Conflict (concurrent request).
 * - If key doesn't exist: INSERTs with status='processing' and returns null (proceed).
 *
 * The check + INSERT is atomic within a single SQLite statement (INSERT OR IGNORE + SELECT).
 */
export function checkIdempotency(
  db: DatabaseDriver,
  key: string,
  motebitId: string,
): IdempotencyCheckResult {
  // Attempt to insert — INSERT OR IGNORE is atomic and won't fail if the row exists.
  const now = Date.now();
  const info = db
    .prepare(
      "INSERT OR IGNORE INTO relay_idempotency_keys (idempotency_key, motebit_id, status, created_at) VALUES (?, ?, 'processing', ?)",
    )
    .run(key, motebitId, now);

  if (info.changes > 0) {
    // Successfully inserted — this is the first request with this key.
    return { action: "proceed" };
  }

  // Row already exists — check its status.
  const existing = db
    .prepare(
      "SELECT status, response_status, response_body FROM relay_idempotency_keys WHERE idempotency_key = ? AND motebit_id = ?",
    )
    .get(key, motebitId) as
    | {
        status: string;
        response_status: number | null;
        response_body: string | null;
      }
    | undefined;

  if (!existing) {
    // Should not happen — race condition between IGNORE and SELECT.
    // Treat as conflict to be safe (fail-closed).
    return { action: "conflict" };
  }

  if (
    existing.status === "completed" &&
    existing.response_status != null &&
    existing.response_body != null
  ) {
    logger.info("idempotency.replay", { key, motebitId });
    return {
      action: "replay",
      status: existing.response_status,
      body: existing.response_body,
    };
  }

  // Still processing — concurrent request.
  logger.info("idempotency.conflict", { key, motebitId });
  return { action: "conflict" };
}

/**
 * Mark an idempotency key as completed with the response to cache.
 */
export function completeIdempotency(
  db: DatabaseDriver,
  key: string,
  motebitId: string,
  responseStatus: number,
  responseBody: string,
): void {
  const now = Date.now();
  db.prepare(
    "UPDATE relay_idempotency_keys SET status = 'completed', response_status = ?, response_body = ?, completed_at = ? WHERE idempotency_key = ? AND motebit_id = ?",
  ).run(responseStatus, responseBody, now, key, motebitId);
}

/**
 * Delete idempotency records older than 24 hours.
 * Called from the existing cleanup interval in index.ts.
 * Returns the number of records deleted.
 */
export function cleanupIdempotencyKeys(db: DatabaseDriver): number {
  const cutoff = Date.now() - IDEMPOTENCY_TTL_MS;
  const info = db.prepare("DELETE FROM relay_idempotency_keys WHERE created_at < ?").run(cutoff);
  return info.changes;
}
