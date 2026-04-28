/**
 * Ledger reconciliation — cross-table audit of virtual accounts +
 * allocations + settlements + withdrawals + settlement proofs.
 *
 * Extracted from `accounts.ts` during the `@motebit/virtual-accounts`
 * extraction. This module is services/relay-scoped because it queries
 * `relay_allocations`, `relay_settlements`, and `relay_settlement_proofs`
 * alongside the virtual-account tables. The ledger package exposes its
 * own invariants (atomic credit/debit, never-partial debit); cross-table
 * consistency is the relay's audit surface.
 */

import type { DatabaseDriver } from "@motebit/persistence";
import { fromMicro, type ReconciliationResult } from "@motebit/virtual-accounts";

/**
 * Verify ledger consistency across all virtual account tables.
 *
 * Checks:
 * 1. Sum of all credits − sum of all debits = sum of all account balances
 * 2. No negative balances exist
 * 3. Every settled allocation has a matching settlement record
 * 4. Every pending withdrawal has a corresponding debit transaction
 * 5. Every completed withdrawal has a relay signature
 * 6. Every completed withdrawal with a payout_reference has a proof record
 */
export function reconcileLedger(db: DatabaseDriver): ReconciliationResult {
  const errors: string[] = [];

  // 1. Balance equation: net transactions should equal sum of account balances
  const txnSum = db
    .prepare("SELECT COALESCE(SUM(amount), 0) as net FROM relay_transactions")
    .get() as { net: number };
  const balanceSum = db
    .prepare("SELECT COALESCE(SUM(balance), 0) as total FROM relay_accounts")
    .get() as { total: number };

  // Exact match — integer micro-units have no drift
  if (txnSum.net !== balanceSum.total) {
    errors.push(
      `Balance equation violated: transaction net ${txnSum.net} != account balance sum ${balanceSum.total}`,
    );
  }

  // 2. No negative balances
  const negativeAccounts = db
    .prepare("SELECT motebit_id, balance FROM relay_accounts WHERE balance < 0")
    .all() as Array<{ motebit_id: string; balance: number }>;
  for (const acct of negativeAccounts) {
    errors.push(
      `Negative balance: agent ${acct.motebit_id} has balance ${acct.balance} (${fromMicro(acct.balance).toFixed(6)} USD)`,
    );
  }

  // 3. Every settled allocation has a matching settlement record
  const settledWithoutSettlement = db
    .prepare(
      `SELECT a.allocation_id, a.task_id, a.motebit_id
       FROM relay_allocations a
       LEFT JOIN relay_settlements s ON s.allocation_id = a.allocation_id
       WHERE a.status = 'settled' AND s.settlement_id IS NULL`,
    )
    .all() as Array<{ allocation_id: string; task_id: string; motebit_id: string }>;
  for (const alloc of settledWithoutSettlement) {
    errors.push(
      `Settled allocation ${alloc.allocation_id} (task ${alloc.task_id}) has no matching settlement record`,
    );
  }

  // 4. Every pending withdrawal has a corresponding debit transaction
  const pendingWithdrawals = db
    .prepare(
      "SELECT withdrawal_id, motebit_id, amount FROM relay_withdrawals WHERE status IN ('pending', 'processing')",
    )
    .all() as Array<{ withdrawal_id: string; motebit_id: string; amount: number }>;
  for (const w of pendingWithdrawals) {
    const txn = db
      .prepare(
        "SELECT 1 FROM relay_transactions WHERE reference_id = ? AND type = 'withdrawal' AND motebit_id = ? LIMIT 1",
      )
      .get(w.withdrawal_id, w.motebit_id) as Record<string, unknown> | undefined;
    if (!txn) {
      errors.push(
        `Pending withdrawal ${w.withdrawal_id} (agent ${w.motebit_id}) has no matching debit transaction`,
      );
    }
  }

  // 5. Every completed withdrawal has a relay signature
  const unsignedCompleted = db
    .prepare(
      "SELECT withdrawal_id, motebit_id FROM relay_withdrawals WHERE status = 'completed' AND relay_signature IS NULL",
    )
    .all() as Array<{ withdrawal_id: string; motebit_id: string }>;
  for (const w of unsignedCompleted) {
    errors.push(
      `Completed withdrawal ${w.withdrawal_id} (agent ${w.motebit_id}) has no relay signature`,
    );
  }

  // 6. Every completed withdrawal with a payout_reference should have a settlement proof
  const completedWithoutProof = db
    .prepare(
      `SELECT w.withdrawal_id, w.motebit_id, w.payout_reference
       FROM relay_withdrawals w
       LEFT JOIN relay_settlement_proofs p ON p.settlement_id = w.withdrawal_id
       WHERE w.status = 'completed' AND w.payout_reference IS NOT NULL AND p.settlement_id IS NULL`,
    )
    .all() as Array<{ withdrawal_id: string; motebit_id: string; payout_reference: string }>;
  for (const w of completedWithoutProof) {
    // Hard error — all completion paths now write proof records (rail or manual).
    errors.push(
      `Completed withdrawal ${w.withdrawal_id} (agent ${w.motebit_id}) has payout_reference but no settlement proof`,
    );
  }

  return { consistent: errors.length === 0, errors };
}
