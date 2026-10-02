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
 *   paid          = per account, the settlement credits it received for this
 *                   allocation
 *
 * and any ledger row already referenced to a dispute of the allocation is a
 * fund action that already ran, claimed or not — a guard that stops the fund
 * action before either number is read, never a term subtracted from them.
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
  "task_mismatch" | "no_allocation" | "unroutable" | "clawback_insufficient";

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
  /** Escrow still held for this allocation, never negative; 0 once a dispute of its own moved money. */
  escrowRemaining: number;
  /** Accounts holding settlement credits for this allocation; empty once a dispute naming it moved money. */
  paid: Array<{ account: string; amount: number }>;
  /** Ledger rows already referenced to a dispute of this allocation. */
  priorDisputeRows: number;
  /** A relay settlement row exists (the allocation closed through settlement). */
  settled: boolean;
}

/**
 * The ONE reading of an allocation's money. Keyed on the allocation; its task
 * comes from relay_allocations, never from a dispute row (F1: a legacy row
 * naming another allocation's task pointed the fund action at that
 * allocation's settlement).
 */
export function allocationLedgerPosition(
  db: DatabaseDriver,
  allocationId: string,
): AllocationLedgerPosition {
  const alloc = db
    .prepare("SELECT motebit_id, task_id FROM relay_allocations WHERE allocation_id = ?")
    .get(allocationId) as { motebit_id: string; task_id: string } | undefined;
  const taskId = alloc?.task_id ?? null;
  const payers = db
    .prepare(
      "SELECT DISTINCT motebit_id FROM relay_transactions WHERE reference_id = ? AND type = 'allocation_hold' LIMIT 2",
    )
    .all(allocationId) as Array<{ motebit_id: string }>;

  // relay_settlements.allocation_id is NOT NULL and names the allocation the
  // receipt route claimed — the allocation key alone finds its settlements.
  const settlements = db
    .prepare(
      `SELECT settlement_id, platform_fee FROM relay_settlements
        WHERE allocation_id = ? AND COALESCE(settlement_mode, 'relay') = 'relay'`,
    )
    .all(allocationId) as Array<{ settlement_id: string; platform_fee: number }>;
  const fees = settlements.reduce((s, r) => s + (r.platform_fee || 0), 0);

  const paidRows = db
    .prepare(
      `SELECT motebit_id, SUM(amount) AS amount FROM relay_transactions
        WHERE type = 'settlement_credit' AND reference_id IN (
          SELECT settlement_id FROM relay_settlements
           WHERE allocation_id = ? AND COALESCE(settlement_mode, 'relay') = 'relay')
        GROUP BY motebit_id`,
    )
    .all(allocationId) as Array<{ motebit_id: string; amount: number }>;
  const settlementCredits = paidRows.reduce((s, r) => s + r.amount, 0);

  const forwarded =
    taskId === null
      ? 0
      : (
          db
            .prepare(
              "SELECT COALESCE(SUM(gross_amount), 0) AS g FROM relay_federation_settlements WHERE task_id = ?",
            )
            .get(taskId) as { g: number }
        ).g;

  // Disputes on this allocation, and disputes NAMING its task from another
  // allocation. The second set is kept on purpose: a relay before the §4.2
  // binding executed a dispute's fund action on the dispute's task_id (main's
  // post-settlement path), so a mismatched legacy dispute on A1 naming A2's
  // task clawed back A2's settlement. Those rows are prior movement of A2's
  // money; without them A2's own dispute reverses the same settlement again
  // (harness: mismatch-final → fileD2 → split → expire, L2). The task is A2's
  // OWN (relay_allocations), so this never reaches a third allocation.
  const disputeRows = db
    .prepare(
      `SELECT motebit_id, amount FROM relay_transactions
        WHERE reference_id IN (
          SELECT dispute_id FROM relay_disputes WHERE allocation_id = ? OR task_id = ?)`,
    )
    .all(allocationId, taskId) as Array<{ motebit_id: string; amount: number }>;
  const ownDisputeRows = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM relay_transactions
          WHERE reference_id IN (SELECT dispute_id FROM relay_disputes WHERE allocation_id = ?)`,
      )
      .get(allocationId) as { n: number }
  ).n;

  // Dispute rows are a GUARD here, never a term. A row referenced to a
  // dispute naming this allocation means a fund action already ran: the fund
  // action stops at `priorDisputeRows` before reading escrow or paid, and a
  // refund path reads escrow only for a `locked` allocation, which a dispute
  // of its own never leaves (filing moves it to `disputed`, the fund action
  // closes it). So nothing is summed over dispute rows; where the invariant
  // would break, escrow and paid read 0 (fail closed) instead of an
  // arithmetic result no reachable state exercises.
  const held = getAllocationHoldRemaining(db, allocationId);
  // Every term is live in the fund action (both regimes distribute the escrow
  // the ledger still holds) and in the stale sweep: a settlement's credit and
  // its fee are what it consumed of the hold (harness: settled / partial go
  // red without either), a federated forward left with no local row
  // (federated-origin / fed-partial).
  const escrowRemaining =
    ownDisputeRows > 0 ? 0 : Math.max(0, held - settlementCredits - fees - forwarded);
  const paid =
    disputeRows.length > 0
      ? []
      : paidRows
          .map((r) => ({ account: r.motebit_id, amount: r.amount }))
          .filter((p) => p.amount > 0);

  return {
    taskId,
    delegator: payers.length === 1 ? payers[0]!.motebit_id : null,
    worker: alloc?.motebit_id ?? null,
    escrowRemaining,
    paid,
    priorDisputeRows: disputeRows.length,
    settled: settlements.length > 0,
  };
}

/**
 * What the ledger still holds for an allocation — the one number every refund
 * or release of it (stale sweep, retry-exhaustion refund, settlement surplus,
 * dispute fund action) pays out of. `getAllocationHoldRemaining` (holds −
 * releases) alone does not see a federated forward, a settlement or a dispute
 * payout (F3: the stale sweep refunded a hold the origin had already
 * forwarded to the executing peer).
 */
export function allocationEscrowHeld(db: DatabaseDriver, allocationId: string): number {
  return allocationLedgerPosition(db, allocationId).escrowRemaining;
}
