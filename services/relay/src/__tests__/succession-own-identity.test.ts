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
  signGuardianRecoverySuccession,
  canonicalJson,
  ed25519Sign,
} from "@motebit/crypto";
import type { KeyPair } from "@motebit/crypto";
import { createTestRelay, JSON_AUTH } from "./test-helpers.js";

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

const registryKey = (mid: string): string =>
  (
    relay.moteDb.db
      .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
      .get(mid) as {
      public_key: string;
    }
  ).public_key;

/** A victim with a REGISTRY key (optionally a guardian), and an unrelated authenticated stranger. */
async function registeredVictim(opts: { withGuardian?: boolean } = {}) {
  const victim = crypto.randomUUID();
  const stranger = crypto.randomUUID();
  const vk = await generateKeypair();
  const sk = await generateKeypair();
  expect(await registerSelf(victim, "v-laptop", vk)).toBe(201);
  expect(await registerSelf(stranger, "s-laptop", sk)).toBe(201);
  const guardian = opts.withGuardian === true ? await generateKeypair() : null;
  const guardianFields =
    guardian == null
      ? {}
      : {
          guardian_public_key: bytesToHex(guardian.publicKey),
          guardian_attestation: bytesToHex(
            await ed25519Sign(
              new TextEncoder().encode(
                canonicalJson({
                  action: "guardian_attestation",
                  guardian_public_key: bytesToHex(guardian.publicKey),
                  motebit_id: victim,
                }),
              ),
              guardian.privateKey,
            ),
          ),
        };
  const { token } = await mintAudienceToken(
    { mid: victim, did: "v-laptop", aud: "admin:query" },
    vk.privateKey,
  );
  const res = await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      endpoint_url: "http://localhost:9999/mcp",
      capabilities: [],
      public_key: bytesToHex(vk.publicKey),
      ...guardianFields,
    }),
  });
  expect(res.status).toBe(200);
  return { victim, vk, stranger, sk, guardian };
}

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

  it("a REGISTERED victim's live key is untouched by a stranger carrying the victim's own genuine record", async () => {
    // The worse pre-fix effect than a history row: this route also sets the
    // registry key. A genuine record is one the victim signed and may have
    // shown someone; carried by a stranger it must change nothing.
    const { victim, vk, stranger, sk } = await registeredVictim();
    const next = await generateKeypair();
    const genuine = await signKeySuccession(
      vk.privateKey,
      next.privateKey,
      next.publicKey,
      vk.publicKey,
    );
    expect((await present(stranger, "s-laptop", sk, victim, genuine)).status).toBe(403);
    expect(registryKey(victim)).toBe(bytesToHex(vk.publicKey));
    expect(successions(victim)).toBe(0);
  });

  it("the operator's master token still carries a genuine record, as it did before", async () => {
    const { victim, vk } = await registeredVictim();
    const next = await generateKeypair();
    const genuine = await signKeySuccession(
      vk.privateKey,
      next.privateKey,
      next.publicKey,
      vk.publicKey,
    );
    const res = await relay.app.request(`/api/v1/agents/${victim}/rotate-key`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify(genuine),
    });
    expect(res.status).toBe(200);
    expect(registryKey(victim)).toBe(bytesToHex(next.publicKey));
  });
});

/**
 * Guardian recovery exists for an owner who has LOST the key, and such an
 * owner cannot mint a token for their own identity — so recovery is, by
 * design, carried by someone else. The first review of this change found
 * the caller check refused it. What authorizes a recovery is the
 * guardian's signature against the guardian key the identity registered,
 * never the hand that carries it.
 *
 * SEVERING (recorded): drop `!body.recovery &&` from the refusal → the
 * first test's 200 becomes 403.
 */
describe("rotate-key — guardian recovery is carried by someone else, and authorized by the guardian", () => {
  it("lands when a third party carries a record the registered guardian signed", async () => {
    const { victim, vk, stranger, sk, guardian } = await registeredVictim({ withGuardian: true });
    const next = await generateKeypair();
    const recovery = await signGuardianRecoverySuccession(
      guardian!.privateKey,
      next.privateKey,
      vk.publicKey,
      next.publicKey,
    );
    expect((await present(stranger, "s-laptop", sk, victim, recovery)).status).toBe(200);
    expect(registryKey(victim)).toBe(bytesToHex(next.publicKey));
  });

  it("and the exemption admits nothing else: a recovery the registered guardian did not sign is refused", async () => {
    const { victim, vk, stranger, sk } = await registeredVictim({ withGuardian: true });
    const impostor = await generateKeypair();
    const mine = await generateKeypair();
    const forged = await signGuardianRecoverySuccession(
      impostor.privateKey,
      mine.privateKey,
      vk.publicKey,
      mine.publicKey,
    );
    expect((await present(stranger, "s-laptop", sk, victim, forged)).status).toBe(400);
    expect(registryKey(victim)).toBe(bytesToHex(vk.publicKey));
    expect(successions(victim)).toBe(0);
  });

  it("nor does marking a record `recovery` open the door for an identity with no guardian", async () => {
    const { victim, vk, stranger, sk } = await registeredVictim();
    const g = await generateKeypair();
    const mine = await generateKeypair();
    const forged = await signGuardianRecoverySuccession(
      g.privateKey,
      mine.privateKey,
      vk.publicKey,
      mine.publicKey,
    );
    expect((await present(stranger, "s-laptop", sk, victim, forged)).status).toBe(400);
    // An ordinary record with the flag bolted on: the signed payload covers
    // the flag, so the guardian check is what it meets, and it fails it.
    const a = await generateKeypair();
    const junk = await signKeySuccession(
      a.privateKey,
      mine.privateKey,
      mine.publicKey,
      a.publicKey,
    );
    const flagged = { ...junk, recovery: true, guardian_signature: junk.old_key_signature };
    expect((await present(stranger, "s-laptop", sk, victim, flagged)).status).toBe(400);
    expect(registryKey(victim)).toBe(bytesToHex(vk.publicKey));
    expect(successions(victim)).toBe(0);
  });
});
