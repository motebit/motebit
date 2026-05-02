/**
 * Treasury reconciliation service-side tests. Exercises the SqliteStore +
 * loop wiring. The pure algebra is tested in
 * `packages/treasury-reconciliation/src/__tests__/reconciler.test.ts` —
 * here we verify the service-side adapter (DB persistence + SQL
 * aggregation + loop scheduling).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSyncRelay } from "../index.js";
import type { SyncRelay } from "../index.js";
import {
  createTreasuryReconciliationTable,
  SqliteTreasuryReconciliationStore,
  getTreasuryReconciliationStats,
  listTreasuryReconciliations,
  startTreasuryReconciliationLoop,
  type EvmRpcAdapter,
} from "../treasury-reconciliation.js";

const TREASURY = "0xee51c5a65c6Fa81c9CC85505884290e90C09D285";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CHAIN = "eip155:8453";

let relay: SyncRelay;

beforeEach(async () => {
  // Note: testnet=true so createSyncRelay doesn't require CDP creds (the
  // X402ConfigError fail-fast in x402-facilitator.ts gates mainnet boot).
  // The treasury-reconciliation helpers under test don't care about
  // testnet vs mainnet — they just need the DB. The relay-boot loop
  // conditional (only-runs-on-mainnet) is tested separately via
  // treasury-reconciliation-e2e.test.ts.
  relay = await createSyncRelay({
    apiToken: "test-token",
    enableDeviceAuth: true,
    x402: {
      payToAddress: TREASURY,
      network: CHAIN,
      testnet: true,
    },
  });
  createTreasuryReconciliationTable(relay.moteDb.db);
});

afterEach(async () => {
  await relay.close();
});

function stubRpc(opts: { balance?: bigint; throws?: Error }): EvmRpcAdapter {
  return {
    getBlockNumber: vi.fn().mockResolvedValue(0n),
    getTransferLogs: vi.fn().mockResolvedValue([]),
    getBalance: opts.throws
      ? vi.fn().mockRejectedValue(opts.throws)
      : vi.fn().mockResolvedValue(opts.balance ?? 0n),
  };
}

function seedSettlement(
  db: SyncRelay["moteDb"]["db"],
  args: { settlementId: string; feeMicro: number; settledAtMs: number; chain?: string },
): void {
  db.prepare(
    `INSERT INTO relay_settlements
       (settlement_id, allocation_id, task_id, motebit_id, amount_settled,
        platform_fee, platform_fee_rate, status, settled_at, settlement_mode,
        x402_network)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    args.settlementId,
    `alloc-${args.settlementId}`,
    `task-${args.settlementId}`,
    "motebit_worker",
    args.feeMicro * 20, // gross = 20× fee (5% rate)
    args.feeMicro,
    0.05,
    "settled",
    args.settledAtMs,
    "relay",
    args.chain ?? CHAIN,
  );
}

describe("SqliteTreasuryReconciliationStore — getRecordedFeeSumMicro", () => {
  it("sums platform_fee for relay-mediated settlements on the chain", () => {
    const store = new SqliteTreasuryReconciliationStore(relay.moteDb.db);
    const now = Date.now();
    seedSettlement(relay.moteDb.db, {
      settlementId: "s1",
      feeMicro: 50_000,
      settledAtMs: now - 60_000,
    });
    seedSettlement(relay.moteDb.db, {
      settlementId: "s2",
      feeMicro: 25_000,
      settledAtMs: now - 30_000,
    });

    expect(store.getRecordedFeeSumMicro(CHAIN, now)).toBe(75_000n);
  });

  it("excludes settlements newer than asOfMs (confirmation-lag buffer)", () => {
    const store = new SqliteTreasuryReconciliationStore(relay.moteDb.db);
    const now = Date.now();
    seedSettlement(relay.moteDb.db, {
      settlementId: "s1",
      feeMicro: 100_000,
      settledAtMs: now - 600_000, // old
    });
    seedSettlement(relay.moteDb.db, {
      settlementId: "s2",
      feeMicro: 999_000,
      settledAtMs: now - 60_000, // within 5min buffer
    });

    // asOfMs = now - 5min — only s1 is older than this
    expect(store.getRecordedFeeSumMicro(CHAIN, now - 5 * 60_000)).toBe(100_000n);
  });

  it("excludes settlements on other chains", () => {
    const store = new SqliteTreasuryReconciliationStore(relay.moteDb.db);
    const now = Date.now();
    seedSettlement(relay.moteDb.db, {
      settlementId: "s1",
      feeMicro: 100_000,
      settledAtMs: now - 60_000,
      chain: CHAIN,
    });
    seedSettlement(relay.moteDb.db, {
      settlementId: "s2",
      feeMicro: 999_000,
      settledAtMs: now - 60_000,
      chain: "eip155:1",
    });

    expect(store.getRecordedFeeSumMicro(CHAIN, now)).toBe(100_000n);
  });

  it("returns 0n when no settlements exist", () => {
    const store = new SqliteTreasuryReconciliationStore(relay.moteDb.db);
    expect(store.getRecordedFeeSumMicro(CHAIN, Date.now())).toBe(0n);
  });
});

describe("SqliteTreasuryReconciliationStore — persistReconciliation", () => {
  it("inserts a reconciliation record byte-faithful for round-trip via listTreasuryReconciliations", () => {
    const store = new SqliteTreasuryReconciliationStore(relay.moteDb.db);
    store.persistReconciliation({
      reconciliationId: "rec-1",
      runAtMs: 1000,
      chain: CHAIN,
      treasuryAddress: TREASURY,
      usdcContractAddress: USDC,
      recordedFeeSumMicro: 100_000n,
      observedOnchainBalanceMicro: 200_000n,
      driftMicro: 100_000n,
      consistent: true,
      confirmationLagBufferMs: 300_000,
    });

    const records = listTreasuryReconciliations(relay.moteDb.db, 10);
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.reconciliation_id).toBe("rec-1");
    expect(r.run_at).toBe(1000);
    expect(BigInt(r.recorded_fee_sum_micro)).toBe(100_000n);
    expect(BigInt(r.drift_micro)).toBe(100_000n);
    expect(r.consistent).toBe(1);
  });
});

describe("getTreasuryReconciliationStats", () => {
  it("aggregates counts + max negative drift over rolling windows", () => {
    const store = new SqliteTreasuryReconciliationStore(relay.moteDb.db);
    const now = Date.now();
    // Two consistent runs in the last 24h
    store.persistReconciliation({
      reconciliationId: "ok-1",
      runAtMs: now - 60_000,
      chain: CHAIN,
      treasuryAddress: TREASURY,
      usdcContractAddress: USDC,
      recordedFeeSumMicro: 0n,
      observedOnchainBalanceMicro: 100_000n,
      driftMicro: 100_000n,
      consistent: true,
      confirmationLagBufferMs: 300_000,
    });
    // One inconsistent run with -2_000 drift
    store.persistReconciliation({
      reconciliationId: "drift-1",
      runAtMs: now - 30_000,
      chain: CHAIN,
      treasuryAddress: TREASURY,
      usdcContractAddress: USDC,
      recordedFeeSumMicro: 5_000n,
      observedOnchainBalanceMicro: 3_000n,
      driftMicro: -2_000n,
      consistent: false,
      confirmationLagBufferMs: 300_000,
    });
    // One inconsistent run further back with worse drift (-5_000)
    store.persistReconciliation({
      reconciliationId: "drift-2",
      runAtMs: now - 45 * 60_000, // 45 min ago, still in 24h window
      chain: CHAIN,
      treasuryAddress: TREASURY,
      usdcContractAddress: USDC,
      recordedFeeSumMicro: 10_000n,
      observedOnchainBalanceMicro: 5_000n,
      driftMicro: -5_000n,
      consistent: false,
      confirmationLagBufferMs: 300_000,
    });

    const stats = getTreasuryReconciliationStats(relay.moteDb.db);
    expect(stats.total_runs).toBe(3);
    expect(stats.inconsistent_runs_24h).toBe(2);
    expect(stats.inconsistent_runs_7d).toBe(2);
    expect(BigInt(stats.max_negative_drift_micro_7d)).toBe(-5_000n);
    // Latest run (drift-1, now - 30_000) is the inconsistent one
    expect(stats.last_run_at).toBe(now - 30_000);
    expect(BigInt(stats.current_drift_micro!)).toBe(-2_000n);
    expect(stats.current_consistent).toBe(false);
  });

  it("returns null fields when no records exist", () => {
    const stats = getTreasuryReconciliationStats(relay.moteDb.db);
    expect(stats.total_runs).toBe(0);
    expect(stats.last_run_at).toBeNull();
    expect(stats.current_drift_micro).toBeNull();
    expect(stats.current_consistent).toBeNull();
  });
});

describe("startTreasuryReconciliationLoop", () => {
  it("respects isFrozen() — skips cycle when frozen", async () => {
    const rpc = stubRpc({ balance: 0n });
    const isFrozen = vi.fn().mockReturnValue(true);
    const interval = startTreasuryReconciliationLoop({
      db: relay.moteDb.db,
      rpc,
      chain: CHAIN,
      treasuryAddress: TREASURY,
      usdcContractAddress: USDC,
      intervalMs: 10, // fast for test
      isFrozen,
    });

    // Wait two cycles
    await new Promise((r) => setTimeout(r, 30));
    clearInterval(interval);

    expect(isFrozen).toHaveBeenCalled();
    // Frozen → no RPC call (cycle skipped before reconcileTreasury runs)
    expect(rpc.getBalance).not.toHaveBeenCalled();
    // Frozen → no records persisted
    expect(listTreasuryReconciliations(relay.moteDb.db, 10)).toHaveLength(0);
  });

  it("runs a cycle when not frozen and persists the result", async () => {
    const rpc = stubRpc({ balance: 4_026_726n });
    const interval = startTreasuryReconciliationLoop({
      db: relay.moteDb.db,
      rpc,
      chain: CHAIN,
      treasuryAddress: TREASURY,
      usdcContractAddress: USDC,
      intervalMs: 10,
    });

    // Wait for first tick + a small grace period
    await new Promise((r) => setTimeout(r, 50));
    clearInterval(interval);

    expect(rpc.getBalance).toHaveBeenCalled();
    const records = listTreasuryReconciliations(relay.moteDb.db, 10);
    expect(records.length).toBeGreaterThanOrEqual(1);
    const r = records[0]!;
    expect(r.chain).toBe(CHAIN);
    expect(BigInt(r.observed_onchain_balance_micro)).toBe(4_026_726n);
    expect(r.consistent).toBe(1);
  });
});
