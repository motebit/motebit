/**
 * Virtual accounts — the payment on-ramp that turns the settlement ledger into a real business.
 *
 * Every motebit agent has a virtual account on the relay. Deposits credit the account,
 * task delegation debits it (allocation hold), and settlement moves funds from delegator
 * to worker. The platform fee is the difference — it stays with the relay.
 */

import type { DatabaseDriver } from "@motebit/persistence";
import { canonicalJson, sign, toBase64Url } from "@motebit/crypto";
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
 * Get account balance with available/pending breakdown.
 * available = balance (already debited for holds/withdrawals)
 * pending_withdrawals = sum of pending/processing withdrawal amounts
 * pending_allocations = sum of locked allocation amounts
 */
export function getAccountBalanceDetailed(
  db: DatabaseDriver,
  motebitId: string,
): {
  balance: number;
  currency: string;
  pending_withdrawals: number;
  pending_allocations: number;
} {
  const account = getOrCreateAccount(db, motebitId);

  const pendingW = db
    .prepare(
      "SELECT COALESCE(SUM(amount), 0) as total FROM relay_withdrawals WHERE motebit_id = ? AND status IN ('pending', 'processing')",
    )
    .get(motebitId) as { total: number };

  const pendingA = db
    .prepare(
      "SELECT COALESCE(SUM(amount_locked), 0) as total FROM relay_allocations WHERE motebit_id = ? AND status = 'locked'",
    )
    .get(motebitId) as { total: number };

  return {
    balance: account.balance,
    currency: account.currency,
    pending_withdrawals: pendingW.total,
    pending_allocations: pendingA.total,
  };
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
 *
 * Uses atomic UPDATE WHERE balance >= amount to prevent race conditions.
 * Even though SQLite is single-writer, this pattern is correct if the
 * relay ever moves to Postgres or a multi-process setup.
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

  // Ensure account exists
  getOrCreateAccount(db, motebitId);

  // Atomic: debit only if balance is sufficient — no read-then-write race
  const info = db
    .prepare(
      "UPDATE relay_accounts SET balance = balance - ?, updated_at = ? WHERE motebit_id = ? AND balance >= ?",
    )
    .run(amount, now, motebitId, amount);

  if (info.changes === 0) return null;

  // Read the new balance after the atomic update
  const updated = db
    .prepare("SELECT balance FROM relay_accounts WHERE motebit_id = ?")
    .get(motebitId) as { balance: number } | undefined;
  const newBalance = updated?.balance ?? 0;

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

// === Stripe Checkout ===

/**
 * Process a completed Stripe Checkout session. Credits the agent's virtual account.
 * Idempotent: uses the Stripe session ID as deposit reference.
 *
 * @returns true if the deposit was applied, false if it was already processed (idempotent replay).
 */
export function processStripeCheckout(
  db: DatabaseDriver,
  sessionId: string,
  motebitId: string,
  amount: number,
  paymentIntent?: string,
): boolean {
  if (amount <= 0) return false;

  // Idempotency: skip if this session was already processed
  if (hasTransactionWithReference(db, motebitId, sessionId)) {
    logger.info("stripe.checkout.idempotent", { motebitId, sessionId });
    return false;
  }

  creditAccount(
    db,
    motebitId,
    amount,
    "deposit",
    sessionId,
    paymentIntent ? `Stripe Checkout: ${paymentIntent}` : `Stripe Checkout: ${sessionId}`,
  );

  logger.info("stripe.checkout.credited", {
    motebitId,
    sessionId,
    amount,
    paymentIntent: paymentIntent ?? null,
  });

  return true;
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
  relay_signature: string | null; // Ed25519 signature over canonical withdrawal receipt
  relay_public_key: string | null; // Hex-encoded relay public key for independent verification
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
      idempotency_key TEXT,
      payout_reference TEXT,
      requested_at INTEGER NOT NULL,
      completed_at INTEGER,
      failure_reason TEXT,
      relay_signature TEXT,
      relay_public_key TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_relay_withdrawals_motebit
      ON relay_withdrawals (motebit_id, requested_at DESC);
    CREATE INDEX IF NOT EXISTS idx_relay_withdrawals_status
      ON relay_withdrawals (status) WHERE status IN ('pending', 'processing');
    CREATE UNIQUE INDEX IF NOT EXISTS idx_relay_withdrawals_idempotency
      ON relay_withdrawals (motebit_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
  `);

  // Migration: add relay_signature and relay_public_key columns for existing DBs
  const cols = db.prepare("PRAGMA table_info(relay_withdrawals)").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  if (!colNames.has("relay_signature")) {
    db.exec("ALTER TABLE relay_withdrawals ADD COLUMN relay_signature TEXT");
  }
  if (!colNames.has("relay_public_key")) {
    db.exec("ALTER TABLE relay_withdrawals ADD COLUMN relay_public_key TEXT");
  }
}

/**
 * Request a withdrawal. Debits the virtual account immediately (funds held).
 * Returns the withdrawal request, or null if insufficient balance.
 *
 * Supports idempotency: if `idempotencyKey` is provided and a withdrawal with
 * that key already exists for this agent, the existing withdrawal is returned
 * without creating a duplicate.
 */
export function requestWithdrawal(
  db: DatabaseDriver,
  motebitId: string,
  amount: number,
  destination: string = "pending",
  idempotencyKey?: string,
): WithdrawalRequest | null | { existing: WithdrawalRequest } {
  // Idempotency check: if key provided and already used, return existing
  if (idempotencyKey) {
    const existing = db
      .prepare("SELECT * FROM relay_withdrawals WHERE motebit_id = ? AND idempotency_key = ?")
      .get(motebitId, idempotencyKey) as WithdrawalRequest | undefined;
    if (existing) {
      logger.info("withdrawal.idempotent", { motebitId, idempotencyKey });
      return { existing };
    }
  }

  const withdrawalId = crypto.randomUUID();
  const now = Date.now();

  // Debit account — returns null if insufficient balance (atomic check)
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
       (withdrawal_id, motebit_id, amount, currency, destination, status, idempotency_key, requested_at)
     VALUES (?, ?, ?, 'USD', ?, 'pending', ?, ?)`,
  ).run(withdrawalId, motebitId, amount, destination, idempotencyKey ?? null, now);

  logger.info("withdrawal.requested", {
    motebitId,
    withdrawalId,
    amount,
    destination,
    idempotencyKey: idempotencyKey ?? null,
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
    relay_signature: null,
    relay_public_key: null,
  };
}

/**
 * Complete a pending withdrawal (called by admin/operator after payout is confirmed).
 * Optionally stores a relay-signed withdrawal receipt for independent verification.
 * When a signature is provided, `completedAt` must match the timestamp used in the signed payload.
 * Returns true if the withdrawal was found and updated.
 */
export function completeWithdrawal(
  db: DatabaseDriver,
  withdrawalId: string,
  payoutReference: string,
  relaySignature?: string,
  relayPublicKey?: string,
  completedAt?: number,
): boolean {
  const now = completedAt ?? Date.now();
  const info = db
    .prepare(
      `UPDATE relay_withdrawals
       SET status = 'completed', payout_reference = ?, completed_at = ?,
           relay_signature = ?, relay_public_key = ?
       WHERE withdrawal_id = ? AND status IN ('pending', 'processing')`,
    )
    .run(payoutReference, now, relaySignature ?? null, relayPublicKey ?? null, withdrawalId);
  if (info.changes > 0) {
    logger.info("withdrawal.completed", {
      withdrawalId,
      payoutReference,
      signed: !!relaySignature,
    });
  }
  return info.changes > 0;
}

/**
 * Sign a withdrawal receipt with the relay's Ed25519 private key.
 * Uses canonical JSON + SHA-256 hash + Ed25519 signature — same pattern as ExecutionReceipt signing.
 * Returns the base64url-encoded signature.
 */
export async function signWithdrawalReceipt(
  withdrawal: {
    withdrawal_id: string;
    motebit_id: string;
    amount: number;
    currency: string;
    destination: string;
    payout_reference: string;
    completed_at: number;
    relay_id: string;
  },
  privateKey: Uint8Array,
): Promise<string> {
  const canonical = canonicalJson(withdrawal);
  const message = new TextEncoder().encode(canonical);
  const sig = await sign(message, privateKey);
  return toBase64Url(sig);
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

// === Ledger Reconciliation ===

export interface ReconciliationResult {
  consistent: boolean;
  errors: string[];
}

/**
 * Verify ledger consistency across all virtual account tables.
 *
 * Checks:
 * 1. Sum of all credits − sum of all debits = sum of all account balances
 * 2. No negative balances exist
 * 3. Every settled allocation has a matching settlement record
 * 4. Every pending withdrawal has a corresponding debit transaction
 * 5. Every completed withdrawal has a relay signature
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

  // Compare with tolerance for floating point
  if (Math.abs(txnSum.net - balanceSum.total) > 0.001) {
    errors.push(
      `Balance equation violated: transaction net ${txnSum.net.toFixed(4)} != account balance sum ${balanceSum.total.toFixed(4)}`,
    );
  }

  // 2. No negative balances
  const negativeAccounts = db
    .prepare("SELECT motebit_id, balance FROM relay_accounts WHERE balance < -0.001")
    .all() as Array<{ motebit_id: string; balance: number }>;
  for (const acct of negativeAccounts) {
    errors.push(
      `Negative balance: agent ${acct.motebit_id} has balance ${acct.balance.toFixed(4)}`,
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

  return { consistent: errors.length === 0, errors };
}
