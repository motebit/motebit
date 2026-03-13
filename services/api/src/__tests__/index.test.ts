import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createSyncRelay } from "../index.js";
import type { SyncRelay } from "../index.js";
import { EventType } from "@motebit/sdk";
import type { EventLogEntry, AgentTask, ExecutionReceipt } from "@motebit/sdk";
// eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation
import { generateKeypair, createSignedToken, signExecutionReceipt } from "@motebit/crypto";

// === Helpers ===

const API_TOKEN = "test-token";
const AUTH_HEADER = { Authorization: `Bearer ${API_TOKEN}` };
const MOTEBIT_ID = "test-mote";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function createTestRelay(overrides?: {
  enableDeviceAuth?: boolean;
  verifyDeviceSignature?: boolean;
}): Promise<SyncRelay> {
  return createSyncRelay({ apiToken: API_TOKEN, ...overrides });
}

function makeEvent(motebitId: string, clock: number): EventLogEntry {
  return {
    event_id: crypto.randomUUID(),
    motebit_id: motebitId,
    device_id: "test-device",
    timestamp: Date.now(),
    event_type: EventType.StateUpdated,
    payload: { clock },
    version_clock: clock,
    tombstoned: false,
  };
}

// === Tests ===

describe("Sync Relay", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
  });

  afterEach(() => {
    relay.close();
  });

  // --- Health ---

  it("GET /health succeeds without auth", async () => {
    const res = await relay.app.request("/health", { method: "GET" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; timestamp: number };
    expect(body.status).toBe("ok");
    expect(body.timestamp).toBeTypeOf("number");
  });

  // --- Auth ---

  it("returns 401 when no token provided on sync routes", async () => {
    const res = await relay.app.request(`/sync/${MOTEBIT_ID}/clock`, { method: "GET" });
    expect(res.status).toBe(401);
  });

  it("returns 401 when wrong token provided", async () => {
    const res = await relay.app.request(`/sync/${MOTEBIT_ID}/clock`, {
      method: "GET",
      headers: { Authorization: "Bearer wrong" },
    });
    expect(res.status).toBe(401);
  });

  // --- Sync: Push ---

  it("POST /sync/:id/push accepts events", async () => {
    const events = [makeEvent(MOTEBIT_ID, 1), makeEvent(MOTEBIT_ID, 2)];
    const res = await relay.app.request(`/sync/${MOTEBIT_ID}/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ events }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { motebit_id: string; accepted: number };
    expect(body.motebit_id).toBe(MOTEBIT_ID);
    expect(body.accepted).toBe(2);
  });

  it("POST /sync/:id/push returns 400 when events missing", async () => {
    const res = await relay.app.request(`/sync/${MOTEBIT_ID}/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  // --- Sync: Pull ---

  it("GET /sync/:id/pull returns pushed events", async () => {
    const events = [makeEvent(MOTEBIT_ID, 1), makeEvent(MOTEBIT_ID, 2)];
    await relay.app.request(`/sync/${MOTEBIT_ID}/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ events }),
    });

    const res = await relay.app.request(`/sync/${MOTEBIT_ID}/pull?after_clock=0`, {
      method: "GET",
      headers: AUTH_HEADER,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { motebit_id: string; events: EventLogEntry[] };
    expect(body.motebit_id).toBe(MOTEBIT_ID);
    expect(body.events.length).toBeGreaterThanOrEqual(2);
  });

  it("GET /sync/:id/pull filters by after_clock", async () => {
    const events = [makeEvent(MOTEBIT_ID, 1), makeEvent(MOTEBIT_ID, 2), makeEvent(MOTEBIT_ID, 3)];
    await relay.app.request(`/sync/${MOTEBIT_ID}/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ events }),
    });

    const res = await relay.app.request(`/sync/${MOTEBIT_ID}/pull?after_clock=1`, {
      method: "GET",
      headers: AUTH_HEADER,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: EventLogEntry[] };
    for (const ev of body.events) {
      expect(ev.version_clock).toBeGreaterThan(1);
    }
    expect(body.events.length).toBeGreaterThanOrEqual(2);
  });

  // --- Sync: Clock ---

  it("GET /sync/:id/clock returns 0 with no events", async () => {
    const res = await relay.app.request(`/sync/${MOTEBIT_ID}/clock`, {
      method: "GET",
      headers: AUTH_HEADER,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { motebit_id: string; latest_clock: number };
    expect(body.motebit_id).toBe(MOTEBIT_ID);
    expect(body.latest_clock).toBe(0);
  });

  it("GET /sync/:id/clock returns latest clock after push", async () => {
    const events = [makeEvent(MOTEBIT_ID, 1), makeEvent(MOTEBIT_ID, 2), makeEvent(MOTEBIT_ID, 3)];
    await relay.app.request(`/sync/${MOTEBIT_ID}/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ events }),
    });

    const res = await relay.app.request(`/sync/${MOTEBIT_ID}/clock`, {
      method: "GET",
      headers: AUTH_HEADER,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { latest_clock: number };
    expect(body.latest_clock).toBe(3);
  });

  // --- Identity ---

  it("POST /identity creates identity", async () => {
    const res = await relay.app.request("/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ owner_id: "owner-1" }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { motebit_id: string; owner_id: string; created_at: number };
    expect(body.motebit_id).toBeTypeOf("string");
    expect(body.owner_id).toBe("owner-1");
    expect(body.created_at).toBeTypeOf("number");
  });

  it("POST /identity returns 400 when owner_id is missing", async () => {
    const res = await relay.app.request("/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("GET /identity/:id loads existing identity", async () => {
    const createRes = await relay.app.request("/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ owner_id: "owner-2" }),
    });
    const created = (await createRes.json()) as { motebit_id: string };

    const res = await relay.app.request(`/identity/${created.motebit_id}`, {
      method: "GET",
      headers: AUTH_HEADER,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { motebit_id: string; owner_id: string };
    expect(body.motebit_id).toBe(created.motebit_id);
    expect(body.owner_id).toBe("owner-2");
  });

  it("GET /identity/:id returns 404 for nonexistent", async () => {
    const res = await relay.app.request("/identity/nonexistent-id", {
      method: "GET",
      headers: AUTH_HEADER,
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("identity not found");
  });

  // --- Isolation: different motebitIds ---

  it("events from one motebitId are isolated from another", async () => {
    await relay.app.request("/sync/mote-a/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ events: [makeEvent("mote-a", 1)] }),
    });

    const res = await relay.app.request("/sync/mote-b/pull?after_clock=0", {
      method: "GET",
      headers: AUTH_HEADER,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: EventLogEntry[] };
    expect(body.events).toHaveLength(0);
  });

  // --- Device Registration ---

  it("POST /device/register returns 401 without master token", async () => {
    const res = await relay.app.request("/device/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ motebit_id: "some-id" }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /device/register returns 400 when motebit_id missing", async () => {
    const res = await relay.app.request("/device/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("POST /device/register returns 404 when identity does not exist", async () => {
    const res = await relay.app.request("/device/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ motebit_id: "nonexistent" }),
    });
    expect(res.status).toBe(404);
  });

  it("POST /device/register creates a device for an existing identity", async () => {
    // First create an identity
    const createRes = await relay.app.request("/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ owner_id: "owner-device-test" }),
    });
    const identity = (await createRes.json()) as { motebit_id: string };

    // Register a device
    const res = await relay.app.request("/device/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ motebit_id: identity.motebit_id, device_name: "Test Phone" }),
    });

    expect(res.status).toBe(201);
    const device = (await res.json()) as {
      device_id: string;
      motebit_id: string;
      device_token: string;
      device_name: string;
      registered_at: number;
    };
    expect(device.device_id).toBeTypeOf("string");
    expect(device.motebit_id).toBe(identity.motebit_id);
    expect(device.device_token).toBeTypeOf("string");
    expect(device.device_name).toBe("Test Phone");
    expect(device.registered_at).toBeTypeOf("number");
  });
});

// === Device Auth Tests ===

describe("Sync Relay — device auth", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: true });
    // Create an identity to work with
    await relay.app.request("/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ owner_id: "owner-auth" }),
    });
  });

  afterEach(() => {
    relay.close();
  });

  async function getIdentityMotebitId(): Promise<string> {
    const res = await relay.app.request("/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ owner_id: `owner-${crypto.randomUUID()}` }),
    });
    const body = (await res.json()) as { motebit_id: string };
    return body.motebit_id;
  }

  async function registerDevice(
    motebitId: string,
  ): Promise<{ device_id: string; device_token: string }> {
    const res = await relay.app.request("/device/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ motebit_id: motebitId }),
    });
    return (await res.json()) as { device_id: string; device_token: string };
  }

  it("rejects sync requests without a token", async () => {
    const res = await relay.app.request(`/sync/${MOTEBIT_ID}/clock`, { method: "GET" });
    expect(res.status).toBe(401);
  });

  it("allows sync requests with master token", async () => {
    const res = await relay.app.request(`/sync/${MOTEBIT_ID}/clock`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
  });

  it("allows sync with a valid device token for the correct motebitId", async () => {
    const motebitId = await getIdentityMotebitId();
    const device = await registerDevice(motebitId);

    const res = await relay.app.request(`/sync/${motebitId}/clock`, {
      method: "GET",
      headers: { Authorization: `Bearer ${device.device_token}` },
    });
    expect(res.status).toBe(200);
  });

  it("rejects sync with a valid device token for a different motebitId", async () => {
    const motebitIdA = await getIdentityMotebitId();
    const motebitIdB = await getIdentityMotebitId();
    const deviceA = await registerDevice(motebitIdA);

    const res = await relay.app.request(`/sync/${motebitIdB}/clock`, {
      method: "GET",
      headers: { Authorization: `Bearer ${deviceA.device_token}` },
    });
    expect(res.status).toBe(403);
  });

  it("rejects sync with an invalid device token", async () => {
    const res = await relay.app.request(`/sync/${MOTEBIT_ID}/clock`, {
      method: "GET",
      headers: { Authorization: "Bearer invalid-token" },
    });
    expect(res.status).toBe(403);
  });
});

// === Signed Token Auth Tests ===

describe("Sync Relay — signed token auth", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: true, verifyDeviceSignature: true });
  });

  afterEach(() => {
    relay.close();
  });

  async function createIdentityAndDevice(
    pubKeyHex: string,
  ): Promise<{ motebitId: string; deviceId: string; deviceToken: string }> {
    // Create identity
    const identityRes = await relay.app.request("/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ owner_id: `owner-${crypto.randomUUID()}` }),
    });
    const identity = (await identityRes.json()) as { motebit_id: string };

    // Register device with public key
    const deviceRes = await relay.app.request("/device/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        motebit_id: identity.motebit_id,
        device_name: "Test",
        public_key: pubKeyHex,
      }),
    });
    const device = (await deviceRes.json()) as { device_id: string; device_token: string };

    return {
      motebitId: identity.motebit_id,
      deviceId: device.device_id,
      deviceToken: device.device_token,
    };
  }

  it("allows sync with a valid signed token", async () => {
    const keypair = await generateKeypair();
    const pubKeyHex = bytesToHex(keypair.publicKey);
    const { motebitId, deviceId } = await createIdentityAndDevice(pubKeyHex);

    const token = await createSignedToken(
      { mid: motebitId, did: deviceId, iat: Date.now(), exp: Date.now() + 5 * 60 * 1000 },
      keypair.privateKey,
    );

    const res = await relay.app.request(`/sync/${motebitId}/clock`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });

  it("rejects expired signed token", async () => {
    const keypair = await generateKeypair();
    const pubKeyHex = bytesToHex(keypair.publicKey);
    const { motebitId, deviceId } = await createIdentityAndDevice(pubKeyHex);

    const token = await createSignedToken(
      { mid: motebitId, did: deviceId, iat: Date.now() - 10 * 60 * 1000, exp: Date.now() - 1 },
      keypair.privateKey,
    );

    const res = await relay.app.request(`/sync/${motebitId}/clock`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it("rejects token signed with wrong key", async () => {
    const keypairA = await generateKeypair();
    const keypairB = await generateKeypair();
    const pubKeyHex = bytesToHex(keypairA.publicKey);
    const { motebitId, deviceId } = await createIdentityAndDevice(pubKeyHex);

    // Sign with keypairB's private key, but device has keypairA's public key
    const token = await createSignedToken(
      { mid: motebitId, did: deviceId, iat: Date.now(), exp: Date.now() + 5 * 60 * 1000 },
      keypairB.privateKey,
    );

    const res = await relay.app.request(`/sync/${motebitId}/clock`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it("rejects token with mismatched motebitId", async () => {
    const keypair = await generateKeypair();
    const pubKeyHex = bytesToHex(keypair.publicKey);
    const { motebitId: motebitIdA, deviceId } = await createIdentityAndDevice(pubKeyHex);

    // Create another identity
    const otherRes = await relay.app.request("/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ owner_id: `owner-${crypto.randomUUID()}` }),
    });
    const otherIdentity = (await otherRes.json()) as { motebit_id: string };

    // Token claims motebitIdA, but we request against otherIdentity
    const token = await createSignedToken(
      { mid: motebitIdA, did: deviceId, iat: Date.now(), exp: Date.now() + 5 * 60 * 1000 },
      keypair.privateKey,
    );

    const res = await relay.app.request(`/sync/${otherIdentity.motebit_id}/clock`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it("device registration stores public key", async () => {
    const keypair = await generateKeypair();
    const pubKeyHex = bytesToHex(keypair.publicKey);

    // Create identity
    const identityRes = await relay.app.request("/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ owner_id: `owner-${crypto.randomUUID()}` }),
    });
    const identity = (await identityRes.json()) as { motebit_id: string };

    // Register device with public key
    const deviceRes = await relay.app.request("/device/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        motebit_id: identity.motebit_id,
        device_name: "My Device",
        public_key: pubKeyHex,
      }),
    });

    expect(deviceRes.status).toBe(201);
    const device = (await deviceRes.json()) as {
      device_id: string;
      public_key: string;
      device_name: string;
    };
    expect(device.public_key).toBe(pubKeyHex);
    expect(device.device_name).toBe("My Device");
  });

  it("rejects device registration with invalid public key format", async () => {
    // Create identity
    const identityRes = await relay.app.request("/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ owner_id: `owner-${crypto.randomUUID()}` }),
    });
    const identity = (await identityRes.json()) as { motebit_id: string };

    // Try to register with invalid public key
    const deviceRes = await relay.app.request("/device/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ motebit_id: identity.motebit_id, public_key: "not-hex" }),
    });

    expect(deviceRes.status).toBe(400);
  });
});

// === Admin API Endpoints ===

describe("Sync Relay — admin API endpoints", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
  });

  afterEach(() => {
    relay.close();
  });

  // --- State ---

  it("GET /api/v1/state/:motebitId returns null when no state saved", async () => {
    const res = await relay.app.request(`/api/v1/state/${MOTEBIT_ID}`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { motebit_id: string; state: unknown };
    expect(body.motebit_id).toBe(MOTEBIT_ID);
    expect(body.state).toBeNull();
  });

  it("GET /api/v1/state/:motebitId returns 401 without auth", async () => {
    const res = await relay.app.request(`/api/v1/state/${MOTEBIT_ID}`, { method: "GET" });
    expect(res.status).toBe(401);
  });

  // --- Memory ---

  it("GET /api/v1/memory/:motebitId returns empty arrays when no memories", async () => {
    const res = await relay.app.request(`/api/v1/memory/${MOTEBIT_ID}`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      motebit_id: string;
      memories: unknown[];
      edges: unknown[];
    };
    expect(body.motebit_id).toBe(MOTEBIT_ID);
    expect(body.memories).toEqual([]);
    expect(body.edges).toEqual([]);
  });

  // --- Goals ---

  it("GET /api/v1/goals/:motebitId returns empty array when no goals", async () => {
    const res = await relay.app.request(`/api/v1/goals/${MOTEBIT_ID}`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { motebit_id: string; goals: unknown[] };
    expect(body.motebit_id).toBe(MOTEBIT_ID);
    expect(body.goals).toEqual([]);
  });

  // --- Conversations ---

  it("GET /api/v1/conversations/:motebitId returns synced conversations", async () => {
    // Push a conversation via sync endpoint
    await relay.app.request(`/sync/${MOTEBIT_ID}/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        conversations: [
          {
            conversation_id: "conv-1",
            motebit_id: MOTEBIT_ID,
            started_at: 1000,
            last_active_at: 2000,
            title: "Test Chat",
            summary: null,
            message_count: 5,
          },
        ],
      }),
    });

    const res = await relay.app.request(`/api/v1/conversations/${MOTEBIT_ID}`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      motebit_id: string;
      conversations: Array<{ conversation_id: string; title: string }>;
    };
    expect(body.motebit_id).toBe(MOTEBIT_ID);
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0]!.conversation_id).toBe("conv-1");
    expect(body.conversations[0]!.title).toBe("Test Chat");
  });

  it("GET /api/v1/conversations/:motebitId/:id/messages returns messages", async () => {
    // Push messages via sync endpoint
    await relay.app.request(`/sync/${MOTEBIT_ID}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        messages: [
          {
            message_id: "msg-1",
            conversation_id: "conv-1",
            motebit_id: MOTEBIT_ID,
            role: "user",
            content: "hello",
            tool_calls: null,
            tool_call_id: null,
            created_at: 1000,
            token_estimate: 5,
          },
          {
            message_id: "msg-2",
            conversation_id: "conv-1",
            motebit_id: MOTEBIT_ID,
            role: "assistant",
            content: "hi there",
            tool_calls: null,
            tool_call_id: null,
            created_at: 2000,
            token_estimate: 8,
          },
        ],
      }),
    });

    const res = await relay.app.request(`/api/v1/conversations/${MOTEBIT_ID}/conv-1/messages`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      motebit_id: string;
      conversation_id: string;
      messages: Array<{ message_id: string; role: string; content: string }>;
    };
    expect(body.conversation_id).toBe("conv-1");
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]!.role).toBe("user");
    expect(body.messages[1]!.role).toBe("assistant");
  });

  // --- Devices ---

  it("GET /api/v1/devices/:motebitId returns registered devices", async () => {
    // Create identity + device
    const identityRes = await relay.app.request("/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ owner_id: "owner-devices" }),
    });
    const identity = (await identityRes.json()) as { motebit_id: string };

    await relay.app.request("/device/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ motebit_id: identity.motebit_id, device_name: "Laptop" }),
    });

    const res = await relay.app.request(`/api/v1/devices/${identity.motebit_id}`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      motebit_id: string;
      devices: Array<{ device_name: string }>;
    };
    expect(body.motebit_id).toBe(identity.motebit_id);
    expect(body.devices).toHaveLength(1);
    expect(body.devices[0]!.device_name).toBe("Laptop");
  });

  // --- Events alias ---

  it("GET /api/v1/sync/:motebitId/pull returns events (alias)", async () => {
    // Push events first
    const events = [makeEvent(MOTEBIT_ID, 1)];
    await relay.app.request(`/sync/${MOTEBIT_ID}/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ events }),
    });

    // Pull via /api/v1 alias
    const res = await relay.app.request(`/api/v1/sync/${MOTEBIT_ID}/pull?after_clock=0`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { motebit_id: string; events: EventLogEntry[] };
    expect(body.motebit_id).toBe(MOTEBIT_ID);
    expect(body.events.length).toBeGreaterThanOrEqual(1);
  });

  // --- Plans (existing, but verify they work) ---

  it("GET /api/v1/plans/:motebitId returns empty when no plans", async () => {
    const res = await relay.app.request(`/api/v1/plans/${MOTEBIT_ID}`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { motebit_id: string; plans: unknown[] };
    expect(body.motebit_id).toBe(MOTEBIT_ID);
    expect(body.plans).toEqual([]);
  });
});

// === Agent Protocol Tests ===

describe("Sync Relay — agent protocol", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
  });

  afterEach(() => {
    relay.close();
  });

  it("POST /agent/:id/task submits a task and returns 201", async () => {
    const res = await relay.app.request(`/agent/${MOTEBIT_ID}/task`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ prompt: "What is 2+2?" }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { task_id: string; status: string };
    expect(body.task_id).toBeTypeOf("string");
    expect(body.status).toBe("pending");
  });

  it("POST /agent/:id/task returns 400 for empty prompt", async () => {
    const res = await relay.app.request(`/agent/${MOTEBIT_ID}/task`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ prompt: "" }),
    });

    expect(res.status).toBe(400);
  });

  it("GET /agent/:id/task/:taskId returns pending task", async () => {
    // Submit task
    const submitRes = await relay.app.request(`/agent/${MOTEBIT_ID}/task`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ prompt: "Test task" }),
    });
    const { task_id } = (await submitRes.json()) as { task_id: string };

    // Poll
    const res = await relay.app.request(`/agent/${MOTEBIT_ID}/task/${task_id}`, {
      method: "GET",
      headers: AUTH_HEADER,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { task: AgentTask; receipt: unknown };
    expect(body.task.status).toBe("pending");
    expect(body.task.prompt).toBe("Test task");
    expect(body.receipt).toBeNull();
  });

  it("GET /agent/:id/task/:taskId returns 404 for missing task", async () => {
    const res = await relay.app.request(`/agent/${MOTEBIT_ID}/task/nonexistent`, {
      method: "GET",
      headers: AUTH_HEADER,
    });

    expect(res.status).toBe(404);
  });

  it("POST /agent/:id/task/:taskId/result stores receipt and extends TTL", async () => {
    // Create an executing agent identity with a real Ed25519 keypair
    const execKeypair = await generateKeypair();
    const execPubKeyHex = bytesToHex(execKeypair.publicKey);

    // Register identity + device so the relay can look up the public key
    const idRes = await relay.app.request("/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ owner_id: "exec-owner" }),
    });
    const { motebit_id: execMotebitId } = (await idRes.json()) as { motebit_id: string };

    await relay.app.request("/device/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        motebit_id: execMotebitId,
        device_name: "Worker",
        public_key: execPubKeyHex,
      }),
    });

    // Submit task
    const submitRes = await relay.app.request(`/agent/${MOTEBIT_ID}/task`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ prompt: "Task with receipt" }),
    });
    const { task_id } = (await submitRes.json()) as { task_id: string };

    // Sign the receipt with the executing agent's private key
    const unsigned = {
      task_id,
      motebit_id: execMotebitId as unknown as import("@motebit/sdk").MotebitId,
      device_id: "worker-device" as unknown as import("@motebit/sdk").DeviceId,
      submitted_at: Date.now(),
      completed_at: Date.now(),
      status: "completed" as const,
      result: "The answer is 42",
      tools_used: [] as string[],
      memories_formed: 0,
      prompt_hash: "abc123",
      result_hash: "def456",
    };
    const receipt = await signExecutionReceipt(unsigned, execKeypair.privateKey);

    const resultRes = await relay.app.request(`/agent/${MOTEBIT_ID}/task/${task_id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify(receipt),
    });
    expect(resultRes.status).toBe(200);

    // Poll — should now have receipt
    const pollRes = await relay.app.request(`/agent/${MOTEBIT_ID}/task/${task_id}`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    expect(pollRes.status).toBe(200);

    const body = (await pollRes.json()) as { task: AgentTask; receipt: ExecutionReceipt | null };
    expect(body.task.status).toBe("completed");
    expect(body.receipt).not.toBeNull();
    expect(body.receipt!.result).toBe("The answer is 42");
    expect(body.receipt!.task_id).toBe(task_id);
  });

  it("POST /agent/:id/task/:taskId/result rejects forged signature", async () => {
    // Create executing agent with known key
    const execKeypair = await generateKeypair();
    const execPubKeyHex = bytesToHex(execKeypair.publicKey);

    const idRes = await relay.app.request("/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ owner_id: "forged-owner" }),
    });
    const { motebit_id: execMotebitId } = (await idRes.json()) as { motebit_id: string };

    await relay.app.request("/device/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        motebit_id: execMotebitId,
        device_name: "Worker",
        public_key: execPubKeyHex,
      }),
    });

    // Submit task
    const submitRes = await relay.app.request(`/agent/${MOTEBIT_ID}/task`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ prompt: "Task with forged receipt" }),
    });
    const { task_id } = (await submitRes.json()) as { task_id: string };

    // Post receipt with garbage signature (key is known but sig is forged)
    const receipt: ExecutionReceipt = {
      task_id,
      motebit_id: execMotebitId as unknown as import("@motebit/sdk").MotebitId,
      device_id: "worker-device" as unknown as import("@motebit/sdk").DeviceId,
      submitted_at: Date.now(),
      completed_at: Date.now(),
      status: "completed",
      result: "Forged result",
      tools_used: [],
      memories_formed: 0,
      prompt_hash: "abc123",
      result_hash: "def456",
      signature: "forged-signature-value",
    };

    const resultRes = await relay.app.request(`/agent/${MOTEBIT_ID}/task/${task_id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify(receipt),
    });
    expect(resultRes.status).toBe(403);
  });

  it("POST /agent/:id/task/:taskId/result rejects unknown agent", async () => {
    // Submit task
    const submitRes = await relay.app.request(`/agent/${MOTEBIT_ID}/task`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ prompt: "Task from unknown" }),
    });
    const { task_id } = (await submitRes.json()) as { task_id: string };

    // Receipt from an agent that never registered — no public key discoverable
    const receipt: ExecutionReceipt = {
      task_id,
      motebit_id: "unknown-agent" as unknown as import("@motebit/sdk").MotebitId,
      device_id: "device-1" as unknown as import("@motebit/sdk").DeviceId,
      submitted_at: Date.now(),
      completed_at: Date.now(),
      status: "completed",
      result: "Unknown",
      tools_used: [],
      memories_formed: 0,
      prompt_hash: "abc123",
      result_hash: "def456",
      signature: "some-sig",
    };

    const resultRes = await relay.app.request(`/agent/${MOTEBIT_ID}/task/${task_id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify(receipt),
    });
    expect(resultRes.status).toBe(403);
  });

  it("POST /agent/:id/task accepts required_capabilities and step_id", async () => {
    const res = await relay.app.request(`/agent/${MOTEBIT_ID}/task`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        prompt: "Run stdio tool",
        required_capabilities: ["stdio_mcp", "file_system"],
        step_id: "step-123",
      }),
    });

    expect(res.status).toBe(201);
    const { task_id } = (await res.json()) as { task_id: string };

    // Verify task has capabilities and step_id
    const pollRes = await relay.app.request(`/agent/${MOTEBIT_ID}/task/${task_id}`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    const body = (await pollRes.json()) as { task: AgentTask };
    expect(body.task.required_capabilities).toEqual(["stdio_mcp", "file_system"]);
    expect(body.task.step_id).toBe("step-123");
  });

  it("budget lock + settlement: full cycle on task with pricing", async () => {
    // Create a service agent with pricing
    const serviceKeypair = await generateKeypair();
    const servicePubHex = bytesToHex(serviceKeypair.publicKey);

    const idRes = await relay.app.request("/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ owner_id: "service-owner" }),
    });
    const { motebit_id: serviceMotebitId } = (await idRes.json()) as { motebit_id: string };

    // Register device with public key (for receipt verification)
    const devRes = await relay.app.request("/device/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        motebit_id: serviceMotebitId,
        device_name: "Service",
        public_key: servicePubHex,
      }),
    });
    const { device_id: serviceDeviceId } = (await devRes.json()) as { device_id: string };

    // Create a signed token so we can register in the agent registry
    const serviceToken = await createSignedToken(
      { mid: serviceMotebitId, did: serviceDeviceId, iat: Date.now(), exp: Date.now() + 300000 },
      serviceKeypair.privateKey,
    );

    // Register agent with capabilities
    await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceToken}`,
      },
      body: JSON.stringify({
        endpoint_url: "http://service.local/mcp",
        capabilities: ["web_search"],
      }),
    });

    // Register service listing with pricing
    await relay.app.request(`/api/v1/agents/${serviceMotebitId}/listing`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceToken}`,
      },
      body: JSON.stringify({
        capabilities: ["web_search"],
        pricing: [{ capability: "web_search", unit_cost: 0.05, currency: "USD", per: "task" }],
      }),
    });

    // Connect the service agent's device so routing can reach it
    const serviceWs = { send: vi.fn(), close: vi.fn(), readyState: 1 };
    relay.connections.set(serviceMotebitId, [
      { ws: serviceWs as never, deviceId: serviceDeviceId, capabilities: ["web_search"] },
    ]);

    // Submit task with max_budget — should trigger budget lock via scored routing
    const submitRes = await relay.app.request(`/agent/${MOTEBIT_ID}/task`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        prompt: "Search for something",
        required_capabilities: ["web_search"],
        max_budget: 1.0,
        currency: "USD",
      }),
    });
    expect(submitRes.status).toBe(201);
    const { task_id } = (await submitRes.json()) as { task_id: string };

    // Verify budget was locked
    const budgetRes = await relay.app.request(`/agent/${MOTEBIT_ID}/budget`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    expect(budgetRes.status).toBe(200);
    const budget = (await budgetRes.json()) as {
      summary: { total_locked: number; total_settled: number };
      allocations: Array<Record<string, unknown>>;
    };
    expect(budget.summary.total_locked).toBeGreaterThan(0);
    expect(budget.allocations.length).toBeGreaterThanOrEqual(1);
    const alloc = budget.allocations.find((a) => a.task_id === task_id);
    expect(alloc).toBeDefined();
    expect(alloc!.status).toBe("locked");
    expect(alloc!.amount_locked).toBeGreaterThan(0);

    // Service agent completes the task with a signed receipt
    const unsigned = {
      task_id,
      motebit_id: serviceMotebitId as unknown as import("@motebit/sdk").MotebitId,
      device_id: serviceDeviceId as unknown as import("@motebit/sdk").DeviceId,
      submitted_at: Date.now(),
      completed_at: Date.now(),
      status: "completed" as const,
      result: "Found 3 results",
      tools_used: ["web_search"],
      memories_formed: 0,
      prompt_hash: "abc",
      result_hash: "def",
    };
    const receipt = await signExecutionReceipt(unsigned, serviceKeypair.privateKey);

    const resultRes = await relay.app.request(`/agent/${MOTEBIT_ID}/task/${task_id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify(receipt),
    });
    expect(resultRes.status).toBe(200);

    // Verify settlement occurred
    const budgetAfter = (await (
      await relay.app.request(`/agent/${MOTEBIT_ID}/budget`, {
        method: "GET",
        headers: AUTH_HEADER,
      })
    ).json()) as {
      summary: { total_locked: number; total_settled: number };
      allocations: Array<Record<string, unknown>>;
    };
    expect(budgetAfter.summary.total_settled).toBeGreaterThan(0);
    const settledAlloc = budgetAfter.allocations.find((a) => a.task_id === task_id);
    expect(settledAlloc!.status).toBe("settled");
    expect(settledAlloc!.settlement_status).toBe("completed");
    expect(settledAlloc!.amount_settled).toBeGreaterThan(0);
  });

  it("budget lock rejects underfunded tasks", async () => {
    // Create and register a service agent with expensive pricing
    const serviceKeypair = await generateKeypair();
    const servicePubHex = bytesToHex(serviceKeypair.publicKey);

    const idRes = await relay.app.request("/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ owner_id: "expensive-service" }),
    });
    const { motebit_id: serviceMotebitId } = (await idRes.json()) as { motebit_id: string };

    const devRes2 = await relay.app.request("/device/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        motebit_id: serviceMotebitId,
        device_name: "Service",
        public_key: servicePubHex,
      }),
    });
    const { device_id: expDeviceId } = (await devRes2.json()) as { device_id: string };

    const serviceToken = await createSignedToken(
      { mid: serviceMotebitId, did: expDeviceId, iat: Date.now(), exp: Date.now() + 300000 },
      serviceKeypair.privateKey,
    );

    await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceToken}`,
      },
      body: JSON.stringify({
        endpoint_url: "http://expensive.local/mcp",
        capabilities: ["code_exec"],
      }),
    });

    await relay.app.request(`/api/v1/agents/${serviceMotebitId}/listing`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceToken}`,
      },
      body: JSON.stringify({
        capabilities: ["code_exec"],
        pricing: [{ capability: "code_exec", unit_cost: 5.0, currency: "USD", per: "task" }],
      }),
    });

    const serviceWs = { send: vi.fn(), close: vi.fn(), readyState: 1 };
    relay.connections.set(serviceMotebitId, [
      { ws: serviceWs as never, deviceId: expDeviceId, capabilities: ["code_exec"] },
    ]);

    // Submit with budget too small for the pricing
    const res = await relay.app.request(`/agent/${MOTEBIT_ID}/task`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        prompt: "Run expensive code",
        required_capabilities: ["code_exec"],
        max_budget: 1.0,
      }),
    });
    expect(res.status).toBe(402);
  });

  it("settlement refunds on failed receipt", async () => {
    // Create service agent
    const serviceKeypair = await generateKeypair();
    const servicePubHex = bytesToHex(serviceKeypair.publicKey);

    const idRes = await relay.app.request("/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ owner_id: "refund-service" }),
    });
    const { motebit_id: serviceMotebitId } = (await idRes.json()) as { motebit_id: string };

    const devRes3 = await relay.app.request("/device/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        motebit_id: serviceMotebitId,
        device_name: "Service",
        public_key: servicePubHex,
      }),
    });
    const { device_id: refDeviceId } = (await devRes3.json()) as { device_id: string };

    const serviceToken = await createSignedToken(
      { mid: serviceMotebitId, did: refDeviceId, iat: Date.now(), exp: Date.now() + 300000 },
      serviceKeypair.privateKey,
    );

    await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceToken}`,
      },
      body: JSON.stringify({
        endpoint_url: "http://refund.local/mcp",
        capabilities: ["web_search"],
      }),
    });

    await relay.app.request(`/api/v1/agents/${serviceMotebitId}/listing`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceToken}`,
      },
      body: JSON.stringify({
        capabilities: ["web_search"],
        pricing: [{ capability: "web_search", unit_cost: 0.1, currency: "USD", per: "task" }],
      }),
    });

    const serviceWs = { send: vi.fn(), close: vi.fn(), readyState: 1 };
    relay.connections.set(serviceMotebitId, [
      { ws: serviceWs as never, deviceId: refDeviceId, capabilities: ["web_search"] },
    ]);

    // Submit task with budget
    const submitRes = await relay.app.request(`/agent/${MOTEBIT_ID}/task`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        prompt: "Search that fails",
        required_capabilities: ["web_search"],
        max_budget: 1.0,
      }),
    });
    const { task_id } = (await submitRes.json()) as { task_id: string };

    // Service agent fails the task
    const unsigned = {
      task_id,
      motebit_id: serviceMotebitId as unknown as import("@motebit/sdk").MotebitId,
      device_id: refDeviceId as unknown as import("@motebit/sdk").DeviceId,
      submitted_at: Date.now(),
      completed_at: Date.now(),
      status: "failed" as const,
      result: "Service unavailable",
      tools_used: [],
      memories_formed: 0,
      prompt_hash: "abc",
      result_hash: "def",
    };
    const receipt = await signExecutionReceipt(unsigned, serviceKeypair.privateKey);

    await relay.app.request(`/agent/${MOTEBIT_ID}/task/${task_id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify(receipt),
    });

    // Verify refund: allocation released, settlement refunded
    const budget = (await (
      await relay.app.request(`/agent/${MOTEBIT_ID}/budget`, {
        method: "GET",
        headers: AUTH_HEADER,
      })
    ).json()) as {
      summary: { total_locked: number; total_settled: number };
      allocations: Array<Record<string, unknown>>;
    };
    const refundedAlloc = budget.allocations.find((a) => a.task_id === task_id);
    expect(refundedAlloc!.status).toBe("released");
    expect(refundedAlloc!.settlement_status).toBe("refunded");
    expect(refundedAlloc!.amount_settled).toBe(0);
  });

  it("POST/GET /sync/:id/plans pushes and pulls plans", async () => {
    const plan = {
      plan_id: "plan-sync-1",
      goal_id: "goal-1",
      motebit_id: MOTEBIT_ID,
      title: "Test plan",
      status: "active",
      created_at: 1000,
      updated_at: 5000,
      current_step_index: 0,
      total_steps: 2,
    };

    const pushRes = await relay.app.request(`/sync/${MOTEBIT_ID}/plans`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ plans: [plan] }),
    });
    expect(pushRes.status).toBe(200);
    const pushBody = (await pushRes.json()) as { accepted: number };
    expect(pushBody.accepted).toBe(1);

    const pullRes = await relay.app.request(`/sync/${MOTEBIT_ID}/plans?since=0`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    expect(pullRes.status).toBe(200);
    const pullBody = (await pullRes.json()) as { plans: Array<{ plan_id: string; title: string }> };
    expect(pullBody.plans).toHaveLength(1);
    expect(pullBody.plans[0]!.plan_id).toBe("plan-sync-1");
    expect(pullBody.plans[0]!.title).toBe("Test plan");
  });

  it("POST/GET /sync/:id/plan-steps pushes and pulls steps", async () => {
    const step = {
      step_id: "step-sync-1",
      plan_id: "plan-sync-1",
      motebit_id: MOTEBIT_ID,
      ordinal: 0,
      description: "Test step",
      prompt: "Do the thing",
      depends_on: "[]",
      optional: false,
      status: "completed",
      required_capabilities: null,
      delegation_task_id: null,
      result_summary: "Done!",
      error_message: null,
      tool_calls_made: 2,
      started_at: 2000,
      completed_at: 3000,
      retry_count: 0,
      updated_at: 3000,
    };

    const pushRes = await relay.app.request(`/sync/${MOTEBIT_ID}/plan-steps`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ steps: [step] }),
    });
    expect(pushRes.status).toBe(200);

    const pullRes = await relay.app.request(`/sync/${MOTEBIT_ID}/plan-steps?since=0`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    expect(pullRes.status).toBe(200);
    const pullBody = (await pullRes.json()) as {
      steps: Array<{ step_id: string; status: string; result_summary: string }>;
    };
    expect(pullBody.steps).toHaveLength(1);
    expect(pullBody.steps[0]!.step_id).toBe("step-sync-1");
    expect(pullBody.steps[0]!.status).toBe("completed");
    expect(pullBody.steps[0]!.result_summary).toBe("Done!");
  });

  it("plan sync enforces step status monotonicity on relay", async () => {
    // First push a completed step
    const completedStep = {
      step_id: "step-mono-1",
      plan_id: "plan-mono-1",
      motebit_id: MOTEBIT_ID,
      ordinal: 0,
      description: "Mono step",
      prompt: "Do it",
      depends_on: "[]",
      optional: false,
      status: "completed",
      required_capabilities: null,
      delegation_task_id: null,
      result_summary: "Done",
      error_message: null,
      tool_calls_made: 1,
      started_at: 2000,
      completed_at: 3000,
      retry_count: 0,
      updated_at: 3000,
    };

    await relay.app.request(`/sync/${MOTEBIT_ID}/plan-steps`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ steps: [completedStep] }),
    });

    // Try to regress status to "running" — should be rejected
    const runningStep = { ...completedStep, status: "running", updated_at: 4000 };
    await relay.app.request(`/sync/${MOTEBIT_ID}/plan-steps`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ steps: [runningStep] }),
    });

    const pullRes = await relay.app.request(`/sync/${MOTEBIT_ID}/plan-steps?since=0`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    const pullBody = (await pullRes.json()) as {
      steps: Array<{ step_id: string; status: string }>;
    };
    const monoStep = pullBody.steps.find((s) => s.step_id === "step-mono-1");
    expect(monoStep!.status).toBe("completed"); // NOT regressed to "running"
  });

  it("GET /agent/:id/capabilities returns identity info", async () => {
    // Create identity first
    await relay.app.request("/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ owner_id: "owner-caps" }),
    });
    const identityRes = await relay.app.request("/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ owner_id: "owner-caps-2" }),
    });
    const identity = (await identityRes.json()) as { motebit_id: string };

    const res = await relay.app.request(`/agent/${identity.motebit_id}/capabilities`, {
      method: "GET",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      motebit_id: string;
      online_devices: number;
      governance: Record<string, unknown>;
    };
    expect(body.motebit_id).toBe(identity.motebit_id);
    expect(body.online_devices).toBe(0);
    expect(body.governance).toBeDefined();
  });

  it("GET /agent/:id/capabilities returns 404 for unknown identity", async () => {
    const res = await relay.app.request("/agent/nonexistent/capabilities", {
      method: "GET",
    });

    expect(res.status).toBe(404);
  });
});

// === Agent Discovery Registry Tests ===

describe("Sync Relay — agent discovery registry", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: true, verifyDeviceSignature: true });
  });

  afterEach(() => {
    relay.close();
  });

  async function setupIdentityAndToken(): Promise<{
    motebitId: string;
    token: string;
    pubKeyHex: string;
  }> {
    const keypair = await generateKeypair();
    const pubKeyHex = bytesToHex(keypair.publicKey);

    // Create identity
    const identityRes = await relay.app.request("/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ owner_id: `owner-${crypto.randomUUID()}` }),
    });
    const identity = (await identityRes.json()) as { motebit_id: string };

    // Register device with public key
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

    // Create signed token
    const token = await createSignedToken(
      {
        mid: identity.motebit_id,
        did: device.device_id,
        iat: Date.now(),
        exp: Date.now() + 5 * 60 * 1000,
      },
      keypair.privateKey,
    );

    return { motebitId: identity.motebit_id, token, pubKeyHex };
  }

  it("returns 401 when no auth token provided", async () => {
    const res = await relay.app.request("/api/v1/agents/discover", { method: "GET" });
    expect(res.status).toBe(401);
  });

  it("register → discover finds the agent", async () => {
    const { motebitId, token, pubKeyHex } = await setupIdentityAndToken();

    // Register
    const regRes = await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        endpoint_url: "https://example.com/mcp",
        capabilities: ["query", "remember"],
        metadata: { name: "Test Agent", description: "A test agent" },
      }),
    });
    expect(regRes.status).toBe(200);
    const regBody = (await regRes.json()) as {
      registered: boolean;
      motebit_id: string;
      expires_at: number;
    };
    expect(regBody.registered).toBe(true);
    expect(regBody.motebit_id).toBe(motebitId);
    expect(regBody.expires_at).toBeTypeOf("number");

    // Discover
    const discoverRes = await relay.app.request("/api/v1/agents/discover", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(discoverRes.status).toBe(200);
    const discoverBody = (await discoverRes.json()) as {
      agents: Array<{
        motebit_id: string;
        public_key: string;
        endpoint_url: string;
        capabilities: string[];
        metadata: { name: string; description: string };
      }>;
    };
    expect(discoverBody.agents).toHaveLength(1);
    expect(discoverBody.agents[0]!.motebit_id).toBe(motebitId);
    expect(discoverBody.agents[0]!.public_key).toBe(pubKeyHex);
    expect(discoverBody.agents[0]!.endpoint_url).toBe("https://example.com/mcp");
    expect(discoverBody.agents[0]!.capabilities).toEqual(["query", "remember"]);
    expect(discoverBody.agents[0]!.metadata).toEqual({
      name: "Test Agent",
      description: "A test agent",
    });
  });

  it("heartbeat refreshes TTL", async () => {
    const { motebitId, token } = await setupIdentityAndToken();

    // Register first
    await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ endpoint_url: "https://example.com/mcp", capabilities: ["query"] }),
    });

    // Heartbeat
    const hbRes = await relay.app.request("/api/v1/agents/heartbeat", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(hbRes.status).toBe(200);
    const hbBody = (await hbRes.json()) as { ok: boolean };
    expect(hbBody.ok).toBe(true);

    // Still discoverable
    const discoverRes = await relay.app.request(`/api/v1/agents/${motebitId}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(discoverRes.status).toBe(200);
  });

  it("heartbeat returns 404 when not registered", async () => {
    const { token } = await setupIdentityAndToken();

    const hbRes = await relay.app.request("/api/v1/agents/heartbeat", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(hbRes.status).toBe(404);
  });

  it("deregister → discover returns empty", async () => {
    const { token } = await setupIdentityAndToken();

    // Register
    await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ endpoint_url: "https://example.com/mcp", capabilities: ["query"] }),
    });

    // Deregister
    const deregRes = await relay.app.request("/api/v1/agents/deregister", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(deregRes.status).toBe(200);
    const deregBody = (await deregRes.json()) as { ok: boolean };
    expect(deregBody.ok).toBe(true);

    // Discover should return empty
    const discoverRes = await relay.app.request("/api/v1/agents/discover", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(discoverRes.status).toBe(200);
    const discoverBody = (await discoverRes.json()) as { agents: unknown[] };
    expect(discoverBody.agents).toHaveLength(0);
  });

  it("discover with capability filter", async () => {
    const agentA = await setupIdentityAndToken();
    const agentB = await setupIdentityAndToken();

    // Register agent A with "query" + "remember"
    await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentA.token}` },
      body: JSON.stringify({
        endpoint_url: "https://a.example.com/mcp",
        capabilities: ["query", "remember"],
      }),
    });

    // Register agent B with "search" only
    await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentB.token}` },
      body: JSON.stringify({ endpoint_url: "https://b.example.com/mcp", capabilities: ["search"] }),
    });

    // Discover with capability=query → only agent A
    const queryRes = await relay.app.request("/api/v1/agents/discover?capability=query", {
      method: "GET",
      headers: { Authorization: `Bearer ${agentA.token}` },
    });
    expect(queryRes.status).toBe(200);
    const queryBody = (await queryRes.json()) as { agents: Array<{ motebit_id: string }> };
    expect(queryBody.agents).toHaveLength(1);
    expect(queryBody.agents[0]!.motebit_id).toBe(agentA.motebitId);

    // Discover with capability=search → only agent B
    const searchRes = await relay.app.request("/api/v1/agents/discover?capability=search", {
      method: "GET",
      headers: { Authorization: `Bearer ${agentA.token}` },
    });
    expect(searchRes.status).toBe(200);
    const searchBody = (await searchRes.json()) as { agents: Array<{ motebit_id: string }> };
    expect(searchBody.agents).toHaveLength(1);
    expect(searchBody.agents[0]!.motebit_id).toBe(agentB.motebitId);

    // Discover all → both agents
    const allRes = await relay.app.request("/api/v1/agents/discover", {
      method: "GET",
      headers: { Authorization: `Bearer ${agentA.token}` },
    });
    expect(allRes.status).toBe(200);
    const allBody = (await allRes.json()) as { agents: unknown[] };
    expect(allBody.agents).toHaveLength(2);
  });

  it("GET /api/v1/agents/:motebitId returns 404 for unknown agent", async () => {
    const { token } = await setupIdentityAndToken();

    const res = await relay.app.request("/api/v1/agents/nonexistent-id", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });

  it("GET /api/v1/agents/:motebitId returns registered agent", async () => {
    const { motebitId, token } = await setupIdentityAndToken();

    // Register
    await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ endpoint_url: "https://example.com/mcp", capabilities: ["query"] }),
    });

    const res = await relay.app.request(`/api/v1/agents/${motebitId}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { motebit_id: string; endpoint_url: string };
    expect(body.motebit_id).toBe(motebitId);
    expect(body.endpoint_url).toBe("https://example.com/mcp");
  });

  it("master token can register with explicit motebit_id", async () => {
    // Create identity + device for public key lookup
    const { motebitId } = await setupIdentityAndToken();

    // Register using master token with explicit motebit_id
    const regRes = await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        motebit_id: motebitId,
        endpoint_url: "https://admin.example.com/mcp",
        capabilities: ["admin"],
      }),
    });
    expect(regRes.status).toBe(200);

    // Discover via master token
    const discoverRes = await relay.app.request("/api/v1/agents/discover", {
      method: "GET",
      headers: AUTH_HEADER,
    });
    expect(discoverRes.status).toBe(200);
    const body = (await discoverRes.json()) as { agents: Array<{ motebit_id: string }> };
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0]!.motebit_id).toBe(motebitId);
  });
});
