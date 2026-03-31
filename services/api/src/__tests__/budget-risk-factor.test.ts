/**
 * Budget pre-allocation with risk factor: verifies that allocateBudget()
 * from @motebit/market is used for task submission (1.2× risk buffer),
 * settlement uses price_snapshot as gross amount, and surplus is released
 * back to the delegator.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSyncRelay } from "../index.js";
import type { SyncRelay } from "../index.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation
import { generateKeypair, bytesToHex, signExecutionReceipt } from "@motebit/crypto";
import { PLATFORM_FEE_RATE } from "@motebit/sdk";

const API_TOKEN = "test-token";
const AUTH_HEADER = { Authorization: `Bearer ${API_TOKEN}` };

/** Compute the gross price snapshot from a unit cost (same formula as relay). */
function grossPrice(unitCost: number): number {
  return unitCost / (1 - PLATFORM_FEE_RATE);
}

/** Compute risk-buffered lock amount, capped at available. */
function riskLock(unitCost: number, available: number, riskFactor = 1.0): number {
  const gross = grossPrice(unitCost);
  return Math.min(gross * (1 + riskFactor * 0.2), available);
}

async function createTestRelay(): Promise<SyncRelay> {
  return createSyncRelay({
    apiToken: API_TOKEN,
    enableDeviceAuth: true,
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
): Promise<{ motebit_id: string; balance: number; transaction_id: string | null }> {
  const res = await relay.app.request(`/api/v1/agents/${motebitId}/deposit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...AUTH_HEADER,
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({ amount }),
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

async function createListedWorker(
  relay: SyncRelay,
  unitCost: number,
  cap = "test-cap",
): Promise<{
  motebitId: string;
  deviceId: string;
  keypair: Awaited<ReturnType<typeof generateKeypair>>;
}> {
  const keypair = await generateKeypair();
  const pubKeyHex = bytesToHex(keypair.publicKey);
  const { motebitId, deviceId } = await createIdentityAndDevice(relay, pubKeyHex);
  await registerAgent(relay, motebitId, [cap]);

  await relay.app.request(`/api/v1/agents/${motebitId}/listing`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({
      capabilities: [cap],
      pricing: [{ capability: cap, unit_cost: unitCost, currency: "USD", per: "task" }],
      sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
      description: "Test service",
      pay_to_address: "0x1234567890abcdef1234567890abcdef12345678",
    }),
  });

  return { motebitId, deviceId, keypair };
}

async function submitTask(
  relay: SyncRelay,
  workerId: string,
  delegatorId: string,
  cap = "test-cap",
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await relay.app.request(`/agent/${workerId}/task`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...AUTH_HEADER,
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({
      prompt: "Do something",
      submitted_by: delegatorId,
      required_capabilities: [cap],
    }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

describe("Budget Pre-Allocation with Risk Factor", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(() => {
    relay.close();
  });

  it("locks 1.2× the gross price when balance is sufficient", async () => {
    const unitCost = 1.0;
    const worker = await createListedWorker(relay, unitCost);
    const delegatorKp = await generateKeypair();
    const { motebitId: delegatorId } = await createIdentityAndDevice(
      relay,
      bytesToHex(delegatorKp.publicKey),
    );

    // grossPrice(1.0) ≈ 1.0526, riskLock ≈ 1.2632
    const expectedLock = riskLock(unitCost, 2.0);
    await deposit(relay, delegatorId, 2.0);

    const { status } = await submitTask(relay, worker.motebitId, delegatorId);
    expect(status).toBe(201);

    const balance = await getBalance(relay, delegatorId);
    expect(balance.balance).toBeCloseTo(2.0 - expectedLock, 4);
  });

  it("caps lock amount at available balance when buffer exceeds it", async () => {
    const unitCost = 1.0;
    const worker = await createListedWorker(relay, unitCost);
    const delegatorKp = await generateKeypair();
    const { motebitId: delegatorId } = await createIdentityAndDevice(
      relay,
      bytesToHex(delegatorKp.publicKey),
    );

    // Deposit slightly more than gross price but less than 1.2× buffer
    // grossPrice ≈ 1.0526, full lock ≈ 1.2632, deposit 1.15
    // allocateBudget caps at available: locks 1.15 (>= grossPrice, so succeeds)
    const depositAmount = grossPrice(unitCost) + 0.1;
    await deposit(relay, delegatorId, depositAmount);

    const { status } = await submitTask(relay, worker.motebitId, delegatorId);
    expect(status).toBe(201);

    // Balance should be ~0 (depositAmount deposited - depositAmount locked)
    const balance = await getBalance(relay, delegatorId);
    expect(balance.balance).toBeCloseTo(0, 4);
  });

  it("returns 402 when balance is below gross price", async () => {
    const unitCost = 1.0;
    const worker = await createListedWorker(relay, unitCost);
    const delegatorKp = await generateKeypair();
    const { motebitId: delegatorId } = await createIdentityAndDevice(
      relay,
      bytesToHex(delegatorKp.publicKey),
    );

    // Deposit less than grossPrice ≈ 1.0526 — allocateBudget returns null
    await deposit(relay, delegatorId, grossPrice(unitCost) - 0.1);

    const { status } = await submitTask(relay, worker.motebitId, delegatorId);
    expect(status).toBe(402);
  });

  it("settlement uses price_snapshot as gross and releases surplus from risk buffer", async () => {
    const unitCost = 1.0;
    const gross = grossPrice(unitCost);
    const worker = await createListedWorker(relay, unitCost);
    const delegatorKp = await generateKeypair();
    const { motebitId: delegatorId } = await createIdentityAndDevice(
      relay,
      bytesToHex(delegatorKp.publicKey),
    );

    // Deposit enough for full 1.2× risk buffer plus some extra
    const depositAmount = 2.0;
    const expectedLock = riskLock(unitCost, depositAmount);
    await deposit(relay, delegatorId, depositAmount);

    const { status, body } = await submitTask(relay, worker.motebitId, delegatorId);
    expect(status).toBe(201);
    const taskId = body.task_id as string;

    // After allocation
    const balanceAfterAlloc = await getBalance(relay, delegatorId);
    expect(balanceAfterAlloc.balance).toBeCloseTo(depositAmount - expectedLock, 4);

    // Submit a receipt to trigger settlement
    const receipt = {
      task_id: taskId,
      relay_task_id: taskId,
      motebit_id: worker.motebitId,
      device_id: worker.deviceId,
      submitted_at: Date.now() - 1000,
      completed_at: Date.now(),
      status: "completed" as const,
      result: "Done",
      tools_used: ["test-cap"],
      memories_formed: 0,
      prompt_hash: "abc123",
      result_hash: "def456",
    };
    const signedReceipt = await signExecutionReceipt(receipt, worker.keypair.privateKey);

    const receiptRes = await relay.app.request(`/agent/${worker.motebitId}/task/${taskId}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify(signedReceipt),
    });
    expect(receiptRes.status).toBe(200);

    // Settlement uses price_snapshot (gross) as the settlement basis.
    // surplus = amount_locked - gross is released back to delegator.
    const surplus = expectedLock - gross;
    const expectedFinalBalance = depositAmount - expectedLock + surplus;
    const finalBalance = await getBalance(relay, delegatorId);
    expect(finalBalance.balance).toBeCloseTo(expectedFinalBalance, 4);
    // Verify surplus is positive (risk buffer was actually released)
    expect(surplus).toBeGreaterThan(0);

    // Verify worker got paid: gross × (1 - PLATFORM_FEE_RATE)
    const workerBalance = await getBalance(relay, worker.motebitId);
    expect(workerBalance.balance).toBeCloseTo(gross * (1 - PLATFORM_FEE_RATE), 4);
  });

  it("no surplus release when amount_locked equals grossAmount", async () => {
    const unitCost = 1.0;
    const gross = grossPrice(unitCost);
    const worker = await createListedWorker(relay, unitCost);
    const delegatorKp = await generateKeypair();
    const { motebitId: delegatorId } = await createIdentityAndDevice(
      relay,
      bytesToHex(delegatorKp.publicKey),
    );

    // Deposit exactly gross — allocateBudget caps at available (gross), no risk buffer room
    await deposit(relay, delegatorId, gross);

    const { status, body } = await submitTask(relay, worker.motebitId, delegatorId);
    expect(status).toBe(201);
    const taskId = body.task_id as string;

    // After allocation, balance ≈ 0 (locked exactly gross)
    const balanceAfterAlloc = await getBalance(relay, delegatorId);
    expect(balanceAfterAlloc.balance).toBeCloseTo(0, 4);

    // Submit receipt
    const receipt = {
      task_id: taskId,
      relay_task_id: taskId,
      motebit_id: worker.motebitId,
      device_id: worker.deviceId,
      submitted_at: Date.now() - 1000,
      completed_at: Date.now(),
      status: "completed" as const,
      result: "Done",
      tools_used: ["test-cap"],
      memories_formed: 0,
      prompt_hash: "abc123",
      result_hash: "def456",
    };
    const signedReceipt = await signExecutionReceipt(receipt, worker.keypair.privateKey);

    const receiptRes = await relay.app.request(`/agent/${worker.motebitId}/task/${taskId}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify(signedReceipt),
    });
    expect(receiptRes.status).toBe(200);

    // amount_locked (gross) == price_snapshot (gross) → no surplus release
    // Delegator balance stays ~0
    const finalBalance = await getBalance(relay, delegatorId);
    expect(finalBalance.balance).toBeCloseTo(0, 4);
  });
});
