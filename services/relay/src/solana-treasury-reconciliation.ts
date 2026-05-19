/**
 * Solana treasury reconciliation — services/relay side. The algebra
 * lives in `@motebit/wallet-solana` (`OperatorSolanaTreasuryReconciler`,
 * sibling to `OperatorSolanaTransfer`); this file is the relay-specific
 * wiring:
 *
 *  - `SqliteSolanaTreasuryReconciliationStore` — DB-backed store
 *    implementing `getRecordedFeeSumMicro` (over verified p2p
 *    `relay_settlements`) and `persistReconciliation` (into the same
 *    `relay_treasury_reconciliations` table the EVM reconciler uses,
 *    discriminated by the `chain` column).
 *  - `startSolanaTreasuryReconciliationLoop` — setInterval loop
 *    mirroring `startTreasuryReconciliationLoop`. Single-tick async-fire,
 *    structured error logging, respects `isFrozen()` callback.
 *
 * The Solana treasury is the relay's IDENTITY-DERIVED Solana wallet
 * (`deriveSolanaAddress(relayIdentity.publicKey)`) — the same wallet
 * that funds `SolanaMemoSubmitter` anchoring, `OperatorSolanaTransfer`
 * Path-0 withdrawals, and that receives Arc 2 P2P fee legs from
 * delegators. The reconciler's job is to compare the relay's recorded
 * `platform_fee` accumulation against the wallet's onchain USDC
 * balance.
 *
 * The verified-only filter on the fee-sum query is load-bearing:
 * P2P settlements record `platform_fee` at submission, but the funds
 * only reach the treasury after `p2p-verifier.ts` confirms both legs
 * landed onchain (Arc 2 atomic multi-output tx). Counting pending or
 * failed rows would produce false-positive negative drift.
 *
 * Doctrine: `docs/doctrine/treasury-custody.md` § "Solana p2p-fee
 * reconciliation" + `services/relay/CLAUDE.md` rule 16.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseDriver } from "@motebit/persistence";
import {
  OperatorSolanaTreasuryReconciler,
  SOLANA_DEFAULT_CONFIRMATION_LAG_BUFFER_MS,
  SOLANA_TREASURY_DEFAULT_CHAIN,
  USDC_MINT_MAINNET,
  Web3JsRpcAdapter,
  type SolanaReconciliationResult,
  type SolanaTreasuryReconciliationLogger,
  type SolanaTreasuryReconciliationStore,
} from "@motebit/wallet-solana";
import { createLogger } from "./logger.js";

export type { SolanaReconciliationResult };

const logger = createLogger({ service: "solana-treasury-reconciliation" });

/** Default cadence for the reconciliation loop: 15 minutes. Matches the
 *  EVM reconciler. */
const DEFAULT_INTERVAL_MS = 15 * 60_000;

/**
 * DB-backed implementation of the package's
 * `SolanaTreasuryReconciliationStore`.
 *
 * Writes to the SAME `relay_treasury_reconciliations` table the EVM
 * reconciler uses — the table's `chain` column carries CAIP-2 strings
 * and discriminates rows across reconcilers (`eip155:8453` vs
 * `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` per CAIP-30). One table,
 * two writers, one admin endpoint.
 */
export class SqliteSolanaTreasuryReconciliationStore implements SolanaTreasuryReconciliationStore {
  constructor(private readonly db: DatabaseDriver) {}

  /**
   * Sum `platform_fee` over VERIFIED p2p settlements whose
   * `settled_at < asOfMs`. Pending/failed rows are excluded because the
   * funds have not actually reached the treasury until the verifier
   * confirms both legs landed onchain (Arc 2 atomic multi-output tx).
   * Settlements newer than the safe horizon are excluded to bound
   * false-positive negative drift while verification is still in flight.
   */
  getRecordedFeeSumMicro(asOfMs: number): bigint {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(platform_fee), 0) AS total
           FROM relay_settlements
          WHERE settlement_mode = 'p2p'
            AND payment_verification_status = 'verified'
            AND settled_at < ?`,
      )
      .get(asOfMs) as { total: number };
    return BigInt(row.total);
  }

  persistReconciliation(result: SolanaReconciliationResult): void {
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

export interface SolanaTreasuryReconciliationLoopConfig {
  db: DatabaseDriver;
  /** Solana RPC endpoint URL. */
  rpcUrl: string;
  /** 32-byte Ed25519 seed — the relay's identity private key. The
   *  treasury address derives directly via `Keypair.fromSeed`. */
  identitySeed: Uint8Array;
  /** USDC SPL mint. Defaults to mainnet USDC. */
  usdcMint?: string;
  /** CAIP-2 chain identifier persisted on each reconciliation row.
   *  Defaults to `SOLANA_MAINNET_CAIP2` per CAIP-30. */
  chain?: string;
  /** Cadence between cycles. Default 15 min. */
  intervalMs?: number;
  /** Confirmation-lag buffer. Default 5 min. */
  confirmationLagBufferMs?: number;
  /** Optional emergency-freeze callback. When true, cycle is skipped. */
  isFrozen?: () => boolean;
  /** Override `Date.now` for tests. */
  now?: () => number;
  /** Override the reconciliation_id generator for tests. */
  generateReconciliationId?: () => string;
  /** RPC commitment level. Defaults to "confirmed". */
  commitment?: "processed" | "confirmed" | "finalized";
  /** Inject a prebuilt reconciler (tests). When set, `rpcUrl`,
   *  `identitySeed`, `usdcMint`, `commitment`, and `chain` are
   *  ignored — the reconciler carries all of those internally. */
  reconciler?: OperatorSolanaTreasuryReconciler;
}

/**
 * Start the background Solana reconciliation loop. Returns the
 * setInterval handle so callers can `clearInterval(handle)` on
 * shutdown. Mirrors the EVM `startTreasuryReconciliationLoop` shape:
 * async-fire, structured error logging, respects `isFrozen()`.
 *
 * The first tick fires after `intervalMs` ms — not immediately — to
 * avoid boot-time RPC pressure when many services restart together.
 */
export function startSolanaTreasuryReconciliationLoop(
  config: SolanaTreasuryReconciliationLoopConfig,
): ReturnType<typeof setInterval> {
  const intervalMs = config.intervalMs ?? DEFAULT_INTERVAL_MS;
  const confirmationLagBufferMs =
    config.confirmationLagBufferMs ?? SOLANA_DEFAULT_CONFIRMATION_LAG_BUFFER_MS;
  const generateReconciliationId = config.generateReconciliationId ?? randomUUID;
  const chain = config.chain ?? SOLANA_TREASURY_DEFAULT_CHAIN;
  const usdcMint = config.usdcMint ?? USDC_MINT_MAINNET;

  const reconciler =
    config.reconciler ??
    new OperatorSolanaTreasuryReconciler(
      new Web3JsRpcAdapter({
        rpcUrl: config.rpcUrl,
        identitySeed: config.identitySeed,
        usdcMint: config.usdcMint,
        ...(config.commitment !== undefined ? { commitment: config.commitment } : {}),
      }),
      chain,
      usdcMint,
    );

  const store = new SqliteSolanaTreasuryReconciliationStore(config.db);
  const loopLogger: SolanaTreasuryReconciliationLogger = {
    info: (event, data) => logger.info(event, data),
    warn: (event, data) => logger.warn(event, data),
    error: (event, data) => logger.error(event, data),
  };

  logger.info("solana-treasury-reconciliation.started", {
    chain,
    treasuryAddress: reconciler.treasuryAddress,
    usdcMint,
    intervalMs,
    confirmationLagBufferMs,
  });

  const tick = async (): Promise<void> => {
    if (config.isFrozen?.()) return;
    try {
      await reconciler.reconcile({
        store,
        generateReconciliationId,
        confirmationLagBufferMs,
        ...(config.now ? { now: config.now } : {}),
        logger: loopLogger,
      });
    } catch (err) {
      logger.error("solana-treasury-reconciliation.cycle_uncaught", {
        chain,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return setInterval(() => {
    void tick();
  }, intervalMs);
}
