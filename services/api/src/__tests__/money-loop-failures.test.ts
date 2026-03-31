/**
 * Money Loop Failure Injection Tests
 *
 * Proves the virtual accounts system doesn't corrupt state when things break:
 * missing receipts, duplicate submissions, invalid signatures, wrong task IDs,
 * insufficient balance edge cases, and withdrawal lifecycle errors.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation
import { generateKeypair, bytesToHex, signExecutionReceipt, hash as sha256 } from "@motebit/crypto";
import type { MotebitId, DeviceId } from "@motebit/sdk";
import { reconcileLedger, toMicro } from "../accounts.js";
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

async function submitTask(
  relay: SyncRelay,
  workerMotebitId: string,
  delegatorMotebitId: string,
): Promise<{ taskId: string; status: number }> {
  const res = await relay.app.request(`/agent/${workerMotebitId}/task`, {
    method: "POST",
    headers: jsonAuthWithIdempotency(),
    body: JSON.stringify({
      prompt: "search for motebit sovereign agents",
      submitted_by: delegatorMotebitId,
      required_capabilities: ["web_search"],
    }),
  });
  if (res.status !== 201) {
    return { taskId: "", status: res.status };
  }
  const body = (await res.json()) as { task_id: string };
  return { taskId: body.task_id, status: res.status };
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

async function submitReceipt(
  relay: SyncRelay,
  workerMotebitId: string,
  taskId: string,
  receipt: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await relay.app.request(`/agent/${workerMotebitId}/task/${taskId}/result`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify(receipt),
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

describe("Money Loop Failure Injection", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(() => {
    relay.close();
  });

  it("worker disappears mid-task (no receipt) — allocation stays locked, stale cleanup returns funds", async () => {
    const workerKp = await generateKeypair();
    const delegatorKp = await generateKeypair();
    const worker = await createAgent(relay, bytesToHex(workerKp.publicKey));
    const delegator = await createAgent(relay, bytesToHex(delegatorKp.publicKey));

    await registerWorker(relay, worker.motebitId);
    await deposit(relay, delegator.motebitId, 10.0);

    // Submit task — debits delegator
    const { taskId, status } = await submitTask(relay, worker.motebitId, delegator.motebitId);
    expect(status).toBe(201);
    expect(taskId).toBeTruthy();

    // Delegator balance decreased by the allocation hold
    const midBalance = await getBalance(relay, delegator.motebitId);
    expect(midBalance).toBeLessThan(10.0);
    const lockedAmount = 10.0 - midBalance;
    expect(lockedAmount).toBeGreaterThan(0);

    // Allocation is locked in the DB
    const alloc = relay.moteDb.db
      .prepare("SELECT * FROM relay_allocations WHERE task_id = ? AND status = 'locked'")
      .get(taskId) as { allocation_id: string; amount_locked: number } | undefined;
    expect(alloc).toBeDefined();
    // alloc.amount_locked is in micro-units (DB), lockedAmount is in dollars (API)
    expect(alloc!.amount_locked).toBe(toMicro(lockedAmount));

    // Simulate stale cleanup: backdate the allocation created_at to > 1 hour ago
    relay.moteDb.db
      .prepare("UPDATE relay_allocations SET created_at = ? WHERE task_id = ?")
      .run(Date.now() - 3_700_000, taskId);

    // Run the stale cleanup logic manually (same as the interval callback)
    const now = Date.now();
    const staleAllocations = relay.moteDb.db
      .prepare(
        "SELECT allocation_id, task_id, motebit_id, amount_locked FROM relay_allocations WHERE status = 'locked' AND created_at < ?",
      )
      .all(now - 3_600_000) as Array<{
      allocation_id: string;
      task_id: string;
      motebit_id: string;
      amount_locked: number;
    }>;

    expect(staleAllocations.length).toBeGreaterThan(0);

    // Import creditAccount to perform the cleanup
    const { creditAccount } = await import("../accounts.js");

    relay.moteDb.db.exec("BEGIN");
    for (const a of staleAllocations) {
      creditAccount(
        relay.moteDb.db,
        delegator.motebitId,
        a.amount_locked,
        "allocation_release",
        a.allocation_id,
        `Stale allocation release for task ${a.task_id}`,
      );
    }
    relay.moteDb.db
      .prepare(
        "UPDATE relay_allocations SET status = 'released', released_at = ? WHERE status = 'locked' AND created_at < ?",
      )
      .run(now, now - 3_600_000);
    relay.moteDb.db.exec("COMMIT");

    // Funds returned to delegator
    const afterBalance = await getBalance(relay, delegator.motebitId);
    expect(afterBalance).toBeCloseTo(10.0, 2);

    // Allocation is now released
    const releasedAlloc = relay.moteDb.db
      .prepare("SELECT status FROM relay_allocations WHERE task_id = ?")
      .get(taskId) as { status: string };
    expect(releasedAlloc.status).toBe("released");

    // Ledger reconciles
    const reconciliation = reconcileLedger(relay.moteDb.db);
    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.errors).toHaveLength(0);
  });

  it("duplicate receipt submission — second is idempotent, worker credited once", async () => {
    const workerKp = await generateKeypair();
    const delegatorKp = await generateKeypair();
    const worker = await createAgent(relay, bytesToHex(workerKp.publicKey));
    const delegator = await createAgent(relay, bytesToHex(delegatorKp.publicKey));

    await registerWorker(relay, worker.motebitId);
    await deposit(relay, delegator.motebitId, 10.0);

    const { taskId } = await submitTask(relay, worker.motebitId, delegator.motebitId);
    expect(taskId).toBeTruthy();

    const receipt = await buildSignedReceipt(taskId, worker.motebitId, workerKp.privateKey);

    // First submission — succeeds
    const first = await submitReceipt(relay, worker.motebitId, taskId, receipt);
    expect(first.status).toBe(200);

    const balanceAfterFirst = await getBalance(relay, worker.motebitId);

    // Second submission — idempotent
    const second = await submitReceipt(relay, worker.motebitId, taskId, receipt);
    expect(second.status).toBe(200);
    expect(second.body.status).toBe("already_settled");

    // Worker balance unchanged after second submission
    const balanceAfterSecond = await getBalance(relay, worker.motebitId);
    expect(balanceAfterSecond).toBe(balanceAfterFirst);

    // Only one settlement record exists
    const settlements = relay.moteDb.db
      .prepare("SELECT COUNT(*) as count FROM relay_settlements WHERE task_id = ?")
      .get(taskId) as { count: number };
    expect(settlements.count).toBe(1);

    // Only one credit transaction for the worker
    const credits = relay.moteDb.db
      .prepare(
        "SELECT COUNT(*) as count FROM relay_transactions WHERE motebit_id = ? AND type = 'settlement_credit'",
      )
      .get(worker.motebitId) as { count: number };
    expect(credits.count).toBe(1);

    const reconciliation = reconcileLedger(relay.moteDb.db);
    expect(reconciliation.consistent).toBe(true);
  });

  it("receipt with invalid signature — 403, no settlement, no balance change", async () => {
    const workerKp = await generateKeypair();
    const imposterKp = await generateKeypair(); // different keypair
    const delegatorKp = await generateKeypair();
    const worker = await createAgent(relay, bytesToHex(workerKp.publicKey));
    const delegator = await createAgent(relay, bytesToHex(delegatorKp.publicKey));

    await registerWorker(relay, worker.motebitId);
    await deposit(relay, delegator.motebitId, 10.0);

    const { taskId } = await submitTask(relay, worker.motebitId, delegator.motebitId);
    expect(taskId).toBeTruthy();

    // Sign with the imposter's key, but claim to be the worker
    const receipt = await buildSignedReceipt(taskId, worker.motebitId, imposterKp.privateKey);

    const result = await submitReceipt(relay, worker.motebitId, taskId, receipt);
    expect(result.status).toBe(403);

    // No settlement created
    const settlements = relay.moteDb.db
      .prepare("SELECT COUNT(*) as count FROM relay_settlements WHERE task_id = ?")
      .get(taskId) as { count: number };
    expect(settlements.count).toBe(0);

    // Worker balance unchanged (still 0)
    const workerBalance = await getBalance(relay, worker.motebitId);
    expect(workerBalance).toBe(0);

    const reconciliation = reconcileLedger(relay.moteDb.db);
    expect(reconciliation.consistent).toBe(true);
  });

  it("receipt for nonexistent task_id — rejected, no settlement", async () => {
    const workerKp = await generateKeypair();
    const worker = await createAgent(relay, bytesToHex(workerKp.publicKey));
    await registerWorker(relay, worker.motebitId);

    const fakeTaskId = crypto.randomUUID();
    const receipt = await buildSignedReceipt(fakeTaskId, worker.motebitId, workerKp.privateKey);

    const result = await submitReceipt(relay, worker.motebitId, fakeTaskId, receipt);
    // Should be rejected — task not found in queue
    expect(result.status).toBe(404);

    // No settlement created
    const settlements = relay.moteDb.db
      .prepare("SELECT COUNT(*) as count FROM relay_settlements WHERE task_id = ?")
      .get(fakeTaskId) as { count: number };
    expect(settlements.count).toBe(0);
  });

  it("withdrawal during pending allocation — only available balance is withdrawable", async () => {
    const agentKp = await generateKeypair();
    const workerKp = await generateKeypair();
    const agent = await createAgent(relay, bytesToHex(agentKp.publicKey));
    const worker = await createAgent(relay, bytesToHex(workerKp.publicKey));

    await registerWorker(relay, worker.motebitId);
    await deposit(relay, agent.motebitId, 100.0);

    // Submit enough tasks to lock up ~$80 of the $100
    // Each task costs unit_cost / (1 - 0.05) = 1.0 / 0.95 ≈ $1.0526 gross
    // We need about 76 tasks to lock ~$80
    const taskIds: string[] = [];
    for (let i = 0; i < 76; i++) {
      const { taskId, status } = await submitTask(relay, worker.motebitId, agent.motebitId);
      if (status === 201) {
        taskIds.push(taskId);
      } else {
        break; // insufficient funds
      }
    }

    // Check how much is locked
    const balance = await getBalance(relay, agent.motebitId);
    const locked = 100.0 - balance;
    expect(locked).toBeGreaterThan(50); // at least $50 locked

    // Try to withdraw $50 — should fail (402) because available < $50
    const bigWithdrawRes = await relay.app.request(`/api/v1/agents/${agent.motebitId}/withdraw`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({
        amount: 50.0,
        destination: "0xMyWallet",
        idempotency_key: "big-withdraw",
      }),
    });
    // Should fail — balance is the available amount (already debited for allocations)
    // If balance < 50, it returns 402
    if (balance < 50) {
      expect(bigWithdrawRes.status).toBe(402);
    }

    // Withdraw a small amount that's within available balance
    const smallAmount = Math.min(balance, 15.0);
    if (smallAmount > 0) {
      const smallWithdrawRes = await relay.app.request(
        `/api/v1/agents/${agent.motebitId}/withdraw`,
        {
          method: "POST",
          headers: jsonAuthWithIdempotency(),
          body: JSON.stringify({
            amount: smallAmount,
            destination: "0xMyWallet",
            idempotency_key: "small-withdraw",
          }),
        },
      );
      expect(smallWithdrawRes.status).toBe(200);

      // Balance decreased by the withdrawal
      const afterSmall = await getBalance(relay, agent.motebitId);
      expect(afterSmall).toBeCloseTo(balance - smallAmount, 2);
    }

    const reconciliation = reconcileLedger(relay.moteDb.db);
    expect(reconciliation.consistent).toBe(true);
  });

  it("double withdrawal with same idempotency key — only one debit, idempotent response", async () => {
    const agentKp = await generateKeypair();
    const agent = await createAgent(relay, bytesToHex(agentKp.publicKey));
    await deposit(relay, agent.motebitId, 50.0);

    const idempotencyKey = "unique-withdrawal-key";

    // First withdrawal
    const first = await relay.app.request(`/api/v1/agents/${agent.motebitId}/withdraw`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({
        amount: 20.0,
        destination: "0xMyWallet",
        idempotency_key: idempotencyKey,
      }),
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { withdrawal: { withdrawal_id: string } };

    // Second withdrawal with same key
    const second = await relay.app.request(`/api/v1/agents/${agent.motebitId}/withdraw`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({
        amount: 20.0,
        destination: "0xMyWallet",
        idempotency_key: idempotencyKey,
      }),
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { withdrawal: { withdrawal_id: string } };

    // Same withdrawal_id returned
    expect(secondBody.withdrawal.withdrawal_id).toBe(firstBody.withdrawal.withdrawal_id);

    // Balance only debited once: 50 - 20 = 30
    const balance = await getBalance(relay, agent.motebitId);
    expect(balance).toBeCloseTo(30.0, 2);

    // Only one withdrawal record
    const withdrawals = relay.moteDb.db
      .prepare(
        "SELECT COUNT(*) as count FROM relay_withdrawals WHERE motebit_id = ? AND idempotency_key = ?",
      )
      .get(agent.motebitId, idempotencyKey) as { count: number };
    expect(withdrawals.count).toBe(1);

    const reconciliation = reconcileLedger(relay.moteDb.db);
    expect(reconciliation.consistent).toBe(true);
  });

  it("admin completes already-completed withdrawal — second attempt returns 404", async () => {
    const agentKp = await generateKeypair();
    const agent = await createAgent(relay, bytesToHex(agentKp.publicKey));
    await deposit(relay, agent.motebitId, 50.0);

    // Request withdrawal
    const withdrawRes = await relay.app.request(`/api/v1/agents/${agent.motebitId}/withdraw`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({
        amount: 25.0,
        destination: "0xMyWallet",
        idempotency_key: "complete-test",
      }),
    });
    expect(withdrawRes.status).toBe(200);
    const { withdrawal } = (await withdrawRes.json()) as {
      withdrawal: { withdrawal_id: string };
    };

    // Admin completes it
    const completeRes = await relay.app.request(
      `/api/v1/admin/withdrawals/${withdrawal.withdrawal_id}/complete`,
      {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ payout_reference: "stripe_tr_first" }),
      },
    );
    expect(completeRes.status).toBe(200);

    // Try to complete again — should fail (already completed, no longer pending/processing)
    const secondComplete = await relay.app.request(
      `/api/v1/admin/withdrawals/${withdrawal.withdrawal_id}/complete`,
      {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ payout_reference: "stripe_tr_second" }),
      },
    );
    expect(secondComplete.status).toBe(404);

    const reconciliation = reconcileLedger(relay.moteDb.db);
    expect(reconciliation.consistent).toBe(true);
  });

  it("admin fails already-completed withdrawal — rejected, no refund", async () => {
    const agentKp = await generateKeypair();
    const agent = await createAgent(relay, bytesToHex(agentKp.publicKey));
    await deposit(relay, agent.motebitId, 50.0);

    // Request withdrawal
    const withdrawRes = await relay.app.request(`/api/v1/agents/${agent.motebitId}/withdraw`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({
        amount: 25.0,
        destination: "0xMyWallet",
        idempotency_key: "fail-after-complete-test",
      }),
    });
    expect(withdrawRes.status).toBe(200);
    const { withdrawal } = (await withdrawRes.json()) as {
      withdrawal: { withdrawal_id: string };
    };

    const balanceAfterWithdraw = await getBalance(relay, agent.motebitId);
    expect(balanceAfterWithdraw).toBeCloseTo(25.0, 2);

    // Admin completes it
    const completeRes = await relay.app.request(
      `/api/v1/admin/withdrawals/${withdrawal.withdrawal_id}/complete`,
      {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ payout_reference: "stripe_tr_done" }),
      },
    );
    expect(completeRes.status).toBe(200);

    // Try to fail it — should be rejected (already completed)
    const failRes = await relay.app.request(
      `/api/v1/admin/withdrawals/${withdrawal.withdrawal_id}/fail`,
      {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ reason: "Oops, want to reverse it" }),
      },
    );
    // failWithdrawal checks for status IN ('pending', 'processing') — completed is excluded
    expect(failRes.status).toBe(404);

    // Balance unchanged — no refund occurred
    const finalBalance = await getBalance(relay, agent.motebitId);
    expect(finalBalance).toBeCloseTo(25.0, 2);

    const reconciliation = reconcileLedger(relay.moteDb.db);
    expect(reconciliation.consistent).toBe(true);
  });
});
