/**
 * What a dispute's fund action may move, derived from the LEDGER (dispute-v1
 * §7.3: resolution redistributes, never mints).
 *
 * The allocation row's `amount_locked` and `status` say what was once held,
 * not what is still there (a failed receipt refunds the whole hold and still
 * closes the allocation `settled`; a federated origin forwards the gross and
 * never touches the row). So the fund action reads, inside the resolving
 * transaction, what the escrow says is left — `allocation-escrow.ts`, the one
 * reading every payout uses:
 *
 *   escrow held   = `allocationHeld`: the allocation's attributed ledger rows,
 *                   its own settlements' fees, its pending/delivered forwards
 *   paid          = per account, what the allocation's own settlements paid,
 *                   net of the claw-backs already taken from it
 *
 * and a ledger row of a dispute movement already attributed to the allocation
 * is a fund action that already ran, claimed or not — a guard that stops the
 * fund action before either number is read. Every leg it then moves goes
 * through `moveAllocationMoney`.
 */
import type { DatabaseDriver } from "@motebit/persistence";
import {
  allocationDisputeRows,
  allocationHeld,
  allocationHoldPayer,
  allocationPaid,
  allocationReviewReason,
} from "./allocation-escrow.js";

/**
 * Write-once record of the ONE fund action that resolved an allocation.
 * Shared by `createDisputeTables` (fresh database) and the upgrade backfill
 * migration (an existing one).
 */
export const DISPUTE_FUND_ACTIONS_DDL = `
  CREATE TABLE IF NOT EXISTS relay_dispute_fund_actions (
    allocation_id     TEXT PRIMARY KEY,
    task_id           TEXT NOT NULL UNIQUE,
    dispute_id        TEXT NOT NULL UNIQUE,
    fund_action       TEXT NOT NULL,
    split_ratio       REAL NOT NULL,
    regime            TEXT NOT NULL,
    worker_amount     INTEGER NOT NULL,
    delegator_amount  INTEGER NOT NULL,
    executed_at       INTEGER NOT NULL
  );
`;

/**
 * Why a verdict's fund action moved nothing (operator-visible on the dispute
 * row, `relay_disputes.fund_refusal`):
 *   task_mismatch          the dispute's task_id is not its allocation's task
 *                          (a row a relay before the §4.2 binding admitted) —
 *                          no allocation's money is moved on it
 *   no_allocation          the allocation row is gone
 *   unroutable             something is owed but the ledger names no single
 *                          paid account / hold payer / worker to route it
 *   clawback_insufficient  the paid account no longer holds what the verdict
 *                          reverses (it withdrew) — the verdict stays
 *                          `resolved` and retries on every read
 */
export type FundRefusalReason =
  "task_mismatch" | "no_allocation" | "unroutable" | "clawback_insufficient" | "under_review";

/** A fund action that cannot execute as the verdict says: the caller rolls back. */
export class FundActionRefused extends Error {
  constructor(
    readonly reason: FundRefusalReason,
    message: string,
  ) {
    super(message);
    this.name = "FundActionRefused";
  }
}

/** Idempotent: the operator-visible refusal marker column on relay_disputes. */
export function ensureFundRefusalColumn(db: DatabaseDriver): void {
  const cols = db.prepare("PRAGMA table_info(relay_disputes)").all() as Array<{ name: string }>;
  if (cols.length > 0 && !cols.some((c) => c.name === "fund_refusal")) {
    db.exec("ALTER TABLE relay_disputes ADD COLUMN fund_refusal TEXT");
  }
}

/**
 * At most one non-expired dispute per task. A row flagged `task_mismatch`
 * never adjudicated the task it names (its allocation is another one), so it
 * does not hold that task's slot — the allocation that owns the task can
 * still be disputed. Replaces `idx_disputes_one_per_task`, which counted it.
 */
export const ONE_LIVE_DISPUTE_PER_TASK_INDEX = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_disputes_one_per_task_v2
    ON relay_disputes(task_id)
    WHERE state != 'expired' AND COALESCE(fund_refusal, '') != 'task_mismatch';
`;

/**
 * Upgrade step for disputes a pre-claim / pre-binding relay left (C2, F1):
 *
 * 1. Flag every row whose task_id is not its allocation's task
 *    (`fund_refusal = 'task_mismatch'`): a relay before the §4.2 binding
 *    admitted it, and a fund action on it would move one allocation's money
 *    on another's task. It is never claimed, and it stops holding that task's
 *    one-dispute slot.
 * 2. Claim each funded allocation for its earliest well-formed final dispute
 *    (relay_dispute_fund_actions starts empty on upgrade, so an empty table
 *    must not read as "nothing ran"). Amounts are the ledger deltas its rows
 *    show: the hold payer's net, and everyone else's.
 *
 * Idempotent: the flag is set once, the claim is `INSERT OR IGNORE`.
 */
export function backfillDisputeFundActions(db: DatabaseDriver): number {
  ensureFundRefusalColumn(db);
  db.prepare(
    `UPDATE relay_disputes SET fund_refusal = 'task_mismatch'
      WHERE fund_refusal IS NULL
        AND EXISTS (SELECT 1 FROM relay_allocations a
                     WHERE a.allocation_id = relay_disputes.allocation_id
                       AND a.task_id != relay_disputes.task_id)`,
  ).run();
  const holdPayer = `(SELECT h.motebit_id FROM relay_transactions h
                       WHERE h.reference_id = a.allocation_id AND h.type = 'allocation_hold')`;
  return db
    .prepare(
      `INSERT OR IGNORE INTO relay_dispute_fund_actions
         (allocation_id, task_id, dispute_id, fund_action, split_ratio, regime,
          worker_amount, delegator_amount, executed_at)
       SELECT d.allocation_id, a.task_id, d.dispute_id, d.fund_action,
              COALESCE(d.split_ratio, 0), 'legacy_backfill',
              COALESCE((SELECT SUM(t.amount) FROM relay_transactions t
                         WHERE t.reference_id = d.dispute_id
                           AND t.motebit_id NOT IN ${holdPayer}), 0),
              COALESCE((SELECT SUM(t.amount) FROM relay_transactions t
                         WHERE t.reference_id = d.dispute_id
                           AND t.motebit_id IN ${holdPayer}), 0),
              COALESCE(d.final_at, d.resolved_at, d.filed_at)
         FROM relay_disputes d
         JOIN relay_allocations a ON a.allocation_id = d.allocation_id
        WHERE d.state = 'final' AND d.fund_action IS NOT NULL AND d.amount_locked > 0
          AND d.task_id = a.task_id
        ORDER BY COALESCE(d.final_at, d.resolved_at, d.filed_at), d.rowid`,
    )
    .run().changes;
}

export interface AllocationLedgerPosition {
  /** The allocation's own task (relay_allocations.task_id); null when the row is gone. */
  taskId: string | null;
  /** The sole `allocation_hold` payer; null when none or more than one. */
  delegator: string | null;
  /** The allocation's worker (the party filing standing is checked against). */
  worker: string | null;
  /** Escrow still held for this allocation (`allocationHeld`), never negative. */
  escrowRemaining: number;
  /** Accounts this allocation's own settlements paid, net of claw-backs already taken. */
  paid: Array<{ account: string; amount: number }>;
  /** Ledger rows of a dispute movement already attributed to this allocation. */
  priorDisputeRows: number;
  /** A relay settlement row exists (the allocation closed through settlement). */
  settled: boolean;
  /** The operator-review flag (a legacy row the upgrade could not attribute cleanly); null when clear. */
  reviewReason: string | null;
}

/**
 * The ONE reading of an allocation's money, keyed on the allocation; every
 * number comes from `allocation-escrow.ts` (explicit states: rows stamped
 * with the allocation they moved, its own settlements, its non-failed
 * forwards). A dispute row counts for the allocation it MOVED — never for
 * another allocation whose task the dispute names (the removed `OR task_id`
 * read let a legacy dispute on A1 close A2 as "already acted" with A2's
 * escrow still held).
 */
export function allocationLedgerPosition(
  db: DatabaseDriver,
  allocationId: string,
): AllocationLedgerPosition {
  const alloc = db
    .prepare("SELECT motebit_id, task_id FROM relay_allocations WHERE allocation_id = ?")
    .get(allocationId) as { motebit_id: string; task_id: string } | undefined;
  const settled =
    db
      .prepare(
        `SELECT 1 FROM relay_settlements
          WHERE allocation_id = ? AND COALESCE(settlement_mode, 'relay') = 'relay' LIMIT 1`,
      )
      .get(allocationId) !== undefined;
  return {
    taskId: alloc?.task_id ?? null,
    delegator: allocationHoldPayer(db, allocationId),
    worker: alloc?.motebit_id ?? null,
    escrowRemaining: allocationHeld(db, allocationId),
    paid: allocationPaid(db, allocationId),
    priorDisputeRows: allocationDisputeRows(db, allocationId),
    settled,
    reviewReason: allocationReviewReason(db, allocationId),
  };
}

/**
 * What the ledger still holds for an allocation — the one number every refund
 * or release of it (stale sweep, retry-exhaustion refund, settlement surplus,
 * dispute fund action) pays out of. Delegates to `allocationHeld`.
 */
export function allocationEscrowHeld(db: DatabaseDriver, allocationId: string): number {
  return allocationHeld(db, allocationId);
}
