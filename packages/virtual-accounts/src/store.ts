/**
 * AccountStore — the persistence boundary.
 *
 * The package defines the interface; consumers ship the implementation.
 * `InMemoryAccountStore` in this file is the test double — it runs the
 * exact same invariants (atomic credit/debit, idempotency, balance
 * equation) without any SQL, so unit tests in this package and in
 * consumers stay deterministic.
 *
 * The canonical production implementation is `SqliteAccountStore` in
 * `services/api/src/account-store-sqlite.ts`, wrapping a
 * `@motebit/persistence` DatabaseDriver.
 */

import type {
  AccountTransaction,
  NewWithdrawal,
  TransactionType,
  VirtualAccount,
  WithdrawalRequest,
  WithdrawalStatus,
} from "./types.js";

export interface AccountStore {
  // ── Accounts ────────────────────────────────────────────────────
  /** Get or lazily create an account with zero balance. */
  getOrCreateAccount(motebitId: string): VirtualAccount;
  /** Return the account, or null if it doesn't exist. Never creates. */
  getAccount(motebitId: string): VirtualAccount | null;

  // ── Atomic compound operations ──────────────────────────────────
  /**
   * Credit an account and append a transaction-log entry **atomically**.
   * Implementations must ensure concurrent callers cannot interleave a
   * partial state (balance updated but transaction not logged, or vice
   * versa).
   *
   * Returns the post-credit balance.
   */
  credit(
    motebitId: string,
    amountMicro: number,
    type: TransactionType,
    referenceId: string | null,
    description: string | null,
  ): number;

  /**
   * Debit an account only if balance >= amount, and append a
   * transaction-log entry, **atomically**. On insufficient funds,
   * returns `null` and leaves state untouched — never a partial debit.
   */
  debit(
    motebitId: string,
    amountMicro: number,
    type: TransactionType,
    referenceId: string | null,
    description: string | null,
  ): number | null;

  // ── Transaction ledger ──────────────────────────────────────────
  getTransactions(motebitId: string, limit?: number): AccountTransaction[];
  /**
   * Idempotency check: has a `deposit`-type transaction with this
   * reference_id already been recorded for this motebit? The type
   * filter matches the legacy `hasTransactionWithReference` shape.
   */
  hasDepositWithReference(motebitId: string, referenceId: string): boolean;

  // ── Withdrawal lifecycle ────────────────────────────────────────
  insertWithdrawal(w: NewWithdrawal): WithdrawalRequest;
  updateWithdrawalStatus(id: string, status: WithdrawalStatus, failureReason?: string): void;
  linkWithdrawalTransfer(id: string, payoutReference: string): boolean;
  setWithdrawalSignature(id: string, signature: string, publicKey: string): void;
  setWithdrawalCompletion(id: string, payoutReference: string, completedAt: number): boolean;
  getWithdrawalById(id: string): WithdrawalRequest | null;
  getWithdrawalByIdempotencyKey(motebitId: string, key: string): WithdrawalRequest | null;
  getWithdrawals(motebitId: string, limit?: number): WithdrawalRequest[];
  getPendingWithdrawalsAdmin(): WithdrawalRequest[];
  getPendingWithdrawalsTotal(motebitId: string): number;
  getPendingAllocationsTotal(motebitId: string): number;

  // ── Sovereign-wallet sweep config (external table, read-only) ──
  /** Returns null fields when not configured / table absent. */
  getSweepConfig(motebitId: string): {
    sweep_threshold: number | null;
    settlement_address: string | null;
  };

  // ── Dispute window ──────────────────────────────────────────────
  /**
   * Amount held back from available balance due to recent settlement
   * activity whose dispute window has not elapsed. Policy input — the
   * provenance is the store implementation's concern (typically a
   * SUM across `relay_settlements` minus active `relay_disputes`).
   */
  getUnwithdrawableHold(motebitId: string): number;
}

// ──────────────────────────────────────────────────────────────────
// In-memory implementation — the test double.
// ──────────────────────────────────────────────────────────────────

interface AccountRow {
  motebit_id: string;
  balance: number;
  currency: string;
  created_at: number;
  updated_at: number;
}

export interface InMemoryAccountStoreOptions {
  /** Override the clock for deterministic tests. Default: Date.now(). */
  now?: () => number;
  /**
   * Override `getUnwithdrawableHold`. Tests that need to exercise the
   * dispute-window branch inject a function; by default the in-memory
   * store has no concept of disputes and returns 0.
   */
  unwithdrawableHold?: (motebitId: string) => number;
  /** Override the sweep-config lookup. Default: null / null. */
  sweepConfig?: (motebitId: string) => {
    sweep_threshold: number | null;
    settlement_address: string | null;
  };
}

export class InMemoryAccountStore implements AccountStore {
  private readonly accounts = new Map<string, AccountRow>();
  private readonly transactions: AccountTransaction[] = [];
  private readonly withdrawals = new Map<string, WithdrawalRequest>();
  private readonly _now: () => number;
  private readonly _unwithdrawableHold: (motebitId: string) => number;
  private readonly _sweepConfig: (motebitId: string) => {
    sweep_threshold: number | null;
    settlement_address: string | null;
  };
  private txnCounter = 0;

  constructor(options: InMemoryAccountStoreOptions = {}) {
    this._now = options.now ?? (() => Date.now());
    this._unwithdrawableHold = options.unwithdrawableHold ?? (() => 0);
    this._sweepConfig =
      options.sweepConfig ?? (() => ({ sweep_threshold: null, settlement_address: null }));
  }

  getOrCreateAccount(motebitId: string): VirtualAccount {
    const existing = this.accounts.get(motebitId);
    if (existing) return { ...existing };
    const now = this._now();
    const row: AccountRow = {
      motebit_id: motebitId,
      balance: 0,
      currency: "USD",
      created_at: now,
      updated_at: now,
    };
    this.accounts.set(motebitId, row);
    return { ...row };
  }

  getAccount(motebitId: string): VirtualAccount | null {
    const row = this.accounts.get(motebitId);
    return row ? { ...row } : null;
  }

  credit(
    motebitId: string,
    amount: number,
    type: TransactionType,
    referenceId: string | null,
    description: string | null,
  ): number {
    const now = this._now();
    let row = this.accounts.get(motebitId);
    if (!row) {
      row = {
        motebit_id: motebitId,
        balance: 0,
        currency: "USD",
        created_at: now,
        updated_at: now,
      };
      this.accounts.set(motebitId, row);
    }
    row.balance += amount;
    row.updated_at = now;
    this.transactions.push({
      transaction_id: this.newTxnId(),
      motebit_id: motebitId,
      type,
      amount,
      balance_after: row.balance,
      reference_id: referenceId,
      description,
      created_at: now,
    });
    return row.balance;
  }

  debit(
    motebitId: string,
    amount: number,
    type: TransactionType,
    referenceId: string | null,
    description: string | null,
  ): number | null {
    const now = this._now();
    let row = this.accounts.get(motebitId);
    if (!row) {
      row = {
        motebit_id: motebitId,
        balance: 0,
        currency: "USD",
        created_at: now,
        updated_at: now,
      };
      this.accounts.set(motebitId, row);
    }
    if (row.balance < amount) return null;
    row.balance -= amount;
    row.updated_at = now;
    this.transactions.push({
      transaction_id: this.newTxnId(),
      motebit_id: motebitId,
      type,
      amount: -amount,
      balance_after: row.balance,
      reference_id: referenceId,
      description,
      created_at: now,
    });
    return row.balance;
  }

  getTransactions(motebitId: string, limit = 50): AccountTransaction[] {
    // DESC by (created_at, transaction_id) — the id is a monotonic counter
    // under the hood, so this is the stable "newest first" even when
    // caller-provided clocks produce identical timestamps.
    return this.transactions
      .filter((t) => t.motebit_id === motebitId)
      .sort((a, b) => {
        if (b.created_at !== a.created_at) return b.created_at - a.created_at;
        return b.transaction_id.localeCompare(a.transaction_id);
      })
      .slice(0, limit);
  }

  hasDepositWithReference(motebitId: string, referenceId: string): boolean {
    return this.transactions.some(
      (t) => t.motebit_id === motebitId && t.reference_id === referenceId && t.type === "deposit",
    );
  }

  insertWithdrawal(w: NewWithdrawal): WithdrawalRequest {
    const record: WithdrawalRequest = {
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
    this.withdrawals.set(w.withdrawal_id, record);
    if (w.idempotency_key != null) {
      // Map idempotency key → withdrawal via a sidecar index
      this.idempotencyIndex.set(`${w.motebit_id}:${w.idempotency_key}`, w.withdrawal_id);
    }
    return { ...record };
  }

  private readonly idempotencyIndex = new Map<string, string>();

  updateWithdrawalStatus(id: string, status: WithdrawalStatus, failureReason?: string): void {
    const w = this.withdrawals.get(id);
    if (!w) return;
    w.status = status;
    if (failureReason !== undefined) w.failure_reason = failureReason;
    if (status === "completed" || status === "failed") {
      w.completed_at = this._now();
    }
  }

  linkWithdrawalTransfer(id: string, payoutReference: string): boolean {
    const w = this.withdrawals.get(id);
    if (!w) return false;
    if (w.status !== "pending" && w.status !== "processing") return false;
    if (w.payout_reference !== null) return false;
    w.payout_reference = payoutReference;
    return true;
  }

  setWithdrawalSignature(id: string, signature: string, publicKey: string): void {
    const w = this.withdrawals.get(id);
    if (!w) return;
    w.relay_signature = signature;
    w.relay_public_key = publicKey;
  }

  setWithdrawalCompletion(id: string, payoutReference: string, completedAt: number): boolean {
    const w = this.withdrawals.get(id);
    if (!w) return false;
    if (w.status !== "pending" && w.status !== "processing") return false;
    w.status = "completed";
    w.payout_reference = payoutReference;
    w.completed_at = completedAt;
    return true;
  }

  getWithdrawalById(id: string): WithdrawalRequest | null {
    const w = this.withdrawals.get(id);
    return w ? { ...w } : null;
  }

  getWithdrawalByIdempotencyKey(motebitId: string, key: string): WithdrawalRequest | null {
    const id = this.idempotencyIndex.get(`${motebitId}:${key}`);
    if (!id) return null;
    return this.getWithdrawalById(id);
  }

  getWithdrawals(motebitId: string, limit = 50): WithdrawalRequest[] {
    return [...this.withdrawals.values()]
      .filter((w) => w.motebit_id === motebitId)
      .sort((a, b) => b.requested_at - a.requested_at)
      .slice(0, limit)
      .map((w) => ({ ...w }));
  }

  getPendingWithdrawalsAdmin(): WithdrawalRequest[] {
    return [...this.withdrawals.values()]
      .filter((w) => w.status === "pending" || w.status === "processing")
      .sort((a, b) => a.requested_at - b.requested_at)
      .map((w) => ({ ...w }));
  }

  getPendingWithdrawalsTotal(motebitId: string): number {
    return [...this.withdrawals.values()]
      .filter(
        (w) => w.motebit_id === motebitId && (w.status === "pending" || w.status === "processing"),
      )
      .reduce((sum, w) => sum + w.amount, 0);
  }

  getPendingAllocationsTotal(_motebitId: string): number {
    // In-memory store does not model allocations; real store reads
    // relay_allocations. Return 0 by default.
    return 0;
  }

  getSweepConfig(motebitId: string): {
    sweep_threshold: number | null;
    settlement_address: string | null;
  } {
    return this._sweepConfig(motebitId);
  }

  getUnwithdrawableHold(motebitId: string): number {
    return this._unwithdrawableHold(motebitId);
  }

  private newTxnId(): string {
    // Deterministic enough for tests; real store uses crypto.randomUUID.
    this.txnCounter += 1;
    return `txn-mem-${this.txnCounter.toString(16).padStart(8, "0")}`;
  }
}
