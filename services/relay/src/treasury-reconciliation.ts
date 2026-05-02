/**
 * Treasury reconciliation — services/relay side. The algebra lives in
 * `@motebit/treasury-reconciliation`; this file is the relay-specific wiring:
 *
 *  - `SqliteTreasuryReconciliationStore` — DB-backed store implementing
 *    `getRecordedFeeSumMicro` (over `relay_settlements`) and
 *    `persistReconciliation` (into `relay_treasury_reconciliations`).
 *  - `createTreasuryReconciliationTable` — relay's local DDL (also persisted
 *    via the canonical `Migration` ladder for production schema-version
 *    advancement; the standalone helper is for tests that bypass migrations).
 *  - `startTreasuryReconciliationLoop` — setInterval loop mirroring
 *    `startCredentialAnchorLoop`. Single-tick async-fire, structured error
 *    logging, respects `isFrozen()` callback.
 *  - `getTreasuryReconciliationStats` + `listTreasuryReconciliations` —
 *    admin-endpoint query helpers.
 *
 * The treasury is an OPERATOR address (the relay's x402 fee-collection wallet),
 * never an agent wallet — see `packages/treasury-reconciliation/CLAUDE.md` Rule 1
 * for the canonical doctrine on why this primitive must NOT be unified with the
 * deposit-detector. This file's only job is to plumb the pure algebra into the
 * relay's accounting tables + boot lifecycle + admin surface.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseDriver } from "@motebit/persistence";
import {
  reconcileTreasury,
  type EvmRpcAdapter,
  type ReconciliationResult,
  type TreasuryReconciliationLogger,
  type TreasuryReconciliationStore,
} from "@motebit/treasury-reconciliation";
import { createLogger } from "./logger.js";

export type { EvmRpcAdapter, ReconciliationResult };

const logger = createLogger({ service: "treasury-reconciliation" });

/** Default cadence for the reconciliation loop: 15 minutes. */
const DEFAULT_INTERVAL_MS = 15 * 60_000;

/** Default confirmation-lag buffer: 5 minutes. Settlements newer than this
 *  window are excluded from the recorded-fee-sum query because the
 *  corresponding x402 facilitator transfers may not have reached the chain's
 *  safe horizon yet. Generous default for L2 chains; phase 2 may tune
 *  per-chain alongside CONFIRMATIONS_BY_CHAIN. */
const DEFAULT_CONFIRMATION_LAG_BUFFER_MS = 5 * 60_000;

/** Persisted row shape — mirrors the SQL columns 1:1. */
export interface StoredReconciliationRecord {
  reconciliation_id: string;
  run_at: number;
  chain: string;
  treasury_address: string;
  usdc_contract_address: string;
  recorded_fee_sum_micro: string; // SQLite stores TEXT; bigint round-trip
  observed_onchain_balance_micro: string;
  drift_micro: string;
  consistent: number; // 0 | 1
  confirmation_lag_buffer_ms: number;
  notes: string | null;
}

/** Aggregated view returned by the admin endpoint. */
export interface TreasuryReconciliationStats {
  total_runs: number;
  inconsistent_runs_24h: number;
  inconsistent_runs_7d: number;
  max_negative_drift_micro_7d: string;
  last_run_at: number | null;
  current_drift_micro: string | null;
  current_consistent: boolean | null;
}

/** Idempotent DDL — also reachable via the v23 migration (production path)
 *  but exposed standalone for tests that bypass `runMigrations`. */
export function createTreasuryReconciliationTable(db: DatabaseDriver): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS relay_treasury_reconciliations (
      reconciliation_id TEXT PRIMARY KEY,
      run_at INTEGER NOT NULL,
      chain TEXT NOT NULL,
      treasury_address TEXT NOT NULL,
      usdc_contract_address TEXT NOT NULL,
      recorded_fee_sum_micro TEXT NOT NULL,
      observed_onchain_balance_micro TEXT NOT NULL,
      drift_micro TEXT NOT NULL,
      consistent INTEGER NOT NULL,
      confirmation_lag_buffer_ms INTEGER NOT NULL,
      notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_treasury_recon_run_at
      ON relay_treasury_reconciliations(run_at);
    CREATE INDEX IF NOT EXISTS idx_treasury_recon_consistent
      ON relay_treasury_reconciliations(consistent);
  `);
}

/** DB-backed implementation of the package's `TreasuryReconciliationStore`. */
export class SqliteTreasuryReconciliationStore implements TreasuryReconciliationStore {
  constructor(private readonly db: DatabaseDriver) {}

  /**
   * Sum `platform_fee` over relay-mediated settlements on `chain` whose
   * `settled_at < asOfMs`. p2p settlements are excluded (zero-fee per
   * product policy, see `services/relay/CLAUDE.md` rule 8). Settlements
   * newer than the safe horizon are excluded to bound false-positive
   * negative drift while x402 facilitator transfers are still settling
   * past the chain's confirmation depth.
   *
   * Note: `relay_settlements` doesn't carry an explicit `chain` column;
   * the chain is implicit in the x402_network field (set by the
   * `onAfterSettle` callback in `tasks.ts`). We filter on `x402_network`
   * here and treat `settlement_mode='relay' AND x402_network=?` as
   * "fees that flow into the treasury on this chain."
   */
  getRecordedFeeSumMicro(chain: string, asOfMs: number): bigint {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(platform_fee), 0) AS total
           FROM relay_settlements
          WHERE settlement_mode = 'relay'
            AND x402_network = ?
            AND settled_at < ?`,
      )
      .get(chain, asOfMs) as { total: number };
    return BigInt(row.total);
  }

  persistReconciliation(result: ReconciliationResult): void {
    this.db
      .prepare(
        `INSERT INTO relay_treasury_reconciliations
           (reconciliation_id, run_at, chain, treasury_address,
            usdc_contract_address, recorded_fee_sum_micro,
            observed_onchain_balance_micro, drift_micro, consistent,
            confirmation_lag_buffer_ms, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        result.reconciliationId,
        result.runAtMs,
        result.chain,
        result.treasuryAddress,
        result.usdcContractAddress,
        result.recordedFeeSumMicro.toString(),
        result.observedOnchainBalanceMicro.toString(),
        result.driftMicro.toString(),
        result.consistent ? 1 : 0,
        result.confirmationLagBufferMs,
        null,
      );
  }
}

/** Aggregate view for `/api/v1/admin/treasury-reconciliation`. */
export function getTreasuryReconciliationStats(db: DatabaseDriver): TreasuryReconciliationStats {
  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60_000;
  const oneWeekAgo = now - 7 * 24 * 60 * 60_000;

  const total = db.prepare("SELECT COUNT(*) as cnt FROM relay_treasury_reconciliations").get() as {
    cnt: number;
  };

  const inconsistent24h = db
    .prepare(
      "SELECT COUNT(*) as cnt FROM relay_treasury_reconciliations WHERE consistent = 0 AND run_at >= ?",
    )
    .get(oneDayAgo) as { cnt: number };

  const inconsistent7d = db
    .prepare(
      "SELECT COUNT(*) as cnt FROM relay_treasury_reconciliations WHERE consistent = 0 AND run_at >= ?",
    )
    .get(oneWeekAgo) as { cnt: number };

  // SQLite TEXT comparison would order lexicographically; pull all 7d-window
  // negative-drift rows and compute the min in JS to avoid the surprise.
  const driftRows = db
    .prepare(
      "SELECT drift_micro FROM relay_treasury_reconciliations WHERE consistent = 0 AND run_at >= ?",
    )
    .all(oneWeekAgo) as Array<{ drift_micro: string }>;
  let maxNegativeDrift = 0n;
  for (const r of driftRows) {
    const d = BigInt(r.drift_micro);
    if (d < maxNegativeDrift) maxNegativeDrift = d;
  }

  const latest = db
    .prepare(
      "SELECT run_at, drift_micro, consistent FROM relay_treasury_reconciliations ORDER BY run_at DESC LIMIT 1",
    )
    .get() as { run_at: number; drift_micro: string; consistent: number } | undefined;

  return {
    total_runs: total.cnt,
    inconsistent_runs_24h: inconsistent24h.cnt,
    inconsistent_runs_7d: inconsistent7d.cnt,
    max_negative_drift_micro_7d: maxNegativeDrift.toString(),
    last_run_at: latest?.run_at ?? null,
    current_drift_micro: latest?.drift_micro ?? null,
    current_consistent: latest === undefined ? null : latest.consistent === 1,
  };
}

/** Recent reconciliation records for the admin endpoint. */
export function listTreasuryReconciliations(
  db: DatabaseDriver,
  limit: number,
): StoredReconciliationRecord[] {
  return db
    .prepare(
      `SELECT reconciliation_id, run_at, chain, treasury_address,
              usdc_contract_address, recorded_fee_sum_micro,
              observed_onchain_balance_micro, drift_micro, consistent,
              confirmation_lag_buffer_ms, notes
         FROM relay_treasury_reconciliations
         ORDER BY run_at DESC
         LIMIT ?`,
    )
    .all(limit) as StoredReconciliationRecord[];
}

export interface TreasuryReconciliationLoopConfig {
  db: DatabaseDriver;
  rpc: EvmRpcAdapter;
  /** CAIP-2 chain id to reconcile (matches `relay_settlements.x402_network`). */
  chain: string;
  /** Operator's x402 fee-collection address. */
  treasuryAddress: string;
  /** ERC-20 USDC contract on the chain. */
  usdcContractAddress: string;
  /** Cadence between reconciliation cycles. Default 15 min. */
  intervalMs?: number;
  /** Confirmation-lag buffer. Default 5 min. */
  confirmationLagBufferMs?: number;
  /** Optional emergency-freeze callback. When true, cycle is skipped. */
  isFrozen?: () => boolean;
  /** Override `Date.now` for tests. */
  now?: () => number;
  /** Override the reconciliation_id generator for tests. */
  generateReconciliationId?: () => string;
}

/**
 * Start the background reconciliation loop. Returns the setInterval handle so
 * callers can `clearInterval(handle)` on shutdown. Mirrors the
 * `startCredentialAnchorLoop` shape: async-fire, structured error logging,
 * respects `isFrozen()` callback.
 *
 * The first tick fires after `intervalMs` ms — not immediately — to avoid
 * boot-time RPC pressure when many services restart together.
 */
export function startTreasuryReconciliationLoop(
  config: TreasuryReconciliationLoopConfig,
): ReturnType<typeof setInterval> {
  const intervalMs = config.intervalMs ?? DEFAULT_INTERVAL_MS;
  const confirmationLagBufferMs =
    config.confirmationLagBufferMs ?? DEFAULT_CONFIRMATION_LAG_BUFFER_MS;
  const generateReconciliationId = config.generateReconciliationId ?? randomUUID;

  const store = new SqliteTreasuryReconciliationStore(config.db);
  const loopLogger: TreasuryReconciliationLogger = {
    info: (event, data) => logger.info(event, data),
    warn: (event, data) => logger.warn(event, data),
    error: (event, data) => logger.error(event, data),
  };

  logger.info("treasury-reconciliation.started", {
    chain: config.chain,
    treasuryAddress: config.treasuryAddress,
    usdcContractAddress: config.usdcContractAddress,
    intervalMs,
    confirmationLagBufferMs,
  });

  const tick = async () => {
    if (config.isFrozen?.()) return;
    try {
      await reconcileTreasury({
        rpc: config.rpc,
        store,
        chain: config.chain,
        treasuryAddress: config.treasuryAddress,
        usdcContractAddress: config.usdcContractAddress,
        confirmationLagBufferMs,
        generateReconciliationId,
        ...(config.now ? { now: config.now } : {}),
        logger: loopLogger,
      });
    } catch (err) {
      // reconcileTreasury already collapses internal errors into the result
      // object and logs them via loopLogger. This catch is the belt-and-
      // suspenders boundary against any throw the package didn't catch.
      logger.error("treasury-reconciliation.cycle_uncaught", {
        chain: config.chain,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return setInterval(() => {
    void tick();
  }, intervalMs);
}
