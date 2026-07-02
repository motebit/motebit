/**
 * Virtual accounts: deposit, balance, allocation hold, settlement credit/debit.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSyncRelay } from "../index.js";
import type { SyncRelay } from "../index.js";
import { seedBalance } from "./test-helpers.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation
import {
  generateKeypair,
  bytesToHex,
  hexToBytes,
  signExecutionReceipt,
  canonicalJson,
  verify,
  fromBase64Url,
} from "@motebit/encryption";
import type { MotebitId, DeviceId } from "@motebit/sdk";

const API_TOKEN = "test-token";
const AUTH_HEADER = { Authorization: `Bearer ${API_TOKEN}` };

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
  _reference?: string,
): Promise<{ motebit_id: string; balance: number; transaction_id: string | null }> {
  const balance = seedBalance(relay, motebitId, amount);
  return { motebit_id: motebitId, balance, transaction_id: "test-seed" };
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

  afterEach(async () => {
    await relay.close();
  });

  it("deposit creates account and credits balance", async () => {
    const keypair = await generateKeypair();
    const { motebitId } = await createIdentityAndDevice(relay, bytesToHex(keypair.publicKey));

    await deposit(relay, motebitId, 10.5);
    // Read back through the ledger (not the seed helper's return) so this
    // verifies a real credit + persisted transaction row, not a tautology.
    const balance = await getBalance(relay, motebitId);
    expect(balance.motebit_id).toBe(motebitId);
    expect(balance.balance).toBe(10.5);
    expect(balance.transactions).toHaveLength(1);
    expect(balance.transactions[0]!.amount).toBe(10.5);
  });

  it("deposit to existing account increments balance", async () => {
    const keypair = await generateKeypair();
    const { motebitId } = await createIdentityAndDevice(relay, bytesToHex(keypair.publicKey));

    await deposit(relay, motebitId, 10);
    await deposit(relay, motebitId, 5);
    // Read back through the ledger — a real accumulated balance, not the
    // seed helper's own return value.
    const balance = await getBalance(relay, motebitId);
    expect(balance.balance).toBe(15);
    expect(balance.transactions).toHaveLength(2);
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

  it("balance includes sweep config when agent registered with sweep_threshold + settlement_address", async () => {
    // Sovereign-exit UX depends on surfacing the sweep relationship. The UI
    // reads these fields to render "Auto-sweep above $X → sovereign wallet"
    // beneath the operating balance. See /Users/daniel/.claude/plans/
    // polymorphic-greeting-nebula.md.
    const keypair = await generateKeypair();
    const { motebitId } = await createIdentityAndDevice(relay, bytesToHex(keypair.publicKey));
    // Valid Solana address format (base58, 32-44 chars, no 0/O/I/l). Not a
    // real onchain address — satisfies the format check in agents.ts.
    // sweep_threshold is in micro-units: 50 USD = 50_000_000 micro.
    const settlementAddress = "So11111111111111111111111111111111111111112";
    const regRes = await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        motebit_id: motebitId,
        endpoint_url: "http://localhost:9999/mcp",
        capabilities: ["test"],
        settlement_address: settlementAddress,
        sweep_threshold: 50_000_000,
      }),
    });
    expect(regRes.status).toBe(200);
    await deposit(relay, motebitId, 10);
    const balance = (await getBalance(relay, motebitId)) as unknown as {
      sweep_threshold: number | null;
      settlement_address: string | null;
    };
    expect(balance.sweep_threshold).toBe(50);
    expect(balance.settlement_address).toBe(settlementAddress);
  });

  it("balance returns null sweep fields when agent has no sweep configured", async () => {
    const keypair = await generateKeypair();
    const { motebitId } = await createIdentityAndDevice(relay, bytesToHex(keypair.publicKey));
    await deposit(relay, motebitId, 5);
    const balance = (await getBalance(relay, motebitId)) as unknown as {
      sweep_threshold: number | null;
      settlement_address: string | null;
    };
    expect(balance.sweep_threshold).toBeNull();
    expect(balance.settlement_address).toBeNull();
  });

  // Sweep-config editing — PATCH /api/v1/agents/:motebitId/sweep-config.
  // Without these, the balance readout ships without a way to configure it,
  // so the feature ships half-built.
  describe("sweep-config PATCH", () => {
    const VALID_ADDRESS = "So11111111111111111111111111111111111111112";
    const OTHER_ADDRESS = "DSwpgjMvXhtGn6BsbqmacdBPA7DSxoUeuew7gvA5Qenk";

    async function registerSimple(motebitId: string): Promise<void> {
      await relay.app.request("/api/v1/agents/register", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH_HEADER },
        body: JSON.stringify({
          motebit_id: motebitId,
          endpoint_url: "http://localhost:9999/mcp",
          capabilities: ["test"],
        }),
      });
    }

    async function patchSweep(motebitId: string, body: Record<string, unknown>): Promise<Response> {
      return relay.app.request(`/api/v1/agents/${motebitId}/sweep-config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...AUTH_HEADER },
        body: JSON.stringify(body),
      });
    }

    it("master token sets threshold and address on existing agent", async () => {
      const kp = await generateKeypair();
      const { motebitId } = await createIdentityAndDevice(relay, bytesToHex(kp.publicKey));
      await registerSimple(motebitId);

      const res = await patchSweep(motebitId, {
        sweep_threshold: 25_000_000,
        settlement_address: VALID_ADDRESS,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        sweep_threshold: number | null;
        settlement_address: string | null;
      };
      expect(body.sweep_threshold).toBe(25_000_000);
      expect(body.settlement_address).toBe(VALID_ADDRESS);
    });

    it("null threshold clears the field; address preserved", async () => {
      const kp = await generateKeypair();
      const { motebitId } = await createIdentityAndDevice(relay, bytesToHex(kp.publicKey));
      await registerSimple(motebitId);
      await patchSweep(motebitId, {
        sweep_threshold: 50_000_000,
        settlement_address: VALID_ADDRESS,
      });

      const res = await patchSweep(motebitId, { sweep_threshold: null });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        sweep_threshold: number | null;
        settlement_address: string | null;
      };
      expect(body.sweep_threshold).toBeNull();
      // Address survives — undefined ≠ null in PATCH semantics
      expect(body.settlement_address).toBe(VALID_ADDRESS);
    });

    it("updating only address preserves existing threshold", async () => {
      const kp = await generateKeypair();
      const { motebitId } = await createIdentityAndDevice(relay, bytesToHex(kp.publicKey));
      await registerSimple(motebitId);
      await patchSweep(motebitId, {
        sweep_threshold: 50_000_000,
        settlement_address: VALID_ADDRESS,
      });

      const res = await patchSweep(motebitId, { settlement_address: OTHER_ADDRESS });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        sweep_threshold: number | null;
        settlement_address: string | null;
      };
      expect(body.sweep_threshold).toBe(50_000_000);
      expect(body.settlement_address).toBe(OTHER_ADDRESS);
    });

    it("rejects negative threshold", async () => {
      const kp = await generateKeypair();
      const { motebitId } = await createIdentityAndDevice(relay, bytesToHex(kp.publicKey));
      await registerSimple(motebitId);
      const res = await patchSweep(motebitId, { sweep_threshold: -1 });
      expect(res.status).toBe(400);
    });

    it("rejects non-integer threshold", async () => {
      const kp = await generateKeypair();
      const { motebitId } = await createIdentityAndDevice(relay, bytesToHex(kp.publicKey));
      await registerSimple(motebitId);
      const res = await patchSweep(motebitId, { sweep_threshold: 1.5 });
      expect(res.status).toBe(400);
    });

    it("rejects malformed settlement_address", async () => {
      const kp = await generateKeypair();
      const { motebitId } = await createIdentityAndDevice(relay, bytesToHex(kp.publicKey));
      await registerSimple(motebitId);
      // Contains lowercase 'l' — excluded from base58
      const res = await patchSweep(motebitId, {
        settlement_address: "Wallet11111111111111111111111111111111111111",
      });
      expect(res.status).toBe(400);
    });

    it("returns 404 when agent not registered", async () => {
      const res = await patchSweep("never-registered-motebit", { sweep_threshold: 1_000_000 });
      expect(res.status).toBe(404);
    });

    it("empty body is a no-op and returns current state", async () => {
      const kp = await generateKeypair();
      const { motebitId } = await createIdentityAndDevice(relay, bytesToHex(kp.publicKey));
      await registerSimple(motebitId);
      await patchSweep(motebitId, {
        sweep_threshold: 10_000_000,
        settlement_address: VALID_ADDRESS,
      });
      const res = await patchSweep(motebitId, {});
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        sweep_threshold: number | null;
        settlement_address: string | null;
      };
      expect(body.sweep_threshold).toBe(10_000_000);
      expect(body.settlement_address).toBe(VALID_ADDRESS);
    });
  });

  // NOTE: the self-declared `POST /deposit` route was removed (treasury-drain
  // vector); its HTTP-layer tests — negative/zero-amount rejection,
  // reference-idempotent dedup, requires-auth — went with the endpoint. Balance
  // is credited only by verified server-side funding; tests seed via
  // `seedBalance`. Amount-positivity and idempotency are covered on the
  // surviving money-mutating endpoint (withdraw) in idempotency.test.ts.

  it("POST /deposit is gone — no route mints balance from a client-supplied amount", async () => {
    // Regression lock for the treasury-drain fix: re-adding a self-declared
    // deposit route (client credits its own balance, then withdraws real
    // funds) must fail this test. The route must not exist.
    const keypair = await generateKeypair();
    const { motebitId } = await createIdentityAndDevice(relay, bytesToHex(keypair.publicKey));
    const res = await relay.app.request(`/api/v1/agents/${motebitId}/deposit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER, "Idempotency-Key": "x" },
      body: JSON.stringify({ amount: 1_000_000 }),
    });
    expect(res.status).toBe(404);
    // And balance stayed zero — nothing was minted.
    const balance = await getBalance(relay, motebitId);
    expect(balance.balance).toBe(0);
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

    // Arc 3.5: self-delegation (gate-exempt) — the worker funds itself, so the
    // virtual-balance allocation path still runs end-to-end.
    await deposit(relay, workerId, 1.0); // $1 — more than enough

    // Submit a task — should succeed with virtual balance (no x402)
    const taskRes = await relay.app.request(`/agent/${workerId}/task`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...AUTH_HEADER,
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        prompt: "Do something",
        submitted_by: workerId,
        required_capabilities: ["test-cap"],
      }),
    });
    // Should not be 402 — virtual balance covers it
    expect(taskRes.status).toBe(201);

    // Verify balance was debited
    const balance = await getBalance(relay, workerId);
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
      headers: {
        "Content-Type": "application/json",
        ...AUTH_HEADER,
        "Idempotency-Key": crypto.randomUUID(),
      },
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
    // Arc 3.5: self-delegation (gate-exempt) — the worker funds itself.
    await deposit(relay, workerId, 5.0);

    // Submit task
    const taskRes = await relay.app.request(`/agent/${workerId}/task`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...AUTH_HEADER,
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        prompt: "Settle this",
        submitted_by: workerId,
        required_capabilities: ["settle-cap"],
      }),
    });
    expect(taskRes.status).toBe(201);
    const taskBody = (await taskRes.json()) as { task_id: string };

    // Submit receipt (worker completes the task)
    const unsigned = {
      task_id: taskBody.task_id,
      relay_task_id: taskBody.task_id,
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

    // Arc 3.5: self-delegation (gate-exempt) — the worker funds itself.
    await deposit(relay, workerId, 50.0);

    // Submit task
    const taskRes = await relay.app.request(`/agent/${workerId}/task`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...AUTH_HEADER,
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        prompt: "Fee test",
        submitted_by: workerId,
        required_capabilities: ["fee-cap"],
      }),
    });
    expect(taskRes.status).toBe(201);
    const taskBody = (await taskRes.json()) as { task_id: string };

    // Submit receipt
    const unsigned = {
      task_id: taskBody.task_id,
      relay_task_id: taskBody.task_id,
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
    // Self-delegation: the worker funds itself, locks gross, is credited net.
    // The platform fee is the only net outflow, so the agent's balance dropped
    // by exactly the fee (deposit - final > 0) and the fee was never credited
    // back. A settlement_credit (the net) was written.
    expect(workerBalance.balance).toBeGreaterThan(0);
    const platformFee = 50 - workerBalance.balance;
    expect(platformFee).toBeGreaterThan(0);
    const creditTxn = workerBalance.transactions.find((t) => t.type === "settlement_credit");
    expect(creditTxn).toBeDefined();
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
      headers: {
        "Content-Type": "application/json",
        ...AUTH_HEADER,
        "Idempotency-Key": crypto.randomUUID(),
      },
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
      headers: {
        "Content-Type": "application/json",
        ...AUTH_HEADER,
        "Idempotency-Key": crypto.randomUUID(),
      },
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
      headers: {
        "Content-Type": "application/json",
        ...AUTH_HEADER,
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({ amount: 20 }),
    });
    await relay.app.request(`/api/v1/agents/${motebitId}/withdraw`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...AUTH_HEADER,
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({ amount: 10 }),
    });

    const res = await relay.app.request(`/api/v1/agents/${motebitId}/withdrawals`, {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { withdrawals: Array<Record<string, unknown>> };
    expect(body.withdrawals).toHaveLength(2);
  });

  it("admin can complete a pending withdrawal with signed receipt", async () => {
    const keypair = await generateKeypair();
    const { motebitId } = await createIdentityAndDevice(relay, bytesToHex(keypair.publicKey));

    await deposit(relay, motebitId, 100);

    // Request withdrawal
    const withdrawRes = await relay.app.request(`/api/v1/agents/${motebitId}/withdraw`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...AUTH_HEADER,
        "Idempotency-Key": crypto.randomUUID(),
      },
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
    const body = (await completeRes.json()) as {
      status: string;
      relay_signature: string;
      relay_public_key: string;
    };
    expect(body.status).toBe("completed");
    expect(body.relay_signature).toBeDefined();
    expect(typeof body.relay_signature).toBe("string");
    expect(body.relay_public_key).toBeDefined();
    expect(typeof body.relay_public_key).toBe("string");

    // Verify the signature independently using the relay's public key
    const relayPubKey = hexToBytes(body.relay_public_key);
    const sig = fromBase64Url(body.relay_signature);

    // Reconstruct the signed payload — we know the fields but not completed_at,
    // so fetch the withdrawal to get the exact timestamp
    const historyRes = await relay.app.request(`/api/v1/agents/${motebitId}/withdrawals`, {
      headers: AUTH_HEADER,
    });
    const history = (await historyRes.json()) as {
      withdrawals: Array<{
        withdrawal_id: string;
        completed_at: number;
        destination: string;
        amount: number;
        currency: string;
      }>;
    };
    const completedW = history.withdrawals.find(
      (w) => w.withdrawal_id === withdrawal.withdrawal_id,
    )!;

    const receiptPayload = {
      withdrawal_id: withdrawal.withdrawal_id,
      motebit_id: motebitId,
      amount: completedW.amount,
      currency: completedW.currency,
      destination: completedW.destination,
      payout_reference: "stripe_transfer_xyz",
      completed_at: completedW.completed_at,
      relay_id: relay.relayIdentity.relayMotebitId,
    };
    const canonical = canonicalJson(receiptPayload);
    const message = new TextEncoder().encode(canonical);
    const valid = await verify(sig, message, relayPubKey);
    expect(valid).toBe(true);

    // Balance should still be 50 (not refunded)
    const balance = await getBalance(relay, motebitId);
    expect(balance.balance).toBe(50);
  });

  it("admin-complete with rail field still succeeds (proof attachment)", async () => {
    const keypair = await generateKeypair();
    const { motebitId } = await createIdentityAndDevice(relay, bytesToHex(keypair.publicKey));

    await deposit(relay, motebitId, 100);

    const withdrawRes = await relay.app.request(`/api/v1/agents/${motebitId}/withdraw`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...AUTH_HEADER,
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({ amount: 30 }),
    });
    const { withdrawal } = (await withdrawRes.json()) as {
      withdrawal: { withdrawal_id: string };
    };

    // Admin completes with rail and network fields
    const completeRes = await relay.app.request(
      `/api/v1/admin/withdrawals/${withdrawal.withdrawal_id}/complete`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH_HEADER },
        body: JSON.stringify({
          payout_reference: "0xabc123",
          rail: "x402",
          network: "eip155:84532",
        }),
      },
    );
    expect(completeRes.status).toBe(200);
    const body = (await completeRes.json()) as { status: string };
    expect(body.status).toBe("completed");
  });

  it("admin-complete with unknown rail field still succeeds", async () => {
    const keypair = await generateKeypair();
    const { motebitId } = await createIdentityAndDevice(relay, bytesToHex(keypair.publicKey));

    await deposit(relay, motebitId, 100);

    const withdrawRes = await relay.app.request(`/api/v1/agents/${motebitId}/withdraw`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...AUTH_HEADER,
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({ amount: 20 }),
    });
    const { withdrawal } = (await withdrawRes.json()) as {
      withdrawal: { withdrawal_id: string };
    };

    // Admin completes with a non-existent rail — should still complete (no proof attached)
    const completeRes = await relay.app.request(
      `/api/v1/admin/withdrawals/${withdrawal.withdrawal_id}/complete`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH_HEADER },
        body: JSON.stringify({
          payout_reference: "manual_transfer_ref",
          rail: "nonexistent",
        }),
      },
    );
    expect(completeRes.status).toBe(200);
  });

  it("withdrawal to non-wallet destination stays pending (no auto-settlement)", async () => {
    const keypair = await generateKeypair();
    const { motebitId } = await createIdentityAndDevice(relay, bytesToHex(keypair.publicKey));

    await deposit(relay, motebitId, 100);

    // Withdraw without destination — defaults to "pending"
    const withdrawRes = await relay.app.request(`/api/v1/agents/${motebitId}/withdraw`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...AUTH_HEADER,
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({ amount: 25 }),
    });
    expect(withdrawRes.status).toBe(200);
    const { withdrawal } = (await withdrawRes.json()) as {
      withdrawal: { status: string; withdrawal_id: string };
    };
    // Should stay pending — "pending" destination does not trigger x402 auto-settlement
    expect(withdrawal.status).toBe("pending");
  });

  it("withdrawal to wallet address with x402 unavailable stays pending", async () => {
    const keypair = await generateKeypair();
    const { motebitId } = await createIdentityAndDevice(relay, bytesToHex(keypair.publicKey));

    await deposit(relay, motebitId, 100);

    // Withdraw to a wallet-like address — x402 facilitator is not reachable in tests,
    // so auto-settlement will fail and fall back to manual pending
    const withdrawRes = await relay.app.request(`/api/v1/agents/${motebitId}/withdraw`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...AUTH_HEADER,
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        amount: 10,
        destination: "0x1234567890abcdef1234567890abcdef12345678",
      }),
    });
    expect(withdrawRes.status).toBe(200);
    const { withdrawal } = (await withdrawRes.json()) as {
      withdrawal: { status: string };
    };
    // x402 facilitator is not reachable in tests — isAvailable() returns false
    // or settle() fails. Either way, auto-settlement falls back to manual pending.
    expect(withdrawal.status).toBe("pending");
  });

  it("admin can fail a withdrawal and refund the agent", async () => {
    const keypair = await generateKeypair();
    const { motebitId } = await createIdentityAndDevice(relay, bytesToHex(keypair.publicKey));

    await deposit(relay, motebitId, 100);

    // Request withdrawal
    const withdrawRes = await relay.app.request(`/api/v1/agents/${motebitId}/withdraw`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...AUTH_HEADER,
        "Idempotency-Key": crypto.randomUUID(),
      },
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
      headers: {
        "Content-Type": "application/json",
        ...AUTH_HEADER,
        "Idempotency-Key": crypto.randomUUID(),
      },
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
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
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

    // First withdrawal — use idempotencyKey for both header and body
    const res1 = await relay.app.request(`/api/v1/agents/${motebitId}/withdraw`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...AUTH_HEADER,
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({ amount: 40, idempotency_key: idempotencyKey }),
    });
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { withdrawal: Record<string, unknown> };
    expect(body1.withdrawal.amount).toBe(40);

    // Second withdrawal with same key — should be idempotent (header-level replay)
    const res2 = await relay.app.request(`/api/v1/agents/${motebitId}/withdraw`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...AUTH_HEADER,
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({ amount: 40, idempotency_key: idempotencyKey }),
    });
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as {
      withdrawal: Record<string, unknown>;
    };
    // Header-level idempotency replays the exact cached response from the first call
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
    // Header-level idempotency replays the exact cached response from the first call
    const body = (await res2.json()) as { withdrawal: { withdrawal_id: string } };
    expect(body.withdrawal).toBeDefined();
    expect(body.withdrawal.withdrawal_id).toBeTruthy();

    // Balance should only be debited once (idempotent replay does not debit again)
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
      headers: {
        "Content-Type": "application/json",
        ...AUTH_HEADER,
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({ amount: 50 }),
    });

    const balance = await getBalance(relay, motebitId);
    expect(balance.balance).toBe(150); // 200 - 50 debited
    expect((balance as Record<string, unknown>).pending_withdrawals).toBe(50);
    expect((balance as Record<string, unknown>).pending_allocations).toBeDefined();
  });

  // --- Signed Withdrawal Receipts ---

  it("completed withdrawal includes relay_signature in history", async () => {
    const keypair = await generateKeypair();
    const { motebitId } = await createIdentityAndDevice(relay, bytesToHex(keypair.publicKey));

    await deposit(relay, motebitId, 100);

    const withdrawRes = await relay.app.request(`/api/v1/agents/${motebitId}/withdraw`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...AUTH_HEADER,
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({ amount: 30 }),
    });
    const { withdrawal } = (await withdrawRes.json()) as {
      withdrawal: { withdrawal_id: string };
    };

    // Complete it
    await relay.app.request(`/api/v1/admin/withdrawals/${withdrawal.withdrawal_id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ payout_reference: "tx_abc123" }),
    });

    // Fetch history — completed withdrawal should have signature
    const historyRes = await relay.app.request(`/api/v1/agents/${motebitId}/withdrawals`, {
      headers: AUTH_HEADER,
    });
    const history = (await historyRes.json()) as {
      withdrawals: Array<{
        withdrawal_id: string;
        relay_signature: string | null;
        relay_public_key: string | null;
        status: string;
      }>;
    };
    const completed = history.withdrawals.find(
      (w) => w.withdrawal_id === withdrawal.withdrawal_id,
    )!;
    expect(completed.status).toBe("completed");
    expect(completed.relay_signature).toBeTruthy();
    expect(completed.relay_public_key).toBeTruthy();
  });

  it("pending withdrawal has null relay_signature", async () => {
    const keypair = await generateKeypair();
    const { motebitId } = await createIdentityAndDevice(relay, bytesToHex(keypair.publicKey));

    await deposit(relay, motebitId, 100);

    await relay.app.request(`/api/v1/agents/${motebitId}/withdraw`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...AUTH_HEADER,
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({ amount: 20 }),
    });

    const historyRes = await relay.app.request(`/api/v1/agents/${motebitId}/withdrawals`, {
      headers: AUTH_HEADER,
    });
    const history = (await historyRes.json()) as {
      withdrawals: Array<{ relay_signature: string | null }>;
    };
    expect(history.withdrawals[0]!.relay_signature).toBeNull();
  });

  // --- Ledger Reconciliation ---

  it("reconciliation passes on consistent ledger", async () => {
    const keypair = await generateKeypair();
    const { motebitId } = await createIdentityAndDevice(relay, bytesToHex(keypair.publicKey));

    // Simple deposit
    await deposit(relay, motebitId, 100);

    const res = await relay.app.request("/api/v1/admin/reconciliation", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { consistent: boolean; errors: string[] };
    expect(body.consistent).toBe(true);
    expect(body.errors).toHaveLength(0);
  });

  it("reconciliation passes after deposit + withdrawal + completion", async () => {
    const keypair = await generateKeypair();
    const { motebitId } = await createIdentityAndDevice(relay, bytesToHex(keypair.publicKey));

    await deposit(relay, motebitId, 200);

    // Request and complete a withdrawal
    const withdrawRes = await relay.app.request(`/api/v1/agents/${motebitId}/withdraw`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...AUTH_HEADER,
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({ amount: 80 }),
    });
    const { withdrawal } = (await withdrawRes.json()) as {
      withdrawal: { withdrawal_id: string };
    };

    await relay.app.request(`/api/v1/admin/withdrawals/${withdrawal.withdrawal_id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        payout_reference: "pay_ref_1",
        rail: "x402",
        network: "eip155:84532",
      }),
    });

    const res = await relay.app.request("/api/v1/admin/reconciliation", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { consistent: boolean; errors: string[] };
    expect(body.consistent).toBe(true);
    expect(body.errors).toHaveLength(0);
  });

  it("reconciliation detects unsigned completed withdrawal", async () => {
    const keypair = await generateKeypair();
    const { motebitId } = await createIdentityAndDevice(relay, bytesToHex(keypair.publicKey));

    await deposit(relay, motebitId, 100);

    // Manually insert a completed withdrawal without a signature (simulating legacy data)
    const wId = crypto.randomUUID();
    relay.moteDb.db
      .prepare(
        `INSERT INTO relay_withdrawals
       (withdrawal_id, motebit_id, amount, currency, destination, status, payout_reference, requested_at, completed_at)
       VALUES (?, ?, 50, 'USD', 'legacy_addr', 'completed', 'old_ref', ?, ?)`,
      )
      .run(wId, motebitId, Date.now() - 10000, Date.now());

    const res = await relay.app.request("/api/v1/admin/reconciliation", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { consistent: boolean; errors: string[] };
    expect(body.consistent).toBe(false);
    expect(body.errors.some((e) => e.includes("no relay signature"))).toBe(true);
  });

  it("reconciliation detects missing debit for pending withdrawal", async () => {
    const keypair = await generateKeypair();
    const { motebitId } = await createIdentityAndDevice(relay, bytesToHex(keypair.publicKey));

    await deposit(relay, motebitId, 100);

    // Manually insert a pending withdrawal without a corresponding debit transaction
    const wId = crypto.randomUUID();
    relay.moteDb.db
      .prepare(
        `INSERT INTO relay_withdrawals
       (withdrawal_id, motebit_id, amount, currency, destination, status, requested_at)
       VALUES (?, ?, 30, 'USD', 'orphan_addr', 'pending', ?)`,
      )
      .run(wId, motebitId, Date.now());

    const res = await relay.app.request("/api/v1/admin/reconciliation", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { consistent: boolean; errors: string[] };
    expect(body.consistent).toBe(false);
    expect(body.errors.some((e) => e.includes("no matching debit transaction"))).toBe(true);
  });

  it("reconciliation passes for manual withdrawal (auto-emits manual proof)", async () => {
    const keypair = await generateKeypair();
    const { motebitId } = await createIdentityAndDevice(relay, bytesToHex(keypair.publicKey));

    await deposit(relay, motebitId, 50);

    // Request and complete a withdrawal WITHOUT specifying a rail
    // (manual off-rail payout — manual proof record emitted automatically)
    const withdrawRes = await relay.app.request(`/api/v1/agents/${motebitId}/withdraw`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...AUTH_HEADER,
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({ amount: 20 }),
    });
    const { withdrawal } = (await withdrawRes.json()) as {
      withdrawal: { withdrawal_id: string };
    };

    await relay.app.request(`/api/v1/admin/withdrawals/${withdrawal.withdrawal_id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ payout_reference: "manual_transfer_ref" }),
    });

    const res = await relay.app.request("/api/v1/admin/reconciliation", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { consistent: boolean; errors: string[] };
    // Manual completion now emits a proof record — reconciliation should pass
    expect(body.consistent).toBe(true);
    expect(body.errors).toHaveLength(0);
  });

  it("reconciliation passes when withdrawal completed with rail proof", async () => {
    const keypair = await generateKeypair();
    const { motebitId } = await createIdentityAndDevice(relay, bytesToHex(keypair.publicKey));

    await deposit(relay, motebitId, 50);

    const withdrawRes = await relay.app.request(`/api/v1/agents/${motebitId}/withdraw`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...AUTH_HEADER,
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({ amount: 15 }),
    });
    const { withdrawal } = (await withdrawRes.json()) as {
      withdrawal: { withdrawal_id: string };
    };

    // Complete WITH rail specified — proof should be persisted
    await relay.app.request(`/api/v1/admin/withdrawals/${withdrawal.withdrawal_id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        payout_reference: "0xabc123",
        rail: "x402",
        network: "eip155:84532",
      }),
    });

    const res = await relay.app.request("/api/v1/admin/reconciliation", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { consistent: boolean; errors: string[] };
    // No proof-related errors — the rail persisted the proof
    expect(body.errors.filter((e) => e.includes("settlement proof"))).toHaveLength(0);
  });

  it("reconciliation requires admin auth", async () => {
    const res = await relay.app.request("/api/v1/admin/reconciliation", {
      headers: {},
    });
    expect(res.status).toBe(401);
  });

  // Bridge webhook tests deleted in Arc 1 Commit 2 of the off-ramp arc.
  // The webhook endpoint /api/v1/bridge/webhook was the completion path
  // for async user-facing Bridge transfers; with Path 2 deleted and
  // BridgeSettlementRail.withdraw() removed at the package level, the
  // webhook can no longer carry a user-withdrawal event and was deleted.
  // Replacement coverage in `bridge-user-withdrawal-deleted.test.ts`
  // asserts: webhook endpoint returns 404; no-fallback-exists invariant;
  // refinement-#4 sibling (Path 0 unavailable → stays pending, never
  // routes to Bridge).
});
