/**
 * Persistent emergency freeze state.
 *
 * Read-through cache backed by SQLite relay_config table.
 * Write to DB first, then update in-memory cache. On startup, load from DB.
 */

import type { DatabaseDriver } from "@motebit/persistence";
import { EmergencyFrozenError } from "./errors.js";
import { createLogger } from "./logger.js";

const logger = createLogger({ service: "freeze" });

export interface FreezeState {
  frozen: boolean;
  reason: string | null;
}

/**
 * Create the relay_config table if it doesn't exist.
 * Generic key-value store for relay-level configuration that must survive restarts.
 */
export function createRelayConfigTable(db: DatabaseDriver): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS relay_config (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

/**
 * Load persisted freeze state from the database.
 * Returns { frozen: false, reason: null } if no persisted state exists.
 */
export function loadFreezeState(db: DatabaseDriver): FreezeState {
  try {
    const row = db.prepare("SELECT value FROM relay_config WHERE key = ?").get("freeze_state") as
      { value: string } | undefined;

    if (!row) {
      return { frozen: false, reason: null };
    }

    const parsed = JSON.parse(row.value) as { frozen: boolean; reason: string | null };
    return {
      frozen: Boolean(parsed.frozen),
      reason: parsed.reason ?? null,
    };
  } catch (err) {
    logger.error("freeze.load_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    // Fail-closed: if we can't read freeze state, assume not frozen
    // (the alternative — assuming frozen — would block all writes on a corrupt config row)
    return { frozen: false, reason: null };
  }
}

/**
 * Persist freeze state to the database atomically, then update the in-memory cache.
 * DB write happens first so a crash between write and cache update is safe
 * (next startup will load the persisted state).
 */
export function persistFreeze(
  db: DatabaseDriver,
  cache: FreezeState,
  frozen: boolean,
  reason: string | null,
): void {
  const value = JSON.stringify({ frozen, reason });

  try {
    db.prepare(
      "INSERT INTO relay_config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    ).run("freeze_state", value, Date.now());
  } catch (err) {
    throw new Error("Failed to persist freeze state", { cause: err });
  }

  // Update in-memory cache only after successful DB write
  cache.frozen = frozen;
  cache.reason = reason;
}

// ---------------------------------------------------------------------------
// Freeze at the money chokepoint
// ---------------------------------------------------------------------------
//
// The freeze middleware refuses a mutating request at ENTRY. A request, a
// loop pass or a recovery replay already past that check when the freeze
// lands would still commit its settlement. The invariant is "while frozen,
// NO money-moving write commits", so the freeze is re-checked where money is
// written: a BEFORE trigger on every money table reads the PERSISTED freeze
// row inside the write's own transaction and aborts it.
//
// Two layers, one rule. Allocation money moves through ONE function
// (`moveAllocationMoney`, allocation-escrow.ts), and that function refuses
// first (`assertNotFrozen`, below) — the freeze sits AT the escrow chokepoint,
// as does the forward lifecycle's per-send claim (`beginForwardSend`). The
// table triggers are the second layer: every other money writer (withdrawals,
// deposits, x402 credit, inbound federated credit) and any raw write that
// bypasses the chokepoint is refused without knowing about the freeze. Claims
// and queue rows are not guarded, so a refused write leaves its work exactly
// where a crash between claim and settle would: it resumes after unfreeze,
// once.
//
// Columns, not rows: a settlement row's `anchor_batch_id` (the anchoring
// cut's bookkeeping) and its P2P verification record are never money, so an
// UPDATE that changes only them commits while frozen — an anchoring pass in
// flight must not be left half-cut (`FREEZE_NON_MONEY_COLUMNS`).

/** The RAISE message the guards abort with; mapped to `EmergencyFrozenError`. */
export const EMERGENCY_FROZEN_SENTINEL = "EMERGENCY_FROZEN";

/**
 * Money tables: INSERT/UPDATE/DELETE is refused while frozen. Value: why the
 * table is money.
 */
export const FREEZE_GUARDED_MONEY_TABLES: Readonly<Record<string, string>> = {
  relay_settlements: "local + P2P-audit settlement rows (the payout decision)",
  relay_federation_settlements: "cross-relay settlement rows",
  relay_transactions: "the virtual-account ledger",
  relay_accounts: "virtual-account balances",
  relay_x402_settlements: "x402 payment outcomes and their credit",
  relay_withdrawals: "withdrawal claims (the decision to pay out)",
  relay_pending_withdrawals: "batched withdrawals: the enqueue and the claim to fire",
  relay_deposit_detector: "the onchain deposit scan cursor (advances only with a credit)",
};

/**
 * Narrowed guards: a row change on a guarded table that moves no money is not
 * refused. Each is `WHEN` SQL over NEW/OLD, ANDed with "frozen".
 *
 * The withdrawal tables are guarded at their DECISIONS (a request — whose
 * debit also shares its transaction —, a claim, a deletion). The outcome
 * record of a payout already claimed and sent is not refused: a freeze cannot
 * recall a send in flight, and refusing its record would lose the only trace
 * of money that left.
 */
const NARROWED: Readonly<
  Record<string, Partial<Record<"INSERT" | "UPDATE" | "DELETE", string | null>>>
> = {
  relay_accounts: {
    // An empty account row (created on first read) moves no money.
    INSERT: "NEW.balance <> 0",
    UPDATE: "NEW.balance IS NOT OLD.balance",
  },
  relay_withdrawals: {
    // null = not refused: a request's INSERT follows its guarded debit
    // synchronously (a refused debit never inserts); the other INSERT is a
    // fired payout's record.
    INSERT: null,
    // Leaving `pending` is the claim (or an operator's complete/fail).
    UPDATE: "OLD.status = 'pending' AND NEW.status IS NOT OLD.status",
  },
  relay_pending_withdrawals: {
    // The claim to fire; a `firing` row's outcome (fired/failed) is a record.
    UPDATE: "OLD.status = 'pending' AND NEW.status IS NOT OLD.status",
  },
};

/**
 * Columns of a guarded table that are not money: an UPDATE that changes only
 * these is not refused. The UPDATE guard of a table listed here refuses a
 * change to any of its {@link FREEZE_MONEY_COLUMNS} (and, fail-closed, to any
 * live column in neither list).
 */
export const FREEZE_NON_MONEY_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  // The anchoring cut assigns leaves to a signed batch (anchoring.ts); the
  // P2P verifier records what the chain shows of a payment the relay never
  // held (p2p-verifier.ts) — neither moves money.
  relay_settlements: [
    "anchor_batch_id",
    "payment_verification_status",
    "payment_verified_at",
    "payment_verification_error",
  ],
  relay_federation_settlements: ["anchor_batch_id"],
};

/**
 * The MONEY columns of each column-narrowed table — declared, not read from
 * the live schema, so the guard is the same on a first boot as on a restart
 * (a column a later boot step adds — `receipt_signature`, added by the task
 * queue — would otherwise be missing from a first boot's guard). Every live
 * column must be here or in {@link FREEZE_NON_MONEY_COLUMNS}
 * (`freeze-money-chokepoint.test.ts` fails on an unclassified one); a live
 * column in neither is still guarded (fail-closed), and a declared one
 * missing from the live schema makes install throw (it ran before the
 * schema was complete).
 */
export const FREEZE_MONEY_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  relay_settlements: [
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
    "x402_tx_hash",
    "x402_network",
    "settlement_mode",
    "p2p_tx_hash",
    "delegator_id",
    "issuer_relay_id",
    "suite",
    "signature",
    "record_json",
    "p2p_worker_leg",
    "p2p_worker_address",
    "p2p_worker_address_rung",
    "receipt_signature",
  ],
  relay_federation_settlements: [
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
    "record_json",
    "allocation_id",
    "status",
    "x402_tx_hash",
    "x402_network",
    "receipt_signature",
  ],
};

/**
 * Status transitions on a guarded table that record an outcome rather than
 * move money: `pending → delivered` is the peer's acknowledgement of a
 * forward already sent (`markForwardDelivered`; `held` counts pending and
 * delivered alike). A freeze cannot recall a send in flight; refusing its
 * record would only re-send it after unfreeze.
 */
const FREEZE_RECORD_TRANSITIONS: Readonly<Record<string, string>> = {
  relay_federation_settlements: "OLD.status = 'pending' AND NEW.status = 'delivered'",
};

/**
 * The columns whose change the UPDATE guard of a column-narrowed table
 * refuses: the declared money columns, plus any live column classified in
 * neither list (fail-closed). Throws if a declared money column does not
 * exist yet — the guards must be installed after every schema mutation.
 */
export function freezeGuardedUpdateColumns(db: DatabaseDriver, table: string): string[] {
  const exempt = new Set(FREEZE_NON_MONEY_COLUMNS[table]);
  const declared = FREEZE_MONEY_COLUMNS[table] ?? [];
  const live = (
    db.prepare(`PRAGMA main.table_info(${table})`).all() as Array<{ name: string }>
  ).map((c) => c.name);
  const liveSet = new Set(live);
  const missing = declared.filter((c) => !liveSet.has(c));
  if (missing.length > 0) {
    throw new Error(
      `installFreezeMoneyGuards: ${table} lacks declared money column(s) ${missing.join(", ")} — install the guards after every schema mutation`,
    );
  }
  const unclassified = live.filter((c) => !exempt.has(c) && !declared.includes(c));
  return [...declared, ...unclassified];
}

/** The UPDATE guard of a column-narrowed table: some money column changes. */
function moneyColumnsChange(db: DatabaseDriver, table: string): string {
  const record = FREEZE_RECORD_TRANSITIONS[table];
  const cols = freezeGuardedUpdateColumns(db, table);
  const changes = cols.map((c) =>
    c === "status" && record != null
      ? `(NEW.status IS NOT OLD.status AND NOT (${record}))`
      : `NEW.${c} IS NOT OLD.${c}`,
  );
  return changes.length > 0 ? changes.join(" OR ") : "0";
}

/**
 * Money-shaped tables deliberately NOT guarded, each with its reason. A table
 * whose name looks like money must be in one of the two registries
 * (`freeze-money-chokepoint.test.ts` fails on an unclassified one).
 */
export const FREEZE_EXEMPT_TABLES: Readonly<Record<string, string>> = {
  relay_allocations:
    "budget holds — written in the same transaction as the guarded relay_accounts debit/credit",
  relay_deposit_log:
    "deposit dedup — written in the same transaction as the guarded relay_accounts credit",
  relay_refund_log:
    "refund dedup — written in the same transaction as the guarded relay_accounts credit",
  relay_allocation_fees:
    "the escrow fee journal — written only inside moveAllocationMoney, which refuses while frozen, in the same transaction as the guarded relay_settlements row",
  relay_dispute_fund_actions:
    "a dispute's write-once fund-action claim — in the same transaction as its legs, which moveAllocationMoney refuses while frozen",
  relay_free_grants:
    "promotional grant record — written in the same transaction as the guarded relay_accounts credit",
  relay_disputes: "dispute records; their money leg (refund/settlement) is guarded",
  relay_dispute_evidence: "dispute evidence; moves no money",
  relay_dispute_resolutions: "dispute resolution records; their money leg is guarded",
  relay_dispute_votes: "adjudicator votes; move no money",
  relay_dispute_orchestrations: "dispute orchestration state; moves no money",
  relay_witness_omission_disputes: "federation witness records; move no money",
  relay_treasury_reconciliations: "observability of the fee address; moves no money",
  relay_bond_commitments: "RPC-verified staked signal, never custodied; moves no money",
  relay_settlement_retries:
    "the settlement-forward retry queue — left as it was so the work resumes after unfreeze",
  relay_settlement_proofs:
    "proof of an external rail transfer that already happened; refusing it would lose the record",
  relay_settlement_payee_corrections: "migration-time attribution corrections; move no money",
  relay_p2p_proof_claims: "admission claims on onchain proofs; the relay moves no P2P money",
  relay_agent_wallets: "settlement address registry; moves no money",
  relay_withdrawal_chain_claims:
    "the Path 0 chain-record marker — written in the same transaction as the guarded `pending → processing` payout claim (#990)",
  relay_withdrawal_payout_attempts:
    "the Solana transactions a payout signs, recorded before broadcast, and their finalized statuses — evidence of what the chain decided; a payout is signed only after its guarded claim, a kill moves no money, and the refund or completion it decides is guarded (#990)",
  relay_withdrawal_payout_queue:
    "the nonce-lane payout queue (withdrawal ids only) — left as it was so the work resumes after unfreeze (#990)",
  relay_subscriptions: "subscription status; its credit leg is guarded",
  relay_execution_ledgers: "goal execution ledgers; not money",
  // The agent-runtime schema `@motebit/persistence` creates in every motebit
  // database, the relay's included. The relay never writes these tables.
  budget_allocations: "agent-runtime schema (@motebit/persistence); the relay never writes it",
  settlements: "agent-runtime schema (@motebit/persistence); the relay never writes it",
  grant_spend_state: "agent-runtime schema (@motebit/persistence); the relay never writes it",
  paid_intent_ledger: "agent-runtime schema (@motebit/persistence); the relay never writes it",
};

/** Whether the persisted freeze row says frozen (same parse rule as `loadFreezeState`). */
const FROZEN_SQL = `(SELECT CASE WHEN json_valid(value) THEN json_extract(value, '$.frozen') END
     FROM main.relay_config WHERE key = 'freeze_state') = 1`;

/**
 * Install the freeze guards on this connection. TEMP triggers (per connection,
 * never written into the database file) on `main` tables; the relay holds ONE
 * connection, so every write of the running relay passes them. Call at boot
 * after EVERY schema mutation (schema, migrations, the task queue's columns):
 * a migration that rebuilds a table drops its triggers. Idempotent. Throws if
 * a guarded table or a declared money column does not exist.
 */
export function installFreezeMoneyGuards(db: DatabaseDriver): void {
  for (const table of Object.keys(FREEZE_GUARDED_MONEY_TABLES)) {
    const exists = db
      .prepare("SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = ?")
      .get(table);
    if (exists == null) {
      throw new Error(`installFreezeMoneyGuards: guarded money table ${table} does not exist`);
    }
    for (const op of ["INSERT", "UPDATE", "DELETE"] as const) {
      const narrowed =
        op === "UPDATE" && table in FREEZE_NON_MONEY_COLUMNS
          ? moneyColumnsChange(db, table)
          : NARROWED[table]?.[op];
      if (narrowed === null) continue;
      const extra = narrowed != null ? ` AND (${narrowed})` : "";
      db.exec(
        `CREATE TEMP TRIGGER IF NOT EXISTS freeze_guard_${table}_${op.toLowerCase()}
           BEFORE ${op} ON main.${table}
           WHEN ${FROZEN_SQL}${extra}
         BEGIN SELECT RAISE(ABORT, '${EMERGENCY_FROZEN_SENTINEL}'); END;`,
      );
    }
  }
}

/**
 * Whether the PERSISTED freeze row says frozen — read inside the caller's
 * transaction, the same row and rule the triggers read (never the in-memory
 * cache, which a second process or a just-landed admin write may not share).
 * A database without the row (or the table) is not frozen.
 */
export function isFrozenNow(db: DatabaseDriver): boolean {
  try {
    const row = db.prepare(`SELECT ${FROZEN_SQL} AS frozen`).get() as
      { frozen: number | null } | undefined;
    return row?.frozen === 1;
  } catch {
    return false;
  }
}

/**
 * Refuse a money movement while frozen: throws {@link EmergencyFrozenError}.
 * Called synchronously where money moves — first thing in
 * `moveAllocationMoney` and in the forward lifecycle's send claim — so the
 * check and the write share one synchronous turn (no freeze can land
 * between them).
 */
export function assertNotFrozen(db: DatabaseDriver): void {
  if (isFrozenNow(db)) throw new EmergencyFrozenError();
}

/**
 * The expiry floor below which a claimed-but-unsettled task entry may be
 * deleted (`TaskQueue.cleanup` / `evict`). Normally `now - holdMs`. While
 * frozen no such claim may go — the freeze is what keeps it unsettled — and
 * for `holdMs` after an unfreeze every claim is held, so the recovery pass
 * gets the same hold a claim would have had without the freeze.
 */
export function claimHoldFloor(db: DatabaseDriver, now: number, holdMs: number): number {
  try {
    const row = db
      .prepare("SELECT value, updated_at FROM relay_config WHERE key = 'freeze_state'")
      .get() as { value: string; updated_at: number } | undefined;
    if (row == null) return now - holdMs;
    const frozen = (JSON.parse(row.value) as { frozen?: unknown }).frozen === true;
    if (frozen || row.updated_at >= now - holdMs) return Number.MIN_SAFE_INTEGER;
  } catch {
    // No relay_config (a bare TaskQueue): the plain hold.
  }
  return now - holdMs;
}

/** The names of the freeze guards installed on this connection. */
export function installedFreezeGuards(db: DatabaseDriver): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM temp.sqlite_master WHERE type = 'trigger' AND name LIKE 'freeze_guard_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

/** Whether `err` (or any error in its cause chain) is a freeze guard's abort. */
export function isEmergencyFrozenAbort(err: unknown): boolean {
  let cur: unknown = err;
  for (let hop = 0; cur != null && hop < 8; hop++) {
    if (cur instanceof Error) {
      if ((cur as { code?: unknown }).code === EMERGENCY_FROZEN_SENTINEL) return true;
      if (cur.message === EMERGENCY_FROZEN_SENTINEL) return true;
      cur = cur.cause;
    } else {
      return false;
    }
  }
  return false;
}
