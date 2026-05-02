/**
 * @motebit/treasury-reconciliation — operator-treasury observability for
 * relay-mediated x402 settlement fees. The package owns the reconciliation
 * algebra (recorded-fee-sum vs onchain balance comparison); persistence
 * + the SQL queries are consumer-supplied via the injected store.
 *
 * Layer 1. See CLAUDE.md for the doctrinal rules.
 */

export type {
  ReconcileTreasuryConfig,
  ReconciliationResult,
  TreasuryReconciliationLogger,
  TreasuryReconciliationStore,
  EvmRpcAdapter,
} from "./types.js";

export {
  InMemoryTreasuryReconciliationStore,
  type InMemoryTreasuryReconciliationStoreOptions,
} from "./store.js";

export { reconcileTreasury } from "./reconciler.js";
