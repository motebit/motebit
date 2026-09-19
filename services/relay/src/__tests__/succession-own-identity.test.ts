/**
 * A key succession is presented only under the identity it rotates.
 *
 * The signed succession payload names two keys and no `motebit_id`, so a
 * record cannot say whose history it belongs to — the route has to. It
 * did not compare the caller to `:motebitId`, so any authenticated
 * identity could record a succession under any other, and the relay
 * served it as that identity's key history.
 *
 * SEVERING (recorded): drop the `caller !== motebitId` refusal in
 * key-rotation.ts → the first test's 403 becomes 200 and a row appears
 * under the victim.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import {
  generateKeypair,
  bytesToHex,
  signDeviceRegistration,
  mintAudienceToken,
  signKeySuccession,
} from "@motebit/crypto";
import type { KeyPair } from "@motebit/crypto";
import { createTestRelay } from "./test-helpers.js";

let relay: SyncRelay;
const JSON_HEADERS = { "Content-Type": "application/json" };

async function registerSelf(mid: string, deviceId: string, kp: KeyPair): Promise<number> {
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
  return res.status;
}

async function present(
  callerMid: string,
  did: string,
  kp: KeyPair,
  targetMid: string,
  record: unknown,
) {
  const { token } = await mintAudienceToken(
    { mid: callerMid, did, aud: "admin:query" },
    kp.privateKey,
  );
  return relay.app.request(`/api/v1/agents/${targetMid}/rotate-key`, {
    method: "POST",
    headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` },
    body: JSON.stringify(record),
  });
}

const successions = (mid: string): number =>
  (
    relay.moteDb.db
      .prepare("SELECT COUNT(*) AS n FROM relay_key_successions WHERE motebit_id = ?")
      .get(mid) as { n: number }
  ).n;

beforeEach(async () => {
  relay = await createTestRelay();
});
afterEach(async () => {
  await relay.close();
});

describe("rotate-key — a succession is the identity's own act", () => {
  it("refuses a succession presented under another identity's token, records nothing, and leaves a trace", async () => {
    const victim = crypto.randomUUID();
    const stranger = crypto.randomUUID();
    const vk = await generateKeypair();
    const sk = await generateKeypair();
    expect(await registerSelf(victim, "v-laptop", vk)).toBe(201);
    expect(await registerSelf(stranger, "s-laptop", sk)).toBe(201);

    // Two keys nobody has seen — and, separately, a GENUINE record of the
    // victim's: whose hand carries it is part of the act.
    const a = await generateKeypair();
    const b = await generateKeypair();
    const junk = await signKeySuccession(a.privateKey, b.privateKey, b.publicKey, a.publicKey);
    const genuine = await signKeySuccession(vk.privateKey, b.privateKey, b.publicKey, vk.publicKey);
    for (const record of [junk, genuine]) {
      const res = await present(stranger, "s-laptop", sk, victim, record);
      expect(res.status).toBe(403);
    }
    expect(successions(victim)).toBe(0);

    const recorded = relay.moteDb.db
      .prepare("SELECT motebit_id, reason FROM relay_auth_events WHERE reason = ?")
      .all("succession_under_another_identity") as Array<{ motebit_id: string }>;
    expect(recorded).toHaveLength(2);
    expect(recorded.every((r) => r.motebit_id === stranger)).toBe(true);
  });

  it("still records the identity's own rotation", async () => {
    const mid = crypto.randomUUID();
    const k1 = await generateKeypair();
    const k2 = await generateKeypair();
    expect(await registerSelf(mid, "laptop", k1)).toBe(201);
    const record = await signKeySuccession(
      k1.privateKey,
      k2.privateKey,
      k2.publicKey,
      k1.publicKey,
    );
    expect((await present(mid, "laptop", k1, mid, record)).status).toBe(200);
    expect(successions(mid)).toBe(1);
  });
});
