import { describe, it, expect, afterEach } from "vitest";
import { createSyncRelay } from "../index.js";
import type { SyncRelay } from "../index.js";

// === Helpers ===

const API_TOKEN = "test-token";
const AUTH_HEADER = { Authorization: `Bearer ${API_TOKEN}` };
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
      headers: AUTH_HEADER,
    });
    expect(freezeRes.status).toBe(200);

    // POST to a write endpoint should be blocked
    const writeRes = await relay.app.request(`/sync/${MOTEBIT_ID}/push`, {
      method: "POST",
      headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
      body: JSON.stringify({ events: [] }),
    });
    expect(writeRes.status).toBe(503);
    const body = (await writeRes.json()) as { error: string };
    expect(body.error).toContain("emergency freeze");
  });

  it("freeze allows read operations", async () => {
    relay = await createTestRelay();

    // Activate freeze
    await relay.app.request("/api/v1/admin/freeze", {
      method: "POST",
      headers: AUTH_HEADER,
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
      headers: AUTH_HEADER,
    });
    expect(freezeRes.status).toBe(200);
    const freezeBody = (await freezeRes.json()) as { status: string };
    expect(freezeBody.status).toBe("frozen");

    // Verify writes are blocked
    const blockedRes = await relay.app.request(`/sync/${MOTEBIT_ID}/push`, {
      method: "POST",
      headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
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

    // Verify writes work again (push with empty events returns 200)
    const allowedRes = await relay.app.request(`/sync/${MOTEBIT_ID}/push`, {
      method: "POST",
      headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
      body: JSON.stringify({ events: [] }),
    });
    // Should not be 503 — the actual endpoint may return 400 or 200 depending on validation,
    // but it should NOT be the freeze 503
    expect(allowedRes.status).not.toBe(503);
  });

  it("health endpoint shows frozen status", async () => {
    relay = await createTestRelay();

    // Before freeze
    const beforeRes = await relay.app.request("/health", { method: "GET" });
    const beforeBody = (await beforeRes.json()) as { status: string; frozen: boolean };
    expect(beforeBody.status).toBe("ok");
    expect(beforeBody.frozen).toBe(false);

    // Activate freeze
    await relay.app.request("/api/v1/admin/freeze", {
      method: "POST",
      headers: AUTH_HEADER,
    });

    // After freeze
    const afterRes = await relay.app.request("/health", { method: "GET" });
    const afterBody = (await afterRes.json()) as { status: string; frozen: boolean };
    expect(afterBody.status).toBe("frozen");
    expect(afterBody.frozen).toBe(true);
  });

  it("startup freeze: relay created with emergencyFreeze=true starts frozen", async () => {
    relay = await createTestRelay({ emergencyFreeze: true });

    // Health should report frozen
    const healthRes = await relay.app.request("/health", { method: "GET" });
    const healthBody = (await healthRes.json()) as { status: string; frozen: boolean };
    expect(healthBody.status).toBe("frozen");
    expect(healthBody.frozen).toBe(true);

    // Writes should be blocked
    const writeRes = await relay.app.request(`/sync/${MOTEBIT_ID}/push`, {
      method: "POST",
      headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
      body: JSON.stringify({ events: [] }),
    });
    expect(writeRes.status).toBe(503);

    // emergencyFreeze property should reflect the state
    expect(relay.emergencyFreeze).toBe(true);
  });

  it("freeze/unfreeze endpoints require admin auth", async () => {
    relay = await createTestRelay();

    // No auth
    const noAuthRes = await relay.app.request("/api/v1/admin/freeze", {
      method: "POST",
    });
    expect(noAuthRes.status).toBe(401);

    // Wrong token
    const wrongAuthRes = await relay.app.request("/api/v1/admin/freeze", {
      method: "POST",
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(wrongAuthRes.status).toBe(401);
  });

  it("unfreeze endpoint is reachable while frozen", async () => {
    relay = await createTestRelay({ emergencyFreeze: true });

    // Unfreeze should work even though we're frozen (it's exempted)
    const unfreezeRes = await relay.app.request("/api/v1/admin/unfreeze", {
      method: "POST",
      headers: AUTH_HEADER,
    });
    expect(unfreezeRes.status).toBe(200);

    // Should be unfrozen now
    const healthRes = await relay.app.request("/health", { method: "GET" });
    const healthBody = (await healthRes.json()) as { frozen: boolean };
    expect(healthBody.frozen).toBe(false);
  });
});
