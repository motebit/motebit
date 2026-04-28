/**
 * Relay ↔ invocation_origin round-trip.
 *
 * Asserts the surface-determinism contract at the relay boundary:
 *   (a) unknown invocation_origin values are rejected (400),
 *   (b) accepted values are stored on the task record and returned on the
 *       polling endpoint so the submitting motebit can confirm what it asked
 *       for actually made it into the relay's economic state,
 *   (c) tasks submitted without the field retain the legacy "unknown origin"
 *       semantics (field absent on round-trip).
 *
 * The outer receipt's signature-bound `invocation_origin` is tested at the
 * agent-task-handler layer; this test covers the relay's ingest/storage
 * boundary specifically.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSyncRelay } from "../index.js";
import type { SyncRelay } from "../index.js";

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
  const res = await relay.app.request("/identity", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({ owner_id: `owner-${crypto.randomUUID()}` }),
  });
  const { motebit_id } = (await res.json()) as { motebit_id: string };
  return motebit_id;
}

async function registerCapabilities(relay: SyncRelay, motebitId: string): Promise<void> {
  await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      motebit_id: motebitId,
      endpoint_url: "http://localhost:3200/mcp",
      capabilities: ["review_pr"],
    }),
  });
}

describe("relay ↔ invocation_origin", () => {
  let relay: SyncRelay;
  let motebitId: string;

  beforeEach(async () => {
    relay = await createTestRelay();
    motebitId = await createAgent(relay);
    await registerCapabilities(relay, motebitId);
  });

  afterEach(async () => {
    await relay.close();
  });

  it("accepts user-tap and persists it on the task record", async () => {
    const res = await relay.app.request(`/agent/${motebitId}/task`, {
      method: "POST",
      headers: { ...JSON_AUTH, "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({
        prompt: "Review this PR: https://github.com/x/y/pull/1",
        required_capabilities: ["review_pr"],
        invocation_origin: "user-tap",
      }),
    });
    expect(res.status).toBe(201);
    const { task_id } = (await res.json()) as { task_id: string };

    const pollRes = await relay.app.request(`/agent/${motebitId}/task/${task_id}`, {
      headers: AUTH,
    });
    expect(pollRes.status).toBe(200);
    const poll = (await pollRes.json()) as { task: { invocation_origin?: string } };
    expect(poll.task.invocation_origin).toBe("user-tap");
  });

  it("rejects unknown invocation_origin with 400", async () => {
    const res = await relay.app.request(`/agent/${motebitId}/task`, {
      method: "POST",
      headers: { ...JSON_AUTH, "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({
        prompt: "Review this PR",
        required_capabilities: ["review_pr"],
        invocation_origin: "sneaky-origin",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("TASK_INVALID_INPUT");
    expect(body.error).toContain("invocation_origin");
  });

  it("omits invocation_origin on the task record when the field is absent (legacy)", async () => {
    const res = await relay.app.request(`/agent/${motebitId}/task`, {
      method: "POST",
      headers: { ...JSON_AUTH, "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({
        prompt: "Review this PR",
        required_capabilities: ["review_pr"],
      }),
    });
    expect(res.status).toBe(201);
    const { task_id } = (await res.json()) as { task_id: string };

    const pollRes = await relay.app.request(`/agent/${motebitId}/task/${task_id}`, {
      headers: AUTH,
    });
    const poll = (await pollRes.json()) as { task: { invocation_origin?: string } };
    expect(poll.task.invocation_origin).toBeUndefined();
  });

  it("round-trips every canonical IntentOrigin value", async () => {
    for (const origin of ["user-tap", "ai-loop", "scheduled", "agent-to-agent"] as const) {
      const res = await relay.app.request(`/agent/${motebitId}/task`, {
        method: "POST",
        headers: { ...JSON_AUTH, "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          prompt: `${origin} task`,
          required_capabilities: ["review_pr"],
          invocation_origin: origin,
        }),
      });
      expect(res.status).toBe(201);
      const { task_id } = (await res.json()) as { task_id: string };
      const pollRes = await relay.app.request(`/agent/${motebitId}/task/${task_id}`, {
        headers: AUTH,
      });
      const poll = (await pollRes.json()) as { task: { invocation_origin?: string } };
      expect(poll.task.invocation_origin).toBe(origin);
    }
  });
});
