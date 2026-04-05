/**
 * PrivyWalletProvider — Privy as a WalletProvider adapter.
 *
 * Wraps @privy-io/node SDK behind the WalletProvider interface.
 * Each agent gets a Privy-managed embedded wallet, created on first access.
 * The relay controls the wallet via server-side API — no user interaction.
 *
 * Metabolic principle: Privy is the glucose (wallet infrastructure).
 * This adapter is the enzyme boundary. PolicyGate decides whether to sign.
 * The wallet does what it's told.
 */

import { PrivyClient } from "@privy-io/node";
import type { WalletProvider } from "./direct-asset-rail.js";
import { createLogger } from "../logger.js";

const logger = createLogger({ service: "privy-wallet" });

export interface PrivyWalletProviderConfig {
  /** Privy App ID. */
  appId: string;
  /** Privy App Secret. */
  appSecret: string;
}

export class PrivyWalletProvider implements WalletProvider {
  private readonly privy: PrivyClient;
  /** agentId → { walletId, address } */
  private readonly walletCache = new Map<string, { id: string; address: string }>();

  constructor(config: PrivyWalletProviderConfig) {
    this.privy = new PrivyClient({
      appId: config.appId,
      appSecret: config.appSecret,
    });
  }

  async getAddress(agentId: string, _chain: string): Promise<string> {
    const wallet = await this.getOrCreateWallet(agentId);
    return wallet.address;
  }

  /**
   * Get token balance for an agent's wallet.
   *
   * Privy's Node SDK doesn't expose a direct balance query.
   * The relay's virtual account ledger is the authoritative source for
   * whether a withdrawal is permitted — the onchain balance is a
   * secondary safety check. For launch, trust the ledger.
   *
   * TODO: Wire RPC provider (Alchemy/Infura) for onchain balance verification.
   */
  async getBalance(_agentId: string, _chain: string, _asset: string): Promise<bigint> {
    return BigInt(Number.MAX_SAFE_INTEGER);
  }

  async sendTransfer(params: {
    agentId: string;
    chain: string;
    to: string;
    asset: string;
    amount: bigint;
    idempotencyKey: string;
  }): Promise<{ txHash: string }> {
    const wallet = await this.getOrCreateWallet(params.agentId);

    // Parse chain ID from CAIP-2 (e.g., "eip155:8453" → 8453)
    const chainId = parseInt(params.chain.split(":")[1] ?? "8453", 10);

    const response = await this.privy
      .wallets()
      .ethereum()
      .sendTransaction(wallet.id, {
        caip2: params.chain,
        params: {
          transaction: {
            to: params.to,
            value: params.amount.toString(),
            chain_id: chainId,
          },
        },
      });

    logger.info("privy.transfer.sent", {
      agentId: params.agentId,
      walletId: wallet.id,
      to: params.to,
      amount: params.amount.toString(),
      txHash: response.hash,
      chain: params.chain,
    });

    return { txHash: response.hash };
  }

  private async getOrCreateWallet(agentId: string): Promise<{ id: string; address: string }> {
    const cached = this.walletCache.get(agentId);
    if (cached) return cached;

    const wallet = await this.privy.wallets().create({
      chain_type: "ethereum",
    });

    const entry = { id: wallet.id, address: wallet.address };
    this.walletCache.set(agentId, entry);

    logger.info("privy.wallet.created", {
      agentId,
      walletId: wallet.id,
      address: wallet.address,
    });

    return entry;
  }
}
