/**
 * Persistent emergency freeze state.
 *
 * Read-through cache backed by SQLite relay_config table.
 * Write to DB first, then update in-memory cache. On startup, load from DB.
 */

import type { DatabaseDriver } from "@motebit/persistence";
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
// Table-level on purpose: any door — today's or one added later (a dispute's
// allocation money routed through one chokepoint) — that writes a guarded
// table is refused without knowing about the freeze. Claims and queue rows are
// not guarded, so a refused write leaves its work exactly where a crash between
// claim and settle would: it resumes after unfreeze, once.

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
 * after the schema and migrations: a migration that rebuilds a table drops its
 * triggers. Idempotent. Throws if a guarded table does not exist.
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
      const narrowed = NARROWED[table]?.[op];
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
