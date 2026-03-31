/**
 * Settlement Safety Tests
 *
 * Part A: Auto-refund on retry exhaustion — verifies that when settlement retries
 * are exhausted, the onRetryExhausted callback is invoked and can refund funds.
 *
 * Part B: Recursive multi-hop settlement — verifies that nested delegation_receipts
 * at arbitrary depth all get settled, and that a depth limit prevents infinite recursion.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { processSettlementRetries, createFederationTables } from "../federation.js";
import type { RelayIdentity } from "../federation.js";
import type { SyncRelay } from "../index.js";
import { openMotebitDatabase, type DatabaseDriver } from "@motebit/persistence";
// eslint-disable-next-line no-restricted-imports -- tests need direct crypto
import { generateKeypair, bytesToHex, signExecutionReceipt, hash as sha256 } from "@motebit/crypto";
import type { MotebitId, DeviceId } from "@motebit/sdk";
import {
  AUTH_HEADER as AUTH,
  JSON_AUTH,
  jsonAuthWithIdempotency,
  createTestRelay,
  createAgent,
} from "./test-helpers.js";

// === Part A helpers ===

function insertPeer(
  db: DatabaseDriver,
  peerId: string,
  endpointUrl: string,
  state = "active",
): void {
  const keypair = crypto.getRandomValues(new Uint8Array(32));
  db.prepare(
    `INSERT OR REPLACE INTO relay_peers (peer_relay_id, public_key, endpoint_url, state, missed_heartbeats, agent_count, trust_score)
     VALUES (?, ?, ?, ?, 0, 0, 0.5)`,
  ).run(peerId, bytesToHex(keypair), endpointUrl, state);
}

function insertRetry(
  db: DatabaseDriver,
  opts: {
    retryId?: string;
    settlementId?: string;
    taskId?: string;
    peerRelayId: string;
    attempts?: number;
    maxAttempts?: number;
    nextRetryAt?: number;
    status?: string;
  },
): string {
  const retryId = opts.retryId ?? crypto.randomUUID();
  const payload = {
    task_id: opts.taskId ?? "task-1",
    settlement_id: opts.settlementId ?? "settle-1",
    origin_relay: "self-relay",
    gross_amount: 100,
    receipt_hash: "abc123",
  };
  db.prepare(
    `INSERT INTO relay_settlement_retries (retry_id, settlement_id, task_id, peer_relay_id, payload_json, attempts, max_attempts, next_retry_at, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    retryId,
    opts.settlementId ?? "settle-1",
    opts.taskId ?? "task-1",
    opts.peerRelayId,
    JSON.stringify(payload),
    opts.attempts ?? 0,
    opts.maxAttempts ?? 5,
    opts.nextRetryAt ?? Date.now() - 1000,
    opts.status ?? "pending",
    Date.now(),
  );
  return retryId;
}

// === Part B helpers ===

async function registerWorker(relay: SyncRelay, motebitId: string, unitCost = 1.0): Promise<void> {
  await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      motebit_id: motebitId,
      endpoint_url: "http://localhost:3200/mcp",
      capabilities: ["web_search"],
    }),
  });
  await relay.app.request(`/api/v1/agents/${motebitId}/listing`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      capabilities: ["web_search"],
      pricing: [{ capability: "web_search", unit_cost: unitCost, currency: "USD", per: "task" }],
      sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
      description: "Web search service",
      pay_to_address: "0x1234567890abcdef1234567890abcdef12345678",
    }),
  });
}

async function deposit(relay: SyncRelay, motebitId: string, amount: number): Promise<number> {
  const res = await relay.app.request(`/api/v1/agents/${motebitId}/deposit`, {
    method: "POST",
    headers: jsonAuthWithIdempotency(),
    body: JSON.stringify({
      amount,
      reference: `deposit-${crypto.randomUUID()}`,
      description: "Test funding",
    }),
  });
  const body = (await res.json()) as { balance: number };
  return body.balance;
}

// === Part A: Retry Exhaustion Refund ===

describe("Settlement Retry Exhaustion Refund", () => {
  let db: DatabaseDriver;
  let identity: RelayIdentity;

  beforeEach(async () => {
    const keypair = await generateKeypair();
    identity = {
      relayMotebitId: `relay-${crypto.randomUUID()}`,
      publicKey: keypair.publicKey,
      privateKey: keypair.privateKey,
      publicKeyHex: bytesToHex(keypair.publicKey),
      did: `did:key:z${bytesToHex(keypair.publicKey).slice(0, 16)}`,
    };

    const moteDb = await openMotebitDatabase(":memory:");
    createFederationTables(moteDb.db);
    moteDb.db.exec(
      "CREATE TABLE IF NOT EXISTS agent_registry (motebit_id TEXT PRIMARY KEY, expires_at INTEGER)",
    );
    db = moteDb.db;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it("invokes onRetryExhausted callback when retries are exhausted", async () => {
    insertPeer(db, "peer-1", "http://peer.test");
    const taskId = `task-${crypto.randomUUID()}`;
    insertRetry(db, {
      peerRelayId: "peer-1",
      taskId,
      attempts: 4,
      maxAttempts: 5,
    });

    vi.stubGlobal("fetch", async () => {
      throw new Error("Still unreachable");
    });

    const exhaustedRetries: Array<{ retry_id: string; task_id: string }> = [];
    await processSettlementRetries(db, identity, (retry) => {
      exhaustedRetries.push(retry);
    });

    expect(exhaustedRetries).toHaveLength(1);
    expect(exhaustedRetries[0]!.task_id).toBe(taskId);
  });

  it("does not invoke callback when retries are not exhausted", async () => {
    insertPeer(db, "peer-1", "http://peer.test");
    insertRetry(db, {
      peerRelayId: "peer-1",
      attempts: 2,
      maxAttempts: 5,
    });

    vi.stubGlobal("fetch", async () => {
      throw new Error("Connection refused");
    });

    const exhaustedRetries: Array<{ retry_id: string }> = [];
    await processSettlementRetries(db, identity, (retry) => {
      exhaustedRetries.push(retry);
    });

    expect(exhaustedRetries).toHaveLength(0);
  });

  it("handles callback error gracefully without crashing", async () => {
    insertPeer(db, "peer-1", "http://peer.test");
    insertRetry(db, {
      peerRelayId: "peer-1",
      attempts: 4,
      maxAttempts: 5,
    });

    vi.stubGlobal("fetch", async () => {
      throw new Error("Unreachable");
    });

    // Callback throws — should not propagate
    await processSettlementRetries(db, identity, () => {
      throw new Error("Refund failed");
    });

    // Retry should still be marked failed despite callback error
    const retry = db
      .prepare("SELECT status FROM relay_settlement_retries WHERE peer_relay_id = ?")
      .get("peer-1") as { status: string } | undefined;
    expect(retry?.status).toBe("failed");
  });

  it("works without callback (backward compatible)", async () => {
    insertPeer(db, "peer-1", "http://peer.test");
    insertRetry(db, {
      peerRelayId: "peer-1",
      attempts: 4,
      maxAttempts: 5,
    });

    vi.stubGlobal("fetch", async () => {
      throw new Error("Unreachable");
    });

    // No callback — should not throw
    await processSettlementRetries(db, identity);

    const retry = db
      .prepare("SELECT status FROM relay_settlement_retries WHERE peer_relay_id = ?")
      .get("peer-1") as { status: string } | undefined;
    expect(retry?.status).toBe("failed");
  });
});

// === Part B: Recursive Multi-Hop Settlement ===

describe("Recursive Multi-Hop Settlement", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(async () => {
    await relay.close();
  });

  it("settles three-level delegation chain (A delegates to B, B delegates to C, C delegates to D)", async () => {
    // Setup: 4 agents — A (delegator), B (intermediate), C (intermediate), D (leaf worker)
    const kpA = await generateKeypair();
    const kpB = await generateKeypair();
    const kpC = await generateKeypair();
    const kpD = await generateKeypair();

    const agentA = await createAgent(relay, bytesToHex(kpA.publicKey));
    const agentB = await createAgent(relay, bytesToHex(kpB.publicKey));
    const agentC = await createAgent(relay, bytesToHex(kpC.publicKey));
    const agentD = await createAgent(relay, bytesToHex(kpD.publicKey));

    // Register B, C, D as workers
    await registerWorker(relay, agentB.motebitId, 2.0);
    await registerWorker(relay, agentC.motebitId, 1.5);
    await registerWorker(relay, agentD.motebitId, 1.0);

    // Fund A
    await deposit(relay, agentA.motebitId, 100.0);

    // A submits task to B
    const taskResAB = await relay.app.request(`/agent/${agentB.motebitId}/task`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({
        prompt: "search for motebit",
        submitted_by: agentA.motebitId,
        required_capabilities: ["web_search"],
      }),
    });
    expect(taskResAB.status).toBe(201);
    const taskAB = (await taskResAB.json()) as { task_id: string };

    // B submits sub-task to C
    await deposit(relay, agentB.motebitId, 50.0);
    const taskResBC = await relay.app.request(`/agent/${agentC.motebitId}/task`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({
        prompt: "read url content",
        submitted_by: agentB.motebitId,
        required_capabilities: ["web_search"],
      }),
    });
    expect(taskResBC.status).toBe(201);
    const taskBC = (await taskResBC.json()) as { task_id: string };

    // C submits sub-task to D
    await deposit(relay, agentC.motebitId, 50.0);
    const taskResCD = await relay.app.request(`/agent/${agentD.motebitId}/task`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({
        prompt: "fetch page",
        submitted_by: agentC.motebitId,
        required_capabilities: ["web_search"],
      }),
    });
    expect(taskResCD.status).toBe(201);
    const taskCD = (await taskResCD.json()) as { task_id: string };

    // D signs its receipt
    const enc = new TextEncoder();
    const receiptD = await signExecutionReceipt(
      {
        task_id: taskCD.task_id,
        relay_task_id: taskCD.task_id,
        motebit_id: agentD.motebitId as unknown as MotebitId,
        device_id: "d-device" as unknown as DeviceId,
        submitted_at: Date.now() - 1000,
        completed_at: Date.now(),
        status: "completed" as const,
        result: "Page content",
        tools_used: ["fetch"],
        memories_formed: 0,
        prompt_hash: await sha256(enc.encode("fetch page")),
        result_hash: await sha256(enc.encode("Page content")),
      },
      kpD.privateKey,
    );

    // C signs its receipt with D's receipt nested
    const receiptC = await signExecutionReceipt(
      {
        task_id: taskBC.task_id,
        relay_task_id: taskBC.task_id,
        motebit_id: agentC.motebitId as unknown as MotebitId,
        device_id: "c-device" as unknown as DeviceId,
        submitted_at: Date.now() - 2000,
        completed_at: Date.now(),
        status: "completed" as const,
        result: "Processed content",
        tools_used: ["process"],
        memories_formed: 0,
        prompt_hash: await sha256(enc.encode("read url content")),
        result_hash: await sha256(enc.encode("Processed content")),
        delegation_receipts: [receiptD],
      },
      kpC.privateKey,
    );

    // B signs its receipt with C's receipt (which contains D's) nested
    const receiptB = await signExecutionReceipt(
      {
        task_id: taskAB.task_id,
        relay_task_id: taskAB.task_id,
        motebit_id: agentB.motebitId as unknown as MotebitId,
        device_id: "b-device" as unknown as DeviceId,
        submitted_at: Date.now() - 3000,
        completed_at: Date.now(),
        status: "completed" as const,
        result: "Search results",
        tools_used: ["web_search"],
        memories_formed: 0,
        prompt_hash: await sha256(enc.encode("search for motebit")),
        result_hash: await sha256(enc.encode("Search results")),
        delegation_receipts: [receiptC],
      },
      kpB.privateKey,
    );

    // Submit B's receipt to settle A→B task (triggers recursive settlement)
    const resultRes = await relay.app.request(
      `/agent/${agentB.motebitId}/task/${taskAB.task_id}/result`,
      {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify(receiptB),
      },
    );
    expect(resultRes.status).toBe(200);

    // Verify B got paid (A→B settlement)
    const balB = await relay.app.request(`/api/v1/agents/${agentB.motebitId}/balance`, {
      headers: AUTH,
    });
    const bB = (await balB.json()) as { balance: number; transactions: Array<{ type: string }> };
    const bSettlements = bB.transactions.filter((t) => t.type === "settlement_credit");
    expect(bSettlements.length).toBeGreaterThanOrEqual(1);

    // Verify C got paid (B→C settlement, recursively settled)
    const balC = await relay.app.request(`/api/v1/agents/${agentC.motebitId}/balance`, {
      headers: AUTH,
    });
    const bC = (await balC.json()) as { balance: number; transactions: Array<{ type: string }> };
    const cSettlements = bC.transactions.filter((t) => t.type === "settlement_credit");
    expect(cSettlements.length).toBeGreaterThanOrEqual(1);

    // Verify D got paid (C→D settlement, recursively settled at depth 2)
    const balD = await relay.app.request(`/api/v1/agents/${agentD.motebitId}/balance`, {
      headers: AUTH,
    });
    const bD = (await balD.json()) as { balance: number; transactions: Array<{ type: string }> };
    const dSettlements = bD.transactions.filter((t) => t.type === "settlement_credit");
    expect(dSettlements.length).toBeGreaterThanOrEqual(1);
  });

  it("stops recursive settlement at depth limit (>10)", async () => {
    // This test verifies the depth guard by constructing a chain that would exceed depth 10.
    // We build a chain of 12 agents: A→B→C→...→L (12 levels).
    // The settlement should stop at depth 10, leaving the last 2 unsettled.
    const agentCount = 13; // A + 12 workers (12 hops: A→B→C→...→M)
    const keypairs = await Promise.all(Array.from({ length: agentCount }, () => generateKeypair()));
    const agents = [];

    for (const kp of keypairs) {
      agents.push(await createAgent(relay, bytesToHex(kp.publicKey)));
    }

    // Register all workers (index 1+) and fund all intermediaries
    for (let i = 1; i < agentCount; i++) {
      await registerWorker(relay, agents[i]!.motebitId, 0.5);
      if (i < agentCount - 1) {
        await deposit(relay, agents[i]!.motebitId, 100.0);
      }
    }
    await deposit(relay, agents[0]!.motebitId, 200.0);

    // Submit tasks for each hop: agent[i] → agent[i+1]
    const taskIds: string[] = [];
    for (let i = 0; i < agentCount - 1; i++) {
      const taskRes = await relay.app.request(`/agent/${agents[i + 1]!.motebitId}/task`, {
        method: "POST",
        headers: jsonAuthWithIdempotency(),
        body: JSON.stringify({
          prompt: `task-${i}`,
          submitted_by: agents[i]!.motebitId,
          required_capabilities: ["web_search"],
        }),
      });
      expect(taskRes.status).toBe(201);
      const body = (await taskRes.json()) as { task_id: string };
      taskIds.push(body.task_id);
    }

    // Build nested receipts from the bottom up
    const enc = new TextEncoder();
    let currentReceipt = await signExecutionReceipt(
      {
        task_id: taskIds[taskIds.length - 1]!,
        relay_task_id: taskIds[taskIds.length - 1]!,
        motebit_id: agents[agentCount - 1]!.motebitId as unknown as MotebitId,
        device_id: "leaf-device" as unknown as DeviceId,
        submitted_at: Date.now() - 1000,
        completed_at: Date.now(),
        status: "completed" as const,
        result: "leaf result",
        tools_used: ["tool"],
        memories_formed: 0,
        prompt_hash: await sha256(enc.encode(`task-${agentCount - 2}`)),
        result_hash: await sha256(enc.encode("leaf result")),
      },
      keypairs[agentCount - 1]!.privateKey,
    );

    // Build receipts from bottom to top, nesting each in the parent.
    // Loop from agent[agentCount-2] down to agent[2] — these are intermediate nodes.
    for (let i = agentCount - 2; i >= 2; i--) {
      currentReceipt = await signExecutionReceipt(
        {
          task_id: taskIds[i]!,
          relay_task_id: taskIds[i]!,
          motebit_id: agents[i]!.motebitId as unknown as MotebitId,
          device_id: `device-${i}` as unknown as DeviceId,
          submitted_at: Date.now() - (agentCount - i) * 1000,
          completed_at: Date.now(),
          status: "completed" as const,
          result: `result-${i}`,
          tools_used: ["tool"],
          memories_formed: 0,
          prompt_hash: await sha256(enc.encode(`task-${i - 1}`)),
          result_hash: await sha256(enc.encode(`result-${i}`)),
          delegation_receipts: [currentReceipt],
        },
        keypairs[i]!.privateKey,
      );
    }

    // Build agent[1]'s receipt for taskIds[0] (the A→B task) with the chain nested inside
    currentReceipt = await signExecutionReceipt(
      {
        task_id: taskIds[0]!,
        relay_task_id: taskIds[0]!,
        motebit_id: agents[1]!.motebitId as unknown as MotebitId,
        device_id: "device-1" as unknown as DeviceId,
        submitted_at: Date.now() - agentCount * 1000,
        completed_at: Date.now(),
        status: "completed" as const,
        result: "top-result",
        tools_used: ["tool"],
        memories_formed: 0,
        prompt_hash: await sha256(enc.encode("task-0")),
        result_hash: await sha256(enc.encode("top-result")),
        delegation_receipts: [currentReceipt],
      },
      keypairs[1]!.privateKey,
    );

    // Submit the top-level receipt (agent[1]'s receipt for task[0])
    const resultRes = await relay.app.request(
      `/agent/${agents[1]!.motebitId}/task/${taskIds[0]!}/result`,
      {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify(currentReceipt),
      },
    );
    expect(resultRes.status).toBe(200);

    // Count how many agents got settlement credits.
    // With depth limit 10, agents at index 1-11 should be settled (depth 1-10 in the recursion),
    // but agent at index 12 (depth 11) should NOT be settled.
    let settledCount = 0;
    for (let i = 1; i < agentCount; i++) {
      const bal = await relay.app.request(`/api/v1/agents/${agents[i]!.motebitId}/balance`, {
        headers: AUTH,
      });
      const body = (await bal.json()) as { transactions: Array<{ type: string }> };
      const hasSettlement = body.transactions.some((t) => t.type === "settlement_credit");
      if (hasSettlement) settledCount++;
    }

    // The first 11 workers (depth 1-10 plus the top-level) should get settled,
    // but the 12th (depth 11) should be blocked by depth limit.
    // Top-level settlement (agent[1]) is not recursive — it's the direct receipt handler.
    // The recursive function starts at depth=1 for delegation_receipts of agent[1].
    // So depth limit 10 means: agent[2] through agent[11] get settled (depth 1-10),
    // agent[12] at depth 11 gets blocked.
    // Plus agent[1] gets settled by the direct (non-recursive) handler.
    // Total settled: 1 (direct) + 10 (recursive) = 11 out of 12 workers.
    expect(settledCount).toBeLessThan(agentCount - 1);
    // At minimum, agents 1-11 should be settled
    expect(settledCount).toBeGreaterThanOrEqual(10);
  });
});
