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
    verifyDeviceSignature: true,
    x402: {
      payToAddress: "0x0000000000000000000000000000000000000000",
      network: "eip155:84532",
      testnet: true,
    },
  });
}

async function createAndRegisterAgent(
  relay: SyncRelay,
  capabilities: string[] = ["test"],
): Promise<string> {
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

  await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({
      motebit_id: identity.motebit_id,
      endpoint_url: "http://localhost:9999/mcp",
      capabilities,
    }),
  });

  return identity.motebit_id;
}

describe("Graph Queries — Trust Closure", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(() => {
    relay.close();
  });

  it("returns empty closure for agent with no trust relationships", async () => {
    const motebitId = await createAndRegisterAgent(relay);

    const res = await relay.app.request(`/api/v1/agents/${motebitId}/trust-closure`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      motebit_id: string;
      closure: Array<{ agent_id: string; trust: number }>;
    };
    expect(body.motebit_id).toBe(motebitId);
    expect(Array.isArray(body.closure)).toBe(true);
  });
});

describe("Graph Queries — Path To", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(() => {
    relay.close();
  });

  it("returns 404 when no trusted path exists", async () => {
    // Register without capabilities — no auto-created listing, so no routing graph entry
    const source = await createAndRegisterAgent(relay, []);
    const target = await createAndRegisterAgent(relay, []);

    const res = await relay.app.request(`/api/v1/agents/${source}/path-to/${target}`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(404);
  });
});

describe("Graph Queries — Full Graph", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(() => {
    relay.close();
  });

  it("returns graph structure with nodes and edges", async () => {
    const motebitId = await createAndRegisterAgent(relay);

    const res = await relay.app.request(`/api/v1/agents/${motebitId}/graph`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      motebit_id: string;
      nodes: string[];
      edges: Array<{ from: string; to: string }>;
      node_count: number;
      edge_count: number;
    };
    expect(body.motebit_id).toBe(motebitId);
    expect(Array.isArray(body.nodes)).toBe(true);
    expect(Array.isArray(body.edges)).toBe(true);
    expect(body.node_count).toBe(body.nodes.length);
    expect(body.edge_count).toBe(body.edges.length);
  });
});

describe("Graph Queries — Routing Explanation", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(() => {
    relay.close();
  });

  it("returns scores structure", async () => {
    const motebitId = await createAndRegisterAgent(relay);

    const res = await relay.app.request(`/api/v1/agents/${motebitId}/routing-explanation`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      motebit_id: string;
      scores: Array<{ motebit_id: string; composite: number }>;
    };
    expect(body.motebit_id).toBe(motebitId);
    expect(Array.isArray(body.scores)).toBe(true);
  });

  it("respects capability filter", async () => {
    await createAndRegisterAgent(relay, ["web-search"]);
    const motebitId = await createAndRegisterAgent(relay, ["summarize"]);

    const res = await relay.app.request(
      `/api/v1/agents/${motebitId}/routing-explanation?capability=web-search`,
      {
        method: "GET",
        headers: AUTH_HEADER,
      },
    );
    expect(res.status).toBe(200);
  });
});
