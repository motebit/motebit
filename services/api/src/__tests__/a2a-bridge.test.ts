import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSyncRelay } from "../index.js";
import type { SyncRelay } from "../index.js";
import { generateKeypair, bytesToHex, hexPublicKeyToDidKey } from "@motebit/crypto";

// === Helpers ===

const API_TOKEN = "test-token";
const AUTH_HEADER = { Authorization: `Bearer ${API_TOKEN}` };
const MOTEBIT_ID = "test-mote";

async function createTestRelay(): Promise<SyncRelay> {
  return createSyncRelay({
    apiToken: API_TOKEN,
    x402: {
      payToAddress: "0x0000000000000000000000000000000000000000",
      network: "eip155:84532",
      testnet: true,
    },
    enableDeviceAuth: false,
  });
}

async function registerAgent(relay: SyncRelay, motebitId: string, publicKeyHex: string) {
  await relay.app.request(`/identity/${motebitId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({ motebit_id: motebitId, owner_id: "test" }),
  });
  await relay.app.request(`/device/${motebitId}/test-device`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({
      device_id: "test-device",
      motebit_id: motebitId,
      public_key: publicKeyHex,
    }),
  });
  // Register in agent_registry so A2A per-agent card can find it
  await relay.app.request(`/api/v1/agents/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({
      motebit_id: motebitId,
      endpoint_url: "http://localhost:9999/mcp",
      capabilities: ["web_search", "read_url"],
      public_key: publicKeyHex,
    }),
  });
}

// === Tests ===

describe("A2A Protocol Bridge", () => {
  let relay: SyncRelay;
  let agentPublicKeyHex: string;

  beforeEach(async () => {
    relay = await createTestRelay();
    const kp = await generateKeypair();
    agentPublicKeyHex = bytesToHex(kp.publicKey);
    await registerAgent(relay, MOTEBIT_ID, agentPublicKeyHex);
  });

  afterEach(() => {
    relay.close();
  });

  // --- /.well-known/agent.json ---

  it("GET /.well-known/agent.json returns relay-level Agent Card with x-motebit identity", async () => {
    const res = await relay.app.request("/.well-known/agent.json");
    expect(res.status).toBe(200);

    const card = (await res.json()) as Record<string, unknown>;
    expect((card.name as string).startsWith("motebit-relay-")).toBe(true);
    expect(card.url).toBeTypeOf("string");
    expect(card.version).toBeTypeOf("string");
    expect(card.capabilities).toEqual({ streaming: false, pushNotifications: false });

    // Skills
    const skills = card.skills as Array<{ id: string; name: string }>;
    expect(skills.length).toBe(3);
    expect(skills.map((s) => s.id)).toEqual(["delegate", "discover", "ap2_payment"]);

    // Security
    expect(card.securitySchemes).toEqual([
      { type: "http", scheme: "bearer", description: expect.any(String) },
    ]);

    // x-motebit extension — relay's own cryptographic identity
    const ext = card["x-motebit"] as Record<string, string>;
    expect(ext.motebit_id).toBeTypeOf("string");
    expect(ext.did).toMatch(/^did:key:z/);
    expect(ext.public_key).toMatch(/^[0-9a-f]{64}$/);
    expect(ext.spec).toBe("motebit/identity@1.0");

    // did:key should derive correctly from public_key
    const derivedDid = hexPublicKeyToDidKey(ext.public_key!);
    expect(ext.did).toBe(derivedDid);
  });

  // --- /a2a/agents/:id/agent.json ---

  it("GET /a2a/agents/:id/agent.json returns per-agent Agent Card with correct identity", async () => {
    const res = await relay.app.request(`/a2a/agents/${MOTEBIT_ID}/agent.json`);
    expect(res.status).toBe(200);

    const card = (await res.json()) as Record<string, unknown>;
    expect(card.url).toContain(MOTEBIT_ID);

    // Skills derived from registered capabilities
    const skills = card.skills as Array<{ id: string }>;
    const skillIds = skills.map((s) => s.id);
    expect(skillIds).toContain("web_search");
    expect(skillIds).toContain("read_url");

    // x-motebit extension — agent's own identity
    const ext = card["x-motebit"] as Record<string, string>;
    expect(ext.motebit_id).toBe(MOTEBIT_ID);
    expect(ext.public_key).toBe(agentPublicKeyHex);

    // did:key roundtrip — the card's DID should derive from the registered public key
    const expectedDid = hexPublicKeyToDidKey(agentPublicKeyHex);
    expect(ext.did).toBe(expectedDid);
  });

  it("GET /a2a/agents/:id/agent.json returns 404 for unknown agent", async () => {
    const res = await relay.app.request("/a2a/agents/nonexistent-agent/agent.json");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("not found");
  });

  // --- POST /a2a/agents/:id (SendMessage) ---

  it("POST /a2a/agents/:id returns 400 for empty message parts", async () => {
    const res = await relay.app.request(`/a2a/agents/${MOTEBIT_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ message: { role: "user", parts: [] } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("at least one part");
  });

  it("POST /a2a/agents/:id returns 400 for message with no extractable text", async () => {
    const res = await relay.app.request(`/a2a/agents/${MOTEBIT_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        message: { role: "user", parts: [{ text: "" }] },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("text or structuredData");
  });

  it("POST /a2a/agents/:id returns 401 without Authorization header", async () => {
    const res = await relay.app.request(`/a2a/agents/${MOTEBIT_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: { role: "user", parts: [{ text: "Hello" }] },
      }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Authorization");
  });

  it("POST /a2a/agents/:id extracts text from structuredData parts", async () => {
    const res = await relay.app.request(`/a2a/agents/${MOTEBIT_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        message: {
          role: "user",
          parts: [{ structuredData: { query: "test search" } }],
        },
      }),
    });
    // Proceeds to task submission (500 expected — fetch to internal relay fails in test env)
    // The key assertion: it didn't 400 (input was valid) or 401 (auth was accepted)
    expect(res.status).not.toBe(400);
    expect(res.status).not.toBe(401);
  });

  // --- POST /ap2/agents/:id/mandate ---

  it("POST /ap2/agents/:id/mandate returns 400 for wrong type", async () => {
    const res = await relay.app.request(`/ap2/agents/${MOTEBIT_ID}/mandate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ type: "wrong_type", intent: "test" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("intent_mandate");
  });

  it("POST /ap2/agents/:id/mandate returns 400 for missing intent", async () => {
    const res = await relay.app.request(`/ap2/agents/${MOTEBIT_ID}/mandate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ type: "intent_mandate", intent: "" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("intent");
  });

  it("POST /ap2/agents/:id/mandate returns 400 for expired TTL", async () => {
    const res = await relay.app.request(`/ap2/agents/${MOTEBIT_ID}/mandate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        type: "intent_mandate",
        intent: "Search for something",
        ttl_ms: 1000,
        timestamp: new Date(Date.now() - 60_000).toISOString(),
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("expired");
  });

  it("POST /ap2/agents/:id/mandate returns 400 for invalid timestamp with TTL", async () => {
    const res = await relay.app.request(`/ap2/agents/${MOTEBIT_ID}/mandate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        type: "intent_mandate",
        intent: "Do something",
        ttl_ms: 60_000,
        timestamp: "not-a-date",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("timestamp");
  });

  it("POST /ap2/agents/:id/mandate returns 401 without Authorization header", async () => {
    const res = await relay.app.request(`/ap2/agents/${MOTEBIT_ID}/mandate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "intent_mandate",
        intent: "Do something",
        timestamp: new Date().toISOString(),
      }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Authorization");
  });

  it("POST /ap2/agents/:id/mandate forwards valid mandate to task pipeline", async () => {
    const res = await relay.app.request(`/ap2/agents/${MOTEBIT_ID}/mandate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        type: "intent_mandate",
        intent: "Search the web for motebit",
        ttl_ms: 300_000,
        max_amount: { currency: "USDC", value: 0.5 },
        timestamp: new Date().toISOString(),
        signer: "test-user",
      }),
    });
    // In test env the internal fetch fails, so we get 500 — but input validation passed
    expect(res.status).not.toBe(400);
    expect(res.status).not.toBe(401);
  });
});
