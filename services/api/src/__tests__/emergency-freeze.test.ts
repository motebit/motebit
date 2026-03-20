import { describe, it, expect, afterEach } from "vitest";
import { createSyncRelay } from "../index.js";
import type { SyncRelay } from "../index.js";

// === Helpers ===

const API_TOKEN = "test-token";
const AUTH_HEADER = { Authorization: `Bearer ${API_TOKEN}` };
const JSON_AUTH = { ...AUTH_HEADER, "Content-Type": "application/json" };
const MOTEBIT_ID = "test-mote";

async function createTestRelay(overrides?: { emergencyFreeze?: boolean }): Promise<SyncRelay> {
  return createSyncRelay({
    apiToken: API_TOKEN,
    enableDeviceAuth: false,
    x402: {
      payToAddress: "0x0000000000000000000000000000000000000000",
      network: "eip155:84532",
      testnet: true,
    },
    ...overrides,
  });
}

function freezeBody(reason = "test freeze") {
  return JSON.stringify({ reason });
}

// === Tests ===

describe("Emergency Freeze", () => {
  let relay: SyncRelay;

  afterEach(() => {
    relay.close();
  });

  it("freeze blocks write operations with 503", async () => {
    relay = await createTestRelay();

    // Activate freeze
    const freezeRes = await relay.app.request("/api/v1/admin/freeze", {
      method: "POST",
      headers: JSON_AUTH,
      body: freezeBody("suspected double-credit"),
    });
    expect(freezeRes.status).toBe(200);

    // POST to a write endpoint should be blocked
    const writeRes = await relay.app.request(`/sync/${MOTEBIT_ID}/push`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ events: [] }),
    });
    expect(writeRes.status).toBe(503);
    const body = (await writeRes.json()) as { error: string };
    expect(body.error).toContain("emergency freeze");
  });

  it("freeze allows read operations", async () => {
    relay = await createTestRelay();

    await relay.app.request("/api/v1/admin/freeze", {
      method: "POST",
      headers: JSON_AUTH,
      body: freezeBody(),
    });

    // GET /health should still work
    const healthRes = await relay.app.request("/health", { method: "GET" });
    expect(healthRes.status).toBe(200);
  });

  it("admin toggle: freeze then unfreeze", async () => {
    relay = await createTestRelay();

    // Freeze
    const freezeRes = await relay.app.request("/api/v1/admin/freeze", {
      method: "POST",
      headers: JSON_AUTH,
      body: freezeBody("investigation"),
    });
    expect(freezeRes.status).toBe(200);
    const freezeBody2 = (await freezeRes.json()) as { status: string; reason: string };
    expect(freezeBody2.status).toBe("frozen");
    expect(freezeBody2.reason).toBe("investigation");

    // Verify writes are blocked
    const blockedRes = await relay.app.request(`/sync/${MOTEBIT_ID}/push`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ events: [] }),
    });
    expect(blockedRes.status).toBe(503);

    // Unfreeze
    const unfreezeRes = await relay.app.request("/api/v1/admin/unfreeze", {
      method: "POST",
      headers: AUTH_HEADER,
    });
    expect(unfreezeRes.status).toBe(200);
    const unfreezeBody = (await unfreezeRes.json()) as { status: string };
    expect(unfreezeBody.status).toBe("active");

    // Verify writes work again
    const allowedRes = await relay.app.request(`/sync/${MOTEBIT_ID}/push`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ events: [] }),
    });
    expect(allowedRes.status).not.toBe(503);
  });

  it("health endpoint shows frozen status and reason", async () => {
    relay = await createTestRelay();

    // Before freeze
    const beforeRes = await relay.app.request("/health", { method: "GET" });
    const beforeBody = (await beforeRes.json()) as { status: string; frozen: boolean };
    expect(beforeBody.status).toBe("ok");
    expect(beforeBody.frozen).toBe(false);

    // Activate freeze with reason
    await relay.app.request("/api/v1/admin/freeze", {
      method: "POST",
      headers: JSON_AUTH,
      body: freezeBody("settlement anomaly"),
    });

    // After freeze — reason visible
    const afterRes = await relay.app.request("/health", { method: "GET" });
    const afterBody = (await afterRes.json()) as {
      status: string;
      frozen: boolean;
      freeze_reason?: string;
    };
    expect(afterBody.status).toBe("frozen");
    expect(afterBody.frozen).toBe(true);
    expect(afterBody.freeze_reason).toBe("settlement anomaly");
  });

  it("startup freeze: relay created with emergencyFreeze=true starts frozen", async () => {
    relay = await createTestRelay({ emergencyFreeze: true });

    const healthRes = await relay.app.request("/health", { method: "GET" });
    const healthBody = (await healthRes.json()) as {
      status: string;
      frozen: boolean;
      freeze_reason?: string;
    };
    expect(healthBody.status).toBe("frozen");
    expect(healthBody.frozen).toBe(true);
    expect(healthBody.freeze_reason).toBe("startup");

    // Writes should be blocked
    const writeRes = await relay.app.request(`/sync/${MOTEBIT_ID}/push`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ events: [] }),
    });
    expect(writeRes.status).toBe(503);

    expect(relay.emergencyFreeze).toBe(true);
  });

  it("freeze requires reason (400 without it)", async () => {
    relay = await createTestRelay();

    // No body
    const noBodyRes = await relay.app.request("/api/v1/admin/freeze", {
      method: "POST",
      headers: AUTH_HEADER,
    });
    expect(noBodyRes.status).toBe(400);

    // Empty reason
    const emptyRes = await relay.app.request("/api/v1/admin/freeze", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ reason: "" }),
    });
    expect(emptyRes.status).toBe(400);

    // Relay should NOT be frozen
    expect(relay.emergencyFreeze).toBe(false);
  });

  it("freeze/unfreeze endpoints require admin auth", async () => {
    relay = await createTestRelay();

    const noAuthRes = await relay.app.request("/api/v1/admin/freeze", {
      method: "POST",
    });
    expect(noAuthRes.status).toBe(401);

    const wrongAuthRes = await relay.app.request("/api/v1/admin/freeze", {
      method: "POST",
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(wrongAuthRes.status).toBe(401);
  });

  it("unfreeze endpoint is reachable while frozen", async () => {
    relay = await createTestRelay({ emergencyFreeze: true });

    const unfreezeRes = await relay.app.request("/api/v1/admin/unfreeze", {
      method: "POST",
      headers: AUTH_HEADER,
    });
    expect(unfreezeRes.status).toBe(200);

    const healthRes = await relay.app.request("/health", { method: "GET" });
    const healthBody = (await healthRes.json()) as { frozen: boolean };
    expect(healthBody.frozen).toBe(false);
  });
});
