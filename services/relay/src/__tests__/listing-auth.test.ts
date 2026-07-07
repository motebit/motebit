/**
 * Service-listing route auth — the regression lock for a critical
 * ordering vulnerability found live on prod 2026-07-07.
 *
 * `registerListingsRoutes` was registered BEFORE `registerAgentRoutes`
 * installed the `/api/v1/agents/*` auth middleware. Hono applies
 * middleware only to routes registered after it, so GET/POST
 * `/api/v1/agents/:id/listing` ran UNAUTHENTICATED — and the POST
 * handler's `callerMotebitId !== :motebitId → 403` guard reads a value
 * only the middleware sets, so it silently no-op'd. Result: anyone
 * could overwrite any agent's listing, including `pay_to_address` —
 * the settlement destination `getAgentPricing` (tasks.ts) reads to
 * route payment. The fix registers listings after the middleware; this
 * suite hits the REAL app so the fix can never silently regress on a
 * future re-order.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct crypto
import { generateKeypair, bytesToHex } from "@motebit/crypto";
// eslint-disable-next-line no-restricted-imports -- tests mint their own bearer tokens
import { createSignedToken } from "@motebit/encryption";
import { createTestRelay, JSON_AUTH } from "./test-helpers.js";

async function seedAgent(relay: SyncRelay): Promise<{
  motebitId: string;
  deviceId: string;
  privateKey: Uint8Array;
}> {
  const kp = await generateKeypair();
  const idRes = await relay.app.request("/identity", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({ owner_id: `owner-${crypto.randomUUID()}` }),
  });
  const { motebit_id } = (await idRes.json()) as { motebit_id: string };
  const devRes = await relay.app.request("/device/register", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({ motebit_id, device_name: "T", public_key: bytesToHex(kp.publicKey) }),
  });
  const { device_id } = (await devRes.json()) as { device_id: string };
  return { motebitId: motebit_id, deviceId: device_id, privateKey: kp.privateKey };
}

function mintToken(mid: string, did: string, pk: Uint8Array, aud: string): Promise<string> {
  return createSignedToken(
    { mid, did, iat: Date.now(), exp: Date.now() + 5 * 60 * 1000, jti: crypto.randomUUID(), aud },
    pk,
  );
}

const LISTING_BODY = JSON.stringify({
  capabilities: ["web_search"],
  pricing: [{ capability: "web_search", unit_cost: 50000, currency: "USDC", per: "request" }],
  pay_to_address: "AttackerWalletAddress1111111111111111111111",
});

describe("service-listing route auth (regression lock for the 2026-07-07 ordering vuln)", () => {
  let relay: SyncRelay;
  beforeEach(async () => {
    relay = await createTestRelay();
  });
  afterEach(() => {
    relay.moteDb.db.close();
  });

  it("POST listing with NO token is rejected — the fund-routing write is closed", async () => {
    const a = await seedAgent(relay);
    const res = await relay.app.request(`/api/v1/agents/${a.motebitId}/listing`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: LISTING_BODY,
    });
    expect(res.status).toBe(401);
    // And nothing was written — getAgentPricing would find no listing.
    const row = relay.moteDb.db
      .prepare("SELECT 1 FROM relay_service_listings WHERE motebit_id = ?")
      .get(a.motebitId);
    expect(row).toBeUndefined();
  });

  it("POST listing with a wrong-agent token cannot overwrite another agent's pay_to_address", async () => {
    const victim = await seedAgent(relay);
    const attacker = await seedAgent(relay);
    const attackerToken = await mintToken(
      attacker.motebitId,
      attacker.deviceId,
      attacker.privateKey,
      "market:listing",
    );
    const res = await relay.app.request(`/api/v1/agents/${victim.motebitId}/listing`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${attackerToken}` },
      body: LISTING_BODY,
    });
    expect(res.status).toBe(403);
    const row = relay.moteDb.db
      .prepare("SELECT 1 FROM relay_service_listings WHERE motebit_id = ?")
      .get(victim.motebitId);
    expect(row).toBeUndefined();
  });

  it("an agent CAN publish its own listing with a device-bound market:listing token", async () => {
    const a = await seedAgent(relay);
    const token = await mintToken(a.motebitId, a.deviceId, a.privateKey, "market:listing");
    const res = await relay.app.request(`/api/v1/agents/${a.motebitId}/listing`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: LISTING_BODY,
    });
    expect(res.status).toBe(200);
  });

  it("GET listing without a token is rejected (market:listing audience enforced)", async () => {
    const a = await seedAgent(relay);
    const res = await relay.app.request(`/api/v1/agents/${a.motebitId}/listing`, { method: "GET" });
    expect(res.status).toBe(401);
  });
});

/**
 * Sibling-sweep lock (2026-07-07): the same middleware-ordering bug the
 * listing routes had also left credentials/trust-graph routes registered
 * before the auth middleware. The fix hoists the middleware early
 * (registerAgentAuthMiddleware, ordering-independent). These pin that the
 * previously-open routes now fail closed, and that the deliberate public
 * carve-outs stay open.
 */
describe("sibling-sweep: previously-bypassing agent routes now fail closed", () => {
  let relay: SyncRelay;
  beforeEach(async () => {
    relay = await createTestRelay();
  });
  afterEach(() => {
    relay.moteDb.db.close();
  });

  it("POST revoke-credential with no token is rejected (was: unauth mutation)", async () => {
    const a = await seedAgent(relay);
    const res = await relay.app.request(`/api/v1/agents/${a.motebitId}/revoke-credential`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential_id: "cred-x" }),
    });
    expect(res.status).toBe(401);
  });

  it("GET trust-closure / graph / routing-explanation with no token are rejected", async () => {
    const a = await seedAgent(relay);
    for (const path of ["trust-closure", "graph", "routing-explanation"]) {
      const res = await relay.app.request(`/api/v1/agents/${a.motebitId}/${path}`, {
        method: "GET",
      });
      expect(res.status, `${path} must fail closed`).toBe(401);
    }
  });

  it("credentials/submit stays permissive-by-signature (deliberate carve-out, no 401)", async () => {
    const a = await seedAgent(relay);
    const res = await relay.app.request(`/api/v1/agents/${a.motebitId}/credentials/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    // The handler runs (verifies the envelope signature itself) — it may
    // reject the empty body with 400, but MUST NOT 401 on missing bearer.
    expect(res.status).not.toBe(401);
  });

  it("GET credentials is now OWNER-PRIVATE — no token 401, another agent 403, own 200", async () => {
    // Flipped 2026-07-07 (Daniel's decision): credentials became
    // owner-private (caller===:motebitId) under the `credentials` audience.
    const victim = await seedAgent(relay);
    const noAuth = await relay.app.request(`/api/v1/agents/${victim.motebitId}/credentials`, {
      method: "GET",
    });
    expect(noAuth.status).toBe(401);

    const attacker = await seedAgent(relay);
    const attackerToken = await mintToken(
      attacker.motebitId,
      attacker.deviceId,
      attacker.privateKey,
      "credentials",
    );
    const crossed = await relay.app.request(`/api/v1/agents/${victim.motebitId}/credentials`, {
      method: "GET",
      headers: { Authorization: `Bearer ${attackerToken}` },
    });
    expect(crossed.status).toBe(403);

    const ownToken = await mintToken(
      victim.motebitId,
      victim.deviceId,
      victim.privateKey,
      "credentials",
    );
    const own = await relay.app.request(`/api/v1/agents/${victim.motebitId}/credentials`, {
      method: "GET",
      headers: { Authorization: `Bearer ${ownToken}` },
    });
    expect(own.status).toBe(200);
  });

  it("POST presentation is owner-private — no token 401, another agent 403", async () => {
    const victim = await seedAgent(relay);
    const noAuth = await relay.app.request(`/api/v1/agents/${victim.motebitId}/presentation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(noAuth.status).toBe(401);

    const attacker = await seedAgent(relay);
    const attackerToken = await mintToken(
      attacker.motebitId,
      attacker.deviceId,
      attacker.privateKey,
      "credentials:present",
    );
    const crossed = await relay.app.request(`/api/v1/agents/${victim.motebitId}/presentation`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${attackerToken}` },
    });
    expect(crossed.status).toBe(403);
  });
});
