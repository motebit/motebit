import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSyncRelay } from "../index.js";
import type { SyncRelay } from "../index.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation
import { generateKeypair, createSignedToken } from "@motebit/crypto";

// === Helpers ===

const API_TOKEN = "test-token";
const AUTH_HEADER = { Authorization: `Bearer ${API_TOKEN}` };

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function createTestRelay(): Promise<SyncRelay> {
  return createSyncRelay({
    apiToken: API_TOKEN,
    enableDeviceAuth: true,
    verifyDeviceSignature: true,
  });
}

async function setupIdentityAndDevice(relay: SyncRelay): Promise<{
  motebitId: string;
  deviceId: string;
  publicKeyHex: string;
  privateKeyHex: string;
  authToken: string;
}> {
  // Create identity
  const identityRes = await relay.app.request("/identity", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({ owner_id: "test-owner" }),
  });
  const identity = (await identityRes.json()) as { motebit_id: string };

  // Generate keypair
  const keypair = await generateKeypair();
  const publicKeyHex = bytesToHex(keypair.publicKey);
  const privateKeyHex = bytesToHex(keypair.privateKey);

  // Register device
  const deviceRes = await relay.app.request("/device/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({
      motebit_id: identity.motebit_id,
      device_name: "Test Desktop",
      public_key: publicKeyHex,
    }),
  });
  const device = (await deviceRes.json()) as { device_id: string };

  // Create signed token
  const authToken = await createSignedToken(
    {
      mid: identity.motebit_id,
      did: device.device_id,
      iat: Date.now(),
      exp: Date.now() + 5 * 60 * 1000,
    },
    keypair.privateKey,
  );

  return {
    motebitId: identity.motebit_id,
    deviceId: device.device_id,
    publicKeyHex,
    privateKeyHex,
    authToken,
  };
}

// === Tests ===

describe("Pairing Protocol", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(() => {
    relay.close();
  });

  // --- Initiate ---

  it("POST /pairing/initiate creates a pairing session", async () => {
    const { authToken } = await setupIdentityAndDevice(relay);

    const res = await relay.app.request("/pairing/initiate", {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      pairing_id: string;
      pairing_code: string;
      expires_at: number;
    };
    expect(body.pairing_id).toBeTruthy();
    expect(body.pairing_code).toMatch(/^[A-Z2-9]{6}$/);
    expect(body.expires_at).toBeGreaterThan(Date.now());
  });

  it("POST /pairing/initiate rejects without signed token", async () => {
    const res = await relay.app.request("/pairing/initiate", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_TOKEN}` },
    });
    expect(res.status).toBe(401);
  });

  // --- Claim ---

  it("POST /pairing/claim succeeds with valid code", async () => {
    const { authToken, motebitId } = await setupIdentityAndDevice(relay);

    // Initiate
    const initRes = await relay.app.request("/pairing/initiate", {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const { pairing_code } = (await initRes.json()) as { pairing_code: string };

    // Generate keypair for Device B
    const keypairB = await generateKeypair();
    const pubKeyB = bytesToHex(keypairB.publicKey);

    // Claim (no auth)
    const claimRes = await relay.app.request("/pairing/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairing_code: pairing_code,
        device_name: "Mobile",
        public_key: pubKeyB,
      }),
    });

    expect(claimRes.status).toBe(200);
    const claimBody = (await claimRes.json()) as { pairing_id: string; motebit_id: string };
    expect(claimBody.pairing_id).toBeTruthy();
    expect(claimBody.motebit_id).toBe(motebitId);
  });

  it("POST /pairing/claim rejects invalid code format", async () => {
    const res = await relay.app.request("/pairing/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairing_code: "abc",
        device_name: "Mobile",
        public_key: "a".repeat(64),
      }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /pairing/claim rejects non-existent code", async () => {
    const res = await relay.app.request("/pairing/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairing_code: "ABCDEF",
        device_name: "Mobile",
        public_key: "a".repeat(64),
      }),
    });
    expect(res.status).toBe(404);
  });

  it("POST /pairing/claim rejects double-claim", async () => {
    const { authToken } = await setupIdentityAndDevice(relay);

    const initRes = await relay.app.request("/pairing/initiate", {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const { pairing_code } = (await initRes.json()) as { pairing_code: string };

    const keypairB = await generateKeypair();
    const pubKeyB = bytesToHex(keypairB.publicKey);

    // First claim
    await relay.app.request("/pairing/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairing_code, device_name: "Mobile", public_key: pubKeyB }),
    });

    // Second claim
    const res = await relay.app.request("/pairing/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairing_code, device_name: "Mobile2", public_key: pubKeyB }),
    });
    expect(res.status).toBe(409);
  });

  it("POST /pairing/claim rejects invalid public key", async () => {
    const { authToken } = await setupIdentityAndDevice(relay);

    const initRes = await relay.app.request("/pairing/initiate", {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const { pairing_code } = (await initRes.json()) as { pairing_code: string };

    const res = await relay.app.request("/pairing/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairing_code, device_name: "Mobile", public_key: "not-a-valid-key" }),
    });
    expect(res.status).toBe(400);
  });

  // --- Full lifecycle ---

  it("full lifecycle: initiate → claim → approve → device registered", async () => {
    const { authToken, motebitId } = await setupIdentityAndDevice(relay);

    // 1. Initiate
    const initRes = await relay.app.request("/pairing/initiate", {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const { pairing_id, pairing_code } = (await initRes.json()) as {
      pairing_id: string;
      pairing_code: string;
    };

    // 2. Claim
    const keypairB = await generateKeypair();
    const pubKeyB = bytesToHex(keypairB.publicKey);
    await relay.app.request("/pairing/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairing_code, device_name: "Mobile", public_key: pubKeyB }),
    });

    // 3. Poll session (Device A)
    const sessionRes = await relay.app.request(`/pairing/${pairing_id}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(sessionRes.status).toBe(200);
    const session = (await sessionRes.json()) as { status: string; claiming_device_name: string };
    expect(session.status).toBe("claimed");
    expect(session.claiming_device_name).toBe("Mobile");

    // 4. Approve
    const approveRes = await relay.app.request(`/pairing/${pairing_id}/approve`, {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(approveRes.status).toBe(200);
    const approveBody = (await approveRes.json()) as {
      device_id: string;
      device_token: string;
      motebit_id: string;
    };
    expect(approveBody.device_id).toBeTruthy();
    expect(approveBody.device_token).toBeTruthy();
    expect(approveBody.motebit_id).toBe(motebitId);

    // 5. Status poll (Device B)
    const statusRes = await relay.app.request(`/pairing/${pairing_id}/status`);
    expect(statusRes.status).toBe(200);
    const status = (await statusRes.json()) as {
      status: string;
      device_id: string;
      device_token: string;
      motebit_id: string;
    };
    expect(status.status).toBe("approved");
    expect(status.device_id).toBe(approveBody.device_id);
    expect(status.motebit_id).toBe(motebitId);
  });

  // --- Deny ---

  it("deny flow: initiate → claim → deny", async () => {
    const { authToken } = await setupIdentityAndDevice(relay);

    const initRes = await relay.app.request("/pairing/initiate", {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const { pairing_id, pairing_code } = (await initRes.json()) as {
      pairing_id: string;
      pairing_code: string;
    };

    const keypairB = await generateKeypair();
    const pubKeyB = bytesToHex(keypairB.publicKey);
    await relay.app.request("/pairing/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairing_code, device_name: "Mobile", public_key: pubKeyB }),
    });

    const denyRes = await relay.app.request(`/pairing/${pairing_id}/deny`, {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(denyRes.status).toBe(200);

    const statusRes = await relay.app.request(`/pairing/${pairing_id}/status`);
    const status = (await statusRes.json()) as { status: string };
    expect(status.status).toBe("denied");
  });

  // --- Access control ---

  it("GET /pairing/:id rejects unauthenticated requests", async () => {
    const res = await relay.app.request("/pairing/fake-id", {
      headers: {},
    });
    expect(res.status).toBe(401);
  });

  it("POST /pairing/:id/approve rejects wrong motebit owner", async () => {
    const deviceA = await setupIdentityAndDevice(relay);
    const deviceC = await setupIdentityAndDevice(relay);

    const initRes = await relay.app.request("/pairing/initiate", {
      method: "POST",
      headers: { Authorization: `Bearer ${deviceA.authToken}` },
    });
    const { pairing_id, pairing_code } = (await initRes.json()) as {
      pairing_id: string;
      pairing_code: string;
    };

    const keypairB = await generateKeypair();
    const pubKeyB = bytesToHex(keypairB.publicKey);
    await relay.app.request("/pairing/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairing_code, device_name: "Mobile", public_key: pubKeyB }),
    });

    // Device C (different motebit) tries to approve
    const approveRes = await relay.app.request(`/pairing/${pairing_id}/approve`, {
      method: "POST",
      headers: { Authorization: `Bearer ${deviceC.authToken}` },
    });
    expect(approveRes.status).toBe(403);
  });

  // --- Status endpoint ---

  it("GET /pairing/:id/status returns pending for unclaimed session", async () => {
    const { authToken } = await setupIdentityAndDevice(relay);

    const initRes = await relay.app.request("/pairing/initiate", {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const { pairing_id } = (await initRes.json()) as { pairing_id: string };

    const statusRes = await relay.app.request(`/pairing/${pairing_id}/status`);
    expect(statusRes.status).toBe(200);
    const status = (await statusRes.json()) as { status: string; motebit_id?: string };
    expect(status.status).toBe("pending");
    expect(status.motebit_id).toBeUndefined();
  });

  it("GET /pairing/:id/status returns 404 for non-existent session", async () => {
    const res = await relay.app.request("/pairing/non-existent-id/status");
    expect(res.status).toBe(404);
  });
});
