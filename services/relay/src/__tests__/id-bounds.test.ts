/**
 * #814 — every relay door that writes a caller-chosen `motebit_id` or
 * `device_id` into durable state bounds its length, so every roster entry
 * the relay can hold is one it can also retire.
 *
 * Three parts:
 *   1. The bound is justified by measurement: the largest ids the doors
 *      admit, in the costliest spelling canonical JSON has, sign into an
 *      enrolment AND a retirement under `MAX_ROSTER_ENTRY_BYTES` — and an
 *      unbounded id does produce the defect (enrolment held, retirement
 *      `too_large`).
 *   2. End to end: an identity bootstrapped at the bound presents its
 *      enrolment and its retirement, and the relay holds both.
 *   3. Each door refuses bound+1 and admits the bound.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import {
  bytesToHex,
  canonicalJson,
  createSignedToken,
  generateKeypair,
  hostEnrollmentId,
  mintAudienceToken,
  signDeviceRegistration,
  signHostEnrollment,
  signHostRetirement,
} from "@motebit/crypto";
import type { KeyPair } from "@motebit/crypto";
import { AUTH_HEADER, createTestRelay, keyProof } from "./test-helpers.js";
import { MAX_ROSTER_ENTRY_BYTES } from "../host-roster-store.js";
import { MAX_DEVICE_ID_LENGTH, MAX_MOTEBIT_ID_LENGTH } from "../id-bounds.js";

const JSON_HEADERS = { "Content-Type": "application/json" };
const bytes = (v: unknown) => new TextEncoder().encode(canonicalJson(v)).length;

async function signedPair(kp: KeyPair, motebitId: string, deviceId: string, at: number) {
  const enrollment = await signHostEnrollment(
    {
      motebit_id: motebitId,
      device_id: deviceId,
      public_key: bytesToHex(kp.publicKey),
      enrolled_at: at,
    },
    kp.privateKey,
  );
  const retirement = await signHostRetirement(
    {
      motebit_id: motebitId,
      enrollment_id: await hostEnrollmentId(enrollment),
      public_key: bytesToHex(kp.publicKey),
      retired_at: at,
    },
    kp.privateKey,
  );
  return { enrollment, retirement };
}

// ── 1. The number ────────────────────────────────────────────────────

describe("#814 the id bound, measured", () => {
  it("the largest admitted ids, worst-case spelling, sign into entries under the cap", async () => {
    const kp = await generateKeypair();
    // U+0001 canonicalizes to `\u0001` — 6 bytes per UTF-16 code unit,
    // the most any code unit costs in JSON. The largest safe integer is
    // the longest timestamp the schema admits.
    const worst = "\u0001";
    const { enrollment, retirement } = await signedPair(
      kp,
      worst.repeat(MAX_MOTEBIT_ID_LENGTH),
      worst.repeat(MAX_DEVICE_ID_LENGTH),
      Number.MAX_SAFE_INTEGER,
    );
    expect(canonicalJson(enrollment.motebit_id)).toHaveLength(MAX_MOTEBIT_ID_LENGTH * 6 + 2);
    // Lone surrogates cost the same six bytes — no spelling is costlier.
    expect(canonicalJson("\ud800")).toHaveLength(8);
    const e = bytes(enrollment);
    const r = bytes(retirement);
    expect(e).toBe(3388);
    expect(r).toBe(1919);
    expect(e).toBeLessThanOrEqual(MAX_ROSTER_ENTRY_BYTES);
    expect(r).toBeLessThanOrEqual(MAX_ROSTER_ENTRY_BYTES);
  });

  it("without the bound, an id exists whose enrolment fits and whose retirement never will", async () => {
    const kp = await generateKeypair();
    let found: number | null = null;
    for (let len = 3700; len <= 4096; len++) {
      const { enrollment, retirement } = await signedPair(kp, "m".repeat(len), "d", 1_000);
      if (
        bytes(enrollment) <= MAX_ROSTER_ENTRY_BYTES &&
        bytes(retirement) > MAX_ROSTER_ENTRY_BYTES
      ) {
        found = len;
        break;
      }
    }
    expect(found).not.toBeNull();
    expect(found!).toBeGreaterThan(MAX_MOTEBIT_ID_LENGTH);
  });
});

// ── 2. End to end ────────────────────────────────────────────────────

describe("#814 the doors", () => {
  let relay: SyncRelay;
  beforeEach(async () => {
    relay = await createTestRelay();
  });
  afterEach(async () => {
    await relay.close();
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    relay.app.request(path, {
      method: "POST",
      headers: { ...JSON_HEADERS, ...headers },
      body: JSON.stringify(body),
    });

  const bootstrap = async (motebitId: string, deviceId: string, kp: KeyPair) =>
    post(
      "/api/v1/agents/bootstrap",
      await keyProof(
        { motebit_id: motebitId, device_id: deviceId, public_key: bytesToHex(kp.publicKey) },
        kp.privateKey,
      ),
    );

  /** An identity + device row written directly — one an earlier relay admitted. */
  function seedHeld(motebitId: string, deviceId: string, kp: KeyPair) {
    relay.moteDb.db
      .prepare(
        "INSERT INTO identities (motebit_id, owner_id, created_at, version_clock) VALUES (?, ?, ?, 0)",
      )
      .run(motebitId, motebitId, Date.now());
    relay.moteDb.db
      .prepare(
        "INSERT INTO devices (device_id, motebit_id, device_token, public_key, registered_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(deviceId, motebitId, crypto.randomUUID(), bytesToHex(kp.publicKey), Date.now());
  }

  const deviceToken = async (motebitId: string, deviceId: string, kp: KeyPair) =>
    createSignedToken(
      {
        mid: motebitId,
        did: deviceId,
        iat: Date.now(),
        exp: Date.now() + 5 * 60 * 1000,
        jti: crypto.randomUUID(),
        aud: "device:auth",
      },
      kp.privateKey,
    );

  it("an identity at the bound: the relay holds its enrolment AND its retirement", async () => {
    const kp = await generateKeypair();
    const mid = "m".repeat(MAX_MOTEBIT_ID_LENGTH);
    const did = "d".repeat(MAX_DEVICE_ID_LENGTH);
    expect((await bootstrap(mid, did, kp)).status).toBe(201);

    const { enrollment, retirement } = await signedPair(kp, mid, did, Number.MAX_SAFE_INTEGER);
    const { token } = await mintAudienceToken({ mid, did, aud: "device:auth" }, kp.privateKey);
    const res = await post(
      `/api/v1/agents/${encodeURIComponent(mid)}/roster`,
      { enrollments: [enrollment], retirements: [retirement] },
      { Authorization: `Bearer ${token}` },
    );
    const json = (await res.json()) as {
      accepted: { kind: string; status: string }[];
      refused: unknown[];
    };
    expect(json.refused).toEqual([]);
    expect(json.accepted.map((a) => [a.kind, a.status])).toEqual([
      ["enrollment", "stored"],
      ["retirement", "stored"],
    ]);
    expect(res.status).toBe(200);
  });

  // ── bootstrap ──

  it("bootstrap refuses a motebit_id of bound+1 and writes nothing", async () => {
    const kp = await generateKeypair();
    const mid = "m".repeat(MAX_MOTEBIT_ID_LENGTH + 1);
    const res = await bootstrap(mid, crypto.randomUUID(), kp);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("motebit_id is 257 characters");
    expect(
      relay.moteDb.db.prepare("SELECT 1 FROM identities WHERE motebit_id = ?").get(mid),
    ).toBeUndefined();
  });

  it("bootstrap refuses a device_id of bound+1 and writes nothing", async () => {
    const kp = await generateKeypair();
    const did = "d".repeat(MAX_DEVICE_ID_LENGTH + 1);
    const res = await bootstrap(crypto.randomUUID(), did, kp);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("device_id is 257 characters");
    expect(
      relay.moteDb.db.prepare("SELECT 1 FROM devices WHERE device_id = ?").get(did),
    ).toBeUndefined();
  });

  // ── register-self ──

  const registerSelf = async (motebitId: string, deviceId: string, kp: KeyPair) =>
    post(
      "/api/v1/devices/register-self",
      await signDeviceRegistration(
        {
          motebit_id: motebitId,
          device_id: deviceId,
          public_key: bytesToHex(kp.publicKey),
          timestamp: Date.now(),
        },
        kp.privateKey,
      ),
    );

  it("register-self admits both ids at the bound", async () => {
    const kp = await generateKeypair();
    const res = await registerSelf(
      "m".repeat(MAX_MOTEBIT_ID_LENGTH),
      "d".repeat(MAX_DEVICE_ID_LENGTH),
      kp,
    );
    expect(res.status).toBe(201);
  });

  it("register-self refuses a motebit_id of bound+1 — validly signed — as id_too_long", async () => {
    const kp = await generateKeypair();
    const res = await registerSelf("m".repeat(MAX_MOTEBIT_ID_LENGTH + 1), crypto.randomUUID(), kp);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      reason: "id_too_long",
      code: "DEVICE_REGISTRATION_REJECTED",
    });
  });

  it("register-self refuses a device_id of bound+1 — validly signed — as id_too_long", async () => {
    const kp = await generateKeypair();
    const res = await registerSelf(crypto.randomUUID(), "d".repeat(MAX_DEVICE_ID_LENGTH + 1), kp);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ reason: "id_too_long" });
  });

  // ── /agents/register (master token names the id) ──

  const register = (motebitId: string) =>
    post(
      "/api/v1/agents/register",
      {
        motebit_id: motebitId,
        endpoint_url: "http://127.0.0.1:9/mcp",
        capabilities: ["x"],
      },
      AUTH_HEADER,
    );

  it("/agents/register admits a motebit_id at the bound", async () => {
    const res = await register("m".repeat(MAX_MOTEBIT_ID_LENGTH));
    expect(res.status).toBe(200);
  });

  it("/agents/register refuses a motebit_id of bound+1 and writes no registry row", async () => {
    const mid = "m".repeat(MAX_MOTEBIT_ID_LENGTH + 1);
    const res = await register(mid);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("motebit_id is 257 characters");
    expect(
      relay.moteDb.db.prepare("SELECT 1 FROM agent_registry WHERE motebit_id = ?").get(mid),
    ).toBeUndefined();
  });

  // ── /device/register (master token; the id must already be held) ──

  const deviceRegister = (motebitId: string, kp: KeyPair) =>
    post(
      "/device/register",
      { motebit_id: motebitId, device_name: "x", public_key: bytesToHex(kp.publicKey) },
      AUTH_HEADER,
    );

  it("/device/register admits a new device under a held id at the bound", async () => {
    const kp = await generateKeypair();
    const mid = "m".repeat(MAX_MOTEBIT_ID_LENGTH);
    seedHeld(mid, crypto.randomUUID(), kp);
    expect((await deviceRegister(mid, kp)).status).toBe(201);
  });

  it("/device/register gives an id held past the bound no new device", async () => {
    const kp = await generateKeypair();
    const mid = "m".repeat(MAX_MOTEBIT_ID_LENGTH + 1);
    seedHeld(mid, crypto.randomUUID(), kp);
    const res = await deviceRegister(mid, kp);
    expect(res.status).toBe(400);
    const n = relay.moteDb.db
      .prepare("SELECT COUNT(*) AS n FROM devices WHERE motebit_id = ?")
      .get(mid) as { n: number };
    expect(n.n).toBe(1);
  });

  // ── pairing approve (the only pairing write of a device row) ──

  async function pairTo(motebitId: string, deviceId: string, kp: KeyPair) {
    const auth = { Authorization: `Bearer ${await deviceToken(motebitId, deviceId, kp)}` };
    const init = await post("/pairing/initiate", {}, auth);
    expect(init.status).toBe(201);
    const { pairing_id, pairing_code } = (await init.json()) as {
      pairing_id: string;
      pairing_code: string;
    };
    const b = await generateKeypair();
    const claim = await post("/pairing/claim", {
      pairing_code,
      device_name: "phone",
      public_key: bytesToHex(b.publicKey),
    });
    expect(claim.status).toBe(200);
    return post(`/pairing/${pairing_id}/approve`, {}, auth);
  }

  it("pairing approve admits a new device under a held id at the bound", async () => {
    const kp = await generateKeypair();
    const mid = "m".repeat(MAX_MOTEBIT_ID_LENGTH);
    const did = crypto.randomUUID();
    seedHeld(mid, did, kp);
    expect((await pairTo(mid, did, kp)).status).toBe(200);
  });

  it("pairing approve gives an id held past the bound no new device", async () => {
    const kp = await generateKeypair();
    const mid = "m".repeat(MAX_MOTEBIT_ID_LENGTH + 1);
    const did = crypto.randomUUID();
    seedHeld(mid, did, kp);
    const res = await pairTo(mid, did, kp);
    expect(res.status).toBe(400);
    const n = relay.moteDb.db
      .prepare("SELECT COUNT(*) AS n FROM devices WHERE motebit_id = ?")
      .get(mid) as { n: number };
    expect(n.n).toBe(1);
  });

  // ── push-token (a device_id stored under the caller) ──

  async function pushToken(deviceId: string) {
    const kp = await generateKeypair();
    const mid = crypto.randomUUID();
    const did = crypto.randomUUID();
    expect((await bootstrap(mid, did, kp)).status).toBe(201);
    const { token } = await mintAudienceToken({ mid, did, aud: "push:register" }, kp.privateKey);
    return post(
      "/api/v1/agents/push-token",
      { device_id: deviceId, push_token: "t", platform: "expo" },
      { Authorization: `Bearer ${token}` },
    );
  }

  it("push-token admits a device_id at the bound", async () => {
    expect((await pushToken("d".repeat(MAX_DEVICE_ID_LENGTH))).status).toBe(200);
  });

  it("push-token refuses a device_id of bound+1", async () => {
    const did = "d".repeat(MAX_DEVICE_ID_LENGTH + 1);
    const res = await pushToken(did);
    expect(res.status).toBe(400);
    expect(
      relay.moteDb.db.prepare("SELECT 1 FROM relay_push_tokens WHERE device_id = ?").get(did),
    ).toBeUndefined();
  });

  // ── migration arrival ──
  //
  // Arrival independently requires the id to be the sovereign commitment to
  // the arriving key (a 36-char UUIDv8), so no over-long id could ever be
  // onboarded here. The bound refuses it first, before any network fetch or
  // verification; at the bound the request passes this check and is judged
  // by the next one.

  const arrive = (motebitId: string) =>
    post(
      "/api/v1/agents/accept-migration",
      {
        motebit_id: motebitId,
        public_key: "00".repeat(32),
        migration_token: {},
        departure_attestation: {},
        credential_bundle: {},
      },
      AUTH_HEADER,
    );

  it("migration arrival refuses a motebit_id of bound+1 before anything else", async () => {
    const res = await arrive("m".repeat(MAX_MOTEBIT_ID_LENGTH + 1));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("motebit_id is 257 characters");
  });

  it("migration arrival passes a motebit_id at the bound on to its next check", async () => {
    const res = await arrive("m".repeat(MAX_MOTEBIT_ID_LENGTH));
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("characters; this relay admits");
  });

  // ── #814 round 2: a present id that is not a string ──
  //
  // The storage layer binds a one-element array as its text, so a length
  // check that looked only at strings let `["z"×5000]` through whole.

  const SPELLINGS: [string, unknown][] = [
    ["array", ["z".repeat(5000)]],
    ["object", { id: "z" }],
    ["number", 7],
    ["boolean", true],
    ["null", null],
  ];

  const TABLES = ["identities", "devices", "agent_registry", "relay_push_tokens"];
  const counts = () =>
    TABLES.map(
      (t) => (relay.moteDb.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n,
    );

  /** The request is refused 400 and no table gained a row. */
  async function refusedWritingNothing(send: () => Response | Promise<Response>): Promise<string> {
    const before = counts();
    const res = await send();
    const text = await res.text();
    expect(res.status, text).toBe(400);
    expect(counts()).toEqual(before);
    return text;
  }

  for (const [name, value] of SPELLINGS) {
    it(`bootstrap refuses a ${name} motebit_id or device_id`, async () => {
      const kp = await generateKeypair();
      const pk = bytesToHex(kp.publicKey);
      await refusedWritingNothing(() =>
        post("/api/v1/agents/bootstrap", { motebit_id: value, device_id: "d", public_key: pk }),
      );
      const t = await refusedWritingNothing(() =>
        post("/api/v1/agents/bootstrap", {
          motebit_id: crypto.randomUUID(),
          device_id: value,
          public_key: pk,
        }),
      );
      expect(t).toContain("device_id must be a string");
    });

    it(`register-self refuses a ${name} id, device_name or owner_id — validly signed`, async () => {
      const kp = await generateKeypair();
      const signed = (fields: Record<string, unknown>) =>
        signDeviceRegistration(
          {
            motebit_id: crypto.randomUUID(),
            device_id: crypto.randomUUID(),
            public_key: bytesToHex(kp.publicKey),
            timestamp: Date.now(),
            ...fields,
          } as never,
          kp.privateKey,
        );
      for (const field of ["motebit_id", "device_id"]) {
        const body = await signed({ [field]: value });
        await refusedWritingNothing(() => post("/api/v1/devices/register-self", body));
      }
      if (value !== null) {
        // null is "absent" for the optional text fields.
        for (const field of ["device_name", "owner_id"]) {
          const body = await signed({ [field]: value });
          const t = await refusedWritingNothing(() => post("/api/v1/devices/register-self", body));
          expect(t).toContain(`${field} must be a string`);
        }
      }
    });

    it(`/agents/register refuses a ${name} motebit_id`, async () => {
      await refusedWritingNothing(() =>
        post(
          "/api/v1/agents/register",
          { motebit_id: value, endpoint_url: "http://127.0.0.1:9/mcp", capabilities: [] },
          AUTH_HEADER,
        ),
      );
    });

    it(`/device/register refuses a ${name} motebit_id or device_name`, async () => {
      const kp = await generateKeypair();
      const mid = crypto.randomUUID();
      seedHeld(mid, crypto.randomUUID(), kp);
      // The array spelling wraps a HELD id — the probe that found this.
      const idValue = Array.isArray(value) ? [mid] : value;
      await refusedWritingNothing(() =>
        post("/device/register", { motebit_id: idValue, device_name: "x" }, AUTH_HEADER),
      );
      if (value !== null) {
        const t = await refusedWritingNothing(() =>
          post("/device/register", { motebit_id: mid, device_name: value }, AUTH_HEADER),
        );
        expect(t).toContain("device_name must be a string");
      }
    });

    it(`push-token refuses a ${name} device_id or push_token`, async () => {
      const kp = await generateKeypair();
      const mid = crypto.randomUUID();
      const did = crypto.randomUUID();
      expect((await bootstrap(mid, did, kp)).status).toBe(201);
      const { token } = await mintAudienceToken({ mid, did, aud: "push:register" }, kp.privateKey);
      const auth = { Authorization: `Bearer ${token}` };
      const t = await refusedWritingNothing(() =>
        post(
          "/api/v1/agents/push-token",
          { device_id: value, push_token: "t", platform: "expo" },
          auth,
        ),
      );
      // A falsy spelling (null) is refused as missing, which predates the check.
      if (value !== null) {
        expect(t).toContain("device_id must be a string");
        const t2 = await refusedWritingNothing(() =>
          post(
            "/api/v1/agents/push-token",
            { device_id: "d", push_token: value, platform: "expo" },
            auth,
          ),
        );
        expect(t2).toContain("push_token must be a string");
      }
    });

    it(`migration arrival refuses a ${name} motebit_id first`, async () => {
      const t = await refusedWritingNothing(() => arrive(value as string));
      expect(t).toContain("motebit_id must be a string");
    });
  }

  // ── push-token under the CALLER's id ──

  async function pushAsHeld(mid: string) {
    const kp = await generateKeypair();
    const did = crypto.randomUUID();
    seedHeld(mid, did, kp);
    const { token } = await mintAudienceToken({ mid, did, aud: "push:register" }, kp.privateKey);
    return post(
      "/api/v1/agents/push-token",
      { device_id: did, push_token: "t", platform: "expo" },
      { Authorization: `Bearer ${token}` },
    );
  }

  it("push-token admits a caller id at the bound", async () => {
    expect((await pushAsHeld("m".repeat(MAX_MOTEBIT_ID_LENGTH))).status).toBe(200);
  });

  it("push-token gives a caller id held past the bound no new row", async () => {
    const res = await pushAsHeld("m".repeat(300));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("motebit_id is 300 characters");
    const n = relay.moteDb.db.prepare("SELECT COUNT(*) AS n FROM relay_push_tokens").get() as {
      n: number;
    };
    expect(n.n).toBe(0);
  });
});
