/**
 * Treasury reconciliation unit tests. Pure-algebra verification — the
 * reconciler is exercised against an in-memory store and a stubbed RPC
 * adapter. No DB, no fetch.
 */

import { describe, it, expect, vi } from "vitest";
import type { EvmRpcAdapter } from "@motebit/evm-rpc";
import { reconcileTreasury } from "../reconciler.js";
import { InMemoryTreasuryReconciliationStore } from "../store.js";

const CHAIN = "eip155:8453";
const TREASURY = "0xee51c5a65c6Fa81c9CC85505884290e90C09D285";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ID = "rec-test-id";
const NOW_MS = 1_714_600_000_000; // 2024-05-01 ish — fixed clock for tests
const BUFFER_MS = 300_000; // 5 minutes

function stubRpc(overrides: { balance?: bigint; throws?: Error }): EvmRpcAdapter {
  return {
    getBlockNumber: vi.fn().mockResolvedValue(BigInt(0)),
    getTransferLogs: vi.fn().mockResolvedValue([]),
    getBalance: overrides.throws
      ? vi.fn().mockRejectedValue(overrides.throws)
      : vi.fn().mockResolvedValue(overrides.balance ?? 0n),
  };
}

describe("reconcileTreasury", () => {
  it("returns consistent result when onchain balance covers recorded fee sum", async () => {
    const store = new InMemoryTreasuryReconciliationStore({
      seededSettlements: [
        { chain: CHAIN, feeMicro: 1_000_000n, settledAtMs: NOW_MS - BUFFER_MS - 1_000 },
        { chain: CHAIN, feeMicro: 500_000n, settledAtMs: NOW_MS - BUFFER_MS - 60_000 },
      ],
    });
    const rpc = stubRpc({ balance: 4_026_726n }); // $4.03 — Daniel's smoke deposit

    const result = await reconcileTreasury({
      rpc,
      store,
      chain: CHAIN,
      treasuryAddress: TREASURY,
      usdcContractAddress: USDC,
      confirmationLagBufferMs: BUFFER_MS,
      generateReconciliationId: () => ID,
      now: () => NOW_MS,
    });

    expect(result.consistent).toBe(true);
    expect(result.recordedFeeSumMicro).toBe(1_500_000n);
    expect(result.observedOnchainBalanceMicro).toBe(4_026_726n);
    expect(result.driftMicro).toBe(2_526_726n);
    expect(result.error).toBeUndefined();
    expect(store.getPersistedRecords()).toHaveLength(1);
    expect(store.getPersistedRecords()[0]!.reconciliationId).toBe(ID);
  });

  it("flags negative drift as inconsistent and persists the record + warn-logs", async () => {
    const store = new InMemoryTreasuryReconciliationStore({
      seededSettlements: [
        { chain: CHAIN, feeMicro: 5_000_000n, settledAtMs: NOW_MS - BUFFER_MS - 1_000 },
      ],
    });
    const rpc = stubRpc({ balance: 1_000_000n }); // less than fee sum
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const result = await reconcileTreasury({
      rpc,
      store,
      chain: CHAIN,
      treasuryAddress: TREASURY,
      usdcContractAddress: USDC,
      confirmationLagBufferMs: BUFFER_MS,
      generateReconciliationId: () => ID,
      now: () => NOW_MS,
      logger,
    });

    expect(result.consistent).toBe(false);
    expect(result.recordedFeeSumMicro).toBe(5_000_000n);
    expect(result.observedOnchainBalanceMicro).toBe(1_000_000n);
    expect(result.driftMicro).toBe(-4_000_000n);
    expect(store.getPersistedRecords()).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "treasury.reconciliation.drift",
      expect.objectContaining({
        chain: CHAIN,
        driftMicro: "-4000000",
      }),
    );
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("excludes settlements newer than the confirmation-lag buffer", async () => {
    const store = new InMemoryTreasuryReconciliationStore({
      seededSettlements: [
        // Old: included (older than safe horizon)
        { chain: CHAIN, feeMicro: 1_000_000n, settledAtMs: NOW_MS - BUFFER_MS - 1_000 },
        // Recent: excluded (newer than safe horizon)
        { chain: CHAIN, feeMicro: 999_999_000n, settledAtMs: NOW_MS - 1_000 },
      ],
    });
    const rpc = stubRpc({ balance: 1_000_000n });

    const result = await reconcileTreasury({
      rpc,
      store,
      chain: CHAIN,
      treasuryAddress: TREASURY,
      usdcContractAddress: USDC,
      confirmationLagBufferMs: BUFFER_MS,
      generateReconciliationId: () => ID,
      now: () => NOW_MS,
    });

    // Only the old settlement contributes; the recent one is excluded
    // even though excluding it would be the difference between consistent
    // and inconsistent.
    expect(result.recordedFeeSumMicro).toBe(1_000_000n);
    expect(result.consistent).toBe(true);
  });

  it("filters by chain — settlements on other chains do not contribute", async () => {
    const store = new InMemoryTreasuryReconciliationStore({
      seededSettlements: [
        { chain: CHAIN, feeMicro: 100n, settledAtMs: NOW_MS - BUFFER_MS - 1_000 },
        { chain: "eip155:1", feeMicro: 999_999n, settledAtMs: NOW_MS - BUFFER_MS - 1_000 },
      ],
    });
    const rpc = stubRpc({ balance: 1_000_000n });

    const result = await reconcileTreasury({
      rpc,
      store,
      chain: CHAIN,
      treasuryAddress: TREASURY,
      usdcContractAddress: USDC,
      confirmationLagBufferMs: BUFFER_MS,
      generateReconciliationId: () => ID,
      now: () => NOW_MS,
    });

    expect(result.recordedFeeSumMicro).toBe(100n);
  });

  it("returns error result and skips persistence when RPC fails", async () => {
    const store = new InMemoryTreasuryReconciliationStore();
    const rpc = stubRpc({ throws: new Error("RPC eth_call returned HTTP 503") });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const result = await reconcileTreasury({
      rpc,
      store,
      chain: CHAIN,
      treasuryAddress: TREASURY,
      usdcContractAddress: USDC,
      confirmationLagBufferMs: BUFFER_MS,
      generateReconciliationId: () => ID,
      now: () => NOW_MS,
      logger,
    });

    expect(result.error).toMatch(/rpc\.getBalance:/);
    expect(result.consistent).toBe(false);
    // Critical: error cycles do NOT persist — audit log is completed-only
    expect(store.getPersistedRecords()).toHaveLength(0);
    expect(logger.error).toHaveBeenCalledWith(
      "treasury.reconciliation.rpc_error",
      expect.objectContaining({ chain: CHAIN, treasuryAddress: TREASURY }),
    );
  });

  it("handles the empty case (zero settlements + zero balance) as consistent", async () => {
    const store = new InMemoryTreasuryReconciliationStore();
    const rpc = stubRpc({ balance: 0n });

    const result = await reconcileTreasury({
      rpc,
      store,
      chain: CHAIN,
      treasuryAddress: TREASURY,
      usdcContractAddress: USDC,
      confirmationLagBufferMs: BUFFER_MS,
      generateReconciliationId: () => ID,
      now: () => NOW_MS,
    });

    expect(result.consistent).toBe(true);
    expect(result.recordedFeeSumMicro).toBe(0n);
    expect(result.observedOnchainBalanceMicro).toBe(0n);
    expect(result.driftMicro).toBe(0n);
    expect(store.getPersistedRecords()).toHaveLength(1);
  });

  it("propagates store errors as error results without persisting", async () => {
    const store: InMemoryTreasuryReconciliationStore = new InMemoryTreasuryReconciliationStore();
    // Replace getRecordedFeeSumMicro with a throwing stub
    store.getRecordedFeeSumMicro = () => {
      throw new Error("DB query failed");
    };
    const rpc = stubRpc({ balance: 0n });

    const result = await reconcileTreasury({
      rpc,
      store,
      chain: CHAIN,
      treasuryAddress: TREASURY,
      usdcContractAddress: USDC,
      confirmationLagBufferMs: BUFFER_MS,
      generateReconciliationId: () => ID,
      now: () => NOW_MS,
    });

    expect(result.error).toMatch(/store\.getRecordedFeeSumMicro:/);
    expect(store.getPersistedRecords()).toHaveLength(0);
  });
});
