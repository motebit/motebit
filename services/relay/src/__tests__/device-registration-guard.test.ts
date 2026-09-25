/**
 * Who may add a device to an identity that already exists.
 *
 * `register-self` and `bootstrap` are the relay's two PUBLIC registration
 * doors — no bearer, the request is its own auth. That is right for an
 * identity's first moment and wrong for every moment after it: a device
 * row's key is what `verifySignedTokenForDevice` verifies an owner token
 * against, so whoever can add a row can mint the owner's tokens.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import {
  generateKeypair,
  bytesToHex,
  signDeviceRegistration,
  mintAudienceToken,
} from "@motebit/crypto";
import type { KeyPair } from "@motebit/crypto";
import type { TokenAudience } from "@motebit/protocol";
import { createTestRelay } from "./test-helpers.js";
import { recordIdentityKey } from "../identity-keys.js";

let relay: SyncRelay;
let owner: KeyPair;
let stranger: KeyPair;
let motebitId: string;

const JSON_HEADERS = { "Content-Type": "application/json" };

async function registerSelf(mid: string, deviceId: string, kp: KeyPair) {
  const body = await signDeviceRegistration(
    {
      motebit_id: mid,
      device_id: deviceId,
      public_key: bytesToHex(kp.publicKey),
      device_name: "test",
      timestamp: Date.now(),
    },
    kp.privateKey,
  );
  const res = await relay.app.request("/api/v1/devices/register-self", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function bootstrap(mid: string, deviceId: string, kp: KeyPair) {
  const res = await relay.app.request("/api/v1/agents/bootstrap", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      motebit_id: mid,
      device_id: deviceId,
      public_key: bytesToHex(kp.publicKey),
    }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function asOwner(
  mid: string,
  deviceId: string,
  kp: KeyPair,
  aud: TokenAudience,
  path: string,
  init: RequestInit = {},
) {
  const { token } = await mintAudienceToken({ mid, did: deviceId, aud }, kp.privateKey);
  return relay.app.request(path, {
    ...init,
    headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` },
  });
}

/** The device rows as stored — what token auth will actually verify against. */
function deviceRows(mid: string): Array<{ device_id: string; public_key: string }> {
  return relay.moteDb.db
    .prepare("SELECT device_id, public_key FROM devices WHERE motebit_id = ? ORDER BY device_id")
    .all(mid) as Array<{ device_id: string; public_key: string }>;
}

beforeEach(async () => {
  relay = await createTestRelay();
  owner = await generateKeypair();
  stranger = await generateKeypair();
  motebitId = crypto.randomUUID();
  expect((await registerSelf(motebitId, "owner-laptop", owner)).status).toBe(201);
});

afterEach(async () => {
  await relay.close();
});

describe("register-self under an identity that already exists", () => {
  it("refuses a NEW device carrying a key the identity has never held", async () => {
    const { status, json } = await registerSelf(motebitId, "stranger-device", stranger);
    expect(status).toBe(409);
    expect(json.code).toBe("IDENTITY_KEY_CONFLICT");
    // Nothing was written: the refusal is not a half-registration.
    expect(deviceRows(motebitId).map((d) => d.device_id)).toEqual(["owner-laptop"]);
  });

  it("so a stranger's token is not the owner's — balance and withdraw both refuse it", async () => {
    await registerSelf(motebitId, "stranger-device", stranger);
    const balance = await asOwner(
      motebitId,
      "stranger-device",
      stranger,
      "account:balance",
      `/api/v1/agents/${motebitId}/balance`,
    );
    expect(balance.status).toBe(401);
    const withdraw = await asOwner(
      motebitId,
      "stranger-device",
      stranger,
      "account:withdraw",
      `/api/v1/agents/${motebitId}/withdraw`,
      { method: "POST", body: JSON.stringify({ amount: 1, destination: "stranger-wallet" }) },
    );
    expect(withdraw.status).toBe(401);
  });

  it("still admits a second machine that holds the identity's OWN key", async () => {
    // Link Device with key transfer, and restore-from-seed, both arrive
    // here: a fresh device_id, the same identity key.
    const { status } = await registerSelf(motebitId, "owner-vps", owner);
    expect(status).toBe(200);
    const res = await asOwner(
      motebitId,
      "owner-vps",
      owner,
      "account:balance",
      `/api/v1/agents/${motebitId}/balance`,
    );
    expect(res.status).toBe(200);
  });

  it("is still idempotent for the same device and key", async () => {
    expect((await registerSelf(motebitId, "owner-laptop", owner)).status).toBe(200);
  });

  it("still refuses the same device under a different key", async () => {
    const { status, json } = await registerSelf(motebitId, "owner-laptop", stranger);
    expect(status).toBe(409);
    expect(json.code).toBe("DEVICE_KEY_CONFLICT");
  });
});

describe("a device_id belongs to the identity that registered it", () => {
  it("register-self under ANOTHER identity cannot take it", async () => {
    // The device table is keyed by device_id alone, so a registration
    // that reuses a known id under a fresh motebit_id replaced the row —
    // moving the owner's device to someone else's identity.
    const theirs = crypto.randomUUID();
    const { status, json } = await registerSelf(theirs, "owner-laptop", stranger);
    expect(status).toBe(409);
    expect(json.code).toBe("DEVICE_ID_TAKEN");
    expect(deviceRows(motebitId)).toEqual([
      { device_id: "owner-laptop", public_key: bytesToHex(owner.publicKey) },
    ]);
    expect(deviceRows(theirs)).toEqual([]);
  });

  it("bootstrap under another identity cannot take it either", async () => {
    const theirs = crypto.randomUUID();
    const { status } = await bootstrap(theirs, "owner-laptop", stranger);
    expect(status).toBe(409);
    expect(deviceRows(motebitId)).toEqual([
      { device_id: "owner-laptop", public_key: bytesToHex(owner.publicKey) },
    ]);
    expect(deviceRows(theirs)).toEqual([]);
  });
});

describe("bootstrap shares the rule", () => {
  it("refuses a key the identity has never held", async () => {
    expect((await bootstrap(motebitId, "stranger-device", stranger)).status).toBe(409);
  });

  it("admits the identity's own key on a new device", async () => {
    expect((await bootstrap(motebitId, "owner-vps", owner)).status).toBe(200);
  });
});

describe("an identity whose registry key was blanked while its holder still answers", () => {
  it("is protected by its HOLDER key — the guard counts what auth will verify against (§5a A1, §5b L1)", async () => {
    // Round two of #747: auth verified against `identity_keys` while this
    // guard built "keys held" from devices + registry only, so a stranger's
    // key passed for an identity with no device row and a blank registry key.
    const serviceId = crypto.randomUUID();
    relay.moteDb.db
      .prepare(
        "INSERT INTO agent_registry (motebit_id, public_key, endpoint_url, registered_at, last_heartbeat, expires_at) VALUES (?, '', '', 1, 1, 9999999999999)",
      )
      .run(serviceId);
    recordIdentityKey(relay.moteDb.db, {
      motebitId: serviceId,
      publicKey: bytesToHex(owner.publicKey),
      source: "register",
      now: 1,
    });
    expect(deviceRows(serviceId)).toEqual([]);
    const s = await registerSelf(serviceId, "stranger-laptop", stranger);
    expect(s.status).toBe(409);
    expect(s.json["code"]).toBe("IDENTITY_KEY_CONFLICT");
    expect(deviceRows(serviceId)).toEqual([]);
    expect((await bootstrap(serviceId, "stranger-box", stranger)).status).toBe(409);
    // The owner's own key on a new machine is still admitted.
    expect((await registerSelf(serviceId, "owner-desk", owner)).status).toBe(201);
  });
});

describe("an identity known only to the agent registry", () => {
  it("is protected by its REGISTRY key — no device row is not no owner", async () => {
    // Service-mode motebits register through /agents/register and may
    // have no device row. Token auth falls back to the registry key, so
    // a first device row under a stranger's key would outrank it.
    const serviceId = crypto.randomUUID();
    const reg = await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: { ...JSON_HEADERS, Authorization: "Bearer test-token" },
      body: JSON.stringify({
        motebit_id: serviceId,
        endpoint_url: "http://localhost:9999/mcp",
        capabilities: ["web_search"],
        public_key: bytesToHex(owner.publicKey),
      }),
    });
    expect(reg.ok).toBe(true);
    expect((await registerSelf(serviceId, "stranger-device", stranger)).status).toBe(409);
    expect((await registerSelf(serviceId, "owner-device", owner)).status).toBeLessThan(300);
  });
});
