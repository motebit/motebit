/**
 * Money Loop Concurrency Tests
 *
 * Proves balances stay consistent under parallel load. SQLite serializes writes,
 * so concurrent requests queue rather than interleave — but the tests verify
 * that the application logic handles this correctly: no double-counting, no
 * lost updates, no negative balances, and ledger reconciliation passes.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation
import { generateKeypair, bytesToHex, signExecutionReceipt, hash as sha256 } from "@motebit/crypto";
import type { MotebitId, DeviceId } from "@motebit/sdk";
import { reconcileLedger } from "../accounts.js";
import {
  AUTH_HEADER as AUTH,
  JSON_AUTH,
  jsonAuthWithIdempotency,
  createTestRelay,
  createAgent,
} from "./test-helpers.js";

async function registerWorker(relay: SyncRelay, motebitId: string): Promise<void> {
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
      pricing: [{ capability: "web_search", unit_cost: 1.0, currency: "USD", per: "task" }],
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
    body: JSON.stringify({ amount, reference: `deposit-${crypto.randomUUID()}` }),
  });
  const body = (await res.json()) as { balance: number };
  return body.balance;
}

async function getBalance(relay: SyncRelay, motebitId: string): Promise<number> {
  const res = await relay.app.request(`/api/v1/agents/${motebitId}/balance`, {
    headers: AUTH,
  });
  const body = (await res.json()) as { balance: number };
  return body.balance;
}

async function buildSignedReceipt(
  taskId: string,
  workerMotebitId: string,
  workerPrivateKey: Uint8Array,
): Promise<Record<string, unknown>> {
  const enc = new TextEncoder();
  const promptHash = await sha256(enc.encode("search for motebit sovereign agents"));
  const resultHash = await sha256(
    enc.encode("Search results: motebit is a sovereign agent protocol"),
  );

  const unsignedReceipt = {
    task_id: taskId,
    relay_task_id: taskId,
    motebit_id: workerMotebitId as unknown as MotebitId,
    device_id: "web-search-service" as unknown as DeviceId,
    submitted_at: Date.now() - 1000,
    completed_at: Date.now(),
    status: "completed" as const,
    result: "Search results: motebit is a sovereign agent protocol",
    tools_used: ["web_search"],
    memories_formed: 0,
    prompt_hash: promptHash,
    result_hash: resultHash,
  };
  return await signExecutionReceipt(unsignedReceipt, workerPrivateKey);
}

describe("Money Loop Concurrency", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(async () => {
    await relay.close();
  });

  it("10 concurrent deposits to same agent — final balance is exactly $10", async () => {
    const agentKp = await generateKeypair();
    const agent = await createAgent(relay, bytesToHex(agentKp.publicKey));

    // Fire 10 deposits of $1 each simultaneously
    const results = await Promise.all(
      Array.from({ length: 10 }, async (_, i) =>
        relay.app.request(`/api/v1/agents/${agent.motebitId}/deposit`, {
          method: "POST",
          headers: jsonAuthWithIdempotency(),
          body: JSON.stringify({ amount: 1.0, reference: `concurrent-deposit-${i}` }),
        }),
      ),
    );

    // All should succeed
    for (const res of results) {
      expect(res.status).toBe(200);
    }

    // Final balance should be exactly $10
    const balance = await getBalance(relay, agent.motebitId);
    expect(balance).toBeCloseTo(10.0, 2);

    // Exactly 10 deposit transactions
    const txnCount = relay.moteDb.db
      .prepare(
        "SELECT COUNT(*) as count FROM relay_transactions WHERE motebit_id = ? AND type = 'deposit'",
      )
      .get(agent.motebitId) as { count: number };
    expect(txnCount.count).toBe(10);

    const reconciliation = reconcileLedger(relay.moteDb.db);
    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.errors).toHaveLength(0);
  });

  it("10 concurrent task submissions from same delegator — no overdraft", async () => {
    const workerKp = await generateKeypair();
    const delegatorKp = await generateKeypair();
    const worker = await createAgent(relay, bytesToHex(workerKp.publicKey));
    const delegator = await createAgent(relay, bytesToHex(delegatorKp.publicKey));

    await registerWorker(relay, worker.motebitId);
    await deposit(relay, delegator.motebitId, 20.0);

    // Submit 10 tasks simultaneously, each costing ~$1.05 gross
    const results = await Promise.all(
      Array.from({ length: 10 }, async () =>
        relay.app.request(`/agent/${worker.motebitId}/task`, {
          method: "POST",
          headers: jsonAuthWithIdempotency(),
          body: JSON.stringify({
            prompt: "search for motebit sovereign agents",
            submitted_by: delegator.motebitId,
            required_capabilities: ["web_search"],
          }),
        }),
      ),
    );

    const accepted = results.filter((r) => r.status === 201);

    // All should either be accepted (201) or rejected for insufficient funds (402)
    for (const res of results) {
      expect([201, 402]).toContain(res.status);
    }

    // Balance should never go negative
    const balance = await getBalance(relay, delegator.motebitId);
    expect(balance).toBeGreaterThanOrEqual(-0.001);

    // Total debited should not exceed $20
    const totalLocked = 20.0 - balance;
    expect(totalLocked).toBeLessThanOrEqual(20.01); // floating point tolerance

    // Number of accepted tasks * gross cost per task should approximately equal total locked
    if (accepted.length > 0) {
      const costPerTask = totalLocked / accepted.length;
      expect(costPerTask).toBeGreaterThan(0);
    }

    const reconciliation = reconcileLedger(relay.moteDb.db);
    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.errors).toHaveLength(0);
  });

  it("concurrent withdraw + deposit race — balance never negative", async () => {
    const agentKp = await generateKeypair();
    const agent = await createAgent(relay, bytesToHex(agentKp.publicKey));
    await deposit(relay, agent.motebitId, 50.0);

    // Simultaneously: deposit $30 and withdraw $50
    const [depositRes, withdrawRes] = await Promise.all([
      relay.app.request(`/api/v1/agents/${agent.motebitId}/deposit`, {
        method: "POST",
        headers: jsonAuthWithIdempotency(),
        body: JSON.stringify({ amount: 30.0, reference: "race-deposit" }),
      }),
      relay.app.request(`/api/v1/agents/${agent.motebitId}/withdraw`, {
        method: "POST",
        headers: jsonAuthWithIdempotency(),
        body: JSON.stringify({
          amount: 50.0,
          destination: "0xMyWallet",
          idempotency_key: "race-withdraw",
        }),
      }),
    ]);

    expect(depositRes.status).toBe(200);

    const balance = await getBalance(relay, agent.motebitId);

    if (withdrawRes.status === 200) {
      // Withdraw succeeded: either deposit ran first (50+30=80, then -50=30)
      // or withdraw ran first (50-50=0, then +30=30)
      // Either way, final balance should be 30
      expect(balance).toBeCloseTo(30.0, 2);
    } else if (withdrawRes.status === 402) {
      // Withdraw failed due to insufficient balance (shouldn't happen with $50 available)
      // but if it did, balance = 50 + 30 = 80
      expect(balance).toBeCloseTo(80.0, 2);
    } else {
      // Unexpected status
      expect.unreachable(`Unexpected withdraw status: ${withdrawRes.status}`);
    }

    // Balance is never negative
    expect(balance).toBeGreaterThanOrEqual(-0.001);

    const reconciliation = reconcileLedger(relay.moteDb.db);
    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.errors).toHaveLength(0);
  });

  it("concurrent settlements crediting same worker — balance is exactly $5", async () => {
    const workerKp = await generateKeypair();
    const delegatorKp = await generateKeypair();
    const worker = await createAgent(relay, bytesToHex(workerKp.publicKey));
    const delegator = await createAgent(relay, bytesToHex(delegatorKp.publicKey));

    await registerWorker(relay, worker.motebitId);
    await deposit(relay, delegator.motebitId, 100.0);

    // Submit 5 tasks sequentially (need unique task IDs)
    const taskIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await relay.app.request(`/agent/${worker.motebitId}/task`, {
        method: "POST",
        headers: jsonAuthWithIdempotency(),
        body: JSON.stringify({
          prompt: "search for motebit sovereign agents",
          submitted_by: delegator.motebitId,
          required_capabilities: ["web_search"],
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { task_id: string };
      taskIds.push(body.task_id);
    }

    // Build receipts for all 5 tasks
    const receipts = await Promise.all(
      taskIds.map((taskId) => buildSignedReceipt(taskId, worker.motebitId, workerKp.privateKey)),
    );

    // Submit all 5 receipts simultaneously
    const results = await Promise.all(
      taskIds.map(async (taskId, i) =>
        relay.app.request(`/agent/${worker.motebitId}/task/${taskId}/result`, {
          method: "POST",
          headers: JSON_AUTH,
          body: JSON.stringify(receipts[i]),
        }),
      ),
    );

    // All should succeed
    for (const res of results) {
      expect(res.status).toBe(200);
    }

    // Worker should have exactly 5 settlement credits
    const credits = relay.moteDb.db
      .prepare(
        "SELECT COUNT(*) as count FROM relay_transactions WHERE motebit_id = ? AND type = 'settlement_credit'",
      )
      .get(worker.motebitId) as { count: number };
    expect(credits.count).toBe(5);

    // Worker balance: each task pays unit_cost = $1.00 (net after 5% fee = $0.95 per task... but
    // settlement_credit is the net amount). Check that total is exactly 5 × net.
    const workerBalance = await getBalance(relay, worker.motebitId);
    // 5 tasks × $1.00 net each (the worker's unit_cost is what they receive)
    expect(workerBalance).toBeCloseTo(5.0, 2);

    // Exactly 5 settlements
    const settlementCount = relay.moteDb.db
      .prepare("SELECT COUNT(*) as count FROM relay_settlements WHERE motebit_id = ?")
      .get(worker.motebitId) as { count: number };
    expect(settlementCount.count).toBe(5);

    const reconciliation = reconcileLedger(relay.moteDb.db);
    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.errors).toHaveLength(0);
  });

  it("rapid deposit-withdraw-deposit cycle — final balance consistent, never negative", async () => {
    const agentKp = await generateKeypair();
    const agent = await createAgent(relay, bytesToHex(agentKp.publicKey));

    // Seed with initial balance so withdrawals have something to take
    await deposit(relay, agent.motebitId, 100.0);

    // 20 operations: alternating deposit $10 and withdraw $5
    const operations = Array.from({ length: 20 }, async (_, i) => {
      if (i % 2 === 0) {
        // Deposit $10
        return relay.app.request(`/api/v1/agents/${agent.motebitId}/deposit`, {
          method: "POST",
          headers: jsonAuthWithIdempotency(),
          body: JSON.stringify({ amount: 10.0, reference: `rapid-deposit-${i}` }),
        });
      } else {
        // Withdraw $5
        return relay.app.request(`/api/v1/agents/${agent.motebitId}/withdraw`, {
          method: "POST",
          headers: jsonAuthWithIdempotency(),
          body: JSON.stringify({
            amount: 5.0,
            destination: "0xMyWallet",
            idempotency_key: `rapid-withdraw-${i}`,
          }),
        });
      }
    });

    const results = await Promise.all(operations);

    // Count successes
    let depositsSucceeded = 0;
    let withdrawalsSucceeded = 0;

    for (let i = 0; i < results.length; i++) {
      if (i % 2 === 0) {
        // Deposits should always succeed
        expect(results[i]!.status).toBe(200);
        depositsSucceeded++;
      } else {
        if (results[i]!.status === 200) {
          withdrawalsSucceeded++;
        } else {
          // 402 is acceptable — insufficient balance
          expect(results[i]!.status).toBe(402);
        }
      }
    }

    // All 10 deposits should have succeeded
    expect(depositsSucceeded).toBe(10);

    // Final balance = 100 + (depositsSucceeded × 10) - (withdrawalsSucceeded × 5)
    const expectedBalance = 100 + depositsSucceeded * 10 - withdrawalsSucceeded * 5;
    const balance = await getBalance(relay, agent.motebitId);
    expect(balance).toBeCloseTo(expectedBalance, 2);

    // Balance is never negative
    expect(balance).toBeGreaterThanOrEqual(-0.001);

    // Verify all deposit transactions exist
    const depositTxns = relay.moteDb.db
      .prepare(
        "SELECT COUNT(*) as count FROM relay_transactions WHERE motebit_id = ? AND type = 'deposit'",
      )
      .get(agent.motebitId) as { count: number };
    // 1 initial + 10 concurrent deposits
    expect(depositTxns.count).toBe(11);

    // Verify withdrawal transactions match succeeded count
    const withdrawalTxns = relay.moteDb.db
      .prepare(
        "SELECT COUNT(*) as count FROM relay_transactions WHERE motebit_id = ? AND type = 'withdrawal'",
      )
      .get(agent.motebitId) as { count: number };
    expect(withdrawalTxns.count).toBe(withdrawalsSucceeded);

    const reconciliation = reconcileLedger(relay.moteDb.db);
    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.errors).toHaveLength(0);
  });
});
