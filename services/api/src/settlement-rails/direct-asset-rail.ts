/**
 * DirectAssetRail — direct onchain stablecoin transfer as a SettlementRail adapter.
 *
 * Fourth and final rail type. The agent moves value itself — no intermediary.
 * The relay's virtual account ledger captures the 5% fee at settlement time.
 * The rail is the exit ramp: it signs a transaction and broadcasts it.
 *
 * WalletProvider is the glucose boundary. Privy, Turnkey, CDP, or a local
 * keypair implement it. The rail calls signAndBroadcast, nothing more.
 * PolicyGate decides whether to sign. The wallet does what it's told.
 *
 * Implements DepositableSettlementRail: agents can receive onchain deposits
 * directly to their wallet address, and withdraw by signing outbound transfers.
 */

import type {
  DepositableSettlementRail,
  PaymentProof,
  DepositResult,
  WithdrawalResult,
} from "@motebit/sdk";
import { createLogger } from "../logger.js";

const logger = createLogger({ service: "direct-asset-rail" });

/**
 * Wallet provider interface — the dumb signer boundary.
 *
 * The wallet signs what PolicyGate approves. It does not make spending
 * decisions. Governance lives in Motebit's policy layer, not here.
 *
 * Privy, Turnkey, CDP, or local keypair implement this.
 * The rail doesn't know or care which one.
 */
export interface WalletProvider {
  /** Get the wallet address for a given agent on a given chain. */
  getAddress(agentId: string, chain: string): Promise<string>;

  /** Get the token balance for an agent's wallet. Returns amount in token decimals (e.g., USDC 6 decimals). */
  getBalance(agentId: string, chain: string, asset: string): Promise<bigint>;

  /**
   * Sign and broadcast a token transfer. Returns the transaction hash.
   * The provider handles gas, nonce, and chain-specific serialization.
   */
  sendTransfer(params: {
    agentId: string;
    chain: string;
    to: string;
    asset: string;
    /** Amount in token-native units (e.g., USDC uses 6 decimals: 1 USDC = 1000000). */
    amount: bigint;
    idempotencyKey: string;
  }): Promise<{ txHash: string }>;
}

export interface DirectAssetRailConfig {
  /** Wallet provider instance. */
  walletProvider: WalletProvider;
  /** CAIP-2 chain identifier (e.g., "eip155:8453" for Base). */
  chain: string;
  /** Asset identifier (e.g., "USDC"). */
  asset: string;
  /** Token decimals for amount conversion. Default: 6 (USDC). */
  decimals?: number;
  /** Callback to persist proof. Injected by relay — the rail does not own storage. */
  onProofAttached?: (settlementId: string, proof: PaymentProof) => void;
}

export class DirectAssetRail implements DepositableSettlementRail {
  readonly railType = "direct_asset" as const;
  readonly name = "direct-asset";
  readonly supportsDeposit = true as const;

  private readonly wallet: WalletProvider;
  private readonly chain: string;
  private readonly asset: string;
  private readonly decimals: number;
  private readonly onProofAttached?: (settlementId: string, proof: PaymentProof) => void;

  constructor(config: DirectAssetRailConfig) {
    this.wallet = config.walletProvider;
    this.chain = config.chain;
    this.asset = config.asset;
    this.decimals = config.decimals ?? 6;
    this.onProofAttached = config.onProofAttached;
  }

  async isAvailable(): Promise<boolean> {
    try {
      // Verify the wallet provider is functional by requesting a known address
      await this.wallet.getAddress("__health_check__", this.chain);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Deposit: return the agent's onchain wallet address as deposit instructions.
   * The agent's counterparty sends tokens directly to this address.
   * Credit happens when the relay detects the inbound transfer (webhook or polling).
   */
  async deposit(
    motebitId: string,
    amount: number,
    currency: string,
    _idempotencyKey: string,
  ): Promise<DepositResult | { redirectUrl: string }> {
    const address = await this.wallet.getAddress(motebitId, this.chain);

    // Return deposit instructions — the address to send tokens to.
    // No redirect needed. The caller shows the address to the depositor.
    return {
      amount,
      currency,
      proof: {
        reference: `deposit-address:${address}`,
        railType: "direct_asset",
        network: this.chain,
        confirmedAt: 0, // Not confirmed until tokens arrive
      },
    };
  }

  /**
   * Withdraw: sign and broadcast a stablecoin transfer to the destination.
   * The wallet provider handles gas, nonce, and chain serialization.
   * Fail-closed: any error throws.
   */
  async withdraw(
    motebitId: string,
    amount: number,
    currency: string,
    destination: string,
    idempotencyKey: string,
  ): Promise<WithdrawalResult> {
    if (amount <= 0) {
      throw new Error("Withdrawal amount must be positive");
    }
    if (!destination) {
      throw new Error("Destination address is required for direct asset withdrawal");
    }

    // Convert dollar amount to token-native units
    const tokenAmount = BigInt(Math.round(amount * 10 ** this.decimals));

    // Check balance before signing
    const balance = await this.wallet.getBalance(motebitId, this.chain, this.asset);
    if (balance < tokenAmount) {
      throw new Error(
        `Insufficient onchain balance: have ${balance.toString()}, need ${tokenAmount.toString()}`,
      );
    }

    // Sign and broadcast
    const { txHash } = await this.wallet.sendTransfer({
      agentId: motebitId,
      chain: this.chain,
      to: destination,
      asset: this.asset,
      amount: tokenAmount,
      idempotencyKey,
    });

    logger.info("direct-asset.withdrawal.broadcast", {
      motebitId,
      amount,
      destination,
      txHash,
      chain: this.chain,
      asset: this.asset,
    });

    return {
      amount,
      currency,
      proof: {
        reference: txHash,
        railType: "direct_asset",
        network: this.chain,
        confirmedAt: Date.now(),
      },
    };
  }

  attachProof(settlementId: string, proof: PaymentProof): Promise<void> {
    logger.info("direct-asset.proof.attached", {
      settlementId,
      reference: proof.reference,
      network: proof.network,
      railType: proof.railType,
    });
    this.onProofAttached?.(settlementId, proof);
    return Promise.resolve();
  }
}
