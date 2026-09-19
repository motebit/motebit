/**
 * A key succession is recorded only when the presenter can name the key
 * this identity currently holds here.
 *
 * The signed succession payload names two keys and no `motebit_id`
 * (`keySuccessionPayload`), so a record cannot say whose history it
 * belongs to — the route has to. Two gaps let a stranger write one:
 *
 *  - the route never compared the caller to `:motebitId`; and
 *  - the check that the record departs from the identity's stored key was
 *    SKIPPED whenever that stored key was absent or the empty string.
 *
 * Both are routine states, not corner cases: the CLI daemon deregisters
 * on every shutdown (`DELETE FROM agent_registry`), and a master-token
 * registration with no key writes `public_key = ''`. A planted row is
 * served afterwards from the public succession route and from the
 * identity-binding bundle (`spec/identity-v1.md` §7.6), so an external
 * verifier walking that chain no longer reaches the motebit's real key.
 *
 * The rule, one sentence: an ordinary succession is the identity's own
 * act, a recovery is the registered guardian's, and either way the record
 * must depart from the key this relay holds for that identity — refusing
 * when it holds none, rather than skipping the check.
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

async function token(mid: string, deviceId: string, kp: KeyPair): Promise<string> {
  const { token: t } = await mintAudienceToken(
    { mid, did: deviceId, aud: "admin:query" },
    kp.privateKey,
  );
  return t;
}

/** Present a record at `targetMid`, carried by `callerMid`'s token. */
async function present(
  callerMid: string,
  deviceId: string,
  kp: KeyPair,
  targetMid: string,
  record: unknown,
): Promise<number> {
  const res = await relay.app.request(`/api/v1/agents/${targetMid}/rotate-key`, {
    method: "POST",
    headers: { ...JSON_HEADERS, Authorization: `Bearer ${await token(callerMid, deviceId, kp)}` },
    body: JSON.stringify(record),
  });
  return res.status;
}

async function registerAgent(mid: string, kp: KeyPair, guardian?: KeyPair): Promise<number> {
  const fields =
    guardian == null
      ? {}
      : {
          guardian_public_key: hex(guardian),
          guardian_attestation: bytesToHex(
            await ed25519Sign(
              new TextEncoder().encode(
                canonicalJson({
                  action: "guardian_attestation",
                  guardian_public_key: hex(guardian),
                  motebit_id: mid,
                }),
              ),
              guardian.privateKey,
            ),
          ),
        };
  const res = await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: { ...JSON_HEADERS, Authorization: `Bearer ${await token(mid, `${mid}-laptop`, kp)}` },
    body: JSON.stringify({
      endpoint_url: "http://localhost:9999/mcp",
      capabilities: [],
      public_key: hex(kp),
      ...fields,
    }),
  });
  return res.status;
}

const successions = (mid: string): number =>
  (
    relay.moteDb.db
      .prepare("SELECT COUNT(*) AS n FROM relay_key_successions WHERE motebit_id = ?")
      .get(mid) as { n: number }
  ).n;

const registryKey = (mid: string): string | undefined =>
  (
    relay.moteDb.db
      .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
      .get(mid) as { public_key: string } | undefined
  )?.public_key;

/** An authenticated party with no relationship to the victim. */
async function stranger(): Promise<{ mid: string; kp: KeyPair }> {
  const mid = crypto.randomUUID();
  const kp = await generateKeypair();
  expect(await registerSelf(mid, `${mid}-laptop`, kp)).toBe(201);
  return { mid, kp };
}

beforeEach(async () => {
  relay = await createTestRelay();
});
afterEach(async () => {
  await relay.close();
});

describe("an ordinary succession is the identity's own act", () => {
  it("refuses one carried by another identity's token — junk, or the victim's own genuine record", async () => {
    const victim = crypto.randomUUID();
    const vk = await generateKeypair();
    const next = await generateKeypair();
    expect(await registerSelf(victim, `${victim}-laptop`, vk)).toBe(201);
    expect(await registerAgent(victim, vk)).toBe(200);
    const s = await stranger();

    const a = await generateKeypair();
    const b = await generateKeypair();
    const junk = await signKeySuccession(a.privateKey, b.privateKey, b.publicKey, a.publicKey);
    // A genuine record the victim signed and may have shown someone: whose
    // hand carries it is part of the act.
    const genuine = await signKeySuccession(
      vk.privateKey,
      next.privateKey,
      next.publicKey,
      vk.publicKey,
    );
    for (const record of [junk, genuine]) {
      expect(await present(s.mid, `${s.mid}-laptop`, s.kp, victim, record)).toBe(403);
    }
    expect(successions(victim)).toBe(0);
    expect(registryKey(victim)).toBe(hex(vk));
  });

  it("and the identity's own rotation still lands", async () => {
    const mid = crypto.randomUUID();
    const k1 = await generateKeypair();
    const k2 = await generateKeypair();
    expect(await registerSelf(mid, `${mid}-laptop`, k1)).toBe(201);
    expect(await registerAgent(mid, k1)).toBe(200);
    const record = await signKeySuccession(
      k1.privateKey,
      k2.privateKey,
      k2.publicKey,
      k1.publicKey,
    );
    expect(await present(mid, `${mid}-laptop`, k1, mid, record)).toBe(200);
    expect(successions(mid)).toBe(1);
    expect(registryKey(mid)).toBe(hex(k2));
  });

  it("the operator's master token still carries one, as it did before", async () => {
    const mid = crypto.randomUUID();
    const k1 = await generateKeypair();
    const k2 = await generateKeypair();
    expect(await registerSelf(mid, `${mid}-laptop`, k1)).toBe(201);
    expect(await registerAgent(mid, k1)).toBe(200);
    const record = await signKeySuccession(
      k1.privateKey,
      k2.privateKey,
      k2.publicKey,
      k1.publicKey,
    );
    const res = await relay.app.request(`/api/v1/agents/${mid}/rotate-key`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify(record),
    });
    expect(res.status).toBe(200);
    expect(registryKey(mid)).toBe(hex(k2));
  });
});

describe("a record must depart from a key this relay holds for the identity", () => {
  it("refuses a plant under an identity whose daemon has shut down — the poisoning this closes", async () => {
    // The daemon deregisters on every shutdown, so "no registry row" is a
    // routine state. The planted chain was served afterwards as the
    // victim's key history.
    const victim = crypto.randomUUID();
    const vk = await generateKeypair();
    expect(await registerSelf(victim, `${victim}-laptop`, vk)).toBe(201);
    expect(await registerAgent(victim, vk)).toBe(200);
    const res = await relay.app.request("/api/v1/agents/deregister", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${await token(victim, `${victim}-laptop`, vk)}` },
    });
    expect(res.status).toBe(200);
    expect(registryKey(victim)).toBeUndefined();

    // Carried under the VICTIM's own id, so the caller check cannot be what
    // refuses it: an attacker with any token for this identity, or the
    // identity itself confused, must still not plant a chain from nowhere.
    const a = await generateKeypair();
    const b = await generateKeypair();
    const plant = await signKeySuccession(a.privateKey, b.privateKey, b.publicKey, a.publicKey);
    expect(await present(victim, `${victim}-laptop`, vk, victim, plant)).toBe(400);
    expect(successions(victim)).toBe(0);

    // What the public surfaces serve is unchanged — nothing to walk.
    const chain = (await (
      await relay.app.request(`/api/v1/agents/${victim}/succession`)
    ).json()) as { chain: unknown[] };
    expect(chain.chain).toEqual([]);
  });

  it("but the identity's own key, still on a device row, is a key it holds", async () => {
    // A deregistered identity must still be able to rotate: its device row
    // holds the key the record departs from. Refusing this would lock out
    // every daemon that has shut down.
    const mid = crypto.randomUUID();
    const k1 = await generateKeypair();
    const k2 = await generateKeypair();
    expect(await registerSelf(mid, `${mid}-laptop`, k1)).toBe(201);
    const record = await signKeySuccession(
      k1.privateKey,
      k2.privateKey,
      k2.publicKey,
      k1.publicKey,
    );
    expect(await present(mid, `${mid}-laptop`, k1, mid, record)).toBe(200);
    expect(successions(mid)).toBe(1);
  });

  it("refuses the identity's OWN record when it departs from a key the relay does not hold", async () => {
    // The caller check cannot be what refuses this: the identity carries
    // its own record. A registered identity's chain must continue from the
    // key on file, not from two keys nobody has seen.
    const mid = crypto.randomUUID();
    const k1 = await generateKeypair();
    expect(await registerSelf(mid, `${mid}-laptop`, k1)).toBe(201);
    expect(await registerAgent(mid, k1)).toBe(200);
    const a = await generateKeypair();
    const b = await generateKeypair();
    const elsewhere = await signKeySuccession(a.privateKey, b.privateKey, b.publicKey, a.publicKey);
    expect(await present(mid, `${mid}-laptop`, k1, mid, elsewhere)).toBe(400);
    expect(successions(mid)).toBe(0);
    expect(registryKey(mid)).toBe(hex(k1));
  });

  it("an EMPTY registry key is not a key on file, so the device row decides", async () => {
    // A master-token registration that names no key writes `public_key =
    // ''`. Treating that as the identity's key refuses the owner's honest
    // rotation; treating it as a key ON FILE that matches nothing would
    // lock the identity out of rotating for good.
    const mid = crypto.randomUUID();
    const k1 = await generateKeypair();
    const k2 = await generateKeypair();
    // Registered BEFORE any device exists, so there is no key to fall back
    // to and the row is written with the empty string.
    const res = await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        motebit_id: mid,
        endpoint_url: "http://localhost:9999/mcp",
        capabilities: [],
      }),
    });
    expect(res.status).toBe(200);
    expect(registryKey(mid)).toBe("");
    expect(await registerSelf(mid, `${mid}-laptop`, k1)).toBe(201);

    const record = await signKeySuccession(
      k1.privateKey,
      k2.privateKey,
      k2.publicKey,
      k1.publicKey,
    );
    expect(await present(mid, `${mid}-laptop`, k1, mid, record)).toBe(200);
    expect(successions(mid)).toBe(1);
  });

  it("refuses a record that goes nowhere", async () => {
    const mid = crypto.randomUUID();
    const k1 = await generateKeypair();
    expect(await registerSelf(mid, `${mid}-laptop`, k1)).toBe(201);
    expect(await registerAgent(mid, k1)).toBe(200);
    const circular = await signKeySuccession(
      k1.privateKey,
      k1.privateKey,
      k1.publicKey,
      k1.publicKey,
    );
    expect(await present(mid, `${mid}-laptop`, k1, mid, circular)).toBe(400);
    expect(successions(mid)).toBe(0);
  });
});

describe("guardian recovery is carried by someone else, and anchored to a key on file", () => {
  /** A victim with a registered guardian and an EMPTY registry key — the replay's precondition. */
  async function victimWithEmptyKey(guardian: KeyPair): Promise<string> {
    const mid = crypto.randomUUID();
    const res = await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        motebit_id: mid,
        endpoint_url: "http://localhost:9999/mcp",
        capabilities: [],
        guardian_public_key: hex(guardian),
        guardian_attestation: bytesToHex(
          await ed25519Sign(
            new TextEncoder().encode(
              canonicalJson({
                action: "guardian_attestation",
                guardian_public_key: hex(guardian),
                motebit_id: mid,
              }),
            ),
            guardian.privateKey,
          ),
        ),
      }),
    });
    expect(res.status).toBe(200);
    expect(registryKey(mid)).toBe("");
    return mid;
  }

  it("lands when a third party carries a record the registered guardian signed", async () => {
    const owner = crypto.randomUUID();
    const ok = await generateKeypair();
    const guardian = await generateKeypair();
    const next = await generateKeypair();
    expect(await registerSelf(owner, `${owner}-laptop`, ok)).toBe(201);
    expect(await registerAgent(owner, ok, guardian)).toBe(200);
    const s = await stranger();
    const recovery = await signGuardianRecoverySuccession(
      guardian.privateKey,
      next.privateKey,
      ok.publicKey,
      next.publicKey,
    );
    expect(await present(s.mid, `${s.mid}-laptop`, s.kp, owner, recovery)).toBe(200);
    expect(registryKey(owner)).toBe(hex(next));
  });

  it("refuses the SAME guardian's genuine record replayed at a sibling identity with an empty key", async () => {
    // Both identities answer to guardian G. A's recovery record is genuine.
    // Under the empty key, the old-key match used to be skipped, so the
    // record landed under B and moved B to a key A's owner controls.
    const guardian = await generateKeypair();
    const a = crypto.randomUUID();
    const ak = await generateKeypair();
    const aNext = await generateKeypair();
    expect(await registerSelf(a, `${a}-laptop`, ak)).toBe(201);
    expect(await registerAgent(a, ak, guardian)).toBe(200);
    const b = await victimWithEmptyKey(guardian);

    const genuine = await signGuardianRecoverySuccession(
      guardian.privateKey,
      aNext.privateKey,
      ak.publicKey,
      aNext.publicKey,
    );
    const s = await stranger();
    expect(await present(s.mid, `${s.mid}-laptop`, s.kp, b, genuine)).toBe(400);
    expect(successions(b)).toBe(0);
    expect(registryKey(b)).toBe("");
    // A's own recovery is untouched by the refusal at B.
    expect(await present(s.mid, `${s.mid}-laptop`, s.kp, a, genuine)).toBe(200);
    expect(registryKey(a)).toBe(hex(aNext));
  });

  it("refuses a recovery for an identity with no guardian on file, however it is carried", async () => {
    const mid = crypto.randomUUID();
    const k1 = await generateKeypair();
    const mine = await generateKeypair();
    expect(await registerSelf(mid, `${mid}-laptop`, k1)).toBe(201);
    expect(await registerAgent(mid, k1)).toBe(200);
    const impostor = await generateKeypair();
    const forged = await signGuardianRecoverySuccession(
      impostor.privateKey,
      mine.privateKey,
      k1.publicKey,
      mine.publicKey,
    );
    const s = await stranger();
    expect(await present(s.mid, `${s.mid}-laptop`, s.kp, mid, forged)).toBe(400);
    expect(registryKey(mid)).toBe(hex(k1));
    expect(successions(mid)).toBe(0);
  });
});

describe("every refusal leaves a trace in the relay's own record", () => {
  it("records the caller and the reason", async () => {
    const victim = crypto.randomUUID();
    const vk = await generateKeypair();
    expect(await registerSelf(victim, `${victim}-laptop`, vk)).toBe(201);
    expect(await registerAgent(victim, vk)).toBe(200);
    const s = await stranger();
    const a = await generateKeypair();
    const b = await generateKeypair();
    const junk = await signKeySuccession(a.privateKey, b.privateKey, b.publicKey, a.publicKey);
    expect(await present(s.mid, `${s.mid}-laptop`, s.kp, victim, junk)).toBe(403);

    const rows = relay.moteDb.db
      .prepare(
        "SELECT kind, motebit_id, reason FROM relay_auth_events WHERE reason LIKE 'succession:%'",
      )
      .all() as Array<{ kind: string; motebit_id: string; reason: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.motebit_id).toBe(s.mid);
    expect(rows[0]!.reason).toBe("succession:under_another_identity");
  });
});

/**
 * Pairing's key-transfer route takes no bearer, and needs none: it is
 * reached by whoever completed the pairing. What it may WRITE is
 * therefore the whole of its safety, and it would write ANY key to the
 * approved device's row — a row whose `public_key` is what an owner
 * token is verified against, so that is a token-minting primitive for
 * anyone holding the pairing id. The session was also never consumed and
 * its expiry never checked here, so the id stayed a standing credential.
 *
 * The transfer's own meaning bounds it: device B receives the identity's
 * seed, so the only key it can honestly present is one the identity
 * already holds.
 */
describe("pairing's key-transfer route writes only a key the identity already holds, once", () => {
  async function approvedSession(): Promise<{
    pairingId: string;
    identityKey: KeyPair;
    claimKey: KeyPair;
  }> {
    const mid = crypto.randomUUID();
    const identityKey = await generateKeypair();
    const claimKey = await generateKeypair();
    expect(await registerSelf(mid, `${mid}-laptop`, identityKey)).toBe(201);
    // Pairing authenticates with its own audience, not `admin:query`.
    const { token: pairToken } = await mintAudienceToken(
      { mid, did: `${mid}-laptop`, aud: "device:auth" },
      identityKey.privateKey,
    );
    const auth = { Authorization: `Bearer ${pairToken}` };
    const init = await relay.app.request("/pairing/initiate", { method: "POST", headers: auth });
    expect(init.status).toBe(201);
    const { pairing_id, pairing_code } = (await init.json()) as {
      pairing_id: string;
      pairing_code: string;
    };
    const claim = await relay.app.request("/pairing/claim", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        pairing_code,
        device_name: "Mobile",
        public_key: hex(claimKey),
      }),
    });
    expect(claim.status).toBe(200);
    const approve = await relay.app.request(`/pairing/${pairing_id}/approve`, {
      method: "POST",
      headers: auth,
    });
    expect(approve.status).toBe(200);
    return { pairingId: pairing_id, identityKey, claimKey };
  }

  const update = (pairingId: string, key: KeyPair) =>
    relay.app.request(`/pairing/${pairingId}/update-key`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ public_key: hex(key) }),
    });
  const mobileKey = (): string =>
    (
      relay.moteDb.db
        .prepare("SELECT public_key FROM devices WHERE device_name = 'Mobile'")
        .get() as { public_key: string }
    ).public_key;

  it("refuses a key the identity does not hold, and writes nothing", async () => {
    const { pairingId, claimKey } = await approvedSession();
    const attacker = await generateKeypair();
    expect((await update(pairingId, attacker)).status).toBe(403);
    expect(mobileKey()).toBe(hex(claimKey));
  });

  it("completes the transfer it exists for, and then the session is spent", async () => {
    const { pairingId, identityKey } = await approvedSession();
    expect((await update(pairingId, identityKey)).status).toBe(200);
    expect(mobileKey()).toBe(hex(identityKey));
    // The pairing id was a standing credential: a second use, at any later
    // date, re-keyed that row again.
    expect((await update(pairingId, identityKey)).status).toBe(409);
  });
});
