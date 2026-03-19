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

describe("Market — Service Listings", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(() => {
    relay.close();
  });

  it("POST listing + GET listing round-trip", async () => {
    const keypair = await generateKeypair();
    const pubKeyHex = bytesToHex(keypair.publicKey);
    const { motebitId } = await createIdentityAndDevice(relay, pubKeyHex);
    await registerAgent(relay, motebitId);

    const postRes = await relay.app.request(`/api/v1/agents/${motebitId}/listing`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        capabilities: ["web-search", "summarize"],
        pricing: [{ capability: "web-search", unit_cost: 0.01, currency: "USD", per: "query" }],
        sla: { max_latency_ms: 3000, availability_guarantee: 0.995 },
        description: "Fast web search service",
      }),
    });
    expect(postRes.status).toBe(200);
    const postBody = (await postRes.json()) as { listing_id: string; updated_at: number };
    expect(postBody.listing_id).toBeDefined();
    expect(postBody.updated_at).toBeGreaterThan(0);

    const getRes = await relay.app.request(`/api/v1/agents/${motebitId}/listing`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    expect(getRes.status).toBe(200);
    const listing = (await getRes.json()) as {
      listing_id: string;
      capabilities: string[];
      description: string;
      sla: { max_latency_ms: number; availability_guarantee: number };
    };
    expect(listing.capabilities).toEqual(["web-search", "summarize"]);
    expect(listing.description).toBe("Fast web search service");
    expect(listing.sla.max_latency_ms).toBe(3000);
  });

  it("GET listing returns 404 when agent registered without capabilities", async () => {
    const keypair = await generateKeypair();
    const pubKeyHex = bytesToHex(keypair.publicKey);
    const { motebitId } = await createIdentityAndDevice(relay, pubKeyHex);
    // Register with empty capabilities — no auto-created listing
    await registerAgent(relay, motebitId, []);

    const res = await relay.app.request(`/api/v1/agents/${motebitId}/listing`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(404);
  });

  it("POST listing replaces existing listing", async () => {
    const keypair = await generateKeypair();
    const pubKeyHex = bytesToHex(keypair.publicKey);
    const { motebitId } = await createIdentityAndDevice(relay, pubKeyHex);
    await registerAgent(relay, motebitId);

    // First listing
    await relay.app.request(`/api/v1/agents/${motebitId}/listing`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ capabilities: ["old"], description: "v1" }),
    });

    // Updated listing
    await relay.app.request(`/api/v1/agents/${motebitId}/listing`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ capabilities: ["new"], description: "v2" }),
    });

    const getRes = await relay.app.request(`/api/v1/agents/${motebitId}/listing`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    const listing = (await getRes.json()) as { capabilities: string[]; description: string };
    expect(listing.capabilities).toEqual(["new"]);
    expect(listing.description).toBe("v2");
  });
});

describe("Market — Revenue", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(() => {
    relay.close();
  });

  it("GET /api/v1/market/revenue returns zeroes when no settlements", async () => {
    const res = await relay.app.request("/api/v1/market/revenue", {
      method: "GET",
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      period_days: number;
      settlement_count: number;
      total_settled: number;
      total_platform_fees: number;
      daily: unknown[];
    };
    expect(body.period_days).toBe(30);
    expect(body.settlement_count).toBe(0);
    expect(body.total_settled).toBe(0);
    expect(body.total_platform_fees).toBe(0);
    expect(body.daily).toEqual([]);
  });

  it("GET /api/v1/market/revenue respects days parameter", async () => {
    const res = await relay.app.request("/api/v1/market/revenue?days=7", {
      method: "GET",
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { period_days: number };
    expect(body.period_days).toBe(7);
  });
});

describe("Market — Candidates", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(() => {
    relay.close();
  });

  it("GET /api/v1/market/candidates returns empty when no agents registered", async () => {
    const res = await relay.app.request("/api/v1/market/candidates", {
      method: "GET",
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidates: unknown[] };
    expect(body.candidates).toEqual([]);
  });

  it("GET /api/v1/market/candidates returns registered agents with listings", async () => {
    const keypair = await generateKeypair();
    const pubKeyHex = bytesToHex(keypair.publicKey);
    const { motebitId } = await createIdentityAndDevice(relay, pubKeyHex);
    await registerAgent(relay, motebitId, ["web-search"]);

    // Create a listing
    await relay.app.request(`/api/v1/agents/${motebitId}/listing`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        capabilities: ["web-search"],
        description: "Search service",
      }),
    });

    const res = await relay.app.request("/api/v1/market/candidates?capability=web-search", {
      method: "GET",
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidates: Array<{ motebit_id: string }> };
    expect(body.candidates.length).toBeGreaterThanOrEqual(1);
    expect(body.candidates.some((c) => c.motebit_id === motebitId)).toBe(true);
  });
});

describe("Market — Settlements", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(() => {
    relay.close();
  });

  it("GET /agent/:id/settlements returns empty when no settlements", async () => {
    const keypair = await generateKeypair();
    const pubKeyHex = bytesToHex(keypair.publicKey);
    const { motebitId } = await createIdentityAndDevice(relay, pubKeyHex);
    await registerAgent(relay, motebitId);

    const res = await relay.app.request(`/agent/${motebitId}/settlements`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      motebit_id: string;
      summary: { settlement_count: number; total_settled: number };
      settlements: unknown[];
    };
    expect(body.motebit_id).toBe(motebitId);
    expect(body.summary.settlement_count).toBe(0);
    expect(body.settlements).toEqual([]);
  });
});

describe("Market — Verify Receipt", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(() => {
    relay.close();
  });

  it("POST /agent/:id/verify-receipt validates a correctly signed receipt", async () => {
    const keypair = await generateKeypair();
    const pubKeyHex = bytesToHex(keypair.publicKey);
    const { motebitId, deviceId } = await createIdentityAndDevice(relay, pubKeyHex);

    const unsigned = {
      task_id: crypto.randomUUID(),
      motebit_id: motebitId as unknown as MotebitId,
      device_id: deviceId as unknown as DeviceId,
      submitted_at: Date.now(),
      completed_at: Date.now(),
      status: "completed" as const,
      result: "done",
      tools_used: [],
      memories_formed: 0,
      prompt_hash: "abc",
      result_hash: "def",
    };
    const receipt = await signExecutionReceipt(unsigned, keypair.privateKey);

    const res = await relay.app.request(`/agent/${motebitId}/verify-receipt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(receipt),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { valid: boolean };
    expect(body.valid).toBe(true);
  });

  it("POST /agent/:id/verify-receipt rejects mismatched motebit_id", async () => {
    const keypair = await generateKeypair();
    const pubKeyHex = bytesToHex(keypair.publicKey);
    const { motebitId, deviceId } = await createIdentityAndDevice(relay, pubKeyHex);

    const unsigned = {
      task_id: crypto.randomUUID(),
      motebit_id: "wrong-id" as unknown as MotebitId,
      device_id: deviceId as unknown as DeviceId,
      submitted_at: Date.now(),
      completed_at: Date.now(),
      status: "completed" as const,
      result: "done",
      tools_used: [],
      memories_formed: 0,
      prompt_hash: "abc",
      result_hash: "def",
    };
    const receipt = await signExecutionReceipt(unsigned, keypair.privateKey);

    const res = await relay.app.request(`/agent/${motebitId}/verify-receipt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(receipt),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { valid: boolean; reason?: string };
    expect(body.valid).toBe(false);
    expect(body.reason).toBe("motebit_id mismatch");
  });

  it("POST /agent/:id/verify-receipt rejects forged signature", async () => {
    const keypair = await generateKeypair();
    const forgedKeypair = await generateKeypair();
    const pubKeyHex = bytesToHex(keypair.publicKey);
    const { motebitId, deviceId } = await createIdentityAndDevice(relay, pubKeyHex);

    const unsigned = {
      task_id: crypto.randomUUID(),
      motebit_id: motebitId as unknown as MotebitId,
      device_id: deviceId as unknown as DeviceId,
      submitted_at: Date.now(),
      completed_at: Date.now(),
      status: "completed" as const,
      result: "done",
      tools_used: [],
      memories_formed: 0,
      prompt_hash: "abc",
      result_hash: "def",
    };
    // Sign with wrong key
    const receipt = await signExecutionReceipt(unsigned, forgedKeypair.privateKey);

    const res = await relay.app.request(`/agent/${motebitId}/verify-receipt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(receipt),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { valid: boolean };
    expect(body.valid).toBe(false);
  });
});
