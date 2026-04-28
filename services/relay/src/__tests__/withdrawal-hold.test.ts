/**
 * Withdrawal hold tests — dispute window guard.
 *
 * Funds from recent settlements (within 24h) are held back from
 * withdrawal until the dispute window closes. This prevents workers
 * from withdrawing before a dispute can be filed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import { generateKeypair, bytesToHex } from "@motebit/encryption";
import { computeDisputeWindowHold, creditAccount } from "../accounts.js";
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

function createSettlement(
  db: import("@motebit/persistence").DatabaseDriver,
  workerId: string,
  taskId: string,
  amount: number,
  settledAt: number,
) {
  const db_ = db as { prepare: (sql: string) => { run: (...args: unknown[]) => void } };
  const settlementId = `stl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  db_
    .prepare(
      `INSERT OR IGNORE INTO relay_settlements
     (settlement_id, allocation_id, task_id, motebit_id, receipt_hash, amount_settled, platform_fee, platform_fee_rate, status, settled_at)
     VALUES (?, ?, ?, ?, '', ?, 0, 0.05, 'completed', ?)`,
    )
    .run(settlementId, `alloc-${taskId}`, taskId, workerId, amount, settledAt);
  return settlementId;
}

// Use a typed db handle
let relay: SyncRelay;

// === Tests ===

describe("computeDisputeWindowHold", () => {
  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
    const kp = await generateKeypair();
    await registerAgent(relay, "worker-hold", bytesToHex(kp.publicKey));
    // Give the worker a balance
    creditAccount(
      relay.moteDb.db,
      "worker-hold",
      500000,
      "deposit",
      "test-deposit",
      "Test deposit",
    );
  });

  afterEach(async () => {
    await relay.close();
  });

  it("holds back funds from recent settlements", () => {
    // Create a settlement within the last 24h
    createSettlement(relay.moteDb.db, "worker-hold", "recent-task", 100000, Date.now() - 3600000); // 1h ago

    const hold = computeDisputeWindowHold(relay.moteDb.db, "worker-hold");
    expect(hold).toBe(100000);
  });

  it("does not hold funds from settlements older than 24h", () => {
    // Create a settlement >24h ago
    const oldTime = Date.now() - 25 * 60 * 60 * 1000; // 25h ago
    createSettlement(relay.moteDb.db, "worker-hold", "old-task", 100000, oldTime);

    const hold = computeDisputeWindowHold(relay.moteDb.db, "worker-hold");
    expect(hold).toBe(0);
  });

  it("does not hold funds for settlements that have active disputes", () => {
    // Create a recent settlement
    createSettlement(relay.moteDb.db, "worker-hold", "disputed-task", 100000, Date.now());

    // File a dispute on it
    relay.moteDb.db
      .prepare(
        `INSERT INTO relay_disputes
         (dispute_id, task_id, allocation_id, filed_by, respondent, category, description, state, amount_locked, filing_fee, filed_at, evidence_deadline)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'evidence', ?, 0, ?, ?)`,
      )
      .run(
        "dsp-test",
        "disputed-task",
        "alloc-disputed-task",
        "delegator",
        "worker-hold",
        "quality",
        "Bad work",
        100000,
        Date.now(),
        Date.now() + 48 * 3600000,
      );

    const hold = computeDisputeWindowHold(relay.moteDb.db, "worker-hold");
    expect(hold).toBe(0); // Dispute owns the lock now
  });

  it("sums multiple recent settlements", () => {
    createSettlement(relay.moteDb.db, "worker-hold", "task-a", 50000, Date.now() - 3600000);
    createSettlement(relay.moteDb.db, "worker-hold", "task-b", 75000, Date.now() - 7200000);

    const hold = computeDisputeWindowHold(relay.moteDb.db, "worker-hold");
    expect(hold).toBe(125000);
  });
});

describe("withdrawal with dispute window hold", () => {
  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
    const kp = await generateKeypair();
    await registerAgent(relay, "worker-wd", bytesToHex(kp.publicKey));
    // Give the worker 500000 micro-units ($0.50)
    creditAccount(relay.moteDb.db, "worker-wd", 500000, "deposit", "test-deposit", "Test deposit");
  });

  afterEach(async () => {
    await relay.close();
  });

  it("blocks withdrawal when recent settlement exceeds available balance", async () => {
    // Recent settlement of 400000 — leaves only 100000 available
    createSettlement(relay.moteDb.db, "worker-wd", "recent-task", 400000, Date.now());

    // Try to withdraw 200000 — should fail (available = 500000 - 400000 = 100000)
    const res = await relay.app.request(`/api/v1/agents/worker-wd/withdraw`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "wd-blocked",
        ...AUTH_HEADER,
      },
      body: JSON.stringify({ amount: 0.2, destination: "pending" }),
    });
    expect(res.status).toBe(402);
  });

  it("allows withdrawal of non-held funds", async () => {
    // Recent settlement of 200000 — leaves 300000 available
    createSettlement(relay.moteDb.db, "worker-wd", "recent-task", 200000, Date.now());

    // Withdraw 100000 ($0.10) — should succeed (available = 300000)
    const res = await relay.app.request(`/api/v1/agents/worker-wd/withdraw`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "wd-allowed",
        ...AUTH_HEADER,
      },
      body: JSON.stringify({ amount: 0.1, destination: "pending" }),
    });
    expect(res.status).toBe(200);
  });

  it("surfaces dispute_window_hold in balance endpoint", async () => {
    createSettlement(relay.moteDb.db, "worker-wd", "recent-task", 150000, Date.now());

    const res = await relay.app.request(`/api/v1/agents/worker-wd/balance`, {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      balance: number;
      dispute_window_hold: number;
      available_for_withdrawal: number;
    };
    expect(body.dispute_window_hold).toBe(0.15); // 150000 micro = $0.15
    expect(body.available_for_withdrawal).toBe(body.balance - body.dispute_window_hold);
  });
});
