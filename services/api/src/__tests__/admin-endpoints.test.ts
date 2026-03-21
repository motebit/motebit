import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSyncRelay } from "../index.js";
import type { SyncRelay } from "../index.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation
import { generateKeypair, bytesToHex } from "@motebit/crypto";

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

async function createIdentity(relay: SyncRelay): Promise<string> {
  const keypair = await generateKeypair();
  const pubKeyHex = bytesToHex(keypair.publicKey);

  const identityRes = await relay.app.request("/identity", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({ owner_id: `owner-${crypto.randomUUID()}` }),
  });
  const identity = (await identityRes.json()) as { motebit_id: string };

  await relay.app.request("/device/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({
      motebit_id: identity.motebit_id,
      device_name: "Test",
      public_key: pubKeyHex,
    }),
  });

  return identity.motebit_id;
}

describe("Admin — Audit", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(() => {
    relay.close();
  });

  it("GET /api/v1/audit/:motebitId returns empty entries", async () => {
    const motebitId = await createIdentity(relay);

    const res = await relay.app.request(`/api/v1/audit/${motebitId}`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { motebit_id: string; entries: unknown[] };
    expect(body.motebit_id).toBe(motebitId);
    expect(Array.isArray(body.entries)).toBe(true);
  });

  it("GET /api/v1/audit/:motebitId returns 401 without auth", async () => {
    const motebitId = await createIdentity(relay);

    const res = await relay.app.request(`/api/v1/audit/${motebitId}`, {
      method: "GET",
    });
    expect(res.status).toBe(401);
  });
});

describe("Admin — Gradient", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(() => {
    relay.close();
  });

  it("GET /api/v1/gradient/:motebitId returns null current when no snapshots", async () => {
    const motebitId = await createIdentity(relay);

    const res = await relay.app.request(`/api/v1/gradient/${motebitId}`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      motebit_id: string;
      current: unknown;
      history: unknown[];
    };
    expect(body.motebit_id).toBe(motebitId);
    expect(body.current).toBeNull();
    expect(body.history).toEqual([]);
  });

  it("GET /api/v1/gradient/:motebitId respects limit parameter", async () => {
    const motebitId = await createIdentity(relay);

    const res = await relay.app.request(`/api/v1/gradient/${motebitId}?limit=5`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
  });
});

describe("Admin — Memory Delete", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(() => {
    relay.close();
  });

  it("DELETE /api/v1/memory/:motebitId/:nodeId returns 404 for nonexistent node", async () => {
    const motebitId = await createIdentity(relay);
    const nodeId = crypto.randomUUID();

    const res = await relay.app.request(`/api/v1/memory/${motebitId}/${nodeId}`, {
      method: "DELETE",
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { deleted: boolean };
    expect(body.deleted).toBe(false);
  });
});

describe("Admin — Plans", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(() => {
    relay.close();
  });

  it("GET /api/v1/plans/:motebitId returns empty when no plans", async () => {
    const motebitId = await createIdentity(relay);

    const res = await relay.app.request(`/api/v1/plans/${motebitId}`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { motebit_id: string; plans: unknown[] };
    expect(body.motebit_id).toBe(motebitId);
    expect(body.plans).toEqual([]);
  });

  it("GET /api/v1/plans/:motebitId/:planId returns 404 for nonexistent plan", async () => {
    const motebitId = await createIdentity(relay);
    const planId = crypto.randomUUID();

    const res = await relay.app.request(`/api/v1/plans/${motebitId}/${planId}`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(404);
  });
});

describe("Admin — Succession", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(() => {
    relay.close();
  });

  it("GET /api/v1/agents/:motebitId/succession returns empty chain", async () => {
    const motebitId = await createIdentity(relay);

    // Register agent first
    await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        motebit_id: motebitId,
        endpoint_url: "http://localhost:9999/mcp",
        capabilities: ["test"],
      }),
    });

    const res = await relay.app.request(`/api/v1/agents/${motebitId}/succession`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      motebit_id: string;
      chain: unknown[];
      current_public_key: string | null;
    };
    expect(body.motebit_id).toBe(motebitId);
    expect(body.chain).toEqual([]);
    expect(body.current_public_key).toBeDefined();
  });
});
