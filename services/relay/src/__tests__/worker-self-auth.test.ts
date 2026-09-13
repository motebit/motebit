/**
 * Worker-to-relay self-authentication — the contract the master-token
 * retirement (2026-09-13) depends on.
 *
 * A service that has never spoken to this relay must be able to run its whole
 * lifecycle with NOTHING but its own Ed25519 key:
 *
 *   bootstrap (public) → register → listing → heartbeat → GET /agents/:id → deregister
 *
 * Every authenticated hop carries a short-lived token the worker signed itself,
 * bound to the audience the route expects (`admin:query` for the registration
 * family, `market:listing` for the listing). No request in this file presents
 * the relay's master token. Before this arc every first-party worker did, and
 * the relay accepted it — so nothing here failed; the blast radius was simply
 * never measured. These tests measure it: if the relay ever requires the
 * master token again on any of these hops, a worker cannot exist without
 * holding operator authority, and this file goes red.
 *
 * Negative space is asserted too: a signed token for an identity the relay has
 * never seen is refused (bootstrap is the introduction, not a formality), and
 * a token bound to the wrong audience is refused (audience binding is not
 * relaxed for self-registration).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
// eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation
import { generateKeypair, bytesToHex, createSignedToken } from "@motebit/encryption";
import type { TokenAudience } from "@motebit/protocol";
import type { SyncRelay } from "../index.js";
import { createTestRelay } from "./test-helpers.js";

const JSON_ONLY = { "Content-Type": "application/json" };

describe("worker self-auth — a service authenticates to its relay with its own key only", () => {
  let relay: SyncRelay;
  let kp: { publicKey: Uint8Array; privateKey: Uint8Array };
  let pubKeyHex: string;
  const motebitId = `worker-${crypto.randomUUID()}`;
  const deviceId = "worker-primary";

  const mint = async (aud: TokenAudience, mid = motebitId, did = deviceId): Promise<string> =>
    createSignedToken(
      {
        mid,
        did,
        iat: Date.now(),
        exp: Date.now() + 5 * 60 * 1000,
        jti: crypto.randomUUID(),
        aud,
      },
      kp.privateKey,
    );
  const signed = async (aud: TokenAudience): Promise<Record<string, string>> => ({
    ...JSON_ONLY,
    Authorization: `Bearer ${await mint(aud)}`,
  });

  beforeEach(async () => {
    relay = await createTestRelay();
    kp = await generateKeypair();
    pubKeyHex = bytesToHex(kp.publicKey);
  });
  afterEach(async () => {
    await relay.close();
  });

  it("refuses a self-signed registration from an identity the relay has never seen (bootstrap is the introduction)", async () => {
    const res = await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: await signed("admin:query"),
      body: JSON.stringify({
        endpoint_url: "http://127.0.0.1:4100/mcp",
        capabilities: ["echo"],
        public_key: pubKeyHex,
      }),
    });
    expect(res.status).toBe(401);
  });

  it("runs the whole lifecycle — bootstrap, register, listing, heartbeat, lookup, deregister — with no master token anywhere", async () => {
    // 1. Public introduction: the relay learns the key it will verify us with.
    const boot = await relay.app.request("/api/v1/agents/bootstrap", {
      method: "POST",
      headers: JSON_ONLY,
      body: JSON.stringify({ motebit_id: motebitId, device_id: deviceId, public_key: pubKeyHex }),
    });
    expect(boot.status).toBe(201);
    expect(((await boot.json()) as { device_id: string }).device_id).toBe(deviceId);

    // Idempotent on (id, key): a restart re-introducing itself is a 200, not a conflict.
    const again = await relay.app.request("/api/v1/agents/bootstrap", {
      method: "POST",
      headers: JSON_ONLY,
      body: JSON.stringify({ motebit_id: motebitId, device_id: deviceId, public_key: pubKeyHex }),
    });
    expect(again.status).toBe(200);

    // 2. Register with a self-signed admin:query bearer. The token's `mid` is
    //    the registered identity — no motebit_id in the body is needed.
    const reg = await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: await signed("admin:query"),
      body: JSON.stringify({
        endpoint_url: "http://127.0.0.1:4100/mcp",
        capabilities: ["echo"],
        public_key: pubKeyHex,
        metadata: { name: "self-auth-worker" },
      }),
    });
    expect(reg.status).toBe(200);

    // 3. Publish a listing under market:listing, scoped to our own id.
    const listing = await relay.app.request(`/api/v1/agents/${motebitId}/listing`, {
      method: "POST",
      headers: await signed("market:listing"),
      body: JSON.stringify({
        capabilities: ["echo"],
        pricing: [{ capability: "echo", unit_cost: 0, currency: "USD", per: "call" }],
        description: "self-auth worker",
      }),
    });
    expect(listing.status).toBe(200);

    // 4. Heartbeat under admin:query — the token identifies us; no body id needed.
    const hb = await relay.app.request("/api/v1/agents/heartbeat", {
      method: "POST",
      headers: await signed("admin:query"),
      body: JSON.stringify({}),
    });
    expect(hb.status).toBe(200);

    // 5. The registry row is readable with our own signed token (the
    //    caller-key fallback the inbound verifier uses for sleeping agents).
    const row = await relay.app.request(`/api/v1/agents/${motebitId}`, {
      headers: { Authorization: `Bearer ${await mint("admin:query")}` },
    });
    expect(row.status).toBe(200);
    expect(((await row.json()) as { public_key: string }).public_key).toBe(pubKeyHex);

    // 6. And the identity-transparency bundle — the PUBLIC key lookup the
    //    inbound verifier tries first — needs no bearer at all.
    const bundle = await relay.app.request(`/api/v1/identity/${motebitId}`);
    expect(bundle.status).toBe(200);
    expect(((await bundle.json()) as { current_public_key: string }).current_public_key).toBe(
      pubKeyHex,
    );

    // 7. Deregister with the signed token. (Under the master token this route
    //    had no caller id and answered 400 — the self-signed path is the one
    //    that actually works.)
    const dereg = await relay.app.request("/api/v1/agents/deregister", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${await mint("admin:query")}` },
    });
    expect(dereg.status).toBe(200);
    const gone = await relay.app.request(`/api/v1/agents/${motebitId}`, {
      headers: { Authorization: `Bearer ${await mint("admin:query")}` },
    });
    expect(gone.status).toBe(404);
  });

  it("keeps audience binding strict on the self-registration family", async () => {
    await relay.app.request("/api/v1/agents/bootstrap", {
      method: "POST",
      headers: JSON_ONLY,
      body: JSON.stringify({ motebit_id: motebitId, device_id: deviceId, public_key: pubKeyHex }),
    });

    // A task:submit token replayed against register is refused.
    const wrongAud = await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: await signed("task:submit"),
      body: JSON.stringify({
        endpoint_url: "http://127.0.0.1:4100/mcp",
        capabilities: ["echo"],
        public_key: pubKeyHex,
      }),
    });
    expect(wrongAud.status).toBe(401);

    // And a listing under admin:query is refused — the listing wants market:listing.
    const wrongListing = await relay.app.request(`/api/v1/agents/${motebitId}/listing`, {
      method: "POST",
      headers: await signed("admin:query"),
      body: JSON.stringify({ capabilities: ["echo"], pricing: [] }),
    });
    expect(wrongListing.status).toBe(401);
  });

  it("refuses a bootstrap that tries to rebind a known identity to a different key (hijack guard)", async () => {
    await relay.app.request("/api/v1/agents/bootstrap", {
      method: "POST",
      headers: JSON_ONLY,
      body: JSON.stringify({ motebit_id: motebitId, device_id: deviceId, public_key: pubKeyHex }),
    });
    const other = await generateKeypair();
    const res = await relay.app.request("/api/v1/agents/bootstrap", {
      method: "POST",
      headers: JSON_ONLY,
      body: JSON.stringify({
        motebit_id: motebitId,
        device_id: deviceId,
        public_key: bytesToHex(other.publicKey),
      }),
    });
    expect(res.status).toBe(409);
  });
});
