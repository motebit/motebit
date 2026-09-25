/**
 * identity-keys — the holder is written by EVIDENCE, never by doors (#703;
 * proposal identity-key-state-v1 §5e, the DA/DB amendments, and §5f's
 * founder decision: the holder is the ONLY authority).
 *
 * Two builds were withdrawn (#747, #750) and three design reviews narrowed
 * the third to one question (G1). This file pins the result as laws and as
 * regressions — one test per finding, named for it — so a future edit that
 * re-opens any of them goes red here first:
 *
 *   #750 R1–R4 and W1–W3, design F1–F7 and F-A…F-E, G1, and the build-time
 *   E-op finding.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
  deriveSovereignMotebitId,
} from "@motebit/crypto";
import type { KeyPair } from "@motebit/crypto";

import type { SyncRelay } from "../index.js";
import {
  IDENTITY_KEYS_BACKFILL_SQL,
  admitKey,
  discoveryKeyFor,
  identityGuardianFor,
  identityKey,
  keysHeldBy,
  proveSovereignFirstKey,
  recordFirstIdentityKey,
  recordIdentityKey,
  recordOperatorServiceKey,
  verificationKeyFor,
} from "../identity-keys.js";
import { departureFrom } from "../succession-apply.js";
import { readIdentityBindings } from "../identity-transparency.js";
import { createTestRelay, JSON_AUTH } from "./test-helpers.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const D = "d".repeat(64);
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
  return db.prepare("SELECT * FROM identity_keys WHERE motebit_id = ?").get(mid) as
    { public_key: string; guardian_public_key: string | null; source: string } | undefined;
}
function registryKey(db: DatabaseDriver, mid: string): string | undefined {
  return (
    db.prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?").get(mid) as
      { public_key: string } | undefined
  )?.public_key;
}

/** A sovereign identity: its motebit_id IS the commitment to its genesis key. */
async function sovereign(): Promise<{ mid: string; kp: KeyPair }> {
  const kp = await generateKeypair();
  return { mid: await deriveSovereignMotebitId(hex(kp)), kp };
}

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

  async function registerSelf(mid: string, deviceId: string, kp: KeyPair, key = hex(kp)) {
    const body = await signDeviceRegistration(
      {
        motebit_id: mid,
        device_id: deviceId,
        public_key: key,
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
  async function bootstrap(mid: string, deviceId: string, publicKey: string) {
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
  /** Operator-bearer registration. */
  async function registerAsOperator(mid: string, extra: Record<string, unknown>) {
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
  /** A device's own bearer — the token is verified by the device row `did` names. */
  async function registerAsDevice(
    mid: string,
    did: string,
    kp: KeyPair,
    extra: Record<string, unknown>,
  ) {
    const { token } = await mintAudienceToken({ mid, did, aud: "admin:query" }, kp.privateKey);
    return relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        endpoint_url: "http://localhost:9999/mcp",
        capabilities: [],
        ...extra,
      }),
    });
  }
  /** Present a recovery record to /rotate-key under a fresh sponsor identity's token. */
  async function presentRotation(target: string, record: unknown): Promise<number> {
    const s = await sovereign();
    expect(await registerSelf(s.mid, `${s.mid}-laptop`, s.kp)).toBe(201);
    const { token } = await mintAudienceToken(
      { mid: s.mid, did: `${s.mid}-laptop`, aud: "rotate-key" },
      s.kp.privateKey,
    );
    const res = await relay.app.request(`/api/v1/agents/${target}/rotate-key`, {
      method: "POST",
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` },
      body: JSON.stringify(record),
    });
    return res.status;
  }
  /** The owner's own rotation, under its own device's token. */
  async function rotateOwn(mid: string, did: string, from: KeyPair, to: KeyPair) {
    const record = await signKeySuccession(
      from.privateKey,
      to.privateKey,
      to.publicKey,
      from.publicKey,
    );
    const { token } = await mintAudienceToken({ mid, did, aud: "rotate-key" }, from.privateKey);
    const res = await relay.app.request(`/api/v1/agents/${mid}/rotate-key`, {
      method: "POST",
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` },
      body: JSON.stringify(record),
    });
    return res.status;
  }
  async function bundleKey(mid: string): Promise<{ status: number; key?: string }> {
    const res = await relay.app.request(`/api/v1/identity/${mid}`);
    if (res.status !== 200) return { status: res.status };
    return {
      status: 200,
      key: ((await res.json()) as { current_public_key: string }).current_public_key,
    };
  }

  describe("the questions (§5f)", () => {
    it("identityKey is the holder and nothing else — never the registry, the chain head or a device row (G1's root)", () => {
      plantRegistry(db, "m-reg", A);
      plantChain(db, "m-chain", B, C);
      plantDevice(db, "m-dev", "d1", D);
      for (const mid of ["m-reg", "m-chain", "m-dev"]) {
        expect(identityKey(db, mid), mid).toBeNull();
      }
      recordIdentityKey(db, { motebitId: "m-reg", publicKey: B, source: "succession", now: 1 });
      expect(identityKey(db, "m-reg")).toMatchObject({ publicKey: B, source: "succession" });
    });

    it("verificationKeyFor: the holder, else exactly the reader's main read ('' is none)", () => {
      expect(verificationKeyFor(db, "m-v", A)).toBe(A);
      expect(verificationKeyFor(db, "m-v", "")).toBeNull();
      expect(verificationKeyFor(db, "m-v", undefined)).toBeNull();
      recordIdentityKey(db, { motebitId: "m-v", publicKey: B, source: "succession", now: 1 });
      expect(verificationKeyFor(db, "m-v", A)).toBe(B);
    });

    it("keysHeldBy: holder ∪ registry ∪ keyed device rows, EXACT, and no raw chain head (DA1, DB4)", () => {
      plantRegistry(db, "m-h", A);
      plantDevice(db, "m-h", "d1", B.toUpperCase());
      plantChain(db, "m-h", C, D);
      recordIdentityKey(db, { motebitId: "m-h", publicKey: C, source: "succession", now: 1 });
      expect([...keysHeldBy(db, "m-h")].sort()).toEqual([A, B.toUpperCase(), C].sort());
      expect(keysHeldBy(db, "m-h").has(B)).toBe(false);
      expect(keysHeldBy(db, "m-h").has(D)).toBe(false);
    });

    it("identityGuardianFor: the holder's guardian, else the registry's", () => {
      plantRegistry(db, "m-g", A, B);
      expect(identityGuardianFor(db, "m-g")).toBe(B);
      recordIdentityKey(db, {
        motebitId: "m-g",
        publicKey: A,
        guardianPublicKey: C,
        source: "succession",
        now: 1,
      });
      expect(identityGuardianFor(db, "m-g")).toBe(C);
    });

    it("discoveryKeyFor: the holder, else the ONE key every keyed device row agrees on, else '' (DA5)", () => {
      plantDevice(db, "m-dk", "d1", A);
      expect(discoveryKeyFor(db, "m-dk")).toBe(A);
      plantDevice(db, "m-dk", "d2", B);
      expect(discoveryKeyFor(db, "m-dk")).toBe("");
      recordIdentityKey(db, { motebitId: "m-dk", publicKey: C, source: "succession", now: 1 });
      expect(discoveryKeyFor(db, "m-dk")).toBe(C);
    });
  });

  describe("evidence", () => {
    it("admitKey: canonical lowercase, or EXACTLY a key already on file — never an alternate spelling (F1, DB4)", () => {
      expect(admitKey(db, "m-a", A)).toBe(true);
      expect(admitKey(db, "m-a", A.toUpperCase())).toBe(false);
      // hexToBytes is lenient: "a!…" reads like "0a…". Refused, never normalized.
      expect(admitKey(db, "m-a", "a!" + A.slice(2))).toBe(false);
      expect(admitKey(db, "m-a", "")).toBe(false);
      // Continuity: a legacy identity's stored spelling is admitted as-is.
      plantDevice(db, "m-a", "d1", B.toUpperCase());
      expect(admitKey(db, "m-a", B.toUpperCase())).toBe(true);
      expect(admitKey(db, "m-b", B.toUpperCase())).toBe(false);
    });

    it("proveSovereignFirstKey: the id must be EXACTLY the commitment to the key (DA3), canonical key only", async () => {
      const { mid, kp } = await sovereign();
      expect(await proveSovereignFirstKey(mid, hex(kp))).not.toBeNull();
      expect(await proveSovereignFirstKey(mid.toUpperCase(), hex(kp))).toBeNull();
      expect(await proveSovereignFirstKey(mid, hex(kp).toUpperCase())).toBeNull();
      expect(await proveSovereignFirstKey(mid, A)).toBeNull();
      expect(await proveSovereignFirstKey("legacy-random-id", hex(kp))).toBeNull();
    });

    it("recordFirstIdentityKey writes only when no holder, no chain, no registry key, and every held key IS this one (DA2, F3)", async () => {
      const cases: Array<[string, (mid: string, k: string) => void, boolean]> = [
        ["nothing on file", () => {}, true],
        ["its own device row only", (mid, k) => plantDevice(db, mid, `${mid}-own`, k), true],
        ["a DIFFERENT registry key", (mid) => plantRegistry(db, mid, B), false],
        [
          "a registry key equal to it (discovery's copy)",
          (mid, k) => plantRegistry(db, mid, k),
          true,
        ],
        ["a '' registry row", (mid) => plantRegistry(db, mid, ""), true],
        ["a recorded chain", (mid) => plantChain(db, mid, B, C), false],
        [
          "a paired device's own key beside it (F3)",
          (mid, k) => {
            plantDevice(db, mid, `${mid}-own`, k);
            plantDevice(db, mid, `${mid}-p`, B);
          },
          false,
        ],
      ];
      for (const [name, plant, writes] of cases) {
        const { mid, kp } = await sovereign();
        const k = hex(kp);
        plant(mid, k);
        const proof = (await proveSovereignFirstKey(mid, k))!;
        expect(recordFirstIdentityKey(db, proof, { source: "register-self", now: 1 }), name).toBe(
          writes,
        );
        expect(identityKey(db, mid)?.publicKey ?? null, name).toBe(writes ? k : null);
      }
    });

    it("F4 — a rotation that lands while the door hashed makes the first-key write a no-op (one transaction, re-read)", async () => {
      const { mid, kp } = await sovereign();
      const proof = (await proveSovereignFirstKey(mid, hex(kp)))!;
      // …the door awaited the hash; meanwhile the identity rotated:
      plantChain(db, mid, hex(kp), B);
      expect(recordFirstIdentityKey(db, proof, { source: "register-self", now: 1 })).toBe(false);
      expect(holderRow(db, mid)).toBeUndefined();
    });

    it("E-op writes only for a bare service identity: no holder, no device row, no chain", () => {
      expect(recordOperatorServiceKey(db, { motebitId: "svc", publicKey: A, now: 1 })).toBe(true);
      expect(identityKey(db, "svc")).toMatchObject({ publicKey: A, source: "operator" });
      plantDevice(db, "svc-dev", "d1", B);
      expect(recordOperatorServiceKey(db, { motebitId: "svc-dev", publicKey: A, now: 1 })).toBe(
        false,
      );
      plantChain(db, "svc-ch", B, C);
      expect(recordOperatorServiceKey(db, { motebitId: "svc-ch", publicKey: A, now: 1 })).toBe(
        false,
      );
    });

    it("the v42 backfill (E-main) transplants registry, else chain head — never a device row (R4), spelling as-is (DA10)", () => {
      plantRegistry(db, "bf-reg", A.toUpperCase(), C);
      plantChain(db, "bf-chain", A, B);
      plantDevice(db, "bf-dev", "d1", D);
      plantRegistry(db, "bf-blank", "");
      db.prepare(IDENTITY_KEYS_BACKFILL_SQL).run(7, 7);
      expect(holderRow(db, "bf-reg")).toMatchObject({
        public_key: A.toUpperCase(),
        guardian_public_key: C,
        source: "backfill:registry",
      });
      expect(holderRow(db, "bf-chain")).toMatchObject({ public_key: B, source: "backfill:chain" });
      expect(holderRow(db, "bf-dev")).toBeUndefined();
      expect(holderRow(db, "bf-blank")).toBeUndefined();
    });
  });

  describe("the doors", () => {
    it("W1 — unsigned bootstrap writes NOTHING to the holder, for any id", async () => {
      const { mid, kp } = await sovereign();
      expect(await bootstrap(mid, "boot-1", hex(kp))).toBe(201);
      expect(holderRow(db, mid)).toBeUndefined();
      expect((await bundleKey(mid)).status).toBe(404);
      expect(await bootstrap("legacy-x", "boot-2", A)).toBe(201);
      expect(holderRow(db, "legacy-x")).toBeUndefined();
    });

    it("W2 — a non-canonical spelling of a key is refused at the public doors, so it cannot lock the owner out", async () => {
      const { mid, kp } = await sovereign();
      expect(await bootstrap(mid, "up-1", hex(kp).toUpperCase())).toBe(400);
      expect(await registerSelf(mid, "up-2", kp, hex(kp).toUpperCase())).toBe(400);
      expect(holderRow(db, mid)).toBeUndefined();
      // The owner then fills normally and can rotate.
      expect(await registerSelf(mid, "own", kp)).toBe(201);
      expect(identityKey(db, mid)?.publicKey).toBe(hex(kp));
      const next = await generateKeypair();
      expect(await rotateOwn(mid, "own", kp, next)).toBe(200);
      expect(identityKey(db, mid)?.publicKey).toBe(hex(next));
    });

    it("register-self: E-sov fills a sovereign identity; a legacy id and a paired device's own key never fill", async () => {
      const { mid, kp } = await sovereign();
      expect(await registerSelf(mid, "rs-1", kp)).toBe(201);
      expect(identityKey(db, mid)).toMatchObject({ publicKey: hex(kp), source: "register-self" });
      const legacy = await generateKeypair();
      expect(await registerSelf("legacy-rs", "rs-2", legacy)).toBe(201);
      expect(holderRow(db, "legacy-rs")).toBeUndefined();
      // A device paired to a sovereign identity holds its own key — not sovereign-bound to the id.
      const s2 = await sovereign();
      plantDevice(db, s2.mid, "genesis", hex(s2.kp));
      const paired = await generateKeypair();
      plantDevice(db, s2.mid, "paired", hex(paired));
      expect(await registerSelf(s2.mid, "paired", paired)).toBeLessThan(500);
      expect(holderRow(db, s2.mid)).toBeUndefined();
    });

    it("DB1 — /agents/register fills E-sov only when the bearer's OWN device key is the body key", async () => {
      const { mid, kp } = await sovereign();
      expect(await bootstrap(mid, "dev", hex(kp))).toBe(201);
      expect(holderRow(db, mid)).toBeUndefined();
      expect((await registerAsDevice(mid, "dev", kp, { public_key: hex(kp) })).status).toBe(200);
      expect(identityKey(db, mid)).toMatchObject({ publicKey: hex(kp), source: "register" });
      // The operator naming a sovereign key proves no possession: not E-sov, and
      // not E-op either (the identity has a device row).
      const s2 = await sovereign();
      expect(await bootstrap(s2.mid, "dev2", hex(s2.kp))).toBe(201);
      expect((await registerAsOperator(s2.mid, { public_key: hex(s2.kp) })).status).toBe(200);
      expect(holderRow(db, s2.mid)).toBeUndefined();
    });

    it("the CLI daemon's shape — unsigned bootstrap, then a KEYLESS register under its own device token — fills a sovereign identity (§5f build-time)", async () => {
      const { mid, kp } = await sovereign();
      expect(await bootstrap(mid, "daemon", hex(kp))).toBe(201);
      expect((await registerAsDevice(mid, "daemon", kp, {})).status).toBe(200);
      expect(identityKey(db, mid)).toMatchObject({ publicKey: hex(kp), source: "register" });
      expect(await bundleKey(mid)).toEqual({ status: 200, key: hex(kp) });
      // …but a paired device's keyless register fills nothing: its key is not sovereign-bound.
      const s2 = await sovereign();
      const paired = await generateKeypair();
      plantDevice(db, s2.mid, "p-only", hex(paired));
      expect((await registerAsDevice(s2.mid, "p-only", paired, {})).status).toBe(200);
      expect(holderRow(db, s2.mid)).toBeUndefined();
    });

    it("W3 — a body key nothing proves never reaches the holder; the registry takes it (discovery), served stays ''", async () => {
      const { mid, kp } = await sovereign();
      const paired = await generateKeypair();
      plantDevice(db, mid, "genesis", hex(kp));
      plantDevice(db, mid, "paired", hex(paired));
      const x = await generateKeypair();
      expect((await registerAsDevice(mid, "paired", paired, { public_key: hex(x) })).status).toBe(
        200,
      );
      expect(holderRow(db, mid)).toBeUndefined();
      expect(registryKey(db, mid)).toBe(hex(x));
      expect(await bundleKey(mid)).toEqual({ status: 200, key: "" });
      // …and the owner still rotates from its genesis row (the device rung).
      const next = await generateKeypair();
      expect(await rotateOwn(mid, "genesis", kp, next)).toBe(200);
    });

    it("keyless /agents/register publishes discovery's key and writes no holder (DA5, R3); '' when rows disagree", async () => {
      plantDevice(db, "kl-agree", "d1", A);
      expect((await registerAsOperator("kl-agree", {})).status).toBe(200);
      expect(registryKey(db, "kl-agree")).toBe(A);
      expect(holderRow(db, "kl-agree")).toBeUndefined();
      plantDevice(db, "kl-dis", "kd1", A);
      plantDevice(db, "kl-dis", "kd2", B);
      expect((await registerAsOperator("kl-dis", {})).status).toBe(200);
      expect(registryKey(db, "kl-dis")).toBe("");
      // "" is absent, not malformed (DB4); a malformed non-empty key is refused.
      expect((await registerAsOperator("kl-dis", { public_key: "" })).status).toBe(200);
      expect((await registerAsOperator("kl-dis", { public_key: "zz" })).status).toBe(400);
    });

    it("E-op — the operator registering a bare service identity fills it, so it can rotate and recover as on main", async () => {
      const k1 = await generateKeypair();
      const g = await generateKeypair();
      expect(
        (
          await registerAsOperator("svc-1", {
            public_key: hex(k1),
            ...(await guardianFields("svc-1", g)),
          })
        ).status,
      ).toBe(200);
      expect(identityKey(db, "svc-1")).toMatchObject({
        publicKey: hex(k1),
        source: "operator",
        guardianPublicKey: hex(g),
      });
      const k2 = await generateKeypair();
      const recovery = await signGuardianRecoverySuccession(
        g.privateKey,
        k2.privateKey,
        k1.publicKey,
        k2.publicKey,
      );
      expect(await presentRotation("svc-1", recovery)).toBe(200);
      expect(identityKey(db, "svc-1")?.publicKey).toBe(hex(k2));
    });

    it("R1/DA6 — every verified attestation reaches the holder, with or without a key; the replaced guardian cannot recover", async () => {
      const k1 = await generateKeypair();
      const g1 = await generateKeypair();
      const g2 = await generateKeypair();
      expect(
        (
          await registerAsOperator("svc-g", {
            public_key: hex(k1),
            ...(await guardianFields("svc-g", g1)),
          })
        ).status,
      ).toBe(200);
      expect((await registerAsOperator("svc-g", await guardianFields("svc-g", g2))).status).toBe(
        200,
      );
      expect(identityGuardianFor(db, "svc-g")).toBe(hex(g2));
      const k2 = await generateKeypair();
      const stale = await signGuardianRecoverySuccession(
        g1.privateKey,
        k2.privateKey,
        k1.publicKey,
        k2.publicKey,
      );
      expect(await presentRotation("svc-g", stale)).toBe(400);
      const fresh = await signGuardianRecoverySuccession(
        g2.privateKey,
        k2.privateKey,
        k1.publicKey,
        k2.publicKey,
      );
      expect(await presentRotation("svc-g", fresh)).toBe(200);
    });

    it("DB4 — a non-canonical guardian is refused before any write", async () => {
      const g = await generateKeypair();
      const fields = await guardianFields("svc-ng", g);
      const res = await registerAsOperator("svc-ng", {
        public_key: A,
        ...fields,
        guardian_public_key: fields.guardian_public_key.toUpperCase(),
      });
      expect(res.status).toBe(400);
      expect(registryKey(db, "svc-ng")).toBeUndefined();
    });

    it("continuity — a legacy identity stored UPPER(K) keeps bootstrapping with UPPER(K); a lowercase K cannot join it (F-D, F-E)", async () => {
      const k = await generateKeypair();
      const upper = hex(k).toUpperCase();
      plantDevice(db, "legacy-up", "d1", upper);
      expect(await bootstrap("legacy-up", "d1", upper)).toBeLessThan(300);
      expect(await bootstrap("legacy-up", "d2", hex(k))).toBe(409);
    });
  });

  describe("G1 — 'no key on file' is not ownerless", () => {
    it("(a) a paired device naming X cannot make X served or force the owner through a succession from X", async () => {
      const owner = await generateKeypair();
      const paired = await generateKeypair();
      plantDevice(db, "g1a", "owner", hex(owner));
      plantDevice(db, "g1a", "paired", hex(paired));
      expect((await registerAsOperator("g1a", {})).status).toBe(200); // keyless: '' (rows disagree)
      const x = await generateKeypair();
      expect((await registerAsDevice("g1a", "paired", paired, { public_key: hex(x) })).status).toBe(
        200,
      );
      expect((await bundleKey("g1a")).key).toBe("");
      expect(readIdentityBindings(db).find((b) => b.motebit_id === "g1a")?.public_key).toBe("");
      const next = await generateKeypair();
      expect(await rotateOwn("g1a", "owner", owner, next)).toBe(200);
    });

    it("(b) a paired device's own rotation moves its row only — never the holder, the served key, or the owner's departure", async () => {
      const owner = await generateKeypair();
      const paired = await generateKeypair();
      plantDevice(db, "g1b", "owner", hex(owner));
      plantDevice(db, "g1b", "paired", hex(paired));
      const k3 = await generateKeypair();
      expect(await rotateOwn("g1b", "paired", paired, k3)).toBe(200);
      expect(holderRow(db, "g1b")).toBeUndefined();
      expect((await bundleKey("g1b")).status).toBe(404);
      expect(departureFrom(db, "g1b", hex(owner)).admissible).toBe(true);
      const next = await generateKeypair();
      expect(await rotateOwn("g1b", "owner", owner, next)).toBe(200);
    });
  });

  describe("DB1 / F-A — a genesis key is never installed from public keys alone", () => {
    it("bootstrapping a known genesis key of an id this relay has not seen serves nothing (main: 404)", async () => {
      const { mid, kp } = await sovereign();
      expect(await bootstrap(mid, "planted", hex(kp))).toBe(201);
      expect((await bundleKey(mid)).status).toBe(404);
      const res = await relay.app.request(`/api/v1/agents/${mid}/succession`);
      expect(
        ((await res.json()) as { current_public_key: string | null }).current_public_key,
      ).toBeNull();
    });
  });

  describe("the laws", () => {
    it("L1 — every key a verification reader can answer is in the guard's set", () => {
      const states: Record<string, (mid: string) => void> = {
        holder: (mid) =>
          recordIdentityKey(db, { motebitId: mid, publicKey: A, source: "succession", now: 1 }),
        registry: (mid) => plantRegistry(db, mid, A),
        "registry '' + holder": (mid) => {
          plantRegistry(db, mid, "");
          recordIdentityKey(db, { motebitId: mid, publicKey: A, source: "operator", now: 1 });
        },
        "chain + registry": (mid) => {
          plantChain(db, mid, B, A);
          plantRegistry(db, mid, A);
        },
        devices: (mid) => plantDevice(db, mid, `${mid}-d`, A),
      };
      for (const [name, plant] of Object.entries(states)) {
        const mid = `l1-${name}`;
        plant(mid);
        const v = verificationKeyFor(db, mid, registryKey(db, mid));
        if (v !== null) expect(keysHeldBy(db, mid).has(v), name).toBe(true);
      }
    });

    it("E-link — the holder moves only through a link from the key it HOLDS; a stale re-presentation moves nothing", async () => {
      const { mid, kp } = await sovereign();
      expect(await registerSelf(mid, "own", kp)).toBe(201);
      const k2 = await generateKeypair();
      expect(await rotateOwn(mid, "own", kp, k2)).toBe(200);
      expect(identityKey(db, mid)).toMatchObject({ publicKey: hex(k2), source: "succession" });
      const k3 = await generateKeypair();
      const stale = await signKeySuccession(
        kp.privateKey,
        k3.privateKey,
        k3.publicKey,
        kp.publicKey,
      );
      expect(await presentRotation(mid, stale)).toBeGreaterThanOrEqual(400);
      expect(identityKey(db, mid)?.publicKey).toBe(hex(k2));
    });
  });
});
