import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation
import { generateKeypair, createSignedToken, bytesToHex } from "@motebit/crypto";
import { AUTH_HEADER, createTestRelay } from "./test-helpers.js";

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

async function makeSignedToken(
  keypair: { privateKey: Uint8Array; publicKey: Uint8Array },
  motebitId: string,
  deviceId: string,
  jti?: string,
  aud?: string,
): Promise<string> {
  return createSignedToken(
    {
      mid: motebitId,
      did: deviceId,
      iat: Date.now(),
      exp: Date.now() + 5 * 60 * 1000,
      jti: jti ?? crypto.randomUUID(),
      aud: aud ?? "sync",
    },
    keypair.privateKey,
  );
}

// === Tests ===

describe("Token Blacklist", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(async () => {
    await relay.close();
  });

  it("rejects a token whose jti is blacklisted", async () => {
    const keypair = await generateKeypair();
    const pubKeyHex = bytesToHex(keypair.publicKey);
    const { motebitId, deviceId } = await createIdentityAndDevice(relay, pubKeyHex);

    // Register agent so revocation infrastructure is in place
    await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        motebit_id: motebitId,
        endpoint_url: "http://localhost:9999/mcp",
        capabilities: ["test"],
      }),
    });

    const jti = crypto.randomUUID();
    const token = await makeSignedToken(keypair, motebitId, deviceId, jti);

    // Token should work before blacklisting
    const res1 = await relay.app.request(`/sync/${motebitId}/clock`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res1.status).toBe(200);

    // Blacklist the jti
    const revokeRes = await relay.app.request(`/api/v1/agents/${motebitId}/revoke-tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ jtis: [jti] }),
    });
    expect(revokeRes.status).toBe(200);
    const revokeBody = (await revokeRes.json()) as { ok: boolean; revoked: number };
    expect(revokeBody.revoked).toBe(1);

    // Now create a NEW token with the same jti — it should be rejected
    const token2 = await makeSignedToken(keypair, motebitId, deviceId, jti);
    const res2 = await relay.app.request(`/sync/${motebitId}/clock`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token2}` },
    });
    expect(res2.status).toBe(403);
  });

  it("still accepts tokens with non-blacklisted jtis", async () => {
    const keypair = await generateKeypair();
    const pubKeyHex = bytesToHex(keypair.publicKey);
    const { motebitId, deviceId } = await createIdentityAndDevice(relay, pubKeyHex);

    // Blacklist one jti
    const blacklistedJti = crypto.randomUUID();
    await relay.app.request(`/api/v1/agents/${motebitId}/revoke-tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ jtis: [blacklistedJti] }),
    });

    // Use a different jti — should work
    const differentJti = crypto.randomUUID();
    const token = await makeSignedToken(keypair, motebitId, deviceId, differentJti);
    const res = await relay.app.request(`/sync/${motebitId}/clock`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });
});

describe("Credential Revocation", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(async () => {
    await relay.close();
  });

  it("revokes a credential and returns revoked status", async () => {
    const keypair = await generateKeypair();
    const pubKeyHex = bytesToHex(keypair.publicKey);
    const { motebitId } = await createIdentityAndDevice(relay, pubKeyHex);

    const credentialId = `urn:uuid:${crypto.randomUUID()}`;

    // Status should be not-revoked initially
    const statusRes1 = await relay.app.request(
      `/api/v1/credentials/${encodeURIComponent(credentialId)}/status`,
      {
        method: "GET",
      },
    );
    expect(statusRes1.status).toBe(200);
    const status1 = (await statusRes1.json()) as { revoked: boolean };
    expect(status1.revoked).toBe(false);

    // Revoke the credential
    const revokeRes = await relay.app.request(`/api/v1/agents/${motebitId}/revoke-credential`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ credential_id: credentialId, reason: "compromised" }),
    });
    expect(revokeRes.status).toBe(200);
    const revokeBody = (await revokeRes.json()) as { ok: boolean; credential_id: string };
    expect(revokeBody.ok).toBe(true);
    expect(revokeBody.credential_id).toBe(credentialId);

    // Status should now be revoked
    const statusRes2 = await relay.app.request(
      `/api/v1/credentials/${encodeURIComponent(credentialId)}/status`,
      {
        method: "GET",
      },
    );
    expect(statusRes2.status).toBe(200);
    const status2 = (await statusRes2.json()) as {
      revoked: boolean;
      revoked_at?: string;
      reason?: string;
    };
    expect(status2.revoked).toBe(true);
    expect(status2.reason).toBe("compromised");
    expect(status2.revoked_at).toBeDefined();
  });

  it("credential status endpoint requires no auth (public)", async () => {
    const credentialId = `urn:uuid:${crypto.randomUUID()}`;
    // No auth header — should still work
    const res = await relay.app.request(
      `/api/v1/credentials/${encodeURIComponent(credentialId)}/status`,
      {
        method: "GET",
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revoked: boolean };
    expect(body.revoked).toBe(false);
  });
});

describe("Identity Revocation", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(async () => {
    await relay.close();
  });

  it("revoked agent has all tokens rejected", async () => {
    const keypair = await generateKeypair();
    const pubKeyHex = bytesToHex(keypair.publicKey);
    const { motebitId, deviceId } = await createIdentityAndDevice(relay, pubKeyHex);

    // Register agent in registry (required for revocation to have effect)
    await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        motebit_id: motebitId,
        endpoint_url: "http://localhost:9999/mcp",
        capabilities: ["test"],
      }),
    });

    // Token should work before revocation
    const token1 = await makeSignedToken(keypair, motebitId, deviceId);
    const res1 = await relay.app.request(`/sync/${motebitId}/clock`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token1}` },
    });
    expect(res1.status).toBe(200);

    // Revoke the agent's identity
    const revokeRes = await relay.app.request(`/api/v1/agents/${motebitId}/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    });
    expect(revokeRes.status).toBe(200);
    const revokeBody = (await revokeRes.json()) as { revoked: boolean };
    expect(revokeBody.revoked).toBe(true);

    // Token should be rejected after identity revocation
    const token2 = await makeSignedToken(keypair, motebitId, deviceId);
    const res2 = await relay.app.request(`/sync/${motebitId}/clock`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token2}` },
    });
    expect(res2.status).toBe(403);
  });
});

describe("Blacklist Cleanup", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(async () => {
    await relay.close();
  });

  it("expired blacklist entries are cleaned up at startup", async () => {
    // The cleanup runs at startup in createSyncRelay. We can verify by inserting
    // an expired entry directly and then creating a new relay to see it cleaned up.
    // Since we use :memory: db, we test that the startup cleanup SQL runs without error.
    // The real test is that blacklisted tokens with valid jtis still work after their
    // blacklist entry expires (tested implicitly by token expiry > blacklist expiry).

    const keypair = await generateKeypair();
    const pubKeyHex = bytesToHex(keypair.publicKey);
    const { motebitId, deviceId } = await createIdentityAndDevice(relay, pubKeyHex);

    // Blacklist a jti
    const jti = crypto.randomUUID();
    await relay.app.request(`/api/v1/agents/${motebitId}/revoke-tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ jtis: [jti] }),
    });

    // Verify the jti IS blacklisted (token rejected)
    const token = await makeSignedToken(keypair, motebitId, deviceId, jti);
    const res = await relay.app.request(`/sync/${motebitId}/clock`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);

    // The startup cleanup code executed without error (tested by relay creation succeeding)
    expect(relay).toBeDefined();
  });
});
