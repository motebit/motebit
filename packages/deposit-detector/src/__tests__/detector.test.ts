import { describe, it, expect, vi } from "vitest";
import type { EvmRpcAdapter, EvmTransferLog } from "../types.js";
import { InMemoryDepositDetectorStore } from "../store.js";
import { detectDeposits } from "../detector.js";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const CHAIN = "eip155:1";

function transferLog(args: {
  txHash: string;
  logIndex: number;
  from: string;
  to: string;
  value: bigint;
  blockNumber: number;
}): EvmTransferLog {
  return {
    blockNumber: BigInt(args.blockNumber),
    txHash: args.txHash,
    logIndex: args.logIndex,
    fromTopic: "0x000000000000000000000000" + args.from.slice(2).toLowerCase(),
    toTopic: "0x000000000000000000000000" + args.to.slice(2).toLowerCase(),
    amountHex: "0x" + args.value.toString(16).padStart(64, "0"),
  };
}

function mockRpc(overrides: {
  blockNumber?: bigint;
  logs?: EvmTransferLog[];
  getBlockNumber?: () => Promise<bigint>;
  getTransferLogs?: () => Promise<EvmTransferLog[]>;
}): EvmRpcAdapter {
  return {
    getBlockNumber:
      overrides.getBlockNumber ?? vi.fn().mockResolvedValue(overrides.blockNumber ?? BigInt(0)),
    getTransferLogs: overrides.getTransferLogs ?? vi.fn().mockResolvedValue(overrides.logs ?? []),
    getBalance: vi.fn().mockResolvedValue(0n),
  };
}

const ALICE_WALLET = "0x1111111111111111111111111111111111111111";
const BOB_WALLET = "0x2222222222222222222222222222222222222222";
const ALICE_ID = "motebit_alice";
const BOB_ID = "motebit_bob";

describe("detectDeposits — cursor behavior", () => {
  it("on first run (cursor null) starts from current block — no history scan", async () => {
    const store = new InMemoryDepositDetectorStore({
      wallets: [{ agentId: ALICE_ID, address: ALICE_WALLET }],
    });
    const rpc = mockRpc({ blockNumber: BigInt(1000) });
    const onDeposit = vi.fn();

    const credits = await detectDeposits({
      store,
      rpc,
      chain: CHAIN,
      contractAddress: USDC,
      transferTopic: TRANSFER_TOPIC,
      maxBlocksPerCycle: 100,
      confirmations: 0,
      onDeposit,
    });

    expect(credits).toBe(0);
    expect(onDeposit).not.toHaveBeenCalled();
    // Cursor did NOT advance when lastBlock >= currentBlock (first-run case).
    expect(store.getCursor(CHAIN)).toBeNull();
  });

  it("advances the cursor when the scan range is empty but wallets exist", async () => {
    const store = new InMemoryDepositDetectorStore({
      wallets: [{ agentId: ALICE_ID, address: ALICE_WALLET }],
      cursors: { [CHAIN]: BigInt(500) },
    });
    const rpc = mockRpc({ blockNumber: BigInt(1000), logs: [] });
    const onDeposit = vi.fn();

    await detectDeposits({
      store,
      rpc,
      chain: CHAIN,
      contractAddress: USDC,
      transferTopic: TRANSFER_TOPIC,
      maxBlocksPerCycle: 1000,
      confirmations: 0,
      onDeposit,
    });

    expect(store.getCursor(CHAIN)).toBe(BigInt(1000));
  });

  it("caps the scan at maxBlocksPerCycle", async () => {
    const store = new InMemoryDepositDetectorStore({
      wallets: [{ agentId: ALICE_ID, address: ALICE_WALLET }],
      cursors: { [CHAIN]: BigInt(0) },
    });
    const getTransferLogs = vi.fn().mockResolvedValue([]);
    const rpc = mockRpc({ blockNumber: BigInt(10_000), getTransferLogs });

    await detectDeposits({
      store,
      rpc,
      chain: CHAIN,
      contractAddress: USDC,
      transferTopic: TRANSFER_TOPIC,
      maxBlocksPerCycle: 1000,
      confirmations: 0,
      onDeposit: vi.fn(),
    });

    // fromBlock = 1, toBlock = 1 + 1000 = 1001 (cap applied).
    expect(getTransferLogs).toHaveBeenCalledWith(
      expect.objectContaining({ fromBlock: BigInt(1), toBlock: BigInt(1001) }),
    );
    expect(store.getCursor(CHAIN)).toBe(BigInt(1001));
  });

  it("with zero wallets, advances cursor but does not fetch logs", async () => {
    const store = new InMemoryDepositDetectorStore({ cursors: { [CHAIN]: BigInt(500) } });
    const getTransferLogs = vi.fn();
    const rpc = mockRpc({ blockNumber: BigInt(600), getTransferLogs });

    await detectDeposits({
      store,
      rpc,
      chain: CHAIN,
      contractAddress: USDC,
      transferTopic: TRANSFER_TOPIC,
      maxBlocksPerCycle: 100,
      confirmations: 0,
      onDeposit: vi.fn(),
    });

    expect(getTransferLogs).not.toHaveBeenCalled();
    expect(store.getCursor(CHAIN)).toBe(BigInt(600));
  });
});

describe("detectDeposits — confirmation horizon (reorg safety)", () => {
  it("never scans past currentBlock - confirmations", async () => {
    const store = new InMemoryDepositDetectorStore({
      wallets: [{ agentId: ALICE_ID, address: ALICE_WALLET }],
      cursors: { [CHAIN]: BigInt(900) },
    });
    const getTransferLogs = vi.fn().mockResolvedValue([]);
    // Head is at 1000; with 12 confirmations, the safe horizon is 988.
    // The cursor at 900 means the scan range is 901 → 988, NOT 901 → 1000.
    const rpc = mockRpc({ blockNumber: BigInt(1000), getTransferLogs });

    await detectDeposits({
      store,
      rpc,
      chain: CHAIN,
      contractAddress: USDC,
      transferTopic: TRANSFER_TOPIC,
      maxBlocksPerCycle: 1000,
      confirmations: 12,
      onDeposit: vi.fn(),
    });

    expect(getTransferLogs).toHaveBeenCalledWith(
      expect.objectContaining({ fromBlock: BigInt(901), toBlock: BigInt(988) }),
    );
    // Cursor advances only over confirmed blocks — never past the safe horizon.
    expect(store.getCursor(CHAIN)).toBe(BigInt(988));
  });

  it("returns 0 credits when the cursor has already reached the safe horizon", async () => {
    const store = new InMemoryDepositDetectorStore({
      wallets: [{ agentId: ALICE_ID, address: ALICE_WALLET }],
      cursors: { [CHAIN]: BigInt(988) },
    });
    const getTransferLogs = vi.fn();
    const rpc = mockRpc({ blockNumber: BigInt(1000), getTransferLogs });

    const credits = await detectDeposits({
      store,
      rpc,
      chain: CHAIN,
      contractAddress: USDC,
      transferTopic: TRANSFER_TOPIC,
      maxBlocksPerCycle: 1000,
      confirmations: 12,
      onDeposit: vi.fn(),
    });

    expect(credits).toBe(0);
    expect(getTransferLogs).not.toHaveBeenCalled();
    // Cursor unchanged — no new confirmed blocks since last scan.
    expect(store.getCursor(CHAIN)).toBe(BigInt(988));
  });

  it("on first run starts from the safe horizon, not the chain head", async () => {
    const store = new InMemoryDepositDetectorStore({
      wallets: [{ agentId: ALICE_ID, address: ALICE_WALLET }],
    });
    const rpc = mockRpc({ blockNumber: BigInt(1000) });
    const onDeposit = vi.fn();

    const credits = await detectDeposits({
      store,
      rpc,
      chain: CHAIN,
      contractAddress: USDC,
      transferTopic: TRANSFER_TOPIC,
      maxBlocksPerCycle: 100,
      confirmations: 12,
      onDeposit,
    });

    // First-run + null cursor + non-zero confirmations: the cursor SHOULD
    // be set to the safe horizon (988), not the head (1000) — otherwise
    // the next cycle would scan blocks 989..(headThen-12) including
    // blocks already at the head when this cycle ran (zero-confirmation
    // window the gate exists to avoid).
    expect(credits).toBe(0);
    expect(onDeposit).not.toHaveBeenCalled();
    // Cursor stays null — first-run + caught-up-to-horizon = no work.
    expect(store.getCursor(CHAIN)).toBeNull();
  });

  it("returns 0 when the chain head is shallower than the confirmation depth", async () => {
    // Brand-new chain where head < confirmations. Edge case for a fresh
    // testnet or a forked chain in early life.
    const store = new InMemoryDepositDetectorStore({
      wallets: [{ agentId: ALICE_ID, address: ALICE_WALLET }],
    });
    const getTransferLogs = vi.fn();
    const rpc = mockRpc({ blockNumber: BigInt(5), getTransferLogs });

    const credits = await detectDeposits({
      store,
      rpc,
      chain: CHAIN,
      contractAddress: USDC,
      transferTopic: TRANSFER_TOPIC,
      maxBlocksPerCycle: 100,
      confirmations: 12,
      onDeposit: vi.fn(),
    });

    expect(credits).toBe(0);
    expect(getTransferLogs).not.toHaveBeenCalled();
  });
});

describe("detectDeposits — filtering and dedup", () => {
  it("invokes onDeposit for transfers to known wallets only", async () => {
    const store = new InMemoryDepositDetectorStore({
      wallets: [{ agentId: ALICE_ID, address: ALICE_WALLET }],
      cursors: { [CHAIN]: BigInt(0) },
    });
    const logs = [
      transferLog({
        txHash: "0xa1",
        logIndex: 0,
        from: "0xaaaa000000000000000000000000000000000000",
        to: ALICE_WALLET,
        value: 1_000_000n,
        blockNumber: 1,
      }),
      // Transfer to an unknown wallet — should be ignored.
      transferLog({
        txHash: "0xa2",
        logIndex: 0,
        from: "0xaaaa000000000000000000000000000000000000",
        to: "0x9999999999999999999999999999999999999999",
        value: 1_000_000n,
        blockNumber: 1,
      }),
    ];
    const rpc = mockRpc({ blockNumber: BigInt(10), logs });
    const onDeposit = vi.fn();

    const credits = await detectDeposits({
      store,
      rpc,
      chain: CHAIN,
      contractAddress: USDC,
      transferTopic: TRANSFER_TOPIC,
      maxBlocksPerCycle: 100,
      confirmations: 0,
      onDeposit,
    });

    expect(credits).toBe(1);
    expect(onDeposit).toHaveBeenCalledTimes(1);
    expect(onDeposit).toHaveBeenCalledWith(
      expect.objectContaining({
        motebitId: ALICE_ID,
        amountOnchain: 1_000_000n,
        txHash: "0xa1",
        logIndex: 0,
        chain: CHAIN,
      }),
    );
  });

  it("skips logs already recorded in the dedup table", async () => {
    const store = new InMemoryDepositDetectorStore({
      wallets: [{ agentId: ALICE_ID, address: ALICE_WALLET }],
      cursors: { [CHAIN]: BigInt(0) },
    });
    store.markProcessed("0xa1", 0);
    const rpc = mockRpc({
      blockNumber: BigInt(10),
      logs: [
        transferLog({
          txHash: "0xa1",
          logIndex: 0,
          from: "0xaa",
          to: ALICE_WALLET,
          value: 1_000_000n,
          blockNumber: 1,
        }),
      ],
    });
    const onDeposit = vi.fn();

    await detectDeposits({
      store,
      rpc,
      chain: CHAIN,
      contractAddress: USDC,
      transferTopic: TRANSFER_TOPIC,
      maxBlocksPerCycle: 100,
      confirmations: 0,
      onDeposit,
    });

    expect(onDeposit).not.toHaveBeenCalled();
  });

  it("skips zero-value logs", async () => {
    const store = new InMemoryDepositDetectorStore({
      wallets: [{ agentId: ALICE_ID, address: ALICE_WALLET }],
      cursors: { [CHAIN]: BigInt(0) },
    });
    const rpc = mockRpc({
      blockNumber: BigInt(10),
      logs: [
        transferLog({
          txHash: "0xz",
          logIndex: 0,
          from: "0xaa",
          to: ALICE_WALLET,
          value: 0n,
          blockNumber: 1,
        }),
      ],
    });
    const onDeposit = vi.fn();

    const credits = await detectDeposits({
      store,
      rpc,
      chain: CHAIN,
      contractAddress: USDC,
      transferTopic: TRANSFER_TOPIC,
      maxBlocksPerCycle: 100,
      confirmations: 0,
      onDeposit,
    });

    expect(credits).toBe(0);
    expect(onDeposit).not.toHaveBeenCalled();
  });

  it("handles multiple agents in the same scan cycle", async () => {
    const store = new InMemoryDepositDetectorStore({
      wallets: [
        { agentId: ALICE_ID, address: ALICE_WALLET },
        { agentId: BOB_ID, address: BOB_WALLET },
      ],
      cursors: { [CHAIN]: BigInt(0) },
    });
    const rpc = mockRpc({
      blockNumber: BigInt(10),
      logs: [
        transferLog({
          txHash: "0xa",
          logIndex: 0,
          from: "0xaa",
          to: ALICE_WALLET,
          value: 1n,
          blockNumber: 1,
        }),
        transferLog({
          txHash: "0xb",
          logIndex: 0,
          from: "0xaa",
          to: BOB_WALLET,
          value: 2n,
          blockNumber: 1,
        }),
      ],
    });
    const onDeposit = vi.fn();

    const credits = await detectDeposits({
      store,
      rpc,
      chain: CHAIN,
      contractAddress: USDC,
      transferTopic: TRANSFER_TOPIC,
      maxBlocksPerCycle: 100,
      confirmations: 0,
      onDeposit,
    });

    expect(credits).toBe(2);
    expect(onDeposit).toHaveBeenCalledTimes(2);
    const ids = onDeposit.mock.calls.map((c) => (c[0] as { motebitId: string }).motebitId);
    expect(ids.sort()).toEqual([ALICE_ID, BOB_ID]);
  });
});

describe("detectDeposits — RPC failure handling", () => {
  it("getBlockNumber failure collapses to 0 credits with no cursor change", async () => {
    const store = new InMemoryDepositDetectorStore({
      wallets: [{ agentId: ALICE_ID, address: ALICE_WALLET }],
      cursors: { [CHAIN]: BigInt(500) },
    });
    const rpc = mockRpc({
      getBlockNumber: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    });

    const credits = await detectDeposits({
      store,
      rpc,
      chain: CHAIN,
      contractAddress: USDC,
      transferTopic: TRANSFER_TOPIC,
      maxBlocksPerCycle: 100,
      confirmations: 0,
      onDeposit: vi.fn(),
    });

    expect(credits).toBe(0);
    expect(store.getCursor(CHAIN)).toBe(BigInt(500)); // unchanged
  });

  it("getTransferLogs failure collapses to 0 credits with no cursor change", async () => {
    const store = new InMemoryDepositDetectorStore({
      wallets: [{ agentId: ALICE_ID, address: ALICE_WALLET }],
      cursors: { [CHAIN]: BigInt(500) },
    });
    const rpc = mockRpc({
      blockNumber: BigInt(600),
      getTransferLogs: vi.fn().mockRejectedValue(new Error("-32005: too many results")),
    });

    const credits = await detectDeposits({
      store,
      rpc,
      chain: CHAIN,
      contractAddress: USDC,
      transferTopic: TRANSFER_TOPIC,
      maxBlocksPerCycle: 100,
      confirmations: 0,
      onDeposit: vi.fn(),
    });

    expect(credits).toBe(0);
    expect(store.getCursor(CHAIN)).toBe(BigInt(500));
  });
});

describe("detectDeposits — onDeposit failure", () => {
  it("individual onDeposit failure logs but does not halt the cycle", async () => {
    const store = new InMemoryDepositDetectorStore({
      wallets: [
        { agentId: ALICE_ID, address: ALICE_WALLET },
        { agentId: BOB_ID, address: BOB_WALLET },
      ],
      cursors: { [CHAIN]: BigInt(0) },
    });
    const rpc = mockRpc({
      blockNumber: BigInt(10),
      logs: [
        transferLog({
          txHash: "0xa",
          logIndex: 0,
          from: "0xaa",
          to: ALICE_WALLET,
          value: 1n,
          blockNumber: 1,
        }),
        transferLog({
          txHash: "0xb",
          logIndex: 0,
          from: "0xaa",
          to: BOB_WALLET,
          value: 2n,
          blockNumber: 1,
        }),
      ],
    });

    const logs: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const logger = {
      info: () => {},
      warn: (event: string, data?: Record<string, unknown>) => logs.push({ event, data }),
      error: () => {},
    };

    // Fail on Alice; succeed on Bob.
    const onDeposit = vi.fn().mockImplementation((args: { motebitId: string }) => {
      if (args.motebitId === ALICE_ID) throw new Error("credit failed");
    });

    const credits = await detectDeposits({
      store,
      rpc,
      chain: CHAIN,
      contractAddress: USDC,
      transferTopic: TRANSFER_TOPIC,
      maxBlocksPerCycle: 100,
      confirmations: 0,
      onDeposit,
      logger,
    });

    expect(credits).toBe(1); // only Bob counted
    expect(onDeposit).toHaveBeenCalledTimes(2);
    expect(logs.some((l) => l.event === "deposit.credit_failed")).toBe(true);
    // Cursor advanced — the dedup table is the safety net, not the cursor.
    expect(store.getCursor(CHAIN)).toBe(BigInt(10));
  });
});
