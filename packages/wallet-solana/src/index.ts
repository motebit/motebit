/**
 * @motebit/wallet-solana — sovereign onchain settlement using the
 * motebit's own Ed25519 identity key.
 *
 * Solana uses Ed25519. The same private key that signs identity
 * assertions for a motebit is also a valid Solana keypair. No second
 * key, no custodial provider, no vendor: identity IS the wallet, by
 * mathematical accident of curve choice. This is the rail that would
 * have emerged from commit 1 if the curve coincidence had been noticed.
 *
 * The rail is a thin interface (chain, asset, address, getBalance,
 * send, isAvailable). All Solana-specific logic lives behind the
 * SolanaRpcAdapter boundary, which is mockable for tests and swappable
 * for future RPC clients (e.g., a @solana/kit-based adapter).
 *
 * The agent pays its own SOL fees. Sovereign means you also pay your
 * own gas. Future improvements (relay-sponsored fee payer) plug in
 * behind the same adapter interface.
 */

export {
  SolanaWalletRail,
  type SolanaWalletRailConfig,
  type SendResult,
  type ConfirmSendQuery,
  type SendConfirmation,
  type ConfirmP2pPaymentQuery,
  type P2pPaymentConfirmation,
  SOLANA_TX_LANDING_HORIZON_MS,
  createSolanaWalletRail,
} from "./rail.js";

export {
  type SolanaRpcAdapter,
  type SendUsdcArgs,
  type SendUsdcBatchItemResult,
  type TxVerificationResult,
  type ConfirmedTransferLeg,
  type OutgoingTransferQuery,
  type OutgoingTransferLookup,
  type BroadcastHooks,
  type SignedTransactionRef,
  type SignatureOutcome,
  type DurableNonceLane,
  type NonceLaneState,
  type DurableTransactionRef,
  type DurableBroadcastHooks,
  type FinalizedSignatureStatus,
  type DurableSendResult,
  type NonceKillResult,
} from "./adapter.js";

export {
  NONCE_ACCOUNT_SEED,
  nonceSeedFor,
  Web3JsRpcAdapter,
  deriveSolanaAddress,
  isDerivedSettlementBinding,
  createSolanaGenesisHashReader,
} from "./web3js-adapter.js";

export {
  SOLANA_MAINNET_GENESIS_HASH,
  SOLANA_DEVNET_GENESIS_HASH,
  SOLANA_TESTNET_GENESIS_HASH,
  SOLANA_TESTNET_CAIP2,
  solanaCaip2FromGenesisHash,
  isSolanaCaip2,
  resolveSolanaNetwork,
  SolanaNetworkResolver,
  SOLANA_GENESIS_READ_TIMEOUT_MS,
  type SolanaNetworkState,
  type SolanaNetworkResolverOptions,
  type SolanaGenesisHashReader,
  type SolanaNetworkResolution,
  type ResolveSolanaNetworkOptions,
} from "./network.js";

export { buildP2pPaymentProof, type BuildP2pPaymentProofArgs } from "./p2p-payment-proof.js";

export { sweepWalletRail, type SweepableWallet, type SweepResult } from "./sweep.js";

export {
  USDC_MINT_MAINNET,
  USDC_MINT_DEVNET,
  InsufficientUsdcBalanceError,
  InvalidSolanaAddressError,
} from "./constants.js";

export {
  swapUsdcToSol,
  swapSolToUsdc,
  GAS_FLOOR_LAMPORTS,
  type JupiterSwapResult,
} from "./jupiter.js";

export {
  SolanaMemoSubmitter,
  type SolanaMemoSubmitterConfig,
  type MemoSubmitterConnection,
  type AnchorBroadcastRef,
  type AnchorBroadcastHooks,
  AnchorTransactionFailedError,
  AnchorBroadcastExpiredError,
  AnchorConfirmationPendingError,
  createSolanaMemoSubmitter,
  parseMemoAnchor,
  parseRevocationMemo,
  parseTransparencyAnchorMemo,
  SOLANA_MAINNET_CAIP2,
  SOLANA_DEVNET_CAIP2,
} from "./memo-submitter.js";

export {
  OperatorSolanaTransfer,
  type OperatorSolanaTransferConfig,
  createOperatorSolanaTransfer,
} from "./operator-transfer.js";

export {
  OperatorSolanaTreasuryReconciler,
  createOperatorSolanaTreasuryReconciler,
  SOLANA_DEFAULT_CONFIRMATION_LAG_BUFFER_MS,
  SOLANA_TREASURY_DEFAULT_CHAIN,
  type OperatorSolanaTreasuryReconcilerConfig,
  type ReconcileSolanaTreasuryArgs,
  type SolanaReconciliationResult,
  type SolanaTreasuryReconciliationLogger,
  type SolanaTreasuryReconciliationStore,
} from "./operator-treasury-reconciler.js";

export {
  confirmSignatureByPolling,
  checkSignatureOnce,
  type SignatureStatusReader,
  type PolledSignatureRef,
  type PolledSignatureOutcome,
  type ConfirmByPollingOptions,
} from "./confirm-signature.js";
