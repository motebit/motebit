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
 *     its signature and `lastValidBlockHeight`, `seen_in_block` once any
 *     read has reported it in a block, and its durable VERDICT once one is
 *     read (`fresh_verdict`, `fresh_context_slot`, `fresh_landed_slot`,
 *     `fresh_checked_at`).
 *
 * The verdict (`readChainVerdict`) — from POSITIVE chain evidence only
 * (#949 round 5). Absence of a transaction in HISTORY is never evidence of
 * non-payment: a node's historical lookup reads a pruned range, a snapshot
 * jump or a swallowed BigTable error as absent. Per recorded attempt:
 *
 *   - `landed` — a status found without error ⇒ PAID by that signature;
 *   - dead — a status found WITH an error, or the FRESH verdict
 *     (`getFreshSignatureVerdict`: the finalized status cache, read without
 *     a history search, bound by minContextSlot, inside the window where it
 *     still covers the whole landing range) says it never landed and never
 *     can. Recorded DURABLY on the attempt the moment it is read, because
 *     the window closes about a minute after the transaction expires and no
 *     later read can prove it again;
 *   - otherwise UNKNOWN — still able to land, or its window not yet open
 *     (`pending`), unreadable (`rpc_error`), or past its fresh window with
 *     no positive evidence recorded (`no_positive_evidence`: nothing the
 *     chain can show will ever prove it did not land).
 *
 * The payout is NOT PAID only when every attempt is dead (or none was ever
 * signed). A supervised sweep (`startFreshVerdictLoop`) takes the fresh
 * verdict for every attempt of a processing payout while its window is open,
 * so the evidence exists when the operator later reconciles.
 *
 * Neither table carries an identity column: both are keyed by the
 * withdrawal, whose own row carries the owner.
 */

import type { DatabaseDriver } from "@motebit/persistence";
import type {
  FreshSignatureVerdict,
  SignatureOutcome,
  SignedTransactionRef,
} from "@motebit/wallet-solana";
import { superviseInterval, type LoopSupervisor } from "./loop-supervisor.js";

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
      fresh_verdict TEXT,
      fresh_context_slot INTEGER,
      fresh_landed_slot INTEGER,
      fresh_checked_at INTEGER,
      PRIMARY KEY (withdrawal_id, signature)
    );
  `);
  // #949 round 5: the durable per-attempt verdict — added to tables created
  // by an earlier build of this record. (An earlier build's `recent_slot`
  // column, if present, is left in place and never read.)
  const cols = new Set(
    (
      db.prepare("PRAGMA table_info(relay_withdrawal_payout_attempts)").all() as Array<{
        name: string;
      }>
    ).map((c) => c.name),
  );
  const added: Array<[string, string]> = [
    ["fresh_verdict", "TEXT"],
    ["fresh_context_slot", "INTEGER"],
    ["fresh_landed_slot", "INTEGER"],
    ["fresh_checked_at", "INTEGER"],
  ];
  for (const [name, type] of added) {
    if (!cols.has(name)) {
      db.exec(`ALTER TABLE relay_withdrawal_payout_attempts ADD COLUMN ${name} ${type}`);
    }
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
       (withdrawal_id, signature, last_valid_block_height, recorded_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (withdrawal_id, signature) DO NOTHING`,
  ).run(withdrawalId, tx.signature, tx.lastValidBlockHeight, recordedAt);
}

/**
 * A recorded attempt's durable verdict (#949 round 5): `landed`, `failed`
 * and `dead_fresh` are POSITIVE evidence and final; `window_passed` records
 * that the fresh window closed with no positive evidence — only a later
 * found status can replace it.
 */
export type RecordedVerdict = "landed" | "failed" | "dead_fresh" | "window_passed";

export interface PayoutAttempt {
  signature: string;
  last_valid_block_height: number;
  seen_in_block: number;
  fresh_verdict: RecordedVerdict | null;
  fresh_context_slot: number | null;
  fresh_landed_slot: number | null;
}

export function getPayoutAttempts(db: DatabaseDriver, withdrawalId: string): PayoutAttempt[] {
  return db
    .prepare(
      `SELECT signature, last_valid_block_height, seen_in_block, fresh_verdict,
              fresh_context_slot, fresh_landed_slot
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

/**
 * Persist a verdict on an attempt — at the moment it is read. A positive
 * verdict is final (never overwritten); `window_passed` yields only to a
 * positive one.
 */
function persistVerdict(
  db: DatabaseDriver,
  withdrawalId: string,
  signature: string,
  verdict: RecordedVerdict,
  contextSlot: number | null,
  landedSlot: number | null,
): void {
  db.prepare(
    `UPDATE relay_withdrawal_payout_attempts
        SET fresh_verdict = ?, fresh_context_slot = ?, fresh_landed_slot = ?, fresh_checked_at = ?
      WHERE withdrawal_id = ? AND signature = ?
        AND (fresh_verdict IS NULL OR fresh_verdict = 'window_passed')`,
  ).run(verdict, contextSlot, landedSlot, Date.now(), withdrawalId, signature);
}

/** The reads the verdict needs — `OperatorSolanaTransfer` satisfies it. */
export interface SignatureOutcomeReader {
  /** History read — trusted for FOUND statuses only (landed / failed). */
  getSignatureOutcome(tx: SignedTransactionRef): Promise<SignatureOutcome>;
  /** The fresh verdict — the only read from which "never landed" is concluded. */
  getFreshSignatureVerdict(tx: SignedTransactionRef): Promise<FreshSignatureVerdict>;
}

export type ChainVerdict =
  | { kind: "paid"; signature: string; slot: number; landed: string[] }
  | { kind: "not_paid"; attempts: number }
  | {
      kind: "undecided";
      /**
       * `pending`: an attempt can still land, or its fresh window has not
       * opened; `rpc_error`: an attempt could not be read;
       * `no_positive_evidence`: an attempt's fresh window closed with no
       * positive evidence recorded — nothing the chain can show will ever
       * prove it did not land (#949 round 5; the honest-path cost, #990).
       * Precedence: pending > rpc_error > no_positive_evidence.
       */
      reason: "pending" | "rpc_error" | "no_positive_evidence";
      signature: string;
      lastValidBlockHeight: number;
      detail?: string;
    };

type AttemptVerdict =
  | { kind: "landed"; slot: number }
  | { kind: "dead" }
  | { kind: "pending" }
  | { kind: "rpc_error"; detail: string }
  | { kind: "no_positive_evidence" };

function refOf(a: PayoutAttempt): SignedTransactionRef {
  return { signature: a.signature, lastValidBlockHeight: a.last_valid_block_height };
}

/**
 * Take the fresh verdict for one attempt with no positive verdict on file,
 * and record it at once.
 */
async function takeFreshVerdict(
  db: DatabaseDriver,
  withdrawalId: string,
  a: PayoutAttempt,
  reader: SignatureOutcomeReader,
): Promise<AttemptVerdict> {
  let fresh: FreshSignatureVerdict;
  try {
    fresh = await reader.getFreshSignatureVerdict(refOf(a));
  } catch (err) {
    fresh = { status: "rpc_error", reason: err instanceof Error ? err.message : String(err) };
  }
  switch (fresh.status) {
    case "landed":
      persistVerdict(db, withdrawalId, a.signature, "landed", fresh.contextSlot, fresh.slot);
      return { kind: "landed", slot: fresh.slot };
    case "failed":
      persistVerdict(db, withdrawalId, a.signature, "failed", fresh.contextSlot, null);
      return { kind: "dead" };
    case "dead_fresh":
      persistVerdict(db, withdrawalId, a.signature, "dead_fresh", fresh.contextSlot, null);
      return { kind: "dead" };
    case "too_early":
      return { kind: "pending" };
    case "window_passed":
      persistVerdict(db, withdrawalId, a.signature, "window_passed", null, null);
      return { kind: "no_positive_evidence" };
    case "rpc_error":
      return { kind: "rpc_error", detail: fresh.reason };
  }
}

async function attemptVerdict(
  db: DatabaseDriver,
  withdrawalId: string,
  a: PayoutAttempt,
  reader: SignatureOutcomeReader,
): Promise<AttemptVerdict> {
  // A positive verdict on file is final.
  if (a.fresh_verdict === "landed" && a.fresh_landed_slot !== null) {
    return { kind: "landed", slot: a.fresh_landed_slot };
  }
  if (a.fresh_verdict === "failed" || a.fresh_verdict === "dead_fresh") return { kind: "dead" };

  // History — FOUND statuses only. Its absence (`expired`, `pending`) is
  // never read as dead; only the fresh verdict below may conclude that.
  let history: SignatureOutcome;
  try {
    history = await reader.getSignatureOutcome(refOf(a));
  } catch (err) {
    history = { status: "rpc_error", reason: err instanceof Error ? err.message : String(err) };
  }
  if (history.status === "landed") {
    persistVerdict(db, withdrawalId, a.signature, "landed", null, history.slot);
    return { kind: "landed", slot: history.slot };
  }
  if (history.status === "failed") {
    persistVerdict(db, withdrawalId, a.signature, "failed", null, null);
    return { kind: "dead" };
  }
  if (history.status === "pending" && history.seen === true) {
    markAttemptSeen(db, withdrawalId, a.signature);
  }
  if (a.fresh_verdict === "window_passed") return { kind: "no_positive_evidence" };
  return takeFreshVerdict(db, withdrawalId, a, reader);
}

/**
 * What the chain says about a chain-recorded payout. Reads every recorded
 * attempt (so a landed one is found wherever it is) and records every
 * verdict it reads.
 */
export async function readChainVerdict(
  db: DatabaseDriver,
  withdrawalId: string,
  reader: SignatureOutcomeReader,
): Promise<ChainVerdict> {
  const attempts = getPayoutAttempts(db, withdrawalId);
  const landed: Array<{ signature: string; slot: number }> = [];
  const undecided: Array<Extract<ChainVerdict, { kind: "undecided" }>> = [];
  for (const a of attempts) {
    const v = await attemptVerdict(db, withdrawalId, a, reader);
    const base = {
      kind: "undecided" as const,
      signature: a.signature,
      lastValidBlockHeight: a.last_valid_block_height,
    };
    switch (v.kind) {
      case "landed":
        landed.push({ signature: a.signature, slot: v.slot });
        break;
      case "dead":
        break;
      case "pending":
        undecided.push({ ...base, reason: "pending" });
        break;
      case "rpc_error":
        undecided.push({ ...base, reason: "rpc_error", detail: v.detail });
        break;
      case "no_positive_evidence":
        undecided.push({ ...base, reason: "no_positive_evidence" });
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
  const rank = { pending: 0, rpc_error: 1, no_positive_evidence: 2 } as const;
  const worst = undecided.sort((x, y) => rank[x.reason] - rank[y.reason])[0];
  if (worst) return worst;
  return { kind: "not_paid", attempts: attempts.length };
}

/**
 * One pass of the fresh-verdict sweep (#949 round 5): for every attempt of a
 * `processing`, chain-recorded withdrawal with no verdict on file, take the
 * fresh verdict and record it. Evidence only — it never settles a
 * withdrawal; the operator's reconcile reads what it recorded. Returns the
 * number of attempts read.
 */
export async function runFreshVerdictSweep(
  db: DatabaseDriver,
  reader: SignatureOutcomeReader,
  limit = 200,
): Promise<number> {
  const rows = db
    .prepare(
      `SELECT a.withdrawal_id AS withdrawal_id, a.signature AS signature,
              a.last_valid_block_height AS last_valid_block_height,
              a.seen_in_block AS seen_in_block, a.fresh_verdict AS fresh_verdict,
              a.fresh_context_slot AS fresh_context_slot,
              a.fresh_landed_slot AS fresh_landed_slot
         FROM relay_withdrawal_payout_attempts a
         JOIN relay_withdrawal_chain_claims c ON c.withdrawal_id = a.withdrawal_id
         JOIN relay_withdrawals w ON w.withdrawal_id = a.withdrawal_id
        WHERE w.status = 'processing' AND a.fresh_verdict IS NULL
        ORDER BY a.recorded_at ASC, a.signature ASC
        LIMIT ?`,
    )
    .all(limit) as Array<PayoutAttempt & { withdrawal_id: string }>;
  for (const row of rows) {
    await takeFreshVerdict(db, row.withdrawal_id, row, reader);
  }
  return rows.length;
}

/**
 * The sweep's cadence. The fresh window is FRESH_WINDOW_END −
 * FRESH_WINDOW_START + 1 = 120 finalized blocks (about 48 s at 400 ms per
 * block), so a 10 s cadence reads each attempt inside it several times over.
 */
export const FRESH_VERDICT_INTERVAL_MS = 10_000;

/** Supervised fresh-verdict loop; single-flight. */
export function startFreshVerdictLoop(
  db: DatabaseDriver,
  reader: SignatureOutcomeReader,
  isFrozen: () => boolean,
  supervisor?: LoopSupervisor,
  intervalMs = FRESH_VERDICT_INTERVAL_MS,
): ReturnType<typeof setInterval> {
  let running = false;
  return superviseInterval(
    supervisor,
    "withdrawal-fresh-verdict",
    intervalMs,
    async () => {
      if (running) return;
      running = true;
      try {
        await runFreshVerdictSweep(db, reader);
      } finally {
        running = false;
      }
    },
    { isFrozen },
  );
}
