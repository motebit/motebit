import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import { AUTH_HEADER, createTestRelay } from "./test-helpers.js";

function decodeTokenPayload(token: string) {
  const payloadB64 = token.split(".")[0]!;
  const base64 = payloadB64.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (base64.length % 4)) % 4;
  const padded = base64 + "=".repeat(pad);
  const json = atob(padded);
  return JSON.parse(json);
}

let relay: SyncRelay;

beforeEach(async () => {
  relay = await createTestRelay();
});

afterEach(async () => {
  await relay.close();
});

async function createIdentity(): Promise<string> {
  const res = await relay.app.request("/identity", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({ owner_id: "owner-test" }),
  });
  const identity = (await res.json()) as { motebit_id: string };
  return identity.motebit_id;
}

describe("POST /api/v1/agents/:motebitId/proxy-token", () => {
  it("issues token for agent with zero balance", async () => {
    const motebitId = await createIdentity();
    const res = await relay.app.request(`/api/v1/agents/${motebitId}/proxy-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token: string;
      balance: number;
      balance_usd: number;
      models: string[];
      expires_at: string;
    };
    expect(body.token).toBeDefined();
    expect(body.models).toEqual([]);
  });

  it("token format is base64url.base64url (one dot)", async () => {
    const motebitId = await createIdentity();
    const res = await relay.app.request(`/api/v1/agents/${motebitId}/proxy-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    });
    const body = (await res.json()) as { token: string };
    const parts = body.token.split(".");
    expect(parts).toHaveLength(2);
    // Each part should be valid base64url (alphanumeric, -, _)
    for (const part of parts) {
      expect(part).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("token payload contains required fields", async () => {
    const motebitId = await createIdentity();
    const res = await relay.app.request(`/api/v1/agents/${motebitId}/proxy-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    });
    const body = (await res.json()) as { token: string };
    const payload = decodeTokenPayload(body.token);
    expect(payload).toHaveProperty("mid");
    expect(payload).toHaveProperty("bal");
    expect(payload).toHaveProperty("models");
    expect(payload).toHaveProperty("jti");
    expect(payload).toHaveProperty("iat");
    expect(payload).toHaveProperty("exp");
  });

  it("token expires in ~1 hour", async () => {
    const motebitId = await createIdentity();
    const res = await relay.app.request(`/api/v1/agents/${motebitId}/proxy-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    });
    const body = (await res.json()) as { token: string };
    const payload = decodeTokenPayload(body.token);
    const ttl = payload.exp - payload.iat;
    // Allow some tolerance: between 3500000 and 3700000 ms (~1 hour)
    expect(ttl).toBeGreaterThanOrEqual(3500000);
    expect(ttl).toBeLessThanOrEqual(3700000);
  });

  it("token mid matches the motebitId", async () => {
    const motebitId = await createIdentity();
    const res = await relay.app.request(`/api/v1/agents/${motebitId}/proxy-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    });
    const body = (await res.json()) as { token: string };
    const payload = decodeTokenPayload(body.token);
    expect(payload.mid).toBe(motebitId);
  });

  it("token bal matches the balance", async () => {
    const motebitId = await createIdentity();
    const res = await relay.app.request(`/api/v1/agents/${motebitId}/proxy-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    });
    const body = (await res.json()) as { token: string; balance: number };
    const payload = decodeTokenPayload(body.token);
    expect(payload.bal).toBe(body.balance);
  });
});

describe("GET /api/v1/subscriptions/:motebitId/status", () => {
  it("returns none status for new agent", async () => {
    const motebitId = await createIdentity();
    const res = await relay.app.request(`/api/v1/subscriptions/${motebitId}/status`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { subscription_status: string };
    expect(body.subscription_status).toBe("none");
  });

  it("returns correct structure with all required fields", async () => {
    const motebitId = await createIdentity();
    const res = await relay.app.request(`/api/v1/subscriptions/${motebitId}/status`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("motebit_id");
    expect(body).toHaveProperty("subscribed");
    expect(body).toHaveProperty("subscription_status");
    expect(body).toHaveProperty("balance");
    expect(body).toHaveProperty("balance_usd");
    expect(body).toHaveProperty("models");
  });

  it("returns zero balance for unfunded agent", async () => {
    const motebitId = await createIdentity();
    const res = await relay.app.request(`/api/v1/subscriptions/${motebitId}/status`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    const body = (await res.json()) as {
      balance: number;
      balance_usd: number;
    };
    expect(body.balance).toBe(0);
    expect(body.balance_usd).toBe(0);
  });

  it("returns subscribed: false when no subscription exists", async () => {
    const motebitId = await createIdentity();
    const res = await relay.app.request(`/api/v1/subscriptions/${motebitId}/status`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    const body = (await res.json()) as { subscribed: boolean };
    expect(body.subscribed).toBe(false);
  });

  it("models array is empty when balance is 0", async () => {
    const motebitId = await createIdentity();
    const res = await relay.app.request(`/api/v1/subscriptions/${motebitId}/status`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    const body = (await res.json()) as { models: string[] };
    expect(body.models).toEqual([]);
  });
});
