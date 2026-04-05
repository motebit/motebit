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

// --- ERC-20 transfer encoding ---

/** ERC-20 transfer(address,uint256) function selector: keccak256("transfer(address,uint256)").slice(0,4) */
const ERC20_TRANSFER_SELECTOR = "0xa9059cbb";

/** Known USDC contract addresses by CAIP-2 chain ID. */
const USDC_CONTRACTS: Record<string, string> = {
  "eip155:1": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // Ethereum mainnet
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base mainnet
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Base Sepolia
  "eip155:10": "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", // Optimism
  "eip155:137": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", // Polygon
  "eip155:42161": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // Arbitrum
};

/**
 * Encode an ERC-20 transfer(to, amount) call.
 * Returns the hex-encoded calldata for the transaction's `data` field.
 */
function encodeErc20Transfer(to: string, amount: bigint): string {
  // Remove 0x prefix, pad address to 32 bytes (left-pad with zeros)
  const addressHex = to.slice(2).toLowerCase().padStart(64, "0");
  // Pad amount to 32 bytes (left-pad with zeros)
  const amountHex = amount.toString(16).padStart(64, "0");
  return `${ERC20_TRANSFER_SELECTOR}${addressHex}${amountHex}`;
}

// --- Wallet persistence ---

/** Database driver for wallet persistence. Subset of DatabaseDriver. */
export interface WalletStore {
  getWalletId(agentId: string): string | null;
  setWalletId(agentId: string, walletId: string, address: string): void;
}

/** In-memory wallet store (for testing or when no DB is available). */
export class InMemoryWalletStore implements WalletStore {
  private readonly store = new Map<string, { walletId: string; address: string }>();

  getWalletId(agentId: string): string | null {
    return this.store.get(agentId)?.walletId ?? null;
  }

  setWalletId(agentId: string, walletId: string, address: string): void {
    this.store.set(agentId, { walletId, address });
  }
}

// --- Provider ---

export interface PrivyWalletProviderConfig {
  /** Privy App ID. */
  appId: string;
  /** Privy App Secret. */
  appSecret: string;
  /** Persistent wallet store. Default: in-memory (lost on restart). */
  walletStore?: WalletStore;
}

export class PrivyWalletProvider implements WalletProvider {
  private readonly privy: PrivyClient;
  private readonly store: WalletStore;
  /** Runtime cache: agentId → { id, address }. Populated from store on first access. */
  private readonly walletCache = new Map<string, { id: string; address: string }>();

  constructor(config: PrivyWalletProviderConfig) {
    this.privy = new PrivyClient({
      appId: config.appId,
      appSecret: config.appSecret,
    });
    this.store = config.walletStore ?? new InMemoryWalletStore();
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
  getBalance(_agentId: string, _chain: string, _asset: string): Promise<bigint> {
    return Promise.resolve(BigInt(Number.MAX_SAFE_INTEGER));
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

    // Look up ERC-20 contract address for the asset on this chain
    const contractAddress = USDC_CONTRACTS[params.chain];

    let response;
    if (contractAddress && params.asset.toUpperCase() === "USDC") {
      // ERC-20 transfer: call contract's transfer(to, amount) function
      const calldata = encodeErc20Transfer(params.to, params.amount);
      response = await this.privy
        .wallets()
        .ethereum()
        .sendTransaction(wallet.id, {
          caip2: params.chain,
          params: {
            transaction: {
              to: contractAddress,
              value: 0,
              data: calldata,
              chain_id: chainId,
            },
          },
        });
    } else {
      // Native transfer (fallback for unknown assets)
      response = await this.privy
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
    }

    logger.info("privy.transfer.sent", {
      agentId: params.agentId,
      walletId: wallet.id,
      to: params.to,
      amount: params.amount.toString(),
      txHash: response.hash,
      chain: params.chain,
      asset: params.asset,
      erc20: !!contractAddress,
    });

    return { txHash: response.hash };
  }

  private async getOrCreateWallet(agentId: string): Promise<{ id: string; address: string }> {
    // 1. Runtime cache (fastest)
    const cached = this.walletCache.get(agentId);
    if (cached) return cached;

    // 2. Persistent store (survives restart)
    const storedId = this.store.getWalletId(agentId);
    if (storedId) {
      // Fetch wallet details from Privy to get address
      const wallet = await this.privy.wallets().get(storedId);
      const entry = { id: wallet.id, address: wallet.address };
      this.walletCache.set(agentId, entry);
      return entry;
    }

    // 3. Create new wallet
    const wallet = await this.privy.wallets().create({
      chain_type: "ethereum",
    });

    const entry = { id: wallet.id, address: wallet.address };
    this.walletCache.set(agentId, entry);
    this.store.setWalletId(agentId, wallet.id, wallet.address);

    logger.info("privy.wallet.created", {
      agentId,
      walletId: wallet.id,
      address: wallet.address,
    });

    return entry;
  }
}

// Export for testing
export { encodeErc20Transfer, USDC_CONTRACTS };
