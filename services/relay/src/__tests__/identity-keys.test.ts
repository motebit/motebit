/**
 * identity-keys — the holder, the three questions, and the six laws between
 * them (#703 Inc 2, proposal identity-key-state-v1 §5, §5a, §5b).
 *
 * The first build was withdrawn after two review rounds found the same
 * defect eight times: a door moved to the holder while a sibling kept
 * reasoning from the old tables. So besides pinning the resolver's
 * precedence and each door's write, this file plants the four tables
 * against each other and checks the laws §5b states between the guard, the
 * authority, the reader and the doors — L1 through L6 — and §8's two
 * stopping clauses as enumerated states.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseDriver } from "@motebit/persistence";
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

import type { SyncRelay } from "../index.js";
import {
  IDENTITY_KEYS_BACKFILL_SQL,
  identityGuardianFor,
  identityKeyFor,
  keysHeldBy,
  provenIdentityKey,
  recordFirstIdentityKey,
  recordIdentityKey,
} from "../identity-keys.js";
import { applySuccession, departureFrom, keyOnFile } from "../succession-apply.js";
import { readIdentityBindings } from "../identity-transparency.js";
import { createTestRelay, AUTH_HEADER, JSON_AUTH } from "./test-helpers.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const D = "d".repeat(64);
const E = "e".repeat(64);
const JSON_HEADERS = { "Content-Type": "application/json" };
const hex = (kp: KeyPair) => bytesToHex(kp.publicKey);

function plantRegistry(
  db: DatabaseDriver,
  mid: string,
  key: string,
  guardian: string | null = null,
) {
  db.prepare(
    "INSERT INTO agent_registry (motebit_id, public_key, endpoint_url, registered_at, last_heartbeat, expires_at, guardian_public_key) VALUES (?, ?, '', ?, ?, ?, ?)",
  ).run(mid, key, 1_000, 1_000, 9_999_999_999_999, guardian);
}
function plantChain(db: DatabaseDriver, mid: string, from: string, to: string) {
  db.prepare(
    "INSERT INTO relay_key_successions (motebit_id, old_public_key, new_public_key, timestamp, new_key_signature) VALUES (?, ?, ?, ?, 'sig')",
  ).run(mid, from, to, 2_000);
}
function plantDevice(db: DatabaseDriver, mid: string, id: string, key: string) {
  db.prepare(
    "INSERT INTO devices (device_id, motebit_id, device_token, public_key, registered_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, mid, `tok-${id}`, key, 3_000);
}
function holderRow(db: DatabaseDriver, mid: string) {
  return db.prepare("SELECT * FROM identity_keys WHERE motebit_id = ?").get(mid);
}

/**
 * The planted states §5b's laws range over. Each returns the key the state
 * is "about" (what the identity would present) so a law can quantify.
 */
const STATES: Record<string, (db: DatabaseDriver, mid: string) => string> = {
  "holder only": (db, mid) => {
    recordIdentityKey(db, { motebitId: mid, publicKey: A, source: "bootstrap", now: 1 });
    return A;
  },
  "registry only": (db, mid) => {
    plantRegistry(db, mid, A);
    return A;
  },
  "chain only": (db, mid) => {
    plantChain(db, mid, B, A);
    return A;
  },
  "devices agree": (db, mid) => {
    plantDevice(db, mid, `${mid}-1`, A);
    plantDevice(db, mid, `${mid}-2`, A);
    return A;
  },
  "devices disagree": (db, mid) => {
    plantDevice(db, mid, `${mid}-1`, A);
    plantDevice(db, mid, `${mid}-2`, B);
    return A;
  },
  "registry '' beside a holder": (db, mid) => {
    plantRegistry(db, mid, "");
    recordIdentityKey(db, { motebitId: mid, publicKey: A, source: "register-self", now: 1 });
    return A;
  },
};

describe("identity-keys", () => {
  let relay: SyncRelay;
  let db: DatabaseDriver;
  beforeEach(async () => {
    relay = await createTestRelay();
    db = relay.moteDb.db;
  });
  afterEach(async () => {
    await relay.close();
  });

  async function registerSelf(mid: string, deviceId: string, kp: KeyPair): Promise<number> {
    const body = await signDeviceRegistration(
      {
        motebit_id: mid,
        device_id: deviceId,
        public_key: hex(kp),
        device_name: "t",
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
  async function bootstrap(mid: string, deviceId: string, publicKey: string): Promise<number> {
    const res = await relay.app.request("/api/v1/agents/bootstrap", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ motebit_id: mid, device_id: deviceId, public_key: publicKey }),
    });
    return res.status;
  }
  async function guardianFields(mid: string, guardian: KeyPair) {
    return {
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
  }
  /** Operator-bearer registration; `extra` carries a key, a guardian, a succession. */
  async function registerAgent(mid: string, extra: Record<string, unknown>): Promise<Response> {
    return relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        motebit_id: mid,
        endpoint_url: "http://localhost:9999/mcp",
        capabilities: [],
        ...extra,
      }),
    });
  }
  async function presentRecovery(target: string, record: unknown): Promise<number> {
    const s = crypto.randomUUID();
    const kp = await generateKeypair();
    expect(await registerSelf(s, `${s}-laptop`, kp)).toBe(201);
    const { token } = await mintAudienceToken(
      { mid: s, did: `${s}-laptop`, aud: "rotate-key" },
      kp.privateKey,
    );
    const res = await relay.app.request(`/api/v1/agents/${target}/rotate-key`, {
      method: "POST",
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` },
      body: JSON.stringify(record),
    });
    return res.status;
  }

  describe("the three questions, one function each", () => {
    it("identityKeyFor: holder > registry > chain head > agreeing devices > null; provenIdentityKey never reaches devices", () => {
      const mid = "mote-prec";
      plantRegistry(db, mid, B);
      plantChain(db, mid, B, C);
      plantDevice(db, mid, "d1", D);
      plantDevice(db, mid, "d2", D);
      recordIdentityKey(db, { motebitId: mid, publicKey: A, source: "register", now: 5 });
      expect(identityKeyFor(db, mid)).toMatchObject({
        publicKey: A,
        rung: "holder",
        source: "register",
      });

      db.prepare("DELETE FROM identity_keys WHERE motebit_id = ?").run(mid);
      expect(identityKeyFor(db, mid)).toMatchObject({
        publicKey: B,
        rung: "registry",
        source: null,
      });

      db.prepare("UPDATE agent_registry SET public_key = '' WHERE motebit_id = ?").run(mid);
      expect(identityKeyFor(db, mid)).toMatchObject({ publicKey: C, rung: "chain" });

      db.prepare("DELETE FROM relay_key_successions WHERE motebit_id = ?").run(mid);
      expect(identityKeyFor(db, mid)).toMatchObject({ publicKey: D, rung: "devices" });
      // The authority stops one rung short: a device row is never a key on file.
      expect(provenIdentityKey(db, mid)).toBeNull();

      // Disagreeing device rows answer nothing — a guess is a planted binding (D5).
      db.prepare("UPDATE devices SET public_key = ? WHERE device_id = 'd2'").run(E);
      expect(identityKeyFor(db, mid)).toBeNull();
      expect(identityKeyFor(db, "mote-unknown")).toBeNull();
    });

    it("keysHeldBy: holder ∪ registry ∪ chain head ∪ keyed device rows, '' excluded, compared case-insensitively", () => {
      const mid = "mote-held";
      expect(keysHeldBy(db, mid).size).toBe(0);
      plantRegistry(db, mid, "");
      expect(keysHeldBy(db, mid).size).toBe(0);
      plantDevice(db, mid, "h1", "");
      expect(keysHeldBy(db, mid).size).toBe(0);
      plantDevice(db, mid, "h2", B.toUpperCase());
      db.prepare("UPDATE agent_registry SET public_key = ? WHERE motebit_id = ?").run(C, mid);
      recordIdentityKey(db, { motebitId: mid, publicKey: A, source: "register", now: 1 });
      plantChain(db, mid, E, D);
      expect([...keysHeldBy(db, mid)].sort()).toEqual([A, B, C, D]);
    });

    it("identityGuardianFor: the holder's guardian, else the registry's", () => {
      const mid = "mote-g";
      expect(identityGuardianFor(db, mid)).toBeNull();
      plantRegistry(db, mid, A, D);
      expect(identityGuardianFor(db, mid)).toBe(D);
      recordIdentityKey(db, { motebitId: mid, publicKey: A, source: "register", now: 1 });
      expect(identityGuardianFor(db, mid)).toBe(D); // holder has none yet → registry's
      recordIdentityKey(db, {
        motebitId: mid,
        publicKey: A,
        guardianPublicKey: E,
        source: "register",
        now: 2,
      });
      expect(identityGuardianFor(db, mid)).toBe(E);
    });
  });

  describe("the writers", () => {
    it("recordIdentityKey upserts the key, keeps the guardian unless given one, and refuses a non-key", () => {
      const mid = "mote-rec";
      recordIdentityKey(db, {
        motebitId: mid,
        publicKey: A,
        guardianPublicKey: E,
        source: "register",
        now: 1,
      });
      recordIdentityKey(db, { motebitId: mid, publicKey: B, source: "succession", now: 2 });
      expect(identityKeyFor(db, mid)).toMatchObject({
        publicKey: B,
        guardianPublicKey: E,
        source: "succession",
        firstSeen: 1,
      });
      expect(() =>
        recordIdentityKey(db, {
          motebitId: mid,
          publicKey: "not-a-key",
          source: "register",
          now: 3,
        }),
      ).toThrow(/not a 32-byte hex public key/);
      expect(identityKeyFor(db, mid)?.publicKey).toBe(B);
    });

    it("recordFirstIdentityKey writes only when nothing is proven and no keyed device row disagrees", () => {
      // New identity: first key.
      expect(
        recordFirstIdentityKey(db, {
          motebitId: "f-new",
          publicKey: A,
          source: "bootstrap",
          now: 1,
        }),
      ).toBe(true);
      // Proven already (any rung of the authority): never overwritten — A2.
      expect(
        recordFirstIdentityKey(db, {
          motebitId: "f-new",
          publicKey: B,
          source: "bootstrap",
          now: 2,
        }),
      ).toBe(false);
      expect(identityKeyFor(db, "f-new")?.publicKey).toBe(A);
      plantRegistry(db, "f-reg", B);
      expect(
        recordFirstIdentityKey(db, {
          motebitId: "f-reg",
          publicKey: A,
          source: "register-self",
          now: 1,
        }),
      ).toBe(false);
      expect(holderRow(db, "f-reg")).toBeUndefined();
      // One device row holding this key: a second machine after key transfer.
      plantDevice(db, "f-one", "o1", A);
      expect(
        recordFirstIdentityKey(db, {
          motebitId: "f-one",
          publicKey: A,
          source: "register-self",
          now: 1,
        }),
      ).toBe(true);
      // A device row holding ANOTHER key: a paired device's own — not the identity's (D5).
      plantDevice(db, "f-two", "t1", A);
      plantDevice(db, "f-two", "t2", B);
      expect(
        recordFirstIdentityKey(db, {
          motebitId: "f-two",
          publicKey: A,
          source: "bootstrap",
          now: 1,
        }),
      ).toBe(false);
      expect(holderRow(db, "f-two")).toBeUndefined();
      // A legacy '' registry key is not a key on file (A5): the first key fires.
      plantRegistry(db, "f-blank", "");
      expect(
        recordFirstIdentityKey(db, {
          motebitId: "f-blank",
          publicKey: A,
          source: "bootstrap",
          now: 1,
        }),
      ).toBe(true);
    });

    it("the backfill fills registry and chain identities only — never from device rows, agreeing or not (§5a A4, #750 review)", () => {
      plantRegistry(db, "bf-reg", A, E);
      plantDevice(db, "bf-reg", "r1", D); // registry wins even with a device row
      plantChain(db, "bf-chain", A, C);
      plantDevice(db, "bf-dev", "v1", D);
      plantDevice(db, "bf-dev", "v2", D);
      plantDevice(db, "bf-amb", "m1", D);
      plantDevice(db, "bf-amb", "m2", E);
      plantDevice(db, "bf-none", "n1", "");
      db.prepare(IDENTITY_KEYS_BACKFILL_SQL).run(7, 7);
      const rows = db
        .prepare(
          "SELECT motebit_id, public_key, guardian_public_key, source FROM identity_keys ORDER BY motebit_id",
        )
        .all();
      expect(rows).toEqual([
        {
          motebit_id: "bf-chain",
          public_key: C,
          guardian_public_key: null,
          source: "backfill:chain",
        },
        {
          motebit_id: "bf-reg",
          public_key: A,
          guardian_public_key: E,
          source: "backfill:registry",
        },
      ]);
      // Agreeing device rows are still what the READER serves — just never the authority.
      expect(identityKeyFor(db, "bf-dev")).toMatchObject({ publicKey: D, rung: "devices" });
      expect(provenIdentityKey(db, "bf-dev")).toBeNull();
      db.prepare(IDENTITY_KEYS_BACKFILL_SQL).run(8, 8);
      expect((db.prepare("SELECT COUNT(*) AS n FROM identity_keys").get() as { n: number }).n).toBe(
        2,
      );
    });

    it("keys are stored as given — an uppercase registrant's own spelling is what the holder answers", () => {
      const upper = "ABCDEF" + "0".repeat(58);
      recordIdentityKey(db, {
        motebitId: "mote-upper",
        publicKey: upper,
        source: "register",
        now: 1,
      });
      expect(identityKeyFor(db, "mote-upper")?.publicKey).toBe(upper);
      expect(departureFrom(db, "mote-upper", upper)).toMatchObject({
        admissible: true,
        rung: "holder",
      });
      expect(departureFrom(db, "mote-upper", upper.toLowerCase())).toMatchObject({
        admissible: false,
      });
    });
  });

  describe("the doors", () => {
    it("/agents/register records the key it proved, with its guardian; a first key over a '' registry row is recorded, not compared against '' (A5)", async () => {
      const g = await generateKeypair();
      const res = await registerAgent("mote-door", {
        public_key: A,
        ...(await guardianFields("mote-door", g)),
      });
      expect(res.status).toBe(200);
      expect(identityKeyFor(db, "mote-door")).toMatchObject({
        publicKey: A,
        source: "register",
        guardianPublicKey: hex(g),
      });

      // A master-token registration that names no key writes '' and records nothing …
      expect((await registerAgent("mote-blank", {})).status).toBe(200);
      expect(holderRow(db, "mote-blank")).toBeUndefined();
      // … and the next registration with a key is a FIRST key, no succession demanded.
      expect((await registerAgent("mote-blank", { public_key: B })).status).toBe(200);
      expect(identityKeyFor(db, "mote-blank")).toMatchObject({ publicKey: B, rung: "holder" });
    });

    it("/agents/register: a first key beside disagreeing device rows is recorded (the door writes the registry unconditionally, and the holder must not disagree with it); a differing key against a holder is refused without a succession", async () => {
      plantDevice(db, "mote-reg-c", "dA", A);
      plantDevice(db, "mote-reg-c", "dB", B);
      expect((await registerAgent("mote-reg-c", { public_key: B })).status).toBe(200);
      expect(identityKeyFor(db, "mote-reg-c")).toMatchObject({
        publicKey: B,
        rung: "holder",
        source: "register",
      });

      recordIdentityKey(db, { motebitId: "mote-reg-h", publicKey: A, source: "bootstrap", now: 1 });
      expect((await registerAgent("mote-reg-h", { public_key: C })).status).toBe(400);
      expect(identityKeyFor(db, "mote-reg-h")?.publicKey).toBe(A);
    });

    it("/agents/register: a lone paired device's own key does not force a succession at registration (A4)", async () => {
      plantDevice(db, "mote-lone", "paired", D);
      // Through the migration too: the backfill must not make the paired row the authority.
      db.prepare(IDENTITY_KEYS_BACKFILL_SQL).run(9, 9);
      expect(holderRow(db, "mote-lone")).toBeUndefined();
      expect(provenIdentityKey(db, "mote-lone")).toBeNull();
      expect((await registerAgent("mote-lone", { public_key: A })).status).toBe(200);
      expect(identityKeyFor(db, "mote-lone")?.publicKey).toBe(A);
    });

    it("/agents/register without a key records nothing in the holder, and publishes the SERVED key — never the first-listed of disagreeing rows (#750 review)", async () => {
      const reg = (mid: string) =>
        (
          db.prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?").get(mid) as {
            public_key: string;
          }
        ).public_key;
      // Disagreeing device rows, nothing proven: the old fallback took the first-listed row.
      plantDevice(db, "mote-nokey", "dA", A);
      plantDevice(db, "mote-nokey", "dB", B);
      expect((await registerAgent("mote-nokey", {})).status).toBe(200);
      expect(holderRow(db, "mote-nokey")).toBeUndefined();
      expect(reg("mote-nokey")).toBe("");
      // Agreeing rows (the daemon's shape): discovery gets the key the relay serves; the holder stays unwritten.
      plantDevice(db, "mote-nokey-agree", "d1", D);
      expect((await registerAgent("mote-nokey-agree", {})).status).toBe(200);
      expect(reg("mote-nokey-agree")).toBe(D);
      expect(holderRow(db, "mote-nokey-agree")).toBeUndefined();
      // With a proven key, a keyless registration keeps it on the registry and leaves the holder's source alone.
      recordIdentityKey(db, { motebitId: "mote-nokey", publicKey: C, source: "bootstrap", now: 1 });
      expect((await registerAgent("mote-nokey", {})).status).toBe(200);
      expect(reg("mote-nokey")).toBe(C);
      expect(holderRow(db, "mote-nokey")).toMatchObject({ public_key: C, source: "bootstrap" });
    });

    it("/agents/register: a guardian attested WITHOUT a key reaches the holder — the replaced guardian cannot recover (#750 review)", async () => {
      const mid = crypto.randomUUID();
      const k1 = await generateKeypair();
      const k2 = await generateKeypair();
      const g1 = await generateKeypair();
      const g2 = await generateKeypair();
      expect(
        (await registerAgent(mid, { public_key: hex(k1), ...(await guardianFields(mid, g1)) }))
          .status,
      ).toBe(200);
      expect((await registerAgent(mid, await guardianFields(mid, g2))).status).toBe(200);
      expect(identityGuardianFor(db, mid)).toBe(hex(g2));
      expect(holderRow(db, mid)).toMatchObject({
        public_key: hex(k1),
        guardian_public_key: hex(g2),
      });
      const stale = await signGuardianRecoverySuccession(
        g1.privateKey,
        k2.privateKey,
        k1.publicKey,
        k2.publicKey,
      );
      expect(await presentRecovery(mid, stale)).toBe(400);
      const fresh = await signGuardianRecoverySuccession(
        g2.privateKey,
        k2.privateKey,
        k1.publicKey,
        k2.publicKey,
      );
      expect(await presentRecovery(mid, fresh)).toBe(200);
    });

    it("bootstrap and register-self record a first key, and never overwrite a holder — 'new' is provenIdentityKey === null, not 'no identities row' (A2)", async () => {
      // A service-mode identity: holder and registry row, NO identities row.
      expect((await registerAgent("mote-svc", { public_key: A })).status).toBe(200);
      expect(
        await db.prepare("SELECT 1 FROM identities WHERE motebit_id = ?").get("mote-svc"),
      ).toBeUndefined();
      // The owner adds a device under the identity's own key: admitted, holder unchanged.
      // 201: this door creates the identities row the service-mode identity lacked.
      expect(await bootstrap("mote-svc", "svc-dev", A)).toBe(201);
      expect(identityKeyFor(db, "mote-svc")).toMatchObject({ publicKey: A, source: "register" });

      // A brand-new identity through each public door records its first key.
      expect(await bootstrap("mote-boot", "b-dev", C)).toBe(201);
      expect(identityKeyFor(db, "mote-boot")).toMatchObject({ publicKey: C, source: "bootstrap" });
      const kp = await generateKeypair();
      expect(await registerSelf("mote-rs", "rs-dev", kp)).toBe(201);
      expect(identityKeyFor(db, "mote-rs")).toMatchObject({
        publicKey: hex(kp),
        source: "register-self",
      });
      // And again from a second machine: idempotent for the holder.
      expect(await registerSelf("mote-rs", "rs-dev-2", kp)).toBe(200);
      expect(holderRow(db, "mote-rs")).toMatchObject({
        source: "register-self",
        updated_at: expect.any(Number),
      });
    });

    it("the legacy /device/register (operator bearer) proves nothing and writes nothing to the holder", async () => {
      recordIdentityKey(db, {
        motebitId: "mote-legacy",
        publicKey: A,
        source: "bootstrap",
        now: 1,
      });
      const res = await relay.app.request("/device/register", {
        method: "POST",
        headers: { ...JSON_HEADERS, ...AUTH_HEADER },
        body: JSON.stringify({ motebit_id: "mote-legacy", device_name: "x", public_key: B }),
      });
      expect(res.status).toBeLessThan(500);
      expect(identityKeyFor(db, "mote-legacy")?.publicKey).toBe(A);
    });

    it("a re-presented head link does not drag a holder that has moved on back to an older key", () => {
      const mid = "mote-replay";
      plantDevice(db, mid, "r1", A);
      plantRegistry(db, mid, A);
      recordIdentityKey(db, { motebitId: mid, publicKey: A, source: "register", now: 1 });
      const link = {
        old_public_key: A,
        new_public_key: B,
        timestamp: 2,
        reason: null,
        old_key_signature: "s1",
        new_key_signature: "s2",
        recovery: false,
        guardian_signature: null,
      } as unknown as Parameters<typeof applySuccession>[2];
      applySuccession(db, mid, link);
      expect(identityKeyFor(db, mid)?.publicKey).toBe(B);
      recordIdentityKey(db, { motebitId: mid, publicKey: C, source: "register", now: 3 });
      applySuccession(db, mid, link);
      expect(identityKeyFor(db, mid)?.publicKey).toBe(C);
    });

    it("the readers agree with the holder: keyOnFile, the identity log, and the §7.6 bundle — for an identity with no registry row at all", async () => {
      const mid = "mote-agree";
      plantRegistry(db, mid, B);
      recordIdentityKey(db, { motebitId: mid, publicKey: A, source: "bootstrap", now: 4 });
      expect(keyOnFile(db, mid).held).toBe(A);
      expect(readIdentityBindings(db).find((b) => b.motebit_id === mid)?.public_key).toBe(A);
      const bundle = await relay.app.request(`/api/v1/identity/${mid}`);
      expect(bundle.status).toBe(200);
      expect(((await bundle.json()) as { current_public_key: string }).current_public_key).toBe(A);

      recordIdentityKey(db, {
        motebitId: "mote-rowless",
        publicKey: C,
        source: "register-self",
        now: 4,
      });
      expect(readIdentityBindings(db).map((b) => b.motebit_id)).toContain("mote-rowless");
      expect((await relay.app.request("/api/v1/identity/mote-rowless")).status).toBe(200);
    });
  });

  describe("the laws (§5b)", () => {
    it("L1 — guard superset: keysHeldBy contains whatever identityKeyFor answers, in every planted state", () => {
      for (const [name, plant] of Object.entries(STATES)) {
        const mid = `l1-${name.replace(/\W+/g, "-")}`;
        plant(db, mid);
        const served = identityKeyFor(db, mid);
        if (served !== null) {
          expect(keysHeldBy(db, mid).has(served.publicKey.toLowerCase()), name).toBe(true);
        }
      }
    });

    it("L2 — a stranger's key never lands: each public door refuses it in every state, and the holder is byte-identical after (§8 clause 1)", async () => {
      const stranger = await generateKeypair();
      for (const [name, plant] of Object.entries(STATES)) {
        for (const door of ["bootstrap", "register-self"] as const) {
          const mid = `l2-${door}-${name.replace(/\W+/g, "-")}`;
          plant(db, mid);
          const before = JSON.stringify(holderRow(db, mid) ?? null);
          const status =
            door === "bootstrap"
              ? await bootstrap(mid, `${mid}-x`, hex(stranger))
              : await registerSelf(mid, `${mid}-x`, stranger);
          expect(status, `${door} / ${name}`).toBe(409);
          expect(JSON.stringify(holderRow(db, mid) ?? null), `${door} / ${name}`).toBe(before);
          expect(keysHeldBy(db, mid).has(hex(stranger)), `${door} / ${name}`).toBe(false);
        }
      }
    });

    it("L3 — departure is proven: admissible only from the proven key; the exact-row device rung only when nothing is proven", () => {
      for (const [name, plant] of Object.entries(STATES)) {
        const mid = `l3-${name.replace(/\W+/g, "-")}`;
        const key = plant(db, mid);
        const proven = provenIdentityKey(db, mid);
        const verdict = departureFrom(db, mid, key);
        if (proven !== null) {
          expect(verdict, name).toMatchObject({ admissible: true, rung: proven.rung });
          expect(departureFrom(db, mid, E).admissible, name).toBe(false);
        } else {
          // Nothing proven: the device row that holds exactly this key decides (#736's last rung, kept for §8).
          expect(verdict, name).toMatchObject({ admissible: true, rung: "device" });
          expect(departureFrom(db, mid, E), name).toMatchObject({
            admissible: false,
            reason: "no_key_on_file",
          });
        }
      }
      // A holder outranks a registry row that disagrees, and the reason names the rung that answered.
      plantRegistry(db, "l3-x", B);
      recordIdentityKey(db, { motebitId: "l3-x", publicKey: A, source: "bootstrap", now: 1 });
      expect(departureFrom(db, "l3-x", B)).toMatchObject({
        admissible: false,
        reason: "not_from_current_key",
      });
      plantChain(db, "l3-c", A, B);
      expect(departureFrom(db, "l3-c", A)).toMatchObject({
        admissible: false,
        reason: "not_from_chain_head",
      });
    });

    it("L4 — serve what you admit: bundle and succession route serve identityKeyFor; held is the authority; they differ only by the device rung", async () => {
      recordIdentityKey(db, { motebitId: "l4-h", publicKey: A, source: "bootstrap", now: 1 });
      plantDevice(db, "l4-d", "d1", B);
      plantDevice(db, "l4-d", "d2", B);
      for (const [mid, current, held] of [
        ["l4-h", A, A],
        ["l4-d", B, null],
      ] as const) {
        const succession = (await (
          await relay.app.request(`/api/v1/agents/${mid}/succession`)
        ).json()) as {
          current_public_key: string | null;
          held_public_key: string | null;
        };
        expect(succession.current_public_key, mid).toBe(current);
        expect(succession.held_public_key, mid).toBe(held);
        expect(identityKeyFor(db, mid)?.publicKey ?? null, mid).toBe(current);
        expect(provenIdentityKey(db, mid)?.publicKey ?? null, mid).toBe(held);
        const bundle = await relay.app.request(`/api/v1/identity/${mid}`);
        expect(bundle.status, mid).toBe(200);
        expect(
          ((await bundle.json()) as { current_public_key: string }).current_public_key,
          mid,
        ).toBe(current);
      }
    });

    it("L5 — one guardian: after register-with-succession carrying a new attestation, recovery, the bundle and the routing boost all read the new one", async () => {
      const mid = crypto.randomUUID();
      const k1 = await generateKeypair();
      const k2 = await generateKeypair();
      const k3 = await generateKeypair();
      const g1 = await generateKeypair();
      const g2 = await generateKeypair();
      expect(
        (await registerAgent(mid, { public_key: hex(k1), ...(await guardianFields(mid, g1)) }))
          .status,
      ).toBe(200);
      expect(identityGuardianFor(db, mid)).toBe(hex(g1));

      const succession = await signKeySuccession(
        k1.privateKey,
        k2.privateKey,
        k2.publicKey,
        k1.publicKey,
      );
      expect(
        (
          await registerAgent(mid, {
            public_key: hex(k2),
            succession,
            ...(await guardianFields(mid, g2)),
          })
        ).status,
      ).toBe(200);
      expect(identityKeyFor(db, mid)).toMatchObject({
        publicKey: hex(k2),
        guardianPublicKey: hex(g2),
      });
      const bundle = (await (await relay.app.request(`/api/v1/identity/${mid}`)).json()) as {
        guardian_public_key?: string;
      };
      expect(bundle.guardian_public_key).toBe(hex(g2));

      // The old guardian can no longer recover; the new one can.
      const stale = await signGuardianRecoverySuccession(
        g1.privateKey,
        k3.privateKey,
        k2.publicKey,
        k3.publicKey,
      );
      expect(await presentRecovery(mid, stale)).toBe(400);
      const fresh = await signGuardianRecoverySuccession(
        g2.privateKey,
        k3.privateKey,
        k2.publicKey,
        k3.publicKey,
      );
      expect(await presentRecovery(mid, fresh)).toBe(200);
      expect(identityKeyFor(db, mid)?.publicKey).toBe(hex(k3));
    });

    it("L5 — no reader re-derives the guardian from the registry (the read-side gate until Part B's)", () => {
      const src = resolve(__dirname, "..");
      const guardianReaders = [
        "key-rotation.ts",
        "agents.ts",
        "trust-graph.ts",
        "tasks.ts",
        "identity-transparency.ts",
      ];
      for (const f of guardianReaders) {
        const text = readFileSync(resolve(src, f), "utf-8");
        expect(text.includes("guardian_public_key FROM agent_registry"), f).toBe(false);
      }
      // The key reads Part A moved; the signature-verifying readers in
      // key-rotation.ts and tasks.ts are Part B's, with the real gate.
      const keyReaders = [
        "agents.ts",
        "trust-graph.ts",
        "identity-transparency.ts",
        "succession-apply.ts",
        "device-registration-guard.ts",
      ];
      for (const f of keyReaders) {
        const text = readFileSync(resolve(src, f), "utf-8");
        expect(/SELECT public_key FROM agent_registry WHERE motebit_id = \?/.test(text), f).toBe(
          false,
        );
      }
    });

    it("L6 — §8 clause 2: guardian recovery lands after v42 for every backfill source, and for the ambiguous identity the backfill leaves unfilled", async () => {
      const g = await generateKeypair();
      const old = await generateKeypair();
      const cases: Record<string, () => void> = {
        registry: () =>
          db
            .prepare("UPDATE agent_registry SET public_key = ? WHERE motebit_id = ?")
            .run(hex(old), mid),
        chain: () => plantChain(db, mid, D, hex(old)),
        "devices agree (unfilled)": () => {
          plantDevice(db, mid, `${mid}-1`, hex(old));
          plantDevice(db, mid, `${mid}-2`, hex(old));
        },
        "devices disagree (unfilled)": () => {
          plantDevice(db, mid, `${mid}-1`, hex(old));
          plantDevice(db, mid, `${mid}-2`, E);
        },
      };
      let mid = "";
      for (const [name, plant] of Object.entries(cases)) {
        mid = crypto.randomUUID();
        // The victim's precondition: a guardian on a registry row with an EMPTY key (registered before any device).
        expect((await registerAgent(mid, await guardianFields(mid, g))).status).toBe(200);
        expect(holderRow(db, mid), name).toBeUndefined();
        plant();
        db.prepare(IDENTITY_KEYS_BACKFILL_SQL).run(9, 9);
        expect(holderRow(db, mid) !== undefined, name).toBe(!name.includes("unfilled"));
        const next = await generateKeypair();
        const recovery = await signGuardianRecoverySuccession(
          g.privateKey,
          next.privateKey,
          old.publicKey,
          next.publicKey,
        );
        expect(await presentRecovery(mid, recovery), name).toBe(200);
        expect(identityKeyFor(db, mid)?.publicKey, name).toBe(hex(next));
        expect(identityGuardianFor(db, mid), name).toBe(hex(g));
      }
    });
  });
});
