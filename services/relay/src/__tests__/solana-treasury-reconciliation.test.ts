/**
 * Solana treasury reconciliation service-side tests. Exercises the
 * SqliteStore + loop wiring. The pure algebra is tested in
 * `packages/wallet-solana/src/__tests__/operator-treasury-reconciler.test.ts` —
 * here we verify the relay-side adapter (DB persistence + SQL
 * aggregation on the verified-only p2p filter + loop scheduling).
 *
 * Sibling of `treasury-reconciliation.test.ts` (EVM side). Both write
 * to the same `relay_treasury_reconciliations` table, discriminated by
 * the `chain` column carrying CAIP-2 strings.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSyncRelay } from "../index.js";
import type { SyncRelay } from "../index.js";
import {
  createTreasuryReconciliationTable,
  listTreasuryReconciliations,
} from "../treasury-reconciliation.js";
import {
  SqliteSolanaTreasuryReconciliationStore,
  startSolanaTreasuryReconciliationLoop,
} from "../solana-treasury-reconciliation.js";
import {
  OperatorSolanaTreasuryReconciler,
  SOLANA_MAINNET_CAIP2,
  SOLANA_TREASURY_DEFAULT_CHAIN,
  USDC_MINT_MAINNET,
  type SolanaRpcAdapter,
} from "@motebit/wallet-solana";

const TREASURY = "RelayTreasurySolanaBase58";
const SOLANA_CHAIN = SOLANA_MAINNET_CAIP2;

let relay: SyncRelay;

beforeEach(async () => {
  relay = await createSyncRelay({
    apiToken: "test-token",
    enableDeviceAuth: true,
    x402: {
      payToAddress: "0xee51c5a65c6Fa81c9CC85505884290e90C09D285",
      network: "eip155:8453",
      testnet: true,
    },
  });
  createTreasuryReconciliationTable(relay.moteDb.db);
});

afterEach(async () => {
  await relay.close();
});

function makeAdapter(overrides: Partial<SolanaRpcAdapter> = {}): SolanaRpcAdapter {
  return {
    ownAddress: TREASURY,
    getUsdcBalance: vi.fn().mockResolvedValue(0n),
    getSolBalance: vi.fn().mockResolvedValue(0n),
    sendUsdc: vi.fn().mockResolvedValue({ signature: "x", slot: 0, confirmed: true }),
    sendUsdcBatch: vi.fn().mockResolvedValue([]),
    getTransaction: vi.fn().mockResolvedValue({ status: "not_found" }),
    isReachable: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function seedP2pSettlement(
  db: SyncRelay["moteDb"]["db"],
  args: {
    settlementId: string;
    feeMicro: number;
    settledAtMs: number;
    verificationStatus?: "verified" | "pending" | "failed";
  },
): void {
  db.prepare(
    `INSERT INTO relay_settlements
       (settlement_id, allocation_id, task_id, motebit_id, amount_settled,
        platform_fee, platform_fee_rate, status, settled_at, settlement_mode,
        p2p_tx_hash, payment_verification_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    args.settlementId,
    `alloc-${args.settlementId}`,
    `task-${args.settlementId}`,
    "motebit_worker",
    args.feeMicro * 20,
    args.feeMicro,
    0.05,
    "settled",
    args.settledAtMs,
    "p2p",
    `tx-${args.settlementId}`,
    args.verificationStatus ?? "verified",
  );
}

function seedEvmRelaySettlement(
  db: SyncRelay["moteDb"]["db"],
  args: { settlementId: string; feeMicro: number; settledAtMs: number },
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
    args.feeMicro * 20,
    args.feeMicro,
    0.05,
    "settled",
    args.settledAtMs,
    "relay",
    "eip155:8453",
  );
}

describe("SqliteSolanaTreasuryReconciliationStore — getRecordedFeeSumMicro", () => {
  it("sums platform_fee for VERIFIED p2p settlements only", () => {
    const store = new SqliteSolanaTreasuryReconciliationStore(relay.moteDb.db);
    const now = Date.now();
    seedP2pSettlement(relay.moteDb.db, {
      settlementId: "s1",
      feeMicro: 50_000,
      settledAtMs: now - 60_000,
      verificationStatus: "verified",
    });
    seedP2pSettlement(relay.moteDb.db, {
      settlementId: "s2",
      feeMicro: 25_000,
      settledAtMs: now - 30_000,
      verificationStatus: "verified",
    });

    expect(store.getRecordedFeeSumMicro(now)).toBe(75_000n);
  });

  it("excludes p2p settlements with payment_verification_status='pending'", () => {
    const store = new SqliteSolanaTreasuryReconciliationStore(relay.moteDb.db);
    const now = Date.now();
    seedP2pSettlement(relay.moteDb.db, {
      settlementId: "s1",
      feeMicro: 50_000,
      settledAtMs: now - 60_000,
      verificationStatus: "verified",
    });
    seedP2pSettlement(relay.moteDb.db, {
      settlementId: "s2",
      feeMicro: 999_000,
      settledAtMs: now - 60_000,
      verificationStatus: "pending",
    });

    expect(store.getRecordedFeeSumMicro(now)).toBe(50_000n);
  });

  it("excludes p2p settlements with payment_verification_status='failed'", () => {
    const store = new SqliteSolanaTreasuryReconciliationStore(relay.moteDb.db);
    const now = Date.now();
    seedP2pSettlement(relay.moteDb.db, {
      settlementId: "s1",
      feeMicro: 50_000,
      settledAtMs: now - 60_000,
      verificationStatus: "verified",
    });
    seedP2pSettlement(relay.moteDb.db, {
      settlementId: "s2",
      feeMicro: 999_000,
      settledAtMs: now - 60_000,
      verificationStatus: "failed",
    });

    expect(store.getRecordedFeeSumMicro(now)).toBe(50_000n);
  });

  it("excludes settlement_mode='relay' rows (EVM x402 fees)", () => {
    const store = new SqliteSolanaTreasuryReconciliationStore(relay.moteDb.db);
    const now = Date.now();
    seedP2pSettlement(relay.moteDb.db, {
      settlementId: "p1",
      feeMicro: 50_000,
      settledAtMs: now - 60_000,
    });
    seedEvmRelaySettlement(relay.moteDb.db, {
      settlementId: "e1",
      feeMicro: 999_000,
      settledAtMs: now - 60_000,
    });

    expect(store.getRecordedFeeSumMicro(now)).toBe(50_000n);
  });

  it("excludes settlements newer than asOfMs (confirmation-lag buffer)", () => {
    const store = new SqliteSolanaTreasuryReconciliationStore(relay.moteDb.db);
    const now = Date.now();
    seedP2pSettlement(relay.moteDb.db, {
      settlementId: "s1",
      feeMicro: 100_000,
      settledAtMs: now - 600_000,
    });
    seedP2pSettlement(relay.moteDb.db, {
      settlementId: "s2",
      feeMicro: 999_000,
      settledAtMs: now - 60_000,
    });

    expect(store.getRecordedFeeSumMicro(now - 5 * 60_000)).toBe(100_000n);
  });

  it("returns 0n when no settlements exist", () => {
    const store = new SqliteSolanaTreasuryReconciliationStore(relay.moteDb.db);
    expect(store.getRecordedFeeSumMicro(Date.now())).toBe(0n);
  });
});

describe("SqliteSolanaTreasuryReconciliationStore — persistReconciliation", () => {
  it("round-trips through the shared relay_treasury_reconciliations table", () => {
    const store = new SqliteSolanaTreasuryReconciliationStore(relay.moteDb.db);
    store.persistReconciliation({
      reconciliationId: "sol-rec-1",
      runAtMs: 1000,
      chain: SOLANA_CHAIN,
      treasuryAddress: TREASURY,
      usdcContractAddress: USDC_MINT_MAINNET,
      recordedFeeSumMicro: 100_000n,
      observedOnchainBalanceMicro: 200_000n,
      driftMicro: 100_000n,
      consistent: true,
      confirmationLagBufferMs: 300_000,
    });

    const records = listTreasuryReconciliations(relay.moteDb.db, 10);
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.reconciliation_id).toBe("sol-rec-1");
    expect(r.chain).toBe(SOLANA_CHAIN);
    expect(r.treasury_address).toBe(TREASURY);
    expect(r.usdc_contract_address).toBe(USDC_MINT_MAINNET);
    expect(BigInt(r.recorded_fee_sum_micro)).toBe(100_000n);
    expect(BigInt(r.drift_micro)).toBe(100_000n);
    expect(r.consistent).toBe(1);
  });

  it("Solana and EVM rows coexist in the same table, discriminated by chain", () => {
    const store = new SqliteSolanaTreasuryReconciliationStore(relay.moteDb.db);
    // Solana row via Solana store
    store.persistReconciliation({
      reconciliationId: "sol-1",
      runAtMs: 2000,
      chain: SOLANA_CHAIN,
      treasuryAddress: TREASURY,
      usdcContractAddress: USDC_MINT_MAINNET,
      recordedFeeSumMicro: 50_000n,
      observedOnchainBalanceMicro: 60_000n,
      driftMicro: 10_000n,
      consistent: true,
      confirmationLagBufferMs: 300_000,
    });
    // Plain SQL insert mimicking an EVM-reconciler row
    relay.moteDb.db
      .prepare(
        `INSERT INTO relay_treasury_reconciliations
           (reconciliation_id, run_at, chain, treasury_address,
            usdc_contract_address, recorded_fee_sum_micro,
            observed_onchain_balance_micro, drift_micro, consistent,
            confirmation_lag_buffer_ms, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "evm-1",
        1000,
        "eip155:8453",
        "0xee51c5a65c6Fa81c9CC85505884290e90C09D285",
        "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        "200000",
        "300000",
        "100000",
        1,
        300_000,
        null,
      );

    const records = listTreasuryReconciliations(relay.moteDb.db, 10);
    expect(records).toHaveLength(2);
    const chains = records.map((r) => r.chain).sort();
    expect(chains).toEqual([SOLANA_CHAIN, "eip155:8453"].sort());
  });
});

describe("startSolanaTreasuryReconciliationLoop", () => {
  it("respects isFrozen() — skips cycle when frozen", async () => {
    const adapter = makeAdapter();
    const reconciler = new OperatorSolanaTreasuryReconciler(
      adapter,
      SOLANA_TREASURY_DEFAULT_CHAIN,
      USDC_MINT_MAINNET,
    );
    const isFrozen = vi.fn().mockReturnValue(true);

    const interval = startSolanaTreasuryReconciliationLoop({
      db: relay.moteDb.db,
      // rpcUrl + identitySeed are ignored when reconciler is injected
      rpcUrl: "https://example.invalid",
      identitySeed: new Uint8Array(32),
      intervalMs: 10,
      isFrozen,
      reconciler,
    });
    await new Promise((r) => setTimeout(r, 30));
    clearInterval(interval);

    expect(isFrozen).toHaveBeenCalled();
    expect(adapter.getUsdcBalance).not.toHaveBeenCalled();
    expect(listTreasuryReconciliations(relay.moteDb.db, 10)).toHaveLength(0);
  });

  it("runs a cycle when not frozen and persists the result", async () => {
    const adapter = makeAdapter({
      getUsdcBalance: vi.fn().mockResolvedValue(4_026_726n),
    });
    const reconciler = new OperatorSolanaTreasuryReconciler(
      adapter,
      SOLANA_TREASURY_DEFAULT_CHAIN,
      USDC_MINT_MAINNET,
    );

    const interval = startSolanaTreasuryReconciliationLoop({
      db: relay.moteDb.db,
      rpcUrl: "https://example.invalid",
      identitySeed: new Uint8Array(32),
      intervalMs: 10,
      reconciler,
    });
    await new Promise((r) => setTimeout(r, 50));
    clearInterval(interval);

    expect(adapter.getUsdcBalance).toHaveBeenCalled();
    const records = listTreasuryReconciliations(relay.moteDb.db, 10);
    expect(records.length).toBeGreaterThanOrEqual(1);
    const r = records[0]!;
    expect(r.chain).toBe(SOLANA_TREASURY_DEFAULT_CHAIN);
    expect(r.treasury_address).toBe(TREASURY);
    expect(BigInt(r.observed_onchain_balance_micro)).toBe(4_026_726n);
    expect(r.consistent).toBe(1);
  });
});
