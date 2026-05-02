/**
 * Treasury reconciliation service-level integration test.
 *
 * Boots the relay's Hono app, seeds reconciliation records into the DB
 * directly, and exercises `GET /api/v1/admin/treasury-reconciliation`
 * over the in-process app.request() boundary. Verifies the admin
 * endpoint shape + auth gating end-to-end.
 *
 * Modeled on `delegation-e2e.test.ts`'s in-process fetch routing pattern.
 * Doesn't run the actual reconciliation loop — that's covered by
 * `treasury-reconciliation.test.ts` (service unit) and
 * `packages/treasury-reconciliation/src/__tests__/reconciler.test.ts`
 * (package algebra).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSyncRelay } from "../index.js";
import type { SyncRelay } from "../index.js";
import {
  createTreasuryReconciliationTable,
  SqliteTreasuryReconciliationStore,
} from "../treasury-reconciliation.js";

const API_TOKEN = "test-admin-token";
const TREASURY = "0xee51c5a65c6Fa81c9CC85505884290e90C09D285";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CHAIN = "eip155:8453";

let relay: SyncRelay;

beforeEach(async () => {
  relay = await createSyncRelay({
    apiToken: API_TOKEN,
    enableDeviceAuth: true,
    x402: {
      payToAddress: TREASURY,
      network: CHAIN,
      testnet: true, // testnet boot to avoid CDP requirement
    },
  });
  createTreasuryReconciliationTable(relay.moteDb.db);
});

afterEach(async () => {
  await relay.close();
});

describe("GET /api/v1/admin/treasury-reconciliation", () => {
  it("returns the canonical response shape with seeded records", async () => {
    const store = new SqliteTreasuryReconciliationStore(relay.moteDb.db);
    const now = Date.now();
    store.persistReconciliation({
      reconciliationId: "rec-e2e-1",
      runAtMs: now - 60_000,
      chain: CHAIN,
      treasuryAddress: TREASURY,
      usdcContractAddress: USDC,
      recordedFeeSumMicro: 0n,
      observedOnchainBalanceMicro: 4_026_726n,
      driftMicro: 4_026_726n,
      consistent: true,
      confirmationLagBufferMs: 300_000,
    });

    const res = await relay.app.request("/api/v1/admin/treasury-reconciliation", {
      headers: { Authorization: `Bearer ${API_TOKEN}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      stats: {
        total_runs: number;
        last_run_at: number | null;
        current_consistent: boolean | null;
        current_drift_micro: string | null;
      };
      records: Array<{ reconciliation_id: string; consistent: number }>;
      treasury_address: string;
      chain: string;
      loop_enabled: boolean;
    };

    expect(body.treasury_address).toBe(TREASURY);
    expect(body.chain).toBe(CHAIN);
    // testnet boot means loop_enabled is false (the loop only starts on mainnet)
    expect(body.loop_enabled).toBe(false);
    expect(body.stats.total_runs).toBe(1);
    expect(body.stats.current_consistent).toBe(true);
    expect(body.records).toHaveLength(1);
    expect(body.records[0]!.reconciliation_id).toBe("rec-e2e-1");
  });

  it("surfaces inconsistent (negative-drift) records correctly", async () => {
    const store = new SqliteTreasuryReconciliationStore(relay.moteDb.db);
    const now = Date.now();
    store.persistReconciliation({
      reconciliationId: "rec-drift",
      runAtMs: now - 30_000,
      chain: CHAIN,
      treasuryAddress: TREASURY,
      usdcContractAddress: USDC,
      recordedFeeSumMicro: 5_000_000n,
      observedOnchainBalanceMicro: 1_000_000n,
      driftMicro: -4_000_000n,
      consistent: false,
      confirmationLagBufferMs: 300_000,
    });

    const res = await relay.app.request("/api/v1/admin/treasury-reconciliation", {
      headers: { Authorization: `Bearer ${API_TOKEN}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      stats: {
        inconsistent_runs_24h: number;
        max_negative_drift_micro_7d: string;
        current_consistent: boolean | null;
      };
      records: Array<{ consistent: number; drift_micro: string }>;
    };

    expect(body.stats.inconsistent_runs_24h).toBe(1);
    expect(BigInt(body.stats.max_negative_drift_micro_7d)).toBe(-4_000_000n);
    expect(body.stats.current_consistent).toBe(false);
    expect(body.records[0]!.consistent).toBe(0);
    expect(BigInt(body.records[0]!.drift_micro)).toBe(-4_000_000n);
  });

  it("returns empty stats + records when no reconciliations have run", async () => {
    const res = await relay.app.request("/api/v1/admin/treasury-reconciliation", {
      headers: { Authorization: `Bearer ${API_TOKEN}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      stats: { total_runs: number; last_run_at: number | null };
      records: unknown[];
    };

    expect(body.stats.total_runs).toBe(0);
    expect(body.stats.last_run_at).toBeNull();
    expect(body.records).toEqual([]);
  });

  it("rejects unauthenticated requests with 401 (admin-route auth gate)", async () => {
    const res = await relay.app.request("/api/v1/admin/treasury-reconciliation");
    expect(res.status).toBe(401);
  });

  it("rejects requests with wrong bearer token", async () => {
    const res = await relay.app.request("/api/v1/admin/treasury-reconciliation", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });
});
