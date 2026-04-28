/**
 * Public types for the deposit detector. Interop with `@motebit/evm-rpc`
 * is type-only — consumers provide an `EvmRpcAdapter` instance.
 */

import type { EvmRpcAdapter, EvmTransferLog } from "@motebit/evm-rpc";

export type { EvmRpcAdapter, EvmTransferLog };

/**
 * Structured logger contract. Dotted event names, structured data.
 * Consumer injects their platform logger.
 */
export interface DepositDetectorLogger {
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, data?: Record<string, unknown>): void;
}

/**
 * Payload the package hands to the `onDeposit` callback. The caller is
 * responsible for (a) the token-specific decimal conversion, and (b)
 * the atomic write that records the dedup entry and credits the account.
 */
export interface DetectedDeposit {
  /** motebit_id of the receiving wallet (resolved via the store's wallet map). */
  motebitId: string;
  /** The `value` field of the ERC-20 `Transfer` event. Caller applies decimals. */
  amountOnchain: bigint;
  /** 0x-prefixed hex. */
  txHash: string;
  /** Log index within the transaction. */
  logIndex: number;
  /** Sender address (0x-prefixed lowercase). */
  fromAddress: string;
  /** Block the log was emitted in. */
  blockNumber: bigint;
  /** CAIP-2 chain id for caller context (e.g., "eip155:8453"). */
  chain: string;
}

/**
 * Callback invoked for each newly-detected deposit (not a dedup hit).
 * Must be idempotent: if the callback throws and the cycle is retried,
 * the `store.hasProcessedLog` check ahead of this call still fires.
 */
export type OnDeposit = (deposit: DetectedDeposit) => void | Promise<void>;

/** Config for a single detection cycle. Exported for tests. */
export interface DetectDepositsConfig {
  store: DepositDetectorStore;
  rpc: EvmRpcAdapter;
  /** CAIP-2 chain identifier, opaque to the package. */
  chain: string;
  /** The ERC-20 contract to scan — USDC at whatever chain you care about. */
  contractAddress: string;
  /** `keccak256("Transfer(address,address,uint256)")` by default. */
  transferTopic: string;
  /** Cap scan range per cycle — prevents catch-up-from-genesis on first run. */
  maxBlocksPerCycle: number;
  /** Fired for each newly-detected deposit. */
  onDeposit: OnDeposit;
  /** Optional logger; defaults to silent. */
  logger?: DepositDetectorLogger;
}

/** Wallet record returned by `DepositDetectorStore.getWallets()`. */
export interface KnownWallet {
  /** motebit_id (the owner). */
  agentId: string;
  /** EVM address, 0x-prefixed. Case does not matter; the detector lowercases. */
  address: string;
}

/**
 * DB-inverted store. The consumer (services/relay) owns persistence of:
 *  - the per-chain block cursor
 *  - the known-wallets lookup table
 *  - the per-log dedup record
 *
 * The package makes no SQL and holds no DB handle.
 */
export interface DepositDetectorStore {
  /** Last scanned block for this chain. `null` on first run. */
  getCursor(chain: string): bigint | null;
  /** Advance the cursor. Called after each successful scan cycle. */
  setCursor(chain: string, block: bigint, updatedAt: number): void;
  /** Snapshot of motebit wallets the relay is monitoring. */
  getWallets(): KnownWallet[];
  /** Dedup check: has this log already been credited? */
  hasProcessedLog(txHash: string, logIndex: number): boolean;
}
