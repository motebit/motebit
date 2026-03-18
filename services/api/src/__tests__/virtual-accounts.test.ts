/**
 * Virtual accounts: deposit, balance, allocation hold, settlement credit/debit.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSyncRelay } from "../index.js";
import type { SyncRelay } from "../index.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation
import { generateKeypair, bytesToHex, signExecutionReceipt } from "@motebit/crypto";
import type { MotebitId, DeviceId } from "@motebit/sdk";

const API_TOKEN = "test-token";
const AUTH_HEADER = { Authorization: `Bearer ${API_TOKEN}` };

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

async function createIdentityAndDevice(
  relay: SyncRelay,
  pubKeyHex: string,
): Promise<{ motebitId: string; deviceId: string }> {
  const identityRes = await relay.app.request("/identity", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({ owner_id: `owner-${crypto.randomUUID()}` }),
  });
  const identity = (await identityRes.json()) as { motebit_id: string };

  const deviceRes = await relay.app.request("/device/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({
      motebit_id: identity.motebit_id,
      device_name: "Test",
      public_key: pubKeyHex,
    }),
  });
  const device = (await deviceRes.json()) as { device_id: string };

  return { motebitId: identity.motebit_id, deviceId: device.device_id };
}

async function registerAgent(
  relay: SyncRelay,
  motebitId: string,
  capabilities: string[] = ["test"],
): Promise<void> {
  await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({
      motebit_id: motebitId,
      endpoint_url: "http://localhost:9999/mcp",
      capabilities,
    }),
  });
}

async function deposit(
  relay: SyncRelay,
  motebitId: string,
  amount: number,
  reference?: string,
): Promise<{ motebit_id: string; balance: number; transaction_id: string | null }> {
  const res = await relay.app.request(`/api/v1/agents/${motebitId}/deposit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({ amount, reference }),
  });
  expect(res.status).toBe(200);
  return res.json() as Promise<{
    motebit_id: string;
    balance: number;
    transaction_id: string | null;
  }>;
}

async function getBalance(
  relay: SyncRelay,
  motebitId: string,
): Promise<{
  motebit_id: string;
  balance: number;
  currency: string;
  transactions: Array<Record<string, unknown>>;
}> {
  const res = await relay.app.request(`/api/v1/agents/${motebitId}/balance`, {
    headers: AUTH_HEADER,
  });
  expect(res.status).toBe(200);
  return res.json() as Promise<{
    motebit_id: string;
    balance: number;
    currency: string;
    transactions: Array<Record<string, unknown>>;
  }>;
}

describe("Virtual Accounts", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(() => {
    relay.close();
  });

  it("deposit creates account and credits balance", async () => {
    const keypair = await generateKeypair();
    const { motebitId } = await createIdentityAndDevice(relay, bytesToHex(keypair.publicKey));

    const result = await deposit(relay, motebitId, 10.5);
    expect(result.motebit_id).toBe(motebitId);
    expect(result.balance).toBe(10.5);
    expect(result.transaction_id).toBeDefined();
  });

  it("deposit to existing account increments balance", async () => {
    const keypair = await generateKeypair();
    const { motebitId } = await createIdentityAndDevice(relay, bytesToHex(keypair.publicKey));

    await deposit(relay, motebitId, 10);
    const result = await deposit(relay, motebitId, 5);
    expect(result.balance).toBe(15);
  });

  it("balance endpoint returns correct balance and transactions", async () => {
    const keypair = await generateKeypair();
    const { motebitId } = await createIdentityAndDevice(relay, bytesToHex(keypair.publicKey));

    await deposit(relay, motebitId, 25);
    await deposit(relay, motebitId, 10);

    const balance = await getBalance(relay, motebitId);
    expect(balance.motebit_id).toBe(motebitId);
    expect(balance.balance).toBe(35);
    expect(balance.currency).toBe("USD");
    expect(balance.transactions).toHaveLength(2);
    // Both deposit amounts present (order may vary due to same-millisecond timestamps)
    const amounts = balance.transactions.map((t) => t.amount).sort();
    expect(amounts).toEqual([10, 25]);
  });

  it("balance returns zero for unknown agent", async () => {
    const balance = await getBalance(relay, "unknown-agent");
    expect(balance.balance).toBe(0);
    expect(balance.transactions).toHaveLength(0);
  });

  it("negative deposit rejected", async () => {
    const keypair = await generateKeypair();
    const { motebitId } = await createIdentityAndDevice(relay, bytesToHex(keypair.publicKey));

    const res = await relay.app.request(`/api/v1/agents/${motebitId}/deposit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ amount: -5 }),
    });
    expect(res.status).toBe(400);
  });

  it("zero deposit rejected", async () => {
    const keypair = await generateKeypair();
    const { motebitId } = await createIdentityAndDevice(relay, bytesToHex(keypair.publicKey));

    const res = await relay.app.request(`/api/v1/agents/${motebitId}/deposit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ amount: 0 }),
    });
    expect(res.status).toBe(400);
  });

  it("double-deposit is idempotent if same reference_id", async () => {
    const keypair = await generateKeypair();
    const { motebitId } = await createIdentityAndDevice(relay, bytesToHex(keypair.publicKey));

    const ref = `ext-payment-${crypto.randomUUID()}`;
    const first = await deposit(relay, motebitId, 50, ref);
    expect(first.balance).toBe(50);
    expect(first.transaction_id).toBeDefined();

    // Second deposit with same reference — idempotent
    const second = await deposit(relay, motebitId, 50, ref);
    expect(second.balance).toBe(50); // Unchanged
    expect((second as Record<string, unknown>).idempotent).toBe(true);
  });

  it("task submission with sufficient virtual balance succeeds", async () => {
    // Set up a worker agent with a priced listing
    const workerKp = await generateKeypair();
    const { motebitId: workerId } = await createIdentityAndDevice(
      relay,
      bytesToHex(workerKp.publicKey),
    );
    await registerAgent(relay, workerId, ["test-cap"]);

    // Create a priced listing for the worker
    await relay.app.request(`/api/v1/agents/${workerId}/listing`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        capabilities: ["test-cap"],
        pricing: [{ capability: "test-cap", unit_cost: 0.1, currency: "USD", per: "task" }],
        sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
        description: "Test service",
        pay_to_address: "0x1234567890abcdef1234567890abcdef12345678",
      }),
    });

    // Set up a delegator with virtual balance
    const delegatorKp = await generateKeypair();
    const { motebitId: delegatorId } = await createIdentityAndDevice(
      relay,
      bytesToHex(delegatorKp.publicKey),
    );
    await deposit(relay, delegatorId, 1.0); // $1 — more than enough

    // Submit a task — should succeed with virtual balance (no x402)
    const taskRes = await relay.app.request(`/agent/${workerId}/task`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        prompt: "Do something",
        submitted_by: delegatorId,
        required_capabilities: ["test-cap"],
      }),
    });
    // Should not be 402 — virtual balance covers it
    expect(taskRes.status).toBe(201);

    // Verify balance was debited
    const balance = await getBalance(relay, delegatorId);
    expect(balance.balance).toBeLessThan(1.0);
  });

  it("task submission with insufficient balance returns 402", async () => {
    // Set up a worker agent with a priced listing
    const workerKp = await generateKeypair();
    const { motebitId: workerId } = await createIdentityAndDevice(
      relay,
      bytesToHex(workerKp.publicKey),
    );
    await registerAgent(relay, workerId, ["expensive-cap"]);

    // Create a priced listing
    await relay.app.request(`/api/v1/agents/${workerId}/listing`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        capabilities: ["expensive-cap"],
        pricing: [{ capability: "expensive-cap", unit_cost: 100, currency: "USD", per: "task" }],
        sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
        description: "Expensive service",
        pay_to_address: "0x1234567890abcdef1234567890abcdef12345678",
      }),
    });

    // Set up a delegator with insufficient balance
    const delegatorKp = await generateKeypair();
    const { motebitId: delegatorId } = await createIdentityAndDevice(
      relay,
      bytesToHex(delegatorKp.publicKey),
    );
    await deposit(relay, delegatorId, 0.01); // Way too little

    // Submit task — should return 402
    const taskRes = await relay.app.request(`/agent/${workerId}/task`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        prompt: "Do something expensive",
        submitted_by: delegatorId,
        required_capabilities: ["expensive-cap"],
      }),
    });
    expect(taskRes.status).toBe(402);
  });

  it("settlement credits worker virtual account", async () => {
    // Set up worker
    const workerKp = await generateKeypair();
    const { motebitId: workerId } = await createIdentityAndDevice(
      relay,
      bytesToHex(workerKp.publicKey),
    );
    await registerAgent(relay, workerId, ["settle-cap"]);
    await relay.app.request(`/api/v1/agents/${workerId}/listing`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        capabilities: ["settle-cap"],
        pricing: [{ capability: "settle-cap", unit_cost: 1.0, currency: "USD", per: "task" }],
        sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
        description: "Settle test",
        pay_to_address: "0x1234567890abcdef1234567890abcdef12345678",
      }),
    });

    // Set up delegator with balance
    const delegatorKp = await generateKeypair();
    const { motebitId: delegatorId } = await createIdentityAndDevice(
      relay,
      bytesToHex(delegatorKp.publicKey),
    );
    await deposit(relay, delegatorId, 5.0);

    // Submit task
    const taskRes = await relay.app.request(`/agent/${workerId}/task`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        prompt: "Settle this",
        submitted_by: delegatorId,
        required_capabilities: ["settle-cap"],
      }),
    });
    expect(taskRes.status).toBe(201);
    const taskBody = (await taskRes.json()) as { task_id: string };

    // Submit receipt (worker completes the task)
    const unsigned = {
      task_id: taskBody.task_id,
      motebit_id: workerId as unknown as MotebitId,
      device_id: "worker-device" as unknown as DeviceId,
      submitted_at: Date.now(),
      completed_at: Date.now(),
      status: "completed" as const,
      result: "Done",
      tools_used: [],
      memories_formed: 0,
      prompt_hash: "abc",
      result_hash: "def",
    };
    const receipt = await signExecutionReceipt(unsigned, workerKp.privateKey);

    const resultRes = await relay.app.request(
      `/agent/${workerId}/task/${taskBody.task_id}/result`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH_HEADER },
        body: JSON.stringify(receipt),
      },
    );
    expect(resultRes.status).toBe(200);

    // Worker should have been credited (net after platform fee)
    const workerBalance = await getBalance(relay, workerId);
    expect(workerBalance.balance).toBeGreaterThan(0);

    // Check that worker's credit transaction exists
    const creditTxn = workerBalance.transactions.find((t) => t.type === "settlement_credit");
    expect(creditTxn).toBeDefined();
    // The credit should be less than the gross (platform fee deducted)
    expect(creditTxn!.amount).toBeGreaterThan(0);
  });

  it("platform fee is captured (not credited to worker)", async () => {
    // Set up worker
    const workerKp = await generateKeypair();
    const { motebitId: workerId } = await createIdentityAndDevice(
      relay,
      bytesToHex(workerKp.publicKey),
    );
    await registerAgent(relay, workerId, ["fee-cap"]);
    await relay.app.request(`/api/v1/agents/${workerId}/listing`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        capabilities: ["fee-cap"],
        pricing: [{ capability: "fee-cap", unit_cost: 10.0, currency: "USD", per: "task" }],
        sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
        description: "Fee test",
        pay_to_address: "0x1234567890abcdef1234567890abcdef12345678",
      }),
    });

    // Set up delegator
    const delegatorKp = await generateKeypair();
    const { motebitId: delegatorId } = await createIdentityAndDevice(
      relay,
      bytesToHex(delegatorKp.publicKey),
    );
    await deposit(relay, delegatorId, 50.0);

    // Submit task
    const taskRes = await relay.app.request(`/agent/${workerId}/task`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        prompt: "Fee test",
        submitted_by: delegatorId,
        required_capabilities: ["fee-cap"],
      }),
    });
    expect(taskRes.status).toBe(201);
    const taskBody = (await taskRes.json()) as { task_id: string };

    // Submit receipt
    const unsigned = {
      task_id: taskBody.task_id,
      motebit_id: workerId as unknown as MotebitId,
      device_id: "worker-device" as unknown as DeviceId,
      submitted_at: Date.now(),
      completed_at: Date.now(),
      status: "completed" as const,
      result: "Done",
      tools_used: [],
      memories_formed: 0,
      prompt_hash: "abc",
      result_hash: "def",
    };
    const receipt = await signExecutionReceipt(unsigned, workerKp.privateKey);

    await relay.app.request(`/agent/${workerId}/task/${taskBody.task_id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify(receipt),
    });

    // Worker balance should be net (gross - 5% fee)
    const workerBalance = await getBalance(relay, workerId);
    // gross = unit_cost / (1 - 0.05) = 10 / 0.95 ~= 10.526316
    // fee = gross * 0.05, net = gross - fee
    // Worker should get the net amount (~ 10.0)
    expect(workerBalance.balance).toBeGreaterThan(0);
    // The gross amount is what was locked, the fee is not credited to anyone
    // So worker balance < gross (deducted amount from delegator)
    const delegatorBalance = await getBalance(relay, delegatorId);
    // Delegator started with 50, had gross debited
    expect(delegatorBalance.balance).toBeLessThan(50);
    // The difference between what delegator lost and what worker gained = platform fee
    const delegatorSpent = 50 - delegatorBalance.balance;
    const platformFee = delegatorSpent - workerBalance.balance;
    expect(platformFee).toBeGreaterThan(0);
  });

  it("deposit requires auth", async () => {
    const res = await relay.app.request(`/api/v1/agents/some-agent/deposit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: 10 }),
    });
    expect(res.status).toBe(401);
  });

  it("balance requires auth", async () => {
    const res = await relay.app.request(`/api/v1/agents/some-agent/balance`, {
      headers: {},
    });
    expect(res.status).toBe(401);
  });

  // --- Withdrawals ---

  it("withdrawal debits balance and creates pending withdrawal", async () => {
    const keypair = await generateKeypair();
    const { motebitId } = await createIdentityAndDevice(relay, bytesToHex(keypair.publicKey));

    await deposit(relay, motebitId, 100);

    const res = await relay.app.request(`/api/v1/agents/${motebitId}/withdraw`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ amount: 30, destination: "0xMyWallet" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { motebit_id: string; withdrawal: Record<string, unknown> };
    expect(body.withdrawal.status).toBe("pending");
    expect(body.withdrawal.amount).toBe(30);
    expect(body.withdrawal.destination).toBe("0xMyWallet");

    // Balance should be reduced
    const balance = await getBalance(relay, motebitId);
    expect(balance.balance).toBe(70);
  });

  it("withdrawal with insufficient balance returns 402", async () => {
    const keypair = await generateKeypair();
    const { motebitId } = await createIdentityAndDevice(relay, bytesToHex(keypair.publicKey));

    await deposit(relay, motebitId, 5);

    const res = await relay.app.request(`/api/v1/agents/${motebitId}/withdraw`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ amount: 50 }),
    });
    expect(res.status).toBe(402);
  });

  it("withdrawal history lists withdrawals", async () => {
    const keypair = await generateKeypair();
    const { motebitId } = await createIdentityAndDevice(relay, bytesToHex(keypair.publicKey));

    await deposit(relay, motebitId, 100);

    // Make two withdrawals
    await relay.app.request(`/api/v1/agents/${motebitId}/withdraw`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ amount: 20 }),
    });
    await relay.app.request(`/api/v1/agents/${motebitId}/withdraw`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ amount: 10 }),
    });

    const res = await relay.app.request(`/api/v1/agents/${motebitId}/withdrawals`, {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { withdrawals: Array<Record<string, unknown>> };
    expect(body.withdrawals).toHaveLength(2);
  });

  it("admin can complete a pending withdrawal", async () => {
    const keypair = await generateKeypair();
    const { motebitId } = await createIdentityAndDevice(relay, bytesToHex(keypair.publicKey));

    await deposit(relay, motebitId, 100);

    // Request withdrawal
    const withdrawRes = await relay.app.request(`/api/v1/agents/${motebitId}/withdraw`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ amount: 50 }),
    });
    const { withdrawal } = (await withdrawRes.json()) as {
      withdrawal: { withdrawal_id: string };
    };

    // Admin completes it
    const completeRes = await relay.app.request(
      `/api/v1/admin/withdrawals/${withdrawal.withdrawal_id}/complete`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH_HEADER },
        body: JSON.stringify({ payout_reference: "stripe_transfer_xyz" }),
      },
    );
    expect(completeRes.status).toBe(200);
    const body = (await completeRes.json()) as { status: string };
    expect(body.status).toBe("completed");

    // Balance should still be 50 (not refunded)
    const balance = await getBalance(relay, motebitId);
    expect(balance.balance).toBe(50);
  });

  it("admin can fail a withdrawal and refund the agent", async () => {
    const keypair = await generateKeypair();
    const { motebitId } = await createIdentityAndDevice(relay, bytesToHex(keypair.publicKey));

    await deposit(relay, motebitId, 100);

    // Request withdrawal
    const withdrawRes = await relay.app.request(`/api/v1/agents/${motebitId}/withdraw`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ amount: 40 }),
    });
    const { withdrawal } = (await withdrawRes.json()) as {
      withdrawal: { withdrawal_id: string };
    };

    // Balance is now 60
    expect((await getBalance(relay, motebitId)).balance).toBe(60);

    // Admin fails it
    const failRes = await relay.app.request(
      `/api/v1/admin/withdrawals/${withdrawal.withdrawal_id}/fail`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH_HEADER },
        body: JSON.stringify({ reason: "Payout provider rejected" }),
      },
    );
    expect(failRes.status).toBe(200);
    const body = (await failRes.json()) as { refunded: boolean };
    expect(body.refunded).toBe(true);

    // Balance should be restored to 100
    const balance = await getBalance(relay, motebitId);
    expect(balance.balance).toBe(100);
  });

  it("admin pending withdrawals endpoint lists all pending", async () => {
    const keypair = await generateKeypair();
    const { motebitId } = await createIdentityAndDevice(relay, bytesToHex(keypair.publicKey));

    await deposit(relay, motebitId, 100);
    await relay.app.request(`/api/v1/agents/${motebitId}/withdraw`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ amount: 25 }),
    });

    const res = await relay.app.request(`/api/v1/admin/withdrawals/pending`, {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      withdrawals: Array<Record<string, unknown>>;
      count: number;
    };
    expect(body.count).toBeGreaterThanOrEqual(1);
    expect(body.withdrawals.some((w) => w.motebit_id === motebitId)).toBe(true);
  });

  it("withdraw requires auth", async () => {
    const res = await relay.app.request(`/api/v1/agents/some-agent/withdraw`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: 10 }),
    });
    expect(res.status).toBe(401);
  });

  // --- Idempotency ---

  it("withdrawal with idempotency key prevents duplicate debit", async () => {
    const keypair = await generateKeypair();
    const { motebitId } = await createIdentityAndDevice(relay, bytesToHex(keypair.publicKey));

    await deposit(relay, motebitId, 100);
    const idempotencyKey = `withdraw-${crypto.randomUUID()}`;

    // First withdrawal
    const res1 = await relay.app.request(`/api/v1/agents/${motebitId}/withdraw`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ amount: 40, idempotency_key: idempotencyKey }),
    });
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { withdrawal: Record<string, unknown> };
    expect(body1.withdrawal.amount).toBe(40);

    // Second withdrawal with same key — should be idempotent
    const res2 = await relay.app.request(`/api/v1/agents/${motebitId}/withdraw`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ amount: 40, idempotency_key: idempotencyKey }),
    });
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as {
      withdrawal: Record<string, unknown>;
      idempotent?: boolean;
    };
    expect(body2.idempotent).toBe(true);
    expect(body2.withdrawal.withdrawal_id).toBe(body1.withdrawal.withdrawal_id);

    // Balance should only be debited once
    const balance = await getBalance(relay, motebitId);
    expect(balance.balance).toBe(60); // 100 - 40, not 100 - 80
  });

  it("withdrawal idempotency key via header works", async () => {
    const keypair = await generateKeypair();
    const { motebitId } = await createIdentityAndDevice(relay, bytesToHex(keypair.publicKey));

    await deposit(relay, motebitId, 100);
    const key = `hdr-${crypto.randomUUID()}`;

    await relay.app.request(`/api/v1/agents/${motebitId}/withdraw`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": key,
        ...AUTH_HEADER,
      },
      body: JSON.stringify({ amount: 25 }),
    });

    const res2 = await relay.app.request(`/api/v1/agents/${motebitId}/withdraw`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": key,
        ...AUTH_HEADER,
      },
      body: JSON.stringify({ amount: 25 }),
    });
    const body = (await res2.json()) as { idempotent?: boolean };
    expect(body.idempotent).toBe(true);

    const balance = await getBalance(relay, motebitId);
    expect(balance.balance).toBe(75);
  });

  // --- Balance model ---

  it("balance includes pending_withdrawals and pending_allocations", async () => {
    const keypair = await generateKeypair();
    const { motebitId } = await createIdentityAndDevice(relay, bytesToHex(keypair.publicKey));

    await deposit(relay, motebitId, 200);

    // Request a withdrawal (pending)
    await relay.app.request(`/api/v1/agents/${motebitId}/withdraw`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ amount: 50 }),
    });

    const balance = await getBalance(relay, motebitId);
    expect(balance.balance).toBe(150); // 200 - 50 debited
    expect((balance as Record<string, unknown>).pending_withdrawals).toBe(50);
    expect((balance as Record<string, unknown>).pending_allocations).toBeDefined();
  });
});
