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

/** ERC-20 balanceOf(address) function selector: keccak256("balanceOf(address)").slice(0,4) */
const ERC20_BALANCE_OF_SELECTOR = "0x70a08231";

/** Public RPC endpoints by CAIP-2 chain ID. */
const DEFAULT_RPC_URLS: Record<string, string> = {
  "eip155:1": "https://eth.llamarpc.com",
  "eip155:8453": "https://mainnet.base.org",
  "eip155:84532": "https://sepolia.base.org",
  "eip155:10": "https://mainnet.optimism.io",
  "eip155:137": "https://polygon-rpc.com",
  "eip155:42161": "https://arb1.arbitrum.io/rpc",
};

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

/**
 * Query an ERC-20 balanceOf via JSON-RPC eth_call.
 * Returns the token balance as bigint, or null if the call fails.
 */
async function queryErc20Balance(
  rpcUrl: string,
  contractAddress: string,
  walletAddress: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<bigint | null> {
  const addressHex = walletAddress.slice(2).toLowerCase().padStart(64, "0");
  const calldata = `${ERC20_BALANCE_OF_SELECTOR}${addressHex}`;

  try {
    const res = await fetchFn(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: contractAddress, data: calldata }, "latest"],
      }),
    });

    if (!res.ok) return null;
    const json = (await res.json()) as { result?: string; error?: unknown };
    if (!json.result || json.error) return null;

    // Result is hex-encoded uint256
    return BigInt(json.result);
  } catch {
    return null;
  }
}

export interface PrivyWalletProviderConfig {
  /** Privy App ID. */
  appId: string;
  /** Privy App Secret. */
  appSecret: string;
  /** Persistent wallet store. Default: in-memory (lost on restart). */
  walletStore?: WalletStore;
  /** Custom RPC URLs by CAIP-2 chain ID. Merged with defaults. */
  rpcUrls?: Record<string, string>;
  /** Injected fetch for testability. Default: globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
}

export class PrivyWalletProvider implements WalletProvider {
  private readonly privy: PrivyClient;
  private readonly store: WalletStore;
  private readonly rpcUrls: Record<string, string>;
  private readonly _fetch: typeof globalThis.fetch;
  /** Runtime cache: agentId → { id, address }. Populated from store on first access. */
  private readonly walletCache = new Map<string, { id: string; address: string }>();
  /** In-flight wallet creation promises. Prevents duplicate Privy wallets from concurrent requests. */
  private readonly walletCreationLocks = new Map<
    string,
    Promise<{ id: string; address: string }>
  >();

  constructor(config: PrivyWalletProviderConfig) {
    this.privy = new PrivyClient({
      appId: config.appId,
      appSecret: config.appSecret,
    });
    this.store = config.walletStore ?? new InMemoryWalletStore();
    this.rpcUrls = { ...DEFAULT_RPC_URLS, ...config.rpcUrls };
    this._fetch = config.fetch ?? globalThis.fetch;
  }

  async getAddress(agentId: string, _chain: string): Promise<string> {
    const wallet = await this.getOrCreateWallet(agentId);
    return wallet.address;
  }

  /**
   * Get ERC-20 token balance for an agent's wallet via JSON-RPC eth_call.
   * Falls back to MAX_SAFE_INTEGER if the RPC call fails (fail-open for balance
   * check — the onchain transaction will revert if insufficient, which is safe).
   */
  async getBalance(agentId: string, chain: string, asset: string): Promise<bigint> {
    const wallet = await this.getOrCreateWallet(agentId);
    const contractAddress = asset.toUpperCase() === "USDC" ? USDC_CONTRACTS[chain] : undefined;
    const rpcUrl = this.rpcUrls[chain];

    if (!contractAddress || !rpcUrl) {
      // Unknown asset or chain — trust the ledger
      return BigInt(Number.MAX_SAFE_INTEGER);
    }

    const balance = await queryErc20Balance(rpcUrl, contractAddress, wallet.address, this._fetch);
    if (balance === null) {
      // RPC failed — fail-open, trust the ledger. The onchain tx will revert if short.
      logger.warn("privy.balance.rpc_failed", { agentId, chain, asset });
      return BigInt(Number.MAX_SAFE_INTEGER);
    }

    return balance;
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

    // 3. Create new wallet — deduplicate concurrent requests to prevent duplicate Privy wallets.
    // Without this lock, two concurrent getOrCreateWallet("agent-1") calls could both see
    // no stored wallet and each create a separate Privy wallet, wasting money and splitting funds.
    const inflight = this.walletCreationLocks.get(agentId);
    if (inflight) return inflight;

    const creation = this.createAndPersistWallet(agentId);
    this.walletCreationLocks.set(agentId, creation);
    try {
      return await creation;
    } finally {
      this.walletCreationLocks.delete(agentId);
    }
  }

  private async createAndPersistWallet(agentId: string): Promise<{ id: string; address: string }> {
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
export { encodeErc20Transfer, queryErc20Balance, USDC_CONTRACTS, DEFAULT_RPC_URLS };
