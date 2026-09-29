/**
 * Idempotency key support for financial operations.
 *
 * Prevents double-charges and double-settlements when clients retry on network failure.
 * Standard pattern: client sends `Idempotency-Key: <uuid>` header. First request proceeds,
 * replays return cached response, concurrent requests get 409 Conflict.
 *
 * Records are scoped to (idempotency_key, motebit_id) — different agents can reuse the same key.
 * Records older than 24 hours are cleaned up by the existing cleanup interval.
 *
 * One key admits at most one task (#888). A task submission binds its claim
 * to the task it admits (`bindIdempotencyClaimToTask`) in the SAME transaction
 * that enqueues the task. From then on the claim is never released: a
 * submission that throws after admission records the response its client got
 * (`recordAdmittedOutcome`), and a replay returns that response, carrying the
 * admitted `task_id`. `releaseIdempotency` deletes only a claim that admitted
 * nothing, so the release on a thrown request cannot reopen a key whose task
 * is already queued.
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
  /** The task this claim admitted (#888); null until admission, and for non-task routes. */
  task_id: string | null;
}

export type IdempotencyCheckResult =
  | { action: "proceed" }
  | { action: "replay"; status: number; body: string }
  | {
      action: "conflict";
      /**
       * The task this still-processing claim already admitted (#888), when it
       * has one — so a 409 can name it. Absent while nothing is admitted yet.
       */
      taskId?: string;
    };

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
  // #888: the task a claim admitted. PRAGMA-guarded so an existing relay DB
  // gains the column in place (same pattern as the relay's other ALTERs).
  const cols = (
    db.prepare("PRAGMA table_info(relay_idempotency_keys)").all() as { name: string }[]
  ).map((c) => c.name);
  if (!cols.includes("task_id")) {
    db.exec("ALTER TABLE relay_idempotency_keys ADD COLUMN task_id TEXT;");
  }
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
      "SELECT status, response_status, response_body, task_id FROM relay_idempotency_keys WHERE idempotency_key = ? AND motebit_id = ?",
    )
    .get(key, motebitId) as
    | {
        status: string;
        response_status: number | null;
        response_body: string | null;
        task_id: string | null;
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

  // Still processing — concurrent request. A claim already bound to a task
  // names it (#888): that is the task this key admitted, whether its request
  // is still in flight or died between admission and recording its outcome.
  logger.info("idempotency.conflict", { key, motebitId, taskId: existing.task_id });
  return existing.task_id != null
    ? { action: "conflict", taskId: existing.task_id }
    : { action: "conflict" };
}

/**
 * Whether a claim already exists for this key — read-only, never claims.
 *
 * The x402 gate asks this BEFORE it prices a task submission (#925): a key
 * that already holds a claim is a replay (completed) or a conflict
 * (processing), and the handler answers both from the claim without admitting
 * anything, so the gate must not quote, verify or charge such a request. It is
 * a peek, not a decision: the handler's `checkIdempotency` still decides, and a
 * claim that lands between this read and the handler is caught there — an
 * x402 payment is settled only by a request that owns its claim, so a request
 * that loses that race is charged nothing.
 */
export function idempotencyClaimExists(
  db: DatabaseDriver,
  key: string,
  motebitId: string,
): boolean {
  return (
    db
      .prepare("SELECT 1 FROM relay_idempotency_keys WHERE idempotency_key = ? AND motebit_id = ?")
      .get(key, motebitId) !== undefined
  );
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
 * Bind a 'processing' claim to the task it admits (#888). Call INSIDE the
 * transaction that enqueues the task, so the task exists exactly when its
 * claim names it: a rollback undoes both. Throws when the claim is not an
 * unbound 'processing' row for this key — the request no longer owns a claim
 * that may admit, so it must not enqueue (the transaction rolls back).
 */
export function bindIdempotencyClaimToTask(
  db: DatabaseDriver,
  key: string,
  motebitId: string,
  taskId: string,
): void {
  const info = db
    .prepare(
      "UPDATE relay_idempotency_keys SET task_id = ? WHERE idempotency_key = ? AND motebit_id = ? AND status = 'processing' AND task_id IS NULL",
    )
    .run(taskId, key, motebitId);
  if (info.changes !== 1) {
    throw new Error(
      `idempotency claim for key ${key} is not an unbound processing claim — refusing to admit task ${taskId}`,
    );
  }
}

/**
 * Record the response a request that ADMITTED a task ended with (#888) — the
 * terminal outcome a replay of its key reports. Written only over the claim
 * bound to that exact task and still 'processing', so a request that already
 * completed its claim (the 201 path) or never admitted is untouched.
 * Returns whether a row was written.
 */
export function recordAdmittedOutcome(
  db: DatabaseDriver,
  key: string,
  motebitId: string,
  taskId: string,
  responseStatus: number,
  responseBody: string,
): boolean {
  const info = db
    .prepare(
      "UPDATE relay_idempotency_keys SET status = 'completed', response_status = ?, response_body = ?, completed_at = ? WHERE idempotency_key = ? AND motebit_id = ? AND task_id = ? AND status = 'processing'",
    )
    .run(responseStatus, responseBody, Date.now(), key, motebitId, taskId);
  return info.changes > 0;
}

/**
 * Release a claimed-but-never-completed idempotency key (#459 secondary
 * defect): a submit handler that throws AFTER `checkIdempotency` claimed
 * the row used to strand it in 'processing' forever — an honest retry
 * with the SAME key then got 409 until the 24h sweep, which trains
 * clients to mint a fresh key per attempt (defeating idempotency
 * entirely; both storm-implicated submitters did exactly this). Deletes
 * ONLY a still-'processing' row that admitted nothing — a completed row
 * (cached response) is never touched, and neither is a claim bound to an
 * admitted task (#888): releasing that one let a same-key retry admit a
 * SECOND task while the first stayed queued. Call from the error boundary
 * of the request that made the claim, never for a conflict observed on
 * someone else's claim.
 */
export function releaseIdempotency(db: DatabaseDriver, key: string, motebitId: string): void {
  db.prepare(
    "DELETE FROM relay_idempotency_keys WHERE idempotency_key = ? AND motebit_id = ? AND status = 'processing' AND task_id IS NULL",
  ).run(key, motebitId);
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

// ── One P2P payment proof admits at most one task (#918) ──────────────────
//
// An Idempotency-Key binds a REQUEST to the task it admits (#888). It says
// nothing about the money. A P2P submission's money is its `payment_proof`,
// and one onchain payment funds exactly one task, so the proof is bound to
// the task it admits, in the SAME admission transaction that enqueues it,
// under a unique claim on the proof's tx hash. Any later admission of that
// proof — under any key, by any submitter, through any door (a relay
// submission, a sub-hop, a federated forward received from a peer) — is
// refused.
//
// The claim exists exactly when its task was admitted. It is written inside
// the admission transaction, so a refusal inside that transaction rolls it
// back with the task, and a refusal before admission never writes it. Nothing
// deletes a claim: after admission the proof is spent on that task, whatever
// becomes of it (a failed forward, an expired task, a paid failure). The retry
// of a failed admitted submission is the same-key replay (#888) or the task's
// result, never the same proof under a new key.
//
// Before this, the only reuse guard read `relay_settlements.p2p_tx_hash`, so
// it saw SETTLED proofs only: one unsettled payment admitted and dispatched a
// task per fresh key. The unique settlement index stopped the second
// settlement, not the second execution.

/**
 * The claim key of a P2P payment proof: its tx hash, byte-for-byte. That is
 * exactly what settlement records as `relay_settlements.p2p_tx_hash` (never
 * trimmed or case-folded; a base58 signature is case-sensitive). One function,
 * so the admission claim and the settled-proof guard compare the same bytes.
 */
export function p2pProofKey(txHash: string): string {
  return txHash;
}

/** The task a P2P payment proof was admitted for, and who submitted it. */
export interface P2pProofClaim {
  task_id: string;
  submitted_by: string;
  /**
   * 1 when `submitted_by` was proven by the admitting request's signed token;
   * 0 when it was asserted (the operator's body field, a peer's forward).
   */
  submitter_verified: 0 | 1;
}

/** The admitted claim on this proof, if any (#918). */
export function findP2pProofClaim(db: DatabaseDriver, txHash: string): P2pProofClaim | undefined {
  return db
    .prepare(
      "SELECT task_id, submitted_by, submitter_verified FROM relay_p2p_proof_claims WHERE tx_hash = ?",
    )
    .get(p2pProofKey(txHash)) as P2pProofClaim | undefined;
}

/**
 * Bind a P2P payment proof to the task it admits (#918). Call INSIDE the
 * transaction that enqueues the task, so a rollback undoes the claim with the
 * task. Idempotent for the same task (a peer re-forwarding the same task_id).
 * Returns the existing claim when the proof is already bound to a DIFFERENT
 * task; the caller must then refuse and roll back, never admit.
 */
export function bindP2pProofToTask(
  db: DatabaseDriver,
  txHash: string,
  taskId: string,
  submittedBy: string,
  /** `submittedBy` was proven by the admitting request's signed token. */
  submitterVerified: boolean,
): { bound: true } | { bound: false; existing: P2pProofClaim } {
  const key = p2pProofKey(txHash);
  const info = db
    .prepare(
      "INSERT OR IGNORE INTO relay_p2p_proof_claims (tx_hash, task_id, submitted_by, submitter_verified, claimed_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(key, taskId, submittedBy, submitterVerified ? 1 : 0, Date.now());
  if (info.changes > 0) return { bound: true };
  const existing = findP2pProofClaim(db, key);
  if (existing == null) {
    // The IGNORE saw a row the SELECT cannot: fail closed, never admit.
    throw new Error(`p2p proof claim for ${key} is unreadable; refusing to admit task ${taskId}`);
  }
  if (existing.task_id === taskId) return { bound: true };
  return { bound: false, existing };
}
