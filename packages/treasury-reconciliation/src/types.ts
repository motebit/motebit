/**
 * Public types for the treasury reconciliation package.
 */

import type { EvmRpcAdapter } from "@motebit/evm-rpc";

export type { EvmRpcAdapter };

/**
 * Structured logger contract. Dotted event names, structured data.
 * Consumer injects their platform logger.
 */
export interface TreasuryReconciliationLogger {
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, data?: Record<string, unknown>): void;
}

/**
 * One reconciliation outcome. The reconciler computes this; the consumer's
 * store persists it (or not — `error` cases skip persistence, see Rule 3).
 */
export interface ReconciliationResult {
  /** UUID-ish; consumer-generated. */
  reconciliationId: string;
  /** Wall-clock time the reconciliation ran. */
  runAtMs: number;
  /** CAIP-2 chain id. */
  chain: string;
  /** Operator's x402 fee-collection address (0x-prefixed). */
  treasuryAddress: string;
  /** ERC-20 contract whose balanceOf is queried. */
  usdcContractAddress: string;
  /** Sum of `platform_fee` over relay-mediated settlements settled before the
   *  confirmation-lag horizon. Micro-units (1 micro = 1e-6 USDC, the relay's
   *  canonical money unit). */
  recordedFeeSumMicro: bigint;
  /** Result of `rpc.getBalance(treasury, USDC)`. Same micro-unit convention
   *  (USDC has 6 onchain decimals, 1:1 with motebit micro-units). */
  observedOnchainBalanceMicro: bigint;
  /** `observedOnchainBalanceMicro - recordedFeeSumMicro`. Positive = surplus
   *  (direct deposits, unsettled worker payouts). Negative = ALERT. */
  driftMicro: bigint;
  /** True when `driftMicro >= 0n`. */
  consistent: boolean;
  /** Buffer (ms) used to exclude settlements newer than `runAtMs - buffer`
   *  from the recorded-fee-sum query. Recorded for audit reproducibility. */
  confirmationLagBufferMs: number;
  /** When set, the cycle errored before producing onchain or fee-sum data.
   *  The result is informational; consumers should NOT persist error cases. */
  error?: string;
}

/**
 * DB-inverted store. The consumer (services/relay) owns persistence of:
 *  - the recorded-fee-sum query (over `relay_settlements`)
 *  - the reconciliation history (over `relay_treasury_reconciliations`)
 *
 * The package makes no SQL and holds no DB handle.
 */
export interface TreasuryReconciliationStore {
  /**
   * Sum of `platform_fee` (micro-units) over relay-mediated settlements
   * for the given `chain` whose `settled_at < asOfMs`. Settlements newer
   * than `asOfMs` are excluded — that's the confirmation-lag buffer.
   * Returns 0n when there are no qualifying settlements.
   */
  getRecordedFeeSumMicro(chain: string, asOfMs: number): bigint;

  /**
   * Persist a successful reconciliation result. Called only when the
   * reconciliation completed without an error. The consumer's storage
   * layer should treat the table as append-only (audit log).
   */
  persistReconciliation(result: ReconciliationResult): void;
}

/** Config for a single reconciliation cycle. Exported for tests. */
export interface ReconcileTreasuryConfig {
  /** RPC adapter for `getBalance`. */
  rpc: EvmRpcAdapter;
  /** Store providing `getRecordedFeeSumMicro` and `persistReconciliation`. */
  store: TreasuryReconciliationStore;
  /** CAIP-2 chain identifier (e.g. "eip155:8453"). */
  chain: string;
  /** Operator's x402 fee-collection address. */
  treasuryAddress: string;
  /** ERC-20 contract address whose `balanceOf(treasuryAddress)` is queried. */
  usdcContractAddress: string;
  /**
   * Settlements whose `settled_at >= now - confirmationLagBufferMs` are
   * excluded from the recorded-fee-sum query. Bounds false-positive negative
   * drift while the corresponding onchain transfers settle past the safe
   * horizon. Default 5 min is generous for L2s with 12-block confirmation.
   */
  confirmationLagBufferMs: number;
  /** Generates a reconciliation_id (e.g., crypto.randomUUID). */
  generateReconciliationId: () => string;
  /** Wall-clock now-source. Defaults to `Date.now`. Tests inject. */
  now?: () => number;
  /** Optional logger; defaults to silent. */
  logger?: TreasuryReconciliationLogger;
}
