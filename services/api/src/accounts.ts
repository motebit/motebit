/**
 * Virtual accounts — the payment on-ramp that turns the settlement ledger into a real business.
 *
 * Every motebit agent has a virtual account on the relay. Deposits credit the account,
 * task delegation debits it (allocation hold), and settlement moves funds from delegator
 * to worker. The platform fee is the difference — it stays with the relay.
 */

import type { DatabaseDriver } from "@motebit/persistence";
import { createLogger } from "./logger.js";

const logger = createLogger({ service: "accounts" });

export interface VirtualAccount {
  motebit_id: string;
  balance: number;
  currency: string;
  created_at: number;
  updated_at: number;
}

export interface AccountTransaction {
  transaction_id: string;
  motebit_id: string;
  type:
    | "deposit"
    | "withdrawal"
    | "allocation_hold"
    | "allocation_release"
    | "settlement_debit"
    | "settlement_credit"
    | "fee";
  amount: number;
  balance_after: number;
  reference_id: string | null;
  description: string | null;
  created_at: number;
}

/** Create virtual account tables. Idempotent. */
export function createAccountTables(db: DatabaseDriver): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS relay_accounts (
      motebit_id TEXT PRIMARY KEY,
      balance REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS relay_transactions (
      transaction_id TEXT PRIMARY KEY,
      motebit_id TEXT NOT NULL,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      balance_after REAL NOT NULL,
      reference_id TEXT,
      description TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_relay_txn_motebit ON relay_transactions (motebit_id, created_at DESC);
  `);
}

/** Get or create a virtual account with zero balance. */
export function getOrCreateAccount(db: DatabaseDriver, motebitId: string): VirtualAccount {
  const existing = db
    .prepare("SELECT * FROM relay_accounts WHERE motebit_id = ?")
    .get(motebitId) as VirtualAccount | undefined;
  if (existing) return existing;

  const now = Date.now();
  db.prepare(
    "INSERT INTO relay_accounts (motebit_id, balance, currency, created_at, updated_at) VALUES (?, 0, 'USD', ?, ?)",
  ).run(motebitId, now, now);

  return { motebit_id: motebitId, balance: 0, currency: "USD", created_at: now, updated_at: now };
}

/** Get account balance, or null if no account exists. */
export function getAccountBalance(db: DatabaseDriver, motebitId: string): VirtualAccount | null {
  return (
    (db.prepare("SELECT * FROM relay_accounts WHERE motebit_id = ?").get(motebitId) as
      | VirtualAccount
      | undefined) ?? null
  );
}

/**
 * Credit an account (deposit, settlement_credit, allocation_release).
 * Creates the account if it doesn't exist.
 * Returns the new balance.
 */
export function creditAccount(
  db: DatabaseDriver,
  motebitId: string,
  amount: number,
  type: AccountTransaction["type"],
  referenceId: string | null,
  description: string | null,
): number {
  const now = Date.now();
  const transactionId = crypto.randomUUID();

  const account = getOrCreateAccount(db, motebitId);
  const newBalance = account.balance + amount;

  db.prepare("UPDATE relay_accounts SET balance = ?, updated_at = ? WHERE motebit_id = ?").run(
    newBalance,
    now,
    motebitId,
  );

  db.prepare(
    `INSERT INTO relay_transactions (transaction_id, motebit_id, type, amount, balance_after, reference_id, description, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(transactionId, motebitId, type, amount, newBalance, referenceId, description, now);

  logger.info("account.credit", {
    motebitId,
    amount,
    type,
    balanceAfter: newBalance,
    referenceId,
  });

  return newBalance;
}

/**
 * Debit an account (allocation_hold, settlement_debit, withdrawal, fee).
 * Returns the new balance, or null if insufficient funds.
 */
export function debitAccount(
  db: DatabaseDriver,
  motebitId: string,
  amount: number,
  type: AccountTransaction["type"],
  referenceId: string | null,
  description: string | null,
): number | null {
  const now = Date.now();
  const transactionId = crypto.randomUUID();

  const account = getOrCreateAccount(db, motebitId);
  if (account.balance < amount) return null;

  const newBalance = account.balance - amount;

  db.prepare("UPDATE relay_accounts SET balance = ?, updated_at = ? WHERE motebit_id = ?").run(
    newBalance,
    now,
    motebitId,
  );

  db.prepare(
    `INSERT INTO relay_transactions (transaction_id, motebit_id, type, amount, balance_after, reference_id, description, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(transactionId, motebitId, type, -amount, newBalance, referenceId, description, now);

  logger.info("account.debit", {
    motebitId,
    amount,
    type,
    balanceAfter: newBalance,
    referenceId,
  });

  return newBalance;
}

/**
 * Get recent transactions for an account.
 */
export function getTransactions(
  db: DatabaseDriver,
  motebitId: string,
  limit: number = 50,
): AccountTransaction[] {
  return db
    .prepare(
      "SELECT * FROM relay_transactions WHERE motebit_id = ? ORDER BY created_at DESC LIMIT ?",
    )
    .all(motebitId, limit) as AccountTransaction[];
}

/**
 * Check if a deposit with the given reference_id already exists (idempotency).
 */
export function hasTransactionWithReference(
  db: DatabaseDriver,
  motebitId: string,
  referenceId: string,
): boolean {
  const row = db
    .prepare(
      "SELECT 1 FROM relay_transactions WHERE motebit_id = ? AND reference_id = ? AND type = 'deposit' LIMIT 1",
    )
    .get(motebitId, referenceId) as Record<string, unknown> | undefined;
  return row !== undefined;
}

// === Withdrawals ===

export interface WithdrawalRequest {
  withdrawal_id: string;
  motebit_id: string;
  amount: number;
  currency: string;
  destination: string; // Wallet address, bank account ref, or "pending" for manual
  status: "pending" | "processing" | "completed" | "failed" | "cancelled";
  payout_reference: string | null; // External payout ID (Stripe transfer, tx hash, etc.)
  requested_at: number;
  completed_at: number | null;
  failure_reason: string | null;
}

/** Create withdrawal tables. Idempotent. */
export function createWithdrawalTables(db: DatabaseDriver): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS relay_withdrawals (
      withdrawal_id TEXT PRIMARY KEY,
      motebit_id TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      destination TEXT NOT NULL DEFAULT 'pending',
      status TEXT NOT NULL DEFAULT 'pending',
      payout_reference TEXT,
      requested_at INTEGER NOT NULL,
      completed_at INTEGER,
      failure_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_relay_withdrawals_motebit
      ON relay_withdrawals (motebit_id, requested_at DESC);
    CREATE INDEX IF NOT EXISTS idx_relay_withdrawals_status
      ON relay_withdrawals (status) WHERE status IN ('pending', 'processing');
  `);
}

/**
 * Request a withdrawal. Debits the virtual account immediately (funds held).
 * Returns the withdrawal request, or null if insufficient balance.
 */
export function requestWithdrawal(
  db: DatabaseDriver,
  motebitId: string,
  amount: number,
  destination: string = "pending",
): WithdrawalRequest | null {
  const withdrawalId = crypto.randomUUID();
  const now = Date.now();

  // Debit account — returns null if insufficient balance
  const newBalance = debitAccount(
    db,
    motebitId,
    amount,
    "withdrawal",
    withdrawalId,
    `Withdrawal request: ${amount} to ${destination}`,
  );
  if (newBalance === null) return null;

  db.prepare(
    `INSERT INTO relay_withdrawals
       (withdrawal_id, motebit_id, amount, currency, destination, status, requested_at)
     VALUES (?, ?, ?, 'USD', ?, 'pending', ?)`,
  ).run(withdrawalId, motebitId, amount, destination, now);

  logger.info("withdrawal.requested", {
    motebitId,
    withdrawalId,
    amount,
    destination,
    balanceAfter: newBalance,
  });

  return {
    withdrawal_id: withdrawalId,
    motebit_id: motebitId,
    amount,
    currency: "USD",
    destination,
    status: "pending",
    payout_reference: null,
    requested_at: now,
    completed_at: null,
    failure_reason: null,
  };
}

/**
 * Complete a pending withdrawal (called by admin/operator after payout is confirmed).
 * Returns true if the withdrawal was found and updated.
 */
export function completeWithdrawal(
  db: DatabaseDriver,
  withdrawalId: string,
  payoutReference: string,
): boolean {
  const now = Date.now();
  const info = db
    .prepare(
      `UPDATE relay_withdrawals
       SET status = 'completed', payout_reference = ?, completed_at = ?
       WHERE withdrawal_id = ? AND status IN ('pending', 'processing')`,
    )
    .run(payoutReference, now, withdrawalId);
  if (info.changes > 0) {
    logger.info("withdrawal.completed", { withdrawalId, payoutReference });
  }
  return info.changes > 0;
}

/**
 * Fail a withdrawal and return funds to the agent's virtual account.
 * Returns true if the withdrawal was found and refunded.
 */
export function failWithdrawal(db: DatabaseDriver, withdrawalId: string, reason: string): boolean {
  const now = Date.now();
  const withdrawal = db
    .prepare(
      "SELECT * FROM relay_withdrawals WHERE withdrawal_id = ? AND status IN ('pending', 'processing')",
    )
    .get(withdrawalId) as WithdrawalRequest | undefined;
  if (!withdrawal) return false;

  // Return funds to account
  creditAccount(
    db,
    withdrawal.motebit_id,
    withdrawal.amount,
    "withdrawal",
    withdrawalId,
    `Withdrawal failed: ${reason}`,
  );

  db.prepare(
    `UPDATE relay_withdrawals
     SET status = 'failed', failure_reason = ?, completed_at = ?
     WHERE withdrawal_id = ?`,
  ).run(reason, now, withdrawalId);

  logger.info("withdrawal.failed", {
    withdrawalId,
    motebitId: withdrawal.motebit_id,
    amount: withdrawal.amount,
    reason,
  });

  return true;
}

/**
 * Get withdrawals for an agent.
 */
export function getWithdrawals(
  db: DatabaseDriver,
  motebitId: string,
  limit: number = 50,
): WithdrawalRequest[] {
  return db
    .prepare(
      "SELECT * FROM relay_withdrawals WHERE motebit_id = ? ORDER BY requested_at DESC LIMIT ?",
    )
    .all(motebitId, limit) as WithdrawalRequest[];
}

/**
 * Get all pending/processing withdrawals (admin view).
 */
export function getPendingWithdrawals(db: DatabaseDriver): WithdrawalRequest[] {
  return db
    .prepare(
      "SELECT * FROM relay_withdrawals WHERE status IN ('pending', 'processing') ORDER BY requested_at ASC",
    )
    .all() as WithdrawalRequest[];
}
