import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SyncRelay } from "../index.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation
import { generateKeypair, createSignedToken, bytesToHex } from "@motebit/crypto";
import { API_TOKEN, AUTH_HEADER, createTestRelay } from "./test-helpers.js";

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

  // Create signed token for pairing (device auth)
  const authToken = await createSignedToken(
    {
      mid: identity.motebit_id,
      did: device.device_id,
      iat: Date.now(),
      exp: Date.now() + 5 * 60 * 1000,
      jti: crypto.randomUUID(),
      aud: "device:auth",
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

  afterEach(async () => {
    await relay.close();
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
      motebit_id: string;
    };
    expect(approveBody.device_id).toBeTruthy();
    expect(approveBody.motebit_id).toBe(motebitId);

    // 5. Status poll (Device B)
    const statusRes = await relay.app.request(`/pairing/${pairing_id}/status`);
    expect(statusRes.status).toBe(200);
    const status = (await statusRes.json()) as {
      status: string;
      device_id: string;
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

  // --- Expired code ---

  it("POST /pairing/claim rejects expired code", async () => {
    const { authToken } = await setupIdentityAndDevice(relay);

    const initRes = await relay.app.request("/pairing/initiate", {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const { pairing_code } = (await initRes.json()) as { pairing_code: string };

    // Advance time past 5-minute TTL
    const realNow = Date.now;
    vi.spyOn(Date, "now").mockReturnValue(realNow() + 6 * 60 * 1000);

    const keypairB = await generateKeypair();
    const pubKeyB = bytesToHex(keypairB.publicKey);
    const res = await relay.app.request("/pairing/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairing_code, device_name: "Mobile", public_key: pubKeyB }),
    });
    expect(res.status).toBe(410);

    vi.restoreAllMocks();
  });

  // --- Error paths ---

  it("GET /pairing/:id returns 404 for non-existent session", async () => {
    const { authToken } = await setupIdentityAndDevice(relay);
    const res = await relay.app.request("/pairing/non-existent-id", {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(404);
  });

  it("GET /pairing/:id returns 403 for wrong motebit owner", async () => {
    const deviceA = await setupIdentityAndDevice(relay);
    const deviceC = await setupIdentityAndDevice(relay);

    const initRes = await relay.app.request("/pairing/initiate", {
      method: "POST",
      headers: { Authorization: `Bearer ${deviceA.authToken}` },
    });
    const { pairing_id } = (await initRes.json()) as { pairing_id: string };

    const res = await relay.app.request(`/pairing/${pairing_id}`, {
      headers: { Authorization: `Bearer ${deviceC.authToken}` },
    });
    expect(res.status).toBe(403);
  });

  it("POST /pairing/:id/approve returns 404 for non-existent session", async () => {
    const { authToken } = await setupIdentityAndDevice(relay);
    const res = await relay.app.request("/pairing/non-existent-id/approve", {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(404);
  });

  it("POST /pairing/:id/approve returns 409 when session is pending (not claimed)", async () => {
    const { authToken } = await setupIdentityAndDevice(relay);

    const initRes = await relay.app.request("/pairing/initiate", {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const { pairing_id } = (await initRes.json()) as { pairing_id: string };

    // Try to approve without claiming first
    const res = await relay.app.request(`/pairing/${pairing_id}/approve`, {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(409);
  });

  it("POST /pairing/:id/deny returns 401 without auth", async () => {
    const res = await relay.app.request("/pairing/fake-id/deny", {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  it("POST /pairing/:id/deny returns 404 for non-existent session", async () => {
    const { authToken } = await setupIdentityAndDevice(relay);
    const res = await relay.app.request("/pairing/non-existent-id/deny", {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(404);
  });

  // --- Key transfer ---

  it("claim with x25519_pubkey stores it, approve with key_transfer stores it, status returns it", async () => {
    const deviceA = await setupIdentityAndDevice(relay);
    const initRes = await relay.app.request("/pairing/initiate", {
      method: "POST",
      headers: { Authorization: `Bearer ${deviceA.authToken}` },
    });
    const { pairing_id, pairing_code } = (await initRes.json()) as {
      pairing_id: string;
      pairing_code: string;
    };

    // Claim with x25519 ephemeral public key
    const keypairB = await generateKeypair();
    const pubKeyB = bytesToHex(keypairB.publicKey);
    const x25519Pub = "b".repeat(64);
    const claimRes = await relay.app.request("/pairing/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairing_code,
        device_name: "Mobile",
        public_key: pubKeyB,
        x25519_pubkey: x25519Pub,
      }),
    });
    expect(claimRes.status).toBe(200);

    // Session should include claiming_x25519_pubkey
    const sessionRes = await relay.app.request(`/pairing/${pairing_id}`, {
      headers: { Authorization: `Bearer ${deviceA.authToken}` },
    });
    const session = (await sessionRes.json()) as { claiming_x25519_pubkey?: string };
    expect(session.claiming_x25519_pubkey).toBe(x25519Pub);

    // Approve with key_transfer payload
    const keyTransfer = {
      x25519_pubkey: "a".repeat(64),
      encrypted_seed: "c".repeat(96),
      nonce: "d".repeat(24),
      tag: "e".repeat(32),
      identity_pubkey_check: deviceA.publicKeyHex,
    };
    const approveRes = await relay.app.request(`/pairing/${pairing_id}/approve`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deviceA.authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ key_transfer: keyTransfer }),
    });
    expect(approveRes.status).toBe(200);

    // Status should include key_transfer
    const statusRes = await relay.app.request(`/pairing/${pairing_id}/status`);
    const status = (await statusRes.json()) as {
      status: string;
      key_transfer?: Record<string, string>;
    };
    expect(status.status).toBe("approved");
    expect(status.key_transfer).toBeDefined();
    expect(status.key_transfer!.x25519_pubkey).toBe("a".repeat(64));
    expect(status.key_transfer!.identity_pubkey_check).toBe(deviceA.publicKeyHex);
  });

  it("POST /pairing/:id/update-key updates device public key", async () => {
    const deviceA = await setupIdentityAndDevice(relay);
    const initRes = await relay.app.request("/pairing/initiate", {
      method: "POST",
      headers: { Authorization: `Bearer ${deviceA.authToken}` },
    });
    const { pairing_id, pairing_code } = (await initRes.json()) as {
      pairing_id: string;
      pairing_code: string;
    };

    const keypairB = await generateKeypair();
    await relay.app.request("/pairing/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairing_code,
        device_name: "Mobile",
        public_key: bytesToHex(keypairB.publicKey),
      }),
    });

    await relay.app.request(`/pairing/${pairing_id}/approve`, {
      method: "POST",
      headers: { Authorization: `Bearer ${deviceA.authToken}` },
    });

    // Update device B's key
    const newKey = "f".repeat(64);
    const updateRes = await relay.app.request(`/pairing/${pairing_id}/update-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ public_key: newKey }),
    });
    expect(updateRes.status).toBe(200);
    const updateBody = (await updateRes.json()) as { ok: boolean };
    expect(updateBody.ok).toBe(true);
  });

  it("POST /pairing/:id/update-key rejects invalid public key", async () => {
    const res = await relay.app.request("/pairing/fake-id/update-key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ public_key: "not-hex" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /pairing/:id/update-key returns 404 for non-existent session", async () => {
    const res = await relay.app.request("/pairing/non-existent/update-key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ public_key: "a".repeat(64) }),
    });
    expect(res.status).toBe(404);
  });

  it("POST /pairing/:id/update-key returns 409 for unapproved session", async () => {
    const { authToken } = await setupIdentityAndDevice(relay);
    const initRes = await relay.app.request("/pairing/initiate", {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const { pairing_id } = (await initRes.json()) as { pairing_id: string };

    const res = await relay.app.request(`/pairing/${pairing_id}/update-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ public_key: "a".repeat(64) }),
    });
    expect(res.status).toBe(409);
  });

  it("POST /pairing/:id/deny returns 403 for wrong motebit owner", async () => {
    const deviceA = await setupIdentityAndDevice(relay);
    const deviceC = await setupIdentityAndDevice(relay);

    const initRes = await relay.app.request("/pairing/initiate", {
      method: "POST",
      headers: { Authorization: `Bearer ${deviceA.authToken}` },
    });
    const { pairing_id } = (await initRes.json()) as { pairing_id: string };

    const res = await relay.app.request(`/pairing/${pairing_id}/deny`, {
      method: "POST",
      headers: { Authorization: `Bearer ${deviceC.authToken}` },
    });
    expect(res.status).toBe(403);
  });
});
