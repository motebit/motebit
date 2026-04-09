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

/**
 * Minimum SOL balance in lamports to consider gas sufficient.
 * 5_000_000 lamports = 0.005 SOL ≈ enough for ~1000 transactions.
 */
const GAS_FLOOR_LAMPORTS = 5_000_000n;

/**
 * Amount of USDC micro-units to swap for gas when the floor is breached.
 * 2_000_000 micro = $2.00 → buys ~0.01+ SOL at current prices → thousands of txns.
 */
const GAS_SWAP_USDC_MICRO = 2_000_000n;

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
  /**
   * Disable automatic gas management. When false (default), the rail
   * auto-swaps USDC → SOL via Jupiter when the SOL balance drops below
   * the gas floor before sending USDC. Set to true in tests or when
   * gas is managed externally.
   */
  disableAutoGas?: boolean;
}

export class SolanaWalletRail {
  /** Stable rail vocabulary — independent of which chain library is used. */
  readonly chain = "solana" as const;
  readonly asset = "USDC" as const;

  private readonly autoGas: boolean;
  private readonly web3Adapter: Web3JsRpcAdapter | null;

  constructor(
    private readonly adapter: SolanaRpcAdapter,
    opts?: { autoGas?: boolean },
  ) {
    this.autoGas = opts?.autoGas ?? false;
    this.web3Adapter = adapter instanceof Web3JsRpcAdapter ? adapter : null;
  }

  /** The wallet's own base58 address. Equivalent to the motebit identity public key. */
  get address(): string {
    return this.adapter.ownAddress;
  }

  /** USDC balance in micro-units (6 decimals, same as motebit money). */
  getBalance(): Promise<bigint> {
    return this.adapter.getUsdcBalance();
  }

  /** Native SOL balance in lamports. */
  getSolBalance(): Promise<bigint> {
    return this.adapter.getSolBalance();
  }

  /**
   * Ensure the wallet has enough SOL for gas. If below the floor,
   * auto-swaps a small amount of USDC → SOL via Jupiter.
   *
   * @returns true if gas is sufficient (or was replenished), false if
   *   auto-swap failed or is disabled.
   */
  async ensureGas(): Promise<boolean> {
    const solBalance = await this.adapter.getSolBalance();
    if (solBalance >= GAS_FLOOR_LAMPORTS) return true;
    if (!this.autoGas || !this.web3Adapter) return false;

    try {
      // Lazy-import Jupiter to avoid loading the module when gas is sufficient
      const { swapUsdcToSol } = await import("./jupiter.js");
      await swapUsdcToSol(
        GAS_SWAP_USDC_MICRO,
        this.web3Adapter.getKeypair(),
        this.web3Adapter.getConnection(),
        this.web3Adapter.getCommitment(),
        this.web3Adapter.getUsdcMint(),
      );
      return true;
    } catch {
      // Auto-swap failed — caller can still attempt the transaction
      // (it will fail with insufficient gas, but that's the honest state)
      return false;
    }
  }

  /**
   * Send USDC to a counterparty Solana address. Amount in micro-units.
   * Auto-swaps USDC → SOL for gas if needed (when autoGas is enabled).
   * Returns the transaction signature once the network confirms it.
   */
  async send(toAddress: string, microAmount: bigint): Promise<SendResult> {
    if (this.autoGas) {
      await this.ensureGas();
    }
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
  return new SolanaWalletRail(adapter, { autoGas: !config.disableAutoGas });
}
