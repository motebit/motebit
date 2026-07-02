/**
 * Idempotency Key Tests
 *
 * Proves: first request succeeds, replay returns cached, concurrent returns 409,
 * different motebit IDs with same key are independent, cleanup removes old records.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSyncRelay } from "../index.js";
import type { SyncRelay } from "../index.js";
import { seedBalance } from "./test-helpers.js";
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

/**
 * Seed balance directly through the ledger (the self-declared `POST /deposit`
 * route was removed — treasury-drain vector). Used only to fund accounts
 * before exercising the withdraw idempotency contract below.
 */
function depositFunds(relay: SyncRelay, motebitId: string, amount: number): void {
  seedBalance(relay, motebitId, amount);
}

// ── Unit tests: core idempotency functions ──────────────────────────────

describe("idempotency (unit)", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(async () => {
    await relay.close();
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

  afterEach(async () => {
    await relay.close();
  });

  // NOTE: deposit-endpoint idempotency tests were removed with the
  // self-declared `POST /deposit` route (treasury-drain vector). The shared
  // idempotency middleware they exercised is covered identically by the
  // withdraw idempotency tests below (missing-key → 400, replay → cached) and
  // the per-motebit key-scoping test at the end of this suite.

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
    depositFunds(relay, motebitId, 20.0);

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
    depositFunds(relay, motebitId, 10.0);
    depositFunds(relay, agent2, 15.0);

    // Same withdraw key, different agents — idempotency is scoped per-motebit,
    // so both proceed independently rather than the second replaying the first.
    const withdraw = (id: string, amount: number) =>
      relay.app.request(`/api/v1/agents/${id}/withdraw`, {
        method: "POST",
        headers: { ...JSON_AUTH, "Idempotency-Key": sharedKey },
        body: JSON.stringify({ amount }),
      });
    const res1 = await withdraw(motebitId, 10.0);
    expect(res1.status).toBe(200);
    const res2 = await withdraw(agent2, 15.0);
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { withdrawal: { amount: number } };
    expect(body2.withdrawal.amount).toBe(15.0); // agent 2's own request, not a replay of agent 1
  });
});
