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
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SyncRelay } from "../index.js";
import {
  generateKeypair,
  bytesToHex,
  signDeviceRegistration,
  mintAudienceToken,
  signKeySuccession,
  verifySuccessionChain,
  signGuardianRecoverySuccession,
  canonicalJson,
  ed25519Sign,
  deriveSovereignMotebitId,
} from "@motebit/crypto";
import type { KeyPair, KeySuccessionRecord } from "@motebit/crypto";
import type { TokenAudience } from "@motebit/protocol";
import { createTestRelay, JSON_AUTH } from "./test-helpers.js";
import { applySuccession, SuccessionRefused } from "../succession-apply.js";

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

async function token(
  mid: string,
  deviceId: string,
  kp: KeyPair,
  aud: TokenAudience = "admin:query",
): Promise<string> {
  const { token: t } = await mintAudienceToken({ mid, did: deviceId, aud }, kp.privateKey);
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
    headers: {
      ...JSON_HEADERS,
      // The audience the spec names for this route, and the one the shipped
      // client mints. A helper that minted `admin:query` here would keep
      // passing while every real client 401'd (#702).
      Authorization: `Bearer ${await token(callerMid, deviceId, kp, "rotate-key")}`,
    },
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

const events = (mid: string, type: string): number =>
  (
    relay.moteDb.db
      .prepare(
        "SELECT COUNT(*) AS n FROM relay_revocation_events WHERE motebit_id = ? AND type = ?",
      )
      .get(mid, type) as { n: number }
  ).n;
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
    const k1 = await generateKeypair();
    // Shipped clients mint the id as the sovereign commitment to k1 (#703 §5f: E-sov).
    const mid = await deriveSovereignMotebitId(hex(k1));
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
    const k1 = await generateKeypair();
    // Shipped clients mint the id as the sovereign commitment to k1 (#703 §5f: E-sov).
    const mid = await deriveSovereignMotebitId(hex(k1));
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

describe("the route answers to the audience the spec names", () => {
  it("accepts `rotate-key` and refuses a general read token", async () => {
    // The route defaulted to `admin:query`, so the only tokens that ever
    // reached it were the operator's, and every signed client 401'd —
    // which is why no rotation has ever been recorded (#702). Narrowing it
    // also means an ordinary read token cannot be replayed here.
    const k1 = await generateKeypair();
    // Shipped clients mint the id as the sovereign commitment to k1 (#703 §5f: E-sov).
    const mid = await deriveSovereignMotebitId(hex(k1));
    const k2 = await generateKeypair();
    expect(await registerSelf(mid, `${mid}-laptop`, k1)).toBe(201);
    expect(await registerAgent(mid, k1)).toBe(200);
    const record = await signKeySuccession(
      k1.privateKey,
      k2.privateKey,
      k2.publicKey,
      k1.publicKey,
    );
    const send = async (aud: TokenAudience): Promise<number> =>
      (
        await relay.app.request(`/api/v1/agents/${mid}/rotate-key`, {
          method: "POST",
          headers: {
            ...JSON_HEADERS,
            Authorization: `Bearer ${await token(mid, `${mid}-laptop`, k1, aud)}`,
          },
          body: JSON.stringify(record),
        })
      ).status;
    expect(await send("admin:query")).toBe(401);
    expect(successions(mid)).toBe(0);
    expect(await send("rotate-key")).toBe(200);
    expect(successions(mid)).toBe(1);
  });
});

describe("a record must depart from a key this relay holds for the identity", () => {
  it("refuses a plant under an identity whose daemon has shut down — the poisoning this closes", async () => {
    // The daemon deregisters on every shutdown. Until #703 that DELETED the
    // registry row, so "relay holds no registry key" was a routine state
    // and the planted chain was served afterwards as the victim's key
    // history. Deregister now DELISTS: the row leaves discovery and the
    // key stays on file — so the relay still holds the victim's key, and
    // the plant is refused for departing from a key it does not hold.
    const victim = crypto.randomUUID();
    const vk = await generateKeypair();
    expect(await registerSelf(victim, `${victim}-laptop`, vk)).toBe(201);
    expect(await registerAgent(victim, vk)).toBe(200);
    const res = await relay.app.request("/api/v1/agents/deregister", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${await token(victim, `${victim}-laptop`, vk)}` },
    });
    expect(res.status).toBe(200);
    expect(registryKey(victim)).toBe(bytesToHex(vk.publicKey));

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
    const k1 = await generateKeypair();
    // Shipped clients mint the id as the sovereign commitment to k1 (#703 §5f: E-sov).
    const mid = await deriveSovereignMotebitId(hex(k1));
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
    const k1 = await generateKeypair();
    // Shipped clients mint the id as the sovereign commitment to k1 (#703 §5f: E-sov).
    const mid = await deriveSovereignMotebitId(hex(k1));
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
    const k1 = await generateKeypair();
    // Shipped clients mint the id as the sovereign commitment to k1 (#703 §5f: E-sov).
    const mid = await deriveSovereignMotebitId(hex(k1));
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

  it("a deregistered identity can rotate MORE THAN ONCE — the recorded chain is what the next one continues from", async () => {
    // The registry UPDATE writes no rows when the row is gone, and the
    // device row is not re-keyed, so after the first rotation there was
    // nothing on file and the second was refused. Rotating twice worked
    // before this rule existed, so that was a regression.
    const k1 = await generateKeypair();
    // Shipped clients mint the id as the sovereign commitment to k1 (#703 §5f: E-sov).
    const mid = await deriveSovereignMotebitId(hex(k1));
    const k2 = await generateKeypair();
    const k3 = await generateKeypair();
    expect(await registerSelf(mid, `${mid}-laptop`, k1)).toBe(201);
    const first = await signKeySuccession(k1.privateKey, k2.privateKey, k2.publicKey, k1.publicKey);
    expect(await present(mid, `${mid}-laptop`, k1, mid, first)).toBe(200);
    const second = await signKeySuccession(
      k2.privateKey,
      k3.privateKey,
      k3.publicKey,
      k2.publicKey,
    );
    // Carried with k2 — the first rotation moved the device row, so the
    // retired key no longer authenticates, which is the point of it.
    expect(await present(mid, `${mid}-laptop`, k2, mid, second)).toBe(200);
    expect(successions(mid)).toBe(2);

    // And the chain head is not a way in: a record departing from the key
    // the chain left BEHIND is refused.
    const stale = await signKeySuccession(k1.privateKey, k3.privateKey, k3.publicKey, k1.publicKey);
    expect(await present(mid, `${mid}-laptop`, k3, mid, stale)).toBe(400);
    expect(successions(mid)).toBe(2);
  });

  it("refuses a record whose keys are the right ones in the wrong spelling — the signature is what makes spelling non-negotiable", async () => {
    // The stored record is served for verification and the linkage check
    // is exact, so a re-spelled record stored verbatim would break the
    // chain on the public surfaces. It never gets that far: the spelling
    // is inside the signed payload, so re-spelling breaks the signature
    // first. Recorded because it is easy to believe the comparison below
    // is what protects this — it is not, and severing that comparison
    // leaves this test green.
    const k1 = await generateKeypair();
    // Shipped clients mint the id as the sovereign commitment to k1 (#703 §5f: E-sov).
    const mid = await deriveSovereignMotebitId(hex(k1));
    const k2 = await generateKeypair();
    expect(await registerSelf(mid, `${mid}-laptop`, k1)).toBe(201);
    expect(await registerAgent(mid, k1)).toBe(200);
    const record = await signKeySuccession(
      k1.privateKey,
      k2.privateKey,
      k2.publicKey,
      k1.publicKey,
    );
    const shouted = { ...record, old_public_key: record.old_public_key.toUpperCase() };
    expect(await present(mid, `${mid}-laptop`, k1, mid, shouted)).toBe(400);
    expect(successions(mid)).toBe(0);
  });

  it("refuses a record that goes nowhere", async () => {
    const k1 = await generateKeypair();
    // Shipped clients mint the id as the sovereign commitment to k1 (#703 §5f: E-sov).
    const mid = await deriveSovereignMotebitId(hex(k1));
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
    const k1 = await generateKeypair();
    // Shipped clients mint the id as the sovereign commitment to k1 (#703 §5f: E-sov).
    const mid = await deriveSovereignMotebitId(hex(k1));
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

describe("the public succession route answers the departure question with the rule /rotate-key enforces", () => {
  async function read(mid: string, from?: string) {
    const url = `/api/v1/agents/${mid}/succession${from ? `?from=${from}` : ""}`;
    return (await (await relay.app.request(url)).json()) as {
      current_public_key: string | null;
      held_public_key: string | null;
      departable?: boolean | null;
      chain: unknown[];
    };
  }

  it("a sovereign client that registered: the holder is its key; departable only from it", async () => {
    const k1 = await generateKeypair();
    // Shipped clients mint the id as the sovereign commitment to k1 (#703 §5f: E-sov).
    const mid = await deriveSovereignMotebitId(hex(k1));
    const other = await generateKeypair();
    expect(await registerSelf(mid, `${mid}-laptop`, k1)).toBe(201);
    expect(await registerAgent(mid, k1)).toBe(200);
    expect(await read(mid, hex(k1))).toMatchObject({ held_public_key: hex(k1), departable: true });
    expect(await read(mid, hex(other))).toMatchObject({
      held_public_key: hex(k1),
      departable: false,
    });
    expect((await read(mid)).departable).toBeUndefined();
  });

  it("a deregistered identity that rotated is held at the key its verified link moved the holder to", async () => {
    const k1 = await generateKeypair();
    // Shipped clients mint the id as the sovereign commitment to k1 (#703 §5f: E-sov).
    const mid = await deriveSovereignMotebitId(hex(k1));
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
    relay.moteDb.db.prepare("DELETE FROM agent_registry WHERE motebit_id = ?").run(mid);
    // `current_public_key` is what the relay SERVES, from the one reader
    // (§5a A6) — no longer a registry read that goes null when the row goes.
    expect(await read(mid, hex(k2))).toMatchObject({
      current_public_key: hex(k2),
      held_public_key: hex(k2),
      departable: true,
    });
    expect(await read(mid, hex(k1))).toMatchObject({ departable: false });
  });

  it("a daemon that shut down before ever rotating: the one holder still names its key, and the route departs from it", async () => {
    // Before #703 Inc 2 this state read as "held is null, yet departable
    // from the device row" — the split a client re-deriving "held" from
    // chain + registry fell into. The holder (identity_keys, written by
    // register-self) now answers even with the registry row gone.
    const k1 = await generateKeypair();
    // Shipped clients mint the id as the sovereign commitment to k1 (#703 §5f: E-sov).
    const mid = await deriveSovereignMotebitId(hex(k1));
    const other = await generateKeypair();
    expect(await registerSelf(mid, `${mid}-laptop`, k1)).toBe(201);
    expect(await registerAgent(mid, k1)).toBe(200);
    relay.moteDb.db.prepare("DELETE FROM agent_registry WHERE motebit_id = ?").run(mid);
    expect(await read(mid, hex(k1))).toMatchObject({
      held_public_key: hex(k1),
      chain: [],
      departable: true,
    });
    expect(await read(mid, hex(other))).toMatchObject({
      held_public_key: hex(k1),
      departable: false,
    });
    // And /rotate-key agrees: the departure the route said yes to lands.
    const k2 = await generateKeypair();
    const record = await signKeySuccession(
      k1.privateKey,
      k2.privateKey,
      k2.publicKey,
      k1.publicKey,
    );
    expect(await present(mid, `${mid}-laptop`, k1, mid, record)).toBe(200);
  });

  it("truly unknown: no registry, no chain, no device row ⇒ held null and not departable from anything", async () => {
    const k1 = await generateKeypair();
    // Shipped clients mint the id as the sovereign commitment to k1 (#703 §5f: E-sov).
    const mid = await deriveSovereignMotebitId(hex(k1));
    expect(await read(mid, hex(k1))).toMatchObject({
      held_public_key: null,
      chain: [],
      departable: false,
    });
  });

  it("the served answer and the route's decision are one function: severing agreement is a red test", async () => {
    // Registry says k1 after a rotation to k2; the holder says k2.
    const k1 = await generateKeypair();
    // Shipped clients mint the id as the sovereign commitment to k1 (#703 §5f: E-sov).
    const mid = await deriveSovereignMotebitId(hex(k1));
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
    // A residual rule 21 names: the registry re-created on an old key. Since
    // #703 Inc 2 a direct registry edit no longer moves the answer — the ONE
    // holder does, and only a door writes it — so the read and the route
    // both still say k2, and they say it because they are the same rule.
    relay.moteDb.db
      .prepare("UPDATE agent_registry SET public_key = ? WHERE motebit_id = ?")
      .run(hex(k1), mid);
    expect(await read(mid, hex(k2))).toMatchObject({ held_public_key: hex(k2), departable: true });
    expect(await read(mid, hex(k1))).toMatchObject({ departable: false });
    const k3 = await generateKeypair();
    const fromK2 = await signKeySuccession(
      k2.privateKey,
      k3.privateKey,
      k3.publicKey,
      k2.publicKey,
    );
    expect(await present(mid, `${mid}-laptop`, k2, mid, fromK2)).toBe(200);
  });
});

describe("every refusal leaves a trace in the relay's own record", () => {
  it("records a recovery probe too — the flag must not be a way to probe unrecorded", async () => {
    // `recovery: true` skips the caller check by design. If the refusals
    // inside that branch went unrecorded, setting the flag would be the
    // obvious way to probe other identities silently.
    const victim = crypto.randomUUID();
    const vk = await generateKeypair();
    const mine = await generateKeypair();
    expect(await registerSelf(victim, `${victim}-laptop`, vk)).toBe(201);
    expect(await registerAgent(victim, vk)).toBe(200);
    const s = await stranger();
    const impostor = await generateKeypair();
    const forged = await signGuardianRecoverySuccession(
      impostor.privateKey,
      mine.privateKey,
      vk.publicKey,
      mine.publicKey,
    );
    expect(await present(s.mid, `${s.mid}-laptop`, s.kp, victim, forged)).toBe(400);
    const reasons = (
      relay.moteDb.db
        .prepare("SELECT reason FROM relay_auth_events WHERE reason LIKE 'succession:%'")
        .all() as Array<{ reason: string }>
    ).map((r) => r.reason);
    expect(reasons).toEqual(["succession:recovery_without_registered_guardian"]);
  });

  it("names the PRESENTER as the subject, not the identity that presented nothing", async () => {
    const k1 = await generateKeypair();
    // Shipped clients mint the id as the sovereign commitment to k1 (#703 §5f: E-sov).
    const mid = await deriveSovereignMotebitId(hex(k1));
    expect(await registerSelf(mid, `${mid}-laptop`, k1)).toBe(201);
    expect(await registerAgent(mid, k1)).toBe(200);
    const a = await generateKeypair();
    const b = await generateKeypair();
    const junk = await signKeySuccession(a.privateKey, b.privateKey, b.publicKey, a.publicKey);
    const res = await relay.app.request(`/api/v1/agents/${mid}/rotate-key`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify(junk),
    });
    expect(res.status).toBe(400);
    const row = relay.moteDb.db
      .prepare("SELECT motebit_id FROM relay_auth_events WHERE reason LIKE 'succession:%'")
      .get() as { motebit_id: string | null };
    // The operator's master token carries no caller identity; the target
    // is in the path, and must not be recorded as the rejected subject.
    expect(row.motebit_id).toBeNull();
  });

  it("records an ordinary rotation's signature refusal too — the record is complete or it misleads", async () => {
    const k1 = await generateKeypair();
    // Shipped clients mint the id as the sovereign commitment to k1 (#703 §5f: E-sov).
    const mid = await deriveSovereignMotebitId(hex(k1));
    const k2 = await generateKeypair();
    expect(await registerSelf(mid, `${mid}-laptop`, k1)).toBe(201);
    expect(await registerAgent(mid, k1)).toBe(200);
    const record = await signKeySuccession(
      k1.privateKey,
      k2.privateKey,
      k2.publicKey,
      k1.publicKey,
    );
    const tampered = { ...record, old_key_signature: "0".repeat(128) };
    expect(await present(mid, `${mid}-laptop`, k1, mid, tampered)).toBe(400);
    const reasons = (
      relay.moteDb.db
        .prepare("SELECT reason FROM relay_auth_events WHERE reason LIKE 'succession:%'")
        .all() as Array<{ reason: string }>
    ).map((r) => r.reason);
    expect(reasons).toEqual(["succession:rotation_signature_invalid"]);
  });

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

  /** The same, with a key transfer approved — what every client actually does. */
  async function approvedTransfer(): Promise<{ pairingId: string; identityKey: KeyPair }> {
    const mid = crypto.randomUUID();
    const identityKey = await generateKeypair();
    const claimKey = await generateKeypair();
    expect(await registerSelf(mid, `${mid}-laptop`, identityKey)).toBe(201);
    const { token: pairToken } = await mintAudienceToken(
      { mid, did: `${mid}-laptop`, aud: "device:auth" },
      identityKey.privateKey,
    );
    const auth = { Authorization: `Bearer ${pairToken}` };
    const init = await relay.app.request("/pairing/initiate", { method: "POST", headers: auth });
    const { pairing_id, pairing_code } = (await init.json()) as {
      pairing_id: string;
      pairing_code: string;
    };
    expect(
      (
        await relay.app.request("/pairing/claim", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({
            pairing_code,
            device_name: "Mobile",
            public_key: hex(claimKey),
            x25519_pubkey: "b".repeat(64),
          }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await relay.app.request(`/pairing/${pairing_id}/approve`, {
          method: "POST",
          headers: { ...auth, ...JSON_HEADERS },
          body: JSON.stringify({
            key_transfer: {
              x25519_pubkey: "a".repeat(64),
              encrypted_seed: "c".repeat(96),
              nonce: "d".repeat(24),
              tag: "e".repeat(32),
              identity_pubkey_check: hex(identityKey),
            },
          }),
        })
      ).status,
    ).toBe(200);
    return { pairingId: pairing_id, identityKey };
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

  it("refuses any key but the one the transfer was approved to carry, and writes nothing", async () => {
    const { pairingId } = await approvedTransfer();
    const attacker = await generateKeypair();
    const before = mobileKey();
    expect((await update(pairingId, attacker)).status).toBe(403);
    expect(mobileKey()).toBe(before);
  });

  it("refuses the approved key in another spelling — what is written is compared exactly everywhere else", async () => {
    // The row is written verbatim, and `key-rotation.ts` compares device
    // keys exactly. A row stored in a spelling the identity does not
    // otherwise use could not serve as the key a succession departs from.
    const { pairingId, identityKey } = await approvedTransfer();
    const before = mobileKey();
    const res = await relay.app.request(`/pairing/${pairingId}/update-key`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ public_key: hex(identityKey).toUpperCase() }),
    });
    expect(res.status).toBe(403);
    expect(mobileKey()).toBe(before);
  });

  it("completes the approved transfer, and re-presenting the id writes only that same key again", async () => {
    // Bounded to one predetermined key, the pairing id stops being a
    // standing credential WITHOUT a single-use flag — which would have to
    // live in `status`, whose published values the clients switch on, and
    // would turn a retry after a lost response into a refusal.
    const { pairingId, identityKey } = await approvedTransfer();
    expect((await update(pairingId, identityKey)).status).toBe(200);
    expect(mobileKey()).toBe(hex(identityKey));
    expect((await update(pairingId, identityKey)).status).toBe(200);
    expect(mobileKey()).toBe(hex(identityKey));
    const attacker = await generateKeypair();
    expect((await update(pairingId, attacker)).status).toBe(403);
    expect(mobileKey()).toBe(hex(identityKey));
  });

  it("accepts the key the approving device said it was transferring, even if the relay's rows moved since", async () => {
    // Every client writes the transferred seed to its keyring BEFORE
    // calling this. A refusal that depended on rows the relay may have
    // dropped in between would strand device B holding a seed whose key
    // the relay no longer recognises, while the client reports that the
    // device kept its own keypair.
    const mid = crypto.randomUUID();
    const identityKey = await generateKeypair();
    const claimKey = await generateKeypair();
    expect(await registerSelf(mid, `${mid}-laptop`, identityKey)).toBe(201);
    const { token: pairToken } = await mintAudienceToken(
      { mid, did: `${mid}-laptop`, aud: "device:auth" },
      identityKey.privateKey,
    );
    const auth = { Authorization: `Bearer ${pairToken}` };
    const init = await relay.app.request("/pairing/initiate", { method: "POST", headers: auth });
    const { pairing_id, pairing_code } = (await init.json()) as {
      pairing_id: string;
      pairing_code: string;
    };
    expect(
      (
        await relay.app.request("/pairing/claim", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({
            pairing_code,
            device_name: "Mobile",
            public_key: hex(claimKey),
            x25519_pubkey: "b".repeat(64),
          }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await relay.app.request(`/pairing/${pairing_id}/approve`, {
          method: "POST",
          headers: { ...auth, ...JSON_HEADERS },
          body: JSON.stringify({
            key_transfer: {
              x25519_pubkey: "a".repeat(64),
              encrypted_seed: "c".repeat(96),
              nonce: "d".repeat(24),
              tag: "e".repeat(32),
              identity_pubkey_check: hex(identityKey),
            },
          }),
        })
      ).status,
    ).toBe(200);

    // The identity's rows go away between approve and the transfer.
    relay.moteDb.db.prepare("DELETE FROM devices WHERE device_id = ?").run(`${mid}-laptop`);
    relay.moteDb.db.prepare("DELETE FROM agent_registry WHERE motebit_id = ?").run(mid);
    const res = await relay.app.request(`/pairing/${pairing_id}/update-key`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ public_key: hex(identityKey) }),
    });
    expect(res.status).toBe(200);
    // And a different key is still refused on that same session.
    const other = await generateKeypair();
    expect(
      (
        await relay.app.request(`/pairing/${pairing_id}/update-key`, {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ public_key: hex(other) }),
        })
      ).status,
    ).toBe(403);
  });

  it("refuses a session that approved no key transfer — there is nothing to complete", async () => {
    // The fallback this replaces accepted any key the identity held, so
    // whoever had the pairing id could put the APPROVING device's key onto
    // the approved device's row: that device then holds a private key the
    // relay no longer recognises, locked out with no bearer involved.
    const { pairingId, identityKey, claimKey } = await approvedSession();
    expect((await update(pairingId, identityKey)).status).toBe(403);
    expect(mobileKey()).toBe(hex(claimKey));
  });
});

/**
 * What a recorded rotation must END.
 *
 * A device row's `public_key` is what `verifySignedTokenForDevice` checks
 * an owner token against, and it is resolved BEFORE the registry key — so
 * a row left holding the retired key shadows the rotation completely. The
 * relay recorded rotations without touching that table, which was a
 * deliberate deferral in `docs/doctrine/security-boundaries.md` on the
 * grounds that rotating an identity should not rotate independent device
 * keypairs. That reasoning is kept: only rows holding the key being
 * retired move.
 */
describe("a recorded rotation ends the old key here", () => {
  async function rotated(): Promise<{
    mid: string;
    k1: KeyPair;
    k2: KeyPair;
    linked: KeyPair;
  }> {
    const k1 = await generateKeypair();
    // Shipped clients mint the id as the sovereign commitment to k1 (#703 §5f: E-sov).
    const mid = await deriveSovereignMotebitId(hex(k1));
    const k2 = await generateKeypair();
    const linked = await generateKeypair();
    expect(await registerSelf(mid, `${mid}-laptop`, k1)).toBe(201);
    expect(await registerSelf(mid, `${mid}-vps`, k1)).toBe(200);
    relay.moteDb.db
      .prepare(
        "INSERT INTO devices (device_id, motebit_id, device_token, public_key, registered_at, device_name) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(`${mid}-tablet`, mid, crypto.randomUUID(), hex(linked), Date.now(), "linked");
    expect(await registerAgent(mid, k1)).toBe(200);
    const record = await signKeySuccession(
      k1.privateKey,
      k2.privateKey,
      k2.publicKey,
      k1.publicKey,
    );
    expect(await present(mid, `${mid}-laptop`, k1, mid, record)).toBe(200);
    return { mid, k1, k2, linked };
  }
  const deviceKey = (did: string): string =>
    (
      relay.moteDb.db.prepare("SELECT public_key FROM devices WHERE device_id = ?").get(did) as {
        public_key: string;
      }
    ).public_key;

  it("moves every row that held the retired key, and leaves an independent device key alone", async () => {
    const { mid, k2, linked } = await rotated();
    expect(deviceKey(`${mid}-laptop`)).toBe(hex(k2));
    expect(deviceKey(`${mid}-vps`)).toBe(hex(k2));
    expect(deviceKey(`${mid}-tablet`)).toBe(hex(linked));
    expect(registryKey(mid)).toBe(hex(k2));
  });

  it("so the retired key stops authenticating and the new one starts, on every machine", async () => {
    const { mid, k1, k2 } = await rotated();
    const path = `/api/v1/agents/${mid}/balance`;
    for (const did of [`${mid}-laptop`, `${mid}-vps`]) {
      const call = async (kp: KeyPair): Promise<number> =>
        (
          await relay.app.request(path, {
            headers: {
              Authorization: `Bearer ${await token(mid, did, kp, "account:balance")}`,
            },
          })
        ).status;
      expect(await call(k1)).toBe(401);
      expect(await call(k2)).toBe(200);
    }
  });

  it("is idempotent — a retry after a lost response appends no second link", async () => {
    const { mid, k1, k2 } = await rotated();
    const record = await signKeySuccession(
      k1.privateKey,
      k2.privateKey,
      k2.publicKey,
      k1.publicKey,
    );
    // The caller's key moved with the rotation, so the retry carries the
    // new one — as a real client would after restarting. It must answer
    // 200: a client told 400 here would believe its rotation failed and
    // keep the old key, while the relay had already applied it.
    expect(await present(mid, `${mid}-laptop`, k2, mid, record)).toBe(200);
    expect(successions(mid)).toBe(1);
  });

  it("lands as one write: if any part fails, none of it is applied", async () => {
    const { mid } = await rotated();
    const before = successions(mid);
    const k3 = await generateKeypair();
    const k4 = await generateKeypair();
    relay.moteDb.db
      .prepare("UPDATE devices SET public_key = ? WHERE device_id = ?")
      .run(hex(k3), `${mid}-laptop`);
    relay.moteDb.db
      .prepare("UPDATE agent_registry SET public_key = ? WHERE motebit_id = ?")
      .run(hex(k3), mid);
    // …and the one holder, which the doors would have moved with them (#703 Inc 2).
    relay.moteDb.db
      .prepare("UPDATE identity_keys SET public_key = ? WHERE motebit_id = ?")
      .run(hex(k3), mid);
    // Fail the LAST statement only. Renaming the table would break the
    // read that runs before any write, so the request would never reach
    // the writes and this would prove nothing.
    relay.moteDb.db.exec(
      "CREATE TRIGGER refuse_succession BEFORE INSERT ON relay_key_successions BEGIN SELECT RAISE(ABORT, 'refused'); END",
    );
    const record = await signKeySuccession(
      k3.privateKey,
      k4.privateKey,
      k4.publicKey,
      k3.publicKey,
    );
    const res = await relay.app.request(`/api/v1/agents/${mid}/rotate-key`, {
      method: "POST",
      headers: {
        ...JSON_HEADERS,
        Authorization: `Bearer ${await token(mid, `${mid}-laptop`, k3, "rotate-key")}`,
      },
      body: JSON.stringify(record),
    });
    relay.moteDb.db.exec("DROP TRIGGER refuse_succession");
    expect(res.status).toBeGreaterThanOrEqual(500);
    // The state with no way back: the registry moved to the new key while
    // the device rows still hold the old one. Neither may have happened.
    expect(registryKey(mid)).toBe(hex(k3));
    expect(deviceKey(`${mid}-laptop`)).toBe(hex(k3));
    expect(successions(mid)).toBe(before);
    // The holder is inside the same transaction: it did not move either.
    expect(
      (
        relay.moteDb.db
          .prepare("SELECT public_key FROM identity_keys WHERE motebit_id = ?")
          .get(mid) as { public_key: string }
      ).public_key,
    ).toBe(hex(k3));
  });

  it("the register door applies the same cascade, so a link it recorded is already finished — re-presenting it is a retry", async () => {
    // `/agents/register` with a succession used to move the registry key
    // and record the link while touching neither the device rows nor the
    // pairing payloads — a rotation that ended nothing, which a second
    // route then had to "finish". #710 tried exactly that and its test
    // PLANTED the chain row in a state the door never produces. Both doors
    // now call one `applySuccession`, so the state cannot exist: this
    // drives the real door and shows the rows moved THERE, and that
    // re-presenting the link to /rotate-key is a retry that changes nothing.
    const { mid, k2 } = await rotated();
    const k3 = await generateKeypair();
    const record = await signKeySuccession(
      k2.privateKey,
      k3.privateKey,
      k3.publicKey,
      k2.publicKey,
    );
    const viaRegister = await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: {
        ...JSON_HEADERS,
        // The bearer must verify against the key the relay holds — k2, on
        // the device row — while the body registers k3 with the succession.
        Authorization: `Bearer ${await token(mid, `${mid}-laptop`, k2)}`,
      },
      body: JSON.stringify({
        endpoint_url: "http://localhost:9999/mcp",
        capabilities: [],
        public_key: hex(k3),
        succession: record,
      }),
    });
    expect(viaRegister.status).toBe(200);
    // The door's own state: registry moved, link held, device rows MOVED.
    expect(registryKey(mid)).toBe(hex(k3));
    expect(successions(mid)).toBe(2);
    expect(deviceKey(`${mid}-laptop`)).toBe(hex(k3));
    expect(deviceKey(`${mid}-vps`)).toBe(hex(k3));
    expect(events(mid, "key_rotated")).toBe(2);

    // Re-presenting the same link here is a retry of the head: 200, the
    // chain does not grow, nothing moves, no second federation event. The
    // bearer is signed with k3 — the key the laptop row holds NOW; a retry
    // signed with the retired key is 401 by construction, which is why the
    // client design reads the chain instead of re-sending.
    const res = await relay.app.request(`/api/v1/agents/${mid}/rotate-key`, {
      method: "POST",
      headers: {
        ...JSON_HEADERS,
        Authorization: `Bearer ${await token(mid, `${mid}-laptop`, k3, "rotate-key")}`,
      },
      body: JSON.stringify(record),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ applied: false });
    expect(deviceKey(`${mid}-laptop`)).toBe(hex(k3));
    expect(deviceKey(`${mid}-vps`)).toBe(hex(k3));
    expect(registryKey(mid)).toBe(hex(k3));
    expect(successions(mid)).toBe(2);
    expect(events(mid, "key_rotated")).toBe(2);
  });

  it("a stray re-presentation of an OLD link — not the head — is refused and moves nothing", async () => {
    // Chain k1→k2→k3. k1→k2 arriving after k2→k3 is not a retry of the
    // head: it is a record departing from a key that is neither the registry
    // key nor the chain head, and the key-on-file rule refuses it. Nothing
    // moves — in particular the registry does not fall back from k3 to k2,
    // which would refuse the identity's next rotation from the real head.
    // (The client design never sends this; it READS the chain and stops.)
    const { mid, k1, k2 } = await rotated();
    const first = await signKeySuccession(k1.privateKey, k2.privateKey, k2.publicKey, k1.publicKey);
    const k3 = await generateKeypair();
    const second = await signKeySuccession(
      k2.privateKey,
      k3.privateKey,
      k3.publicKey,
      k2.publicKey,
    );
    expect(await present(mid, `${mid}-laptop`, k2, mid, second)).toBe(200);
    expect(registryKey(mid)).toBe(hex(k3));

    // The bearer is one the relay can verify: the laptop row now holds k3.
    const res = await relay.app.request(`/api/v1/agents/${mid}/rotate-key`, {
      method: "POST",
      headers: {
        ...JSON_HEADERS,
        Authorization: `Bearer ${await token(mid, `${mid}-laptop`, k3, "rotate-key")}`,
      },
      body: JSON.stringify(first),
    });
    expect(res.status).toBe(400);
    expect(registryKey(mid)).toBe(hex(k3));
    expect(deviceKey(`${mid}-laptop`)).toBe(hex(k3));
    expect(successions(mid)).toBe(2);
    // And the identity can still rotate from the real head.
    const k4 = await generateKeypair();
    const third = await signKeySuccession(k3.privateKey, k4.privateKey, k4.publicKey, k3.publicKey);
    expect(await present(mid, `${mid}-laptop`, k3, mid, third)).toBe(200);
    expect(registryKey(mid)).toBe(hex(k4));
  });

  // ── A key never enters an identity's history twice (#775). ──
  //
  // A rotation back to a key the identity has held used to be recorded as a
  // new link. Every roster consumer then refuses that chain as
  // `duplicate_key` (`verifyHostRoster`, `spec/machine-roster-v1.md` §6)
  // forever, and the rotate-back put the holder on an old key again, which
  // made an earlier guardian recovery from that key re-presentable by anyone
  // inside its freshness window, undoing the rotate-back.

  const holderKey = (mid: string): string | undefined =>
    (
      relay.moteDb.db
        .prepare("SELECT public_key FROM identity_keys WHERE motebit_id = ?")
        .get(mid) as { public_key: string } | undefined
    )?.public_key;
  const successionRefusals = (): Array<{ motebit_id: string | null; reason: string }> =>
    relay.moteDb.db
      .prepare(
        "SELECT motebit_id, reason FROM relay_auth_events WHERE reason LIKE 'succession:%' ORDER BY rowid",
      )
      .all() as Array<{ motebit_id: string | null; reason: string }>;
  const servedChainVerifies = async (mid: string, current: KeyPair): Promise<void> => {
    const served = (await (await relay.app.request(`/api/v1/agents/${mid}/succession`)).json()) as {
      chain: KeySuccessionRecord[];
    };
    const verdict = await verifySuccessionChain(served.chain);
    expect(verdict.valid).toBe(true);
    expect(verdict.current_public_key).toBe(hex(current));
  };

  it("refuses a rotation BACK to a key the identity has held (A→B→A), records it, and moves nothing", async () => {
    const { mid, k1, k2 } = await rotated();
    const back = await signKeySuccession(k2.privateKey, k1.privateKey, k1.publicKey, k2.publicKey);
    const res = await relay.app.request(`/api/v1/agents/${mid}/rotate-key`, {
      method: "POST",
      headers: {
        ...JSON_HEADERS,
        Authorization: `Bearer ${await token(mid, `${mid}-laptop`, k2, "rotate-key")}`,
      },
      body: JSON.stringify(back),
    });
    expect(res.status).toBe(409);
    expect(successions(mid)).toBe(1);
    expect(registryKey(mid)).toBe(hex(k2));
    expect(holderKey(mid)).toBe(hex(k2));
    expect(deviceKey(`${mid}-laptop`)).toBe(hex(k2));
    expect(events(mid, "key_rotated")).toBe(1);
    // Recorded like every other refusal on this route, naming the presenter.
    expect(successionRefusals()).toEqual([{ motebit_id: mid, reason: "succession:reuses_key" }]);
    await servedChainVerifies(mid, k2);
  });

  it("refuses a key from anywhere in the history, not only the one just left (A→B→C→A)", async () => {
    const { mid, k1, k2 } = await rotated();
    const k3 = await generateKeypair();
    const toC = await signKeySuccession(k2.privateKey, k3.privateKey, k3.publicKey, k2.publicKey);
    expect(await present(mid, `${mid}-laptop`, k2, mid, toC)).toBe(200);
    const backToA = await signKeySuccession(
      k3.privateKey,
      k1.privateKey,
      k1.publicKey,
      k3.publicKey,
    );
    expect(await present(mid, `${mid}-laptop`, k3, mid, backToA)).toBe(409);
    expect(successions(mid)).toBe(2);
    expect(holderKey(mid)).toBe(hex(k3));
    await servedChainVerifies(mid, k3);
  });

  it("accepts a rotation onward to a key the identity has never held (A→B→C)", async () => {
    const { mid, k2 } = await rotated();
    const k3 = await generateKeypair();
    const onward = await signKeySuccession(
      k2.privateKey,
      k3.privateKey,
      k3.publicKey,
      k2.publicKey,
    );
    const res = await relay.app.request(`/api/v1/agents/${mid}/rotate-key`, {
      method: "POST",
      headers: {
        ...JSON_HEADERS,
        Authorization: `Bearer ${await token(mid, `${mid}-laptop`, k2, "rotate-key")}`,
      },
      body: JSON.stringify(onward),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ applied: true });
    expect(successions(mid)).toBe(2);
    expect(holderKey(mid)).toBe(hex(k3));
    expect(successionRefusals()).toEqual([]);
    await servedChainVerifies(mid, k3);
  });

  it("the register door refuses a registration back to a key the identity has held, and records it", async () => {
    const { mid, k1, k2 } = await rotated();
    const back = await signKeySuccession(k2.privateKey, k1.privateKey, k1.publicKey, k2.publicKey);
    const res = await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: {
        ...JSON_HEADERS,
        Authorization: `Bearer ${await token(mid, `${mid}-laptop`, k2)}`,
      },
      body: JSON.stringify({
        endpoint_url: "http://localhost:9999/mcp",
        capabilities: [],
        public_key: hex(k1),
        succession: back,
      }),
    });
    expect(res.status).toBe(409);
    expect(successions(mid)).toBe(1);
    expect(registryKey(mid)).toBe(hex(k2));
    expect(holderKey(mid)).toBe(hex(k2));
    expect(deviceKey(`${mid}-laptop`)).toBe(hex(k2));
    expect(events(mid, "key_rotated")).toBe(1);
    expect(successionRefusals()).toEqual([{ motebit_id: mid, reason: "succession:reuses_key" }]);
  });

  it("a guardian recovery re-presented after a later link is never applied again (the #777 replay)", async () => {
    // K1→K2 by guardian recovery, carried by a third party. Before #775 the
    // owner could then rotate back K2→K1, and the holder on K1 made the
    // recovery K1→K2 departable again: anyone holding it could replay it
    // inside its 15-minute window and undo the rotate-back (recovery skips
    // the caller check). The rotate-back is now refused, so the replay's
    // precondition is built here the way a relay running the old rule left
    // it: [K1→K2 recovery, K2→K1] recorded, every row back on K1.
    const k1 = await generateKeypair();
    const mid = await deriveSovereignMotebitId(hex(k1));
    const k2 = await generateKeypair();
    const guardian = await generateKeypair();
    expect(await registerSelf(mid, `${mid}-laptop`, k1)).toBe(201);
    expect(await registerAgent(mid, k1, guardian)).toBe(200);
    const recovery = await signGuardianRecoverySuccession(
      guardian.privateKey,
      k2.privateKey,
      k1.publicKey,
      k2.publicKey,
    );
    const s = await stranger();
    expect(await present(s.mid, `${s.mid}-laptop`, s.kp, mid, recovery)).toBe(200);
    expect(holderKey(mid)).toBe(hex(k2));

    // The rotate-back is refused at the route now.
    const back = await signKeySuccession(k2.privateKey, k1.privateKey, k1.publicKey, k2.publicKey);
    expect(await present(mid, `${mid}-laptop`, k2, mid, back)).toBe(409);
    expect(holderKey(mid)).toBe(hex(k2));

    // A relay that ran the old rule recorded it: plant that state.
    const db = relay.moteDb.db;
    db.prepare(
      `INSERT INTO relay_key_successions (motebit_id, old_public_key, new_public_key, timestamp, reason, old_key_signature, new_key_signature, recovery, guardian_signature) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL)`,
    ).run(
      mid,
      back.old_public_key,
      back.new_public_key,
      back.timestamp,
      back.reason ?? null,
      back.old_key_signature,
      back.new_key_signature,
    );
    db.prepare("UPDATE identity_keys SET public_key = ? WHERE motebit_id = ?").run(hex(k1), mid);
    db.prepare("UPDATE agent_registry SET public_key = ? WHERE motebit_id = ?").run(hex(k1), mid);
    db.prepare("UPDATE devices SET public_key = ? WHERE motebit_id = ?").run(hex(k1), mid);

    // The replay: the same recovery record, still fresh, carried by anyone.
    // It departs from the key held (K1), so only #775 stands in its way.
    expect(await present(s.mid, `${s.mid}-laptop`, s.kp, mid, recovery)).toBe(409);
    expect(successions(mid)).toBe(2);
    expect(holderKey(mid)).toBe(hex(k1));
    expect(registryKey(mid)).toBe(hex(k1));
    expect(deviceKey(`${mid}-laptop`)).toBe(hex(k1));
    expect(successionRefusals()).toEqual([
      { motebit_id: mid, reason: "succession:reuses_key" },
      { motebit_id: s.mid, reason: "succession:replays_recorded_link" },
    ]);
    // And a rotation onward from what is held still lands.
    const k3 = await generateKeypair();
    const onward = await signKeySuccession(
      k1.privateKey,
      k3.privateKey,
      k3.publicKey,
      k1.publicKey,
    );
    expect(await present(mid, `${mid}-laptop`, k1, mid, onward)).toBe(200);
    expect(holderKey(mid)).toBe(hex(k3));
  });

  it("the head link re-presented is still a retry, not a reuse", async () => {
    // The head's own new key is in the history by definition. A retry of it
    // (a lost response) must stay 200 with nothing appended.
    const { mid, k1, k2 } = await rotated();
    const retry = await signKeySuccession(k1.privateKey, k2.privateKey, k2.publicKey, k1.publicKey);
    const res = await relay.app.request(`/api/v1/agents/${mid}/rotate-key`, {
      method: "POST",
      headers: {
        ...JSON_HEADERS,
        Authorization: `Bearer ${await token(mid, `${mid}-laptop`, k2, "rotate-key")}`,
      },
      body: JSON.stringify(retry),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ applied: false });
    expect(successions(mid)).toBe(1);
    expect(successionRefusals()).toEqual([]);
  });

  it("the one writer refuses a reuse whichever door calls it, in any spelling, and writes nothing", async () => {
    // Doors pre-check nothing: `applySuccession` is the chokepoint, so a
    // door added later cannot forget the rule.
    const { mid, k1, k2 } = await rotated();
    const back = await signKeySuccession(k2.privateKey, k1.privateKey, k1.publicKey, k2.publicKey);
    const retired: string[] = [];
    for (const record of [back, { ...back, new_public_key: hex(k1).toUpperCase() }]) {
      let thrown: unknown;
      try {
        applySuccession(relay.moteDb.db, mid, record, (_m, key) => retired.push(key));
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(SuccessionRefused);
      expect((thrown as SuccessionRefused).reason).toBe("reuses_key");
    }
    expect(retired).toEqual([]);
    expect(successions(mid)).toBe(1);
    expect(deviceKey(`${mid}-laptop`)).toBe(hex(k2));
    expect(registryKey(mid)).toBe(hex(k2));
  });

  it("the history includes the registry key, not only the chain", async () => {
    // A registry that disagrees with the holder is a state main's rules can
    // leave (the registry is written by doors the holder is not). Rotating
    // onto the key the registry already names would record a key the
    // identity has answered to as a new one.
    const k1 = await generateKeypair();
    const mid = await deriveSovereignMotebitId(hex(k1));
    expect(await registerSelf(mid, `${mid}-laptop`, k1)).toBe(201);
    expect(await registerAgent(mid, k1)).toBe(200);
    const other = await generateKeypair();
    relay.moteDb.db
      .prepare("UPDATE agent_registry SET public_key = ? WHERE motebit_id = ?")
      .run(hex(other), mid);
    expect(holderKey(mid)).toBe(hex(k1));
    const onto = await signKeySuccession(
      k1.privateKey,
      other.privateKey,
      other.publicKey,
      k1.publicKey,
    );
    expect(() => applySuccession(relay.moteDb.db, mid, onto, () => {})).toThrow(SuccessionRefused);
    expect(successions(mid)).toBe(0);
    expect(holderKey(mid)).toBe(hex(k1));
  });

  it("the history includes the holder key: a writer caller that skipped departure cannot land on it", async () => {
    // At the route this is unreachable — with a holder, departure requires
    // old = holder, so new = holder goes nowhere — which is exactly why the
    // writer must hold the line itself.
    const k1 = await generateKeypair();
    const mid = await deriveSovereignMotebitId(hex(k1));
    expect(await registerSelf(mid, `${mid}-laptop`, k1)).toBe(201);
    expect(await registerAgent(mid, k1)).toBe(200);
    const other = await generateKeypair();
    relay.moteDb.db
      .prepare("UPDATE agent_registry SET public_key = ? WHERE motebit_id = ?")
      .run(hex(other), mid);
    expect(holderKey(mid)).toBe(hex(k1));
    const ontoHolder = await signKeySuccession(
      other.privateKey,
      k1.privateKey,
      k1.publicKey,
      other.publicKey,
    );
    let thrown: unknown;
    try {
      applySuccession(relay.moteDb.db, mid, ontoHolder, () => {});
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SuccessionRefused);
    expect((thrown as SuccessionRefused).reason).toBe("reuses_key");
    expect(successions(mid)).toBe(0);
    expect(registryKey(mid)).toBe(hex(other));
  });

  // Lowercasing is not canonicalization: `hexToBytes` decodes leniently, so a
  // legacy chain row may spell a key in a form only the verifier recognises
  // (#782 round 1). These build that legacy state directly — no current door
  // can write it (`admitKey`), and production holds none (2026-09-25: 0
  // successions, 0 non-canonical device or registry keys).
  const signAs = async (
    oldKp: KeyPair,
    oldSpelling: string,
    newKp: KeyPair,
    newSpelling: string,
  ) => {
    const timestamp = Date.now();
    const suite = "motebit-jcs-ed25519-hex-v1";
    const msg = new TextEncoder().encode(
      canonicalJson({ old_public_key: oldSpelling, new_public_key: newSpelling, timestamp, suite }),
    );
    return {
      old_public_key: oldSpelling,
      new_public_key: newSpelling,
      timestamp,
      suite,
      old_key_signature: bytesToHex(await ed25519Sign(msg, oldKp.privateKey)),
      new_key_signature: bytesToHex(await ed25519Sign(msg, newKp.privateKey)),
    };
  };
  const insertLegacyLink = (mid: string, oldKey: string, newKey: string) =>
    relay.moteDb.db
      .prepare(
        "INSERT INTO relay_key_successions (motebit_id, old_public_key, new_public_key, timestamp, reason, old_key_signature, new_key_signature, recovery, guardian_signature) VALUES (?, ?, ?, ?, NULL, 'x', 'x', 0, NULL)",
      )
      .run(mid, oldKey, newKey, Date.now());
  /** A key whose hex has a '0' opening some byte, and a lenient re-spelling of it ("0a" → "a "). */
  const keyWithLenientSpelling = async (): Promise<{ kp: KeyPair; alt: string }> => {
    for (;;) {
      const kp = await generateKeypair();
      const h = hex(kp);
      for (let i = 0; i < h.length; i += 2) {
        if (h[i] === "0") return { kp, alt: h.slice(0, i) + h[i + 1] + " " + h.slice(i + 2) };
      }
    }
  };

  it("a key spelled leniently in a legacy link is still that key: rotating to its canonical spelling is refused", async () => {
    const mid = crypto.randomUUID();
    const a = await generateKeypair();
    const b = await generateKeypair();
    const { kp: k, alt } = await keyWithLenientSpelling();
    expect(alt).not.toBe(hex(k));
    expect(alt.toLowerCase()).not.toBe(hex(k)); // lowercasing alone cannot see it
    const reg = await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        motebit_id: mid,
        endpoint_url: "http://localhost:9999/mcp",
        capabilities: [],
        public_key: hex(b),
      }),
    });
    expect(reg.status).toBe(200);
    insertLegacyLink(mid, hex(a), alt);
    insertLegacyLink(mid, alt, hex(b));
    const toK = await signKeySuccession(b.privateKey, k.privateKey, k.publicKey, b.publicKey);
    const res = await relay.app.request(`/api/v1/agents/${mid}/rotate-key`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify(toK),
    });
    expect(res.status).toBe(409);
    expect(successions(mid)).toBe(2);
  });

  it("departing from a retired key spelled in UPPERCASE is still departing from a retired key", async () => {
    const mid = crypto.randomUUID();
    const k = await generateKeypair();
    const b = await generateKeypair();
    const c = await generateKeypair();
    insertLegacyLink(mid, hex(k), hex(b));
    const reg = await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        motebit_id: mid,
        endpoint_url: "http://localhost:9999/mcp",
        capabilities: [],
      }),
    });
    expect(reg.status).toBe(200);
    relay.moteDb.db
      .prepare("UPDATE agent_registry SET public_key = ? WHERE motebit_id = ?")
      .run(hex(k).toUpperCase(), mid);
    relay.moteDb.db.prepare("DELETE FROM identity_keys WHERE motebit_id = ?").run(mid);
    const fork = await signAs(k, hex(k).toUpperCase(), c, hex(c));
    const res = await relay.app.request(`/api/v1/agents/${mid}/rotate-key`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify(fork),
    });
    expect(res.status).toBe(409);
    expect(successions(mid)).toBe(1);
  });

  it("refuses a link whose two sides are one key spelled twice (UPPER(K) → k, from a legacy device row)", async () => {
    // A legacy device row stored non-canonically (main's older case-folding
    // guard admitted these; `admitKey` stops new ones). With no holder, no
    // registry and no chain, departure falls to the exact device row, and
    // `goes_nowhere` compares exactly — so a correctly signed
    // { old: UPPER(K), new: k } was recorded: one key on both sides of a link
    // (#780's decisive review).
    const mid = crypto.randomUUID();
    const k = await generateKeypair();
    expect(await registerSelf(mid, `${mid}-legacy`, k)).toBe(201);
    const upper = hex(k).toUpperCase();
    relay.moteDb.db
      .prepare("UPDATE devices SET public_key = ? WHERE motebit_id = ?")
      .run(upper, mid);
    relay.moteDb.db.prepare("DELETE FROM agent_registry WHERE motebit_id = ?").run(mid);
    relay.moteDb.db.prepare("DELETE FROM identity_keys WHERE motebit_id = ?").run(mid);
    const timestamp = Date.now();
    const suite = "motebit-jcs-ed25519-hex-v1";
    const msg = new TextEncoder().encode(
      canonicalJson({ old_public_key: upper, new_public_key: hex(k), timestamp, suite }),
    );
    const sig = bytesToHex(await ed25519Sign(msg, k.privateKey));
    const record = {
      old_public_key: upper,
      new_public_key: hex(k),
      timestamp,
      suite,
      old_key_signature: sig,
      new_key_signature: sig,
    };
    const res = await relay.app.request(`/api/v1/agents/${mid}/rotate-key`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify(record),
    });
    expect(res.status).toBe(409);
    expect(successions(mid)).toBe(0);
  });

  it("refuses a link that DEPARTS from a retired key — a holder-less identity cannot fork its chain (K1→K2, then K1→K3)", async () => {
    // A legacy identity with no holder row, whose registry is emptied by a
    // keyless master-token registration and then re-filled with the retired
    // K1 by whoever still holds it. Departure (main's rule: the registry
    // key) admits K1 again; only the history can say K1 is retired.
    const mid = crypto.randomUUID();
    const k1 = await generateKeypair();
    const k2 = await generateKeypair();
    const k3 = await generateKeypair();
    const master = async (body: Record<string, unknown>): Promise<number> =>
      (
        await relay.app.request("/api/v1/agents/register", {
          method: "POST",
          headers: JSON_AUTH,
          body: JSON.stringify({
            motebit_id: mid,
            endpoint_url: "http://localhost:9999/mcp",
            capabilities: [],
            ...body,
          }),
        })
      ).status;
    expect(await master({ public_key: hex(k1) })).toBe(200);
    relay.moteDb.db.prepare("DELETE FROM identity_keys WHERE motebit_id = ?").run(mid);
    expect(holderKey(mid)).toBeUndefined();

    const toK2 = await signKeySuccession(k1.privateKey, k2.privateKey, k2.publicKey, k1.publicKey);
    const r1 = await relay.app.request(`/api/v1/agents/${mid}/rotate-key`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify(toK2),
    });
    expect(r1.status).toBe(200);
    expect(registryKey(mid)).toBe(hex(k2));

    expect(await master({})).toBe(200);
    expect(registryKey(mid)).toBe("");
    expect(await registerSelf(mid, `${mid}-laptop`, k1)).toBe(201);
    expect(await registerAgent(mid, k1)).toBe(200);
    expect(registryKey(mid)).toBe(hex(k1));

    const fork = await signKeySuccession(k1.privateKey, k3.privateKey, k3.publicKey, k1.publicKey);
    expect(await present(mid, `${mid}-laptop`, k1, mid, fork)).toBe(409);
    expect(successions(mid)).toBe(1);
    expect(registryKey(mid)).toBe(hex(k1));
    expect(successionRefusals()).toEqual([
      { motebit_id: mid, reason: "succession:departs_from_retired_key" },
    ]);
  });

  it("a rotation recorded at /rotate-key reaches federation, and a retry does not repeat it", async () => {
    const { mid, k1, k2 } = await rotated();
    expect(events(mid, "key_rotated")).toBe(1);
    const record = await signKeySuccession(
      k1.privateKey,
      k2.privateKey,
      k2.publicKey,
      k1.publicKey,
    );
    // rotated() already recorded k1→k2 with its own record; this fresh
    // record has the same keys and is a retry of the head by construction.
    expect(await present(mid, `${mid}-laptop`, k2, mid, record)).toBe(200);
    expect(events(mid, "key_rotated")).toBe(1);
  });

  it("a retry of the head is accepted after the freshness window has closed — the relay judged that timestamp once", async () => {
    // The record's timestamp is inside the signature, so a client cannot
    // refresh a held record; and a link the register door recorded may be
    // re-presented long after. Refusing the retry as "too old" would tell a
    // client its rotation failed when it succeeded. A NEW link that old is
    // still refused.
    const { mid, k1, k2 } = await rotated();
    const retry = await signKeySuccession(k1.privateKey, k2.privateKey, k2.publicKey, k1.publicKey);
    const k3 = await generateKeypair();
    const fresh = await signKeySuccession(k2.privateKey, k3.privateKey, k3.publicKey, k2.publicKey);
    vi.useFakeTimers({ now: Date.now() + 20 * 60_000, toFake: ["Date"] });
    try {
      expect(await present(mid, `${mid}-laptop`, k2, mid, retry)).toBe(200);
      expect(successions(mid)).toBe(1);
      expect(await present(mid, `${mid}-laptop`, k2, mid, fresh)).toBe(400);
      expect(registryKey(mid)).toBe(hex(k2));
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a hardware-attestation credential bound to the key it retires", async () => {
    // The credential names the key it was attached to, and the attach
    // route refuses a mismatch. Carried across a rotation it would be
    // published beside a key it does not name, and a peer checking the
    // binding this relay itself enforces would reject the agent.
    const k1 = await generateKeypair();
    // Shipped clients mint the id as the sovereign commitment to k1 (#703 §5f: E-sov).
    const mid = await deriveSovereignMotebitId(hex(k1));
    const k2 = await generateKeypair();
    expect(await registerSelf(mid, `${mid}-laptop`, k1)).toBe(201);
    expect(await registerAgent(mid, k1)).toBe(200);
    relay.moteDb.db
      .prepare("UPDATE devices SET hardware_attestation_credential = ? WHERE device_id = ?")
      .run(
        JSON.stringify({ credentialSubject: { identity_public_key: hex(k1) } }),
        `${mid}-laptop`,
      );
    const record = await signKeySuccession(
      k1.privateKey,
      k2.privateKey,
      k2.publicKey,
      k1.publicKey,
    );
    expect(await present(mid, `${mid}-laptop`, k1, mid, record)).toBe(200);
    const row = relay.moteDb.db
      .prepare("SELECT hardware_attestation_credential AS c FROM devices WHERE device_id = ?")
      .get(`${mid}-laptop`) as { c: string | null };
    expect(row.c).toBeNull();
  });

  it("a guardian recovery ends the old key too", async () => {
    const k1 = await generateKeypair();
    // Shipped clients mint the id as the sovereign commitment to k1 (#703 §5f: E-sov).
    const mid = await deriveSovereignMotebitId(hex(k1));
    const next = await generateKeypair();
    const guardian = await generateKeypair();
    expect(await registerSelf(mid, `${mid}-laptop`, k1)).toBe(201);
    expect(await registerAgent(mid, k1, guardian)).toBe(200);
    const recovery = await signGuardianRecoverySuccession(
      guardian.privateKey,
      next.privateKey,
      k1.publicKey,
      next.publicKey,
    );
    const s = await stranger();
    expect(await present(s.mid, `${s.mid}-laptop`, s.kp, mid, recovery)).toBe(200);
    // Recovery is for an owner who lost the key. One that left the lost key
    // authenticating would have recovered nothing. A guardian can already
    // move the identity to any key, so this adds no power it lacked.
    expect(deviceKey(`${mid}-laptop`)).toBe(hex(next));
  });
});

describe("a rotation retires a pairing approval that carried the old key", () => {
  it("refuses a stale approved transfer, so the retired key cannot be written back", async () => {
    // Pairing's key-transfer route takes no bearer and its session is not
    // consumed, by design — bounded to one predetermined key, replaying it
    // rewrites the same key. A rotation is what falsifies that: the
    // approved key is now the RETIRED one, and writing it back onto a
    // device row resurrects it, because the row is read before the
    // registry.
    const k1 = await generateKeypair();
    // Shipped clients mint the id as the sovereign commitment to k1 (#703 §5f: E-sov).
    const mid = await deriveSovereignMotebitId(hex(k1));
    const k2 = await generateKeypair();
    const claimKey = await generateKeypair();
    expect(await registerSelf(mid, `${mid}-laptop`, k1)).toBe(201);
    expect(await registerAgent(mid, k1)).toBe(200);
    const { token: pairToken } = await mintAudienceToken(
      { mid, did: `${mid}-laptop`, aud: "device:auth" },
      k1.privateKey,
    );
    const auth = { Authorization: `Bearer ${pairToken}` };
    const init = await relay.app.request("/pairing/initiate", { method: "POST", headers: auth });
    const { pairing_id, pairing_code } = (await init.json()) as {
      pairing_id: string;
      pairing_code: string;
    };
    expect(
      (
        await relay.app.request("/pairing/claim", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({
            pairing_code,
            device_name: "Mobile",
            public_key: hex(claimKey),
            x25519_pubkey: "b".repeat(64),
          }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await relay.app.request(`/pairing/${pairing_id}/approve`, {
          method: "POST",
          headers: { ...auth, ...JSON_HEADERS },
          body: JSON.stringify({
            key_transfer: {
              x25519_pubkey: "a".repeat(64),
              encrypted_seed: "c".repeat(96),
              nonce: "d".repeat(24),
              tag: "e".repeat(32),
              identity_pubkey_check: hex(k1),
            },
          }),
        })
      ).status,
    ).toBe(200);

    // An approval carrying a key this rotation is NOT about, present
    // before it runs: clearing every session would strand an unrelated
    // pairing mid-transfer, with no signal to re-pair.
    const unrelated = crypto.randomUUID();
    const untouchedKey = await generateKeypair();
    relay.moteDb.db
      .prepare(
        "INSERT INTO pairing_sessions (pairing_id, motebit_id, initiator_device_id, pairing_code, status, created_at, expires_at, key_transfer_payload) VALUES (?, ?, ?, ?, 'approved', ?, ?, ?)",
      )
      .run(
        unrelated,
        mid,
        `${mid}-laptop`,
        "ZZZ999",
        1,
        2,
        JSON.stringify({ identity_pubkey_check: hex(untouchedKey) }),
      );

    const record = await signKeySuccession(
      k1.privateKey,
      k2.privateKey,
      k2.publicKey,
      k1.publicKey,
    );
    expect(await present(mid, `${mid}-laptop`, k1, mid, record)).toBe(200);

    const survived = relay.moteDb.db
      .prepare("SELECT key_transfer_payload AS p FROM pairing_sessions WHERE pairing_id = ?")
      .get(unrelated) as { p: string | null };
    expect(survived.p).not.toBeNull();

    const replay = await relay.app.request(`/pairing/${pairing_id}/update-key`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ public_key: hex(k1) }),
    });
    expect(replay.status).toBe(403);
    const mobile = relay.moteDb.db
      .prepare("SELECT public_key FROM devices WHERE device_name = 'Mobile'")
      .get() as { public_key: string };
    expect(mobile.public_key).toBe(hex(claimKey));
    // And the retired key is not a credential by that route either.
    const balance = await relay.app.request(`/api/v1/agents/${mid}/balance`, {
      headers: {
        Authorization: `Bearer ${await token(mid, `${mid}-laptop`, k1, "account:balance")}`,
      },
    });
    expect(balance.status).toBe(401);
  });
});
