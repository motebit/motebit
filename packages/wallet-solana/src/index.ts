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
  createSolanaWalletRail,
} from "./rail.js";

export { type SolanaRpcAdapter, type SendUsdcArgs } from "./adapter.js";

export { Web3JsRpcAdapter } from "./web3js-adapter.js";

export {
  USDC_MINT_MAINNET,
  USDC_MINT_DEVNET,
  InsufficientUsdcBalanceError,
  InvalidSolanaAddressError,
} from "./constants.js";

export { swapUsdcToSol, type JupiterSwapResult } from "./jupiter.js";

export {
  SolanaMemoSubmitter,
  type SolanaMemoSubmitterConfig,
  createSolanaMemoSubmitter,
  parseMemoAnchor,
  parseRevocationMemo,
  SOLANA_MAINNET_CAIP2,
  SOLANA_DEVNET_CAIP2,
} from "./memo-submitter.js";
