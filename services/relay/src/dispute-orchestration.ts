/**
 * §6.2 federation orchestrator — deferred retry-within-72h driver.
 *
 * Wraps the one-shot `orchestrateFederationResolution` (in `disputes.ts`)
 * with persistence + retry policy so a single peer hiccup at fan-out
 * time no longer becomes a permanently-lost vote. The §6.6 72h
 * adjudication window is now the orchestrator's actual attempt window;
 * the per-request 10s timeout governs ONE attempt, not the deadline.
 *
 * State machine per (dispute_id, round) in `relay_dispute_orchestrations`:
 *
 *   absent → in_progress → done       (quorum reached; resolution persisted)
 *                        → timed_out  (72h deadline; §6.6 fallback applies)
 *
 * Per-attempt retry policy: exponential backoff capped at 30 minutes —
 * `min(10s * 2^attempt, 30min)`. Caps the worst-case poll rate while
 * keeping the early-attempt cadence tight enough to catch transient
 * peer flakiness within the first few minutes.
 *
 * The driver is restart-resumable by construction: the table is the
 * single source of truth, the worker (`runDeferredOrchestrationCycle`)
 * picks up `in_progress` rows on every poll regardless of process
 * identity. Cross-process concurrency is bounded by:
 *   - `relay_dispute_resolutions UNIQUE(dispute_id, round)` catches any
 *     duplicate finalize race (one wins, the other rolls back gracefully).
 *   - `relay_dispute_votes UNIQUE(dispute_id, round, peer_id) ON CONFLICT
 *     DO UPDATE` makes parallel fan-outs to the same peer idempotent.
 *
 * See `memory/section_6_2_orchestrator_async_deferral` for the
 * deferred-trade-off the v1 sync orchestrator left open; this module
 * closes it.
 */
import type { DatabaseDriver } from "@motebit/persistence";
import type { AdjudicatorVote, DisputeFundAction, DisputeOutcome } from "@motebit/protocol";
import { signDisputeResolution } from "@motebit/encryption";
import type { RelayIdentity } from "./federation.js";
import { createLogger } from "./logger.js";

const logger = createLogger({ service: "relay", module: "dispute-orchestration" });

/** §6.6 adjudication window — the orchestrator's deferred attempt deadline. */
export const ORCHESTRATION_DEADLINE_MS = 72 * 60 * 60 * 1000;

/** Per-attempt timeout — the per-request fan-out deadline (one attempt). */
export const ORCHESTRATION_PER_ATTEMPT_TIMEOUT_MS = 10_000;

/** Backoff cap — no single inter-attempt gap exceeds this. */
const ORCHESTRATION_BACKOFF_CAP_MS = 30 * 60 * 1000;

/** Worker poll cadence — how often `runDeferredOrchestrationCycle` fires. */
export const ORCHESTRATION_WORKER_INTERVAL_MS = 60_000;

/**
 * Compute the next-attempt timestamp from attempt count.
 * `min(10s * 2^attempt, 30min)`. Attempt 0 → 10s; 1 → 20s; ... 8 → 30min.
 */
export function computeNextAttemptAt(attemptCount: number, now: number): number {
  const baseDelayMs = 10_000 * Math.pow(2, Math.max(0, attemptCount));
  const delayMs = Math.min(baseDelayMs, ORCHESTRATION_BACKOFF_CAP_MS);
  return now + delayMs;
}

export interface OrchestrationRow {
  dispute_id: string;
  round: number;
  status: "in_progress" | "done" | "timed_out";
  started_at: number;
  last_attempt_at: number;
  next_attempt_at: number | null;
  attempt_count: number;
  deadline_at: number;
}

/**
 * Read orchestration state for a (dispute, round). Returns null if no
 * attempt has been made yet.
 */
export function getOrchestrationState(
  db: DatabaseDriver,
  disputeId: string,
  round: number,
): OrchestrationRow | null {
  const row = db
    .prepare(
      `SELECT dispute_id, round, status, started_at, last_attempt_at, next_attempt_at,
              attempt_count, deadline_at
       FROM relay_dispute_orchestrations WHERE dispute_id = ? AND round = ?`,
    )
    .get(disputeId, round) as OrchestrationRow | undefined;
  return row ?? null;
}

/**
 * Insert an in_progress orchestration row at the start of the first
 * attempt. Idempotent: re-running on existing row is a no-op (the row
 * already carries the started_at + deadline).
 */
export function initOrchestration(
  db: DatabaseDriver,
  disputeId: string,
  round: number,
  now: number,
): OrchestrationRow {
  const existing = getOrchestrationState(db, disputeId, round);
  if (existing) return existing;
  const deadlineAt = now + ORCHESTRATION_DEADLINE_MS;
  db.prepare(
    `INSERT INTO relay_dispute_orchestrations
       (dispute_id, round, status, started_at, last_attempt_at, next_attempt_at, attempt_count, deadline_at)
     VALUES (?, ?, 'in_progress', ?, ?, ?, 0, ?)`,
  ).run(disputeId, round, now, now, computeNextAttemptAt(0, now), deadlineAt);
  return getOrchestrationState(db, disputeId, round)!;
}

/**
 * Update an orchestration row after one attempt: bump attempt_count,
 * update last_attempt_at, set next_attempt_at per backoff. Status
 * stays `in_progress` — finalization (done / timed_out) is a separate
 * call site at the attempt-or-finalize boundary.
 */
export function recordOrchestrationAttempt(
  db: DatabaseDriver,
  disputeId: string,
  round: number,
  now: number,
): OrchestrationRow {
  const current = getOrchestrationState(db, disputeId, round);
  if (!current)
    throw new Error(`Cannot record attempt on missing orchestration row ${disputeId}:${round}`);
  const newAttemptCount = current.attempt_count + 1;
  db.prepare(
    `UPDATE relay_dispute_orchestrations
       SET attempt_count = ?, last_attempt_at = ?, next_attempt_at = ?
       WHERE dispute_id = ? AND round = ?`,
  ).run(newAttemptCount, now, computeNextAttemptAt(newAttemptCount, now), disputeId, round);
  return getOrchestrationState(db, disputeId, round)!;
}

/** Mark orchestration done (quorum reached). next_attempt_at cleared. */
export function markOrchestrationDone(db: DatabaseDriver, disputeId: string, round: number): void {
  db.prepare(
    `UPDATE relay_dispute_orchestrations
       SET status = 'done', next_attempt_at = NULL
       WHERE dispute_id = ? AND round = ?`,
  ).run(disputeId, round);
}

/** Mark orchestration timed_out (72h deadline elapsed). next_attempt_at cleared. */
export function markOrchestrationTimedOut(
  db: DatabaseDriver,
  disputeId: string,
  round: number,
): void {
  db.prepare(
    `UPDATE relay_dispute_orchestrations
       SET status = 'timed_out', next_attempt_at = NULL
       WHERE dispute_id = ? AND round = ?`,
  ).run(disputeId, round);
}

/**
 * Enumerate orchestrations whose next_attempt_at <= now and status is
 * `in_progress`. Used by the background worker to drive retries.
 */
export function getDueOrchestrations(
  db: DatabaseDriver,
  now: number,
  limit = 50,
): Array<{ dispute_id: string; round: number }> {
  return db
    .prepare(
      `SELECT dispute_id, round
       FROM relay_dispute_orchestrations
       WHERE status = 'in_progress' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?
       ORDER BY next_attempt_at ASC
       LIMIT ?`,
    )
    .all(now, limit) as Array<{ dispute_id: string; round: number }>;
}

/**
 * Sign + persist a DisputeResolution row and transition the dispute to
 * `resolved` (round 1) or `final` (round 2) atomically. Used by both
 * the synchronous /resolve quorum-on-first-attempt path and the
 * deferred worker's quorum-on-later-attempt path.
 *
 * Cross-process safety: the `relay_dispute_resolutions UNIQUE
 * (dispute_id, round)` constraint catches any concurrent finalize race
 * — one writer wins, the other catches the constraint violation and
 * is a no-op (the resolution that landed first is canonical). Returns
 * `{ persisted: true }` if this call wrote the row, `{ persisted: false }`
 * if a concurrent writer beat us to it.
 */
export interface FinalizeArgs {
  disputeId: string;
  round: number;
  resolution: DisputeOutcome;
  rationale: string;
  fund_action: DisputeFundAction;
  split_ratio: number;
  adjudicator_votes: AdjudicatorVote[];
  resolvedAt: number;
}

export interface FinalizeDeps {
  db: DatabaseDriver;
  relayIdentity: RelayIdentity;
}

export async function finalizeFederationResolution(
  args: FinalizeArgs,
  deps: FinalizeDeps,
): Promise<{ persisted: boolean; signature: string }> {
  const { db, relayIdentity } = deps;
  const signed = await signDisputeResolution(
    {
      dispute_id: args.disputeId,
      resolution: args.resolution,
      rationale: args.rationale,
      fund_action: args.fund_action,
      split_ratio: args.split_ratio,
      adjudicator: relayIdentity.relayMotebitId,
      adjudicator_votes: args.adjudicator_votes,
      resolved_at: args.resolvedAt,
    },
    relayIdentity.privateKey,
  );
  const resolutionId = `res-${args.resolvedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  // The two-step transition (insert resolution + update dispute state)
  // runs in a single transaction. The state-target depends on round:
  //   round 1 → 'resolved' (24h appeal window opens)
  //   round 2 → 'final'    (terminal; fund_action executes elsewhere)
  // Round 2's atomic transition mirrors disputes.ts /appeal handler.
  const targetState = args.round === 1 ? "resolved" : "final";
  const stateColumn = args.round === 1 ? "resolved_at" : "final_at";
  db.exec("BEGIN");
  try {
    try {
      db.prepare(
        `INSERT INTO relay_dispute_resolutions
           (resolution_id, dispute_id, round, resolution, rationale, fund_action,
            split_ratio, adjudicator, adjudicator_votes, resolved_at, signature, is_appeal)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        resolutionId,
        args.disputeId,
        args.round,
        args.resolution,
        args.rationale,
        args.fund_action,
        args.split_ratio,
        relayIdentity.relayMotebitId,
        JSON.stringify(args.adjudicator_votes),
        args.resolvedAt,
        signed.signature,
        args.round === 2 ? 1 : 0,
      );
    } catch (err) {
      // UNIQUE(dispute_id, round) constraint hit — concurrent writer
      // beat us. Roll back, return persisted: false. Caller treats as
      // success (resolution is canonical from the other writer).
      db.exec("ROLLBACK");
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE") || msg.includes("constraint")) {
        logger.info("dispute.finalize.concurrent_writer_won", {
          disputeId: args.disputeId,
          round: args.round,
        });
        return { persisted: false, signature: signed.signature };
      }
      throw err;
    }
    db.prepare(
      `UPDATE relay_disputes
         SET state = ?, resolution = ?, rationale = ?, fund_action = ?,
             split_ratio = ?, adjudicator = ?, ${stateColumn} = ?
         WHERE dispute_id = ?`,
    ).run(
      targetState,
      args.resolution,
      args.rationale,
      args.fund_action,
      args.split_ratio,
      relayIdentity.relayMotebitId,
      args.resolvedAt,
      args.disputeId,
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { persisted: true, signature: signed.signature };
}
