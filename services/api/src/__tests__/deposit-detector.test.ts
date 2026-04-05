/**
 * Deposit detector tests.
 *
 * Tests event-log scanning with mocked RPC — no real chain interaction.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSyncRelay } from "../index.js";
import type { SyncRelay } from "../index.js";
import { detectDeposits, createDepositDetectorTable } from "../deposit-detector.js";
import { getAccountBalance } from "../accounts.js";

const API_TOKEN = "test-token";

// --- Mock RPC responses ---

function blockNumberResponse(blockNum: number) {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: "0x" + blockNum.toString(16),
  };
}

function transferLogsResponse(
  logs: Array<{
    txHash: string;
    logIndex: number;
    from: string;
    to: string;
    value: bigint;
    blockNumber: number;
  }>,
) {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: logs.map((l) => ({
      transactionHash: l.txHash,
      logIndex: "0x" + l.logIndex.toString(16),
      topics: [
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        "0x000000000000000000000000" + l.from.slice(2).toLowerCase(),
        "0x000000000000000000000000" + l.to.slice(2).toLowerCase(),
      ],
      data: "0x" + l.value.toString(16).padStart(64, "0"),
      blockNumber: "0x" + l.blockNumber.toString(16),
    })),
  };
}

let relay: SyncRelay;

beforeEach(async () => {
  relay = await createSyncRelay({
    apiToken: API_TOKEN,
    enableDeviceAuth: true,
    x402: {
      payToAddress: "0x0000000000000000000000000000000000000000",
      network: "eip155:84532",
      testnet: true,
    },
  });
  createDepositDetectorTable(relay.moteDb.db);
  // Create agent wallet table (may already exist from relay init)
  relay.moteDb.db.exec(`
    CREATE TABLE IF NOT EXISTS relay_agent_wallets (
      agent_id TEXT PRIMARY KEY,
      wallet_id TEXT NOT NULL,
      address TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
});

afterEach(async () => {
  await relay.close();
});

describe("detectDeposits", () => {
  it("credits agent account when USDC Transfer detected", async () => {
    const agentId = "agent-deposit-001";
    const walletAddr = "0x1234567890abcdef1234567890abcdef12345678";

    // Register agent wallet
    relay.moteDb.db
      .prepare(
        "INSERT INTO relay_agent_wallets (agent_id, wallet_id, address, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(agentId, "wallet-001", walletAddr, Date.now());

    // Ensure agent has a virtual account
    relay.moteDb.db
      .prepare(
        "INSERT OR IGNORE INTO relay_accounts (motebit_id, balance, currency, created_at, updated_at) VALUES (?, 0, 'USD', ?, ?)",
      )
      .run(agentId, Date.now(), Date.now());

    // Set block cursor so we scan from block 100
    relay.moteDb.db
      .prepare(
        "INSERT INTO relay_deposit_detector (chain, last_block, updated_at) VALUES (?, ?, ?)",
      )
      .run("eip155:84532", "100", Date.now());

    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // eth_blockNumber → block 110
        return { ok: true, json: async () => blockNumberResponse(110) };
      }
      // eth_getLogs → one Transfer to agent wallet (5 USDC = 5_000_000 units)
      return {
        ok: true,
        json: async () =>
          transferLogsResponse([
            {
              txHash: "0xdeposit_tx_001",
              logIndex: 0,
              from: "0xSender0000000000000000000000000000000001",
              to: walletAddr,
              value: BigInt(5_000_000),
              blockNumber: 105,
            },
          ]),
      };
    });

    const credits = await detectDeposits({
      db: relay.moteDb.db,
      chain: "eip155:84532",
      rpcUrl: "https://sepolia.base.org",
      contractAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      maxBlocksPerCycle: 1000,
      fetchFn: mockFetch as unknown as typeof globalThis.fetch,
    });

    expect(credits).toBe(1);

    // Verify virtual account was credited
    const balance = getAccountBalance(relay.moteDb.db, agentId);
    expect(balance?.balance).toBe(5_000_000);

    // Verify deposit log recorded
    const log = relay.moteDb.db
      .prepare("SELECT * FROM relay_deposit_log WHERE tx_hash = ?")
      .get("0xdeposit_tx_001") as { agent_id: string; amount: string } | undefined;
    expect(log).toBeDefined();
    expect(log!.agent_id).toBe(agentId);
    expect(log!.amount).toBe("5000000");

    // Verify block cursor advanced
    const cursor = relay.moteDb.db
      .prepare("SELECT last_block FROM relay_deposit_detector WHERE chain = ?")
      .get("eip155:84532") as { last_block: string };
    expect(cursor.last_block).toBe("110");
  });

  it("ignores transfers to non-agent addresses", async () => {
    relay.moteDb.db
      .prepare(
        "INSERT INTO relay_agent_wallets (agent_id, wallet_id, address, created_at) VALUES (?, ?, ?, ?)",
      )
      .run("agent-002", "wallet-002", "0xAgentAddr000000000000000000000000000002", Date.now());

    relay.moteDb.db
      .prepare(
        "INSERT INTO relay_deposit_detector (chain, last_block, updated_at) VALUES (?, ?, ?)",
      )
      .run("eip155:84532", "100", Date.now());

    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { ok: true, json: async () => blockNumberResponse(110) };
      // Transfer to a random address, not an agent
      return {
        ok: true,
        json: async () =>
          transferLogsResponse([
            {
              txHash: "0xrandom_tx",
              logIndex: 0,
              from: "0xSender0000000000000000000000000000000001",
              to: "0xNotAnAgent000000000000000000000000000099",
              value: BigInt(1_000_000),
              blockNumber: 105,
            },
          ]),
      };
    });

    const credits = await detectDeposits({
      db: relay.moteDb.db,
      chain: "eip155:84532",
      rpcUrl: "https://rpc",
      contractAddress: "0xUSDC",
      maxBlocksPerCycle: 1000,
      fetchFn: mockFetch as unknown as typeof globalThis.fetch,
    });

    expect(credits).toBe(0);
  });

  it("deduplicates — same tx+logIndex not credited twice", async () => {
    const agentId = "agent-dedup";
    const walletAddr = "0xDedup00000000000000000000000000000000aa";

    relay.moteDb.db
      .prepare(
        "INSERT INTO relay_agent_wallets (agent_id, wallet_id, address, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(agentId, "wallet-dd", walletAddr, Date.now());
    relay.moteDb.db
      .prepare(
        "INSERT OR IGNORE INTO relay_accounts (motebit_id, balance, currency, created_at, updated_at) VALUES (?, 0, 'USD', ?, ?)",
      )
      .run(agentId, Date.now(), Date.now());
    relay.moteDb.db
      .prepare(
        "INSERT INTO relay_deposit_detector (chain, last_block, updated_at) VALUES (?, ?, ?)",
      )
      .run("eip155:84532", "100", Date.now());

    const transferLog = transferLogsResponse([
      {
        txHash: "0xsame_tx",
        logIndex: 0,
        from: "0xSender0000000000000000000000000000000001",
        to: walletAddr,
        value: BigInt(2_000_000),
        blockNumber: 105,
      },
    ]);

    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      // Alternate: blockNumber, then logs
      if (callCount % 2 === 1) return { ok: true, json: async () => blockNumberResponse(110) };
      return { ok: true, json: async () => transferLog };
    });

    const fetchFn = mockFetch as unknown as typeof globalThis.fetch;

    // First scan
    const credits1 = await detectDeposits({
      db: relay.moteDb.db,
      chain: "eip155:84532",
      rpcUrl: "https://rpc",
      contractAddress: "0xUSDC",
      maxBlocksPerCycle: 1000,
      fetchFn,
    });
    expect(credits1).toBe(1);

    // Reset cursor to rescan same blocks
    relay.moteDb.db
      .prepare("UPDATE relay_deposit_detector SET last_block = ? WHERE chain = ?")
      .run("100", "eip155:84532");

    // Second scan — same tx should be deduplicated
    const credits2 = await detectDeposits({
      db: relay.moteDb.db,
      chain: "eip155:84532",
      rpcUrl: "https://rpc",
      contractAddress: "0xUSDC",
      maxBlocksPerCycle: 1000,
      fetchFn,
    });
    expect(credits2).toBe(0);

    // Balance should be 2_000_000, not 4_000_000
    const balance = getAccountBalance(relay.moteDb.db, agentId);
    expect(balance?.balance).toBe(2_000_000);
  });

  it("handles RPC failure gracefully — returns 0 credits", async () => {
    relay.moteDb.db
      .prepare(
        "INSERT INTO relay_deposit_detector (chain, last_block, updated_at) VALUES (?, ?, ?)",
      )
      .run("eip155:84532", "100", Date.now());

    const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const credits = await detectDeposits({
      db: relay.moteDb.db,
      chain: "eip155:84532",
      rpcUrl: "https://rpc",
      contractAddress: "0xUSDC",
      maxBlocksPerCycle: 1000,
      fetchFn: mockFetch as unknown as typeof globalThis.fetch,
    });

    expect(credits).toBe(0);
  });

  it("advances cursor even when no wallets exist", async () => {
    relay.moteDb.db
      .prepare(
        "INSERT INTO relay_deposit_detector (chain, last_block, updated_at) VALUES (?, ?, ?)",
      )
      .run("eip155:84532", "100", Date.now());

    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      return { ok: true, json: async () => blockNumberResponse(200) };
    });

    await detectDeposits({
      db: relay.moteDb.db,
      chain: "eip155:84532",
      rpcUrl: "https://rpc",
      contractAddress: "0xUSDC",
      maxBlocksPerCycle: 1000,
      fetchFn: mockFetch as unknown as typeof globalThis.fetch,
    });

    const cursor = relay.moteDb.db
      .prepare("SELECT last_block FROM relay_deposit_detector WHERE chain = ?")
      .get("eip155:84532") as { last_block: string };
    expect(cursor.last_block).toBe("200");
  });
});
