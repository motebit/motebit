/**
 * BOOTED-ARTIFACT activation conformance for the identity→authz pipeline
 * link (docs/doctrine/composition-preserves-enforcement.md — the per-link
 * behavioral-severing ladder; this link's seam-reduction is
 * `mintAudienceToken` + `check-token-mint-canonical`).
 *
 * The incident this rung reproduces is f9d875b1 (relay-security follow-up
 * item 1): `market:query` was a REGISTERED audience — planner and CLI minted
 * it — but `/api/v1/market/candidates` sat under the master-only catch-all,
 * so every registered-but-rejected device token got 401 and sovereign
 * delegation broke at discovery. It hid because the two contract halves
 * never met: server tests used the master token, client tests mocked fetch.
 *
 * This suite makes the halves meet in the DEPLOYED ARTIFACT: it boots the
 * compiled `node dist/server.js` (the run.sh exec line), provisions an
 * identity + device key over the real HTTP API with the operator master
 * token (production-faithful: operators provision, clients mint), then
 * drives the EXACT client-shaped device token — minted through the same
 * `mintAudienceToken` seam every client uses — at the real route:
 *
 *  - accept-half: a `market:query` device token reaches market discovery
 *    (the f9d875b1 fix, observed from outside);
 *  - reject-half: the same key's `sync`-audience token is refused —
 *    cross-endpoint replay defense enforced in the artifact;
 *  - floor: no token at all is refused.
 *
 * Discriminating power (severing run, recorded in the PR): deleting the
 * `dualAuth(MARKET_QUERY_AUDIENCE)` carve-out in middleware.ts — the exact
 * f9d875b1 incident shape, the route falling back to the master-only
 * catch-all — turns the accept-half red at 401 while every in-process
 * mock-free assertion above it stays green. The reject-half guards the
 * OPPOSITE severing (an over-permissive wildcard swallowing the audience
 * check would turn IT red), so the pair discriminates in both directions.
 *
 * Rung choice: this suite boots only the compiled-dist rung. The
 * source-vs-dist differential is #359's suite's job (build-pipeline
 * fidelity); this suite targets link behavior, and one boot keeps the
 * marginal cost of each new link's pair low.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKeypair, mintAudienceToken, bytesToHex } from "@motebit/crypto";
import {
  BOOT_TIMEOUT_MS,
  DIST_TIER,
  bootRealEntry,
  killBootedEntry,
  type BootedEntry,
} from "./booted-entry-harness.js";

const MASTER_TOKEN = "booted-authz-master-token";

interface Provisioned {
  motebitId: string;
  deviceId: string;
  privateKey: Uint8Array;
}

/** Provision identity + device over the REAL HTTP API, as an operator would. */
async function provisionDevice(baseUrl: string): Promise<Provisioned> {
  const keypair = await generateKeypair();
  const identityRes = await fetch(`${baseUrl}/identity`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${MASTER_TOKEN}` },
    body: JSON.stringify({ owner_id: `owner-${crypto.randomUUID()}` }),
  });
  if (!identityRes.ok) {
    throw new Error(`provisioning /identity failed: ${identityRes.status}`);
  }
  const identity = (await identityRes.json()) as { motebit_id: string };
  const deviceRes = await fetch(`${baseUrl}/device/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${MASTER_TOKEN}` },
    body: JSON.stringify({
      motebit_id: identity.motebit_id,
      device_name: "booted-authz-probe",
      public_key: bytesToHex(keypair.publicKey),
    }),
  });
  if (!deviceRes.ok) {
    throw new Error(`provisioning /device/register failed: ${deviceRes.status}`);
  }
  const device = (await deviceRes.json()) as { device_id: string };
  return {
    motebitId: identity.motebit_id,
    deviceId: device.device_id,
    privateKey: keypair.privateKey,
  };
}

describe("booted entry — identity→authz link (audience binding enforced in the deployed artifact)", () => {
  let booted: BootedEntry | null = null;
  let device: Provisioned;

  beforeAll(async () => {
    booted = await bootRealEntry(DIST_TIER, { MOTEBIT_API_TOKEN: MASTER_TOKEN });
    device = await provisionDevice(booted.baseUrl);
  }, BOOT_TIMEOUT_MS);

  afterAll(() => {
    killBootedEntry(booted);
  });

  it("accepts the exact client-shaped market:query device token at market discovery (f9d875b1 accept-half)", async () => {
    const { token } = await mintAudienceToken(
      { mid: device.motebitId, did: device.deviceId, aud: "market:query" },
      device.privateKey,
    );
    const res = await fetch(`${booted!.baseUrl}/api/v1/market/candidates?capability=web-search`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    // Repair pointer on failure: a 401 here is the f9d875b1 class live in
    // the artifact — a registered audience the deployed route no longer
    // accepts. The carve-out is `dualAuth(MARKET_QUERY_AUDIENCE)` on
    // /api/v1/market/candidates in services/relay/src/middleware.ts.
    expect(res.status).toBe(200);
  });

  it("rejects the same key's sync-audience token there (cross-endpoint replay defense)", async () => {
    const { token } = await mintAudienceToken(
      { mid: device.motebitId, did: device.deviceId, aud: "sync" },
      device.privateKey,
    );
    const res = await fetch(`${booted!.baseUrl}/api/v1/market/candidates`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  it("rejects an unauthenticated request outright", async () => {
    const res = await fetch(`${booted!.baseUrl}/api/v1/market/candidates`);
    expect(res.status).toBe(401);
  });
});
