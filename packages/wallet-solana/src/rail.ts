/**
 * SolanaWalletRail — the public, motebit-shaped interface to a
 * sovereign Solana USDC wallet.
 *
 * The rail is deliberately tiny: chain, asset, address, plus three
 * methods that delegate to the SolanaRpcAdapter. All Solana-specific
 * code lives in the adapter, never here. This keeps the rail timeless
 * (the same shape will work for Aptos, Sui, or any future Ed25519
 * chain) and the boundary swappable (web3.js today, kit tomorrow).
 *
 * The address is derived from the motebit's identity Ed25519 secret
 * key. There is no second key, no key derivation ceremony, and no
 * vendor: the agent's identity public key IS its Solana address.
 */

import type { SolanaRpcAdapter } from "./adapter.js";
import type { SendUsdcResult } from "./adapter.js";
import { Web3JsRpcAdapter } from "./web3js-adapter.js";

export type SendResult = SendUsdcResult;

export interface SolanaWalletRailConfig {
  /** Solana RPC endpoint URL (mainnet-beta, devnet, or custom). */
  rpcUrl: string;
  /**
   * 32-byte Ed25519 seed — the motebit's identity private key.
   * The Solana keypair (and address) is derived from this seed
   * directly via Keypair.fromSeed.
   */
  identitySeed: Uint8Array;
  /** USDC SPL mint (base58). Defaults to mainnet USDC. */
  usdcMint?: string;
  /** RPC commitment level. Defaults to "confirmed". */
  commitment?: "processed" | "confirmed" | "finalized";
}

export class SolanaWalletRail {
  /** Stable rail vocabulary — independent of which chain library is used. */
  readonly chain = "solana" as const;
  readonly asset = "USDC" as const;

  constructor(private readonly adapter: SolanaRpcAdapter) {}

  /** The wallet's own base58 address. Equivalent to the motebit identity public key. */
  get address(): string {
    return this.adapter.ownAddress;
  }

  /** USDC balance in micro-units (6 decimals, same as motebit money). */
  getBalance(): Promise<bigint> {
    return this.adapter.getUsdcBalance();
  }

  /**
   * Send USDC to a counterparty Solana address. Amount in micro-units.
   * Returns the transaction signature once the network confirms it.
   * Throws InsufficientUsdcBalanceError or InvalidSolanaAddressError
   * for predictable error paths; other RPC errors propagate.
   */
  send(toAddress: string, microAmount: bigint): Promise<SendResult> {
    return this.adapter.sendUsdc({ toAddress, microAmount });
  }

  /** Whether the RPC endpoint is reachable right now. */
  isAvailable(): Promise<boolean> {
    return this.adapter.isReachable();
  }
}

/**
 * Construct a SolanaWalletRail backed by the default @solana/web3.js
 * adapter. Production wiring goes through this factory; tests can
 * construct `new SolanaWalletRail(mockAdapter)` directly.
 */
export function createSolanaWalletRail(config: SolanaWalletRailConfig): SolanaWalletRail {
  const adapter = new Web3JsRpcAdapter({
    rpcUrl: config.rpcUrl,
    identitySeed: config.identitySeed,
    usdcMint: config.usdcMint,
    commitment: config.commitment,
  });
  return new SolanaWalletRail(adapter);
}
