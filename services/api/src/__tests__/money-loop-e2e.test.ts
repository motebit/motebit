/**
 * Money Loop E2E: The atomic proof of an agent economy.
 *
 * Proves the complete flow:
 *   deposit → discover → delegate → execute → receipt → settle → earn → withdraw
 *
 * Two agents on the same relay:
 *   - Delegator: has funds, needs web search done
 *   - Worker: priced service, earns from completing tasks
 *
 * After the loop completes:
 *   - Delegator's balance decreased by gross amount
 *   - Worker's balance increased by net amount (after 5% fee)
 *   - Platform fee captured
 *   - Worker can withdraw earnings with signed receipt
 *   - Ledger reconciles
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSyncRelay } from "../index.js";
import type { SyncRelay } from "../index.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation
import { generateKeypair, bytesToHex, signExecutionReceipt, hash as sha256 } from "@motebit/crypto";
import type { MotebitId, DeviceId } from "@motebit/sdk";
import { reconcileLedger } from "../accounts.js";

const API_TOKEN = "test-token";
const AUTH = { Authorization: `Bearer ${API_TOKEN}` };
const JSON_AUTH = { "Content-Type": "application/json", ...AUTH };

async function createTestRelay(): Promise<SyncRelay> {
  return createSyncRelay({
    apiToken: API_TOKEN,
    enableDeviceAuth: true,
    verifyDeviceSignature: true,
    x402: {
      payToAddress: "0x0000000000000000000000000000000000000000",
      network: "eip155:84532",
      testnet: true,
    },
  });
}

async function createAgent(
  relay: SyncRelay,
  pubKeyHex: string,
): Promise<{ motebitId: string; deviceId: string }> {
  const identityRes = await relay.app.request("/identity", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({ owner_id: `owner-${crypto.randomUUID()}` }),
  });
  const { motebit_id } = (await identityRes.json()) as { motebit_id: string };

  const deviceRes = await relay.app.request("/device/register", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({ motebit_id, device_name: "Test", public_key: pubKeyHex }),
  });
  const { device_id } = (await deviceRes.json()) as { device_id: string };

  return { motebitId: motebit_id, deviceId: device_id };
}

describe("Money Loop E2E", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(() => {
    relay.close();
  });

  it("complete money loop: deposit → delegate → receipt → settle → earn → withdraw → reconcile", async () => {
    // === SETUP: Two agents ===
    const workerKp = await generateKeypair();
    const delegatorKp = await generateKeypair();

    const worker = await createAgent(relay, bytesToHex(workerKp.publicKey));
    const delegator = await createAgent(relay, bytesToHex(delegatorKp.publicKey));

    // Register worker as a discoverable service agent
    await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        motebit_id: worker.motebitId,
        endpoint_url: "http://localhost:3200/mcp",
        capabilities: ["web_search"],
      }),
    });

    // Create a priced service listing for the worker
    const listingRes = await relay.app.request(`/api/v1/agents/${worker.motebitId}/listing`, {
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
    expect(listingRes.status).toBe(200);

    // === STEP 1: DEPOSIT — Delegator funds their account ===
    const depositRes = await relay.app.request(`/api/v1/agents/${delegator.motebitId}/deposit`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        amount: 10.0,
        reference: "initial-funding",
        description: "Fund agent for delegation",
      }),
    });
    expect(depositRes.status).toBe(200);
    const depositBody = (await depositRes.json()) as { balance: number };
    expect(depositBody.balance).toBe(10.0);

    // === STEP 2: DISCOVER — Find the worker agent ===
    const discoverRes = await relay.app.request(`/api/v1/agents/discover?capability=web_search`, {
      headers: AUTH,
    });
    expect(discoverRes.status).toBe(200);
    const discovered = (await discoverRes.json()) as {
      agents: Array<{ motebit_id: string }>;
    };
    expect(discovered.agents.some((a) => a.motebit_id === worker.motebitId)).toBe(true);

    // === STEP 3: DELEGATE — Submit a task (auto-debits delegator's balance) ===
    const taskRes = await relay.app.request(`/agent/${worker.motebitId}/task`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        prompt: "search for motebit sovereign agents",
        submitted_by: delegator.motebitId,
        required_capabilities: ["web_search"],
      }),
    });
    expect(taskRes.status).toBe(201);
    const taskBody = (await taskRes.json()) as { task_id: string };
    expect(taskBody.task_id).toBeDefined();

    // Verify delegator balance was debited (allocation hold)
    const midBalance = await relay.app.request(`/api/v1/agents/${delegator.motebitId}/balance`, {
      headers: AUTH,
    });
    const midB = (await midBalance.json()) as { balance: number };
    expect(midB.balance).toBeLessThan(10.0);
    // Funds were debited for allocation hold
    expect(10.0 - midB.balance).toBeGreaterThan(0);

    // === STEP 4: EXECUTE + RECEIPT — Worker completes and signs ===
    const enc = new TextEncoder();
    const promptHash = await sha256(enc.encode("search for motebit sovereign agents"));
    const resultHash = await sha256(
      enc.encode("Search results: motebit is a sovereign agent protocol"),
    );

    const unsignedReceipt = {
      task_id: taskBody.task_id,
      relay_task_id: taskBody.task_id,
      motebit_id: worker.motebitId as unknown as MotebitId,
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
    const signedReceipt = await signExecutionReceipt(unsignedReceipt, workerKp.privateKey);

    // === STEP 5: SETTLE — Submit receipt, relay verifies and settles ===
    const receiptRes = await relay.app.request(
      `/agent/${worker.motebitId}/task/${taskBody.task_id}/result`,
      {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify(signedReceipt),
      },
    );
    expect(receiptRes.status).toBe(200);

    // === STEP 6: VERIFY EARNINGS — Worker earned, platform took fee ===
    const workerBalance = await relay.app.request(`/api/v1/agents/${worker.motebitId}/balance`, {
      headers: AUTH,
    });
    const workerB = (await workerBalance.json()) as {
      balance: number;
      transactions: Array<{ type: string; amount: number }>;
    };

    // Worker should have earned (net after platform fee)
    expect(workerB.balance).toBeGreaterThan(0);
    const creditTxn = workerB.transactions.find((t) => t.type === "settlement_credit");
    expect(creditTxn).toBeDefined();
    expect(creditTxn!.amount).toBeGreaterThan(0);

    // Platform fee: what delegator paid - what worker earned
    const delegatorFinal = await relay.app.request(
      `/api/v1/agents/${delegator.motebitId}/balance`,
      { headers: AUTH },
    );
    const delegatorB = (await delegatorFinal.json()) as { balance: number };
    const delegatorPaid = 10.0 - delegatorB.balance;
    const platformFee = delegatorPaid - workerB.balance;
    expect(platformFee).toBeGreaterThan(0);

    // === STEP 7: WITHDRAW — Worker withdraws earnings ===
    const withdrawRes = await relay.app.request(`/api/v1/agents/${worker.motebitId}/withdraw`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        amount: workerB.balance,
        destination: "0xWorkerWallet",
        idempotency_key: "first-withdrawal",
      }),
    });
    expect(withdrawRes.status).toBe(200);
    const withdrawal = (await withdrawRes.json()) as {
      withdrawal: { withdrawal_id: string; status: string; amount: number };
    };
    expect(withdrawal.withdrawal.status).toBe("pending");
    expect(withdrawal.withdrawal.amount).toBe(workerB.balance);

    // Worker balance is now 0 (funds held for withdrawal)
    const workerAfterWithdraw = await relay.app.request(
      `/api/v1/agents/${worker.motebitId}/balance`,
      { headers: AUTH },
    );
    const workerAfterB = (await workerAfterWithdraw.json()) as { balance: number };
    expect(workerAfterB.balance).toBe(0);

    // === STEP 8: ADMIN COMPLETES — Payout confirmed with signed receipt ===
    const completeRes = await relay.app.request(
      `/api/v1/admin/withdrawals/${withdrawal.withdrawal.withdrawal_id}/complete`,
      {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ payout_reference: "stripe_tr_abc123" }),
      },
    );
    expect(completeRes.status).toBe(200);
    const completeBody = (await completeRes.json()) as {
      status: string;
      relay_signature: string;
      relay_public_key: string;
    };
    expect(completeBody.status).toBe("completed");
    expect(completeBody.relay_signature).toBeDefined();
    expect(completeBody.relay_public_key).toBeDefined();

    // === STEP 9: RECONCILE — Ledger is consistent ===
    const reconciliation = reconcileLedger(relay.moteDb.db);
    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.errors).toHaveLength(0);

    // === THE LOOP IS PROVEN ===
    // An agent deposited funds, discovered a service, delegated a task,
    // the service executed it, signed a receipt, the relay verified and
    // settled, the service earned money, withdrew it with a signed receipt,
    // and the ledger reconciles. This is an agent economy.
  });
});
