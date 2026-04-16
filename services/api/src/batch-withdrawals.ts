/**
 * Aggregated withdrawal execution — spec/settlement-v1.md §11.2.
 *
 * The sweep enqueues eligible withdrawals into `relay_pending_withdrawals`
 * instead of firing them one at a time. This module runs the loop that
 * groups pending rows by rail, applies `shouldBatchSettle` per-rail, and
 * fires — via `rail.withdrawBatch` when the rail implements the native
 * primitive, or serially through `rail.withdraw` otherwise. The serial
 * fallback still wins: fewer fires per hour, amortized per-fire overhead,
 * no dust submissions.
 *
 * Debit-at-enqueue invariant: the agent's virtual account is debited at
 * the moment the sweep claims balance for an outgoing withdrawal. The
 * fire path does NOT re-debit — it only calls the rail and records the
 * relay_withdrawals row that tracks the rail's async completion.
 *
 * Failure posture:
 *   - Rail call throws → pending row becomes `failed`, balance stays
 *     debited, operator resolves via admin endpoint. The debit is the
 *     audit trail that funds were claimed for this sweep.
 *   - Stale `firing` rows (no terminal state after STALE_FIRING_MS) are
 *     logged but NOT automatically retried; the rail side-effect may
 *     have partially completed.
 */

import type { DatabaseDriver } from "@motebit/persistence";
import type {
  BatchableGuestRail,
  BatchWithdrawalItem,
  GuestRail,
  WithdrawalResult,
} from "@motebit/sdk";
import { isBatchableRail } from "@motebit/sdk";
import { shouldBatchSettle, DEFAULT_BATCH_POLICY, type BatchPolicy } from "@motebit/market";
import {
  debitAccount,
  computeDisputeWindowHold,
  getOrCreateAccount,
  fromMicro,
} from "./accounts.js";
import { createLogger } from "./logger.js";

const logger = createLogger({ service: "batch-withdrawals" });

/** Default loop interval: 10 minutes. */
const DEFAULT_LOOP_INTERVAL_MS = 10 * 60 * 1000;

/** Stale `firing` rows older than this are anomalies — logged, not retried. */
const STALE_FIRING_MS = 2 * 60 * 1000;

export interface BatchWithdrawalConfig {
  /** How often to evaluate pending queues (ms). Default: 600_000. */
  intervalMs?: number;
  /** Per-rail fee estimate in micro-units. Key by rail.name. */
  railFeeEstimates?: Readonly<Record<string, number>>;
  /** Override the batch policy (defaults to DEFAULT_BATCH_POLICY from @motebit/market). */
  policy?: BatchPolicy;
  /** Per-rail policy overrides — merged over `policy`. Key by rail.name. */
  railPolicyOverrides?: Readonly<Record<string, Partial<BatchPolicy>>>;
}

export interface EnqueueParams {
  motebitId: string;
  amountMicro: number;
  destination: string;
  rail: string;
  source: "sweep" | "user";
  /** Optional — the caller may provide a stable key for external idempotency. */
  idempotencyKey?: string;
}

interface PendingRow {
  pending_id: string;
  motebit_id: string;
  amount_micro: number;
  destination: string;
  rail: string;
  source: string;
  enqueued_at: number;
  status: string;
  idempotency_key: string | null;
}

const INSERT_PENDING = `
  INSERT INTO relay_pending_withdrawals (
    pending_id, motebit_id, amount_micro, destination, rail, source,
    enqueued_at, status, idempotency_key
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
`;

/**
 * Debit the agent's virtual account and record a pending withdrawal row.
 * Returns the pending_id on success, or null if the debit failed
 * (insufficient balance, dispute hold). Same balance invariants as the
 * pre-aggregation sweep call to `requestWithdrawal`.
 */
export function enqueuePendingWithdrawal(db: DatabaseDriver, params: EnqueueParams): string | null {
  const { motebitId, amountMicro, destination, rail, source, idempotencyKey } = params;

  if (amountMicro <= 0) {
    throw new Error(`enqueuePendingWithdrawal: amount must be positive (got ${amountMicro})`);
  }

  // Dispute hold — funds from recent relay settlements are not sweepable.
  const account = getOrCreateAccount(db, motebitId);
  const disputeHold = computeDisputeWindowHold(db, motebitId);
  if (account.balance - disputeHold < amountMicro) {
    logger.info("pending_withdrawal.dispute_hold", {
      motebitId,
      amountMicro,
      balance: account.balance,
      disputeHold,
    });
    return null;
  }

  const pendingId = crypto.randomUUID();
  const newBalance = debitAccount(
    db,
    motebitId,
    amountMicro,
    "withdrawal",
    pendingId,
    `Pending withdrawal ${pendingId} → ${destination} via ${rail}`,
  );
  if (newBalance === null) return null;

  db.prepare(INSERT_PENDING).run(
    pendingId,
    motebitId,
    amountMicro,
    destination,
    rail,
    source,
    Date.now(),
    idempotencyKey ?? null,
  );

  logger.info("pending_withdrawal.enqueued", {
    pendingId,
    motebitId,
    amountMicro,
    destination,
    rail,
    source,
    balanceAfter: newBalance,
  });

  return pendingId;
}

/** Aggregated summary used by the admin endpoint. */
export interface RailSummary {
  rail: string;
  count: number;
  aggregated_micro: number;
  oldest_age_ms: number;
}

export function getPendingWithdrawalsSummary(db: DatabaseDriver): {
  by_rail: RailSummary[];
  total: number;
} {
  const now = Date.now();
  const rows = db
    .prepare(
      `SELECT rail, COUNT(*) AS count, SUM(amount_micro) AS aggregated_micro,
              MIN(enqueued_at) AS oldest_enqueued_at
       FROM relay_pending_withdrawals
       WHERE status = 'pending'
       GROUP BY rail`,
    )
    .all() as Array<{
    rail: string;
    count: number;
    aggregated_micro: number;
    oldest_enqueued_at: number;
  }>;

  const by_rail = rows.map((r) => ({
    rail: r.rail,
    count: r.count,
    aggregated_micro: r.aggregated_micro,
    oldest_age_ms: now - r.oldest_enqueued_at,
  }));

  const total = by_rail.reduce((sum, r) => sum + r.count, 0);
  return { by_rail, total };
}

function resolvePolicy(config: BatchWithdrawalConfig, railName: string): BatchPolicy {
  const base = config.policy ?? DEFAULT_BATCH_POLICY;
  const override = config.railPolicyOverrides?.[railName];
  return override ? { ...base, ...override } : base;
}

function resolveFeeEstimate(config: BatchWithdrawalConfig, railName: string): number {
  return config.railFeeEstimates?.[railName] ?? 0;
}

/**
 * Transition pending rows to `firing`, returning the rows that were
 * successfully claimed for this fire. Atomic per-row: any row that was
 * already moved by a concurrent tick is skipped.
 */
function claimForFiring(db: DatabaseDriver, pendingIds: string[], now: number): PendingRow[] {
  const claimed: PendingRow[] = [];
  const update = db.prepare(
    `UPDATE relay_pending_withdrawals
     SET status = 'firing', last_attempt_at = ?
     WHERE pending_id = ? AND status = 'pending'`,
  );
  const select = db.prepare(
    `SELECT pending_id, motebit_id, amount_micro, destination, rail, source,
            enqueued_at, status, idempotency_key
     FROM relay_pending_withdrawals WHERE pending_id = ?`,
  );
  for (const id of pendingIds) {
    const info = update.run(now, id);
    if (info.changes === 0) continue;
    const row = select.get(id) as PendingRow | undefined;
    if (row) claimed.push(row);
  }
  return claimed;
}

function markFired(db: DatabaseDriver, pendingId: string, withdrawalId: string, now: number): void {
  db.prepare(
    `UPDATE relay_pending_withdrawals
     SET status = 'fired', withdrawal_id = ?, last_attempt_at = ?
     WHERE pending_id = ?`,
  ).run(withdrawalId, now, pendingId);
}

function markFailed(db: DatabaseDriver, pendingId: string, reason: string, now: number): void {
  db.prepare(
    `UPDATE relay_pending_withdrawals
     SET status = 'failed', last_error = ?, last_attempt_at = ?
     WHERE pending_id = ?`,
  ).run(reason, now, pendingId);
}

/**
 * Insert a relay_withdrawals row for an already-debited pending item.
 * The rail's async completion (webhook, poll) updates this row's status
 * later via the existing `completeWithdrawal` / `failWithdrawal` flow.
 */
function recordFiredWithdrawal(
  db: DatabaseDriver,
  row: PendingRow,
  payoutReference: string | null,
  railStatus: "pending" | "completed",
  now: number,
): string {
  const withdrawalId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO relay_withdrawals
       (withdrawal_id, motebit_id, amount, currency, destination, status,
        idempotency_key, payout_reference, requested_at, completed_at)
     VALUES (?, ?, ?, 'USD', ?, ?, ?, ?, ?, ?)`,
  ).run(
    withdrawalId,
    row.motebit_id,
    row.amount_micro,
    row.destination,
    railStatus,
    row.idempotency_key,
    payoutReference,
    row.enqueued_at,
    railStatus === "completed" ? now : null,
  );
  return withdrawalId;
}

function railStatusFromResult(result: WithdrawalResult): "pending" | "completed" {
  // confirmedAt === 0 means the rail returned a pending result
  // (Stripe manual, Bridge async). Non-zero means it settled.
  return (result.proof?.confirmedAt ?? 0) > 0 ? "completed" : "pending";
}

function toBatchItem(row: PendingRow): BatchWithdrawalItem {
  return {
    motebit_id: row.motebit_id,
    amount_micro: row.amount_micro,
    currency: "USDC",
    destination: row.destination,
    idempotency_key: row.idempotency_key ?? `pending-${row.pending_id}`,
  };
}

/**
 * Evaluate one rail's pending queue and fire if the policy clears.
 * Exported for tests; the production caller is `startBatchWithdrawalLoop`.
 */
export async function evaluateAndFireRail(
  db: DatabaseDriver,
  rail: GuestRail,
  config: BatchWithdrawalConfig,
): Promise<void> {
  const rows = db
    .prepare(
      `SELECT pending_id, motebit_id, amount_micro, destination, rail, source,
              enqueued_at, status, idempotency_key
       FROM relay_pending_withdrawals
       WHERE rail = ? AND status = 'pending'
       ORDER BY enqueued_at ASC`,
    )
    .all(rail.name) as PendingRow[];

  if (rows.length === 0) return;

  const aggregated = rows.reduce((sum, r) => sum + r.amount_micro, 0);
  const oldestAge = Date.now() - rows[0]!.enqueued_at;
  const feeEstimate = resolveFeeEstimate(config, rail.name);
  const policy = resolvePolicy(config, rail.name);

  if (!shouldBatchSettle(aggregated, feeEstimate, oldestAge, policy)) {
    logger.debug("batch.policy.not_firing", {
      rail: rail.name,
      count: rows.length,
      aggregatedMicro: aggregated,
      oldestAgeMs: oldestAge,
      feeEstimateMicro: feeEstimate,
    });
    return;
  }

  const now = Date.now();
  const claimed = claimForFiring(
    db,
    rows.map((r) => r.pending_id),
    now,
  );
  if (claimed.length === 0) return;

  logger.info("batch.firing", {
    rail: rail.name,
    count: claimed.length,
    aggregatedMicro: claimed.reduce((sum, r) => sum + r.amount_micro, 0),
    mode: isBatchableRail(rail) ? "batch" : "serial",
  });

  if (isBatchableRail(rail)) {
    await fireBatch(db, rail, claimed);
  } else {
    await fireSerial(db, rail, claimed);
  }
}

async function fireBatch(
  db: DatabaseDriver,
  rail: BatchableGuestRail,
  rows: PendingRow[],
): Promise<void> {
  // Map idempotency_key → row for O(1) lookup of per-item outcomes.
  // toBatchItem mints the idempotency_key deterministically from
  // pending_id, so the key is unique per row by construction.
  const items = rows.map((r) => toBatchItem(r));
  const byKey = new Map<string, PendingRow>(rows.map((r, i) => [items[i]!.idempotency_key, r]));

  let result;
  try {
    result = await rail.withdrawBatch(items);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const now = Date.now();
    for (const row of rows) markFailed(db, row.pending_id, reason, now);
    logger.error("batch.fire_failed", { rail: rail.name, count: rows.length, error: reason });
    return;
  }

  const now = Date.now();
  for (const { item, result: perItem } of result.fired) {
    const row = byKey.get(item.idempotency_key);
    if (!row) continue;
    const withdrawalId = recordFiredWithdrawal(
      db,
      row,
      perItem.proof?.reference ?? null,
      railStatusFromResult(perItem),
      now,
    );
    markFired(db, row.pending_id, withdrawalId, now);
  }
  for (const { item, reason } of result.failed) {
    const row = byKey.get(item.idempotency_key);
    if (!row) continue;
    markFailed(db, row.pending_id, reason, now);
  }
  logger.info("batch.fire_complete", {
    rail: rail.name,
    fired: result.fired.length,
    failed: result.failed.length,
  });
}

async function fireSerial(db: DatabaseDriver, rail: GuestRail, rows: PendingRow[]): Promise<void> {
  let fired = 0;
  let failed = 0;
  for (const row of rows) {
    const idempotencyKey = row.idempotency_key ?? `pending-${row.pending_id}`;
    try {
      // GuestRail.withdraw takes the amount in whole units (dollars/USDC,
      // not micros). The pending ledger stores micros; convert at the
      // boundary. Batch-capable rails take micros directly via
      // BatchWithdrawalItem.amount_micro — this conversion is only for
      // the serial-fallback path.
      const result = await rail.withdraw(
        row.motebit_id,
        fromMicro(row.amount_micro),
        "USDC",
        row.destination,
        idempotencyKey,
      );
      const now = Date.now();
      const withdrawalId = recordFiredWithdrawal(
        db,
        row,
        result.proof?.reference ?? null,
        railStatusFromResult(result),
        now,
      );
      markFired(db, row.pending_id, withdrawalId, now);
      fired++;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      markFailed(db, row.pending_id, reason, Date.now());
      failed++;
      logger.warn("batch.serial_item_failed", {
        rail: rail.name,
        pendingId: row.pending_id,
        motebitId: row.motebit_id,
        amountMicro: row.amount_micro,
        error: reason,
      });
    }
  }
  logger.info("batch.fire_complete", { rail: rail.name, mode: "serial", fired, failed });
}

/** Log any `firing` rows that have exceeded STALE_FIRING_MS. */
function logStaleFiring(db: DatabaseDriver): void {
  const cutoff = Date.now() - STALE_FIRING_MS;
  const stale = db
    .prepare(
      `SELECT pending_id, motebit_id, rail, last_attempt_at FROM relay_pending_withdrawals
       WHERE status = 'firing' AND last_attempt_at IS NOT NULL AND last_attempt_at < ?`,
    )
    .all(cutoff) as Array<{
    pending_id: string;
    motebit_id: string;
    rail: string;
    last_attempt_at: number;
  }>;
  for (const row of stale) {
    logger.warn("batch.stale_firing", {
      pendingId: row.pending_id,
      motebitId: row.motebit_id,
      rail: row.rail,
      ageMs: Date.now() - row.last_attempt_at,
    });
  }
}

/**
 * Start the batch-withdrawal background loop.
 * On each tick: iterate each registered rail, evaluate its pending
 * queue against the policy, and fire if threshold clears.
 */
export function startBatchWithdrawalLoop(
  db: DatabaseDriver,
  rails: ReadonlyArray<GuestRail>,
  config: BatchWithdrawalConfig = {},
  isFrozen?: () => boolean,
): ReturnType<typeof setInterval> {
  const intervalMs = config.intervalMs ?? DEFAULT_LOOP_INTERVAL_MS;
  logger.info("batch_withdrawals.started", { intervalMs, rails: rails.map((r) => r.name) });

  return setInterval(() => {
    if (isFrozen?.()) return;
    void (async () => {
      try {
        logStaleFiring(db);
        for (const rail of rails) {
          await evaluateAndFireRail(db, rail, config);
        }
      } catch (err) {
        logger.error("batch_withdrawals.tick_error", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }, intervalMs);
}
