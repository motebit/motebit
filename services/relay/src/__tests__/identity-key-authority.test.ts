/**
 * Who may change what this relay believes an identity's key is.
 *
 * Rotation is the remedy for a lost or stolen machine, so it has to END
 * the old key here, not merely record a newer one. It did not: a device
 * row keeps the key it was registered with, a device row's key is what
 * `verifySignedTokenForDevice` verifies an owner token against, and
 * rotation never touched device rows. The holder of a rotated-away key
 * stayed a full first-person principal — and the registration door let
 * any first-person principal install a guardian vouched for by nobody
 * but that guardian, after which guardian recovery moves the identity to
 * a key of the caller's choosing.
 *
 * Three rules, each tested from the side of the party it refuses:
 *
 *  1. A succession is recorded only under the caller's OWN identity, and
 *     only when it departs from a key that identity holds here.
 *  2. Recording a succession re-keys, in the same step, every device row
 *     that held the old key. A device linked under its own key is not
 *     the identity's key and is left alone.
 *  3. A guardian is installed only by a caller whose token was verified
 *     under the identity key itself, and an installed guardian is never
 *     replaced by registration.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import {
  generateKeypair,
  bytesToHex,
  signDeviceRegistration,
  mintAudienceToken,
  signKeySuccession,
  signGuardianRecoverySuccession,
  canonicalJson,
  ed25519Sign,
} from "@motebit/crypto";
import type { KeyPair } from "@motebit/crypto";
import type { TokenAudience } from "@motebit/protocol";
import { createTestRelay } from "./test-helpers.js";

let relay: SyncRelay;
let motebitId: string;
let k1: KeyPair;
let k2: KeyPair;

const JSON_HEADERS = { "Content-Type": "application/json" };
const hex = (kp: KeyPair) => bytesToHex(kp.publicKey);

async function registerSelf(mid: string, deviceId: string, kp: KeyPair): Promise<number> {
  const body = await signDeviceRegistration(
    {
      motebit_id: mid,
      device_id: deviceId,
      public_key: hex(kp),
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
  return res.status;
}

async function as(
  mid: string,
  deviceId: string,
  kp: KeyPair,
  path: string,
  body?: unknown,
  aud: TokenAudience = "admin:query",
): Promise<{ status: number; json: Record<string, unknown> }> {
  const { token } = await mintAudienceToken({ mid, did: deviceId, aud }, kp.privateKey);
  const res = await relay.app.request(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: res.status,
    json: (await res.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

const registerAgent = (deviceId: string, kp: KeyPair, identityKey: KeyPair, extra: object = {}) =>
  as(motebitId, deviceId, kp, "/api/v1/agents/register", {
    endpoint_url: "http://localhost:9999/mcp",
    capabilities: [],
    public_key: hex(identityKey),
    ...extra,
  });

const rotate = (deviceId: string, kp: KeyPair, record: unknown, mid: string = motebitId) =>
  as(motebitId, deviceId, kp, `/api/v1/agents/${mid}/rotate-key`, record);

/** A guardian key and the attestation the registration door asks for — signed by the guardian alone. */
async function guardianFor(mid: string): Promise<{ kp: KeyPair; fields: object }> {
  const kp = await generateKeypair();
  const attestation = await ed25519Sign(
    new TextEncoder().encode(
      canonicalJson({
        action: "guardian_attestation",
        guardian_public_key: hex(kp),
        motebit_id: mid,
      }),
    ),
    kp.privateKey,
  );
  return {
    kp,
    fields: { guardian_public_key: hex(kp), guardian_attestation: bytesToHex(attestation) },
  };
}

/** A device linked WITHOUT key transfer: a row under the identity, holding its own key. */
function linkDevice(deviceId: string, kp: KeyPair): void {
  relay.moteDb.db
    .prepare(
      "INSERT INTO devices (device_id, motebit_id, device_token, public_key, registered_at, device_name) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(deviceId, motebitId, crypto.randomUUID(), hex(kp), Date.now(), "linked");
}

function registry(mid: string): { public_key: string; guardian_public_key: string | null } {
  return relay.moteDb.db
    .prepare("SELECT public_key, guardian_public_key FROM agent_registry WHERE motebit_id = ?")
    .get(mid) as { public_key: string; guardian_public_key: string | null };
}
function deviceKey(deviceId: string): string {
  return (
    relay.moteDb.db.prepare("SELECT public_key FROM devices WHERE device_id = ?").get(deviceId) as {
      public_key: string;
    }
  ).public_key;
}
function successionCount(mid: string): number {
  return (
    relay.moteDb.db
      .prepare("SELECT COUNT(*) AS n FROM relay_key_successions WHERE motebit_id = ?")
      .get(mid) as { n: number }
  ).n;
}

beforeEach(async () => {
  relay = await createTestRelay();
  motebitId = crypto.randomUUID();
  k1 = await generateKeypair();
  k2 = await generateKeypair();
  expect(await registerSelf(motebitId, "laptop", k1)).toBe(201);
  // A second machine under an identity that exists answers 200, not 201.
  expect(await registerSelf(motebitId, "vps", k1)).toBe(200);
  expect((await registerAgent("laptop", k1, k1)).status).toBe(200);
});

afterEach(async () => {
  await relay.close();
});

describe("rule 1 — a succession is the identity's own act", () => {
  it("refuses a succession presented under another identity's token", async () => {
    const stranger = crypto.randomUUID();
    const sk = await generateKeypair();
    expect(await registerSelf(stranger, "s-laptop", sk)).toBe(201);
    const record = await signKeySuccession(
      k1.privateKey,
      k2.privateKey,
      k2.publicKey,
      k1.publicKey,
    );
    // Even a GENUINE record: whose hand carries it is part of the act.
    const { token } = await mintAudienceToken(
      { mid: stranger, did: "s-laptop", aud: "admin:query" },
      sk.privateKey,
    );
    const res = await relay.app.request(`/api/v1/agents/${motebitId}/rotate-key`, {
      method: "POST",
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` },
      body: JSON.stringify(record),
    });
    expect(res.status).toBe(403);
    expect(successionCount(motebitId)).toBe(0);
    expect(registry(motebitId).public_key).toBe(hex(k1));
  });

  it("refuses a succession that departs from a key the identity never held here", async () => {
    // An identity with device rows and NO registry row — nothing pinned the old key before.
    const bare = crypto.randomUUID();
    const bk = await generateKeypair();
    expect(await registerSelf(bare, "b-laptop", bk)).toBe(201);
    const a = await generateKeypair();
    const b = await generateKeypair();
    const junk = await signKeySuccession(a.privateKey, b.privateKey, b.publicKey, a.publicKey);
    const res = await as(bare, "b-laptop", bk, `/api/v1/agents/${bare}/rotate-key`, junk);
    expect(res.status).toBe(400);
    expect(successionCount(bare)).toBe(0);
  });

  it("still records a genuine first rotation for an identity with no registry row", async () => {
    const bare = crypto.randomUUID();
    const bk = await generateKeypair();
    const bk2 = await generateKeypair();
    expect(await registerSelf(bare, "b-laptop", bk)).toBe(201);
    const record = await signKeySuccession(
      bk.privateKey,
      bk2.privateKey,
      bk2.publicKey,
      bk.publicKey,
    );
    const res = await as(bare, "b-laptop", bk, `/api/v1/agents/${bare}/rotate-key`, record);
    expect(res.status).toBe(200);
    expect(successionCount(bare)).toBe(1);
  });
});

describe("rule 2 — a rotation ends the old key here", () => {
  it("re-keys every device row that held the old key, and leaves a linked device's own key alone", async () => {
    const linked = await generateKeypair();
    linkDevice("tablet", linked);
    const record = await signKeySuccession(
      k1.privateKey,
      k2.privateKey,
      k2.publicKey,
      k1.publicKey,
    );
    expect((await rotate("laptop", k1, record)).status).toBe(200);
    expect(deviceKey("laptop")).toBe(hex(k2));
    expect(deviceKey("vps")).toBe(hex(k2));
    expect(deviceKey("tablet")).toBe(hex(linked));
    expect(registry(motebitId).public_key).toBe(hex(k2));
  });

  it("so the old key is no longer a credential, and the new one is — on every machine", async () => {
    const record = await signKeySuccession(
      k1.privateKey,
      k2.privateKey,
      k2.publicKey,
      k1.publicKey,
    );
    expect((await rotate("laptop", k1, record)).status).toBe(200);
    const path = `/api/v1/agents/${motebitId}/balance`;
    for (const device of ["laptop", "vps"]) {
      expect((await as(motebitId, device, k1, path, undefined, "account:balance")).status).toBe(
        401,
      );
      expect((await as(motebitId, device, k2, path, undefined, "account:balance")).status).toBe(
        200,
      );
    }
  });

  it("the registration door's succession path re-keys the same way", async () => {
    const record = await signKeySuccession(
      k1.privateKey,
      k2.privateKey,
      k2.publicKey,
      k1.publicKey,
    );
    const res = await registerAgent("laptop", k1, k2, { succession: record });
    expect(res.status).toBe(200);
    expect(registry(motebitId).public_key).toBe(hex(k2));
    expect(deviceKey("laptop")).toBe(hex(k2));
    expect(deviceKey("vps")).toBe(hex(k2));
  });

  it("the whole sequence: after rotation, the holder of the old key cannot take the identity", async () => {
    const record = await signKeySuccession(
      k1.privateKey,
      k2.privateKey,
      k2.publicKey,
      k1.publicKey,
    );
    expect((await rotate("laptop", k1, record)).status).toBe(200);

    const thiefKey = await generateKeypair();
    const guardian = await guardianFor(motebitId);
    const install = await registerAgent("laptop", k1, k2, guardian.fields);
    expect(install.status).toBe(401);
    const recovery = await signGuardianRecoverySuccession(
      guardian.kp.privateKey,
      thiefKey.privateKey,
      k2.publicKey,
      thiefKey.publicKey,
    );
    expect((await rotate("laptop", k1, recovery)).status).toBe(401);

    expect(registry(motebitId)).toEqual({ public_key: hex(k2), guardian_public_key: null });
    expect(successionCount(motebitId)).toBe(1);
  });
});

describe("rule 3 — a guardian is installed by the identity key, once", () => {
  it("refuses a guardian from a linked device, whose token proves only its own key", async () => {
    const linked = await generateKeypair();
    linkDevice("tablet", linked);
    const guardian = await guardianFor(motebitId);
    const res = await registerAgent("tablet", linked, k1, guardian.fields);
    expect(res.status).toBe(403);
    expect(registry(motebitId).guardian_public_key).toBeNull();
  });

  it("so a linked device cannot recover the identity to a key of its own", async () => {
    const linked = await generateKeypair();
    linkDevice("tablet", linked);
    const guardian = await guardianFor(motebitId);
    await registerAgent("tablet", linked, k1, guardian.fields);
    const mine = await generateKeypair();
    const recovery = await signGuardianRecoverySuccession(
      guardian.kp.privateKey,
      mine.privateKey,
      k1.publicKey,
      mine.publicKey,
    );
    const res = await rotate("tablet", linked, recovery);
    expect(res.status).toBe(400);
    expect(registry(motebitId).public_key).toBe(hex(k1));
  });

  it("installs a guardian for the identity key, and guardian recovery then works", async () => {
    const guardian = await guardianFor(motebitId);
    expect((await registerAgent("laptop", k1, k1, guardian.fields)).status).toBe(200);
    expect(registry(motebitId).guardian_public_key).toBe(hex(guardian.kp));
    const recovery = await signGuardianRecoverySuccession(
      guardian.kp.privateKey,
      k2.privateKey,
      k1.publicKey,
      k2.publicKey,
    );
    expect((await rotate("laptop", k1, recovery)).status).toBe(200);
    expect(registry(motebitId).public_key).toBe(hex(k2));
    expect(deviceKey("vps")).toBe(hex(k2));
  });

  it("never replaces an installed guardian through registration — even for the identity key", async () => {
    const first = await guardianFor(motebitId);
    expect((await registerAgent("laptop", k1, k1, first.fields)).status).toBe(200);
    const second = await guardianFor(motebitId);
    const res = await registerAgent("laptop", k1, k1, second.fields);
    expect(res.status).toBe(409);
    expect(registry(motebitId).guardian_public_key).toBe(hex(first.kp));
    // Re-registering with the SAME guardian is not a replacement.
    expect((await registerAgent("laptop", k1, k1, first.fields)).status).toBe(200);
  });
});
