/**
 * OperatorSolanaTreasuryReconciler — operator-treasury observability
 * for the relay's identity-derived Solana treasury wallet.
 *
 * Sibling of `@motebit/treasury-reconciliation` (EVM x402 fee-collection
 * observability). The two are structurally the same primitive — both
 * compare an internal recorded-fee sum against an onchain treasury
 * balance and alert on negative drift — but their wire-level
 * dependencies differ enough that each lives next to its chain-specific
 * adapter:
 *
 *   - EVM treasury reconciler depends on `@motebit/evm-rpc`'s
 *     `EvmRpcAdapter.getBalance({contractAddress, accountAddress})`.
 *   - Solana treasury reconciler depends on
 *     `SolanaRpcAdapter.getUsdcBalance()` (USDC SPL mint is the
 *     adapter's construction-site convention, not a per-call argument).
 *
 * The package boundary mirrors deposit detection: EVM in
 * `@motebit/deposit-detector`, Solana inside `@motebit/wallet-solana`.
 *
 * Doctrine: see `docs/doctrine/treasury-custody.md` § "Solana p2p-fee
 * reconciliation" for why the verified-only filter on
 * `relay_settlements` is load-bearing — the Arc 2 atomic multi-output
 * P2P tx records `platform_fee` at submission time, but the funds only
 * reach the treasury after the verifier confirms both legs landed
 * onchain. Counting unverified rows would produce false-positive
 * negative drift while Solana is still settling.
 *
 * Conservative phase-1 invariant: `consistent = onchain >= recordedFeeSum`.
 * Positive drift is ALWAYS fine — covers direct deposits, anchor-fee
 * SOL→USDC swap residue, manual operator funding. Negative drift is
 * the alert: more fees were recorded as verified than arrived onchain.
 */

import type { SolanaRpcAdapter } from "./adapter.js";
import { USDC_MINT_MAINNET } from "./constants.js";
import { SOLANA_MAINNET_CAIP2 } from "./memo-submitter.js";
import { Web3JsRpcAdapter } from "./web3js-adapter.js";

/** Default confirmation-lag buffer: 5 minutes. Settlements whose
 *  `settled_at >= now - buffer` are excluded from the recorded-fee-sum
 *  query because the P2P verifier may not have completed its onchain
 *  walk yet. Generous default; tune if cycles miss freshly-verified
 *  rows. */
export const SOLANA_DEFAULT_CONFIRMATION_LAG_BUFFER_MS = 5 * 60_000;

/**
 * Structured logger contract. Dotted event names, structured data.
 * Consumer injects their platform logger; matches the EVM reconciler's
 * `TreasuryReconciliationLogger` shape by intent so a single relay-side
 * logger adapter can serve both.
 */
export interface SolanaTreasuryReconciliationLogger {
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, data?: Record<string, unknown>): void;
}

/**
 * One reconciliation outcome. Field names match the EVM
 * `ReconciliationResult` so the relay's `relay_treasury_reconciliations`
 * table accepts rows from both chains via the `chain` column (CAIP-2:
 * `eip155:8453`, `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`, …).
 */
export interface SolanaReconciliationResult {
  /** UUID-ish; consumer-generated. */
  reconciliationId: string;
  /** Wall-clock time the reconciliation ran. */
  runAtMs: number;
  /** CAIP-2 chain id per CAIP-30 (e.g. `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`,
   *  `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`). The exported
   *  `SOLANA_MAINNET_CAIP2` / `SOLANA_DEVNET_CAIP2` constants are the
   *  canonical source — consume those rather than re-declaring. */
  chain: string;
  /** Operator's identity-derived Solana treasury address (base58). */
  treasuryAddress: string;
  /** USDC SPL mint address (base58). Recorded for audit symmetry with
   *  the EVM reconciler's `usdcContractAddress`. */
  usdcContractAddress: string;
  /** Sum of `platform_fee` over verified p2p settlements settled
   *  before the confirmation-lag horizon. Micro-units (USDC has 6
   *  decimals on Solana). */
  recordedFeeSumMicro: bigint;
  /** Result of `adapter.getUsdcBalance()` against the treasury wallet's
   *  associated token account. Same micro-unit convention. */
  observedOnchainBalanceMicro: bigint;
  /** `observedOnchainBalanceMicro - recordedFeeSumMicro`. Positive =
   *  surplus (direct deposits, SOL→USDC swap residue). Negative = ALERT. */
  driftMicro: bigint;
  /** True when `driftMicro >= 0n`. */
  consistent: boolean;
  /** Buffer (ms) used to exclude settlements whose `settled_at >=
   *  runAtMs - buffer` from the recorded-fee-sum query. */
  confirmationLagBufferMs: number;
  /** When set, the cycle errored before producing onchain or fee-sum
   *  data. The result is informational; consumers should NOT persist
   *  error cases. */
  error?: string;
}

/**
 * DB-inverted store. The consumer (services/relay) owns persistence of:
 *   - the recorded-fee-sum query (over `relay_settlements` for
 *     `settlement_mode='p2p' AND payment_verification_status='verified'`)
 *   - the reconciliation history (over `relay_treasury_reconciliations`,
 *     the same table the EVM reconciler writes to, discriminated by the
 *     `chain` column)
 *
 * The package makes no SQL and holds no DB handle.
 */
export interface SolanaTreasuryReconciliationStore {
  /**
   * Sum of `platform_fee` (micro-units) over verified p2p settlements
   * whose `settled_at < asOfMs`. Returns 0n when there are no qualifying
   * settlements. The verified-only filter is load-bearing — see the
   * class doc.
   */
  getRecordedFeeSumMicro(asOfMs: number): bigint;

  /**
   * Persist a successful reconciliation result. Called only when the
   * reconciliation completed without an error. The consumer's storage
   * layer should treat the table as append-only (audit log).
   */
  persistReconciliation(result: SolanaReconciliationResult): void;
}

export interface OperatorSolanaTreasuryReconcilerConfig {
  /** Solana RPC endpoint URL. Same value as `SOLANA_RPC_URL`. */
  rpcUrl: string;
  /**
   * 32-byte Ed25519 seed — the relay's identity private key. The
   * treasury address derives directly via `Keypair.fromSeed`; this is
   * the SAME wallet `OperatorSolanaTransfer` and `SolanaMemoSubmitter`
   * use, by Solana's Ed25519 curve coincidence.
   */
  identitySeed: Uint8Array;
  /** USDC SPL mint (base58). Defaults to mainnet USDC. */
  usdcMint?: string;
  /** RPC commitment level. Defaults to "confirmed". */
  commitment?: "processed" | "confirmed" | "finalized";
  /** CAIP-2 chain identifier persisted on each reconciliation row.
   *  Defaults to `SOLANA_MAINNET_CAIP2`; tests / devnet wiring override
   *  by passing `SOLANA_DEVNET_CAIP2` (both exported from this package). */
  chain?: string;
}

export interface ReconcileSolanaTreasuryArgs {
  /** Store providing `getRecordedFeeSumMicro` and `persistReconciliation`. */
  store: SolanaTreasuryReconciliationStore;
  /** Generates a reconciliation_id (e.g., `crypto.randomUUID`). */
  generateReconciliationId: () => string;
  /** Settlements whose `settled_at >= now - confirmationLagBufferMs`
   *  are excluded from the recorded-fee-sum query. Defaults to
   *  `SOLANA_DEFAULT_CONFIRMATION_LAG_BUFFER_MS`. */
  confirmationLagBufferMs?: number;
  /** Wall-clock now-source. Defaults to `Date.now`. Tests inject. */
  now?: () => number;
  /** Optional logger; defaults to silent. */
  logger?: SolanaTreasuryReconciliationLogger;
}

/**
 * Operator-side Solana treasury reconciler. Construct once at relay
 * boot via the factory; call `reconcile(...)` from the loop.
 *
 * The constructor accepts a pre-built `SolanaRpcAdapter` for test
 * injection; production wiring goes through
 * `createOperatorSolanaTreasuryReconciler` which builds the default
 * `Web3JsRpcAdapter` from config. Same shape as `OperatorSolanaTransfer`.
 */
export class OperatorSolanaTreasuryReconciler {
  constructor(
    private readonly adapter: SolanaRpcAdapter,
    private readonly chain: string,
    private readonly usdcMint: string,
  ) {}

  /** The relay treasury's own base58 Solana address. */
  get treasuryAddress(): string {
    return this.adapter.ownAddress;
  }

  /**
   * Run one reconciliation cycle.
   *
   *  1. Compute the safe-horizon timestamp: `now - confirmationLagBufferMs`.
   *  2. Query recorded fee sum from the store, asOfMs = safe-horizon.
   *  3. Query observed onchain USDC balance via `adapter.getUsdcBalance`.
   *  4. Compute drift = onchain - feeSum; consistent = drift >= 0n.
   *  5. Persist successful result via `store.persistReconciliation`.
   *  6. On error, return a result with `error` populated and SKIP
   *     persistence — the audit log is for completed cycles only.
   */
  async reconcile(args: ReconcileSolanaTreasuryArgs): Promise<SolanaReconciliationResult> {
    const {
      store,
      generateReconciliationId,
      confirmationLagBufferMs = SOLANA_DEFAULT_CONFIRMATION_LAG_BUFFER_MS,
      now = Date.now,
      logger,
    } = args;

    const reconciliationId = generateReconciliationId();
    const runAtMs = now();
    const asOfMs = runAtMs - confirmationLagBufferMs;

    let recordedFeeSumMicro: bigint;
    try {
      recordedFeeSumMicro = store.getRecordedFeeSumMicro(asOfMs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger?.error("solana_treasury.reconciliation.store_error", {
        reconciliationId,
        chain: this.chain,
        error: message,
      });
      return {
        reconciliationId,
        runAtMs,
        chain: this.chain,
        treasuryAddress: this.treasuryAddress,
        usdcContractAddress: this.usdcMint,
        recordedFeeSumMicro: 0n,
        observedOnchainBalanceMicro: 0n,
        driftMicro: 0n,
        consistent: false,
        confirmationLagBufferMs,
        error: `store.getRecordedFeeSumMicro: ${message}`,
      };
    }

    let observedOnchainBalanceMicro: bigint;
    try {
      observedOnchainBalanceMicro = await this.adapter.getUsdcBalance();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger?.error("solana_treasury.reconciliation.rpc_error", {
        reconciliationId,
        chain: this.chain,
        treasuryAddress: this.treasuryAddress,
        error: message,
      });
      return {
        reconciliationId,
        runAtMs,
        chain: this.chain,
        treasuryAddress: this.treasuryAddress,
        usdcContractAddress: this.usdcMint,
        recordedFeeSumMicro,
        observedOnchainBalanceMicro: 0n,
        driftMicro: 0n,
        consistent: false,
        confirmationLagBufferMs,
        error: `adapter.getUsdcBalance: ${message}`,
      };
    }

    const driftMicro = observedOnchainBalanceMicro - recordedFeeSumMicro;
    const consistent = driftMicro >= 0n;

    const result: SolanaReconciliationResult = {
      reconciliationId,
      runAtMs,
      chain: this.chain,
      treasuryAddress: this.treasuryAddress,
      usdcContractAddress: this.usdcMint,
      recordedFeeSumMicro,
      observedOnchainBalanceMicro,
      driftMicro,
      consistent,
      confirmationLagBufferMs,
    };

    store.persistReconciliation(result);

    if (!consistent) {
      logger?.warn("solana_treasury.reconciliation.drift", {
        reconciliationId,
        chain: this.chain,
        treasuryAddress: this.treasuryAddress,
        recordedFeeSumMicro: recordedFeeSumMicro.toString(),
        observedOnchainBalanceMicro: observedOnchainBalanceMicro.toString(),
        driftMicro: driftMicro.toString(),
      });
    } else {
      logger?.info("solana_treasury.reconciliation.cycle", {
        reconciliationId,
        chain: this.chain,
        recordedFeeSumMicro: recordedFeeSumMicro.toString(),
        observedOnchainBalanceMicro: observedOnchainBalanceMicro.toString(),
        driftMicro: driftMicro.toString(),
      });
    }

    return result;
  }
}

/** Default CAIP-2 chain when none supplied. Re-exports
 *  `SOLANA_MAINNET_CAIP2` under a name that signals the reconciler's
 *  default-chain semantics; the underlying canonical string is the
 *  same single source of truth in `memo-submitter.ts`. */
export const SOLANA_TREASURY_DEFAULT_CHAIN = SOLANA_MAINNET_CAIP2;

/** Construct an `OperatorSolanaTreasuryReconciler` backed by the default
 *  `Web3JsRpcAdapter`. Production wiring goes through this factory. */
export function createOperatorSolanaTreasuryReconciler(
  config: OperatorSolanaTreasuryReconcilerConfig,
): OperatorSolanaTreasuryReconciler {
  const adapter = new Web3JsRpcAdapter({
    rpcUrl: config.rpcUrl,
    identitySeed: config.identitySeed,
    usdcMint: config.usdcMint,
    commitment: config.commitment,
  });
  const chain = config.chain ?? SOLANA_TREASURY_DEFAULT_CHAIN;
  // Mirror the adapter's mint default for the audit-log field so the
  // recorded `usdcContractAddress` always matches the mint the adapter
  // is actually querying.
  const usdcMint = config.usdcMint ?? USDC_MINT_MAINNET;
  return new OperatorSolanaTreasuryReconciler(adapter, chain, usdcMint);
}
