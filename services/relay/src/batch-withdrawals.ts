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
 * Failure posture (#945) — every claimed queue row ends with exactly ONE
 * relay_withdrawals row, the operator's settle door, written in the same
 * transaction as the queue row's terminal status:
 *   - Rail call throws, or a batch reports the item failed → the queue row
 *     becomes `failed` AND a relay_withdrawals row is recorded for it: a
 *     sent-mode rail's payout may have been accepted, so `processing`
 *     (settled only through the operator's reconcile, after the rail's
 *     horizon); a manual rail sent nothing, so `pending` (admin
 *     complete/fail). The balance stays debited either way — the debit is
 *     the audit trail that funds were claimed. Before #945 a throw left the
 *     queue row `failed` with the debit in place and NO withdrawal row, so
 *     no admin door could ever settle it: funds stranded.
 *   - A `firing` row this process is not firing, older than
 *     STALE_FIRING_MS, is one an earlier process claimed and died on — the
 *     rail may have been called. It is recovered the same way (never
 *     re-fired: the side effect may have happened), with the horizon counted
 *     from its fire time. Before #945 such rows were only logged.
 *   - A terminal write that finds the queue row no longer `firing` writes
 *     nothing and is logged at error level (`batch.settle_lost`).
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
import { isManualPayoutRail, payoutValidityMsOf } from "@motebit/settlement-rails";
import { UNDECLARED_PAYOUT_HORIZON_MS } from "./payout-horizon.js";

const logger = createLogger({ service: "batch-withdrawals" });

/** Default loop interval: 10 minutes. */
const DEFAULT_LOOP_INTERVAL_MS = 10 * 60 * 1000;

/**
 * A `firing` row not being fired by this process and older than this was
 * claimed by a process that died mid-fire — recovered to a settle door,
 * never re-fired (#945).
 */
const STALE_FIRING_MS = 2 * 60 * 1000;

/**
 * Queue rows THIS process claimed and has not yet settled — from
 * `claimForFiring` until the fire's outcome is written. Stale-firing
 * recovery never touches them: a slow rail call in this process is not a
 * crash.
 */
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
    firingHere.add(id);
    const row = select.get(id) as PendingRow | undefined;
    if (row) claimed.push(row);
  }
  return claimed;
}

/** Compare-and-set `firing → fired`, linking the settle door. True when this call moved it. */
function markFired(
  db: DatabaseDriver,
  pendingId: string,
  withdrawalId: string,
  now: number,
): boolean {
  const info = db
    .prepare(
      `UPDATE relay_pending_withdrawals
       SET status = 'fired', withdrawal_id = ?, last_attempt_at = ?
       WHERE pending_id = ? AND status = 'firing'`,
    )
    .run(withdrawalId, now, pendingId);
  return info.changes > 0;
}

/**
 * Compare-and-set `firing → failed`, linking the settle door the failure
 * was parked under (#945). True when this call moved it.
 */
function markFailed(
  db: DatabaseDriver,
  pendingId: string,
  withdrawalId: string,
  reason: string,
  now: number,
): boolean {
  const info = db
    .prepare(
      `UPDATE relay_pending_withdrawals
       SET status = 'failed', withdrawal_id = ?, last_error = ?, last_attempt_at = ?
       WHERE pending_id = ? AND status = 'firing'`,
    )
    .run(withdrawalId, reason, now, pendingId);
  return info.changes > 0;
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
  /** When the rail was (or may have been) handed the payout — the claim time. */
  firedAt: number;
  /** Why the outcome is unresolved (a throw, a crash), for the operator. */
  failureReason: string | null;
}

function firedRecordFor(
  rail: WithdrawableGuestRail,
  result: WithdrawalResult,
  now: number,
): FiredRecord {
  const reference = result.proof?.reference ?? null;
  if ((result.proof?.confirmedAt ?? 0) > 0) {
    return {
      status: "completed",
      payoutReference: reference,
      payoutValidUntil: null,
      firedAt: now,
      failureReason: null,
    };
  }
  if (isManualPayoutRail(rail)) {
    return {
      status: "pending",
      payoutReference: null,
      payoutValidUntil: null,
      firedAt: now,
      failureReason: null,
    };
  }
  return {
    status: "processing",
    payoutReference: reference,
    payoutValidUntil: now + (payoutValidityMsOf(rail) ?? UNDECLARED_PAYOUT_HORIZON_MS),
    firedAt: now,
    failureReason: null,
  };
}

/**
 * How a fire whose outcome is unknown is recorded (#945): the rail threw,
 * a batch reported the item failed, or the process died mid-fire. A manual
 * rail sent nothing ⇒ `pending`. Anything else may have been accepted by
 * the provider ⇒ `processing`, with the rail's horizon counted from the
 * fire (a rail this relay no longer has registered is treated as
 * sent-with-no-declared-horizon — the conservative floor).
 */
function unresolvedRecordFor(
  rail: WithdrawableGuestRail | null,
  reason: string,
  firedAt: number,
): FiredRecord {
  if (rail !== null && isManualPayoutRail(rail)) {
    return {
      status: "pending",
      payoutReference: null,
      payoutValidUntil: null,
      firedAt,
      failureReason: `batch fire failed before any payout (manual rail): ${reason}`,
    };
  }
  return {
    status: "processing",
    payoutReference: null,
    payoutValidUntil:
      firedAt + ((rail !== null ? payoutValidityMsOf(rail) : null) ?? UNDECLARED_PAYOUT_HORIZON_MS),
    firedAt,
    failureReason: `unresolved payout: batch fire outcome unknown (${reason}); the provider may have accepted it — reconcile against the provider before completing or failing`,
  };
}

/**
 * Insert a relay_withdrawals row for an already-debited, already-claimed
 * pending item, in the state `firedRecordFor` / `unresolvedRecordFor`
 * decided.
 */
function recordFiredWithdrawal(
  db: DatabaseDriver,
  withdrawalId: string,
  row: PendingRow,
  fired: FiredRecord,
  now: number,
): void {
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
    fired.status === "pending" ? null : fired.firedAt,
    fired.payoutValidUntil,
    fired.failureReason,
  );
}

/**
 * Write a claimed queue row's outcome and its settle door in ONE
 * transaction (#945): the queue row's CAS `firing → fired|failed` and the
 * relay_withdrawals row it links. A CAS that loses (the row is no longer
 * `firing`) writes nothing and is logged — never a second door.
 */
function settleFire(
  db: DatabaseDriver,
  row: PendingRow,
  record: FiredRecord,
  queueOutcome: { kind: "fired" } | { kind: "failed"; reason: string },
  now: number,
): string | null {
  const withdrawalId = crypto.randomUUID();
  const written = db.transaction(() => {
    const moved =
      queueOutcome.kind === "fired"
        ? markFired(db, row.pending_id, withdrawalId, now)
        : markFailed(db, row.pending_id, withdrawalId, queueOutcome.reason, now);
    if (!moved) return false;
    recordFiredWithdrawal(db, withdrawalId, row, record, now);
    return true;
  });
  firingHere.delete(row.pending_id);
  if (!written) {
    logger.error("batch.settle_lost", {
      pendingId: row.pending_id,
      motebitId: row.motebit_id,
      outcome: queueOutcome.kind,
      recorded: record.status,
      note: "the queue row is no longer `firing`; no withdrawal row was written for this outcome",
    });
    return null;
  }
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

  try {
    if (isBatchableRail(rail)) {
      await fireBatch(db, rail, claimed);
    } else {
      await fireSerial(db, rail, claimed);
    }
  } finally {
    // A row the fire left unsettled (a batch that did not report it) is no
    // longer being fired here: the next tick recovers it (#945).
    for (const row of claimed) firingHere.delete(row.pending_id);
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
    // Outcome unknown for every item: each gets its settle door (#945).
    const reason = err instanceof Error ? err.message : String(err);
    const now = Date.now();
    for (const row of rows) {
      settleFire(db, row, unresolvedRecordFor(rail, reason, now), { kind: "failed", reason }, now);
    }
    logger.error("batch.fire_failed", { rail: rail.name, count: rows.length, error: reason });
    return;
  }

  const now = Date.now();
  for (const { item, result: perItem } of result.fired) {
    const row = byKey.get(item.idempotency_key);
    if (!row) continue;
    settleFire(db, row, firedRecordFor(rail, perItem, now), { kind: "fired" }, now);
  }
  for (const { item, reason } of result.failed) {
    const row = byKey.get(item.idempotency_key);
    if (!row) continue;
    // A per-item failure a sent-mode rail reports is not proof nothing was
    // accepted; it is parked on the same door as a throw (#945).
    settleFire(db, row, unresolvedRecordFor(rail, reason, now), { kind: "failed", reason }, now);
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
  rows: PendingRow[],
): Promise<void> {
  let fired = 0;
  let failed = 0;
  for (const row of rows) {
    const idempotencyKey = row.idempotency_key ?? `pending-${row.pending_id}`;
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
      // Outcome unknown: the provider may have accepted it before failing.
      // Parked on a settle door, never re-fired (#945).
      const reason = err instanceof Error ? err.message : String(err);
      const now = Date.now();
      settleFire(db, row, unresolvedRecordFor(rail, reason, now), { kind: "failed", reason }, now);
      failed++;
      logger.warn("batch.serial_item_failed", {
        rail: rail.name,
        pendingId: row.pending_id,
        motebitId: row.motebit_id,
        amountMicro: row.amount_micro,
        error: reason,
      });
      continue;
    }
    const now = Date.now();
    settleFire(db, row, firedRecordFor(rail, result, now), { kind: "fired" }, now);
    fired++;
  }
  logger.info("batch.fire_complete", { rail: rail.name, mode: "serial", fired, failed });
}

/**
 * Recover `firing` rows an earlier process claimed and died on (#945): a
 * row not being fired here and older than STALE_FIRING_MS. The rail may
 * have been called, so the row is never re-fired: it is parked on a settle
 * door — `processing` for a sent-mode (or no longer registered) rail,
 * `pending` for a manual one — with the horizon counted from NOW (every
 * call the dead process made happened before this moment).
 */
export function recoverStaleFiring(
  db: DatabaseDriver,
  rails: ReadonlyArray<WithdrawableGuestRail>,
): number {
  const now = Date.now();
  const stale = db
    .prepare(
      `SELECT pending_id, motebit_id, amount_micro, destination, rail, source,
              enqueued_at, status, idempotency_key, last_attempt_at
       FROM relay_pending_withdrawals
       WHERE status = 'firing' AND (last_attempt_at IS NULL OR last_attempt_at < ?)`,
    )
    .all(now - STALE_FIRING_MS) as Array<PendingRow & { last_attempt_at: number | null }>;
  let recovered = 0;
  for (const row of stale) {
    if (firingHere.has(row.pending_id)) continue;
    const rail = rails.find((r) => r.name === row.rail) ?? null;
    const reason = "the process firing this payout ended before recording its outcome";
    const withdrawalId = settleFire(
      db,
      row,
      unresolvedRecordFor(rail, reason, now),
      { kind: "failed", reason },
      now,
    );
    if (withdrawalId !== null) recovered++;
    logger.warn("batch.stale_firing_recovered", {
      pendingId: row.pending_id,
      motebitId: row.motebit_id,
      rail: row.rail,
      railRegistered: rail !== null,
      ageMs: row.last_attempt_at != null ? now - row.last_attempt_at : null,
      withdrawalId,
    });
  }
  return recovered;
}

/**
 * One tick of the batch-withdrawal loop: recover crashed fires, then
 * evaluate and fire each withdrawable rail. Exported for tests; the
 * production caller is `startBatchWithdrawalLoop`.
 */
export async function runBatchWithdrawalTick(
  db: DatabaseDriver,
  rails: ReadonlyArray<GuestRail>,
  config: BatchWithdrawalConfig,
): Promise<void> {
  const withdrawableRails = rails.filter(isWithdrawableRail);
  recoverStaleFiring(db, withdrawableRails);
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
        // Log, then rethrow so the supervisor records the failed tick
        // (services/relay/CLAUDE.md rule 19).
        logger.error("batch_withdrawals.tick_error", {
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
    { isFrozen },
  );
}
