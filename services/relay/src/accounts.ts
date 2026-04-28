/**
 * Virtual accounts — deprecation shim.
 *
 * The implementation now lives in `@motebit/virtual-accounts` (Layer 1
 * package). This file preserves the legacy `(db, motebitId, ...)`
 * functional API by routing through a per-db `SqliteAccountStore`
 * singleton (see `account-store-sqlite.ts`). New code should consume
 * `@motebit/virtual-accounts` directly and pass an `AccountStore`
 * instance.
 *
 * Sibling modules that used to live here:
 *  - `settlement-proofs.ts` — `createProofTable`, `storeSettlementProof`,
 *     `getSettlementProofs`
 *  - `reconciliation.ts` — `reconcileLedger`
 *  - `stripe-credit.ts` — `processStripeCheckout`
 *  - `account-store-sqlite.ts` — `createAccountTables`,
 *     `createWithdrawalTables`, `createWalletTable`, `SqliteAccountStore`
 *
 * Delete this file once every consumer is migrated to the package API.
 */

import type { DatabaseDriver } from "@motebit/persistence";
import {
  completeWithdrawal as pkgCompleteWithdrawal,
  failWithdrawal as pkgFailWithdrawal,
  getAccountBalanceDetailed as pkgGetAccountBalanceDetailed,
  requestWithdrawal as pkgRequestWithdrawal,
  signWithdrawalReceipt as pkgSignWithdrawalReceipt,
  type AccountBalanceDetail,
  type AccountTransaction,
  type TransactionType,
  type VirtualAccount,
  type WithdrawalRequest,
  type WithdrawalReceiptPayload,
} from "@motebit/virtual-accounts";
import { sqliteAccountStoreFor } from "./account-store-sqlite.js";
import { createLogger } from "./logger.js";

const logger = createLogger({ service: "accounts" });

// ── Re-exports: money + types ──────────────────────────────────────────
export { fromMicro, toMicro } from "@motebit/virtual-accounts";
export type {
  AccountTransaction,
  VirtualAccount,
  WithdrawalRequest,
} from "@motebit/virtual-accounts";
export type { ReconciliationResult } from "@motebit/virtual-accounts";

// ── Re-exports: sibling modules ────────────────────────────────────────
export {
  createAccountTables,
  createWithdrawalTables,
  createWalletTable,
  SqliteAccountStore,
  sqliteAccountStoreFor,
} from "./account-store-sqlite.js";
export {
  createProofTable,
  storeSettlementProof,
  getSettlementProofs,
} from "./settlement-proofs.js";
export { reconcileLedger } from "./reconciliation.js";
export { processStripeCheckout } from "./stripe-credit.js";

// ── Legacy functional API — wraps the SqliteAccountStore per db ────────

export function getOrCreateAccount(db: DatabaseDriver, motebitId: string): VirtualAccount {
  return sqliteAccountStoreFor(db).getOrCreateAccount(motebitId);
}

export function getAccountBalance(db: DatabaseDriver, motebitId: string): VirtualAccount | null {
  return sqliteAccountStoreFor(db).getAccount(motebitId);
}

export function getAccountBalanceDetailed(
  db: DatabaseDriver,
  motebitId: string,
): AccountBalanceDetail {
  return pkgGetAccountBalanceDetailed(sqliteAccountStoreFor(db), motebitId);
}

export function computeDisputeWindowHold(db: DatabaseDriver, motebitId: string): number {
  return sqliteAccountStoreFor(db).getUnwithdrawableHold(motebitId);
}

export function creditAccount(
  db: DatabaseDriver,
  motebitId: string,
  amount: number,
  type: TransactionType,
  referenceId: string | null,
  description: string | null,
): number {
  const newBalance = sqliteAccountStoreFor(db).credit(
    motebitId,
    amount,
    type,
    referenceId,
    description,
  );
  logger.info("account.credit", {
    motebitId,
    amount,
    type,
    balanceAfter: newBalance,
    referenceId,
  });
  return newBalance;
}

export function debitAccount(
  db: DatabaseDriver,
  motebitId: string,
  amount: number,
  type: TransactionType,
  referenceId: string | null,
  description: string | null,
): number | null {
  const newBalance = sqliteAccountStoreFor(db).debit(
    motebitId,
    amount,
    type,
    referenceId,
    description,
  );
  if (newBalance !== null) {
    logger.info("account.debit", {
      motebitId,
      amount,
      type,
      balanceAfter: newBalance,
      referenceId,
    });
  }
  return newBalance;
}

export function getTransactions(
  db: DatabaseDriver,
  motebitId: string,
  limit: number = 50,
): AccountTransaction[] {
  return sqliteAccountStoreFor(db).getTransactions(motebitId, limit);
}

export function hasTransactionWithReference(
  db: DatabaseDriver,
  motebitId: string,
  referenceId: string,
): boolean {
  return sqliteAccountStoreFor(db).hasDepositWithReference(motebitId, referenceId);
}

export function requestWithdrawal(
  db: DatabaseDriver,
  motebitId: string,
  amount: number,
  destination: string = "pending",
  idempotencyKey?: string,
): WithdrawalRequest | null | { existing: WithdrawalRequest } {
  return pkgRequestWithdrawal(sqliteAccountStoreFor(db), {
    motebitId,
    amountMicro: amount,
    destination,
    idempotencyKey,
    logger,
  });
}

export function linkWithdrawalTransfer(
  db: DatabaseDriver,
  withdrawalId: string,
  payoutReference: string,
): boolean {
  return sqliteAccountStoreFor(db).linkWithdrawalTransfer(withdrawalId, payoutReference);
}

export function completeWithdrawal(
  db: DatabaseDriver,
  withdrawalId: string,
  payoutReference: string,
  relaySignature?: string,
  relayPublicKey?: string,
  completedAt?: number,
): boolean {
  return pkgCompleteWithdrawal(sqliteAccountStoreFor(db), {
    withdrawalId,
    payoutReference,
    relaySignature,
    relayPublicKey,
    completedAt,
    logger,
  });
}

export function signWithdrawalReceipt(
  withdrawal: WithdrawalReceiptPayload,
  privateKey: Uint8Array,
): Promise<string> {
  return pkgSignWithdrawalReceipt(withdrawal, privateKey);
}

export function failWithdrawal(db: DatabaseDriver, withdrawalId: string, reason: string): boolean {
  return pkgFailWithdrawal(sqliteAccountStoreFor(db), withdrawalId, reason, logger);
}

export function getWithdrawals(
  db: DatabaseDriver,
  motebitId: string,
  limit: number = 50,
): WithdrawalRequest[] {
  return sqliteAccountStoreFor(db).getWithdrawals(motebitId, limit);
}

export function getPendingWithdrawals(db: DatabaseDriver): WithdrawalRequest[] {
  return sqliteAccountStoreFor(db).getPendingWithdrawalsAdmin();
}
