/**
 * @motebit/deposit-detector — EVM `Transfer` event scanner with DB
 * inversion. The package owns scanning, filtering, and cursor logic;
 * persistence + crediting are consumer-supplied callbacks.
 *
 * Layer 1. See CLAUDE.md for doctrinal rules and Rule 2 (dedup
 * atomicity is the consumer's responsibility).
 */

export type {
  DepositDetectorLogger,
  DepositDetectorStore,
  DetectDepositsConfig,
  DetectedDeposit,
  EvmRpcAdapter,
  EvmTransferLog,
  KnownWallet,
  OnDeposit,
} from "./types.js";

export { InMemoryDepositDetectorStore, type InMemoryDepositDetectorStoreOptions } from "./store.js";

export { detectDeposits } from "./detector.js";
