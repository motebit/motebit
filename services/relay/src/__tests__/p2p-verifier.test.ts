/**
 * P2P verifier tests — async verification, trust downgrade, admin reporting.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import { generateKeypair, bytesToHex } from "@motebit/encryption";
import { getSettlementStatsByMode, getRecentP2pSettlements } from "../p2p-verifier.js";
import { AUTH_HEADER, createTestRelay } from "./test-helpers.js";

// === Helpers ===

async function registerAgent(relay: SyncRelay, motebitId: string, publicKeyHex: string) {
  await relay.app.request(`/api/v1/agents/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({
      motebit_id: motebitId,
      endpoint_url: "http://localhost:9999/mcp",
      capabilities: ["web_search"],
      public_key: publicKeyHex,
    }),
  });
}

function insertSettlement(
  db: import("@motebit/persistence").DatabaseDriver,
  settlementId: string,
  taskId: string,
  workerId: string,
  mode: "relay" | "p2p",
  verificationStatus: string = "verified",
  txHash: string | null = null,
) {
  db.prepare(
    `INSERT OR IGNORE INTO relay_settlements
     (settlement_id, allocation_id, task_id, motebit_id, receipt_hash,
      amount_settled, platform_fee, platform_fee_rate, status, settled_at,
      settlement_mode, p2p_tx_hash, payment_verification_status)
     VALUES (?, ?, ?, ?, '', ?, ?, ?, 'completed', ?, ?, ?, ?)`,
  ).run(
    settlementId,
    `alloc-${taskId}`,
    taskId,
    workerId,
    mode === "relay" ? 100000 : 0,
    mode === "relay" ? 5000 : 0,
    mode === "relay" ? 0.05 : 0,
    Date.now(),
    mode,
    txHash,
    verificationStatus,
  );
}

// === getSettlementStatsByMode ===

describe("getSettlementStatsByMode", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
    const kp = await generateKeypair();
    await registerAgent(relay, "worker-stats", bytesToHex(kp.publicKey));
  });

  afterEach(async () => {
    await relay.close();
  });

  it("groups settlements by mode", () => {
    insertSettlement(relay.moteDb.db, "stl-r1", "task-r1", "worker-stats", "relay");
    insertSettlement(relay.moteDb.db, "stl-r2", "task-r2", "worker-stats", "relay");
    insertSettlement(
      relay.moteDb.db,
      "stl-p1",
      "task-p1",
      "worker-stats",
      "p2p",
      "pending",
      "tx123",
    );

    const stats = getSettlementStatsByMode(relay.moteDb.db);

    const relayStats = stats.find((s) => s.mode === "relay");
    const p2pStats = stats.find((s) => s.mode === "p2p");

    expect(relayStats).toBeDefined();
    expect(relayStats!.count).toBe(2);
    expect(relayStats!.total_settled).toBe(200000);
    expect(relayStats!.verified_count).toBe(2);

    expect(p2pStats).toBeDefined();
    expect(p2pStats!.count).toBe(1);
    expect(p2pStats!.pending_count).toBe(1);
  });

  it("returns empty array when no settlements exist", () => {
    const stats = getSettlementStatsByMode(relay.moteDb.db);
    expect(stats).toEqual([]);
  });

  it("counts failed verifications", () => {
    insertSettlement(
      relay.moteDb.db,
      "stl-f1",
      "task-f1",
      "worker-stats",
      "p2p",
      "failed",
      "bad-tx",
    );
    insertSettlement(
      relay.moteDb.db,
      "stl-f2",
      "task-f2",
      "worker-stats",
      "p2p",
      "verified",
      "good-tx",
    );

    const stats = getSettlementStatsByMode(relay.moteDb.db);
    const p2p = stats.find((s) => s.mode === "p2p");
    expect(p2p!.failed_count).toBe(1);
    expect(p2p!.verified_count).toBe(1);
  });
});

// === getRecentP2pSettlements ===

describe("getRecentP2pSettlements", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
  });

  afterEach(async () => {
    await relay.close();
  });

  it("returns only p2p settlements", () => {
    insertSettlement(relay.moteDb.db, "stl-r1", "task-r1", "w1", "relay");
    insertSettlement(relay.moteDb.db, "stl-p1", "task-p1", "w1", "p2p", "pending", "tx-abc");

    const recent = getRecentP2pSettlements(relay.moteDb.db);
    expect(recent.length).toBe(1);
    expect(recent[0]!.settlement_id).toBe("stl-p1");
    expect(recent[0]!.p2p_tx_hash).toBe("tx-abc");
    expect(recent[0]!.payment_verification_status).toBe("pending");
  });

  it("returns empty when no p2p settlements", () => {
    insertSettlement(relay.moteDb.db, "stl-r1", "task-r1", "w1", "relay");
    const recent = getRecentP2pSettlements(relay.moteDb.db);
    expect(recent).toEqual([]);
  });
});

// === Admin endpoint ===

describe("GET /api/v1/admin/settlements", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
  });

  afterEach(async () => {
    await relay.close();
  });

  it("returns stats grouped by mode", async () => {
    insertSettlement(relay.moteDb.db, "stl-a1", "task-a1", "w1", "relay");
    insertSettlement(relay.moteDb.db, "stl-a2", "task-a2", "w1", "p2p", "verified", "tx1");

    const res = await relay.app.request("/api/v1/admin/settlements", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      stats_by_mode: Array<{ mode: string; count: number }>;
      recent_p2p: Array<{ settlement_id: string }>;
      p2p_verifier_enabled: boolean;
    };

    expect(body.stats_by_mode.length).toBeGreaterThanOrEqual(1);
    expect(body.recent_p2p.length).toBe(1);
    expect(typeof body.p2p_verifier_enabled).toBe("boolean");
  });
});
