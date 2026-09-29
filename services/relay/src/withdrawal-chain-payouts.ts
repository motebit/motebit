/**
 * Chain-recorded withdrawal payouts (#949, #945) — the relay records every
 * Solana transaction a Path 0 payout signs BEFORE it is broadcast, so whether
 * the payout landed is later decided by asking the chain about exactly those
 * transactions, never by the relay's wall clock.
 *
 * Why not the clock. A Solana transaction is valid until the chain passes
 * its blockhash's `lastValidBlockHeight`. Block HEIGHT, not time: a halted or
 * badly slowed cluster produces no heights, so a transaction signed before
 * the halt is still valid when the cluster resumes — hours later on the
 * relay's clock. The #921 reconcile door opened at "last broadcast + 150s +
 * 5 min" of wall clock; during a halt an operator saw nothing on chain,
 * refunded, and the payout then landed: paid AND refunded (#949).
 *
 * The record:
 *
 *   - `relay_withdrawal_chain_claims` — one row per withdrawal whose payout
 *     is chain-recorded, written in the SAME transaction as the claim
 *     (`pending → processing`). Its presence says: every transaction this
 *     payout ever signed is in the attempts table, because the adapter calls
 *     `beforeBroadcast` for each one before sending it, and a hook that
 *     cannot record stops the send (#885). So "no attempts recorded" means
 *     "nothing was ever broadcast".
 *   - `relay_withdrawal_payout_attempts` — one row per signed transaction:
 *     its signature and `lastValidBlockHeight`, and `seen_in_block` once any
 *     read has reported it in a block (sticky: a later "absent" read for it
 *     is never trusted as expiry — #885 round 5).
 *
 * The verdict (`readChainVerdict`) — from chain facts only:
 *
 *   - any attempt `landed` ⇒ PAID by that signature;
 *   - every attempt `failed` or `expired` (past its last valid height, read
 *     slot-consistently by the adapter; never for a seen attempt), or no
 *     attempt at all ⇒ NOT PAID, and nothing of this payout can ever land;
 *   - otherwise (an attempt still `pending`, or a read failed) ⇒ UNDECIDED:
 *     the reconcile door stays shut, whatever the clock says.
 *
 * Neither table carries an identity column: both are keyed by the
 * withdrawal, whose own row carries the owner.
 */

import type { DatabaseDriver } from "@motebit/persistence";
import { historyCoversLanding } from "@motebit/wallet-solana";
import type { SignatureOutcome, SignedTransactionRef } from "@motebit/wallet-solana";

/** Idempotent. Called from `createWithdrawalTables`. */
export function createWithdrawalChainPayoutTables(db: DatabaseDriver): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS relay_withdrawal_chain_claims (
      withdrawal_id TEXT PRIMARY KEY,
      chain TEXT NOT NULL,
      claimed_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS relay_withdrawal_payout_attempts (
      withdrawal_id TEXT NOT NULL,
      signature TEXT NOT NULL,
      last_valid_block_height INTEGER NOT NULL,
      recorded_at INTEGER NOT NULL,
      seen_in_block INTEGER NOT NULL DEFAULT 0,
      recent_slot INTEGER,
      PRIMARY KEY (withdrawal_id, signature)
    );
  `);
  // #949 round 2: the slot read before the blockhash (the landing window's
  // lower edge) — added to tables created by the first build of this record.
  const cols = db.prepare("PRAGMA table_info(relay_withdrawal_payout_attempts)").all() as Array<{
    name: string;
  }>;
  if (!cols.some((c) => c.name === "recent_slot")) {
    db.exec("ALTER TABLE relay_withdrawal_payout_attempts ADD COLUMN recent_slot INTEGER");
  }
}

/** Record that `withdrawalId`'s payout is chain-recorded. Run inside the claim's transaction. */
export function markChainRecordedClaim(
  db: DatabaseDriver,
  withdrawalId: string,
  chain: "solana",
  claimedAt: number,
): void {
  db.prepare(
    "INSERT INTO relay_withdrawal_chain_claims (withdrawal_id, chain, claimed_at) VALUES (?, ?, ?)",
  ).run(withdrawalId, chain, claimedAt);
}

/** True when the withdrawal's payout was claimed under the chain record. */
export function isChainRecordedClaim(db: DatabaseDriver, withdrawalId: string): boolean {
  return (
    db
      .prepare("SELECT 1 AS one FROM relay_withdrawal_chain_claims WHERE withdrawal_id = ?")
      .get(withdrawalId) !== undefined
  );
}

/**
 * Record one signed transaction BEFORE it is broadcast (the adapter's
 * `beforeBroadcast`). Throws on failure — and a throwing hook stops the send.
 * Re-recording the same signature is a no-op: a re-sign over the same
 * blockhash produces the identical transaction, which can land only once.
 */
export function recordPayoutAttempt(
  db: DatabaseDriver,
  withdrawalId: string,
  tx: SignedTransactionRef,
  recordedAt: number,
): void {
  db.prepare(
    `INSERT INTO relay_withdrawal_payout_attempts
       (withdrawal_id, signature, last_valid_block_height, recorded_at, recent_slot)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (withdrawal_id, signature) DO NOTHING`,
  ).run(
    withdrawalId,
    tx.signature,
    tx.lastValidBlockHeight,
    recordedAt,
    typeof tx.recentSlot === "number" ? tx.recentSlot : null,
  );
}

export interface PayoutAttempt {
  signature: string;
  last_valid_block_height: number;
  seen_in_block: number;
  recent_slot: number | null;
}

export function getPayoutAttempts(db: DatabaseDriver, withdrawalId: string): PayoutAttempt[] {
  return db
    .prepare(
      `SELECT signature, last_valid_block_height, seen_in_block, recent_slot
         FROM relay_withdrawal_payout_attempts
        WHERE withdrawal_id = ?
        ORDER BY recorded_at ASC, signature ASC`,
    )
    .all(withdrawalId) as PayoutAttempt[];
}

function markAttemptSeen(db: DatabaseDriver, withdrawalId: string, signature: string): void {
  db.prepare(
    "UPDATE relay_withdrawal_payout_attempts SET seen_in_block = 1 WHERE withdrawal_id = ? AND signature = ?",
  ).run(withdrawalId, signature);
}

/** The reads the verdict needs — `OperatorSolanaTransfer` satisfies it. */
export interface SignatureOutcomeReader {
  getSignatureOutcome(tx: SignedTransactionRef): Promise<SignatureOutcome>;
  /** The node's first available slot — the lower edge of what "absent" can speak for. */
  getFirstAvailableSlot(): Promise<number>;
}

export type ChainVerdict =
  | { kind: "paid"; signature: string; slot: number; landed: string[] }
  | { kind: "not_paid"; attempts: number }
  | {
      kind: "undecided";
      /**
       * `pending`: an attempt can still land; `rpc_error`: an attempt could
       * not be read; `history_pruned`: an attempt is past its last valid
       * height and the node has no record of it, but the node does not
       * provably hold the slots it could have landed in — it may have LANDED
       * (#949 round 2). Precedence: pending > rpc_error > history_pruned, so
       * `history_pruned` means no undecided attempt can still land or failed
       * to read for any other reason.
       */
      reason: "pending" | "rpc_error" | "history_pruned";
      signature: string;
      lastValidBlockHeight: number;
      detail?: string;
    };

/**
 * What the chain says about a chain-recorded payout. Reads every recorded
 * attempt (so a landed one is found wherever it is); persists `seen` stickily.
 */
export async function readChainVerdict(
  db: DatabaseDriver,
  withdrawalId: string,
  reader: SignatureOutcomeReader,
): Promise<ChainVerdict> {
  const attempts = getPayoutAttempts(db, withdrawalId);
  const landed: Array<{ signature: string; slot: number }> = [];
  const undecided: Array<Extract<ChainVerdict, { kind: "undecided" }>> = [];
  // Read once, lazily: the node's retained-history edge. A failed read means
  // no absence can be proven complete.
  let firstAvailable: number | null | undefined;
  const retainedFrom = async (): Promise<number | null> => {
    if (firstAvailable === undefined) {
      try {
        firstAvailable = await reader.getFirstAvailableSlot();
      } catch {
        firstAvailable = null;
      }
    }
    return firstAvailable;
  };
  for (const a of attempts) {
    const tx: SignedTransactionRef = {
      signature: a.signature,
      lastValidBlockHeight: a.last_valid_block_height,
      ...(a.recent_slot !== null ? { recentSlot: a.recent_slot } : {}),
    };
    let outcome: SignatureOutcome;
    try {
      outcome = await reader.getSignatureOutcome(tx);
    } catch (err) {
      outcome = { status: "rpc_error", reason: err instanceof Error ? err.message : String(err) };
    }
    if (outcome.status === "pending" && outcome.seen === true) {
      markAttemptSeen(db, withdrawalId, a.signature);
      a.seen_in_block = 1;
    }
    // Sticky: a transaction some node reported in a block may still land;
    // an "absent past its height" read for it proves nothing (#885 round 5).
    if (outcome.status === "expired" && a.seen_in_block === 1) {
      outcome = { status: "pending", seen: true };
    }
    // Absence of evidence is evidence of absence only inside the window the
    // node provably retains (#949 round 2). An `expired` is accepted only when
    // the node's first available slot is at or before where this transaction
    // could first land; otherwise (history pruned, the edge unreadable, or the
    // landing window never recorded) a landed payout would read exactly like
    // this, so the verdict is UNKNOWN — never "not landed".
    if (outcome.status === "expired") {
      const first = await retainedFrom();
      if (first === null || !historyCoversLanding(tx, first)) {
        outcome = {
          status: "rpc_error",
          reason:
            first === null
              ? "the node's retained history could not be read"
              : `the node's history starts at slot ${first}, after where ${a.signature} could have landed`,
          historyPruned: true,
        };
      }
    }
    const base = {
      kind: "undecided" as const,
      signature: a.signature,
      lastValidBlockHeight: a.last_valid_block_height,
    };
    switch (outcome.status) {
      case "landed":
        landed.push({ signature: a.signature, slot: outcome.slot });
        break;
      case "failed":
      case "expired":
        break;
      case "pending":
        undecided.push({ ...base, reason: "pending" });
        break;
      case "rpc_error":
        undecided.push({
          ...base,
          reason: outcome.historyPruned === true ? "history_pruned" : "rpc_error",
          detail: outcome.reason,
        });
        break;
    }
  }
  if (landed.length > 0) {
    return {
      kind: "paid",
      signature: landed[0]!.signature,
      slot: landed[0]!.slot,
      landed: landed.map((l) => l.signature),
    };
  }
  const rank = { pending: 0, rpc_error: 1, history_pruned: 2 } as const;
  const worst = undecided.sort((x, y) => rank[x.reason] - rank[y.reason])[0];
  if (worst) return worst;
  return { kind: "not_paid", attempts: attempts.length };
}

/**
 * Blocks past a height this process read before a LEGACY claim's broadcast
 * can be proven dead (#949). A legacy claim was made by an earlier process
 * that recorded no signature; each transaction it broadcast was signed over
 * a blockhash fetched before this process started, whose last valid height
 * is at most that blockhash's height + 150. Any height this process reads is
 * at or above that blockhash's height (up to cross-node lag), so once the
 * chain is 150 + 150 (lag) + 10 (the adapter's absence margin) blocks past
 * the first height this process read, nothing the earlier process signed
 * can land. A halted chain never gets there.
 */
export const LEGACY_BROADCAST_HEIGHT_BOUND = 150 + 150 + 10;
