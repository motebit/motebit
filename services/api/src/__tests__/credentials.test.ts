import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSyncRelay } from "../index.js";
import type { SyncRelay } from "../index.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation
import {
  generateKeypair,
  bytesToHex,
  issueReputationCredential,
  publicKeyToDidKey,
} from "@motebit/crypto";

const API_TOKEN = "test-token";
const AUTH_HEADER = { Authorization: `Bearer ${API_TOKEN}` };

async function createTestRelay(overrides: { issueCredentials?: boolean } = {}): Promise<SyncRelay> {
  return createSyncRelay({
    apiToken: API_TOKEN,
    enableDeviceAuth: true,
    verifyDeviceSignature: true,
    x402: {
      payToAddress: "0x0000000000000000000000000000000000000000",
      network: "eip155:84532",
      testnet: true,
    },
    ...overrides,
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

describe("Credentials — Reputation Issuance", () => {
  let relay: SyncRelay;

  afterEach(() => {
    relay.close();
  });

  it("returns 403 when relay credential issuance is disabled", async () => {
    relay = await createTestRelay({ issueCredentials: false });
    const keypair = await generateKeypair();
    const pubKeyHex = bytesToHex(keypair.publicKey);
    const { motebitId } = await createIdentityAndDevice(relay, pubKeyHex);

    const res = await relay.app.request(`/api/v1/credentials/${motebitId}/reputation`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    });
    expect(res.status).toBe(403);
  });

  it("returns 404 when no task history exists", async () => {
    relay = await createTestRelay({ issueCredentials: true });
    const keypair = await generateKeypair();
    const pubKeyHex = bytesToHex(keypair.publicKey);
    const { motebitId } = await createIdentityAndDevice(relay, pubKeyHex);

    const res = await relay.app.request(`/api/v1/credentials/${motebitId}/reputation`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    });
    expect(res.status).toBe(404);
  });
});

describe("Credentials — Verify", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(() => {
    relay.close();
  });

  it("verifies a valid credential", async () => {
    const keypair = await generateKeypair();
    const did = publicKeyToDidKey(keypair.publicKey);

    const vc = await issueReputationCredential(
      {
        success_rate: 0.95,
        avg_latency_ms: 500,
        task_count: 10,
        trust_score: 0.85,
        availability: 0.99,
        measured_at: Date.now(),
      },
      keypair.privateKey,
      keypair.publicKey,
      did,
    );

    const res = await relay.app.request("/api/v1/credentials/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(vc),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { valid: boolean; issuer: string };
    expect(body.valid).toBe(true);
  });

  it("returns 400 for missing required fields", async () => {
    const res = await relay.app.request("/api/v1/credentials/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "NotACredential" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("Credentials — List", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(() => {
    relay.close();
  });

  it("returns empty array when no credentials exist", async () => {
    const keypair = await generateKeypair();
    const pubKeyHex = bytesToHex(keypair.publicKey);
    const { motebitId } = await createIdentityAndDevice(relay, pubKeyHex);

    const res = await relay.app.request(`/api/v1/agents/${motebitId}/credentials`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { motebit_id: string; credentials: unknown[] };
    expect(body.motebit_id).toBe(motebitId);
    expect(body.credentials).toEqual([]);
  });
});

describe("Credentials — Presentation", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(() => {
    relay.close();
  });

  it("returns 404 when no credentials exist for agent", async () => {
    const keypair = await generateKeypair();
    const pubKeyHex = bytesToHex(keypair.publicKey);
    const { motebitId } = await createIdentityAndDevice(relay, pubKeyHex);

    const res = await relay.app.request(`/api/v1/agents/${motebitId}/presentation`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    });
    expect(res.status).toBe(404);
  });
});
