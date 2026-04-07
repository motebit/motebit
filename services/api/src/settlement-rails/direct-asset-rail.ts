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

/**
 * Thrown by `DirectAssetRail.withdraw` when the agent's onchain wallet does
 * not hold enough of the asset to cover the requested transfer.
 *
 * This is the treasury-gap surface: the relay's *virtual* ledger can show a
 * large balance (earned from settled delegations), while the agent's
 * *onchain* wallet is empty because the relay has not yet funded it from
 * the treasury. The two balances live in different systems — the virtual
 * ledger is the relay's SQLite, the onchain balance is the wallet provider
 * (Privy, Turnkey, CDP, …). Bridging them is the treasury rebalancer's job;
 * until that exists, an agent who tries to withdraw to a wallet address
 * can hit this even though their relay account says they have money.
 *
 * The error carries enough context for the withdrawal endpoint to compose
 * a clear user-facing message (including the virtual balance, which the
 * rail itself doesn't know about) and to fall back to a manual rail.
 *
 * Code: `INSUFFICIENT_ONCHAIN_BALANCE`. Machine-readable so HTTP layers
 * can map it to a specific response shape instead of a 500.
 */
export class InsufficientOnchainBalanceError extends Error {
  readonly code = "INSUFFICIENT_ONCHAIN_BALANCE" as const;
  readonly motebitId: string;
  readonly chain: string;
  readonly asset: string;
  readonly walletAddress: string;
  /** Onchain balance in token-native units (e.g. USDC 6 decimals). */
  readonly onchainBalance: bigint;
  /** Required amount in token-native units. */
  readonly requiredAmount: bigint;
  /** Token decimals used for conversion. */
  readonly decimals: number;
  /** Requested withdrawal amount in human dollars (as received by `withdraw`). */
  readonly amountUsd: number;

  constructor(details: {
    motebitId: string;
    chain: string;
    asset: string;
    walletAddress: string;
    onchainBalance: bigint;
    requiredAmount: bigint;
    decimals: number;
    amountUsd: number;
  }) {
    const shortfallUnits = details.requiredAmount - details.onchainBalance;
    const shortfallUsd = Number(shortfallUnits) / 10 ** details.decimals;
    super(
      `Insufficient onchain balance on ${details.chain}: wallet ${details.walletAddress} ` +
        `holds ${details.onchainBalance.toString()} ${details.asset} ` +
        `(${(Number(details.onchainBalance) / 10 ** details.decimals).toFixed(details.decimals)} ${details.asset}), ` +
        `need ${details.requiredAmount.toString()} ` +
        `(${details.amountUsd.toFixed(2)} USD). ` +
        `Shortfall: ${shortfallUsd.toFixed(2)} ${details.asset}. ` +
        `The relay virtual account ledger may show a larger balance than the wallet — ` +
        `onchain treasury has not been funded for this agent yet. ` +
        `Fall back to the manual Stripe withdrawal rail, or wait for treasury rebalancing.`,
    );
    this.name = "InsufficientOnchainBalanceError";
    this.motebitId = details.motebitId;
    this.chain = details.chain;
    this.asset = details.asset;
    this.walletAddress = details.walletAddress;
    this.onchainBalance = details.onchainBalance;
    this.requiredAmount = details.requiredAmount;
    this.decimals = details.decimals;
    this.amountUsd = details.amountUsd;
  }
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

    // Check balance before signing. If short, throw a structured error that
    // carries enough context for the withdrawal endpoint to surface a clear
    // user-facing message and fall back to a manual rail. The relay's
    // virtual ledger can show a large balance while this onchain wallet is
    // empty — see `InsufficientOnchainBalanceError` for the treasury-gap
    // rationale.
    const balance = await this.wallet.getBalance(motebitId, this.chain, this.asset);
    if (balance < tokenAmount) {
      const walletAddress = await this.wallet.getAddress(motebitId, this.chain);
      const err = new InsufficientOnchainBalanceError({
        motebitId,
        chain: this.chain,
        asset: this.asset,
        walletAddress,
        onchainBalance: balance,
        requiredAmount: tokenAmount,
        decimals: this.decimals,
        amountUsd: amount,
      });
      logger.warn("direct-asset.withdrawal.insufficient_balance", {
        motebitId,
        chain: this.chain,
        asset: this.asset,
        walletAddress,
        onchainBalance: balance.toString(),
        requiredAmount: tokenAmount.toString(),
        amountUsd: amount,
        code: err.code,
      });
      throw err;
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
