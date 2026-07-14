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
  seedX402PaidTask,
} from "./test-helpers.js";

// Arc 3.5: both tests are relay-custody CROSS-AGENT fund-refund disputes over
// the ONE surviving relay-custody form — the x402-PAID settlement. The gate
// requires P2P for deposit-funded paid delegation, so the tests drive the
// x402 shape: `seedX402PaidTask` seeds the exact state a successful x402-paid
// submission leaves behind (queue entry with x402_tx_hash + auto-deposit +
// locked allocation — the facilitator round-trip is the only faked step,
// since `x402TxHash` is set exclusively by the real `onAfterSettle` payment
// hook), then everything downstream is REAL and route-driven: receipt
// ingestion → signed relay settlement → dispute window hold → dispute filing
// → resolution fund movement → withdrawal → ledger reconciliation. The P2P
// trust-layer complaint form (no fund movement) is covered by
// `p2p-cycle-e2e.test.ts`. See off-ramp-as-user-action.md § "Arc 3.5".
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

    // === STEPS 1+2: x402-PAID SUBMISSION (seeded — see header) ===
    const taskId = seedX402PaidTask(relay, {
      workerId: worker.motebitId,
      delegatorId: delegator.motebitId,
      prompt: "search for something",
      unitCostUsd: 1.0,
    });

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

    // === STEP 6: HOLD PERSISTS THROUGH THE DISPUTE ===
    // The escrow hold is a UNION of (24h window open) OR (active dispute
    // references the task) — filing a dispute must NOT release the funds,
    // or the worker could withdraw mid-dispute and defeat the claw-back
    // (dispute-v1.md §7.5; the pre-2026-06 predicate had exactly that bug).
    const workerBal2 = (await (
      await relay.app.request(`/api/v1/agents/${worker.motebitId}/balance`, { headers: AUTH })
    ).json()) as { dispute_window_hold: number };
    expect(workerBal2.dispute_window_hold).toBe(workerEarnings);

    const blockedMidDispute = await relay.app.request(
      `/api/v1/agents/${worker.motebitId}/withdraw`,
      {
        method: "POST",
        headers: jsonAuthWithIdempotency(),
        body: JSON.stringify({ amount: workerEarnings, destination: "pending" }),
      },
    );
    expect(blockedMidDispute.status).toBe(402);

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

    // x402-paid submission (seeded — see header)
    const taskId = seedX402PaidTask(relay, {
      workerId: worker.motebitId,
      delegatorId: delegator.motebitId,
      prompt: "do work",
      unitCostUsd: 2.0,
    });

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

    // Post-settlement split redistributes by CLAW-BACK (dispute-v1.md §7.4,
    // the mint fix): the worker already holds the full net, so it KEEPS its
    // 60% share (no second credit — crediting it would mint money) and is
    // debited the delegator's 40%, which moves to the delegator as a
    // settlement_credit. Both legs reference the dispute.
    const workerBal = (await (
      await relay.app.request(`/api/v1/agents/${worker.motebitId}/balance`, { headers: AUTH })
    ).json()) as {
      balance: number;
      transactions: Array<{ type: string; amount: number; reference_id: string }>;
    };

    const delegatorBal = (await (
      await relay.app.request(`/api/v1/agents/${delegator.motebitId}/balance`, { headers: AUTH })
    ).json()) as {
      balance: number;
      transactions: Array<{ type: string; amount: number; reference_id: string }>;
    };

    const workerClawback = workerBal.transactions.find(
      (t) => t.type === "settlement_debit" && t.reference_id === disputeId,
    );
    const delegatorSplit = delegatorBal.transactions.find(
      (t) => t.type === "settlement_credit" && t.reference_id === disputeId,
    );

    expect(workerClawback).toBeDefined();
    expect(delegatorSplit).toBeDefined();
    // The claw-back and the refund are the same funds: one debit, one credit.
    expect(-workerClawback!.amount).toBe(delegatorSplit!.amount);
    // Worker retains 60% of the net, delegator receives 40%.
    expect(workerBal.balance).toBeGreaterThan(delegatorBal.balance);
    expect(workerBal.balance).toBeGreaterThan(0);
    expect(delegatorSplit!.amount).toBeGreaterThan(0);

    // Ledger reconciles
    expect(reconcileLedger(relay.moteDb.db).consistent).toBe(true);
  });
});
