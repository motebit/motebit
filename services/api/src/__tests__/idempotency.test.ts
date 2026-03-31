/**
 * Idempotency Key Tests
 *
 * Proves: first request succeeds, replay returns cached, concurrent returns 409,
 * different motebit IDs with same key are independent, cleanup removes old records.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSyncRelay } from "../index.js";
import type { SyncRelay } from "../index.js";
import { checkIdempotency, completeIdempotency, cleanupIdempotencyKeys } from "../idempotency.js";

const API_TOKEN = "test-token";
const AUTH = { Authorization: `Bearer ${API_TOKEN}` };
const JSON_AUTH = { "Content-Type": "application/json", ...AUTH };

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

async function createAgent(relay: SyncRelay): Promise<string> {
  const identityRes = await relay.app.request("/identity", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({ owner_id: `owner-${crypto.randomUUID()}` }),
  });
  const { motebit_id } = (await identityRes.json()) as { motebit_id: string };
  return motebit_id;
}

async function depositFunds(
  relay: SyncRelay,
  motebitId: string,
  amount: number,
  idempotencyKey?: string,
): Promise<Response> {
  return relay.app.request(`/api/v1/agents/${motebitId}/deposit`, {
    method: "POST",
    headers: {
      ...JSON_AUTH,
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify({ amount }),
  });
}

// ── Unit tests: core idempotency functions ──────────────────────────────

describe("idempotency (unit)", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(() => {
    relay.close();
  });

  it("first request returns proceed", () => {
    const db = relay.moteDb.db;
    const result = checkIdempotency(db, "key-1", "agent-1");
    expect(result.action).toBe("proceed");
  });

  it("completed request returns replay with cached response", () => {
    const db = relay.moteDb.db;

    // First: claim the key
    const first = checkIdempotency(db, "key-2", "agent-1");
    expect(first.action).toBe("proceed");

    // Complete it
    completeIdempotency(db, "key-2", "agent-1", 200, '{"ok":true}');

    // Second: should replay
    const second = checkIdempotency(db, "key-2", "agent-1");
    expect(second.action).toBe("replay");
    if (second.action === "replay") {
      expect(second.status).toBe(200);
      expect(second.body).toBe('{"ok":true}');
    }
  });

  it("concurrent request returns conflict", () => {
    const db = relay.moteDb.db;

    // First: claim the key (still processing)
    const first = checkIdempotency(db, "key-3", "agent-1");
    expect(first.action).toBe("proceed");

    // Second: should get conflict since first is still processing
    const second = checkIdempotency(db, "key-3", "agent-1");
    expect(second.action).toBe("conflict");
  });

  it("same key different motebit IDs are independent", () => {
    const db = relay.moteDb.db;

    const first = checkIdempotency(db, "shared-key", "agent-A");
    expect(first.action).toBe("proceed");

    const second = checkIdempotency(db, "shared-key", "agent-B");
    expect(second.action).toBe("proceed");

    // Complete agent-A
    completeIdempotency(db, "shared-key", "agent-A", 200, '{"agent":"A"}');

    // Agent-A should replay, agent-B should conflict (still processing)
    const replayA = checkIdempotency(db, "shared-key", "agent-A");
    expect(replayA.action).toBe("replay");

    const conflictB = checkIdempotency(db, "shared-key", "agent-B");
    expect(conflictB.action).toBe("conflict");
  });

  it("cleanup removes old records", () => {
    const db = relay.moteDb.db;

    // Insert a record manually with old timestamp (25 hours ago)
    const oldTime = Date.now() - 25 * 60 * 60 * 1000;
    db.prepare(
      "INSERT INTO relay_idempotency_keys (idempotency_key, motebit_id, status, created_at) VALUES (?, ?, 'completed', ?)",
    ).run("old-key", "agent-1", oldTime);

    // Insert a recent record
    checkIdempotency(db, "new-key", "agent-1");

    // Cleanup should remove only the old one
    const deleted = cleanupIdempotencyKeys(db);
    expect(deleted).toBe(1);

    // Old key should be gone (proceed = new)
    const result = checkIdempotency(db, "old-key", "agent-1");
    expect(result.action).toBe("proceed");

    // New key should still be there (conflict = still processing)
    const newResult = checkIdempotency(db, "new-key", "agent-1");
    expect(newResult.action).toBe("conflict");
  });
});

// ── Integration tests: HTTP endpoints ───────────────────────────────────

describe("idempotency (HTTP endpoints)", () => {
  let relay: SyncRelay;
  let motebitId: string;

  beforeEach(async () => {
    relay = await createTestRelay();
    motebitId = await createAgent(relay);
  });

  afterEach(() => {
    relay.close();
  });

  it("deposit: missing Idempotency-Key returns 400", async () => {
    const res = await relay.app.request(`/api/v1/agents/${motebitId}/deposit`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ amount: 10.0 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Idempotency-Key");
  });

  it("deposit: first request succeeds, replay returns cached response", async () => {
    const idempKey = crypto.randomUUID();

    // First request
    const res1 = await depositFunds(relay, motebitId, 10.0, idempKey);
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { balance: number; transaction_id: string };
    expect(body1.balance).toBe(10.0);
    expect(body1.transaction_id).toBeTruthy();

    // Replay with same key — should return cached response, NOT double-deposit
    const res2 = await depositFunds(relay, motebitId, 10.0, idempKey);
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { balance: number; transaction_id: string };
    // Replay should return the exact same response (balance=10, not 20)
    expect(body2.balance).toBe(body1.balance);
    expect(body2.transaction_id).toBe(body1.transaction_id);
  });

  it("deposit: different keys allow separate deposits", async () => {
    const key1 = crypto.randomUUID();
    const key2 = crypto.randomUUID();

    const res1 = await depositFunds(relay, motebitId, 5.0, key1);
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { balance: number };
    expect(body1.balance).toBe(5.0);

    const res2 = await depositFunds(relay, motebitId, 5.0, key2);
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { balance: number };
    expect(body2.balance).toBe(10.0);
  });

  it("withdraw: missing Idempotency-Key returns 400", async () => {
    const res = await relay.app.request(`/api/v1/agents/${motebitId}/withdraw`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ amount: 5.0 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Idempotency-Key");
  });

  it("withdraw: first request succeeds, replay returns cached response", async () => {
    // Fund the account first
    await depositFunds(relay, motebitId, 20.0, crypto.randomUUID());

    const withdrawKey = crypto.randomUUID();
    const withdrawRequest = (key: string) =>
      relay.app.request(`/api/v1/agents/${motebitId}/withdraw`, {
        method: "POST",
        headers: { ...JSON_AUTH, "Idempotency-Key": key },
        body: JSON.stringify({ amount: 5.0 }),
      });

    // First request
    const res1 = await withdrawRequest(withdrawKey);
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { withdrawal: { withdrawal_id: string } };
    expect(body1.withdrawal.withdrawal_id).toBeTruthy();

    // Replay — should return cached, not double-withdraw
    const res2 = await withdrawRequest(withdrawKey);
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { withdrawal: { withdrawal_id: string } };
    expect(body2.withdrawal.withdrawal_id).toBe(body1.withdrawal.withdrawal_id);
  });

  it("task submission: missing Idempotency-Key returns 400", async () => {
    // Register the agent first
    await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        motebit_id: motebitId,
        endpoint_url: "http://localhost:3200/mcp",
        capabilities: ["web_search"],
      }),
    });

    const res = await relay.app.request(`/agent/${motebitId}/task`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ prompt: "test" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Idempotency-Key");
  });

  it("task submission: replay returns cached response", async () => {
    // Register the agent
    await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        motebit_id: motebitId,
        endpoint_url: "http://localhost:3200/mcp",
        capabilities: ["web_search"],
      }),
    });

    const taskKey = crypto.randomUUID();
    const submitTask = (key: string) =>
      relay.app.request(`/agent/${motebitId}/task`, {
        method: "POST",
        headers: { ...JSON_AUTH, "Idempotency-Key": key },
        body: JSON.stringify({ prompt: "search for cats" }),
      });

    // First request
    const res1 = await submitTask(taskKey);
    expect(res1.status).toBe(201);
    const body1 = (await res1.json()) as { task_id: string; status: string };
    expect(body1.task_id).toBeTruthy();

    // Replay — should return cached
    const res2 = await submitTask(taskKey);
    expect(res2.status).toBe(201);
    const body2 = (await res2.json()) as { task_id: string; status: string };
    expect(body2.task_id).toBe(body1.task_id);
  });

  it("ledger submission: missing Idempotency-Key returns 400", async () => {
    const res = await relay.app.request(`/agent/${motebitId}/ledger`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        spec: "motebit/execution-ledger@1.0",
        motebit_id: motebitId,
        goal_id: "goal-1",
        content_hash: "abc123",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Idempotency-Key");
  });

  it("ledger submission: replay returns cached response", async () => {
    const ledgerKey = crypto.randomUUID();
    const submitLedger = (key: string) =>
      relay.app.request(`/agent/${motebitId}/ledger`, {
        method: "POST",
        headers: { ...JSON_AUTH, "Idempotency-Key": key },
        body: JSON.stringify({
          spec: "motebit/execution-ledger@1.0",
          motebit_id: motebitId,
          goal_id: "goal-1",
          content_hash: "abc123",
        }),
      });

    // First request
    const res1 = await submitLedger(ledgerKey);
    expect(res1.status).toBe(201);
    const body1 = (await res1.json()) as { ledger_id: string; content_hash: string };
    expect(body1.ledger_id).toBeTruthy();

    // Replay — should return cached
    const res2 = await submitLedger(ledgerKey);
    expect(res2.status).toBe(201);
    const body2 = (await res2.json()) as { ledger_id: string; content_hash: string };
    expect(body2.ledger_id).toBe(body1.ledger_id);
  });

  it("same idempotency key for different agents are independent", async () => {
    const agent2 = await createAgent(relay);
    const sharedKey = crypto.randomUUID();

    // Deposit to agent 1
    const res1 = await depositFunds(relay, motebitId, 10.0, sharedKey);
    expect(res1.status).toBe(200);

    // Same key, agent 2 — should proceed independently
    const res2 = await depositFunds(relay, agent2, 15.0, sharedKey);
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { balance: number };
    expect(body2.balance).toBe(15.0); // Not 10 (agent 1's amount)
  });
});
