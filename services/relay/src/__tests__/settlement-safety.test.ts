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
import {
  generateKeypair,
  bytesToHex,
  signExecutionReceipt,
  hash as sha256,
} from "@motebit/encryption";
import type { MotebitId, DeviceId } from "@motebit/sdk";
import {
  AUTH_HEADER as AUTH,
  JSON_AUTH,
  createTestRelay,
  createAgent,
  seedP2pSubTask,
} from "./test-helpers.js";
import { toMicro } from "../accounts.js";

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

// === Part A.2: Double-spend prevention ===
// Verifies that the refund callback cannot credit the delegator if the allocation
// has already been settled (e.g., a late-arriving receipt settled the worker).

describe("Refund double-spend prevention", () => {
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
    // Create accounts + allocations tables for refund testing
    moteDb.db.exec(`
      CREATE TABLE IF NOT EXISTS relay_accounts (
        motebit_id TEXT PRIMARY KEY,
        balance INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS relay_allocations (
        allocation_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL UNIQUE,
        motebit_id TEXT NOT NULL,
        amount_locked INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'locked',
        created_at INTEGER NOT NULL,
        settled_at INTEGER,
        released_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS relay_transactions (
        transaction_id TEXT PRIMARY KEY,
        motebit_id TEXT NOT NULL,
        amount INTEGER NOT NULL,
        type TEXT NOT NULL,
        reference_id TEXT,
        description TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS relay_refund_log (
        refund_id TEXT PRIMARY KEY,
        retry_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        allocation_id TEXT NOT NULL,
        delegator_id TEXT NOT NULL,
        amount INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'completed',
        error TEXT,
        created_at INTEGER NOT NULL
      );
    `);
    db = moteDb.db;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips refund when allocation is already settled", async () => {
    const taskId = `task-${crypto.randomUUID()}`;
    const allocId = `alloc-${crypto.randomUUID()}`;
    const delegatorId = "delegator-1";

    // Create a settled allocation (simulates: receipt arrived and settled before retry exhaustion)
    db.prepare("INSERT INTO relay_accounts (motebit_id, balance) VALUES (?, ?)").run(
      delegatorId,
      0,
    );
    db.prepare(
      "INSERT INTO relay_allocations (allocation_id, task_id, motebit_id, amount_locked, status, created_at, settled_at) VALUES (?, ?, ?, ?, 'settled', ?, ?)",
    ).run(allocId, taskId, delegatorId, 500_000, Date.now(), Date.now());

    insertPeer(db, "peer-1", "http://peer.test");
    insertRetry(db, {
      peerRelayId: "peer-1",
      taskId,
      attempts: 4,
      maxAttempts: 5,
    });

    vi.stubGlobal("fetch", async () => {
      throw new Error("Unreachable");
    });

    let callbackInvoked = false;
    await processSettlementRetries(db, identity, (retry) => {
      callbackInvoked = true;
      // Simulate the refund callback from index.ts — atomic status claim
      const claimResult = db
        .prepare(
          "UPDATE relay_allocations SET status = 'released', released_at = ? WHERE task_id = ? AND status = 'locked'",
        )
        .run(Date.now(), retry.task_id);
      // Should be 0 changes because allocation is already 'settled'
      expect(claimResult.changes).toBe(0);
    });

    expect(callbackInvoked).toBe(true);

    // Delegator balance unchanged — no double-spend
    const account = db
      .prepare("SELECT balance FROM relay_accounts WHERE motebit_id = ?")
      .get(delegatorId) as { balance: number };
    expect(account.balance).toBe(0);

    // Allocation still in settled state — not corrupted
    const alloc = db
      .prepare("SELECT status FROM relay_allocations WHERE allocation_id = ?")
      .get(allocId) as { status: string };
    expect(alloc.status).toBe("settled");
  });
});

// === Part B: Recursive Multi-Hop Settlement ===

// Multi-hop-as-P2P (Increment 1): these tests drive p2p sub-hops — each hop is a
// task the sub-delegator paid onchain from its OWN wallet and submitted with a
// payment_proof (seeded via seedP2pSubTask). A single top-level receipt carrying
// the nested chain drives settleSubReceipt, which now writes an AUDIT-ONLY p2p
// settlement row per hop (no relay custody, no virtual-account credit). See
// docs/doctrine/off-ramp-as-user-action.md § "Multi-hop-as-P2P — Increment 1"
// and services/relay/CLAUDE.md rule 8.
const WORKER_ADDR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv";

describe("Recursive Multi-Hop Settlement (p2p)", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(async () => {
    await relay.close();
  });

  it("settles a three-level p2p chain (A→B→C→D) as audit-only p2p rows", async () => {
    const kpA = await generateKeypair();
    const kpB = await generateKeypair();
    const kpC = await generateKeypair();
    const kpD = await generateKeypair();

    const agentA = await createAgent(relay, bytesToHex(kpA.publicKey));
    const agentB = await createAgent(relay, bytesToHex(kpB.publicKey));
    const agentC = await createAgent(relay, bytesToHex(kpC.publicKey));
    const agentD = await createAgent(relay, bytesToHex(kpD.publicKey));

    // Each hop: the sub-delegator paid its worker onchain from its own wallet.
    const taskAB = seedP2pSubTask(relay, {
      workerId: agentB.motebitId,
      delegatorId: agentA.motebitId,
      prompt: "search for motebit",
      unitCostUsd: 2.0,
      workerAddress: WORKER_ADDR,
    });
    const taskBC = seedP2pSubTask(relay, {
      workerId: agentC.motebitId,
      delegatorId: agentB.motebitId,
      prompt: "read url content",
      unitCostUsd: 1.5,
      workerAddress: WORKER_ADDR,
    });
    const taskCD = seedP2pSubTask(relay, {
      workerId: agentD.motebitId,
      delegatorId: agentC.motebitId,
      prompt: "fetch page",
      unitCostUsd: 1.0,
      workerAddress: WORKER_ADDR,
    });

    const enc = new TextEncoder();
    const receiptD = await signExecutionReceipt(
      {
        task_id: taskCD,
        relay_task_id: taskCD,
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
    const receiptC = await signExecutionReceipt(
      {
        task_id: taskBC,
        relay_task_id: taskBC,
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
    const receiptB = await signExecutionReceipt(
      {
        task_id: taskAB,
        relay_task_id: taskAB,
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

    // One top-level receipt submission drives the whole chain.
    const resultRes = await relay.app.request(`/agent/${agentB.motebitId}/task/${taskAB}/result`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify(receiptB),
    });
    expect(resultRes.status).toBe(200);

    // Every hop settled as an AUDIT-ONLY p2p row: settlement_mode='p2p', the net
    // from the proof, a fee leg, and a tx hash — no relay custody.
    const p2pRow = (taskId: string, agentId: string) =>
      relay.moteDb.db
        .prepare(
          "SELECT settlement_mode, amount_settled, platform_fee, p2p_tx_hash FROM relay_settlements WHERE task_id = ? AND motebit_id = ?",
        )
        .get(taskId, agentId) as
        | {
            settlement_mode: string;
            amount_settled: number;
            platform_fee: number;
            p2p_tx_hash: string | null;
          }
        | undefined;

    for (const [taskId, agentId, net] of [
      [taskAB, agentB.motebitId, toMicro(2.0)],
      [taskBC, agentC.motebitId, toMicro(1.5)],
      [taskCD, agentD.motebitId, toMicro(1.0)],
    ] as const) {
      const row = p2pRow(taskId, agentId);
      expect(row).toBeDefined();
      expect(row!.settlement_mode).toBe("p2p");
      expect(row!.amount_settled).toBe(net);
      expect(row!.platform_fee).toBeGreaterThan(0);
      expect(row!.p2p_tx_hash).not.toBeNull();
    }

    // P2P books NO virtual-account credit — money moved onchain.
    for (const agentId of [agentB.motebitId, agentC.motebitId, agentD.motebitId]) {
      const bal = (await (
        await relay.app.request(`/api/v1/agents/${agentId}/balance`, { headers: AUTH })
      ).json()) as { transactions: Array<{ type: string }> };
      expect(bal.transactions.some((t) => t.type === "settlement_credit")).toBe(false);
    }
  });

  it("stops recursive p2p settlement at the depth limit (>10)", async () => {
    const agentCount = 13; // A + 12 workers (12 hops: agent[0]→…→agent[12])
    const keypairs = await Promise.all(Array.from({ length: agentCount }, () => generateKeypair()));
    const agents = [];
    for (const kp of keypairs) {
      agents.push(await createAgent(relay, bytesToHex(kp.publicKey)));
    }

    // Seed each hop agent[i]→agent[i+1] as a p2p sub-task (worker = agent[i+1]).
    const taskIds: string[] = [];
    for (let i = 0; i < agentCount - 1; i++) {
      taskIds.push(
        seedP2pSubTask(relay, {
          workerId: agents[i + 1]!.motebitId,
          delegatorId: agents[i]!.motebitId,
          prompt: `task-${i}`,
          unitCostUsd: 0.5,
          workerAddress: WORKER_ADDR,
        }),
      );
    }

    // Nest receipts bottom-up. agent[i] is the WORKER of taskIds[i-1], so its
    // receipt is signed by keypairs[i] and bound to relay_task_id = taskIds[i-1].
    const enc = new TextEncoder();
    // Leaf: agent[12], worker of taskIds[11].
    let currentReceipt = await signExecutionReceipt(
      {
        task_id: taskIds[agentCount - 2]!,
        relay_task_id: taskIds[agentCount - 2]!,
        motebit_id: agents[agentCount - 1]!.motebitId as unknown as MotebitId,
        device_id: "leaf-device" as unknown as DeviceId,
        submitted_at: Date.now() - 1000,
        completed_at: Date.now(),
        status: "completed" as const,
        result: "leaf result",
        tools_used: ["tool"],
        memories_formed: 0,
        prompt_hash: await sha256(enc.encode("leaf")),
        result_hash: await sha256(enc.encode("leaf result")),
      },
      keypairs[agentCount - 1]!.privateKey,
    );
    // Intermediates agent[11]…agent[2]: each worker of taskIds[i-1], nests the child.
    for (let i = agentCount - 2; i >= 2; i--) {
      currentReceipt = await signExecutionReceipt(
        {
          task_id: taskIds[i - 1]!,
          relay_task_id: taskIds[i - 1]!,
          motebit_id: agents[i]!.motebitId as unknown as MotebitId,
          device_id: `device-${i}` as unknown as DeviceId,
          submitted_at: Date.now() - (agentCount - i) * 1000,
          completed_at: Date.now(),
          status: "completed" as const,
          result: `result-${i}`,
          tools_used: ["tool"],
          memories_formed: 0,
          prompt_hash: await sha256(enc.encode(`hop-${i}`)),
          result_hash: await sha256(enc.encode(`result-${i}`)),
          delegation_receipts: [currentReceipt],
        },
        keypairs[i]!.privateKey,
      );
    }
    // Top: agent[1], worker of taskIds[0] (the agent[0]→agent[1] task).
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
        prompt_hash: await sha256(enc.encode("hop-1")),
        result_hash: await sha256(enc.encode("top-result")),
        delegation_receipts: [currentReceipt],
      },
      keypairs[1]!.privateKey,
    );

    const resultRes = await relay.app.request(
      `/agent/${agents[1]!.motebitId}/task/${taskIds[0]!}/result`,
      { method: "POST", headers: JSON_AUTH, body: JSON.stringify(currentReceipt) },
    );
    expect(resultRes.status).toBe(200);

    // agent[1] settles via the direct parent-P2P write; the recursion settles
    // agent[2]…agent[11] (depths 1–10); agent[12] at depth 11 is blocked by the
    // depth guard. Count agents with a p2p settlement row.
    let p2pSettledCount = 0;
    for (let i = 1; i < agentCount; i++) {
      const row = relay.moteDb.db
        .prepare("SELECT 1 FROM relay_settlements WHERE motebit_id = ? AND settlement_mode = 'p2p'")
        .get(agents[i]!.motebitId);
      if (row != null) p2pSettledCount++;
    }
    // 1 (direct) + 10 (recursive depths 1–10) = 11; agent[12] at depth 11 blocked.
    expect(p2pSettledCount).toBe(11);
    expect(p2pSettledCount).toBeLessThan(agentCount - 1);
    expect(p2pSettledCount).toBeGreaterThanOrEqual(10);
  });
});
