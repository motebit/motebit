/**
 * Chain-decided withdrawal payouts (#949, #945, #990) — a Path 0 payout is
 * decided by CONSENSUS RULES, never by what an RPC fails to report.
 *
 * Five review rounds (#949) each found another way an RPC's ABSENCE (or
 * unfinalized) reading misleads: pruned history, a missing slot, BigTable's
 * swallowed errors, cleanup lag, a snapshot jump — and finally that released
 * agave's `getSignatureStatuses` ignores `commitment` and `minContextSlot`
 * altogether and answers from the processed bank, minority forks included.
 * Nothing built on reported absence closes. #990 decides by two facts that
 * are consensus rules, not RPC behaviour:
 *
 *   1. A durable-nonce transaction can land only while the nonce account
 *      holds the nonce value it was signed over, and landing — success OR
 *      failure — advances the nonce (agave `svm/src/rollback_accounts.rs`:
 *      a failed transaction's nonce account is stored already advanced). So
 *      of all the transactions signed over one nonce value, at most ONE ever
 *      lands, and none ever expires.
 *   2. A status whose per-status `confirmationStatus` is `finalized` is final
 *      (`rpc.rs` `get_transaction_status` / `is_finalized`: at or below the
 *      highest super-majority root, on the rooted path; the history branch
 *      returns rooted statuses only, marked `Finalized`).
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
 *     its signature, `kind` (`payout` | `kill`), the durable nonce it was
 *     signed over (`nonce_account`, `nonce_value`; NULL on a blockhash
 *     payout an earlier build signed, whose `last_valid_block_height` is
 *     set instead), and its FINALIZED status once read (`final_status`
 *     `ok` | `err`, `final_slot`, `final_checked_at` — a finalized status
 *     never changes, so it is recorded once and never read again).
 *   - `relay_withdrawal_payout_queue` — Path 0 withdrawals waiting for the
 *     nonce lane (busy with an undecided payout, or unavailable). They stay
 *     `pending` — the operator's /fail still works — and the resolution loop
 *     fires them once the lane is free.
 *
 * The verdict (`readChainVerdict`) — positive evidence only:
 *
 *   - PAID: a payout found `finalized` without error.
 *   - NOT PAID: nothing was ever broadcast; or the durable payout found
 *     `finalized` WITH an error (it consumed its nonce and moved nothing);
 *     or a KILL — `nonceAdvance` alone over the payout's nonce value, signed
 *     by the treasury — found `finalized` (it consumed the nonce, so the
 *     payout never can land).
 *   - Everything else — absent, found but not finalized, unreadable — is
 *     UNDECIDED: no decision, read again later. Never absence as evidence.
 *
 * Neither table carries an identity column: both are keyed by the
 * withdrawal, whose own row carries the owner.
 */

import type { DatabaseDriver } from "@motebit/persistence";
import type {
  DurableBroadcastHooks,
  DurableNonceLane,
  DurableTransactionRef,
  FinalizedSignatureStatus,
  NonceKillResult,
  NonceLaneState,
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
      last_valid_block_height INTEGER,
      recorded_at INTEGER NOT NULL,
      seen_in_block INTEGER NOT NULL DEFAULT 0,
      kind TEXT NOT NULL DEFAULT 'payout',
      nonce_account TEXT,
      nonce_value TEXT,
      nonce_observed_slot INTEGER,
      final_status TEXT,
      final_slot INTEGER,
      final_checked_at INTEGER,
      PRIMARY KEY (withdrawal_id, signature)
    );
    CREATE INDEX IF NOT EXISTS idx_payout_attempts_nonce
      ON relay_withdrawal_payout_attempts (nonce_account, nonce_value);
    CREATE TABLE IF NOT EXISTS relay_withdrawal_payout_queue (
      withdrawal_id TEXT PRIMARY KEY,
      queued_at INTEGER NOT NULL
    );
  `);
  // #990: the durable-nonce and finalized-status columns, added to tables
  // an earlier build of this record created. (Columns an earlier build
  // added and no longer read are left in place.)
  const cols = new Set(
    (
      db.prepare("PRAGMA table_info(relay_withdrawal_payout_attempts)").all() as Array<{
        name: string;
      }>
    ).map((c) => c.name),
  );
  const added: Array<[string, string]> = [
    ["kind", "TEXT NOT NULL DEFAULT 'payout'"],
    ["nonce_account", "TEXT"],
    ["nonce_value", "TEXT"],
    ["nonce_observed_slot", "INTEGER"],
    ["final_status", "TEXT"],
    ["final_slot", "INTEGER"],
    ["final_checked_at", "INTEGER"],
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
 * Record one durable transaction (a payout or its kill) BEFORE it is
 * broadcast — the adapter's `beforeBroadcast`. Throws on failure, and a
 * throwing hook stops the send. Re-recording the same signature is a no-op
 * (a re-broadcast kill is the identical, deterministically signed tx).
 */
export function recordDurableAttempt(
  db: DatabaseDriver,
  withdrawalId: string,
  tx: DurableTransactionRef,
  recordedAt: number,
): void {
  db.prepare(
    `INSERT INTO relay_withdrawal_payout_attempts
       (withdrawal_id, signature, recorded_at, kind, nonce_account, nonce_value, nonce_observed_slot)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (withdrawal_id, signature) DO NOTHING`,
  ).run(
    withdrawalId,
    tx.signature,
    recordedAt,
    tx.kind,
    tx.nonceAccount,
    tx.nonceValue,
    tx.nonceObservedSlot ?? null,
  );
}

export interface PayoutAttempt {
  signature: string;
  kind: "payout" | "kill";
  nonce_account: string | null;
  nonce_value: string | null;
  /** The finalized slot the payout's nonce value was observed at (#990 round 8). */
  nonce_observed_slot: number | null;
  recorded_at: number;
  last_valid_block_height: number | null;
  final_status: "ok" | "err" | null;
  final_slot: number | null;
}

export function getPayoutAttempts(db: DatabaseDriver, withdrawalId: string): PayoutAttempt[] {
  return db
    .prepare(
      `SELECT signature, kind, nonce_account, nonce_value, nonce_observed_slot, recorded_at,
              last_valid_block_height, final_status, final_slot
         FROM relay_withdrawal_payout_attempts
        WHERE withdrawal_id = ?
        ORDER BY recorded_at ASC, signature ASC`,
    )
    .all(withdrawalId) as PayoutAttempt[];
}

/** Record a FINALIZED status — once; a finalized status never changes. */
function recordFinal(
  db: DatabaseDriver,
  withdrawalId: string,
  signature: string,
  ok: boolean,
  slot: number,
): void {
  db.prepare(
    `UPDATE relay_withdrawal_payout_attempts
        SET final_status = ?, final_slot = ?, final_checked_at = ?
      WHERE withdrawal_id = ? AND signature = ? AND final_status IS NULL`,
  ).run(ok ? "ok" : "err", slot, Date.now(), withdrawalId, signature);
}

/** Is this nonce value already carried by a recorded transaction (the lane is busy)? */
export function isNonceValueUsed(db: DatabaseDriver, lane: DurableNonceLane): boolean {
  return (
    db
      .prepare(
        "SELECT 1 AS one FROM relay_withdrawal_payout_attempts WHERE nonce_account = ? AND nonce_value = ? LIMIT 1",
      )
      .get(lane.account, lane.nonceValue) !== undefined
  );
}

// ── the queue ────────────────────────────────────────────────────────────

export function enqueuePayout(db: DatabaseDriver, withdrawalId: string, at: number): void {
  db.prepare(
    "INSERT INTO relay_withdrawal_payout_queue (withdrawal_id, queued_at) VALUES (?, ?) ON CONFLICT (withdrawal_id) DO NOTHING",
  ).run(withdrawalId, at);
}

export function dequeuePayout(db: DatabaseDriver, withdrawalId: string): void {
  db.prepare("DELETE FROM relay_withdrawal_payout_queue WHERE withdrawal_id = ?").run(withdrawalId);
}

export function queuedPayouts(db: DatabaseDriver, limit = 50): string[] {
  return (
    db
      .prepare(
        "SELECT withdrawal_id FROM relay_withdrawal_payout_queue ORDER BY queued_at ASC, withdrawal_id ASC LIMIT ?",
      )
      .all(limit) as Array<{ withdrawal_id: string }>
  ).map((r) => r.withdrawal_id);
}

// ── reads, bounded ───────────────────────────────────────────────────────

/** Per-call timeout on every chain read the relay makes here (#990). */
export const CHAIN_READ_TIMEOUT_MS = 10_000;

/** `p`, or a rejection after `ms` — a hung RPC call never holds a loop. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** Run `fn` over `items`, at most `limit` at a time. */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/** The read the verdict needs — `OperatorSolanaTransfer` satisfies it. */
export interface FinalityReader {
  getFinalizedStatus(signature: string): Promise<FinalizedSignatureStatus>;
}

/** The reads and the broadcast a kill needs — `OperatorSolanaTransfer` satisfies it. */
export interface NonceKiller {
  readNonceAccount(account: string, opts?: { minContextSlot?: number }): Promise<NonceLaneState>;
  broadcastNonceKill(
    lane: DurableNonceLane,
    hooks?: DurableBroadcastHooks,
  ): Promise<NonceKillResult>;
}

export type ChainVerdict =
  | { kind: "paid"; signature: string; slot: number; landed: string[] }
  | {
      kind: "not_paid";
      attempts: number;
      /** What proves it: nothing broadcast, the payout failed, or a kill consumed its nonce. */
      by: "no_broadcast" | "payout_failed" | "killed";
    }
  | {
      kind: "undecided";
      /** `pending`: nothing finalized yet; `rpc_error`: a read failed (precedence over pending). */
      reason: "pending" | "rpc_error";
      /** The payout's signature. */
      signature: string;
      /** A durable payout: a kill can make it decidable. False for a blockhash payout. */
      killable: boolean;
      /** Recorded transactions found but not yet finalized. */
      unfinalized: string[];
      detail?: string;
    };

/**
 * What the chain says about a chain-recorded payout — from FINALIZED statuses
 * only. Reads every recorded transaction not yet finalized (bounded
 * concurrency, a timeout per read) and records each finalized status.
 */
export async function readChainVerdict(
  db: DatabaseDriver,
  withdrawalId: string,
  reader: FinalityReader,
  opts: { timeoutMs?: number; concurrency?: number } = {},
): Promise<ChainVerdict> {
  const attempts = getPayoutAttempts(db, withdrawalId);
  if (attempts.length === 0) return { kind: "not_paid", attempts: 0, by: "no_broadcast" };
  const timeoutMs = opts.timeoutMs ?? CHAIN_READ_TIMEOUT_MS;
  const unfinalized: string[] = [];
  let rpcError: string | undefined;
  await mapBounded(
    attempts.filter((a) => a.final_status === null),
    opts.concurrency ?? 4,
    async (a) => {
      let st: FinalizedSignatureStatus;
      try {
        st = await withTimeout(
          reader.getFinalizedStatus(a.signature),
          timeoutMs,
          "finalized status",
        );
      } catch (err) {
        st = {
          status: "unknown",
          reason: "rpc_error",
          detail: err instanceof Error ? err.message : String(err),
        };
      }
      if (st.status === "finalized") {
        recordFinal(db, withdrawalId, a.signature, st.ok, st.slot);
        a.final_status = st.ok ? "ok" : "err";
        a.final_slot = st.slot;
      } else if (st.reason === "not_finalized") {
        unfinalized.push(a.signature);
      } else if (st.reason === "rpc_error") {
        rpcError ??= st.detail ?? "unreadable";
      }
    },
  );

  const payouts = attempts.filter((a) => a.kind === "payout");
  const kills = attempts.filter((a) => a.kind === "kill");
  const landed = payouts.filter((a) => a.final_status === "ok");
  if (landed.length > 0) {
    return {
      kind: "paid",
      signature: landed[0]!.signature,
      slot: landed[0]!.final_slot ?? 0,
      landed: landed.map((l) => l.signature),
    };
  }
  const durable = payouts.find((a) => a.nonce_value !== null && a.nonce_account !== null);
  if (durable) {
    // One nonce value, at most one landing: the payout failing, or a kill
    // over the SAME nonce value landing, proves the payout never can.
    if (durable.final_status === "err") {
      return { kind: "not_paid", attempts: attempts.length, by: "payout_failed" };
    }
    const killedBy = kills.find(
      (k) =>
        k.final_status !== null &&
        k.nonce_account === durable.nonce_account &&
        k.nonce_value === durable.nonce_value,
    );
    if (killedBy) return { kind: "not_paid", attempts: attempts.length, by: "killed" };
  } else if (payouts.length > 0 && payouts.every((a) => a.final_status === "err")) {
    // A blockhash payout (an earlier build): each found finalized and failed.
    return { kind: "not_paid", attempts: attempts.length, by: "payout_failed" };
  }
  const first = durable ?? payouts[0] ?? attempts[0]!;
  return {
    kind: "undecided",
    reason: rpcError !== undefined ? "rpc_error" : "pending",
    signature: first.signature,
    killable: durable !== undefined,
    unfinalized,
    ...(rpcError !== undefined ? { detail: rpcError } : {}),
  };
}

/** Nonce values recorded on `account` before `before` (older than any value recorded later). */
export function earlierNonceValues(
  db: DatabaseDriver,
  account: string,
  before: number,
): Set<string> {
  return new Set(
    (
      db
        .prepare(
          "SELECT DISTINCT nonce_value FROM relay_withdrawal_payout_attempts WHERE nonce_account = ? AND recorded_at < ? AND nonce_value IS NOT NULL",
        )
        .all(account, before) as Array<{ nonce_value: string }>
    ).map((r) => r.nonce_value),
  );
}

/** The highest finalized slot any recorded nonce value was observed at — the floor of every lane read. */
export function laneReadFloor(db: DatabaseDriver): number | undefined {
  const row = db
    .prepare("SELECT MAX(nonce_observed_slot) AS m FROM relay_withdrawal_payout_attempts")
    .get() as { m: number | null } | undefined;
  return row?.m ?? undefined;
}

export type KillRequest =
  /** The kill was broadcast (or re-broadcast); a finalized kill will decide it. */
  | { status: "sent" }
  /** The RPC refused it (e.g. the nonce already advanced at processed) — proves nothing. */
  | { status: "not_sent"; detail: string }
  /**
   * The nonce has PROVABLY moved past the payout's value (#990 round 8): read
   * at finalized from a bank at or after the slot the value was observed at,
   * holding a value that is neither the payout's nor any value this relay
   * recorded earlier on that account. The payout can never land.
   */
  | { status: "consumed" }
  /**
   * The read proves nothing: a node behind the observed slot, or an older
   * value this relay recorded earlier (a stale bank), or a payout recorded
   * without its observed slot. Never "consumed".
   */
  | { status: "stale"; detail: string }
  | { status: "lane_unavailable"; detail: string }
  /** A blockhash payout: no kill exists. */
  | { status: "not_killable" };

/**
 * Broadcast the kill for a durable payout (#990): `nonceAdvance` alone, over
 * the payout's own nonce value, recorded before it is sent. Safe at ANY time
 * — only one transaction over that nonce value can land, so the kill and the
 * payout race and exactly one wins; the refund waits for the kill's
 * FINALIZED status.
 */
export async function requestKill(
  db: DatabaseDriver,
  withdrawalId: string,
  killer: NonceKiller,
  opts: { timeoutMs?: number } = {},
): Promise<KillRequest> {
  const payout = getPayoutAttempts(db, withdrawalId).find(
    (a) => a.kind === "payout" && a.nonce_account !== null && a.nonce_value !== null,
  );
  if (!payout || payout.nonce_account === null || payout.nonce_value === null) {
    return { status: "not_killable" };
  }
  const observed = payout.nonce_observed_slot;
  if (observed === null) {
    return { status: "stale", detail: "the payout was recorded without its observed slot" };
  }
  const timeoutMs = opts.timeoutMs ?? CHAIN_READ_TIMEOUT_MS;
  // The payout's OWN nonce account (#990 round 8, P-a): a seed rotation moves
  // the current lane, never this payout — the treasury is authority of every
  // lane it created. Read at or after the slot its value was observed at.
  let lane: NonceLaneState;
  try {
    lane = await withTimeout(
      killer.readNonceAccount(payout.nonce_account, { minContextSlot: observed }),
      timeoutMs,
      "nonce account",
    );
  } catch (err) {
    lane = { status: "unavailable", reason: err instanceof Error ? err.message : String(err) };
  }
  if (lane.status !== "ready") return { status: "lane_unavailable", detail: lane.reason };
  if (lane.observedSlot === undefined || lane.observedSlot < observed) {
    return { status: "stale", detail: `read from slot ${lane.observedSlot ?? "?"} < ${observed}` };
  }
  if (lane.nonceValue !== payout.nonce_value) {
    // Belt and braces: a value this relay recorded EARLIER on this account is
    // older than N — a stale bank, never proof that N was consumed.
    if (earlierNonceValues(db, payout.nonce_account, payout.recorded_at).has(lane.nonceValue)) {
      return { status: "stale", detail: "the read shows an older recorded nonce value" };
    }
    return { status: "consumed" };
  }
  let result: NonceKillResult;
  try {
    result = await withTimeout(
      killer.broadcastNonceKill(
        { account: payout.nonce_account, nonceValue: payout.nonce_value, observedSlot: observed },
        { beforeBroadcast: (tx) => recordDurableAttempt(db, withdrawalId, tx, Date.now()) },
      ),
      timeoutMs,
      "kill broadcast",
    );
  } catch (err) {
    return { status: "not_sent", detail: err instanceof Error ? err.message : String(err) };
  }
  return result.sent ? { status: "sent" } : { status: "not_sent", detail: result.detail ?? "" };
}

/**
 * The resolution loop's cadence. Each tick fires queued payouts when the
 * lane is free and decides every processing payout it can (budget.ts).
 */
export const PAYOUT_RESOLUTION_INTERVAL_MS = 10_000;

/** Supervised, single-flight payout-resolution loop. */
export function startPayoutResolutionLoop(
  resolveOnce: () => Promise<void>,
  isFrozen: () => boolean,
  supervisor?: LoopSupervisor,
  intervalMs = PAYOUT_RESOLUTION_INTERVAL_MS,
): ReturnType<typeof setInterval> {
  let running = false;
  return superviseInterval(
    supervisor,
    "withdrawal-payout-resolution",
    intervalMs,
    async () => {
      if (running) return;
      running = true;
      try {
        await resolveOnce();
      } finally {
        running = false;
      }
    },
    { isFrozen },
  );
}
