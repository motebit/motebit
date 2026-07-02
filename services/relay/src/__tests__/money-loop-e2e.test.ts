/**
 * Money Loop E2E: the relay-custody money machinery, end-to-end.
 *
 * Arc 3.5 closes deposit-funded relay-custody for paid CROSS-AGENT delegation —
 * that path now settles P2P (delegator pays the worker onchain; see
 * `p2p-cycle-e2e.test.ts` for the cross-agent earn flow). But the relay-custody
 * money machinery itself — deposit → allocate → settle → platform fee →
 * withdraw → reconcile — still runs for the surviving relay-custody paths
 * (self-delegation, x402, multi-hop). This test exercises that machinery
 * end-to-end via **self-delegation** (`submitted_by === worker`, a gate-exempt
 * same-party flow): one agent funds itself, delegates to itself, the relay
 * settles (taking the 5% fee), and the agent withdraws — the ledger reconciles
 * throughout.
 *
 * Coverage split after Arc 3.5:
 *   - cross-agent paid earn flow → `p2p-cycle-e2e.test.ts` (P2P, onchain)
 *   - allocation / credit / withdraw primitives → `virtual-accounts.test.ts` (unit)
 *   - this file → the relay-custody integration loop survives via self-delegation
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

describe("Money Loop E2E", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(async () => {
    await relay.close();
  });

  it("relay-custody money loop (self-delegation): deposit → settle → fee → withdraw → reconcile", async () => {
    // === SETUP: one agent that delegates to itself ===
    const kp = await generateKeypair();
    const agent = await createAgent(relay, bytesToHex(kp.publicKey));

    // Register as a priced service (it will delegate to itself).
    await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        motebit_id: agent.motebitId,
        endpoint_url: "http://localhost:3200/mcp",
        capabilities: ["web_search"],
      }),
    });
    const listingRes = await relay.app.request(`/api/v1/agents/${agent.motebitId}/listing`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        capabilities: ["web_search"],
        pricing: [{ capability: "web_search", unit_cost: 1.0, currency: "USD", per: "task" }],
        sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
        description: "Self-service web search",
        pay_to_address: "0x1234567890abcdef1234567890abcdef12345678",
      }),
    });
    expect(listingRes.status).toBe(200);

    // === STEP 1: DEPOSIT ===
    const seededBalance = seedBalance(relay, agent.motebitId, 10.0);
    expect(seededBalance).toBe(10.0);

    // === STEP 2: SELF-DELEGATE — submitted_by === worker → gate-exempt, relay settles ===
    const taskRes = await relay.app.request(`/agent/${agent.motebitId}/task`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({
        prompt: "self-delegated search",
        submitted_by: agent.motebitId,
        required_capabilities: ["web_search"],
      }),
    });
    expect(taskRes.status).toBe(201);
    const { task_id } = (await taskRes.json()) as { task_id: string };

    // Allocation locked → balance dropped below the deposit (gross hold).
    const midB = (await (
      await relay.app.request(`/api/v1/agents/${agent.motebitId}/balance`, { headers: AUTH })
    ).json()) as { balance: number };
    expect(midB.balance).toBeLessThan(10.0);

    // === STEP 3: RECEIPT + SETTLE ===
    const enc = new TextEncoder();
    const signedReceipt = await signExecutionReceipt(
      {
        task_id,
        relay_task_id: task_id,
        motebit_id: agent.motebitId as unknown as MotebitId,
        device_id: "web-search-service" as unknown as DeviceId,
        submitted_at: Date.now() - 1000,
        completed_at: Date.now(),
        status: "completed" as const,
        result: "Search results: motebit is a sovereign agent protocol",
        tools_used: ["web_search"],
        memories_formed: 0,
        prompt_hash: await sha256(enc.encode("self-delegated search")),
        result_hash: await sha256(
          enc.encode("Search results: motebit is a sovereign agent protocol"),
        ),
      },
      kp.privateKey,
    );
    const receiptRes = await relay.app.request(`/agent/${agent.motebitId}/task/${task_id}/result`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify(signedReceipt),
    });
    expect(receiptRes.status).toBe(200);

    // === STEP 4: VERIFY MACHINERY — net credited back to the agent, only the 5% fee left the loop ===
    const afterB = (await (
      await relay.app.request(`/api/v1/agents/${agent.motebitId}/balance`, { headers: AUTH })
    ).json()) as { balance: number; transactions: Array<{ type: string; amount: number }> };
    // Self-delegation: gross was locked, net was credited back, the platform fee
    // is the only net outflow. balance = 10 - gross + net = 10 - fee (~$0.05).
    expect(afterB.balance).toBeLessThan(10.0); // fee was captured
    expect(afterB.balance).toBeGreaterThan(9.0); // only the ~5% fee left the loop
    const creditTxn = afterB.transactions.find((t) => t.type === "settlement_credit");
    expect(creditTxn).toBeDefined();
    expect(creditTxn!.amount).toBeGreaterThan(0);

    // The platform fee is non-zero (relay captured it).
    expect(10.0 - afterB.balance).toBeGreaterThan(0);

    // The relay-custody settlement records the payer in `delegator_id` so the
    // per-peer settlement-summary export can attribute it (here the payer is
    // the worker itself — self-delegation — which the projection then excludes;
    // the point is that the producer populates the column, not only P2P rows).
    const settledRow = relay.moteDb.db
      .prepare("SELECT delegator_id, settlement_mode FROM relay_settlements WHERE motebit_id = ?")
      .get(agent.motebitId) as { delegator_id: string | null; settlement_mode: string } | undefined;
    expect(settledRow?.settlement_mode).toBe("relay");
    expect(settledRow?.delegator_id).toBe(agent.motebitId);

    // === STEP 5: WITHDRAW (back-date to clear the 24h dispute-window hold) ===
    relay.moteDb.db
      .prepare("UPDATE relay_settlements SET settled_at = ? WHERE motebit_id = ?")
      .run(Date.now() - 25 * 60 * 60 * 1000, agent.motebitId);

    const withdrawRes = await relay.app.request(`/api/v1/agents/${agent.motebitId}/withdraw`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({
        amount: afterB.balance,
        destination: "0xAgentWallet",
        idempotency_key: "first-withdrawal",
      }),
    });
    expect(withdrawRes.status).toBe(200);
    const withdrawal = (await withdrawRes.json()) as {
      withdrawal: { withdrawal_id: string; status: string; amount: number };
    };
    expect(withdrawal.withdrawal.status).toBe("pending");

    // === STEP 6: ADMIN COMPLETES ===
    const completeRes = await relay.app.request(
      `/api/v1/admin/withdrawals/${withdrawal.withdrawal.withdrawal_id}/complete`,
      {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({
          payout_reference: "stripe_tr_abc123",
          rail: "x402",
          network: "eip155:84532",
        }),
      },
    );
    expect(completeRes.status).toBe(200);
    expect(((await completeRes.json()) as { status: string }).status).toBe("completed");

    // === STEP 7: RECONCILE — ledger is consistent ===
    const reconciliation = reconcileLedger(relay.moteDb.db);
    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.errors).toHaveLength(0);
  });
});
