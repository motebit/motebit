/**
 * Deposit detector — services/api side. The state machine lives in
 * `@motebit/deposit-detector`; this file is the relay-specific wiring:
 *
 *  - `SqliteDepositDetectorStore` — DB-backed cursor / wallets / dedup
 *  - `onDeposit` callback — records dedup entry + credits the virtual
 *    account atomically in a SQLite transaction, so a retry never
 *    double-credits the same log
 *  - `createDepositDetectorTable` — the relay's local DDL for
 *    `relay_deposit_detector` + `relay_deposit_log`
 *  - `detectDeposits` + `startDepositDetector` — legacy-API wrappers
 *    that preserve the pre-extraction `(db, chain, rpc, ...)` signature
 *
 * The package side has no DB access and no knowledge of the relay's
 * chain-USDC contract/RPC map — those tables of constants live here.
 */

import type { DatabaseDriver } from "@motebit/persistence";
import {
  detectDeposits as pkgDetectDeposits,
  type DepositDetectorStore,
  type EvmRpcAdapter,
  type EvmTransferLog,
  type OnDeposit,
  type KnownWallet,
} from "@motebit/deposit-detector";
import { HttpJsonRpcEvmAdapter } from "@motebit/evm-rpc";
import { sqliteAccountStoreFor } from "./account-store-sqlite.js";
import { createLogger } from "./logger.js";

export type { EvmRpcAdapter, EvmTransferLog };

const logger = createLogger({ service: "deposit-detector" });

/** ERC-20 Transfer event topic0: keccak256("Transfer(address,address,uint256)") */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Known USDC contract addresses by CAIP-2 chain ID. */
const USDC_CONTRACTS: Record<string, string> = {
  "eip155:1": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  "eip155:10": "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  "eip155:137": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  "eip155:42161": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
};

/** Default public RPC endpoints by CAIP-2 chain ID. */
const DEFAULT_RPC_URLS: Record<string, string> = {
  "eip155:1": "https://eth.llamarpc.com",
  "eip155:8453": "https://mainnet.base.org",
  "eip155:84532": "https://sepolia.base.org",
  "eip155:10": "https://mainnet.optimism.io",
  "eip155:137": "https://polygon-rpc.com",
  "eip155:42161": "https://arb1.arbitrum.io/rpc",
};

/** USDC: 6 decimals onchain === 6 decimals micro-units. 1:1 mapping. */
const USDC_ONCHAIN_TO_MICRO = 1;

/** Create the block cursor + dedup log tables. Idempotent. */
export function createDepositDetectorTable(db: DatabaseDriver): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS relay_deposit_detector (
      chain TEXT PRIMARY KEY,
      last_block TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS relay_deposit_log (
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      agent_id TEXT NOT NULL,
      from_address TEXT NOT NULL,
      amount TEXT NOT NULL,
      chain TEXT NOT NULL,
      block_number TEXT NOT NULL,
      credited_at INTEGER NOT NULL,
      PRIMARY KEY (tx_hash, log_index)
    );
  `);
}

/** DB-backed implementation of the package's `DepositDetectorStore`. */
export class SqliteDepositDetectorStore implements DepositDetectorStore {
  constructor(private readonly db: DatabaseDriver) {}

  getCursor(chain: string): bigint | null {
    const row = this.db
      .prepare("SELECT last_block FROM relay_deposit_detector WHERE chain = ?")
      .get(chain) as { last_block: string } | undefined;
    return row ? BigInt(row.last_block) : null;
  }

  setCursor(chain: string, block: bigint, updatedAt: number): void {
    this.db
      .prepare(
        "INSERT INTO relay_deposit_detector (chain, last_block, updated_at) VALUES (?, ?, ?) ON CONFLICT (chain) DO UPDATE SET last_block = excluded.last_block, updated_at = excluded.updated_at",
      )
      .run(chain, block.toString(), updatedAt);
  }

  getWallets(): KnownWallet[] {
    const rows = this.db
      .prepare("SELECT agent_id, address FROM relay_agent_wallets")
      .all() as Array<{ agent_id: string; address: string }>;
    return rows.map((r) => ({ agentId: r.agent_id, address: r.address }));
  }

  hasProcessedLog(txHash: string, logIndex: number): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM relay_deposit_log WHERE tx_hash = ? AND log_index = ?")
      .get(txHash, logIndex);
    return row != null;
  }
}

/**
 * Build the `onDeposit` callback that atomically records the dedup
 * entry and credits the virtual account. The two writes share a
 * BEGIN/COMMIT so a concurrent cycle can never re-credit the same log.
 */
function buildCreditOnDepositCallback(db: DatabaseDriver): OnDeposit {
  const accountStore = sqliteAccountStoreFor(db);
  return (deposit) => {
    const microAmount = Number(deposit.amountOnchain) * USDC_ONCHAIN_TO_MICRO;
    if (microAmount <= 0) return;

    db.exec("BEGIN");
    try {
      accountStore.credit(
        deposit.motebitId,
        microAmount,
        "deposit",
        `onchain-${deposit.txHash}-${deposit.logIndex}`,
        `USDC deposit from ${deposit.fromAddress} on ${deposit.chain} (block ${deposit.blockNumber})`,
      );
      db.prepare(
        "INSERT INTO relay_deposit_log (tx_hash, log_index, agent_id, from_address, amount, chain, block_number, credited_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        deposit.txHash,
        deposit.logIndex,
        deposit.motebitId,
        deposit.fromAddress,
        deposit.amountOnchain.toString(),
        deposit.chain,
        deposit.blockNumber.toString(),
        Date.now(),
      );
      db.exec("COMMIT");

      logger.info("deposit.detected", {
        agentId: deposit.motebitId,
        chain: deposit.chain,
        amount: microAmount,
        from: deposit.fromAddress,
        txHash: deposit.txHash,
        blockNumber: deposit.blockNumber.toString(),
      });
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  };
}

/**
 * Legacy-signature wrapper for the pre-extraction integration tests.
 * Accepts a DatabaseDriver, wires an SqliteDepositDetectorStore, and
 * calls the package detector with the atomic onDeposit closure.
 */
export async function detectDeposits(config: {
  db: DatabaseDriver;
  chain: string;
  rpc: EvmRpcAdapter;
  contractAddress: string;
  maxBlocksPerCycle: number;
}): Promise<number> {
  return pkgDetectDeposits({
    store: new SqliteDepositDetectorStore(config.db),
    rpc: config.rpc,
    chain: config.chain,
    contractAddress: config.contractAddress,
    transferTopic: TRANSFER_TOPIC,
    maxBlocksPerCycle: config.maxBlocksPerCycle,
    onDeposit: buildCreditOnDepositCallback(config.db),
    logger,
  });
}

export interface DepositDetectorConfig {
  db: DatabaseDriver;
  /** CAIP-2 chain to monitor. */
  chain: string;
  /** Poll interval in ms. Default: 15_000. */
  intervalMs?: number;
  /** Max blocks to scan per cycle. Default: 1000. */
  maxBlocksPerCycle?: number;
  /** Custom RPC URLs. Merged with defaults. Ignored when `rpc` is provided. */
  rpcUrls?: Record<string, string>;
  /** Injected RPC adapter for testability. Default: HttpJsonRpcEvmAdapter from the chain's URL. */
  rpc?: EvmRpcAdapter;
  /** Injected fetch for the default adapter. Ignored when `rpc` is provided. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Start the background detection loop for a single chain. Returns the
 * setInterval handle so callers can `clearInterval(handle)` on shutdown.
 *
 * The loop itself lives here rather than in the package because the
 * services/api-side constants (`USDC_CONTRACTS`, `DEFAULT_RPC_URLS`,
 * `TRANSFER_TOPIC`) plus the no-config-found fallback are relay-specific.
 * Each tick invokes the package's pure `detectDeposits` with the
 * transactional `onDeposit` closure.
 */
export function startDepositDetector(
  config: DepositDetectorConfig,
): ReturnType<typeof setInterval> {
  const rpcUrls = { ...DEFAULT_RPC_URLS, ...config.rpcUrls };
  const rpcUrl = rpcUrls[config.chain];
  const contractAddress = USDC_CONTRACTS[config.chain];
  const intervalMs = config.intervalMs ?? 15_000;
  const maxBlocksPerCycle = config.maxBlocksPerCycle ?? 1000;

  if (!contractAddress || (!config.rpc && !rpcUrl)) {
    logger.warn("deposit-detector.disabled", {
      chain: config.chain,
      reason: !contractAddress ? "no USDC contract" : "no RPC URL",
    });
    // Return a no-op interval so `clearInterval` remains a safe call.
    return setInterval(() => {}, 2_147_483_647);
  }

  createDepositDetectorTable(config.db);

  const rpc: EvmRpcAdapter =
    config.rpc ?? new HttpJsonRpcEvmAdapter({ rpcUrl: rpcUrl!, fetch: config.fetch });
  const store = new SqliteDepositDetectorStore(config.db);
  const onDeposit = buildCreditOnDepositCallback(config.db);

  logger.info("deposit-detector.started", {
    chain: config.chain,
    intervalMs,
    maxBlocksPerCycle,
  });

  const tick = async () => {
    try {
      const credits = await pkgDetectDeposits({
        store,
        rpc,
        chain: config.chain,
        contractAddress,
        transferTopic: TRANSFER_TOPIC,
        maxBlocksPerCycle,
        onDeposit,
        logger,
      });
      if (credits > 0) {
        logger.info("deposit-detector.cycle", {
          chain: config.chain,
          creditsApplied: credits,
        });
      }
    } catch (err) {
      logger.warn("deposit-detector.cycle_failed", {
        chain: config.chain,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  void tick();
  return setInterval(() => void tick(), intervalMs);
}
