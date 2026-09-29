/**
 * x402 settlement records — the durable intent behind every x402 settle (#907
 * rounds 2–3).
 *
 * A task submission funded by x402 settles its own verified payment inside
 * the request, just before admission (tasks.ts). The facilitator call can end
 * three ways, and only two of them are knowledge:
 *
 *   - SETTLED: the facilitator returned success with a transaction hash, on
 *     this network, for exactly the authorized amount.
 *   - REFUSED: the facilitator's verdict names a reason in `DEFINITE_REFUSALS`
 *     (a CLOSED set of exact-EVM refusals made before anything is broadcast)
 *     and carries no transaction hash.
 *   - UNKNOWN: everything else — a timeout, a 5xx or non-JSON body, a network
 *     error, a malformed response, `nonce_already_used`, `transaction_failed`
 *     (which `@x402/evm` v2's `parseEip3009TransferError` returns for any
 *     thrown settle error it does not recognise, including a receipt wait that
 *     timed out after broadcast), a reverted or event-mismatched transaction,
 *     a refusal WITH a transaction hash, or a success we cannot attribute.
 *     The transfer may have landed.
 *
 * Before the facilitator is called, the request writes a `pending` record
 * keyed by the EIP-3009 authorization (payer, nonce). It becomes `credited`
 * when this request (or the reconciler) credits the delegator, or `failed` on
 * a definite refusal, or when the chain proves it cancelled or expired
 * unexecuted. An UNKNOWN outcome leaves it `pending`, and the client is told
 * not to pay again.
 *
 * RECONCILIATION CREDITS ONLY ON PROOF OF EXECUTION (#907 round 3). The
 * token's `authorizationState(authorizer, nonce)` bit is set by BOTH
 * `transferWithAuthorization` and `cancelAuthorization` (USDC FiatTokenV2), so
 * reading it lets a payer cancel between verify and settle and be credited
 * for nothing. The reconciler instead reads the events: an
 * `AuthorizationUsed(authorizer, nonce)` log, whose transaction carries a
 * `Transfer(payer → treasury, value)` of exactly the recorded amount, is the
 * proof; an `AuthorizationCanceled(authorizer, nonce)` log is a proven
 * failure; neither, with the confirmed chain head's own timestamp past
 * `validBefore` + margin, is a proven expiry. See `reconcileX402Settlement`.
 *
 * The (payer, nonce) primary key is also the replay defence: one signed
 * authorization is settled and credited at most once, under any key and
 * whatever a facilitator does.
 */

import type { DatabaseDriver } from "@motebit/persistence";
import { creditAccount } from "./accounts.js";
import { createLogger } from "./logger.js";
import { superviseInterval, type LoopSupervisor } from "./loop-supervisor.js";

const logger = createLogger({ service: "x402-settlements" });

export type X402SettlementStatus = "pending" | "credited" | "failed";

/** The EIP-3009 authorization inside an exact-EVM x402 payment payload. */
export interface Eip3009Authorization {
  /** The authorizer (payer), lowercase 0x address. */
  payer: string;
  /** The authorization nonce, lowercase 0x 32-byte hex. */
  nonce: string;
  /** Recipient, lowercase 0x address. */
  to: string;
  /** Value in token atomic units, canonical decimal string. */
  value: string;
  /** Unix seconds after which the authorization may execute (EIP-3009: `block.timestamp > validAfter`). */
  validAfter: number;
  /** Unix seconds after which the authorization can no longer execute. */
  validBefore: number;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const NONCE = /^0x[0-9a-fA-F]{64}$/;
/** A decimal-string non-negative integer: no sign, no fraction, no `0x`, no exponent. */
const DECIMAL_UINT = /^(0|[1-9][0-9]{0,77})$/;

/**
 * Strictly parse an atomic-unit amount: a canonical decimal-string integer
 * that is a safe JS integer, else null. `"0x10"`, `"-1"`, `"1.5"`, `"1e6"`,
 * `"007"` and numbers (not strings) are all refused.
 */
export function parseAtomicAmount(v: unknown): number | null {
  if (typeof v !== "string" || !DECIMAL_UINT.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Read the EIP-3009 authorization from an x402 payment payload, or null when
 * the payload is not an exact-EVM EIP-3009 payment. Only such a payment can be
 * recorded and reconciled, so any other shape is refused before settling.
 * Fields are strings, as the x402 exact-EVM client produces them.
 */
export function readEip3009Authorization(payload: unknown): Eip3009Authorization | null {
  if (payload == null || typeof payload !== "object") return null;
  const auth = (payload as { authorization?: unknown }).authorization;
  if (auth == null || typeof auth !== "object") return null;
  const a = auth as Record<string, unknown>;
  const { from, to, nonce, value, validAfter, validBefore } = a;
  if (typeof from !== "string" || !ADDRESS.test(from)) return null;
  if (typeof to !== "string" || !ADDRESS.test(to)) return null;
  if (typeof nonce !== "string" || !NONCE.test(nonce)) return null;
  if (parseAtomicAmount(value) == null) return null;
  const va = parseAtomicAmount(validAfter);
  const vb = parseAtomicAmount(validBefore);
  if (va == null || vb == null) return null;
  return {
    payer: from.toLowerCase(),
    nonce: nonce.toLowerCase(),
    to: to.toLowerCase(),
    value: value as string,
    validAfter: va,
    validBefore: vb,
  };
}

/**
 * The CLOSED set of facilitator refusals that mean "nothing was broadcast":
 * the exact-EVM facilitator's pre-broadcast verification reasons. Anything
 * else is UNKNOWN. Deliberately absent: `invalid_exact_evm_nonce_already_used`
 * (the authorization was executed or cancelled by someone — possibly this
 * relay's own earlier attempt), `invalid_exact_evm_transaction_failed` (the
 * fallback `parseEip3009TransferError` gives any unrecognised thrown error,
 * including a receipt wait that timed out after broadcast) and
 * `invalid_exact_evm_transfer_event_mismatch` (a transaction landed). A
 * refusal that carries a transaction hash is UNKNOWN whatever its reason.
 */
export const DEFINITE_REFUSALS: ReadonlySet<string> = new Set([
  "insufficient_funds",
  "invalid_exact_evm_insufficient_balance",
  "invalid_exact_evm_signature",
  "invalid_exact_evm_payload_authorization_valid_before",
  "invalid_exact_evm_payload_authorization_valid_after",
  "invalid_exact_evm_payload_authorization_value_mismatch",
  "invalid_exact_evm_authorization_value",
  "invalid_exact_evm_recipient_mismatch",
  "invalid_exact_evm_network_mismatch",
  "invalid_exact_evm_scheme",
  "invalid_exact_evm_missing_eip712_domain",
  "invalid_exact_evm_token_name_mismatch",
  "invalid_exact_evm_token_version_mismatch",
  "invalid_exact_evm_eip3009_not_supported",
  "invalid_exact_evm_transaction_simulation_failed",
  "invalid_scheme",
  "invalid_network",
  "invalid_payload",
  "invalid_payment_requirements",
  "invalid_x402_version",
  "unsupported_scheme",
]);

/**
 * The furthest ahead an authorization's `validBefore` may be when presented
 * (seconds). It is client-chosen; bounding it bounds how long a record can stay
 * pending and how far reconciliation scans. x402 exact-EVM clients sign
 * `now + maxTimeoutSeconds` (300 s by default).
 */
export const X402_MAX_VALIDITY_SECONDS = 3_600;

/**
 * The widest signed execution window, `validBefore − validAfter`, the gate
 * accepts (seconds). EIP-3009 executes only when `validAfter < block.timestamp
 * < validBefore`, so this window — two SIGNED chain-time facts, never the
 * relay's clock — is exactly where reconciliation looks for an execution
 * (#907 round 9). Bounding it bounds the scan: a client choosing
 * `validAfter = 0` is refused, not scanned from genesis. x402 exact-EVM
 * clients sign `validAfter = now − 600` and `validBefore = now +
 * maxTimeoutSeconds` (300 s by default): a 900 s window.
 */
export const X402_MAX_WINDOW_SECONDS = 7_200;

/** How a facilitator settle ended. The credited amount is never taken from here. */
export type SettleOutcome =
  | { kind: "settled"; txHash: string; network: string }
  | { kind: "refused"; reason: string }
  | { kind: "unknown"; reason: string };

/**
 * Classify a facilitator verdict — a returned `SettleResponse`, or the body a
 * thrown `SettleError` carries (the facilitator answered non-2xx with a JSON
 * settle response). A thrown error of any other type is UNKNOWN and never
 * reaches here. A success is `settled` only with a transaction hash, on the
 * expected network, and — when the facilitator reports an amount — exactly
 * the authorized amount (strictly parsed); anything else is UNKNOWN.
 */
export function classifySettleVerdict(
  verdict: {
    success: boolean;
    transaction?: string;
    network?: string;
    amount?: unknown;
    errorReason?: string;
  },
  expected: { network: string; amountMicro: number },
): SettleOutcome {
  const tx = verdict.transaction ?? "";
  if (verdict.success) {
    if (tx === "") return { kind: "unknown", reason: "settled_without_transaction" };
    if (verdict.network !== expected.network) {
      return { kind: "unknown", reason: "settled_on_unexpected_network" };
    }
    if (
      verdict.amount !== undefined &&
      parseAtomicAmount(verdict.amount) !== expected.amountMicro
    ) {
      return { kind: "unknown", reason: "settled_amount_mismatch" };
    }
    return { kind: "settled", txHash: tx, network: verdict.network };
  }
  const reason = verdict.errorReason ?? "";
  if (tx === "" && DEFINITE_REFUSALS.has(reason)) return { kind: "refused", reason };
  return { kind: "unknown", reason: reason === "" ? "settle_failed_without_reason" : reason };
}

export interface X402SettlementRecord {
  payer: string;
  nonce: string;
  network: string;
  token: string;
  pay_to: string;
  /** The authorization's value = the quoted gross (the gate checks both). The only amount ever credited. */
  amount_micro: number;
  /** The authorization's signed validAfter (unix s): where the scan starts. */
  valid_after: number;
  valid_before: number;
  idempotency_key: string;
  motebit_id: string;
  delegator_id: string;
  task_id: string;
  status: X402SettlementStatus;
  tx_hash: string | null;
  failure_reason: string | null;
  created_at: number;
  resolved_at: number | null;
  /** Reconciler cursor: first block of the event scan (null until the first scan). */
  scan_from_block: number | null;
  /** Reconciler cursor: last block scanned (inclusive), never past the confirmed head. */
  scanned_to_block: number | null;
  /** First wall-clock time a complete scan saw it unexecuted past `validBefore`; expiry needs a second. */
  expiry_observed_at: number | null;
  /**
   * CHAIN-time stamps (the confirmed head's own timestamp, unix s) that every
   * wait is measured on (#907 round 10) — the confirmation gap from
   * `expiry_observed_head_ts`, the first re-check from `resolved_head_ts`,
   * each later one at `next_recheck_head_ts`. The wall-clock columns beside
   * them are for the operator's eyes only: a relay clock that ran fast and was
   * corrected would otherwise hold a record back by the size of the jump.
   */
  expiry_observed_head_ts: number | null;
  resolved_head_ts: number | null;
  next_recheck_head_ts: number | null;
  /** Re-checks spent on a `failed` record, and when the next one may run. */
  recheck_count: number;
  next_recheck_at: number | null;
  /** The consumed Transfer log (with `tx_hash`) a reconciled credit rests on; UNIQUE with `tx_hash`. */
  credit_log_index: number | null;
  /** The fixed last block of the scan: first block past `valid_before + margin` (null until the head passes it). */
  scan_end_block: number | null;
  /** Cursor of the current FULL pass (confirming observation or re-check); null when none is in progress. */
  pass_cursor: number | null;
  /** When the reconciler last visited this record (the selection order). */
  last_checked_at: number | null;
  /** Re-checks spent on an `execution_mismatch` — a budget of its own (#907 round 8). */
  mismatch_rechecks: number;
  /**
   * The LATEST chain observation that did not settle the record (#907 round
   * 11): `execution_mismatch` when a used authorization's paired Transfer did
   * not match. `failure_reason` is the record's ORIGINAL failure class and is
   * never rewritten by a re-check, so the two re-check budgets stay
   * orthogonal — a mismatch seen on an expiry re-check ADDS its own re-check,
   * it never replaces the expiry re-checks still left.
   */
  last_observation: string | null;
  /** Chain time (confirmed head's timestamp) of that mismatch observation: its re-check waits from here. */
  mismatch_observed_head_ts: number | null;
  /**
   * EXECUTION EVIDENCE IS A STICKY FLAG (#907 rounds 12–13). Once a
   * head-capped scan of the signed window has returned an
   * `AuthorizationUsed(payer, nonce)` log for the record, a later read that
   * shows nothing is a lagging (or reorged) view, never evidence of absence:
   *   - `unpaired`: Used seen, its paired Transfer not (yet) read. Never
   *     terminal, spends nothing; every visit is a full head-capped scan of
   *     the window (so the execution is found wherever it lands), on the
   *     chain-time cadence 10 min / 1 h / then every 6 h, forever.
   *   - `mismatched`: Used seen AND paired to a Transfer that fails the checks
   *     (wrong recipient, amount or token). The first observation spends
   *     nothing; each later one spends the mismatch re-check, then the
   *     expiry-class re-checks; terminal once both are spent. Never back to
   *     `unpaired`.
   * The flag never pins a transaction: no read is ever made by a stored hash.
   */
  used_state: "unpaired" | "mismatched" | null;
  /** The transaction whose AuthorizationUsed log was last seen — for the operator's eyes only, never read by. */
  used_observed_tx: string | null;
  /** Chain time the Used log was first seen. */
  used_observed_head_ts: number | null;
  /** Visits spent on the cadence (execution evidence or read errors): drives the next wait. */
  visit_backoffs: number;
  /** Chain time the record may next be visited (null: no cadence applies). */
  next_visit_head_ts: number | null;
}

/** A record for this (payer, nonce), if any. */
export function findX402Settlement(
  db: DatabaseDriver,
  payer: string,
  nonce: string,
): X402SettlementRecord | undefined {
  return db
    .prepare("SELECT * FROM relay_x402_settlements WHERE payer = ? AND nonce = ?")
    .get(payer.toLowerCase(), nonce.toLowerCase()) as X402SettlementRecord | undefined;
}

/** The pending record a request under this (key, path agent) left, if any. */
export function findPendingX402ForKey(
  db: DatabaseDriver,
  idempotencyKey: string,
  motebitId: string,
): X402SettlementRecord | undefined {
  return db
    .prepare(
      "SELECT * FROM relay_x402_settlements WHERE idempotency_key = ? AND motebit_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
    )
    .get(idempotencyKey, motebitId) as X402SettlementRecord | undefined;
}

/** Records an operator should see: pending, and failed (most recent first). */
export function listX402SettlementsForOperator(
  db: DatabaseDriver,
  opts: { status?: "pending" | "failed"; limit?: number } = {},
): X402SettlementRecord[] {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  if (opts.status != null) {
    return db
      .prepare(
        "SELECT * FROM relay_x402_settlements WHERE status = ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(opts.status, limit) as X402SettlementRecord[];
  }
  return db
    .prepare(
      "SELECT * FROM relay_x402_settlements WHERE status IN ('pending', 'failed') ORDER BY created_at DESC LIMIT ?",
    )
    .all(limit) as X402SettlementRecord[];
}

/**
 * The selection clock, as SQL evaluated inside the write that uses it:
 * `created_at` and `last_checked_at` are both
 * `max(now, (largest key any queued record holds) + 1)`. Stamps therefore
 * strictly increase ACROSS processes and restarts, whatever the wall clock
 * does: a record created or visited after another always sorts after it —
 * inside one millisecond (#907 round 8), after the wall clock jumps back
 * (round 9: a per-process counter restarted at 0 left the stamps written
 * before the jump in the "future", starving a record for as long as the
 * jump), and between two relay processes on one database. The FIFO bound on
 * SELECTION_ORDER assumes exactly this: every key minted after t is > t.
 * Bind: the wall clock (ms). Each MAX reads idx_x402_settlements_selection.
 */
const NEXT_QUEUE_STAMP_SQL = `MAX(?,
  COALESCE((SELECT MAX(COALESCE(last_checked_at, created_at)) FROM relay_x402_settlements WHERE status = 'pending'), 0) + 1,
  COALESCE((SELECT MAX(COALESCE(last_checked_at, created_at)) FROM relay_x402_settlements WHERE status = 'failed'), 0) + 1)`;

/**
 * Write the pending intent BEFORE the facilitator is called. Returns false
 * when this authorization already has a record (a replay, or a concurrent
 * request carrying the same signed payload): it must not be settled again.
 */
export function recordX402Intent(
  db: DatabaseDriver,
  rec: Pick<
    X402SettlementRecord,
    | "payer"
    | "nonce"
    | "network"
    | "token"
    | "pay_to"
    | "amount_micro"
    | "valid_after"
    | "valid_before"
    | "idempotency_key"
    | "motebit_id"
    | "delegator_id"
    | "task_id"
  >,
): boolean {
  if (!Number.isSafeInteger(rec.amount_micro) || rec.amount_micro <= 0) {
    throw new Error(`x402 intent: refusing a non-positive amount (${rec.amount_micro})`);
  }
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO relay_x402_settlements
         (payer, nonce, network, token, pay_to, amount_micro, valid_after, valid_before,
          idempotency_key, motebit_id, delegator_id, task_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ${NEXT_QUEUE_STAMP_SQL})`,
    )
    .run(
      rec.payer,
      rec.nonce,
      rec.network,
      rec.token,
      rec.pay_to,
      rec.amount_micro,
      rec.valid_after,
      rec.valid_before,
      rec.idempotency_key,
      rec.motebit_id,
      rec.delegator_id,
      rec.task_id,
      Date.now(),
    );
  return info.changes === 1;
}

/**
 * Mark a pending record failed — a definite facilitator refusal, or a chain
 * read that proved it cancelled, expired unexecuted, or executed in a way
 * that does not match the record.
 */
export function markX402Failed(
  db: DatabaseDriver,
  payer: string,
  nonce: string,
  reason: string,
  /**
   * The confirmed head's timestamp the failure was decided at. The request
   * path has no chain reader and passes null: the reconciler stamps the head
   * it first sees the record under (`stampUnobservedFailures`).
   */
  headTs: number | null = null,
  /**
   * A failure decided from the ABSENCE of an execution (expired unused) or a
   * cancellation: never applied to a record with execution evidence, so a
   * stale pass cannot fail what another run has seen executed (round 14).
   */
  opts: { requireNoEvidence?: boolean } = {},
): boolean {
  const info = db
    .prepare(
      `UPDATE relay_x402_settlements SET status = 'failed', failure_reason = ?, resolved_at = ?, resolved_head_ts = ?, pass_cursor = NULL,
         last_observation = CASE WHEN ? = 'execution_mismatch' THEN 'execution_mismatch' ELSE last_observation END,
         mismatch_observed_head_ts = CASE WHEN ? = 'execution_mismatch' THEN ? ELSE mismatch_observed_head_ts END
       WHERE payer = ? AND nonce = ? AND status = 'pending' AND (? = 0 OR used_state IS NULL)`,
    )
    .run(
      reason,
      Date.now(),
      headTs,
      reason,
      reason,
      headTs,
      payer,
      nonce,
      opts.requireNoEvidence === true ? 1 : 0,
    );
  return info.changes === 1;
}

/**
 * Credit a record's delegator, exactly once: the status flip and the ledger
 * credit commit in one transaction. The amount is ALWAYS the record's
 * `amount_micro` (the authorization's value = the quoted gross), never a
 * facilitator-reported number.
 *
 * `from` names the states the flip may leave: the settling request passes
 * `pending` only; the reconciler, holding proof of execution, may also flip a
 * `failed` record (a failure is not terminal against evidence — a lagging read
 * or a mis-refused settle may have marked it). Returns false (and credits
 * nothing) when the record is not in one of them.
 */
export function creditX402Settlement(
  db: DatabaseDriver,
  payer: string,
  nonce: string,
  args: {
    txHash: string | null;
    /** The Transfer log consumed by a reconciled credit; (txHash, index) is unique across records. */
    creditLogIndex?: number;
    description: string;
    from: "pending" | "pending_or_failed";
  },
): boolean {
  db.exec("BEGIN");
  try {
    const rec = findX402Settlement(db, payer, nonce);
    if (rec == null) {
      db.exec("ROLLBACK");
      return false;
    }
    if (!Number.isSafeInteger(rec.amount_micro) || rec.amount_micro <= 0) {
      throw new Error(`x402 credit: refusing a non-positive amount (${rec.amount_micro})`);
    }
    const statuses = args.from === "pending" ? "('pending')" : "('pending', 'failed')";
    const info = db
      .prepare(
        `UPDATE relay_x402_settlements SET status = 'credited', tx_hash = COALESCE(?, tx_hash), credit_log_index = ?, failure_reason = NULL, resolved_at = ? WHERE payer = ? AND nonce = ? AND status IN ${statuses}`,
      )
      .run(args.txHash, args.creditLogIndex ?? null, Date.now(), rec.payer, rec.nonce);
    if (info.changes !== 1) {
      db.exec("ROLLBACK");
      return false;
    }
    creditAccount(
      db,
      rec.delegator_id,
      rec.amount_micro,
      "deposit",
      `x402-${rec.task_id}`,
      args.description,
    );
    db.exec("COMMIT");
    return true;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// ── Reconciliation: proof of execution, never the state bit ───────────────

/** One EIP-3009 event for an (authorizer, nonce), from the token contract itself. */
export interface AuthorizationEvent {
  kind: "used" | "canceled";
  txHash: string;
  blockNumber: number;
  /** The log's index in its block (JSON-RPC `logIndex`). */
  logIndex: number;
}

/** One log of a SUCCESSFUL transaction's receipt, in receipt order. Hex lowercase. */
export interface ReceiptLog {
  address: string;
  topics: string[];
  data: string;
}

/**
 * The chain reads reconciliation needs. Motebit-shaped port (CLAUDE.md rule
 * 15): every wire failure is ONE thrown Error.
 */
export interface X402ChainReader {
  /** The newest block at the reader's confirmation depth: its number and its own timestamp (unix s). */
  getConfirmedHead(): Promise<{ number: number; timestamp: number }>;
  /** A block's own timestamp (unix s). */
  getBlockTimestamp(blockNumber: number): Promise<number>;
  /**
   * `AuthorizationUsed` / `AuthorizationCanceled` logs EMITTED BY `token` for
   * this exact (authorizer, nonce), in the inclusive block range. The
   * implementation filters at the node AND re-checks every field locally.
   */
  getAuthorizationEvents(args: {
    token: string;
    authorizer: string;
    nonce: string;
    fromBlock: number;
    toBlock: number;
  }): Promise<AuthorizationEvent[]>;
  /**
   * The logs of a transaction's receipt, IN RECEIPT ORDER. Empty when the
   * transaction did not succeed or any log is marked `removed` (fail closed).
   */
  getReceiptLogs(txHash: string): Promise<ReceiptLog[]>;
}

/** keccak256("AuthorizationUsed(address,bytes32)") */
export const AUTHORIZATION_USED_TOPIC =
  "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
/** keccak256("AuthorizationCanceled(address,bytes32)") */
export const AUTHORIZATION_CANCELED_TOPIC =
  "0x1cdd46ff242716cdaa72d159d339a485b3438398348d68f09d7c8c0a59353d81";
/** keccak256("Transfer(address,address,uint256)") */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Scan and confirmation bounds (see `reconcileX402Settlement`). */
export interface X402ScanParams {
  /** Blocks per `eth_getLogs` page — under common public-RPC range caps. */
  pageBlocks: number;
  /** Pages per record per reconciliation run (a long backlog continues next run). */
  maxPagesPerRun: number;
  /** Chain seconds past `validBefore` before an unexecuted authorization may be called expired. */
  expiryMarginSeconds: number;
  /** Wall-clock gap between the two agreeing observations an expiry needs (ms). */
  expiryConfirmGapMs: number;
  /**
   * Re-checks of a `failed` record, and the wait before each (ms of CHAIN
   * time); also the visit cadence of a record with execution evidence or a
   * read error (the last value repeats forever).
   */
  recheckBackoffMs: readonly number[];
}

export const X402_SCAN: X402ScanParams = {
  pageBlocks: 2_000,
  maxPagesPerRun: 25,
  expiryMarginSeconds: 120,
  expiryConfirmGapMs: 5 * 60_000,
  recheckBackoffMs: [10 * 60_000, 60 * 60_000, 6 * 60 * 60_000],
};

const topicAddress = (a: string): string => "0x" + a.slice(2).toLowerCase().padStart(64, "0");
const addressFromTopic = (t: string): string => "0x" + t.slice(-40).toLowerCase();

/**
 * `eth_getLogs` / `eth_getTransactionReceipt` / `eth_getBlockByNumber` over
 * HTTP JSON-RPC. The confirmed head is `latest − confirmations`: nothing
 * newer is read, so a reorg shallower than the depth cannot un-credit or
 * un-cancel what reconciliation decided. Nothing the node returns is trusted
 * beyond its shape: a log's emitting address, topics and `removed` flag are
 * re-checked here, and a receipt whose `status` is not `0x1` proves nothing.
 */
export class HttpX402ChainReader implements X402ChainReader {
  constructor(
    private readonly rpcUrl: string,
    private readonly confirmations: number,
    private readonly fetchFn: typeof globalThis.fetch = globalThis.fetch,
    private readonly timeoutMs = 15_000,
  ) {}

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(this.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { result?: T; error?: { message?: string } };
      if (body.error != null) throw new Error(body.error.message ?? "JSON-RPC error");
      if (body.result === undefined) throw new Error("missing result");
      return body.result;
    } catch (err) {
      throw new Error(
        `x402 chain read ${method} failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private static hexNumber(v: unknown, what: string): number {
    if (typeof v !== "string" || !/^0x[0-9a-fA-F]+$/.test(v)) {
      throw new Error(`x402 chain read: malformed ${what}`);
    }
    const n = Number(BigInt(v));
    if (!Number.isSafeInteger(n)) throw new Error(`x402 chain read: ${what} out of range`);
    return n;
  }

  async getBlockTimestamp(blockNumber: number): Promise<number> {
    const block = await this.call<{ timestamp?: unknown } | null>("eth_getBlockByNumber", [
      "0x" + blockNumber.toString(16),
      false,
    ]);
    if (block == null) throw new Error(`x402 chain read: block ${blockNumber} not found`);
    return HttpX402ChainReader.hexNumber(block.timestamp, "block timestamp");
  }

  async getConfirmedHead(): Promise<{ number: number; timestamp: number }> {
    const latest = HttpX402ChainReader.hexNumber(
      await this.call<string>("eth_blockNumber", []),
      "block number",
    );
    const number = Math.max(0, latest - this.confirmations);
    return { number, timestamp: await this.getBlockTimestamp(number) };
  }

  async getAuthorizationEvents(args: {
    token: string;
    authorizer: string;
    nonce: string;
    fromBlock: number;
    toBlock: number;
  }): Promise<AuthorizationEvent[]> {
    const token = args.token.toLowerCase();
    const logs = await this.call<
      {
        address?: string;
        topics?: string[];
        transactionHash?: string;
        blockNumber?: string;
        logIndex?: string;
        removed?: boolean;
      }[]
    >("eth_getLogs", [
      {
        address: token,
        fromBlock: "0x" + args.fromBlock.toString(16),
        toBlock: "0x" + args.toBlock.toString(16),
        topics: [
          [AUTHORIZATION_USED_TOPIC, AUTHORIZATION_CANCELED_TOPIC],
          topicAddress(args.authorizer),
          args.nonce.toLowerCase(),
        ],
      },
    ]);
    if (!Array.isArray(logs)) throw new Error("x402 chain read: eth_getLogs result not an array");
    const out: AuthorizationEvent[] = [];
    for (const log of logs) {
      // Never trust the node's filter: every field is re-checked.
      if (log.removed === true) continue;
      if (log.address?.toLowerCase() !== token) continue;
      const topics = (log.topics ?? []).map((t) => t.toLowerCase());
      if (topics[1] !== topicAddress(args.authorizer) || topics[2] !== args.nonce.toLowerCase()) {
        continue;
      }
      const kind =
        topics[0] === AUTHORIZATION_USED_TOPIC
          ? "used"
          : topics[0] === AUTHORIZATION_CANCELED_TOPIC
            ? "canceled"
            : null;
      if (kind == null || typeof log.transactionHash !== "string") continue;
      const blockNumber = HttpX402ChainReader.hexNumber(log.blockNumber, "log block number");
      if (blockNumber < args.fromBlock || blockNumber > args.toBlock) continue;
      out.push({
        kind,
        txHash: log.transactionHash.toLowerCase(),
        blockNumber,
        logIndex: HttpX402ChainReader.hexNumber(log.logIndex, "log index"),
      });
    }
    return out;
  }

  async getReceiptLogs(txHash: string): Promise<ReceiptLog[]> {
    const receipt = await this.call<{
      status?: string;
      logs?: { address?: string; topics?: string[]; data?: string; removed?: boolean }[];
    } | null>("eth_getTransactionReceipt", [txHash]);
    if (receipt == null) throw new Error(`x402 chain read: receipt ${txHash} not found`);
    if (receipt.status !== "0x1") return [];
    const logs = receipt.logs ?? [];
    // A receipt with any removed log is from a reorged view: prove nothing from it.
    if (logs.some((l) => l.removed === true)) return [];
    return logs.map((l) => ({
      address: typeof l.address === "string" ? l.address.toLowerCase() : "",
      topics: (l.topics ?? []).map((t) => t.toLowerCase()),
      data: typeof l.data === "string" ? l.data.toLowerCase() : "",
    }));
  }
}

/** The RPC URL for an x402 network: `X402_RPC_URL_<CAIP2 upper, non-alnum → _>` overrides the default. */
export function x402RpcUrlFor(
  network: string,
  defaults: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const key = "X402_RPC_URL_" + network.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const override = env[key];
  return override != null && override !== "" ? override : defaults[network];
}

/**
 * Whether the reconciler can read `network`: an RPC URL (override or default)
 * AND a confirmation depth. The x402 gate is armed only for a network this is
 * true of (#907 round 11): a payment whose settle outcome is unknown must be
 * resolvable from the chain, so the relay refuses to boot rather than accept
 * payments it could never reconcile.
 */
export function x402ReconcilerCanRead(
  network: string,
  defaults: Record<string, string>,
  confirmationsByChain: Record<string, number>,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return x402RpcUrlFor(network, defaults, env) != null && confirmationsByChain[network] != null;
}

export type ReconcileDecision =
  | "credited"
  | "cancelled"
  | "expired"
  | "expiry_observed"
  | "authorization_still_valid"
  | "execution_mismatch"
  | "still_pending"
  | "used_unpaired"
  | "used_not_visible"
  | "scan_incomplete"
  | "no_execution_found"
  | "unchanged"
  | "read_error";

export interface ReconcileResult {
  credited: number;
  failed: number;
  stillPending: number;
  errors: number;
}

/**
 * Locate the first block to scan: the newest block whose timestamp is at or
 * before `targetTs` — by binary search over block numbers (block timestamps
 * are non-decreasing), O(log n) reads however old the record is. Never returns
 * a block newer than the target: if even block 0 is newer, it returns 0; a
 * read error throws, and nothing is persisted.
 */
async function locateScanStart(
  reader: X402ChainReader,
  head: { number: number; timestamp: number },
  targetTs: number,
): Promise<number> {
  if (head.timestamp <= targetTs) return head.number;
  let lo = 0;
  let hi = head.number; // invariant: ts(hi) > targetTs
  if ((await reader.getBlockTimestamp(0)) > targetTs) return 0;
  // invariant: ts(lo) <= targetTs < ts(hi)
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if ((await reader.getBlockTimestamp(mid)) <= targetTs) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * THE PAIRING RULE. The Transfer that proves an authorization executed is the
 * one USDC's `transferWithAuthorization` emitted for it — never "some matching
 * Transfer in the same transaction". In Circle's stablecoin-evm (the source of
 * FiatTokenV2_x, which Base USDC runs), `EIP3009._transferWithAuthorization`
 * calls `_markAuthorizationAsUsed(from, nonce)` — which emits
 * `AuthorizationUsed(authorizer, nonce)` — and then `_transfer(from, to,
 * value)`, whose body (FiatTokenV1 `_transfer`) emits exactly one
 * `Transfer(from, to, value)` and nothing else. Nothing runs between the two
 * emits, so the paired Transfer is the NEXT log in the same receipt, emitted
 * by the same token contract. Both are located in ONE source — the receipt's
 * log array — so a node's `logIndex` convention (block- or tx-scoped) cannot
 * mis-pair them. Returns the transfer and its position in the receipt (the
 * consumed-marker index), or undefined.
 * (contracts/v2/EIP3009.sol `_transferWithAuthorization` /
 * `_markAuthorizationAsUsed`; contracts/v1/FiatTokenV1.sol `_transfer`.)
 */
export function pairedTransfer(
  logs: readonly ReceiptLog[],
  auth: { token: string; authorizer: string; nonce: string },
): { position: number; from: string; to: string; value: bigint } | undefined {
  const token = auth.token.toLowerCase();
  const i = logs.findIndex(
    (l) =>
      l.address === token &&
      l.topics[0] === AUTHORIZATION_USED_TOPIC &&
      l.topics[1] === topicAddress(auth.authorizer) &&
      l.topics[2] === auth.nonce.toLowerCase(),
  );
  if (i < 0) return undefined;
  const t = logs[i + 1];
  if (t == null || t.address !== token || t.topics[0] !== TRANSFER_TOPIC || t.topics.length !== 3) {
    return undefined;
  }
  if (!/^0x[0-9a-f]{1,64}$/.test(t.data)) return undefined;
  return {
    position: i + 1,
    from: addressFromTopic(t.topics[1]!),
    to: addressFromTopic(t.topics[2]!),
    value: BigInt(t.data),
  };
}

/**
 * The first block whose timestamp is past `targetTs`, by binary search in
 * `[from, head]` (the caller guarantees `head.timestamp > targetTs`). EIP-3009
 * refuses `transferWithAuthorization` once `block.timestamp >= validBefore`,
 * so nothing after this block can execute the authorization: it is the fixed
 * END of a record's scan (#907 round 6).
 */
async function locateScanEnd(
  reader: X402ChainReader,
  from: number,
  head: { number: number; timestamp: number },
  targetTs: number,
): Promise<number> {
  if ((await reader.getBlockTimestamp(from)) > targetTs) return from;
  let lo = from; // invariant: ts(lo) <= targetTs
  let hi = head.number; // invariant: ts(hi) > targetTs
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if ((await reader.getBlockTimestamp(mid)) <= targetTs) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** Which persisted cursor a scan advances. */
type ScanCursor = "scanned_to_block" | "pass_cursor";

/**
 * Scan `[fromBlock, toBlock]` for the record's events, in pages, at most
 * `maxPagesPerRun` this run, persisting `cursor` after every empty page so the
 * next run continues rather than restarts. `reached` says the scan got past
 * `toBlock`.
 */
async function scanEvents(
  db: DatabaseDriver,
  reader: X402ChainReader,
  rec: X402SettlementRecord,
  fromBlock: number,
  toBlock: number,
  /** null: a read-only scan (the operator's resolve) — no cursor is written. */
  cursor: ScanCursor | null,
  p: X402ScanParams,
  /** Pages this call may read. The operator's resolve passes Infinity: it scans the whole window. */
  maxPages: number = p.maxPagesPerRun,
): Promise<{ events: AuthorizationEvent[]; reached: boolean; stale: boolean }> {
  let at = fromBlock;
  let events: AuthorizationEvent[] = [];
  let pages = 0;
  let pageBlocks = p.pageBlocks;
  // Compare-and-set: every cursor write names the state this run observed —
  // the status, the pass generation (`recheck_count`) and the cursor value it
  // last saw. A concurrent run that concluded, failed or re-based the record
  // makes this run's writes no-ops (#907 round 7). The run does not stop
  // there (round 14): it finishes the scan READ-ONLY up to `toBlock`, so an
  // honest read is never discarded because a lagging run won a write race —
  // the caller may still credit from what it finds, and nothing else.
  let expected: number | null = cursor === "pass_cursor" ? rec.pass_cursor : rec.scanned_to_block;
  let lost = false;
  while (at <= toBlock && (lost || pages < maxPages) && events.length === 0) {
    const to = Math.min(toBlock, at + pageBlocks - 1);
    try {
      events = await reader.getAuthorizationEvents({
        token: rec.token,
        authorizer: rec.payer,
        nonce: rec.nonce,
        fromBlock: at,
        toBlock: to,
      });
    } catch (err) {
      // A provider that caps eth_getLogs ranges below `pageBlocks`: halve the
      // page and retry the same block, down to one block, instead of a
      // permanent read error.
      const msg = err instanceof Error ? err.message : String(err);
      if (pageBlocks > 1 && RANGE_LIMIT_ERROR.test(msg)) {
        pageBlocks = Math.max(1, Math.floor(pageBlocks / 2));
        continue;
      }
      throw err;
    }
    if (events.length === 0 && cursor != null && !lost) {
      const info =
        cursor === "pass_cursor"
          ? db
              .prepare(
                "UPDATE relay_x402_settlements SET pass_cursor = ? WHERE payer = ? AND nonce = ? AND status = ? AND recheck_count = ? AND pass_cursor IS ?",
              )
              .run(to, rec.payer, rec.nonce, rec.status, rec.recheck_count, expected)
          : db
              .prepare(
                "UPDATE relay_x402_settlements SET scanned_to_block = ? WHERE payer = ? AND nonce = ? AND status = 'pending' AND scanned_to_block IS ?",
              )
              .run(to, rec.payer, rec.nonce, expected);
      if (info.changes !== 1) lost = true;
      else expected = to;
    }
    at = to + 1;
    pages += 1;
  }
  return { events, reached: events.length === 0 && at > toBlock, stale: lost };
}

/** An eth_getLogs refusal because the block range is too wide (provider wording varies). */
const RANGE_LIMIT_ERROR =
  /block range|range (is )?too (large|wide|big)|exceed(s|ed)? .*range|max(imum)? .*range|limited to .*range|limit.*blocks|too many (blocks|results)|query returned more than|response size (exceeded|is too large)/i;

/**
 * Reconcile ONE record against the chain.
 *
 *   1. Range: from `scan_from_block` (the newest block at or before
 *      the signed `valid_after` — never the relay's clock — by binary search) to a FIXED end —
 *      `scan_end_block`, the first block whose timestamp is past
 *      `valid_before + expiryMarginSeconds` (binary search, persisted once the
 *      confirmed head passes it). Nothing after it can execute the
 *      authorization, so the range is finite and "scanned to the end" is a
 *      stable fact. Until the head gets there, scans stop at the head.
 *   2. Cursors, persisted every page, so a range longer than one run's budget
 *      (`maxPagesPerRun × pageBlocks`) advances across runs:
 *      `scanned_to_block` for the ordinary pass; `pass_cursor` for a FULL
 *      pass (the confirming second observation of an expiry, and every
 *      re-check), which rescans from `scan_from_block` and is reset when it
 *      concludes.
 *   3. `AuthorizationUsed(payer, nonce)` found ⇒ its paired Transfer (see
 *      `pairedTransfer`) from the payer to `pay_to` for exactly `amount_micro`
 *      ⇒ credited once, consuming that Transfer log. Otherwise
 *      `execution_mismatch`.
 *   4. `AuthorizationCanceled(payer, nonce)` ⇒ failed `cancelled`.
 *   5. Expiry: the ordinary pass reaching the fixed end with no event records
 *      `expiry_observed_head_ts` (the head's timestamp). A full confirming pass
 *      starts once the head is `expiryConfirmGapMs` of CHAIN time later and, on reaching the end with no event,
 *      declares `authorization_expired_unused`.
 *   6. A re-check of a `failed` record is a full pass; it is SPENT when it
 *      concludes (an event found, or the end reached), never while in
 *      progress, and never by an operator's resolve.
 *   Any read error leaves everything as it was (fail safe).
 */
export async function reconcileX402Settlement(
  db: DatabaseDriver,
  reader: X402ChainReader,
  rec: X402SettlementRecord,
  p: X402ScanParams = X402_SCAN,
  opts: {
    operator?: boolean;
    /**
     * The confirmed head the RUN read once (#907 round 12): selection and every
     * decision in the run use the same head, so a second, regressed read can
     * never make this pass decide differently than selection admitted.
     * Omitted (the operator's resolve, a direct call): read here, once.
     */
    head?: { number: number; timestamp: number };
  } = {},
): Promise<ReconcileDecision> {
  const recheck = rec.status === "failed";
  const operator = opts.operator === true;
  /** Execution evidence seen before this visit (a FLAG — round 13). */
  const usedSeen = rec.used_state != null;
  /** The confirmed head's timestamp this visit uses (null until read). */
  let chainNow: number | null = opts.head?.timestamp ?? null;
  /** The visit-cadence counter as this visit knows it. */
  let visitBackoffs = rec.visit_backoffs;
  /** A run that lost a compare-and-set race: it may credit, and write nothing else. */
  let observeOnly = false;

  /**
   * The chain-time cadence of a record that must not be visited every tick:
   * one with execution evidence (10 min, 1 h, then every 6 h, forever) and
   * one whose reads failed (same progression; reset by the next good read).
   */
  const scheduleNextVisit = (headTs: number): void => {
    const backoff = p.recheckBackoffMs;
    const wait = backoff[Math.min(visitBackoffs, backoff.length - 1)] ?? 0;
    visitBackoffs += 1;
    db.prepare(
      "UPDATE relay_x402_settlements SET visit_backoffs = ?, next_visit_head_ts = ? WHERE payer = ? AND nonce = ?",
    ).run(visitBackoffs, headTs + chainSeconds(wait), rec.payer, rec.nonce);
  };

  /**
   * Conclude a re-check pass of a record WITHOUT execution evidence: spend
   * one expiry-class re-check. Guarded by the generation this run observed,
   * so a pass another run already concluded is never spent twice (#907
   * rounds 5–8), and by `used_state IS NULL`, so a stale evidence-less pass
   * never spends a record that has since gained evidence (round 13). Every spend leaves a non-null chain-time wait. The
   * operator's resolve never spends and never writes.
   */
  const spendExpiryRecheck = (headTs: number): void => {
    if (!recheck || operator) return;
    const done = rec.recheck_count + 1;
    const wait = p.recheckBackoffMs[done] ?? p.recheckBackoffMs[p.recheckBackoffMs.length - 1] ?? 0;
    // The next re-check waits in CHAIN time (round 10); the wall-clock
    // `next_recheck_at` is informational.
    db.prepare(
      "UPDATE relay_x402_settlements SET recheck_count = ?, next_recheck_at = ?, next_recheck_head_ts = ?, pass_cursor = NULL WHERE payer = ? AND nonce = ? AND status = 'failed' AND recheck_count = ? AND used_state IS NULL",
    ).run(
      done,
      Date.now() + wait,
      headTs + chainSeconds(wait),
      rec.payer,
      rec.nonce,
      rec.recheck_count,
    );
  };

  /**
   * Record execution evidence for the first time, or move `unpaired` to
   * `mismatched` (never back). A FLAG, never a pinned transaction: the next
   * visit finds the execution wherever it is by a head-capped scan of the
   * signed window. `used_observed_tx` is for the operator's eyes only.
   */
  const markUsedSeen = (state: "unpaired" | "mismatched", txHash: string, headTs: number): void => {
    const backoff = p.recheckBackoffMs;
    const wait = backoff[0] ?? 0;
    db.prepare(
      `UPDATE relay_x402_settlements SET used_state = ?, used_observed_tx = ?,
         used_observed_head_ts = COALESCE(used_observed_head_ts, ?),
         last_observation = CASE WHEN ? = 'mismatched' THEN 'execution_mismatch' ELSE last_observation END,
         mismatch_observed_head_ts = CASE WHEN ? = 'mismatched' THEN ? ELSE mismatch_observed_head_ts END,
         visit_backoffs = 1, next_visit_head_ts = ?, pass_cursor = NULL
       WHERE payer = ? AND nonce = ?
         AND (status = 'failed' OR (status = 'pending' AND ? = 'unpaired'))
         AND (used_state IS NULL OR (used_state = 'unpaired' AND ? = 'mismatched'))`,
    ).run(
      state,
      txHash,
      headTs,
      state,
      state,
      headTs,
      headTs + chainSeconds(wait),
      rec.payer,
      rec.nonce,
      state,
      state,
    );
    visitBackoffs = 1;
  };

  /**
   * A mismatch observation on a record already `mismatched`: spend ONE
   * re-check — the mismatch budget first, then the expiry-class budget — and
   * set the next visit. Guarded by the observed generation. The record is
   * terminal (never selected again) once BOTH budgets are spent: after the
   * first mismatch observation, (1 − mismatch_rechecks) + (3 − recheck_count)
   * further ones — at most 4 (5 in all) when no expiry-class re-check was
   * spent before the evidence, fewer when some were (L, L, C, C, C closes
   * after 3 observations). The same rule closes a CORRECT execution a node
   * keeps misreporting with a wrong-value Transfer that many times; the
   * operator's resolve (a whole-window scan) still credits it.
   */
  const spendMismatchObservation = (headTs: number): void => {
    const mr =
      rec.mismatch_rechecks < MISMATCH_RECHECKS ? rec.mismatch_rechecks + 1 : rec.mismatch_rechecks;
    const rc =
      rec.mismatch_rechecks < MISMATCH_RECHECKS ? rec.recheck_count : rec.recheck_count + 1;
    const backoff = p.recheckBackoffMs;
    const wait = backoff[Math.min(visitBackoffs, backoff.length - 1)] ?? 0;
    visitBackoffs += 1;
    db.prepare(
      "UPDATE relay_x402_settlements SET mismatch_rechecks = ?, recheck_count = ?, mismatch_observed_head_ts = ?, visit_backoffs = ?, next_visit_head_ts = ? WHERE payer = ? AND nonce = ? AND status = 'failed' AND recheck_count = ? AND mismatch_rechecks = ?",
    ).run(
      mr,
      rc,
      headTs,
      visitBackoffs,
      headTs + chainSeconds(wait),
      rec.payer,
      rec.nonce,
      rec.recheck_count,
      rec.mismatch_rechecks,
    );
  };

  /**
   * Judge an `AuthorizationUsed` log THIS visit's head-capped scan returned,
   * by its transaction's receipt — the only receipt read there is, and never
   * for a transaction the scan did not just return (round 13).
   *   - paired and matching ⇒ credit;
   *   - no Transfer paired (a missing log) ⇒ `unpaired` evidence: never
   *     terminal, spends nothing, re-read on the cadence;
   *   - paired but failing the checks ⇒ `mismatched`: spends the mismatch,
   *     then the expiry-class budget, on each LATER mismatch observation;
   *     terminal when both are spent; never back to `unpaired`.
   */
  const judgeUsed = async (
    txHash: string,
    usedLogIndex: number,
    headTs: number,
  ): Promise<ReconcileDecision> => {
    const logs = await reader.getReceiptLogs(txHash);
    const paired = pairedTransfer(logs, {
      token: rec.token,
      authorizer: rec.payer,
      nonce: rec.nonce,
    });
    if (paired == null) {
      if (operator || observeOnly) return "used_unpaired"; // observed, nothing written
      if (rec.used_state == null) {
        markUsedSeen("unpaired", txHash, headTs);
        logger.warn("x402.reconcile.used_unpaired", {
          payer: rec.payer,
          nonce: rec.nonce,
          txHash,
          idempotencyKey: rec.idempotency_key,
        });
      } else {
        scheduleNextVisit(headTs); // unpaired stays unpaired; mismatched is not reopened
      }
      return "used_unpaired";
    }
    const matches =
      paired.from === rec.payer &&
      paired.to === rec.pay_to.toLowerCase() &&
      paired.value === BigInt(rec.amount_micro);
    const mismatch = (): ReconcileDecision => {
      if (operator || observeOnly) return "execution_mismatch"; // observed, nothing written
      if (rec.used_state === "mismatched") {
        spendMismatchObservation(headTs);
      } else {
        // The first mismatch observation spends nothing, whatever the
        // record's origin (round 13): both budgets stay whole. Failing a
        // pending record and flagging its evidence commit together (round
        // 14): a crash between them would leave a failed record with no
        // evidence and no re-check class — never selected again.
        db.exec("BEGIN");
        try {
          if (!recheck) {
            markX402Failed(db, rec.payer, rec.nonce, "execution_mismatch", headTs);
          }
          markUsedSeen("mismatched", txHash, headTs);
          db.exec("COMMIT");
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
      }
      return "execution_mismatch";
    };
    if (!matches) {
      logger.error("x402.reconcile.execution_mismatch", {
        payer: rec.payer,
        nonce: rec.nonce,
        txHash,
        usedLogIndex,
        pairedPosition: paired.position,
        pairedFrom: paired.from,
        pairedTo: paired.to,
        pairedValue: paired.value.toString(),
        expectedTo: rec.pay_to,
        expectedAmountMicro: rec.amount_micro,
        idempotencyKey: rec.idempotency_key,
        delegator: rec.delegator_id,
      });
      return mismatch();
    }
    let credited: boolean;
    try {
      credited = creditX402Settlement(db, rec.payer, rec.nonce, {
        txHash,
        creditLogIndex: paired.position,
        description: `x402 payment ${txHash}#${paired.position} (authorization ${rec.nonce}) reconciled from chain for task ${rec.task_id}`,
        from: "pending_or_failed",
      });
    } catch (err) {
      // The consumed marker: this Transfer log already credited another
      // record. Pairing should make this impossible; if it happens, nothing
      // is credited twice and the operator is told.
      if (!/UNIQUE/i.test(err instanceof Error ? err.message : String(err))) throw err;
      logger.error("x402.reconcile.transfer_already_consumed", {
        payer: rec.payer,
        nonce: rec.nonce,
        txHash,
        transferLogIndex: paired.position,
        idempotencyKey: rec.idempotency_key,
      });
      return mismatch();
    }
    if (credited) {
      logger.info("x402.reconcile.credited", {
        payer: rec.payer,
        nonce: rec.nonce,
        txHash,
        transferLogIndex: paired.position,
        delegator: rec.delegator_id,
        amountMicro: rec.amount_micro,
        idempotencyKey: rec.idempotency_key,
        wasFailed: recheck,
      });
    }
    return credited ? "credited" : "unchanged";
  };

  // The operator's resolve is READ-ONLY except for a credit (#907 round 11):
  // it writes no column the loop's selection or scan reads — not the queue
  // stamp, cursors, scan bounds, observations, budgets or status.
  if (!operator) {
    db.prepare(
      `UPDATE relay_x402_settlements SET last_checked_at = ${NEXT_QUEUE_STAMP_SQL} WHERE payer = ? AND nonce = ?`,
    ).run(Date.now(), rec.payer, rec.nonce);
  }
  try {
    const head = opts.head ?? (await reader.getConfirmedHead());
    chainNow = head.timestamp;
    const expiryTs = rec.valid_before + p.expiryMarginSeconds;
    const stillValid = head.timestamp <= expiryTs;
    let from = rec.scan_from_block;
    if (from == null) {
      // The signed validAfter, never the relay's clock (#907 round 9: a
      // start derived from `created_at` landed after the execution block when
      // the relay's clock ran fast, and the payment was declared unused).
      from = await locateScanStart(reader, head, rec.valid_after);
      if (!operator) {
        db.prepare(
          "UPDATE relay_x402_settlements SET scan_from_block = ? WHERE payer = ? AND nonce = ? AND scan_from_block IS NULL",
        ).run(from, rec.payer, rec.nonce);
      }
    }
    let end = rec.scan_end_block;
    if (end == null && !stillValid) {
      end = await locateScanEnd(reader, from, head, expiryTs);
      if (!operator) {
        db.prepare(
          "UPDATE relay_x402_settlements SET scan_end_block = ? WHERE payer = ? AND nonce = ? AND scan_end_block IS NULL",
        ).run(end, rec.payer, rec.nonce);
      }
    }
    // Every read stops at THIS reader's confirmed head, even when the fixed
    // end is persisted: a load-balanced node behind an earlier one would
    // otherwise "scan" blocks it does not have (Geth clamps silently) and
    // conclude over them (#907 round 9).
    const ceiling = end != null ? Math.min(end, head.number) : head.number;
    // The whole-window scan (round 13): the operator's resolve, and every
    // visit of a record with execution evidence — the SIGNED window from its
    // start, capped at the confirmed head, however many pages a provider's
    // range cap forces (the window is at most X402_MAX_WINDOW_SECONDS long),
    // persisting no cursor. The execution is found wherever it landed.
    const wholeWindow = operator || usedSeen;
    // The two expiry observations are separated in CHAIN time (round 10).
    const confirming = !wholeWindow && !recheck && rec.expiry_observed_head_ts != null;
    if (
      confirming &&
      head.timestamp - rec.expiry_observed_head_ts! < chainSeconds(p.expiryConfirmGapMs)
    ) {
      return "still_pending"; // the second observation waits out the gap
    }
    const fullPass = recheck || confirming;
    const { events, reached, stale } = await scanEvents(
      db,
      reader,
      rec,
      wholeWindow
        ? from
        : fullPass
          ? (rec.pass_cursor ?? from - 1) + 1
          : (rec.scanned_to_block ?? from - 1) + 1,
      ceiling,
      wholeWindow ? null : fullPass ? "pass_cursor" : "scanned_to_block",
      p,
      wholeWindow ? Number.POSITIVE_INFINITY : p.maxPagesPerRun,
    );
    if (stale) {
      // Another run moved this record on while this one read. It may still
      // CREDIT from a Used log it found (the status-guarded credit path);
      // it never spends a budget, marks a record failed, writes evidence or
      // sets a visit cadence — not even on a read error (round 15).
      observeOnly = true;
      const used = events.find((e) => e.kind === "used");
      if (used == null) return "unchanged";
      return await judgeUsed(used.txHash, used.logIndex, head.timestamp);
    }
    // The reads succeeded: a record without evidence leaves any read-error
    // cadence behind it.
    if (!operator && !usedSeen && visitBackoffs > 0) {
      db.prepare(
        "UPDATE relay_x402_settlements SET visit_backoffs = 0, next_visit_head_ts = NULL WHERE payer = ? AND nonce = ?",
      ).run(rec.payer, rec.nonce);
      visitBackoffs = 0;
    }
    const used = events.find((e) => e.kind === "used");
    if (used != null) return await judgeUsed(used.txHash, used.logIndex, head.timestamp);
    // Execution evidence is sticky: a scan that shows no Used (or a Canceled,
    // which a Used seen at confirmed depth rules out short of a reorg past
    // that depth — outside the stated threat model) is a lagging or reorged
    // view. It clears nothing and spends nothing.
    if (usedSeen) {
      if (operator) {
        if (stillValid) return "authorization_still_valid";
        return reached && end != null && ceiling === end ? "no_execution_found" : "scan_incomplete";
      }
      scheduleNextVisit(head.timestamp);
      return "used_not_visible";
    }
    const canceled = events.find((e) => e.kind === "canceled");
    if (canceled != null) {
      if (operator) return "cancelled"; // observed, nothing written
      if (recheck) {
        spendExpiryRecheck(head.timestamp);
        return "unchanged";
      }
      // Blocked when another run has since seen the execution (round 14): then
      // nothing was decided here (round 15).
      if (
        !markX402Failed(db, rec.payer, rec.nonce, "authorization_cancelled", head.timestamp, {
          requireNoEvidence: true,
        })
      ) {
        return "unchanged";
      }
      logger.info("x402.reconcile.cancelled", {
        payer: rec.payer,
        nonce: rec.nonce,
        txHash: canceled.txHash,
        idempotencyKey: rec.idempotency_key,
      });
      return "cancelled";
    }
    // No event in what this run scanned.
    // Scanned to the FIXED end, with this reader's head at or past it.
    const concluded = reached && end != null && ceiling === end;
    if (operator) {
      if (stillValid) return "authorization_still_valid";
      // Not concluded only when this reader's head is below the window's end.
      return concluded ? "no_execution_found" : "scan_incomplete";
    }
    if (recheck) {
      if (stillValid) return "authorization_still_valid";
      if (concluded) spendExpiryRecheck(head.timestamp);
      return "unchanged";
    }
    if (!concluded) return stillValid ? "authorization_still_valid" : "still_pending";
    if (!confirming) {
      db.prepare(
        "UPDATE relay_x402_settlements SET expiry_observed_at = ?, expiry_observed_head_ts = ? WHERE payer = ? AND nonce = ? AND status = 'pending' AND expiry_observed_head_ts IS NULL",
      ).run(Date.now(), head.timestamp, rec.payer, rec.nonce);
      return "expiry_observed";
    }
    if (
      !markX402Failed(db, rec.payer, rec.nonce, "authorization_expired_unused", head.timestamp, {
        requireNoEvidence: true,
      })
    ) {
      return "unchanged"; // blocked: another run has seen the execution
    }
    logger.info("x402.reconcile.expired_unused", {
      payer: rec.payer,
      nonce: rec.nonce,
      idempotencyKey: rec.idempotency_key,
    });
    return "expired";
  } catch (err) {
    logger.error("x402.reconcile.read_failed", {
      payer: rec.payer,
      nonce: rec.nonce,
      amountMicro: rec.amount_micro,
      idempotencyKey: rec.idempotency_key,
      error: err instanceof Error ? err.message : String(err),
    });
    // A read error still sets the record's next visit (round 13): a failing
    // record is never re-read every tick. Only with a known chain time, and
    // never from a run that lost a write race (round 15).
    if (!operator && !observeOnly && chainNow != null) scheduleNextVisit(chainNow);
    return "read_error";
  }
}

/**
 * Failure reasons a later proof of execution can overturn: a facilitator
 * refusal or an expiry. `cancelled` and `execution_mismatch` are decided FROM
 * an event and are not re-checked.
 */
const RECHECKABLE_FAILURES = [...DEFINITE_REFUSALS, "authorization_expired_unused"];
/**
 * `execution_mismatch` is decided from an event, but pairing reads a node's
 * receipt; one re-check covers a node quirk (#907 round 5).
 */
const MISMATCH_RECHECKS = 1;

/**
 * One reconciliation run: every `pending` record, then every `failed` record
 * with a re-checkable reason whose `valid_before` has passed by the confirmed
 * head's clock, with re-checks left (`recheck_count < recheckBackoffMs.length`)
 * and its backoff elapsed. A re-check is a full rescan; an execution proof
 * found then credits the record. After the last one only the operator's
 * resolve door touches it.
 */
/**
 * The selection key: `COALESCE(last_checked_at, created_at)` — the last visit,
 * or for a never-visited record its creation. A new record competes by its
 * AGE, never ahead of older work (#907 round 8: `COALESCE(…, 0)` put every
 * new record ahead of every visited one, and a steady stream of cheap new
 * records starved a visited record forever).
 *
 * The bound this gives: a record visited at time t gets key t; every record
 * created or visited after t gets a key > t. So only records whose key is
 * already < t can be selected before it again: it is revisited within
 * ceil(#records with a smaller key / limit) + 1 runs, however many arrive
 * after t. (Ties break on created_at.)
 */
const SELECTION_ORDER = "ORDER BY COALESCE(last_checked_at, created_at) ASC, created_at ASC";

/**
 * The records one run visits: pending records, and failed records eligible
 * for a re-check — EVERY eligibility condition in SQL before the LIMIT, the
 * chain-time one against `headTs` (the confirmed head's timestamp) passed in.
 * Exported so the selection can be tested directly.
 */
/**
 * A failure the request path decided (a definite facilitator refusal) has no
 * chain time: the request holds no chain reader. The reconciler stamps it with
 * the confirmed head it first sees the record under, and its first re-check
 * waits from there — at most one loop tick later than the failure itself.
 */
function stampUnobservedFailures(db: DatabaseDriver, headTs: number): void {
  db.prepare(
    "UPDATE relay_x402_settlements SET resolved_head_ts = ? WHERE status = 'failed' AND resolved_head_ts IS NULL",
  ).run(headTs);
}

/** A wall-clock duration (ms) as chain seconds, rounded up. */
function chainSeconds(ms: number): number {
  return Math.ceil(ms / 1000);
}

export function selectX402Candidates(
  db: DatabaseDriver,
  headTs: number | null,
  p: X402ScanParams,
  limit: number,
): { pending: X402SettlementRecord[]; failed: X402SettlementRecord[] } {
  if (headTs == null) return { pending: [], failed: [] };
  // Every record honours its visit cadence (execution evidence, read errors).
  const pending = db
    .prepare(
      `SELECT * FROM relay_x402_settlements WHERE status = 'pending'
         AND (next_visit_head_ts IS NULL OR next_visit_head_ts <= ?)
       ${SELECTION_ORDER} LIMIT ?`,
    )
    .all(headTs, limit) as X402SettlementRecord[];
  const placeholders = RECHECKABLE_FAILURES.map(() => "?").join(",");
  const failed = db
    .prepare(
      // Execution evidence (round 13): `unpaired` is always eligible on its
      // cadence; `mismatched` while either budget is left. Without evidence:
      // the expiry-class re-checks, the first waiting backoff[0] from the
      // moment the record failed (`resolved_head_ts`), each later one the next
      // backoff — all in CHAIN time, against the confirmed head (round 10) —
      // and only once chain time is past validBefore.
      `SELECT * FROM relay_x402_settlements WHERE status = 'failed'
         AND (next_visit_head_ts IS NULL OR next_visit_head_ts <= ?)
         AND (used_state = 'unpaired'
              OR (used_state = 'mismatched' AND (recheck_count < ? OR mismatch_rechecks < ?))
              OR (used_state IS NULL
                  AND failure_reason IN (${placeholders}) AND recheck_count < ?
                  AND COALESCE(next_recheck_head_ts, resolved_head_ts + ?) <= ?
                  AND valid_before + ? < ?))
       ${SELECTION_ORDER} LIMIT ?`,
    )
    .all(
      headTs,
      p.recheckBackoffMs.length,
      MISMATCH_RECHECKS,
      ...RECHECKABLE_FAILURES,
      p.recheckBackoffMs.length,
      chainSeconds(p.recheckBackoffMs[0] ?? 0),
      headTs,
      p.expiryMarginSeconds,
      headTs,
      limit,
    ) as X402SettlementRecord[];
  return { pending, failed };
}

export async function reconcilePendingX402Settlements(
  db: DatabaseDriver,
  reader: X402ChainReader,
  opts: { limit?: number; scan?: Partial<X402ScanParams> } = {},
): Promise<ReconcileResult> {
  const p: X402ScanParams = { ...X402_SCAN, ...opts.scan };
  const limit = opts.limit ?? 100;
  const result: ReconcileResult = { credited: 0, failed: 0, stillPending: 0, errors: 0 };
  // ONE confirmed head per run (#907 round 12): selection and every record's
  // pass use it. A failed head read makes nothing eligible and visits nothing.
  let head: { number: number; timestamp: number };
  try {
    head = await reader.getConfirmedHead();
  } catch (err) {
    // Nothing is eligible without a head; the outage is logged and counted.
    logger.error("x402.reconcile.head_read_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    result.errors += 1;
    return result;
  }
  stampUnobservedFailures(db, head.timestamp);
  const { pending, failed } = selectX402Candidates(db, head.timestamp, p, limit);
  for (const rec of [...pending, ...failed]) {
    const d = await reconcileX402Settlement(db, reader, rec, p, { head });
    if (d === "credited") result.credited += 1;
    else if (d === "cancelled" || d === "expired" || d === "execution_mismatch") result.failed += 1;
    else if (
      d === "still_pending" ||
      d === "expiry_observed" ||
      d === "authorization_still_valid" ||
      d === "used_unpaired" ||
      d === "used_not_visible"
    ) {
      result.stillPending += 1;
    } else if (d === "read_error") result.errors += 1;
  }
  return result;
}

/** Supervised loop over {@link reconcilePendingX402Settlements} (CLAUDE.md rule 19). */
export function startX402ReconciliationLoop(args: {
  db: DatabaseDriver;
  reader: X402ChainReader;
  intervalMs: number;
  isFrozen?: () => boolean;
  supervisor?: LoopSupervisor;
}): ReturnType<typeof setInterval> {
  let inFlight = false;
  return superviseInterval(
    args.supervisor,
    "x402-reconciliation",
    args.intervalMs,
    // Single-flight: a tick that fires while the previous run is still
    // working is skipped (a slow chain must never run two passes over one
    // record at once). Cross-instance safety is the compare-and-set on every
    // cursor write (`scanEvents`).
    async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const r = await reconcilePendingX402Settlements(args.db, args.reader);
        if (r.errors > 0) {
          throw new Error(`x402 reconciliation: ${r.errors} chain read(s) failed`);
        }
      } finally {
        inFlight = false;
      }
    },
    args.isFrozen != null ? { isFrozen: args.isFrozen } : {},
  );
}
