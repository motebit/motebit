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
 * Claim before send (issue #921): `claimForFiring` is the compare-and-set
 * `pending → firing` on each queue row, and a row is handed to the rail only
 * when THIS tick claimed it. A fired payout the rail has not confirmed is
 * recorded as a `processing` relay_withdrawals row (a payout handed to a
 * provider, spec/market-v1.md §10.3) with the rail's declared horizon —
 * never `pending`, which the operator's manual fail would refund while the
 * rail's payout could still land (the double pay #921 closed on /withdraw).
 * It settles only through the operator's reconcile door (budget.ts). A rail
 * that declares itself MANUAL (`payoutMode: "manual"`, Stripe) sends
 * nothing, so its fire is an ordinary `pending` withdrawal (`firedRecordFor`).
 *
 * Failure posture — the money rule: refund ONLY what provably never left.
 *   - Proven not sent (the rail threw `PayoutNotSentError`, or the rail is
 *     MANUAL and its `withdraw()` sends nothing) → the row goes `refund_owed`
 *     and is refunded through the ledger in ONE transaction with its
 *     `refund_owed → refunded` compare-and-set, so a refund happens at most
 *     once. A refund the emergency freeze refuses stays `refund_owed` and is
 *     retried by the first tick after unfreeze.
 *   - Outcome unknown (any other throw, a per-item batch failure — its
 *     reason is telemetry, never a proof —, a send the process died in) →
 *     NO refund. The row goes `unknown` and a `processing` relay_withdrawals
 *     row is recorded with the payout's horizon, so the operator's #921
 *     reconcile door settles it (paid ⇒ completed; not_paid ⇒ refunded once).
 *   - A `firing` row is recovered as outcome-unknown (or refunded, for a
 *     manual rail) only when no send for it can be running: claimed in an
 *     earlier process life, or stale and not in flight in this process.
 *   - Rows parked `failed` by a relay that predates this rule are left for
 *     the operator: some of them may have been paid.
 */

import type { DatabaseDriver } from "@motebit/persistence";
import type {
  BatchableGuestRail,
  WithdrawableGuestRail,
  BatchWithdrawalItem,
  GuestRail,
  WithdrawalResult,
} from "@motebit/sdk";
import { isBatchableRail, isWithdrawableRail } from "@motebit/sdk";
import { shouldBatchSettle, DEFAULT_BATCH_POLICY, type BatchPolicy } from "@motebit/market";
import { fromMicro } from "./accounts.js";
import { computeWithdrawableAvailable } from "@motebit/virtual-accounts";
import { sqliteAccountStoreFor } from "./account-store-sqlite.js";
import { createLogger } from "./logger.js";
import { superviseInterval, type LoopSupervisor } from "./loop-supervisor.js";
import { isManualPayoutRail, isPayoutNotSent, payoutValidityMsOf } from "@motebit/settlement-rails";
import { isEmergencyFrozenAbort } from "./freeze.js";
import { UNDECLARED_PAYOUT_HORIZON_MS } from "./payout-horizon.js";

const logger = createLogger({ service: "batch-withdrawals" });

/** Default loop interval: 10 minutes. */
const DEFAULT_LOOP_INTERVAL_MS = 10 * 60 * 1000;

/**
 * A `firing` row claimed in THIS process life and not in flight here is
 * recovered once it is older than this (an exception escaped between the
 * claim and the outcome's write). Never re-sent.
 */
const STALE_FIRING_MS = 2 * 60 * 1000;

/** When this process started: a `firing` row claimed before it has no send running. */
const PROCESS_STARTED_AT = Date.now();

/** Queue rows whose send is running in this process (claim → outcome written). */
const firingHere = new Set<string>();

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

/**
 * Debit the agent's virtual account and record a pending withdrawal row.
 * Returns the pending_id on success, or null if the debit failed
 * (insufficient balance, dispute hold). Same balance invariants as the
 * pre-aggregation sweep call to `requestWithdrawal`.
 *
 * The debit-before-insert atomicity (Rule 12) is now expressed as a
 * single compound primitive on `AccountStore.debitAndEnqueuePending`
 * (@motebit/virtual-accounts). The dispute-window hold stays at the
 * orchestration layer — it's a policy check, not a ledger invariant.
 */
export function enqueuePendingWithdrawal(db: DatabaseDriver, params: EnqueueParams): string | null {
  const { motebitId, amountMicro, destination, rail, source, idempotencyKey } = params;

  if (amountMicro <= 0) {
    throw new Error(`enqueuePendingWithdrawal: amount must be positive (got ${amountMicro})`);
  }

  // Withdrawal holds — BOTH of them. Aggregation is an exit path like any
  // other, so it subtracts the dispute-window escrow AND the unspent
  // promotional grant (`computeWithdrawableAvailable` is the canonical
  // definition, shared with `requestWithdrawal` and the sweep). Policy-layer
  // check; the compound primitive below enforces only the raw balance
  // invariant. Computed before the atomic write so an insufficient-hold state
  // doesn't even attempt the debit.
  const { balance, disputeHold, grantHold, available } = computeWithdrawableAvailable(
    sqliteAccountStoreFor(db),
    motebitId,
  );
  if (available < amountMicro) {
    logger.info("pending_withdrawal.hold_insufficient", {
      motebitId,
      amountMicro,
      balance,
      disputeHold,
      grantHold,
      available,
    });
    return null;
  }

  const result = sqliteAccountStoreFor(db).debitAndEnqueuePending({
    motebitId,
    amountMicro,
    destination,
    rail,
    source,
    idempotencyKey: idempotencyKey ?? null,
  });
  if (result === null) return null;

  logger.info("pending_withdrawal.enqueued", {
    pendingId: result.pendingId,
    motebitId,
    amountMicro,
    destination,
    rail,
    source,
    balanceAfter: result.newBalance,
  });

  return result.pendingId;
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

/**
 * A rail's failure, classified by the money rule: `not_sent` only on proof
 * that nothing left (a `PayoutNotSentError`, or a MANUAL rail, whose
 * `withdraw()` sends nothing); everything else may have left.
 */
function failureOutcome(rail: object | undefined, err: unknown): "not_sent" | "unknown" {
  if (rail !== undefined && isManualPayoutRail(rail)) return "not_sent";
  return isPayoutNotSent(err) ? "not_sent" : "unknown";
}

/**
 * Refund one `refund_owed` row: the `refund_owed → refunded` compare-and-set
 * and the ledger credit (referenced by the pending_id) commit together or not
 * at all, so of any number of callers exactly one refunds. A freeze refusal
 * rolls both back and leaves the row owed. Returns true when THIS call refunded.
 */
function settleOwedRefund(db: DatabaseDriver, pendingId: string, now: number): boolean {
  try {
    return sqliteAccountStoreFor(db).refundPendingWithdrawal(pendingId, now);
  } catch (err) {
    if (!isEmergencyFrozenAbort(err)) throw err;
    logger.warn("pending_withdrawal.refund_frozen", {
      pendingId,
      note: "the emergency freeze refused the refund; the row stays refund_owed and is refunded after unfreeze",
    });
    return false;
  }
}

/**
 * The payout provably never left: park the row `refund_owed` (FROM `firing`
 * only), then refund it.
 */
function refundNotSent(db: DatabaseDriver, row: PendingRow, reason: string, now: number): void {
  const info = db
    .prepare(
      `UPDATE relay_pending_withdrawals
       SET status = 'refund_owed', last_error = ?, last_attempt_at = ?
       WHERE pending_id = ? AND status = 'firing'`,
    )
    .run(reason, now, row.pending_id);
  if (info.changes === 0) {
    logger.error("pending_withdrawal.outcome_lost", {
      pendingId: row.pending_id,
      outcome: "not_sent",
      note: "the row is no longer firing; its not-sent outcome was not recorded — reconcile by hand",
    });
    return;
  }
  const refunded = settleOwedRefund(db, row.pending_id, now);
  logger.warn("pending_withdrawal.not_sent", {
    pendingId: row.pending_id,
    motebitId: row.motebit_id,
    amountMicro: row.amount_micro,
    refunded,
    reason,
  });
}

/**
 * The payout may have left: never refund. The row goes `unknown` (FROM
 * `firing` only) and, in the same transaction, a `processing` withdrawal is
 * recorded with the payout's horizon — the #921 reconcile door settles it.
 */
function holdUnknown(
  db: DatabaseDriver,
  rail: object | undefined,
  row: PendingRow,
  reason: string,
  now: number,
): void {
  const withdrawalId = db.transaction(() => {
    const info = db
      .prepare(
        `UPDATE relay_pending_withdrawals
         SET status = 'unknown', last_error = ?, last_attempt_at = ?
         WHERE pending_id = ? AND status = 'firing'`,
      )
      .run(reason, now, row.pending_id);
    if (info.changes === 0) return null;
    const id = recordFiredWithdrawal(
      db,
      row,
      {
        status: "processing",
        payoutReference: null,
        payoutValidUntil:
          now + ((rail && payoutValidityMsOf(rail)) ?? UNDECLARED_PAYOUT_HORIZON_MS),
      },
      now,
      `unresolved payout: batched withdrawal ${row.pending_id} failed (${reason}); the transfer may have been submitted — reconcile on chain before completing or failing`,
    );
    db.prepare("UPDATE relay_pending_withdrawals SET withdrawal_id = ? WHERE pending_id = ?").run(
      id,
      row.pending_id,
    );
    return id;
  });
  if (withdrawalId === null) {
    logger.error("pending_withdrawal.outcome_lost", {
      pendingId: row.pending_id,
      outcome: "unknown",
      note: "the row is no longer firing; its unknown outcome was not recorded — reconcile by hand",
    });
    return;
  }
  logger.warn("pending_withdrawal.outcome_unknown", {
    pendingId: row.pending_id,
    motebitId: row.motebit_id,
    amountMicro: row.amount_micro,
    withdrawalId,
    reason,
  });
}

/** Record a failure by the money rule. */
function markFailed(
  db: DatabaseDriver,
  rail: object | undefined,
  row: PendingRow,
  err: unknown,
  now: number,
): void {
  const reason = err instanceof Error ? err.message : String(err);
  if (failureOutcome(rail, err) === "not_sent") refundNotSent(db, row, reason, now);
  else holdUnknown(db, rail, row, reason, now);
}

/**
 * Record a fired payout: the `firing → fired` compare-and-set and its
 * relay_withdrawals row commit together.
 */
function markFired(
  db: DatabaseDriver,
  row: PendingRow,
  fired: FiredRecord,
  now: number,
): string | null {
  const withdrawalId = db.transaction(() => {
    const info = db
      .prepare(
        `UPDATE relay_pending_withdrawals
         SET status = 'fired', last_attempt_at = ?
         WHERE pending_id = ? AND status = 'firing'`,
      )
      .run(now, row.pending_id);
    if (info.changes === 0) return null;
    const id = recordFiredWithdrawal(db, row, fired, now);
    db.prepare("UPDATE relay_pending_withdrawals SET withdrawal_id = ? WHERE pending_id = ?").run(
      id,
      row.pending_id,
    );
    return id;
  });
  if (withdrawalId === null) {
    logger.error("pending_withdrawal.outcome_lost", {
      pendingId: row.pending_id,
      outcome: "fired",
      payoutReference: fired.payoutReference,
      note: "the payout fired but the row is no longer firing; reconcile the ledger against the rail",
    });
  }
  return withdrawalId;
}

/**
 * How a fired payout is recorded (#921):
 *
 *   - `completed` — the rail confirmed it (`confirmedAt > 0`).
 *   - `pending`   — the rail is MANUAL by declaration (`payoutMode: "manual"`,
 *     Stripe): `withdraw()` sent nothing, an operator pays out by hand, so
 *     the ordinary admin /complete and /fail act on it. Its placeholder
 *     reference is not a payout and is not recorded.
 *   - `processing` — sent, outcome unknown: the payout is with the provider
 *     and may still land, so only the operator's reconcile settles it, once
 *     `payout_valid_until` (the rail's declared validity, else the
 *     conservative UNDECLARED_PAYOUT_HORIZON_MS) has passed.
 */
interface FiredRecord {
  status: "completed" | "pending" | "processing";
  payoutReference: string | null;
  payoutValidUntil: number | null;
}

function firedRecordFor(
  rail: WithdrawableGuestRail,
  result: WithdrawalResult,
  now: number,
): FiredRecord {
  const reference = result.proof?.reference ?? null;
  if ((result.proof?.confirmedAt ?? 0) > 0) {
    return { status: "completed", payoutReference: reference, payoutValidUntil: null };
  }
  if (isManualPayoutRail(rail)) {
    return { status: "pending", payoutReference: null, payoutValidUntil: null };
  }
  return {
    status: "processing",
    payoutReference: reference,
    payoutValidUntil: now + (payoutValidityMsOf(rail) ?? UNDECLARED_PAYOUT_HORIZON_MS),
  };
}

/**
 * Insert a relay_withdrawals row for an already-debited, already-FIRED
 * pending item, in the state `firedRecordFor` decided.
 */
function recordFiredWithdrawal(
  db: DatabaseDriver,
  row: PendingRow,
  fired: FiredRecord,
  now: number,
  failureReason: string | null = null,
): string {
  const withdrawalId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO relay_withdrawals
       (withdrawal_id, motebit_id, amount, currency, destination, status,
        idempotency_key, payout_reference, requested_at, completed_at, claimed_at,
        payout_valid_until, failure_reason)
     VALUES (?, ?, ?, 'USD', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    withdrawalId,
    row.motebit_id,
    row.amount_micro,
    row.destination,
    fired.status,
    row.idempotency_key,
    fired.payoutReference,
    row.enqueued_at,
    fired.status === "completed" ? now : null,
    fired.status === "pending" ? null : now,
    fired.payoutValidUntil,
    failureReason,
  );
  return withdrawalId;
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
 *
 * Rails MUST be `WithdrawableGuestRail` to enter the batch worker —
 * `withdraw()` lives only on that marker interface (off-ramp arc, Arc 1
 * Commit 2). The `startBatchWithdrawalLoop` caller filters the rail
 * list through `isWithdrawableRail` before passing rails in; this type
 * tightens the contract so any future caller is forced to do the same.
 */
export async function evaluateAndFireRail(
  db: DatabaseDriver,
  rail: WithdrawableGuestRail,
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

  logger.info("batch.firing", {
    rail: rail.name,
    count: rows.length,
    aggregatedMicro: aggregated,
    mode: isBatchableRail(rail) ? "batch" : "serial",
  });

  if (isBatchableRail(rail)) {
    const claimed = claimForFiring(
      db,
      rows.map((r) => r.pending_id),
      Date.now(),
    );
    if (claimed.length === 0) return;
    for (const row of claimed) firingHere.add(row.pending_id);
    try {
      await fireBatch(db, rail, claimed);
    } finally {
      for (const row of claimed) firingHere.delete(row.pending_id);
    }
  } else {
    // Serial: each row is claimed immediately before its own send, so an
    // emergency freeze that lands during one send refuses the next claim (a
    // guarded write) and every later row stays `pending` for after unfreeze.
    await fireSerial(db, rail, rows, { claimEach: true });
  }
}

async function fireBatch(
  db: DatabaseDriver,
  rail: BatchableGuestRail,
  rows: PendingRow[],
): Promise<void> {
  const items = rows.map((r) => toBatchItem(r));

  // We attribute each per-item batch result back to its pending row by
  // idempotency_key. `toBatchItem` uses the row's CLIENT-SUPPLIED
  // idempotency_key when present (only falling back to a pending_id-derived key
  // when absent), and client keys are not guaranteed unique across motebits — so
  // a batch CAN contain two rows sharing a key. That would collapse them in the
  // lookup map and silently mis-attribute one row's outcome (record the wrong
  // withdrawal, drop the other). Detect the collision and fall back to serial
  // firing, which records each row by pending_id with no key lookup. (Latent
  // today — no rail is batchable yet; this keeps the trap from biting whenever
  // one ships. `BatchableGuestRail` is a `WithdrawableGuestRail`, so it can fire
  // serially.)
  const keys = items.map((i) => i.idempotency_key);
  if (new Set(keys).size !== keys.length) {
    logger.warn("batch.idempotency_key_collision", {
      rail: rail.name,
      count: rows.length,
      reason: "duplicate idempotency_key in batch — firing serially to avoid mis-attribution",
    });
    await fireSerial(db, rail, rows);
    return;
  }

  const byKey = new Map<string, PendingRow>(rows.map((r, i) => [items[i]!.idempotency_key, r]));

  let result;
  try {
    result = await rail.withdrawBatch(items);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const now = Date.now();
    for (const row of rows) markFailed(db, rail, row, err, now);
    logger.error("batch.fire_failed", {
      rail: rail.name,
      count: rows.length,
      outcome: failureOutcome(rail, err),
      error: reason,
    });
    return;
  }

  const now = Date.now();
  const answered = new Set<string>();
  for (const { item, result: perItem } of result.fired) {
    const row = byKey.get(item.idempotency_key);
    if (!row || answered.has(row.pending_id)) continue;
    answered.add(row.pending_id);
    markFired(db, row, firedRecordFor(rail, perItem, now), now);
  }
  for (const { item, reason } of result.failed) {
    const row = byKey.get(item.idempotency_key);
    if (!row || answered.has(row.pending_id)) continue;
    answered.add(row.pending_id);
    // A per-item failure is a telemetry string, never a proof that nothing
    // left — outcome unknown unless the rail is manual.
    markFailed(db, rail, row, new Error(reason), now);
  }
  const unanswered = rows.filter((r) => !answered.has(r.pending_id));
  if (unanswered.length > 0) {
    // Left `firing`: recovered as outcome-unknown once stale (never re-sent).
    logger.error("batch.items_unanswered", {
      rail: rail.name,
      pendingIds: unanswered.map((r) => r.pending_id),
    });
  }
  logger.info("batch.fire_complete", {
    rail: rail.name,
    fired: result.fired.length,
    failed: result.failed.length,
  });
}

async function fireSerial(
  db: DatabaseDriver,
  rail: WithdrawableGuestRail,
  candidates: PendingRow[],
  opts: { claimEach: boolean } = { claimEach: false },
): Promise<void> {
  let fired = 0;
  let failed = 0;
  for (const candidate of candidates) {
    // A refused claim (emergency freeze) throws out of the pass: nothing more
    // is sent, the remaining rows are left as they were.
    const row = opts.claimEach
      ? claimForFiring(db, [candidate.pending_id], Date.now())[0]
      : candidate;
    if (row == null) continue;
    const idempotencyKey = row.idempotency_key ?? `pending-${row.pending_id}`;
    firingHere.add(row.pending_id);
    try {
      let result: WithdrawalResult;
      try {
        // GuestRail.withdraw takes the amount in whole units (dollars/USDC,
        // not micros). The pending ledger stores micros; convert at the
        // boundary. Batch-capable rails take micros directly via
        // BatchWithdrawalItem.amount_micro — this conversion is only for
        // the serial-fallback path.
        result = await rail.withdraw(
          row.motebit_id,
          fromMicro(row.amount_micro),
          "USDC",
          row.destination,
          idempotencyKey,
        );
      } catch (err) {
        markFailed(db, rail, row, err, Date.now());
        failed++;
        logger.warn("batch.serial_item_failed", {
          rail: rail.name,
          pendingId: row.pending_id,
          motebitId: row.motebit_id,
          amountMicro: row.amount_micro,
          outcome: failureOutcome(rail, err),
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      const now = Date.now();
      markFired(db, row, firedRecordFor(rail, result, now), now);
      fired++;
    } finally {
      firingHere.delete(row.pending_id);
    }
  }
  logger.info("batch.fire_complete", { rail: rail.name, mode: "serial", fired, failed });
}

/**
 * Recover `firing` rows no send can still be running for — claimed in an
 * earlier process life, or stale and not in flight here — by the money rule:
 * a manual rail sent nothing (refund); any other may have sent (hold for the
 * #921 reconcile). Never re-sent.
 */
function recoverFiring(
  db: DatabaseDriver,
  rails: ReadonlyArray<GuestRail>,
  now: number,
  processStartedAt: number,
): void {
  const rows = db
    .prepare(
      `SELECT pending_id, motebit_id, amount_micro, destination, rail, source,
              enqueued_at, status, idempotency_key, last_attempt_at
       FROM relay_pending_withdrawals WHERE status = 'firing'`,
    )
    .all() as Array<PendingRow & { last_attempt_at: number | null }>;
  for (const row of rows) {
    const claimedAt = row.last_attempt_at ?? 0;
    const earlierLife = claimedAt < processStartedAt;
    if (!earlierLife && (firingHere.has(row.pending_id) || now - claimedAt < STALE_FIRING_MS)) {
      continue;
    }
    const rail = rails.find((r) => r.name === row.rail);
    logger.warn("batch.firing_recovered", {
      pendingId: row.pending_id,
      motebitId: row.motebit_id,
      rail: row.rail,
      ageMs: now - claimedAt,
      earlierLife,
    });
    markFailed(
      db,
      rail,
      row,
      new Error(
        earlierLife
          ? "the process died while this payout was being sent"
          : "the send's outcome was never recorded",
      ),
      now,
    );
  }
}

/** Refund every `refund_owed` row (a refund the freeze refused, or a crash before it). */
function settleOwedRefunds(db: DatabaseDriver, now: number): void {
  const owed = db
    .prepare("SELECT pending_id FROM relay_pending_withdrawals WHERE status = 'refund_owed'")
    .all() as Array<{ pending_id: string }>;
  for (const { pending_id } of owed) settleOwedRefund(db, pending_id, now);
}

/**
 * One pass of the batch-withdrawal loop: recover `firing` rows no send is
 * running for, refund what is owed, then evaluate and fire each rail.
 * Exported for tests; `opts.processStartedAt` simulates a restart.
 */
export async function runBatchWithdrawalTick(
  db: DatabaseDriver,
  rails: ReadonlyArray<GuestRail>,
  config: BatchWithdrawalConfig,
  opts: { processStartedAt?: number } = {},
): Promise<void> {
  const withdrawableRails = rails.filter(isWithdrawableRail);
  const now = Date.now();
  recoverFiring(db, withdrawableRails, now, opts.processStartedAt ?? PROCESS_STARTED_AT);
  settleOwedRefunds(db, now);
  for (const rail of withdrawableRails) {
    await evaluateAndFireRail(db, rail, config);
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
  supervisor?: LoopSupervisor,
): ReturnType<typeof setInterval> {
  const intervalMs = config.intervalMs ?? DEFAULT_LOOP_INTERVAL_MS;
  // Filter the incoming rail list to only those that opt-in to
  // user-facing withdrawal via `WithdrawableGuestRail`. Bridge
  // (treasury-only) is structurally excluded — `isWithdrawableRail`
  // returns false for it. Any non-withdrawable rail registered for
  // other purposes (treasury, deposit-only) is silently skipped here
  // rather than crashing the batch loop.
  const withdrawableRails = rails.filter(isWithdrawableRail);
  logger.info("batch_withdrawals.started", {
    intervalMs,
    rails: withdrawableRails.map((r) => r.name),
    skipped: rails.length - withdrawableRails.length,
  });

  return superviseInterval(
    supervisor,
    "batch-withdrawal",
    intervalMs,
    async () => {
      try {
        await runBatchWithdrawalTick(db, withdrawableRails, config);
      } catch (err) {
        logger.error("batch_withdrawals.tick_error", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    { isFrozen },
  );
}
