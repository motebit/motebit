/**
 * SqliteAccountStore — the production AccountStore implementation.
 *
 * Implements `@motebit/virtual-accounts`'s `AccountStore` interface over a
 * `@motebit/persistence` DatabaseDriver. Every atomic compound method
 * (`credit`, `debit`) uses a single SQL statement with balance-guarded
 * UPDATE to preserve Rule 12's "never partial" contract.
 *
 * The DDL for `relay_accounts`, `relay_transactions`, `relay_withdrawals`,
 * `relay_agent_wallets`, and the post-install ALTER TABLE for legacy
 * deployments lives here — the shape that used to live in the pre-
 * extraction `accounts.ts`. Called at relay boot before `runMigrations`
 * (see `services/api/src/index.ts`), consistent with how
 * `createFederationTables` / `createPairingTables` / `createDataSyncTables`
 * operate.
 */

import type { DatabaseDriver } from "@motebit/persistence";
import type {
  AccountStore,
  AccountTransaction,
  NewWithdrawal,
  TransactionType,
  VirtualAccount,
  WithdrawalRequest,
  WithdrawalStatus,
} from "@motebit/virtual-accounts";
import { DISPUTE_WINDOW_MS } from "@motebit/virtual-accounts";

/** Create virtual-account + transaction tables. Idempotent. */
export function createAccountTables(db: DatabaseDriver): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS relay_accounts (
      motebit_id TEXT PRIMARY KEY,
      balance INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS relay_transactions (
      transaction_id TEXT PRIMARY KEY,
      motebit_id TEXT NOT NULL,
      type TEXT NOT NULL,
      amount INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      reference_id TEXT,
      description TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_relay_txn_motebit ON relay_transactions (motebit_id, created_at DESC);

    -- Settlement lookups + idempotency checks by allocation/session reference
    CREATE INDEX IF NOT EXISTS idx_relay_txn_reference ON relay_transactions (reference_id) WHERE reference_id IS NOT NULL;

    -- Analytics queries filtering by transaction type over time
    CREATE INDEX IF NOT EXISTS idx_relay_txn_type_time ON relay_transactions (type, created_at);
  `);
}

/** Create withdrawal table + legacy ALTER TABLE column additions. Idempotent. */
export function createWithdrawalTables(db: DatabaseDriver): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS relay_withdrawals (
      withdrawal_id TEXT PRIMARY KEY,
      motebit_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
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

  // Migration: add relay_signature and relay_public_key columns for DBs
  // created before these fields existed. Idempotent via PRAGMA guard.
  const cols = db.prepare("PRAGMA table_info(relay_withdrawals)").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  if (!colNames.has("relay_signature")) {
    db.exec("ALTER TABLE relay_withdrawals ADD COLUMN relay_signature TEXT");
  }
  if (!colNames.has("relay_public_key")) {
    db.exec("ALTER TABLE relay_withdrawals ADD COLUMN relay_public_key TEXT");
  }
}

/** Create agent wallet table. Idempotent. Reserved for sovereign-rail wiring. */
export function createWalletTable(db: DatabaseDriver): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS relay_agent_wallets (
      agent_id TEXT PRIMARY KEY,
      wallet_id TEXT NOT NULL,
      address TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
}

export class SqliteAccountStore implements AccountStore {
  constructor(private readonly db: DatabaseDriver) {}

  getOrCreateAccount(motebitId: string): VirtualAccount {
    const existing = this.db
      .prepare("SELECT * FROM relay_accounts WHERE motebit_id = ?")
      .get(motebitId) as VirtualAccount | undefined;
    if (existing) return existing;

    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO relay_accounts (motebit_id, balance, currency, created_at, updated_at) VALUES (?, 0, 'USD', ?, ?)",
      )
      .run(motebitId, now, now);
    return { motebit_id: motebitId, balance: 0, currency: "USD", created_at: now, updated_at: now };
  }

  getAccount(motebitId: string): VirtualAccount | null {
    return (
      (this.db.prepare("SELECT * FROM relay_accounts WHERE motebit_id = ?").get(motebitId) as
        | VirtualAccount
        | undefined) ?? null
    );
  }

  credit(
    motebitId: string,
    amount: number,
    type: TransactionType,
    referenceId: string | null,
    description: string | null,
  ): number {
    const now = Date.now();
    const transactionId = crypto.randomUUID();

    // Ensure the row exists before the atomic UPDATE.
    this.getOrCreateAccount(motebitId);

    this.db
      .prepare(
        "UPDATE relay_accounts SET balance = balance + ?, updated_at = ? WHERE motebit_id = ?",
      )
      .run(amount, now, motebitId);

    const updated = this.db
      .prepare("SELECT balance FROM relay_accounts WHERE motebit_id = ?")
      .get(motebitId) as { balance: number } | undefined;
    const newBalance = updated?.balance ?? 0;

    this.db
      .prepare(
        `INSERT INTO relay_transactions (transaction_id, motebit_id, type, amount, balance_after, reference_id, description, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(transactionId, motebitId, type, amount, newBalance, referenceId, description, now);

    return newBalance;
  }

  debit(
    motebitId: string,
    amount: number,
    type: TransactionType,
    referenceId: string | null,
    description: string | null,
  ): number | null {
    const now = Date.now();
    const transactionId = crypto.randomUUID();

    this.getOrCreateAccount(motebitId);

    // Atomic: debit only if balance >= amount. No read-then-write race even
    // under multi-process; `changes === 0` is the "insufficient funds" signal.
    const info = this.db
      .prepare(
        "UPDATE relay_accounts SET balance = balance - ?, updated_at = ? WHERE motebit_id = ? AND balance >= ?",
      )
      .run(amount, now, motebitId, amount);

    if (info.changes === 0) return null;

    const updated = this.db
      .prepare("SELECT balance FROM relay_accounts WHERE motebit_id = ?")
      .get(motebitId) as { balance: number } | undefined;
    const newBalance = updated?.balance ?? 0;

    this.db
      .prepare(
        `INSERT INTO relay_transactions (transaction_id, motebit_id, type, amount, balance_after, reference_id, description, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(transactionId, motebitId, type, -amount, newBalance, referenceId, description, now);

    return newBalance;
  }

  getTransactions(motebitId: string, limit = 50): AccountTransaction[] {
    return this.db
      .prepare(
        "SELECT * FROM relay_transactions WHERE motebit_id = ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(motebitId, limit) as AccountTransaction[];
  }

  hasDepositWithReference(motebitId: string, referenceId: string): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 FROM relay_transactions WHERE motebit_id = ? AND reference_id = ? AND type = 'deposit' LIMIT 1",
      )
      .get(motebitId, referenceId) as Record<string, unknown> | undefined;
    return row !== undefined;
  }

  insertWithdrawal(w: NewWithdrawal): WithdrawalRequest {
    this.db
      .prepare(
        `INSERT INTO relay_withdrawals
           (withdrawal_id, motebit_id, amount, currency, destination, status, idempotency_key, requested_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        w.withdrawal_id,
        w.motebit_id,
        w.amount,
        w.currency,
        w.destination,
        w.idempotency_key,
        w.requested_at,
      );
    return {
      withdrawal_id: w.withdrawal_id,
      motebit_id: w.motebit_id,
      amount: w.amount,
      currency: w.currency,
      destination: w.destination,
      status: "pending",
      payout_reference: null,
      requested_at: w.requested_at,
      completed_at: null,
      failure_reason: null,
      relay_signature: null,
      relay_public_key: null,
    };
  }

  updateWithdrawalStatus(id: string, status: WithdrawalStatus, failureReason?: string): void {
    if (status === "failed") {
      this.db
        .prepare(
          "UPDATE relay_withdrawals SET status = 'failed', failure_reason = ?, completed_at = ? WHERE withdrawal_id = ?",
        )
        .run(failureReason ?? null, Date.now(), id);
    } else {
      this.db
        .prepare("UPDATE relay_withdrawals SET status = ? WHERE withdrawal_id = ?")
        .run(status, id);
    }
  }

  linkWithdrawalTransfer(id: string, payoutReference: string): boolean {
    const info = this.db
      .prepare(
        "UPDATE relay_withdrawals SET payout_reference = ? WHERE withdrawal_id = ? AND status IN ('pending', 'processing') AND payout_reference IS NULL",
      )
      .run(payoutReference, id);
    return info.changes > 0;
  }

  setWithdrawalSignature(id: string, signature: string, publicKey: string): void {
    this.db
      .prepare(
        "UPDATE relay_withdrawals SET relay_signature = ?, relay_public_key = ? WHERE withdrawal_id = ?",
      )
      .run(signature, publicKey, id);
  }

  setWithdrawalCompletion(id: string, payoutReference: string, completedAt: number): boolean {
    const info = this.db
      .prepare(
        "UPDATE relay_withdrawals SET status = 'completed', payout_reference = ?, completed_at = ? WHERE withdrawal_id = ? AND status IN ('pending', 'processing')",
      )
      .run(payoutReference, completedAt, id);
    return info.changes > 0;
  }

  getWithdrawalById(id: string): WithdrawalRequest | null {
    return (
      (this.db.prepare("SELECT * FROM relay_withdrawals WHERE withdrawal_id = ?").get(id) as
        | WithdrawalRequest
        | undefined) ?? null
    );
  }

  getWithdrawalByIdempotencyKey(motebitId: string, key: string): WithdrawalRequest | null {
    return (
      (this.db
        .prepare("SELECT * FROM relay_withdrawals WHERE motebit_id = ? AND idempotency_key = ?")
        .get(motebitId, key) as WithdrawalRequest | undefined) ?? null
    );
  }

  getWithdrawals(motebitId: string, limit = 50): WithdrawalRequest[] {
    return this.db
      .prepare(
        "SELECT * FROM relay_withdrawals WHERE motebit_id = ? ORDER BY requested_at DESC LIMIT ?",
      )
      .all(motebitId, limit) as WithdrawalRequest[];
  }

  getPendingWithdrawalsAdmin(): WithdrawalRequest[] {
    return this.db
      .prepare(
        "SELECT * FROM relay_withdrawals WHERE status IN ('pending', 'processing') ORDER BY requested_at ASC",
      )
      .all() as WithdrawalRequest[];
  }

  getPendingWithdrawalsTotal(motebitId: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(SUM(amount), 0) as total FROM relay_withdrawals WHERE motebit_id = ? AND status IN ('pending', 'processing')",
      )
      .get(motebitId) as { total: number };
    return row.total;
  }

  getPendingAllocationsTotal(motebitId: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(SUM(amount_locked), 0) as total FROM relay_allocations WHERE motebit_id = ? AND status = 'locked'",
      )
      .get(motebitId) as { total: number };
    return row.total;
  }

  getSweepConfig(motebitId: string): {
    sweep_threshold: number | null;
    settlement_address: string | null;
  } {
    // agent_registry rows exist for registered motebits but not for agents
    // that only touched the relay's economic layer (virtual accounts are
    // lazy-created on first transaction). Missing row = no sweep configured.
    try {
      const row = this.db
        .prepare(
          "SELECT sweep_threshold, settlement_address FROM agent_registry WHERE motebit_id = ?",
        )
        .get(motebitId) as
        | { sweep_threshold: number | null; settlement_address: string | null }
        | undefined;
      return row ?? { sweep_threshold: null, settlement_address: null };
    } catch {
      // agent_registry may not exist in minimal test setups — fail open.
      return { sweep_threshold: null, settlement_address: null };
    }
  }

  getUnwithdrawableHold(motebitId: string): number {
    const cutoff = Date.now() - DISPUTE_WINDOW_MS;
    try {
      const row = this.db
        .prepare(
          `SELECT COALESCE(SUM(s.amount_settled), 0) as total
           FROM relay_settlements s
           WHERE s.motebit_id = ?
             AND s.settled_at > ?
             AND s.status = 'completed'
             AND COALESCE(s.settlement_mode, 'relay') = 'relay'
             AND s.task_id NOT IN (
               SELECT d.task_id FROM relay_disputes d
               WHERE d.state NOT IN ('final', 'expired')
             )`,
        )
        .get(motebitId, cutoff) as { total: number };
      return row.total;
    } catch {
      // relay_settlements or relay_disputes table may not exist in minimal setups.
      return 0;
    }
  }
}

// ── Singleton binding keyed by DatabaseDriver ─────────────────────────────
// The shim at `services/api/src/accounts.ts` calls the legacy functional API
// with a `db` argument. That API is backed by a per-db SqliteAccountStore;
// we memoize here so each logical database binds to exactly one store.
// Using WeakMap is safe because DatabaseDriver instances are object-typed.

const stores = new WeakMap<DatabaseDriver, SqliteAccountStore>();

export function sqliteAccountStoreFor(db: DatabaseDriver): SqliteAccountStore {
  let s = stores.get(db);
  if (!s) {
    s = new SqliteAccountStore(db);
    stores.set(db, s);
  }
  return s;
}
