/**
 * Deposit detector — scans ERC-20 Transfer events to detect inbound
 * deposits to agent wallets and credit virtual accounts.
 *
 * Endgame pattern: ONE eth_getLogs call per cycle fetches ALL USDC
 * Transfer events in the block range. Filter in-memory for known
 * agent wallets. O(1) RPC calls regardless of wallet count.
 * 1 wallet or 1 million wallets — same single call.
 *
 * Transfer(address indexed from, address indexed to, uint256 value)
 * topic0: 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
 */

import type { DatabaseDriver } from "@motebit/persistence";
import { createLogger } from "./logger.js";
import { creditAccount } from "./accounts.js";

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

/** USDC: 6 decimals onchain = 6 decimals in relay micro-units. 1:1 mapping. */
const USDC_ONCHAIN_TO_MICRO = 1;

export interface DepositDetectorConfig {
  db: DatabaseDriver;
  /** CAIP-2 chain to monitor. */
  chain: string;
  /** Poll interval in ms. Default: 15_000 (15 seconds, ~5 Base blocks). */
  intervalMs?: number;
  /** Max blocks to scan per cycle. Default: 1000. Prevents catching up from genesis. */
  maxBlocksPerCycle?: number;
  /** Custom RPC URLs. Merged with defaults. */
  rpcUrls?: Record<string, string>;
  /** Injected fetch for testability. */
  fetch?: typeof globalThis.fetch;
}

/** Create the block cursor table. Idempotent. */
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

/** Parsed Transfer event log. */
interface TransferLog {
  txHash: string;
  logIndex: number;
  from: string;
  to: string;
  value: bigint;
  blockNumber: bigint;
}

/** Parse Transfer event logs from eth_getLogs response. */
function parseTransferLogs(
  logs: Array<{
    transactionHash: string;
    logIndex: string;
    topics: string[];
    data: string;
    blockNumber: string;
  }>,
): TransferLog[] {
  const results: TransferLog[] = [];
  for (const log of logs) {
    if (log.topics.length < 3 || log.topics[0] !== TRANSFER_TOPIC) continue;
    // topics[1] = from (address, 32 bytes, left-padded)
    // topics[2] = to (address, 32 bytes, left-padded)
    // data = value (uint256)
    const from = "0x" + log.topics[1]!.slice(26).toLowerCase();
    const to = "0x" + log.topics[2]!.slice(26).toLowerCase();
    const value = BigInt(log.data);
    results.push({
      txHash: log.transactionHash,
      logIndex: parseInt(log.logIndex, 16),
      from,
      to,
      value,
      blockNumber: BigInt(log.blockNumber),
    });
  }
  return results;
}

/** Get the current block number via eth_blockNumber. */
async function getCurrentBlock(
  rpcUrl: string,
  fetchFn: typeof globalThis.fetch,
): Promise<bigint | null> {
  try {
    const res = await fetchFn(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { result?: string };
    return json.result ? BigInt(json.result) : null;
  } catch {
    return null;
  }
}

/** Fetch Transfer event logs from the USDC contract in a block range. */
async function fetchTransferLogs(
  rpcUrl: string,
  contractAddress: string,
  fromBlock: bigint,
  toBlock: bigint,
  fetchFn: typeof globalThis.fetch,
): Promise<TransferLog[]> {
  const res = await fetchFn(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getLogs",
      params: [
        {
          address: contractAddress,
          topics: [TRANSFER_TOPIC],
          fromBlock: "0x" + fromBlock.toString(16),
          toBlock: "0x" + toBlock.toString(16),
        },
      ],
    }),
  });

  if (!res.ok) return [];
  const json = (await res.json()) as { result?: Array<Record<string, unknown>>; error?: unknown };
  if (json.result == null || json.error != null) return [];

  return parseTransferLogs(
    json.result as Array<{
      transactionHash: string;
      logIndex: string;
      topics: string[];
      data: string;
      blockNumber: string;
    }>,
  );
}

/**
 * Run one detection cycle. Exported for testing.
 *
 * 1. Get current block
 * 2. Fetch Transfer logs from last cursor to current block
 * 3. Filter for transfers TO known agent wallets
 * 4. Credit each new deposit to the virtual account
 * 5. Advance the block cursor
 */
export async function detectDeposits(config: {
  db: DatabaseDriver;
  chain: string;
  rpcUrl: string;
  contractAddress: string;
  maxBlocksPerCycle: number;
  fetchFn: typeof globalThis.fetch;
}): Promise<number> {
  const { db, chain, rpcUrl, contractAddress, maxBlocksPerCycle, fetchFn } = config;

  // Get current block
  const currentBlock = await getCurrentBlock(rpcUrl, fetchFn);
  if (currentBlock === null) return 0;

  // Get last processed block from cursor
  const cursor = db
    .prepare("SELECT last_block FROM relay_deposit_detector WHERE chain = ?")
    .get(chain) as { last_block: string } | undefined;

  // If no cursor, start from current block (don't scan history)
  const lastBlock = cursor ? BigInt(cursor.last_block) : currentBlock;
  if (lastBlock >= currentBlock) return 0; // No new blocks

  // Cap the scan range
  const fromBlock = lastBlock + BigInt(1);
  const toBlock =
    currentBlock - fromBlock > BigInt(maxBlocksPerCycle)
      ? fromBlock + BigInt(maxBlocksPerCycle)
      : currentBlock;

  // Build set of known agent wallet addresses (lowercase for comparison)
  const wallets = db.prepare("SELECT agent_id, address FROM relay_agent_wallets").all() as Array<{
    agent_id: string;
    address: string;
  }>;

  if (wallets.length === 0) {
    // No wallets to monitor — just advance cursor
    db.prepare(
      "INSERT INTO relay_deposit_detector (chain, last_block, updated_at) VALUES (?, ?, ?) ON CONFLICT (chain) DO UPDATE SET last_block = excluded.last_block, updated_at = excluded.updated_at",
    ).run(chain, toBlock.toString(), Date.now());
    return 0;
  }

  const walletMap = new Map<string, string>(); // address → agentId
  for (const w of wallets) {
    walletMap.set(w.address.toLowerCase(), w.agent_id);
  }

  // Fetch ALL Transfer events in the block range — one RPC call
  const logs = await fetchTransferLogs(rpcUrl, contractAddress, fromBlock, toBlock, fetchFn);

  let creditsApplied = 0;
  const now = Date.now();

  for (const log of logs) {
    const agentId = walletMap.get(log.to);
    if (!agentId) continue; // Not an agent wallet

    // Deduplicate: check if this tx+logIndex was already processed
    const existing = db
      .prepare("SELECT 1 FROM relay_deposit_log WHERE tx_hash = ? AND log_index = ?")
      .get(log.txHash, log.logIndex);
    if (existing != null) continue;

    const microAmount = Number(log.value) * USDC_ONCHAIN_TO_MICRO;
    if (microAmount <= 0) continue;

    db.exec("BEGIN");
    try {
      creditAccount(
        db,
        agentId,
        microAmount,
        "deposit",
        `onchain-${log.txHash}-${log.logIndex}`,
        `USDC deposit from ${log.from} on ${chain} (block ${log.blockNumber})`,
      );

      // Record in deposit log for deduplication
      db.prepare(
        "INSERT INTO relay_deposit_log (tx_hash, log_index, agent_id, from_address, amount, chain, block_number, credited_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        log.txHash,
        log.logIndex,
        agentId,
        log.from,
        log.value.toString(),
        chain,
        log.blockNumber.toString(),
        now,
      );

      db.exec("COMMIT");

      logger.info("deposit.detected", {
        agentId,
        chain,
        amount: microAmount,
        from: log.from,
        txHash: log.txHash,
        blockNumber: log.blockNumber.toString(),
      });

      creditsApplied++;
    } catch (err) {
      db.exec("ROLLBACK");
      logger.warn("deposit.credit_failed", {
        agentId,
        txHash: log.txHash,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Advance block cursor
  db.prepare(
    "INSERT INTO relay_deposit_detector (chain, last_block, updated_at) VALUES (?, ?, ?) ON CONFLICT (chain) DO UPDATE SET last_block = excluded.last_block, updated_at = excluded.updated_at",
  ).run(chain, toBlock.toString(), now);

  return creditsApplied;
}

/**
 * Start the deposit detection background loop.
 * Returns an interval handle for cleanup.
 */
export function startDepositDetector(
  config: DepositDetectorConfig,
): ReturnType<typeof setInterval> {
  const rpcUrls = { ...DEFAULT_RPC_URLS, ...config.rpcUrls };
  const rpcUrl = rpcUrls[config.chain];
  const contractAddress = USDC_CONTRACTS[config.chain];
  const intervalMs = config.intervalMs ?? 15_000;
  const maxBlocksPerCycle = config.maxBlocksPerCycle ?? 1000;
  const fetchFn = config.fetch ?? globalThis.fetch;

  if (!rpcUrl || !contractAddress) {
    logger.warn("deposit-detector.disabled", {
      chain: config.chain,
      reason: !rpcUrl ? "no RPC URL" : "no USDC contract",
    });
    return setInterval(() => {}, 2_147_483_647);
  }

  createDepositDetectorTable(config.db);

  logger.info("deposit-detector.started", {
    chain: config.chain,
    intervalMs,
    maxBlocksPerCycle,
  });

  const tick = async () => {
    try {
      const credits = await detectDeposits({
        db: config.db,
        chain: config.chain,
        rpcUrl,
        contractAddress,
        maxBlocksPerCycle,
        fetchFn,
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
