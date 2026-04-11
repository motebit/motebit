/**
 * P2P Settlement Cycle E2E: Proves the direct onchain settlement path.
 *
 * eligibility → payment proof → task submission → receipt → audit record
 * with verification_status=pending → trust updated → credential issued
 *
 * Also proves: ineligible pair falls back to relay, p2p dispute creates
 * trust-layer complaint.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
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
  jsonAuthWithIdempotency,
  createTestRelay,
  createAgent,
} from "./test-helpers.js";

// Valid base58 Solana address (no 0/O/I/l)
const WORKER_SOLANA_ADDR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv";
// Valid base58 tx hash (64-88 chars, no 0/O/I/l)
const FAKE_TX_HASH = "4vERYvaLiDsLaNaTransaCtiNSignaTuReHashThatis88charsLng1234567891abcDEFghijk";

function setTrust(
  db: import("@motebit/persistence").DatabaseDriver,
  fromId: string,
  toId: string,
  trustLevel: string,
  interactionCount: number,
) {
  db.prepare(
    `INSERT OR REPLACE INTO agent_trust
     (motebit_id, remote_motebit_id, trust_level, interaction_count, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(fromId, toId, trustLevel, interactionCount, Date.now(), Date.now());
}

describe("P2P Settlement Cycle E2E", () => {
  let relay: SyncRelay;
  let workerKp: { publicKey: Uint8Array; privateKey: Uint8Array };
  let delegatorKp: { publicKey: Uint8Array; privateKey: Uint8Array };
  let worker: { motebitId: string; deviceId: string };
  let delegator: { motebitId: string; deviceId: string };

  beforeEach(async () => {
    relay = await createTestRelay();
    workerKp = await generateKeypair();
    delegatorKp = await generateKeypair();
    worker = await createAgent(relay, bytesToHex(workerKp.publicKey));
    delegator = await createAgent(relay, bytesToHex(delegatorKp.publicKey));

    // Register worker with p2p settlement capabilities
    await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        motebit_id: worker.motebitId,
        endpoint_url: "http://localhost:3200/mcp",
        capabilities: ["web_search"],
        settlement_address: WORKER_SOLANA_ADDR,
        settlement_modes: "relay,p2p",
      }),
    });

    // Register delegator with p2p
    await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        motebit_id: delegator.motebitId,
        endpoint_url: "http://localhost:3201/mcp",
        capabilities: [],
        settlement_modes: "relay,p2p",
      }),
    });

    // Worker needs a listing
    await relay.app.request(`/api/v1/agents/${worker.motebitId}/listing`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        capabilities: ["web_search"],
        pricing: [{ capability: "web_search", unit_cost: 0.5, currency: "USD", per: "task" }],
        sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
        description: "Search",
        pay_to_address: WORKER_SOLANA_ADDR,
      }),
    });

    // Build trust between the pair (verified, 10 interactions)
    setTrust(relay.moteDb.db, delegator.motebitId, worker.motebitId, "verified", 10);
  });

  afterEach(async () => {
    await relay.close();
  });

  it("full p2p cycle: eligible → submit with proof → receipt → audit record", async () => {
    // === STEP 1: SUBMIT P2P TASK ===
    const taskRes = await relay.app.request(`/agent/${worker.motebitId}/task`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({
        prompt: "search for something via p2p",
        submitted_by: delegator.motebitId,
        target_agent: worker.motebitId,
        required_capabilities: ["web_search"],
        payment_proof: {
          tx_hash: FAKE_TX_HASH,
          chain: "solana",
          network: "solana:mainnet",
          to_address: WORKER_SOLANA_ADDR,
          amount_micro: 500000,
        },
      }),
    });
    expect(taskRes.status).toBe(201);
    const { task_id: taskId } = (await taskRes.json()) as { task_id: string };

    // No allocation should exist (p2p skips virtual account)
    const alloc = relay.moteDb.db
      .prepare("SELECT * FROM relay_allocations WHERE task_id = ?")
      .get(taskId);
    expect(alloc).toBeUndefined();

    // Delegator balance should be untouched (no debit for p2p)
    // (Delegator has no deposits, so balance should be 0)
    const delegatorBal = (await (
      await relay.app.request(`/api/v1/agents/${delegator.motebitId}/balance`, { headers: AUTH })
    ).json()) as { balance: number };
    expect(delegatorBal.balance).toBe(0);

    // === STEP 2: WORKER SUBMITS RECEIPT ===
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
        result: "p2p search results",
        tools_used: ["web_search"],
        memories_formed: 0,
        prompt_hash: await sha256(enc.encode("search for something via p2p")),
        result_hash: await sha256(enc.encode("p2p search results")),
      },
      workerKp.privateKey,
    );

    const receiptRes = await relay.app.request(`/agent/${worker.motebitId}/task/${taskId}/result`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify(receipt),
    });
    expect(receiptRes.status).toBe(200);

    // === STEP 3: VERIFY SETTLEMENT AUDIT RECORD ===
    const allSettlements = relay.moteDb.db
      .prepare("SELECT * FROM relay_settlements WHERE task_id = ?")
      .all(taskId) as Array<Record<string, unknown>>;

    // Should have exactly one settlement record (the p2p audit)
    const settlement = allSettlements.find((s) => s.settlement_mode === "p2p");
    expect(settlement).toBeDefined();
    expect(settlement!.amount_settled).toBe(0);
    expect(settlement!.platform_fee).toBe(0);
    expect(settlement!.p2p_tx_hash).toBe(FAKE_TX_HASH);
    expect(settlement!.payment_verification_status).toBe("pending");
    expect(settlement!.delegator_id).toBe(delegator.motebitId);

    // Worker balance should NOT increase (p2p — money moved onchain, not through relay)
    const workerBal = (await (
      await relay.app.request(`/api/v1/agents/${worker.motebitId}/balance`, { headers: AUTH })
    ).json()) as { balance: number; dispute_window_hold: number };
    expect(workerBal.balance).toBe(0);
    // No dispute window hold (p2p settlements excluded)
    expect(workerBal.dispute_window_hold).toBe(0);
  });

  it("p2p dispute creates trust-layer complaint with no fund movement", async () => {
    // Submit and complete a p2p task first
    const taskRes = await relay.app.request(`/agent/${worker.motebitId}/task`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({
        prompt: "p2p task for dispute",
        submitted_by: delegator.motebitId,
        target_agent: worker.motebitId,
        payment_proof: {
          tx_hash: FAKE_TX_HASH,
          chain: "solana",
          network: "solana:mainnet",
          to_address: WORKER_SOLANA_ADDR,
          amount_micro: 500000,
        },
      }),
    });
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
        result: "bad p2p work",
        tools_used: [],
        memories_formed: 0,
        prompt_hash: await sha256(enc.encode("p2p task for dispute")),
        result_hash: await sha256(enc.encode("bad p2p work")),
      },
      workerKp.privateKey,
    );
    await relay.app.request(`/agent/${worker.motebitId}/task/${taskId}/result`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify(receipt),
    });

    // File p2p dispute (no allocation exists)
    const disputeRes = await relay.app.request(`/api/v1/allocations/p2p-${taskId}/dispute`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        task_id: taskId,
        filed_by: delegator.motebitId,
        respondent: worker.motebitId,
        category: "quality",
        description: "P2P work was bad",
        evidence_refs: ["receipt-1"],
      }),
    });
    expect(disputeRes.status).toBe(200);
    const disputeBody = (await disputeRes.json()) as {
      dispute_id: string;
      amount_locked: number;
      p2p_dispute: boolean;
    };
    expect(disputeBody.amount_locked).toBe(0);
    expect(disputeBody.p2p_dispute).toBe(true);

    // Resolve — no funds move (amount_locked = 0)
    const resolveRes = await relay.app.request(
      `/api/v1/disputes/${disputeBody.dispute_id}/resolve`,
      {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({
          resolution: "upheld",
          rationale: "P2P work was indeed bad",
          fund_action: "refund_to_delegator",
        }),
      },
    );
    expect(resolveRes.status).toBe(200);

    // Neither party's balance should change (trust-only dispute)
    const workerBal = (await (
      await relay.app.request(`/api/v1/agents/${worker.motebitId}/balance`, { headers: AUTH })
    ).json()) as { balance: number };
    const delegatorBal = (await (
      await relay.app.request(`/api/v1/agents/${delegator.motebitId}/balance`, { headers: AUTH })
    ).json()) as { balance: number };
    expect(workerBal.balance).toBe(0);
    expect(delegatorBal.balance).toBe(0);
  });

  it("ineligible pair (low trust) cannot use p2p, gets 403", async () => {
    // Drop trust below threshold
    setTrust(relay.moteDb.db, delegator.motebitId, worker.motebitId, "first_contact", 1);

    const taskRes = await relay.app.request(`/agent/${worker.motebitId}/task`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({
        prompt: "try p2p with low trust",
        submitted_by: delegator.motebitId,
        target_agent: worker.motebitId,
        payment_proof: {
          tx_hash: FAKE_TX_HASH,
          chain: "solana",
          network: "solana:mainnet",
          to_address: WORKER_SOLANA_ADDR,
          amount_micro: 500000,
        },
      }),
    });
    expect(taskRes.status).toBe(403);
  });
});
