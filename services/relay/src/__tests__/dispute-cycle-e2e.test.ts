/**
 * Dispute Cycle E2E: Proves the full dispute money path.
 *
 * settlement → hold blocks withdrawal → dispute filed → hold releases →
 * dispute resolution moves funds → winner withdraws → ledger reconciles
 *
 * This is the load-bearing test. If any step has a gap, real money is at risk.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import {
  generateKeypair,
  bytesToHex,
  signExecutionReceipt,
  signDisputeRequest,
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
} from "./test-helpers.js";

describe("Dispute Cycle E2E", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(async () => {
    await relay.close();
  });

  it("settle → hold blocks → dispute → resolve refund → delegator withdraws", async () => {
    // === SETUP ===
    const workerKp = await generateKeypair();
    const delegatorKp = await generateKeypair();
    const worker = await createAgent(relay, bytesToHex(workerKp.publicKey));
    const delegator = await createAgent(relay, bytesToHex(delegatorKp.publicKey));

    // Register worker with listing
    await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        motebit_id: worker.motebitId,
        endpoint_url: "http://localhost:3200/mcp",
        capabilities: ["web_search"],
      }),
    });
    await relay.app.request(`/api/v1/agents/${worker.motebitId}/listing`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        capabilities: ["web_search"],
        pricing: [{ capability: "web_search", unit_cost: 1.0, currency: "USD", per: "task" }],
        sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
        description: "Web search",
        pay_to_address: "0x1234567890abcdef1234567890abcdef12345678",
      }),
    });

    // === STEP 1: DEPOSIT ===
    const depositRes = await relay.app.request(`/api/v1/agents/${delegator.motebitId}/deposit`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({ amount: 10.0, reference: "dispute-test" }),
    });
    expect(depositRes.status).toBe(200);

    // === STEP 2: DELEGATE ===
    const taskRes = await relay.app.request(`/agent/${worker.motebitId}/task`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({
        prompt: "search for something",
        submitted_by: delegator.motebitId,
        required_capabilities: ["web_search"],
      }),
    });
    expect(taskRes.status).toBe(201);
    const { task_id: taskId } = (await taskRes.json()) as { task_id: string };

    // === STEP 3: RECEIPT + SETTLEMENT ===
    const enc = new TextEncoder();
    const receipt = await signExecutionReceipt(
      {
        task_id: taskId,
        relay_task_id: taskId,
        motebit_id: worker.motebitId as unknown as MotebitId,
        device_id: "svc" as unknown as DeviceId,
        submitted_at: Date.now() - 1000,
        completed_at: Date.now(),
        status: "completed" as const,
        result: "done",
        tools_used: ["web_search"],
        memories_formed: 0,
        prompt_hash: await sha256(enc.encode("search for something")),
        result_hash: await sha256(enc.encode("done")),
      },
      workerKp.privateKey,
    );

    const receiptRes = await relay.app.request(`/agent/${worker.motebitId}/task/${taskId}/result`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify(receipt),
    });
    expect(receiptRes.status).toBe(200);

    // Worker earned money
    const workerBal1 = (await (
      await relay.app.request(`/api/v1/agents/${worker.motebitId}/balance`, { headers: AUTH })
    ).json()) as { balance: number; dispute_window_hold: number; available_for_withdrawal: number };
    expect(workerBal1.balance).toBeGreaterThan(0);
    const workerEarnings = workerBal1.balance;

    // === STEP 4: DISPUTE WINDOW HOLD BLOCKS WITHDRAWAL ===
    expect(workerBal1.dispute_window_hold).toBeGreaterThan(0);
    expect(workerBal1.available_for_withdrawal).toBe(0);

    // Try to withdraw — should be blocked (402)
    const blockedWithdraw = await relay.app.request(`/api/v1/agents/${worker.motebitId}/withdraw`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({ amount: workerEarnings, destination: "pending" }),
    });
    expect(blockedWithdraw.status).toBe(402);

    // === STEP 5: FILE DISPUTE ===
    // Find the allocation
    const alloc = relay.moteDb.db
      .prepare("SELECT allocation_id FROM relay_allocations WHERE task_id = ?")
      .get(taskId) as { allocation_id: string };

    // Per spec/dispute-v1.md §4.2 the body is a signed DisputeRequest.
    // Register the delegator in agent_registry so the relay can resolve
    // their public key for signature verification, then sign + post.
    await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        motebit_id: delegator.motebitId,
        endpoint_url: "http://localhost:3201/mcp",
        capabilities: [],
        public_key: bytesToHex(delegatorKp.publicKey),
      }),
    });
    const signedRequest = await signDisputeRequest(
      {
        dispute_id: `dsp-e2e-${crypto.randomUUID()}`,
        task_id: taskId,
        allocation_id: alloc.allocation_id,
        filed_by: delegator.motebitId,
        respondent: worker.motebitId,
        category: "quality",
        description: "Work was inadequate",
        evidence_refs: ["receipt-hash"],
        filed_at: Date.now(),
      },
      delegatorKp.privateKey,
    );
    const disputeRes = await relay.app.request(
      `/api/v1/allocations/${alloc.allocation_id}/dispute`,
      {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify(signedRequest),
      },
    );
    expect(disputeRes.status).toBe(200);
    const { dispute_id: disputeId } = (await disputeRes.json()) as { dispute_id: string };

    // === STEP 6: DISPUTE HOLD RELEASES WITHDRAWAL HOLD ===
    // After dispute is filed, the dispute owns the lock. Window hold should be 0.
    const workerBal2 = (await (
      await relay.app.request(`/api/v1/agents/${worker.motebitId}/balance`, { headers: AUTH })
    ).json()) as { dispute_window_hold: number };
    expect(workerBal2.dispute_window_hold).toBe(0);

    // === STEP 7: RESOLVE DISPUTE — REFUND TO DELEGATOR ===
    const resolveRes = await relay.app.request(`/api/v1/disputes/${disputeId}/resolve`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        resolution: "upheld",
        rationale: "Evidence shows work was inadequate",
        fund_action: "refund_to_delegator",
      }),
    });
    expect(resolveRes.status).toBe(200);

    // Phase 6.2 commit-4a: spec §7.1+§7.3 require funds locked through
    // appeal window. Back-date resolved_at and trigger lazy-finalize
    // via GET /:disputeId.
    relay.moteDb.db
      .prepare("UPDATE relay_disputes SET resolved_at = ? WHERE dispute_id = ?")
      .run(Date.now() - 25 * 60 * 60 * 1000, disputeId);
    await relay.app.request(`/api/v1/disputes/${disputeId}`, { headers: AUTH });

    // Delegator should have received refund
    const delegatorBal = (await (
      await relay.app.request(`/api/v1/agents/${delegator.motebitId}/balance`, { headers: AUTH })
    ).json()) as { balance: number; transactions: Array<{ type: string; amount: number }> };

    // Check the settlement_credit from dispute refund exists
    const refundTxn = delegatorBal.transactions.find(
      (t) => t.type === "settlement_credit" && t.amount > 0,
    );
    expect(refundTxn).toBeDefined();

    // === STEP 8: DELEGATOR WITHDRAWS REFUND ===
    // Back-date to clear dispute window (the refund is a settlement_credit, so hold applies)
    relay.moteDb.db
      .prepare("UPDATE relay_settlements SET settled_at = ? WHERE task_id = ?")
      .run(Date.now() - 25 * 60 * 60 * 1000, taskId);

    const withdrawRes = await relay.app.request(`/api/v1/agents/${delegator.motebitId}/withdraw`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({ amount: delegatorBal.balance, destination: "pending" }),
    });
    expect(withdrawRes.status).toBe(200);

    // === STEP 9: RECONCILE ===
    const reconciliation = reconcileLedger(relay.moteDb.db);
    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.errors).toHaveLength(0);
  });

  it("settle → dispute → resolve split → both parties credited", async () => {
    // === SETUP (same as above) ===
    const workerKp = await generateKeypair();
    const delegatorKp = await generateKeypair();
    const worker = await createAgent(relay, bytesToHex(workerKp.publicKey));
    const delegator = await createAgent(relay, bytesToHex(delegatorKp.publicKey));

    await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        motebit_id: worker.motebitId,
        endpoint_url: "http://localhost:3200/mcp",
        capabilities: ["web_search"],
      }),
    });
    await relay.app.request(`/api/v1/agents/${worker.motebitId}/listing`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        capabilities: ["web_search"],
        pricing: [{ capability: "web_search", unit_cost: 2.0, currency: "USD", per: "task" }],
        sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
        description: "Search",
        pay_to_address: "0xabc",
      }),
    });

    await relay.app.request(`/api/v1/agents/${delegator.motebitId}/deposit`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({ amount: 10.0, reference: "split-test" }),
    });

    const taskRes = await relay.app.request(`/agent/${worker.motebitId}/task`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({
        prompt: "do work",
        submitted_by: delegator.motebitId,
        required_capabilities: ["web_search"],
      }),
    });
    expect(taskRes.status).toBe(201);
    const { task_id: taskId } = (await taskRes.json()) as { task_id: string };

    const enc = new TextEncoder();
    const receipt = await signExecutionReceipt(
      {
        task_id: taskId,
        relay_task_id: taskId,
        motebit_id: worker.motebitId as unknown as MotebitId,
        device_id: "svc" as unknown as DeviceId,
        submitted_at: Date.now() - 1000,
        completed_at: Date.now(),
        status: "completed" as const,
        result: "partial work",
        tools_used: ["web_search"],
        memories_formed: 0,
        prompt_hash: await sha256(enc.encode("do work")),
        result_hash: await sha256(enc.encode("partial work")),
      },
      workerKp.privateKey,
    );
    await relay.app.request(`/agent/${worker.motebitId}/task/${taskId}/result`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify(receipt),
    });

    // File dispute + resolve as split
    const alloc = relay.moteDb.db
      .prepare("SELECT allocation_id FROM relay_allocations WHERE task_id = ?")
      .get(taskId) as { allocation_id: string };

    await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        motebit_id: delegator.motebitId,
        endpoint_url: "http://localhost:3201/mcp",
        capabilities: [],
        public_key: bytesToHex(delegatorKp.publicKey),
      }),
    });
    const signedRequest = await signDisputeRequest(
      {
        dispute_id: `dsp-e2e-${crypto.randomUUID()}`,
        task_id: taskId,
        allocation_id: alloc.allocation_id,
        filed_by: delegator.motebitId,
        respondent: worker.motebitId,
        category: "quality",
        description: "Partial quality",
        evidence_refs: ["evidence-1"],
        filed_at: Date.now(),
      },
      delegatorKp.privateKey,
    );
    const disputeRes = await relay.app.request(
      `/api/v1/allocations/${alloc.allocation_id}/dispute`,
      {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify(signedRequest),
      },
    );
    const { dispute_id: disputeId } = (await disputeRes.json()) as { dispute_id: string };

    const resolveRes = await relay.app.request(`/api/v1/disputes/${disputeId}/resolve`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        resolution: "split",
        rationale: "Work was partially adequate",
        fund_action: "split",
        split_ratio: 0.6,
      }),
    });
    expect(resolveRes.status).toBe(200);

    // Phase 6.2 commit-4a: spec §7.1+§7.3 require funds locked through
    // appeal window. Back-date + lazy-finalize trigger.
    relay.moteDb.db
      .prepare("UPDATE relay_disputes SET resolved_at = ? WHERE dispute_id = ?")
      .run(Date.now() - 25 * 60 * 60 * 1000, disputeId);
    await relay.app.request(`/api/v1/disputes/${disputeId}`, { headers: AUTH });

    // Both parties should have settlement_credit transactions from the split
    const workerBal = (await (
      await relay.app.request(`/api/v1/agents/${worker.motebitId}/balance`, { headers: AUTH })
    ).json()) as { transactions: Array<{ type: string; amount: number; reference_id: string }> };

    const delegatorBal = (await (
      await relay.app.request(`/api/v1/agents/${delegator.motebitId}/balance`, { headers: AUTH })
    ).json()) as { transactions: Array<{ type: string; amount: number; reference_id: string }> };

    const workerSplit = workerBal.transactions.find(
      (t) => t.type === "settlement_credit" && t.reference_id === disputeId,
    );
    const delegatorSplit = delegatorBal.transactions.find(
      (t) => t.type === "settlement_credit" && t.reference_id === disputeId,
    );

    expect(workerSplit).toBeDefined();
    expect(delegatorSplit).toBeDefined();
    // Worker gets 60%, delegator gets 40%
    expect(workerSplit!.amount).toBeGreaterThan(delegatorSplit!.amount);

    // Ledger reconciles
    expect(reconcileLedger(relay.moteDb.db).consistent).toBe(true);
  });
});
