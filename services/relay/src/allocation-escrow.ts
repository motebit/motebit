/**
 * Allocation escrow — the ONE chokepoint every movement of allocation money
 * goes through, and the ONE reading of what an allocation still holds.
 *
 * Four review rounds each found a new path that wrote allocation money
 * outside the dispute harness's alphabet. The shared root: "escrow still
 * held" was DERIVED from several tables whose rows had implicit lifecycles (a
 * federated forward counted as moved before the peer acknowledged it; a
 * dispute row was attributed by the task it named rather than the allocation
 * it moved), so every new writer could disagree with the derivation. This
 * module ends that:
 *
 *  1. `moveAllocationMoney` is the only writer. Inside the caller's
 *     transaction, synchronously, it reads `held`, refuses (throws
 *     {@link AllocationMoneyRefused}) when the amount exceeds it or the payee
 *     is not a party of THAT allocation — parties derive from
 *     relay_allocations, the allocation's own hold rows and its own
 *     settlements, never from a dispute or task row — and writes the ledger
 *     row stamped with `allocation_id` and the movement's `kind`.
 *  2. A federated forward has an explicit lifecycle (`pending` → `delivered`
 *     | `failed`). `held` counts pending and delivered forwards as moved and
 *     failed ones as returned; the failure transition (`forward_return`) and
 *     the exhaustion refund run in one transaction through this chokepoint.
 *  3. `allocationHeld` is one function over explicit states: the allocation's
 *     stamped ledger rows, its own settlements' fees, its non-failed forwards.
 *     Rows written before the stamp existed are attributed by their type's
 *     own reference convention (a hold / release references the allocation; a
 *     settlement credit references one of the allocation's settlements); the
 *     upgrade migration stamps every legacy dispute row by the allocation it
 *     actually moved, and flags for operator review what it cannot attribute.
 *  4. `check-allocation-money-chokepoint` (scripts/) fails CI on any raw write
 *     to the allocation-money tables outside this module, and on any `kind`
 *     used in source that the conservation harness's alphabet does not drive.
 *
 * A database-level guard backs the chokepoint: AFTER INSERT triggers on the
 * three allocation-money tables abort any row that leaves an allocation's
 * `held` negative (`installAllocationEscrowGuards`).
 */
import type { DatabaseDriver } from "@motebit/persistence";
import { sqliteAccountStoreFor } from "./account-store-sqlite.js";
import { assertNotFrozen } from "./freeze.js";
import { createLogger } from "./logger.js";

const logger = createLogger({ service: "allocation-escrow" });

/**
 * Every kind of allocation-money movement. The conservation harness
 * (`__tests__/dispute-conservation-harness.test.ts`) drives each one and
 * asserts it observed each; the gate fails on a kind used in source the
 * harness does not list.
 */
export const ALLOCATION_MONEY_KINDS = [
  /** delegator → escrow (the lock at submission) */
  "hold",
  /** escrow → relay: the platform fee, recorded by the relay settlement row */
  "settlement_fee",
  /** escrow → the settlement's signed payee (net) */
  "settlement_credit",
  /** escrow → hold payer at settlement: failed-receipt refund, partial remainder, risk-buffer surplus */
  "settlement_release",
  /** escrow → executing peer relay (a `pending` forward) */
  "federated_forward",
  /** peer → escrow: a forward the peer never acknowledged becomes `failed` */
  "forward_return",
  /** escrow → hold payer when a forward's delivery retries are exhausted */
  "retry_exhaustion_refund",
  /** escrow → hold payer when a locked allocation passes the stale horizon */
  "sweep_refund",
  /** paid account → escrow: a dispute reverses part of a settlement */
  "dispute_clawback",
  /** escrow → the allocation's worker by a dispute verdict */
  "dispute_worker",
  /** escrow → hold payer by a dispute verdict */
  "dispute_delegator",
] as const;
export type AllocationMoneyKind = (typeof ALLOCATION_MONEY_KINDS)[number];

/** Kinds that pay the allocation's sole hold payer. */
const TO_HOLD_PAYER: ReadonlySet<AllocationMoneyKind> = new Set([
  "settlement_release",
  "retry_exhaustion_refund",
  "sweep_refund",
  "dispute_delegator",
]);

export type AllocationMoneyRefusal =
  | "no_allocation"
  | "exceeds_held"
  | "not_a_party"
  | "unroutable"
  | "insufficient_balance"
  | "invalid_amount"
  | "forward_not_pending"
  | "under_review";

/** A movement the escrow cannot make as asked: the caller's transaction rolls back. */
export class AllocationMoneyRefused extends Error {
  constructor(
    readonly reason: AllocationMoneyRefusal,
    readonly kind: AllocationMoneyKind,
    message: string,
  ) {
    super(message);
    this.name = "AllocationMoneyRefused";
  }
}

/** Forward lifecycle (relay_federation_settlements.status on a sent forward). */
export type ForwardStatus = "pending" | "delivered" | "failed";

// ── Schema ────────────────────────────────────────────────────────────────

function columns(db: DatabaseDriver, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name),
  );
}

/**
 * Idempotent: the escrow stamp columns. relay_transactions gets
 * `allocation_id` + `allocation_kind`; relay_federation_settlements gets
 * `allocation_id` + `status` (a row with no status set is a pre-lifecycle
 * forward: `delivered` unless the upgrade migration derives otherwise from
 * its retry rows); relay_allocations gets `review_reason`, the
 * operator-visible marker of an allocation whose legacy rows could not be
 * attributed. Tables that do not exist yet are skipped (their DDL carries
 * the columns).
 */
export function ensureAllocationEscrowColumns(db: DatabaseDriver): void {
  const tx = columns(db, "relay_transactions");
  if (tx.size > 0) {
    if (!tx.has("allocation_id"))
      db.exec("ALTER TABLE relay_transactions ADD COLUMN allocation_id TEXT");
    if (!tx.has("allocation_kind"))
      db.exec("ALTER TABLE relay_transactions ADD COLUMN allocation_kind TEXT");
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_relay_txn_allocation ON relay_transactions (allocation_id) WHERE allocation_id IS NOT NULL",
    );
  }
  const fed = columns(db, "relay_federation_settlements");
  if (fed.size > 0) {
    if (!fed.has("allocation_id"))
      db.exec("ALTER TABLE relay_federation_settlements ADD COLUMN allocation_id TEXT");
    if (!fed.has("status")) {
      db.exec(
        "ALTER TABLE relay_federation_settlements ADD COLUMN status TEXT NOT NULL DEFAULT 'delivered'",
      );
    }
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_fed_settlements_allocation ON relay_federation_settlements (allocation_id) WHERE allocation_id IS NOT NULL",
    );
  }
  if (tx.size > 0) {
    // The fee journal: what each relay settlement's fee took out of its
    // allocation's escrow, append-only. `held` reads fees here so a retention
    // truncation of relay_settlements (horizon.ts) never makes a settled fee
    // read as escrow again; a settlement with no journal row (written before
    // the journal, or a raw test seed) is read from relay_settlements.
    db.exec(`
      CREATE TABLE IF NOT EXISTS relay_allocation_fees (
        settlement_id TEXT PRIMARY KEY,
        allocation_id TEXT NOT NULL,
        amount INTEGER NOT NULL CHECK (typeof(amount) = 'integer' AND amount >= 0),
        recorded_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_allocation_fees_allocation ON relay_allocation_fees (allocation_id);
    `);
  }
  const alloc = columns(db, "relay_allocations");
  if (alloc.size > 0 && !alloc.has("review_reason")) {
    db.exec("ALTER TABLE relay_allocations ADD COLUMN review_reason TEXT");
  }
}

// ── Held: the one reading ──────────────────────────────────────────────────

/**
 * SQL for an allocation's raw held amount, with `:A` standing for the
 * allocation id expression. One definition, used by `allocationHeld` and by
 * the database guard triggers:
 *
 *   held = −Σ ledger rows attributed to A      (the hold is a −debit, so it adds;
 *                                                payouts subtract; claw-backs add)
 *        − Σ fees of A's relay settlements (the append-only fee journal;
 *          a pre-journal settlement read from its row)
 *        − Σ gross of A's forwards still pending or delivered
 *
 * A ledger row is attributed to A when stamped `allocation_id = A`, or — a row
 * written before the stamp existed — by its type's own reference convention.
 * A forward is A's when stamped, or (pre-stamp) a sent forward of A's task.
 */
function heldSql(a: string): string {
  return `(
    -(SELECT COALESCE(SUM(t.amount), 0) FROM relay_transactions t
       WHERE t.allocation_id = ${a}
          OR (t.allocation_id IS NULL AND t.type IN ('allocation_hold', 'allocation_release')
              AND t.reference_id = ${a})
          OR (t.allocation_id IS NULL AND t.type = 'settlement_credit'
              AND t.reference_id IN (SELECT s.settlement_id FROM relay_settlements s
                                      WHERE s.allocation_id = ${a}
                                        AND COALESCE(s.settlement_mode, 'relay') = 'relay')))
    - (SELECT COALESCE(SUM(j.amount), 0) FROM relay_allocation_fees j WHERE j.allocation_id = ${a})
    - (SELECT COALESCE(SUM(s.platform_fee), 0) FROM relay_settlements s
        WHERE s.allocation_id = ${a} AND COALESCE(s.settlement_mode, 'relay') = 'relay'
          AND s.settlement_id NOT IN (SELECT j.settlement_id FROM relay_allocation_fees j))
    - (SELECT COALESCE(SUM(f.gross_amount), 0) FROM relay_federation_settlements f
        WHERE f.status IN ('pending', 'delivered')
          AND (f.allocation_id = ${a}
               OR (f.allocation_id IS NULL AND f.downstream_relay_id IS NOT NULL
                   AND f.task_id = (SELECT x.task_id FROM relay_allocations x
                                     WHERE x.allocation_id = ${a}))))
  )`;
}

/**
 * What the ledger still holds for an allocation, unfloored (a legacy state
 * that overpaid reads negative; the chokepoint then refuses every outflow).
 */
export function allocationHeldRaw(db: DatabaseDriver, allocationId: string): number {
  return (
    byAllocation(db, `SELECT ${heldSql("?")} AS held`, allocationId).get() as { held: number }
  ).held;
}

/**
 * Bind every `?` in `sql` to the allocation id (the driver binds positional
 * parameters only, so a query naming the allocation N times takes it N times).
 */
function byAllocation(
  db: DatabaseDriver,
  sql: string,
  allocationId: string,
): { get: () => unknown; all: () => unknown[] } {
  const n = (sql.match(/\?/g) ?? []).length;
  const args = Array.from({ length: n }, () => allocationId);
  const stmt = db.prepare(sql);
  return { get: () => stmt.get(...args), all: () => stmt.all(...args) };
}

/** What the ledger still holds for an allocation — the one number every payout reads. */
export function allocationHeld(db: DatabaseDriver, allocationId: string): number {
  return Math.max(0, allocationHeldRaw(db, allocationId));
}

/** The allocation's hold payers: who funded its escrow (attributed hold rows). */
export function allocationHoldPayers(db: DatabaseDriver, allocationId: string): string[] {
  return (
    byAllocation(
      db,
      `SELECT DISTINCT motebit_id FROM relay_transactions
        WHERE type = 'allocation_hold'
          AND (allocation_id = ? OR (allocation_id IS NULL AND reference_id = ?))`,
      allocationId,
    ).all() as Array<{ motebit_id: string }>
  ).map((r) => r.motebit_id);
}

/** The sole hold payer, or null when the ledger names none or more than one. */
export function allocationHoldPayer(db: DatabaseDriver, allocationId: string): string | null {
  const payers = allocationHoldPayers(db, allocationId);
  return payers.length === 1 ? payers[0]! : null;
}

/** The payee a relay settlement of this allocation names in its SIGNED body. */
function settlementPayee(
  db: DatabaseDriver,
  allocationId: string,
  settlementId: string,
): string | null {
  const row = db
    .prepare(
      `SELECT motebit_id, record_json FROM relay_settlements
        WHERE settlement_id = ? AND allocation_id = ? AND COALESCE(settlement_mode, 'relay') = 'relay'`,
    )
    .get(settlementId, allocationId) as
    { motebit_id: string; record_json: string | null } | undefined;
  if (!row) return null;
  if (row.record_json) {
    try {
      const signed = JSON.parse(row.record_json) as { motebit_id?: unknown };
      if (typeof signed.motebit_id === "string") return signed.motebit_id;
    } catch {
      /* fall through to the column */
    }
  }
  return row.motebit_id;
}

/**
 * Per account, what this allocation's OWN settlements paid it, net of the
 * dispute claw-backs already taken from it for this allocation.
 */
export function allocationPaid(
  db: DatabaseDriver,
  allocationId: string,
): Array<{ account: string; amount: number }> {
  return (
    byAllocation(
      db,
      `SELECT motebit_id, SUM(amount) AS amount FROM relay_transactions
        WHERE (type = 'settlement_credit'
               AND reference_id IN (SELECT settlement_id FROM relay_settlements
                                     WHERE allocation_id = ?
                                       AND COALESCE(settlement_mode, 'relay') = 'relay')
               AND (allocation_id = ? OR allocation_id IS NULL))
           OR (allocation_id = ? AND allocation_kind = 'dispute_clawback')
        GROUP BY motebit_id`,
      allocationId,
    ).all() as Array<{ motebit_id: string; amount: number }>
  )
    .map((r) => ({ account: r.motebit_id, amount: r.amount }))
    .filter((p) => p.amount > 0);
}

/** Ledger rows of a dispute movement already attributed to this allocation. */
export function allocationDisputeRows(db: DatabaseDriver, allocationId: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM relay_transactions
          WHERE allocation_id = ? AND allocation_kind IN ('dispute_clawback', 'dispute_worker', 'dispute_delegator')`,
      )
      .get(allocationId) as { n: number }
  ).n;
}

/** The operator-review marker on an allocation, or null. */
export function allocationReviewReason(db: DatabaseDriver, allocationId: string): string | null {
  const row = db
    .prepare("SELECT review_reason FROM relay_allocations WHERE allocation_id = ?")
    .get(allocationId) as { review_reason: string | null } | undefined;
  return row?.review_reason ?? null;
}

// ── The chokepoint ─────────────────────────────────────────────────────────

/** Columns a relay settlement row may carry (insert allowlist). */
const SETTLEMENT_COLUMNS = new Set([
  "settlement_id",
  "allocation_id",
  "task_id",
  "motebit_id",
  "receipt_hash",
  "ledger_hash",
  "amount_settled",
  "platform_fee",
  "platform_fee_rate",
  "status",
  "settled_at",
  "settlement_mode",
  "delegator_id",
  "x402_tx_hash",
  "x402_network",
  "issuer_relay_id",
  "suite",
  "signature",
  "record_json",
  "p2p_tx_hash",
  "payment_verification_status",
  "p2p_worker_leg",
  "p2p_worker_address",
  "p2p_worker_address_rung",
  "receipt_signature",
]);

/** Columns a federation settlement row may carry (insert allowlist). */
const FEDERATION_COLUMNS = new Set([
  "settlement_id",
  "task_id",
  "upstream_relay_id",
  "downstream_relay_id",
  "agent_id",
  "gross_amount",
  "fee_amount",
  "net_amount",
  "fee_rate",
  "settled_at",
  "receipt_hash",
  "x402_tx_hash",
  "x402_network",
  "record_json",
  "receipt_signature",
]);

function insertRow(
  db: DatabaseDriver,
  table: "relay_settlements" | "relay_federation_settlements",
  allow: ReadonlySet<string>,
  row: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  orIgnore = false,
): number {
  const full = { ...row, ...extra };
  const cols = Object.keys(full);
  for (const c of cols) {
    if (!allow.has(c) && !(c in extra)) throw new Error(`${table}: column ${c} not allowed`);
  }
  // The verb + table are literal (one per table and conflict mode), so every
  // write to these tables is visible to the static gates that register them.
  const head =
    table === "relay_settlements"
      ? orIgnore
        ? "INSERT OR IGNORE INTO relay_settlements"
        : "INSERT INTO relay_settlements"
      : orIgnore
        ? "INSERT OR IGNORE INTO relay_federation_settlements"
        : "INSERT INTO relay_federation_settlements";
  return db
    .prepare(`${head} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .run(...cols.map((c) => full[c] as never)).changes;
}

export type AllocationMove =
  | { kind: "hold"; allocationId: string; amount: number; party: string; description: string }
  | {
      kind: "settlement_fee";
      allocationId: string;
      amount: number;
      /** The relay-custody settlement row; its `platform_fee` must equal `amount`. */
      settlement: Record<string, unknown>;
    }
  | {
      kind: "settlement_credit";
      allocationId: string;
      amount: number;
      party: string;
      settlementId: string;
      description: string;
    }
  | {
      kind: "settlement_release" | "retry_exhaustion_refund" | "sweep_refund";
      allocationId: string;
      amount: number;
      party: string;
      description: string;
    }
  | {
      kind: "federated_forward";
      allocationId: string;
      amount: number;
      /** The sent forward's row (`gross_amount` must equal `amount`); recorded `pending`. */
      forward: Record<string, unknown>;
    }
  | { kind: "forward_return"; allocationId: string; amount: number; settlementId: string }
  | {
      kind: "dispute_clawback" | "dispute_worker" | "dispute_delegator";
      allocationId: string;
      amount: number;
      party: string;
      disputeId: string;
      description: string;
    };

function refuse(
  move: AllocationMove,
  reason: AllocationMoneyRefusal,
  detail: string,
): AllocationMoneyRefused {
  logger.warn("allocation_escrow.refused", {
    kind: move.kind,
    allocationId: move.allocationId,
    amount: move.amount,
    reason,
    detail,
  });
  return new AllocationMoneyRefused(
    reason,
    move.kind,
    `allocation ${move.allocationId}: ${move.kind} of ${move.amount} refused (${reason}): ${detail}`,
  );
}

/**
 * Move allocation money — the ONLY writer. Runs synchronously inside the
 * caller's transaction; throws `EmergencyFrozenError` while the relay is
 * frozen, and {@link AllocationMoneyRefused} (writing nothing either way)
 * when the movement would exceed what the allocation holds, pay anyone but a
 * party of that allocation, or the payer cannot cover it.
 */
export function moveAllocationMoney(db: DatabaseDriver, move: AllocationMove): void {
  // The emergency freeze refuses HERE, before anything is read or written:
  // the one place allocation money moves is the one place the freeze holds
  // for it (EmergencyFrozenError; the caller's transaction rolls back). The
  // table triggers stay the second layer for raw writes.
  assertNotFrozen(db);
  const { allocationId, amount } = move;
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw refuse(move, "invalid_amount", `amount ${amount} is not a non-negative integer`);
  }
  const alloc = db
    .prepare(
      "SELECT allocation_id, motebit_id, review_reason FROM relay_allocations WHERE allocation_id = ?",
    )
    .get(allocationId) as
    { allocation_id: string; motebit_id: string; review_reason: string | null } | undefined;

  // A settlement record that moves nothing (a free task: gross 0) is written
  // even with no allocation row; every other movement needs its allocation.
  if (move.kind === "settlement_fee" && amount === 0 && !alloc) {
    insertSettlement(move);
    return;
  }
  if (!alloc) throw refuse(move, "no_allocation", "no relay_allocations row");

  const stamp = { allocationId, kind: move.kind };
  const store = sqliteAccountStoreFor(db);

  if (move.kind === "hold") {
    if (amount === 0) return;
    const after = store.debitSpendable(
      move.party,
      amount,
      "allocation_hold",
      allocationId,
      move.description,
      stamp,
    );
    if (after === null)
      throw refuse(move, "insufficient_balance", `${move.party} cannot fund the hold`);
    return;
  }

  if (move.kind === "forward_return") {
    const fwd = db
      .prepare(
        "SELECT gross_amount, status FROM relay_federation_settlements WHERE settlement_id = ? AND allocation_id = ?",
      )
      .get(move.settlementId, allocationId) as { gross_amount: number; status: string } | undefined;
    if (!fwd || fwd.status !== "pending") {
      throw refuse(
        move,
        "forward_not_pending",
        `forward ${move.settlementId} is ${fwd?.status ?? "absent"}`,
      );
    }
    if (fwd.gross_amount !== amount) {
      throw refuse(move, "invalid_amount", `forward gross is ${fwd.gross_amount}`);
    }
    db.prepare(
      "UPDATE relay_federation_settlements SET status = 'failed' WHERE settlement_id = ? AND status = 'pending'",
    ).run(move.settlementId);
    return;
  }

  if (move.kind === "dispute_clawback") {
    if (alloc.review_reason !== null) throw refuse(move, "under_review", alloc.review_reason);
    if (amount === 0) return;
    const paid =
      allocationPaid(db, allocationId).find((p) => p.account === move.party)?.amount ?? 0;
    if (amount > paid) {
      throw refuse(
        move,
        "not_a_party",
        `${move.party} was paid ${paid} by this allocation's settlements`,
      );
    }
    const after = store.debit(
      move.party,
      amount,
      "settlement_debit",
      move.disputeId,
      move.description,
      stamp,
    );
    if (after === null)
      throw refuse(move, "insufficient_balance", `${move.party} holds less than ${amount}`);
    return;
  }

  // Every remaining kind takes money OUT of the escrow.
  const held = allocationHeldRaw(db, allocationId);
  if (amount > held) throw refuse(move, "exceeds_held", `held ${held}`);

  switch (move.kind) {
    case "settlement_fee": {
      if (move.settlement.allocation_id !== allocationId) {
        throw refuse(move, "not_a_party", "settlement row names another allocation");
      }
      if (move.settlement.platform_fee !== amount) {
        throw refuse(move, "invalid_amount", "settlement platform_fee differs from the fee moved");
      }
      insertSettlement(move);
      return;
    }
    case "settlement_credit": {
      if (amount === 0) return;
      const payee = settlementPayee(db, allocationId, move.settlementId);
      if (payee === null || payee !== move.party) {
        throw refuse(
          move,
          "not_a_party",
          `settlement ${move.settlementId} pays ${payee ?? "nobody"} for this allocation`,
        );
      }
      store.credit(
        move.party,
        amount,
        "settlement_credit",
        move.settlementId,
        move.description,
        stamp,
      );
      return;
    }
    case "federated_forward": {
      if (move.forward.gross_amount !== amount) {
        throw refuse(move, "invalid_amount", "forward gross differs from the amount moved");
      }
      if (move.forward.downstream_relay_id == null) {
        throw refuse(move, "not_a_party", "a forward names the peer it pays");
      }
      insertRow(db, "relay_federation_settlements", FEDERATION_COLUMNS, move.forward, {
        allocation_id: allocationId,
        status: "pending",
      });
      return;
    }
    case "dispute_worker": {
      if (alloc.review_reason !== null) throw refuse(move, "under_review", alloc.review_reason);
      if (amount === 0) return;
      if (move.party !== alloc.motebit_id) {
        throw refuse(move, "not_a_party", `${move.party} is not this allocation's worker`);
      }
      store.credit(
        move.party,
        amount,
        "settlement_credit",
        move.disputeId,
        move.description,
        stamp,
      );
      return;
    }
    default: {
      // TO_HOLD_PAYER kinds.
      if (!TO_HOLD_PAYER.has(move.kind)) throw new Error(`unhandled allocation kind ${move.kind}`);
      if (move.kind === "dispute_delegator" && alloc.review_reason !== null) {
        throw refuse(move, "under_review", alloc.review_reason);
      }
      if (amount === 0) return;
      const payer = allocationHoldPayer(db, allocationId);
      if (payer === null) throw refuse(move, "unroutable", "the ledger names no single hold payer");
      if (move.party !== payer) {
        throw refuse(
          move,
          "not_a_party",
          `${move.party} is not this allocation's hold payer (${payer})`,
        );
      }
      const type = move.kind === "dispute_delegator" ? "settlement_credit" : "allocation_release";
      const ref = move.kind === "dispute_delegator" ? move.disputeId : allocationId;
      store.credit(move.party, amount, type, ref, move.description, stamp);
      return;
    }
  }

  function insertSettlement(m: Extract<AllocationMove, { kind: "settlement_fee" }>): void {
    const mode = m.settlement.settlement_mode ?? "relay";
    if (mode !== "relay") throw refuse(m, "not_a_party", "a relay-custody settlement only");
    insertRow(db, "relay_settlements", SETTLEMENT_COLUMNS, m.settlement);
    if (m.amount > 0) {
      db.prepare(
        "INSERT INTO relay_allocation_fees (settlement_id, allocation_id, amount, recorded_at) VALUES (?, ?, ?, ?)",
      ).run(m.settlement.settlement_id, allocationId, m.amount, Date.now());
    }
  }
}

/**
 * Open an allocation's escrow record (`locked`). Its money arrives only by a
 * `hold` movement; the row alone holds nothing. INSERT OR IGNORE — the
 * submission path's existing idempotency.
 */
export function openAllocation(
  db: DatabaseDriver,
  a: {
    allocationId: string;
    taskId: string;
    worker: string;
    amountLocked: number;
    createdAt: number;
  },
): void {
  db.prepare(
    "INSERT OR IGNORE INTO relay_allocations (allocation_id, task_id, motebit_id, amount_locked, status, created_at) VALUES (?, ?, ?, ?, 'locked', ?)",
  ).run(a.allocationId, a.taskId, a.worker, a.amountLocked, a.createdAt);
}

// ── Non-allocation writers of the same tables ──────────────────────────────

/**
 * Record a P2P settlement AUDIT row: the relay never held the funds (they
 * moved onchain), so it moves no allocation money. INSERT OR IGNORE — the
 * callers' existing idempotency.
 */
export function recordP2pSettlementAudit(db: DatabaseDriver, row: Record<string, unknown>): number {
  if (row.settlement_mode !== "p2p") throw new Error("recordP2pSettlementAudit: p2p rows only");
  return insertRow(db, "relay_settlements", SETTLEMENT_COLUMNS, row, {}, true);
}

/**
 * The FINAL hop of a federated settlement (§7.3): record the received row and
 * pay the local worker, once (the unique (task_id, upstream_relay_id) index
 * makes a re-delivery a no-op). Inbound money from the forwarding peer — no
 * local allocation funds it, and a task this relay holds escrow for is
 * refused (its money moves through `moveAllocationMoney`).
 */
export function recordInboundFederatedSettlement(
  db: DatabaseDriver,
  row: Record<string, unknown>,
  credit: { worker: string | null; amount: number; description: string },
): boolean {
  if (row.downstream_relay_id != null)
    throw new Error("inbound settlements have no downstream relay");
  const local = db
    .prepare("SELECT allocation_id FROM relay_allocations WHERE task_id = ? LIMIT 1")
    .get(row.task_id) as { allocation_id: string } | undefined;
  if (local) {
    throw new Error(
      `inbound settlement for task ${String(row.task_id)} which holds local escrow (${local.allocation_id})`,
    );
  }
  // A re-delivered forward (the §7.4 retry path) is a no-op: the row it wrote
  // stands, and pays once (checked before the INSERT — the one-settlement-
  // per-task guard refuses a second row outright).
  const already = db
    .prepare(
      "SELECT 1 FROM relay_federation_settlements WHERE task_id = ? AND upstream_relay_id = ?",
    )
    .get(row.task_id, row.upstream_relay_id);
  if (already !== undefined) return false;
  const inserted =
    insertRow(db, "relay_federation_settlements", FEDERATION_COLUMNS, row, {}, true) > 0;
  if (inserted && credit.worker != null && credit.amount > 0) {
    sqliteAccountStoreFor(db).credit(
      credit.worker,
      credit.amount,
      "settlement_credit",
      row.settlement_id as string,
      credit.description,
    );
  }
  return inserted;
}

/**
 * Forward lifecycle: claim ONE send of a pending forward. Called immediately
 * before each POST of `/federation/v1/settlement/forward` — the first send
 * and every retry — in the same synchronous turn as the send is started.
 * Refuses while frozen (`EmergencyFrozenError`: the send is the moment money
 * leaves for the peer, which credits its worker on receipt), so a freeze that
 * lands during one send stops every later one. Returns false — send nothing —
 * when the forward is already `delivered`, or `failed` (its gross returned to
 * the escrow and refunded: sending it then would pay twice).
 */
export function beginForwardSend(db: DatabaseDriver, settlementId: string): boolean {
  assertNotFrozen(db);
  const status = forwardOf(db, settlementId)?.status;
  // A forward row the lifecycle never stamped (pre-lifecycle) is sent as before.
  return status !== "delivered" && status !== "failed";
}

/** Forward lifecycle: the peer acknowledged a pending forward. Idempotent. */
export function markForwardDelivered(db: DatabaseDriver, settlementId: string): void {
  db.prepare(
    "UPDATE relay_federation_settlements SET status = 'delivered' WHERE settlement_id = ? AND status = 'pending'",
  ).run(settlementId);
}

/** A sent forward's lifecycle row, or undefined. */
export function forwardOf(
  db: DatabaseDriver,
  settlementId: string,
):
  | { allocation_id: string | null; gross_amount: number; status: ForwardStatus; task_id: string }
  | undefined {
  return db
    .prepare(
      "SELECT allocation_id, gross_amount, status, task_id FROM relay_federation_settlements WHERE settlement_id = ? AND downstream_relay_id IS NOT NULL",
    )
    .get(settlementId) as
    | { allocation_id: string | null; gross_amount: number; status: ForwardStatus; task_id: string }
    | undefined;
}

// ── Database guard ─────────────────────────────────────────────────────────

/**
 * AFTER INSERT triggers that abort any allocation-money row leaving that
 * allocation's held negative. They back the chokepoint (which refuses first,
 * with a typed error); a raw write that bypasses it still cannot overdraw.
 * Idempotent. Legacy rows are untouched (triggers fire on insert only).
 */
export function installAllocationEscrowGuards(db: DatabaseDriver): void {
  const has = (t: string): boolean =>
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) !==
    undefined;
  if (
    !has("relay_transactions") ||
    !has("relay_settlements") ||
    !has("relay_federation_settlements") ||
    !has("relay_allocations")
  ) {
    return;
  }
  const abort = "SELECT RAISE(ABORT, 'allocation escrow overdrawn')";
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_allocation_escrow_txn
    AFTER INSERT ON relay_transactions
    WHEN NEW.allocation_id IS NOT NULL AND NEW.amount > 0
    BEGIN
      ${abort} WHERE ${heldSql("NEW.allocation_id")} < 0;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_allocation_escrow_settlement
    AFTER INSERT ON relay_settlements
    WHEN COALESCE(NEW.settlement_mode, 'relay') = 'relay' AND NEW.platform_fee > 0
      AND EXISTS (SELECT 1 FROM relay_allocations WHERE allocation_id = NEW.allocation_id)
    BEGIN
      ${abort} WHERE ${heldSql("NEW.allocation_id")} < 0;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_allocation_escrow_forward
    AFTER INSERT ON relay_federation_settlements
    WHEN NEW.allocation_id IS NOT NULL
    BEGIN
      ${abort} WHERE ${heldSql("NEW.allocation_id")} < 0;
    END;
  `);
}

// ── Upgrade migration ──────────────────────────────────────────────────────

/**
 * The upgrade step for rows written before the chokepoint (idempotent — it
 * only fills what is unset and re-derives what is derivable):
 *
 * 0. Fees and settlement credits. Every relay settlement's fee is copied into
 *    the append-only fee journal and every settlement credit is stamped with
 *    its settlement's allocation, so `held` no longer depends on
 *    relay_settlements rows a retention horizon may truncate.
 * 1. Forward lifecycle. Every sent forward (downstream_relay_id set) is
 *    stamped with its task's allocation, and its status derived from its
 *    retry rows: a `failed` retry ⇒ `failed`, a `pending` one ⇒ `pending`,
 *    otherwise (completed, or delivered at once with no retry) ⇒ `delivered`.
 * 2. Dispute attribution. A dispute row is stamped with the allocation it
 *    actually moved: a well-formed dispute's (task_id = its allocation's
 *    task) by its allocation. A dispute whose task_id names ANOTHER
 *    allocation (admitted before the §4.2 binding) moved one of two
 *    allocations' money: each row goes to the one whose parties it touched
 *    (hold payer, worker, an account its own settlements paid). Such an
 *    allocation is flagged for operator review — a legacy cross-allocation
 *    movement no rule here may treat as that allocation's own fund action —
 *    and a row touching both or neither is ambiguous: it is left unstamped
 *    and BOTH allocations are flagged. Nothing flagged is silently closed:
 *    `review_reason` is set and visible, dispute fund actions on it refuse
 *    (`under_review`).
 * 3. A released / settled allocation that still holds escrow because a
 *    forward it counted as moved had in fact failed is flagged
 *    `failed_forward_unrefunded`.
 */
export function backfillAllocationEscrow(db: DatabaseDriver): {
  forwards: number;
  disputeRows: number;
  flagged: number;
} {
  ensureAllocationEscrowColumns(db);
  const has = (t: string): boolean =>
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) !==
    undefined;
  let forwards = 0;
  let disputeRows = 0;
  let flagged = 0;
  const flag = (allocationId: string, reason: string): void => {
    flagged += db
      .prepare(
        "UPDATE relay_allocations SET review_reason = ? WHERE allocation_id = ? AND review_reason IS NULL",
      )
      .run(reason, allocationId).changes;
  };

  if (has("relay_federation_settlements") && has("relay_allocations")) {
    forwards += db
      .prepare(
        `UPDATE relay_federation_settlements
            SET allocation_id = (SELECT a.allocation_id FROM relay_allocations a
                                  WHERE a.task_id = relay_federation_settlements.task_id)
          WHERE allocation_id IS NULL AND downstream_relay_id IS NOT NULL
            AND EXISTS (SELECT 1 FROM relay_allocations a
                         WHERE a.task_id = relay_federation_settlements.task_id)`,
      )
      .run().changes;
    if (has("relay_settlement_retries")) {
      db.prepare(
        `UPDATE relay_federation_settlements
            SET status = CASE
              WHEN EXISTS (SELECT 1 FROM relay_settlement_retries r
                            WHERE r.settlement_id = relay_federation_settlements.settlement_id
                              AND r.status = 'failed') THEN 'failed'
              WHEN EXISTS (SELECT 1 FROM relay_settlement_retries r
                            WHERE r.settlement_id = relay_federation_settlements.settlement_id
                              AND r.status = 'pending') THEN 'pending'
              ELSE 'delivered' END
          WHERE downstream_relay_id IS NOT NULL`,
      ).run();
    }
  }

  if (has("relay_settlements") && has("relay_allocations") && has("relay_transactions")) {
    // Pre-journal fees and pre-stamp settlement credits: attribute them now,
    // so a later retention truncation of relay_settlements changes no held.
    db.prepare(
      `INSERT OR IGNORE INTO relay_allocation_fees (settlement_id, allocation_id, amount, recorded_at)
       SELECT s.settlement_id, s.allocation_id, s.platform_fee, COALESCE(s.settled_at, 0)
         FROM relay_settlements s
        WHERE COALESCE(s.settlement_mode, 'relay') = 'relay' AND s.platform_fee > 0
          AND typeof(s.platform_fee) = 'integer'
          AND EXISTS (SELECT 1 FROM relay_allocations a WHERE a.allocation_id = s.allocation_id)`,
    ).run();
    db.prepare(
      `UPDATE relay_transactions
          SET allocation_id = (SELECT s.allocation_id FROM relay_settlements s
                                WHERE s.settlement_id = relay_transactions.reference_id),
              allocation_kind = 'settlement_credit'
        WHERE allocation_id IS NULL AND type = 'settlement_credit'
          AND reference_id IN (SELECT s.settlement_id FROM relay_settlements s
                                 JOIN relay_allocations a ON a.allocation_id = s.allocation_id
                                WHERE COALESCE(s.settlement_mode, 'relay') = 'relay')`,
    ).run();
  }

  if (has("relay_disputes") && has("relay_allocations") && has("relay_transactions")) {
    // Well-formed disputes: the dispute's own allocation.
    disputeRows += db
      .prepare(
        `UPDATE relay_transactions
            SET allocation_id = (SELECT d.allocation_id FROM relay_disputes d
                                  WHERE d.dispute_id = relay_transactions.reference_id),
                allocation_kind = CASE
                  WHEN amount < 0 THEN 'dispute_clawback'
                  WHEN motebit_id IN (SELECT h.motebit_id FROM relay_transactions h
                                       JOIN relay_disputes d ON d.dispute_id = relay_transactions.reference_id
                                      WHERE h.type = 'allocation_hold' AND h.reference_id = d.allocation_id)
                    THEN 'dispute_delegator'
                  ELSE 'dispute_worker' END
          WHERE allocation_id IS NULL
            AND reference_id IN (SELECT d.dispute_id FROM relay_disputes d
                                   JOIN relay_allocations a ON a.allocation_id = d.allocation_id
                                  WHERE a.task_id = d.task_id)`,
      )
      .run().changes;

    // Cross-allocation (pre-§4.2) disputes: attribute each row by party.
    const crossRows = db
      .prepare(
        `SELECT t.rowid AS rid, t.motebit_id, t.amount, d.allocation_id AS a1,
                (SELECT a2.allocation_id FROM relay_allocations a2 WHERE a2.task_id = d.task_id) AS a2
           FROM relay_transactions t
           JOIN relay_disputes d ON d.dispute_id = t.reference_id
           JOIN relay_allocations a ON a.allocation_id = d.allocation_id
          WHERE t.allocation_id IS NULL AND a.task_id != d.task_id`,
      )
      .all() as Array<{
      rid: number;
      motebit_id: string;
      amount: number;
      a1: string;
      a2: string | null;
    }>;
    const partiesOf = new Map<string, Set<string>>();
    const parties = (allocationId: string): Set<string> => {
      let p = partiesOf.get(allocationId);
      if (!p) {
        const worker = db
          .prepare("SELECT motebit_id FROM relay_allocations WHERE allocation_id = ?")
          .get(allocationId) as { motebit_id: string } | undefined;
        const paid = db
          .prepare(
            `SELECT DISTINCT t.motebit_id FROM relay_transactions t
               JOIN relay_settlements s ON s.settlement_id = t.reference_id
              WHERE t.type = 'settlement_credit' AND s.allocation_id = ?`,
          )
          .all(allocationId) as Array<{ motebit_id: string }>;
        p = new Set([
          ...allocationHoldPayers(db, allocationId),
          ...(worker ? [worker.motebit_id] : []),
          ...paid.map((r) => r.motebit_id),
        ]);
        partiesOf.set(allocationId, p);
      }
      return p;
    };
    for (const r of crossRows) {
      const in1 = parties(r.a1).has(r.motebit_id);
      const in2 = r.a2 !== null && parties(r.a2).has(r.motebit_id);
      if (in1 === in2) {
        // Ambiguous (touches both, or neither): left unstamped, both flagged.
        flag(r.a1, "legacy_ambiguous_dispute_rows");
        if (r.a2 !== null) flag(r.a2, "legacy_ambiguous_dispute_rows");
        continue;
      }
      const target = in1 ? r.a1 : r.a2!;
      flag(target, "legacy_cross_allocation_dispute");
      const kind =
        r.amount < 0
          ? "dispute_clawback"
          : allocationHoldPayers(db, target).includes(r.motebit_id)
            ? "dispute_delegator"
            : "dispute_worker";
      disputeRows += db
        .prepare(
          "UPDATE relay_transactions SET allocation_id = ?, allocation_kind = ? WHERE rowid = ?",
        )
        .run(target, kind, r.rid).changes;
    }
    // A cross-allocation dispute that moved nothing flags nothing: only the
    // allocation whose money a legacy row actually touched is under review,
    // and that row never counts as a prior action for the OTHER allocation.
  }

  if (has("relay_federation_settlements") && has("relay_allocations")) {
    const stranded = db
      .prepare(
        `SELECT DISTINCT a.allocation_id FROM relay_allocations a
           JOIN relay_federation_settlements f ON f.allocation_id = a.allocation_id
          WHERE f.status = 'failed' AND a.status IN ('released', 'settled')`,
      )
      .all() as Array<{ allocation_id: string }>;
    for (const { allocation_id } of stranded) {
      if (allocationHeldRaw(db, allocation_id) > 0)
        flag(allocation_id, "failed_forward_unrefunded");
    }
  }
  if (flagged > 0) logger.warn("allocation_escrow.flagged_for_review", { flagged });
  return { forwards, disputeRows, flagged };
}
