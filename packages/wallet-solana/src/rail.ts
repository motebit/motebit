/**
 * SolanaWalletRail — the public, motebit-shaped interface to a
 * sovereign Solana USDC wallet. Implements `SovereignRail` from
 * `@motebit/protocol` — custody is "agent", the rail is not registered
 * at the relay, and the identity key signs every transaction.
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

import type {
  SovereignWalletRail,
  SovereignP2pPaymentRequest,
  P2pPaymentProof,
} from "@motebit/protocol";
import type { SolanaRpcAdapter } from "./adapter.js";
import type { SendUsdcResult, SendUsdcBatchItemResult } from "./adapter.js";
import { Web3JsRpcAdapter } from "./web3js-adapter.js";
import { buildP2pPaymentProof } from "./p2p-payment-proof.js";

export type SendResult = SendUsdcResult;

/**
 * Minimum SOL balance in lamports to consider gas sufficient.
 * 5_000_000 lamports = 0.005 SOL ≈ enough for ~1000 transactions.
 */
import { GAS_FLOOR_LAMPORTS } from "./jupiter.js";

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

export class SolanaWalletRail implements SovereignWalletRail {
  /** Stable rail vocabulary — independent of which chain library is used. */
  readonly custody = "agent" as const;
  readonly name = "solana-wallet" as const;
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
   * Owner-invoked SOL → USDC swap — the funding-side half of wallet
   * homeostasis (the owner may fund with whatever asset landed; the
   * wallet normalizes toward working capital). Delegates to the Jupiter
   * adapter, which enforces the gas floor fail-closed. Exposed for the
   * `wallet swap` deterministic affordance; NOT called autonomously
   * (autonomous posture normalization is deferred-with-trigger and
   * would ride the standing-grant meter).
   */
  async swapSolToUsdc(solLamports: bigint): Promise<import("./jupiter.js").JupiterSwapResult> {
    if (!this.web3Adapter) {
      throw new Error(
        "swap unavailable: this rail was constructed without a web3 adapter (createSolanaWalletRail provides one).",
      );
    }
    const { swapSolToUsdc } = await import("./jupiter.js");
    return swapSolToUsdc(
      solLamports,
      this.web3Adapter.getKeypair(),
      this.web3Adapter.getConnection(),
      this.web3Adapter.getCommitment(),
      this.web3Adapter.getUsdcMint(),
    );
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

  /**
   * Send USDC to multiple counterparties in as few Solana transactions
   * as possible. One transaction with N transfer instructions pays one
   * base fee instead of N — the endgame shape for multi-hop settlement
   * payout on the sovereign rail.
   *
   * Chunking to fit Solana's 1232-byte tx limit is handled internally
   * by the adapter. Fail-fast: if any chunk fails, remaining items are
   * not submitted. Per-item results indicate what landed.
   */
  async sendBatch(
    items: ReadonlyArray<{ toAddress: string; microAmount: bigint }>,
  ): Promise<SendUsdcBatchItemResult[]> {
    if (this.autoGas) {
      await this.ensureGas();
    }
    return this.adapter.sendUsdcBatch(items);
  }

  /**
   * Build a P2P payment proof: broadcast the worker leg + relay-fee leg(s)
   * in ONE atomic transaction and return the verifiable proof. This is what
   * lets a paid direct delegation satisfy the relay's Arc-3.5 P2P-proof gate.
   *
   * Delegates to `buildP2pPaymentProof` (the canonical multi-leg builder) so
   * the atomicity guarantee + proof assembly live in exactly one place — the
   * rail only layers gas management on top. Two legs for single-operator P2P
   * (worker + relay treasury); three for cross-operator federated P2P when
   * the executor-relay fields are present.
   */
  async buildP2pPayment(request: SovereignP2pPaymentRequest): Promise<P2pPaymentProof> {
    if (this.autoGas) {
      await this.ensureGas();
    }
    return buildP2pPaymentProof(this.adapter, {
      workerAddress: request.workerAddress,
      amountMicro: request.amountMicro,
      treasuryAddress: request.treasuryAddress,
      feeAmountMicro: request.feeAmountMicro,
      ...(request.executorTreasuryAddress != null
        ? { executorTreasuryAddress: request.executorTreasuryAddress }
        : {}),
      ...(request.executorFeeAmountMicro != null
        ? { executorFeeAmountMicro: request.executorFeeAmountMicro }
        : {}),
      ...(request.network != null ? { network: request.network } : {}),
    });
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
