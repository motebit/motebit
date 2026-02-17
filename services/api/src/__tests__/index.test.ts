import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSyncRelay } from "../index.js";
import type { SyncRelay } from "../index.js";
import { EventType } from "@motebit/sdk";
import type { EventLogEntry } from "@motebit/sdk";

// === Helpers ===

const API_TOKEN = "test-token";
const AUTH_HEADER = { Authorization: `Bearer ${API_TOKEN}` };
const MOTEBIT_ID = "test-mote";

function createTestRelay(overrides?: { enableDeviceAuth?: boolean }): SyncRelay {
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

  beforeEach(() => {
    relay = createTestRelay();
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
    relay = createTestRelay({ enableDeviceAuth: true });
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

  async function registerDevice(motebitId: string): Promise<{ device_id: string; device_token: string }> {
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
