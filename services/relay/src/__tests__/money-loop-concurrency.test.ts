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
import {
  generateKeypair,
  bytesToHex,
  signExecutionReceipt,
  hash as sha256,
} from "@motebit/encryption";
import type { MotebitId, DeviceId } from "@motebit/sdk";
import { reconcileLedger } from "../accounts.js";
import {
  AUTH_HEADER as AUTH,
  JSON_AUTH,
  jsonAuthWithIdempotency,
  createTestRelay,
  createAgent,
  seedBalance,
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
  return seedBalance(relay, motebitId, amount);
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

  // NOTE: the "10 concurrent deposits" test was removed with the self-declared
  // `POST /deposit` route (treasury-drain vector). Concurrent credit atomicity is
  // a store-level concern covered in virtual-accounts; concurrent-spend safety
  // (the money-relevant invariant) is covered by the task-submission and
  // settlement-credit concurrency tests below, plus the concurrent-withdrawal
  // double-spend test that replaced the deposit/withdraw race.

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

  it("concurrent withdrawals exceeding balance — no double-spend, never negative", async () => {
    const agentKp = await generateKeypair();
    const agent = await createAgent(relay, bytesToHex(agentKp.publicKey));
    seedBalance(relay, agent.motebitId, 50.0);

    // Fire two withdrawals ($50 + $30 = $80) against a $50 balance
    // simultaneously — the atomic debit must let at most a funded subset
    // through; the pair can never both settle (that would over-draw the
    // treasury), and balance must never go negative.
    const [wd50, wd30] = await Promise.all([
      relay.app.request(`/api/v1/agents/${agent.motebitId}/withdraw`, {
        method: "POST",
        headers: jsonAuthWithIdempotency(),
        body: JSON.stringify({ amount: 50.0, destination: "0xWalletA", idempotency_key: "wd-50" }),
      }),
      relay.app.request(`/api/v1/agents/${agent.motebitId}/withdraw`, {
        method: "POST",
        headers: jsonAuthWithIdempotency(),
        body: JSON.stringify({ amount: 30.0, destination: "0xWalletB", idempotency_key: "wd-30" }),
      }),
    ]);

    const succeededMicro = (wd50.status === 200 ? 50 : 0) + (wd30.status === 200 ? 30 : 0);
    // At most $50 can have been withdrawn — both succeeding ($80) would be a
    // double-spend against the treasury.
    expect(succeededMicro).toBeLessThanOrEqual(50);

    const balance = await getBalance(relay, agent.motebitId);
    expect(balance).toBeCloseTo(50 - succeededMicro, 2);
    expect(balance).toBeGreaterThanOrEqual(-0.001);

    const reconciliation = reconcileLedger(relay.moteDb.db);
    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.errors).toHaveLength(0);
  });

  it("concurrent settlements crediting same worker — 5 credits totaling $5, none lost", async () => {
    const workerKp = await generateKeypair();
    const worker = await createAgent(relay, bytesToHex(workerKp.publicKey));

    // Arc 3.5: self-delegation (submitted_by === worker) — the worker funds
    // itself and delegates 5 tasks to itself; the concurrency property under
    // test (5 parallel settlement credits all land, none lost to a race) is
    // identical. We assert the credit COUNT and SUM rather than the raw
    // balance, since under self-delegation the balance also reflects the
    // deposit-side allocation locks.
    await registerWorker(relay, worker.motebitId);
    await deposit(relay, worker.motebitId, 100.0);

    // Submit 5 tasks sequentially (need unique task IDs)
    const taskIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await relay.app.request(`/agent/${worker.motebitId}/task`, {
        method: "POST",
        headers: jsonAuthWithIdempotency(),
        body: JSON.stringify({
          prompt: "search for motebit sovereign agents",
          submitted_by: worker.motebitId,
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

    // The 5 credits sum to exactly 5 × net ($1.00 each) — proves no concurrent
    // credit was lost or double-applied. (Deposit-independent: this asserts the
    // earnings total, not the raw balance, which also carries the deposit.)
    const creditSum = relay.moteDb.db
      .prepare(
        "SELECT COALESCE(SUM(amount), 0) as total FROM relay_transactions WHERE motebit_id = ? AND type = 'settlement_credit'",
      )
      .get(worker.motebitId) as { total: number };
    // amount is stored in micro-units; 5 × $1.00 net = 5_000_000.
    expect(creditSum.total).toBe(5_000_000);

    // Exactly 5 settlements
    const settlementCount = relay.moteDb.db
      .prepare("SELECT COUNT(*) as count FROM relay_settlements WHERE motebit_id = ?")
      .get(worker.motebitId) as { count: number };
    expect(settlementCount.count).toBe(5);

    const reconciliation = reconcileLedger(relay.moteDb.db);
    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.errors).toHaveLength(0);
  });

  it("many concurrent withdrawals against seeded balance — consistent, never negative", async () => {
    const agentKp = await generateKeypair();
    const agent = await createAgent(relay, bytesToHex(agentKp.publicKey));

    // Seed once, then fire 20 concurrent $5 withdrawals against $50 — only 10
    // can be funded. The atomic debit must never over-draw or go negative,
    // regardless of interleaving.
    seedBalance(relay, agent.motebitId, 50.0);

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        relay.app.request(`/api/v1/agents/${agent.motebitId}/withdraw`, {
          method: "POST",
          headers: jsonAuthWithIdempotency(),
          body: JSON.stringify({
            amount: 5.0,
            destination: "0xMyWallet",
            idempotency_key: `rapid-withdraw-${i}`,
          }),
        }),
      ),
    );

    let withdrawalsSucceeded = 0;
    for (const res of results) {
      if (res.status === 200) {
        withdrawalsSucceeded++;
      } else {
        // 402 is the only acceptable non-success — insufficient balance.
        expect(res.status).toBe(402);
      }
    }

    // At most $50 of $5 withdrawals can be funded — no over-draw.
    expect(withdrawalsSucceeded).toBeLessThanOrEqual(10);

    const balance = await getBalance(relay, agent.motebitId);
    expect(balance).toBeCloseTo(50 - withdrawalsSucceeded * 5, 2);
    expect(balance).toBeGreaterThanOrEqual(-0.001);

    // Withdrawal transaction rows match the succeeded count exactly.
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
