/**
 * What a dispute's fund action may move, derived from the LEDGER (dispute-v1
 * §7.3: resolution redistributes, never mints).
 *
 * The allocation row's `amount_locked` and `status` say what was once held,
 * not what is still there: a failed receipt refunds the whole hold and still
 * closes the allocation `settled`; a federated origin forwards the gross to
 * the executing peer and never touches the row; a dispute on a relay without
 * the claim table paid out and left the allocation `disputed`. Every one of
 * those, read from the row, paid the escrow a second time. So the fund action
 * reads, inside the resolving transaction, what the ledger says is left:
 *
 *   escrow held   = allocation_hold debits − allocation_release credits
 *                   (`getAllocationHoldRemaining`, the settlement path's own
 *                   reading)
 *                 − what relay settlements of this allocation consumed
 *                   (the worker credits under their settlement ids, plus the
 *                   platform fee, which leaves escrow with no ledger row)
 *                 − gross a federated origin forwarded to the executing peer
 *                 − the net of every row referenced to a dispute of this
 *                   allocation
 *   paid          = per account, the settlement credits it received for this
 *                   allocation, net of dispute rows on that account
 *
 * and any ledger row already referenced to a dispute of the allocation is a
 * fund action that already ran, claimed or not.
 */
import type { DatabaseDriver } from "@motebit/persistence";
import { getAllocationHoldRemaining } from "./accounts.js";

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
 * Claim rows for disputes a relay without the claim table already finalized
 * (C2: the table starts empty on upgrade, so an empty table must not read as
 * "nothing ran"). The earliest final dispute of each funded allocation owns
 * the claim; amounts are what its ledger rows moved. Idempotent: `INSERT OR
 * IGNORE` on the allocation / task / dispute keys.
 */
export function backfillDisputeFundActions(db: DatabaseDriver): number {
  return db
    .prepare(
      `INSERT OR IGNORE INTO relay_dispute_fund_actions
         (allocation_id, task_id, dispute_id, fund_action, split_ratio, regime,
          worker_amount, delegator_amount, executed_at)
       SELECT d.allocation_id, d.task_id, d.dispute_id, d.fund_action,
              COALESCE(d.split_ratio, 0), 'legacy_backfill',
              COALESCE((SELECT SUM(t.amount) FROM relay_transactions t
                         WHERE t.reference_id = d.dispute_id AND t.amount > 0
                           AND t.motebit_id = a.motebit_id), 0),
              COALESCE((SELECT SUM(t.amount) FROM relay_transactions t
                         WHERE t.reference_id = d.dispute_id AND t.amount > 0
                           AND t.motebit_id != a.motebit_id), 0),
              COALESCE(d.final_at, d.resolved_at, d.filed_at)
         FROM relay_disputes d
         JOIN relay_allocations a ON a.allocation_id = d.allocation_id
        WHERE d.state = 'final' AND d.fund_action IS NOT NULL AND d.amount_locked > 0
        ORDER BY COALESCE(d.final_at, d.resolved_at, d.filed_at), d.rowid`,
    )
    .run().changes;
}

export interface AllocationLedgerPosition {
  /** The sole `allocation_hold` payer; null when none or more than one. */
  delegator: string | null;
  /** The allocation's worker (the party filing standing is checked against). */
  worker: string | null;
  /** Escrow still held for this allocation, never negative. */
  escrowRemaining: number;
  /** Accounts holding settlement credits for this allocation, net of disputes. */
  paid: Array<{ account: string; amount: number }>;
  /** Ledger rows already referenced to a dispute of this allocation. */
  priorDisputeRows: number;
  /** A relay settlement row exists (the allocation closed through settlement). */
  settled: boolean;
}

export function allocationLedgerPosition(
  db: DatabaseDriver,
  allocationId: string,
  taskId: string,
): AllocationLedgerPosition {
  const alloc = db
    .prepare("SELECT motebit_id FROM relay_allocations WHERE allocation_id = ?")
    .get(allocationId) as { motebit_id: string } | undefined;
  const payers = db
    .prepare(
      "SELECT DISTINCT motebit_id FROM relay_transactions WHERE reference_id = ? AND type = 'allocation_hold' LIMIT 2",
    )
    .all(allocationId) as Array<{ motebit_id: string }>;

  const settlements = db
    .prepare(
      `SELECT settlement_id, platform_fee FROM relay_settlements
        WHERE (allocation_id = ? OR task_id = ?)
          AND COALESCE(settlement_mode, 'relay') = 'relay'`,
    )
    .all(allocationId, taskId) as Array<{ settlement_id: string; platform_fee: number }>;
  const fees = settlements.reduce((s, r) => s + (r.platform_fee || 0), 0);

  const paidRows = db
    .prepare(
      `SELECT motebit_id, SUM(amount) AS amount FROM relay_transactions
        WHERE type = 'settlement_credit' AND reference_id IN (
          SELECT settlement_id FROM relay_settlements
           WHERE (allocation_id = ? OR task_id = ?)
             AND COALESCE(settlement_mode, 'relay') = 'relay')
        GROUP BY motebit_id`,
    )
    .all(allocationId, taskId) as Array<{ motebit_id: string; amount: number }>;
  const settlementCredits = paidRows.reduce((s, r) => s + r.amount, 0);

  const forwarded = (
    db
      .prepare(
        "SELECT COALESCE(SUM(gross_amount), 0) AS g FROM relay_federation_settlements WHERE task_id = ?",
      )
      .get(taskId) as { g: number }
  ).g;

  const disputeRows = db
    .prepare(
      `SELECT motebit_id, amount FROM relay_transactions
        WHERE reference_id IN (
          SELECT dispute_id FROM relay_disputes WHERE allocation_id = ? OR task_id = ?)`,
    )
    .all(allocationId, taskId) as Array<{ motebit_id: string; amount: number }>;
  const disputeNet = disputeRows.reduce((s, r) => s + r.amount, 0);

  const held = getAllocationHoldRemaining(db, allocationId);
  const escrowRemaining = Math.max(0, held - settlementCredits - fees - forwarded - disputeNet);

  const paid = paidRows
    .map((r) => ({
      account: r.motebit_id,
      amount:
        r.amount +
        disputeRows.filter((d) => d.motebit_id === r.motebit_id).reduce((s, d) => s + d.amount, 0),
    }))
    .filter((p) => p.amount > 0);

  return {
    delegator: payers.length === 1 ? payers[0]!.motebit_id : null,
    worker: alloc?.motebit_id ?? null,
    escrowRemaining,
    paid,
    priorDisputeRows: disputeRows.length,
    settled: settlements.length > 0,
  };
}
