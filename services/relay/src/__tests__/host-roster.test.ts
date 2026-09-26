/**
 * The relay's half of the machine roster: it stores and observes, and it
 * never reduces.
 *
 * `spec/machine-roster-v1.md` §8/§9/§11, `docs/doctrine/machine-roster.md`,
 * `docs/proposals/machine-roster-relay-v1.md` (the design, D1–D6).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SyncRelay } from "../index.js";
import {
  generateKeypair,
  bytesToHex,
  mintAudienceToken,
  signHostEnrollment,
  signHostRetirement,
  verifyHostEnrollment,
  verifyHostRoster,
  hostEnrollmentId,
} from "@motebit/crypto";
import type { KeyPair } from "@motebit/crypto";
import type { HostEnrollment, HostRetirement, TokenAudience } from "@motebit/protocol";
import { AUTH_HEADER, createTestRelay } from "./test-helpers.js";
import {
  HOST_LIVENESS_RETENTION_MS,
  MAX_FOREIGN_ENTRIES_PER_MOTEBIT,
  MAX_OWN_ENROLLMENTS_PER_KEY,
  MAX_OWN_RETIREMENTS_PER_KEY,
  observeHostConnection,
  readHostLiveness,
  sweepHostLiveness,
} from "../host-roster-store.js";
import type { ConnectedDevice } from "../websocket.js";
import { registerHostRosterRoutes } from "../host-roster-routes.js";
import { Hono } from "hono";

let relay: SyncRelay;
let owner: KeyPair;
let pub: string;
let motebitId: string;

const JSON_HEADERS = { "Content-Type": "application/json" };
const DAY = 24 * 60 * 60 * 1000;
const HOST = ["unattended_runtime"];

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
  expect(res.status).toBeLessThan(300);
}

/** A device row under a key of the test's choosing (a paired device, an old key). */
function addDevice(deviceId: string, kp: KeyPair, mid = motebitId) {
  relay.moteDb.db
    .prepare(
      "INSERT INTO devices (device_id, motebit_id, device_token, public_key, registered_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(deviceId, mid, crypto.randomUUID(), bytesToHex(kp.publicKey), Date.now());
}

async function as(
  mid: string,
  deviceId: string,
  kp: KeyPair,
  path: string,
  init: RequestInit = {},
  aud: TokenAudience = "device:auth",
) {
  const { token } = await mintAudienceToken({ mid, did: deviceId, aud }, kp.privateKey);
  const res = await relay.app.request(path, {
    ...init,
    headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` },
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const rosterPath = () => `/api/v1/agents/${motebitId}/roster`;

const presentAs = (
  deviceId: string,
  kp: KeyPair,
  body: { enrollments?: unknown[]; retirements?: unknown[] },
) => as(motebitId, deviceId, kp, rosterPath(), { method: "POST", body: JSON.stringify(body) });

const present = (body: { enrollments?: unknown[]; retirements?: unknown[] }) =>
  presentAs("laptop", owner, body);

const read = () => as(motebitId, "laptop", owner, rosterPath());

const enrolUnder = (kp: KeyPair, deviceId: string, at = 1_000) =>
  signHostEnrollment(
    {
      motebit_id: motebitId,
      device_id: deviceId,
      public_key: bytesToHex(kp.publicKey),
      enrolled_at: at,
    },
    kp.privateKey,
  );
const enrol = (deviceId: string, at = 1_000) => enrolUnder(owner, deviceId, at);

const retireUnder = async (kp: KeyPair, e: HostEnrollment) =>
  signHostRetirement(
    {
      motebit_id: motebitId,
      enrollment_id: await hostEnrollmentId(e),
      public_key: bytesToHex(kp.publicKey),
      retired_at: 2_000,
    },
    kp.privateKey,
  );
const retire = (e: HostEnrollment) => retireUnder(owner, e);

function rows(): number {
  return (
    relay.moteDb.db
      .prepare("SELECT COUNT(*) AS n FROM relay_host_roster_entries WHERE motebit_id = ?")
      .get(motebitId) as { n: number }
  ).n;
}

/**
 * Fill a bucket directly: `n` rows signed (as far as the table says) by
 * `signer`, held in `bucket` — as if presented by that key's holder
 * ("own") or by some other caller ("foreign").
 */
function fill(
  signer: string,
  n: number,
  bucket: "own" | "foreign",
  kind: "enrollment" | "retirement" = "enrollment",
) {
  const ins = relay.moteDb.db.prepare(
    "INSERT INTO relay_host_roster_entries (motebit_id, entry_id, kind, signer_key, bucket, body_json, received_at) VALUES (?, ?, ?, ?, ?, '{}', 1)",
  );
  for (let i = 0; i < n; i++)
    ins.run(motebitId, `filler-${signer}-${bucket}-${kind}-${i}`, kind, signer, bucket);
}

function bucketOf(entryId: string): string | undefined {
  return (
    relay.moteDb.db
      .prepare("SELECT bucket FROM relay_host_roster_entries WHERE motebit_id = ? AND entry_id = ?")
      .get(motebitId, entryId) as { bucket: string } | undefined
  )?.bucket;
}

beforeEach(async () => {
  relay = await createTestRelay();
  owner = await generateKeypair();
  pub = bytesToHex(owner.publicKey);
  motebitId = crypto.randomUUID();
  await bootstrap(motebitId, "laptop", owner);
});

afterEach(async () => {
  await relay.close();
});

describe("presenting roster entries", () => {
  it("stores what the signer produced and serves it back UNCHANGED", async () => {
    const laptop = await enrol("laptop");
    const { status, json } = await present({ enrollments: [laptop] });
    expect(status).toBe(200);
    expect(json.accepted).toEqual([
      { kind: "enrollment", id: await hostEnrollmentId(laptop), status: "stored" },
    ]);
    const served = (await read()).json;
    expect(served.enrollments).toEqual([laptop]);
    const [back] = served.enrollments as HostEnrollment[];
    expect(await verifyHostEnrollment(back!)).toBe(true);
    expect(await hostEnrollmentId(back!)).toBe(await hostEnrollmentId(laptop));
  });

  it("is an idempotent union — presenting the same entries again adds nothing", async () => {
    const laptop = await enrol("laptop");
    const vps = await enrol("vps");
    await present({ enrollments: [laptop, vps] });
    const again = await present({ enrollments: [vps, laptop, laptop] });
    expect(again.status).toBe(200);
    expect((again.json.accepted as Array<{ status: string }>).map((a) => a.status)).toEqual([
      "already_held",
      "already_held",
      "already_held",
    ]);
    expect(rows()).toBe(2);
  });

  it("has NO freshness window — these are durable artifacts, not requests", async () => {
    const ancient = await enrol("vps", Date.now() - 400 * DAY);
    expect((await present({ enrollments: [ancient] })).status).toBe(200);
  });

  it("keeps a retirement AND the enrolment it ends — the relay stores the set, the consumer reduces it", async () => {
    const vps = await enrol("vps");
    const gone = await retire(vps);
    expect((await present({ enrollments: [vps], retirements: [gone] })).status).toBe(200);
    const served = (await read()).json;
    expect(served.enrollments).toEqual([vps]);
    expect(served.retirements).toEqual([gone]);
    const verdict = await verifyHostRoster({
      motebitId,
      keyChain: [pub],
      enrollments: served.enrollments as HostEnrollment[],
      retirements: served.retirements as HostRetirement[],
    });
    if (!verdict.ok) throw new Error(verdict.reason);
    expect(verdict.active).toEqual([]);
    expect(verdict.retired.map((m) => m.device_id)).toEqual(["vps"]);
  });

  it("accepts a retirement whose enrolment it has never seen — union has no order", async () => {
    const vps = await enrol("vps");
    expect((await present({ retirements: [await retire(vps)] })).status).toBe(200);
    expect(rows()).toBe(1);
  });
});

describe("what the relay refuses to hold — integrity only, never trust", () => {
  it("holds an entry that verifies under a key that is not the motebit's — NO untrusted_key at ingest", async () => {
    const stranger = await generateKeypair();
    const forged = await enrolUnder(stranger, "attacker-box", 1);
    expect((await present({ enrollments: [await enrol("laptop"), forged] })).status).toBe(200);
    const served = (await read()).json;
    // ...and it changes nothing for a consumer, who reduces against a
    // chain IT verified: the stranger's entry is refused THERE.
    const verdict = await verifyHostRoster({
      motebitId,
      keyChain: [pub],
      enrollments: served.enrollments as HostEnrollment[],
      retirements: served.retirements as HostRetirement[],
    });
    if (!verdict.ok) throw new Error(verdict.reason);
    expect(verdict.active.map((m) => m.device_id)).toEqual(["laptop"]);
    expect(verdict.rejected.map((r) => r.reason)).toEqual(["untrusted_key"]);
  });

  it("a refused neighbour is not a veto, and a partial presentation is a 422", async () => {
    const good = await enrol("laptop");
    const { status, json } = await present({
      enrollments: [good, { ...good, device_id: "edited" }],
    });
    expect(status).toBe(422);
    expect(json.refused).toEqual([{ kind: "enrollment", index: 1, reason: "bad_signature" }]);
    expect((json.accepted as unknown[]).length).toBe(1);
    expect(rows()).toBe(1);
  });

  it("a tampered entry, an entry for another motebit, and one carrying extra fields", async () => {
    const e = await enrol("laptop");
    const elsewhere = await signHostEnrollment(
      { motebit_id: "another-motebit", device_id: "x", public_key: pub, enrolled_at: 1 },
      owner.privateKey,
    );
    const { status, json } = await present({
      enrollments: [{ ...e, device_id: "edited" }, elsewhere, { ...e, hosts: ["run"] }],
    });
    expect(status).toBe(422);
    expect((json.refused as Array<{ reason: string }>).map((r) => r.reason)).toEqual([
      "bad_signature",
      "wrong_motebit",
      "malformed",
    ]);
    expect(rows()).toBe(0);
  });

  it("after a DATA LOSS it still holds entries under a key it has never heard of", async () => {
    const old = await generateKeypair();
    const lost = await enrolUnder(old, "lost-vps", 1);
    expect((await present({ enrollments: [lost] })).status).toBe(200);
    expect((await present({ enrollments: [lost] })).status).toBe(200); // and on reconnect
  });

  it("a malformed field is a 400, and more entries than one request may carry is a 413", async () => {
    expect((await present({})).status).toBe(400);
    const e = await enrol("laptop");
    expect(
      (await present({ enrollments: e as unknown as unknown[], retirements: [] })).status,
    ).toBe(400);
    expect(
      (await present({ enrollments: [], retirements: "none" as unknown as unknown[] })).status,
    ).toBe(400);
    const many = await Promise.all(Array.from({ length: 65 }, (_, i) => enrol(`m-${i}`)));
    expect((await present({ enrollments: many })).status).toBe(413);
    expect(rows()).toBe(0);
  });
});

describe("caps are partitioned by signer key (review F2)", () => {
  it("a full own bucket refuses the next own enrolment with roster_full — and still takes a retirement", async () => {
    const vps = await enrol("vps");
    await present({ enrollments: [vps] });
    fill(pub, MAX_OWN_ENROLLMENTS_PER_KEY - 1, "own");
    const another = await present({ enrollments: [await enrol("one-too-many")] });
    expect(another.status).toBe(422);
    expect(another.json.refused).toEqual([{ kind: "enrollment", index: 0, reason: "roster_full" }]);
    const retired = await present({ retirements: [await retire(vps)] });
    expect(retired.status).toBe(200);
    expect((retired.json.accepted as Array<{ status: string }>)[0]?.status).toBe("stored");
  });

  it("an entry already held is a no-op BEFORE any cap — a full bucket never refuses a re-presentation", async () => {
    const vps = await enrol("vps");
    await present({ enrollments: [vps] });
    fill(pub, MAX_OWN_ENROLLMENTS_PER_KEY, "own");
    const again = await present({ enrollments: [vps] });
    expect(again.status).toBe(200);
    expect((again.json.accepted as Array<{ status: string }>)[0]?.status).toBe("already_held");
  });

  it("an OLD-KEY caller filling every cap it can reach cannot cause refusal of an entry in the current key's own bucket", async () => {
    // The thief holds the pre-rotation key K_old and a device row under it
    // (or: a device linked without key transfer, holding its own K_d). It
    // fills its own bucket, and the one shared foreign bucket with entries
    // under keys it minted. The sovereign's current key — `owner` here —
    // still has an empty own bucket, and only its holders can fill it.
    const kOld = await generateKeypair();
    addDevice("old-box", kOld);
    const kOldHex = bytesToHex(kOld.publicKey);
    fill(kOldHex, MAX_OWN_ENROLLMENTS_PER_KEY - 1, "own");
    // One more of its own through the route — its own bucket is now full.
    const own = await presentAs("old-box", kOld, {
      enrollments: [await enrolUnder(kOld, "ghost-0")],
    });
    expect(own.status).toBe(200);
    expect(
      (await presentAs("old-box", kOld, { enrollments: [await enrolUnder(kOld, "ghost-x")] })).json
        .refused,
    ).toEqual([{ kind: "enrollment", index: 0, reason: "roster_full" }]);
    // The foreign bucket, filled with entries under junk keys.
    fill("f".repeat(64), MAX_FOREIGN_ENTRIES_PER_MOTEBIT, "foreign");

    // The current key's holder: an active line, and the retirement of the
    // stolen machine's line, both taken.
    const laptop = await enrol("laptop");
    const stolenLine = await enrolUnder(owner, "stolen-vps");
    const r = await present({ enrollments: [laptop, stolenLine] });
    expect(r.status).toBe(200);
    const r2 = await present({ retirements: [await retire(stolenLine)] });
    expect(r2.status).toBe(200);
    expect((r2.json.accepted as Array<{ status: string }>)[0]?.status).toBe("stored");
  });

  it("the old-key caller cannot even carry the current key's entries into the full foreign bucket — but their holder can", async () => {
    const kOld = await generateKeypair();
    addDevice("old-box", kOld);
    fill("f".repeat(64), MAX_FOREIGN_ENTRIES_PER_MOTEBIT, "foreign");
    const line = await enrol("vps");
    const viaThief = await presentAs("old-box", kOld, { enrollments: [line] });
    expect(viaThief.json.refused).toEqual([
      { kind: "enrollment", index: 0, reason: "roster_full" },
    ]);
    const viaOwner = await present({ enrollments: [line] });
    expect(viaOwner.status).toBe(200);
  });

  it("after a rotation, an old-key thief who FILLED its own bucket cannot stop the sovereign replicating a superseded line", async () => {
    // With a comparative count ("rows not signed by the caller"), K_old's
    // full OWN bucket read as a full FOREIGN bucket to every other caller,
    // so the honest K_new holder could never replicate a superseded line.
    // The bucket is stored at ingest; K_old's own rows are not foreign.
    const kOld = await generateKeypair();
    const kOldHex = bytesToHex(kOld.publicKey);
    fill(kOldHex, MAX_OWN_ENROLLMENTS_PER_KEY, "own");
    fill(kOldHex, MAX_OWN_RETIREMENTS_PER_KEY, "own", "retirement");
    // The superseded line: the old VPS, enrolled under K_old before the
    // rotation, carried by the sovereign (owner = K_new) from its cache.
    const superseded = await enrolUnder(kOld, "old-vps");
    const r = await present({ enrollments: [superseded] });
    expect(r.status).toBe(200);
    expect((r.json.accepted as Array<{ status: string }>)[0]?.status).toBe("stored");
    expect(bucketOf(await hostEnrollmentId(superseded))).toBe("foreign");
    // ...and it is refused only when the foreign bucket ITSELF is full.
    fill("f".repeat(64), MAX_FOREIGN_ENTRIES_PER_MOTEBIT - 1, "foreign");
    const next = await present({ enrollments: [await enrolUnder(kOld, "old-nas")] });
    expect(next.json.refused).toEqual([{ kind: "enrollment", index: 0, reason: "roster_full" }]);
  });

  it("an entry held in one bucket stays held there when another caller re-presents it", async () => {
    const kOld = await generateKeypair();
    addDevice("old-box", kOld);
    const line = await enrolUnder(kOld, "old-vps");
    expect((await presentAs("old-box", kOld, { enrollments: [line] })).status).toBe(200);
    const id = await hostEnrollmentId(line);
    expect(bucketOf(id)).toBe("own");
    const again = await present({ enrollments: [line] });
    expect(again.status).toBe(200);
    expect((again.json.accepted as Array<{ status: string }>)[0]?.status).toBe("already_held");
    expect(bucketOf(id)).toBe("own");
  });

  it("the foreign bucket is one shared bucket of 256", async () => {
    const other = await generateKeypair();
    fill("e".repeat(64), MAX_FOREIGN_ENTRIES_PER_MOTEBIT - 1, "foreign");
    expect((await present({ enrollments: [await enrolUnder(other, "a")] })).status).toBe(200);
    const full = await present({ enrollments: [await enrolUnder(other, "b")] });
    expect(full.json.refused).toEqual([{ kind: "enrollment", index: 0, reason: "roster_full" }]);
  });
});

describe("the roster is first-person: caller PRESENT and EQUAL (D5)", () => {
  it("is not readable or writable without a token", async () => {
    expect((await relay.app.request(rosterPath())).status).toBe(401);
    const post = await relay.app.request(rosterPath(), {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ enrollments: [await enrol("laptop")] }),
    });
    expect(post.status).toBe(401);
    expect(rows()).toBe(0);
  });

  it("the operator MASTER token gets 403 on both routes — it names no caller", async () => {
    await present({ enrollments: [await enrol("laptop")] });
    const get = await relay.app.request(rosterPath(), { headers: AUTH_HEADER });
    expect(get.status).toBe(403);
    const post = await relay.app.request(rosterPath(), {
      method: "POST",
      headers: { ...JSON_HEADERS, ...AUTH_HEADER },
      body: JSON.stringify({ enrollments: [await enrol("vps")] }),
    });
    expect(post.status).toBe(403);
    expect(rows()).toBe(1);
  });

  it("is not readable or writable by another identity", async () => {
    const other = await generateKeypair();
    const otherId = crypto.randomUUID();
    await bootstrap(otherId, "their-laptop", other);
    await present({ enrollments: [await enrol("laptop")] });
    const peek = await as(otherId, "their-laptop", other, rosterPath());
    expect(peek.status).toBe(403);
    expect(peek.json.enrollments).toBeUndefined();
    const write = await as(otherId, "their-laptop", other, rosterPath(), {
      method: "POST",
      body: JSON.stringify({ enrollments: [await enrol("vps")] }),
    });
    expect(write.status).toBe(403);
    expect(rows()).toBe(1);
  });

  it("the caller must be PRESENT: a verified key with no caller named is refused, whatever sets it", async () => {
    // In the composed relay the master token sets neither caller nor key,
    // so the key requirement alone would also refuse it. This pins the
    // caller-present rule on its own: #698's `requireFirstPerson` passed
    // when `callerMotebitId` was unset — exactly the master-token case.
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("callerVerifiedKey" as never, pub as never);
      c.set("callerVerifiedKeySource" as never, "device" as never);
      await next();
    });
    registerHostRosterRoutes({
      app,
      db: relay.moteDb.db,
      connections: new Map(),
      relayMotebitId: "relay",
    });
    expect((await app.request(rosterPath())).status).toBe(403);
    const post = await app.request(rosterPath(), {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ enrollments: [await enrol("laptop")] }),
    });
    expect(post.status).toBe(403);
    expect(rows()).toBe(0);
  });

  it("answers only to the named audience (device:auth), not the admin:query default", async () => {
    const wrong = await as(motebitId, "laptop", owner, rosterPath(), {}, "admin:query");
    expect(wrong.status).toBe(401);
  });
});

describe("liveness: per device AND key, hosts only, served beside the set (D4, D6)", () => {
  type Row = {
    device_id: string;
    bound_under: string;
    last_seen_at: number | null;
    sockets_open: number;
    host_sockets_open: number;
  };
  type Liveness = {
    observed_by: string;
    retention_days: number;
    observing_since: number;
    rows: Row[];
    live_unenrolled: Array<{
      device_id: string;
      bound_under: string;
      sockets_open: number;
      host_sockets_open: number;
    }>;
  };

  function peer(
    deviceId: string,
    opts: { key?: string; verified?: boolean; capabilities?: string[] } = {},
  ): ConnectedDevice {
    const verified = opts.verified ?? true;
    return {
      ws: { readyState: 1, send: () => {} },
      deviceId,
      deviceIdDeclared: true,
      deviceIdVerified: verified,
      ...(verified ? { boundUnder: opts.key ?? pub } : {}),
      capabilities: opts.capabilities ?? HOST,
    } as unknown as ConnectedDevice;
  }
  function connectPeer(p: ConnectedDevice) {
    relay.connections.set(motebitId, [...(relay.connections.get(motebitId) ?? []), p]);
  }
  const observe = (p: ConnectedDevice, at = 5_000) =>
    observeHostConnection(relay.moteDb.db, motebitId, p, relay.relayIdentity.relayMotebitId, at);
  const persisted = () => readHostLiveness(relay.moteDb.db, motebitId);

  it("F1: a socket verified under K_old, its device row since rotated to K_new, stays bound under K_old and never lights a K_new row", async () => {
    const kNew = await generateKeypair();
    await bootstrap(motebitId, "vps", owner); // the device row, under K_old = owner
    const kOld = pub;
    const sock = peer("vps", { key: kOld });
    connectPeer(sock);
    expect(observe(sock, 1_000)).toBe(true); // bind
    // The row rewrite alone (direct SQL): what `applySuccession` does to the
    // rows. Its socket close (#767) is not in play here — this isolates the
    // capture, which must hold for the whole of a close handshake.
    relay.moteDb.db
      .prepare("UPDATE devices SET public_key = ? WHERE motebit_id = ?")
      .run(bytesToHex(kNew.publicKey), motebitId);
    expect(observe(sock, 2_000)).toBe(true); // flush / close, after rotation
    expect(persisted()).toEqual([{ device_id: "vps", bound_under: kOld, last_seen_at: 2_000 }]);

    // GET, read by the rotated laptop (its own row is K_new now too).
    const live = (await as(motebitId, "laptop", kNew, rosterPath())).json.liveness as Liveness;
    expect(live.rows).toEqual([
      {
        device_id: "vps",
        bound_under: kOld,
        last_seen_at: 2_000,
        sockets_open: 1,
        host_sockets_open: 1,
      },
    ]);
    expect(live.rows.some((r) => r.bound_under === bytesToHex(kNew.publicKey))).toBe(false);
    expect(live.live_unenrolled).toEqual([]);
  });

  it("two keys claiming one device_id never overwrite each other", () => {
    const k1 = "1".repeat(64);
    const k2 = "2".repeat(64);
    observe(peer("vps", { key: k1 }), 1_000);
    observe(peer("vps", { key: k2 }), 2_000);
    observe(peer("vps", { key: k1 }), 3_000);
    expect(persisted()).toEqual([
      { device_id: "vps", bound_under: k1, last_seen_at: 3_000 },
      { device_id: "vps", bound_under: k2, last_seen_at: 2_000 },
    ]);
  });

  it("is ONE overwritten value per (device, key), never a history", () => {
    observe(peer("vps"), 1_000);
    observe(peer("vps"), 2_000);
    expect(persisted()).toEqual([{ device_id: "vps", bound_under: pub, last_seen_at: 2_000 }]);
  });

  it("a NON-HOST bound socket persists nothing, and appears only live, in live_unenrolled", async () => {
    const phone = peer("phone", { capabilities: ["sync"] });
    connectPeer(phone);
    expect(observe(phone)).toBe(false);
    expect(persisted()).toEqual([]);
    const live = (await read()).json.liveness as Liveness;
    expect(live.rows).toEqual([]);
    expect(live.live_unenrolled).toEqual([
      { device_id: "phone", bound_under: pub, sockets_open: 1, host_sockets_open: 0 },
    ]);
  });

  it("a socket that only DECLARED an id is not attributable: nothing persisted, nothing reported", async () => {
    const liar = peer("vps", { verified: false });
    connectPeer(liar);
    expect(observe(liar)).toBe(false);
    const live = (await read()).json.liveness as Liveness;
    expect(live.rows).toEqual([]);
    expect(live.live_unenrolled).toEqual([]);
  });

  it("rows = persisted ∪ live bound hosts: an offline host keeps its line, a live one counts its sockets", async () => {
    const vps = peer("vps");
    connectPeer(vps);
    connectPeer(peer("vps")); // a second socket under the same pair — doctor's hint
    observe(peer("nas"), 7_000); // seen, now offline
    const live = (await read()).json.liveness as Liveness;
    expect(live.rows).toEqual([
      {
        device_id: "nas",
        bound_under: pub,
        last_seen_at: 7_000,
        sockets_open: 0,
        host_sockets_open: 0,
      },
      {
        device_id: "vps",
        bound_under: pub,
        last_seen_at: null,
        sockets_open: 2,
        host_sockets_open: 2,
      },
    ]);
    expect(live.observed_by).toBe(relay.relayIdentity.relayMotebitId);
    expect(live.retention_days).toBe(90);
    expect(live.observing_since).toBeGreaterThanOrEqual(
      Date.now() - HOST_LIVENESS_RETENTION_MS - 1_000,
    );
    expect(live.observing_since).toBeLessThanOrEqual(Date.now());
  });

  it("a CLOSED socket left in connections counts nowhere in GET (defence in depth)", async () => {
    const closed = {
      ...peer("vps"),
      ws: { readyState: 3, send: () => {} },
    } as unknown as ConnectedDevice;
    connectPeer(closed);
    connectPeer(peer("phone", { capabilities: ["sync"] }));
    const zombieHost = { ...peer("phone", { capabilities: ["sync"] }), ws: { readyState: 2 } };
    connectPeer(zombieHost as unknown as ConnectedDevice);
    observe(peer("vps"), 7_000); // a persisted row for the closed host
    const live = (await read()).json.liveness as Liveness;
    expect(live.rows).toEqual([
      {
        device_id: "vps",
        bound_under: pub,
        last_seen_at: 7_000,
        sockets_open: 0,
        host_sockets_open: 0,
      },
    ]);
    expect(live.live_unenrolled).toEqual([
      { device_id: "phone", bound_under: pub, sockets_open: 1, host_sockets_open: 0 },
    ]);
  });

  it("an over-long entry is refused too_large before it is verified or held", async () => {
    const huge = await enrol("x".repeat(5_000));
    const r = await present({ enrollments: [huge, await enrol("laptop")] });
    expect(r.status).toBe(422);
    expect(r.json.refused).toEqual([{ kind: "enrollment", index: 0, reason: "too_large" }]);
    expect(rows()).toBe(1);
  });

  it("a request body over the limit is refused whole with 413", async () => {
    const res = await as(motebitId, "laptop", owner, rosterPath(), {
      method: "POST",
      body: JSON.stringify({ enrollments: [], pad: "x".repeat(300_000) }),
    });
    expect(res.status).toBe(413);
    expect(rows()).toBe(0);
  });

  it("the TTL sweep deletes a row unseen for 90 days — and skips one with a live bound socket", () => {
    const now = 1_000 * DAY;
    const db = relay.moteDb.db;
    observe(peer("idle-daemon"), now - 91 * DAY);
    observe(peer("gone"), now - 91 * DAY);
    observe(peer("recent"), now - 89 * DAY);
    const deleted = sweepHostLiveness(db, new Map([[motebitId, [peer("idle-daemon")]]]), now);
    expect(deleted).toBe(1);
    expect(persisted().map((r) => r.device_id)).toEqual(["idle-daemon", "recent"]);
  });

  // The desktop app and the CLI daemon share one device_id on a machine
  // (surfaces §0), so they bind as the SAME (device_id, bound_under) pair.
  // Only the daemon hosts unattended work; the desktop is not its liveness.
  const DESKTOP = ["sync"];

  it("two quantities: a host and a non-host socket on one pair read sockets_open 2, host_sockets_open 1", async () => {
    connectPeer(peer("laptop")); // the daemon
    connectPeer(peer("laptop", { capabilities: DESKTOP })); // the desktop app
    const live = (await read()).json.liveness as Liveness;
    expect(live.rows).toEqual([
      {
        device_id: "laptop",
        bound_under: pub,
        last_seen_at: null,
        sockets_open: 2, // main's meaning, unchanged: every bound socket
        host_sockets_open: 1, // the host's liveness: one daemon, no copied id
      },
    ]);
    expect(live.live_unenrolled).toEqual([]);
  });

  it("dead daemon + live desktop: the row still reads a session (sockets_open 1) but no host (0), last_seen_at kept", async () => {
    // S7 at the relay: a retired/stolen machine whose daemon once ran, with
    // only a desktop session open, must still read CONNECTED to its owner.
    observe(peer("laptop"), 7_000); // the daemon was seen, then went offline
    const desktop = peer("laptop", { capabilities: DESKTOP });
    connectPeer(desktop);
    expect(observe(desktop, 9_000)).toBe(false); // the desktop writes nothing
    const live = (await read()).json.liveness as Liveness;
    expect(live.rows).toEqual([
      {
        device_id: "laptop",
        bound_under: pub,
        last_seen_at: 7_000,
        sockets_open: 1,
        host_sockets_open: 0,
      },
    ]);
    expect(live.live_unenrolled).toEqual([]);
  });

  it("S8: after the sweep removes a dead daemon's row, the desktop reappears as a session, never a host", async () => {
    const now = 1_000 * DAY;
    observe(peer("laptop"), now - 91 * DAY);
    const desktop = peer("laptop", { capabilities: DESKTOP });
    connectPeer(desktop);
    expect(sweepHostLiveness(relay.moteDb.db, relay.connections, now)).toBe(1);
    const live = (await read()).json.liveness as Liveness;
    expect(live.rows).toEqual([]);
    expect(live.live_unenrolled).toEqual([
      { device_id: "laptop", bound_under: pub, sockets_open: 1, host_sockets_open: 0 },
    ]);
  });

  it("the TTL sweep does not skip a row kept alive only by a non-host socket", () => {
    const now = 1_000 * DAY;
    const db = relay.moteDb.db;
    observe(peer("laptop"), now - 91 * DAY); // daemon, long dead
    observe(peer("vps"), now - 91 * DAY); // daemon, idle but connected
    const connections = new Map([
      [motebitId, [peer("laptop", { capabilities: DESKTOP }), peer("vps")]],
    ]);
    expect(sweepHostLiveness(db, connections, now)).toBe(1);
    expect(persisted().map((r) => r.device_id)).toEqual(["vps"]);
  });

  it("the TTL sweep does not skip a row kept alive only by a CLOSED host socket", () => {
    const now = 1_000 * DAY;
    observe(peer("vps"), now - 91 * DAY);
    const closed = { ...peer("vps"), ws: { readyState: 3 } } as unknown as ConnectedDevice;
    expect(sweepHostLiveness(relay.moteDb.db, new Map([[motebitId, [closed]]]), now)).toBe(1);
    expect(persisted()).toEqual([]);
  });

  it("GET carries no count or quantifier over machines — only per-(device, key) socket counts", async () => {
    await present({ enrollments: [await enrol("vps"), await enrol("nas")] });
    connectPeer(peer("vps"));
    connectPeer(peer("phone", { capabilities: ["sync"] }));
    observe(peer("nas"), 1);
    const served = (await read()).json;
    expect(Object.keys(served).sort()).toEqual([
      "enrollments",
      "liveness",
      "motebit_id",
      "retirements",
    ]);
    expect(Object.keys(served.liveness as object).sort()).toEqual([
      "live_unenrolled",
      "observed_by",
      "observing_since",
      "retention_days",
      "rows",
    ]);
    const QUANTIFIER =
      /count|total|machines|members|number|^n$|^all|^none|every|active|retired|superseded|connected|online|reached|status|verdict/i;
    const walk = (v: unknown, path: string): string[] => {
      if (Array.isArray(v)) return v.flatMap((x, i) => walk(x, `${path}[${i}]`));
      if (v == null || typeof v !== "object") return [];
      return Object.entries(v).flatMap(([k, x]) => [
        ...(QUANTIFIER.test(k) && !path.startsWith("enrollments") && !path.startsWith("retirements")
          ? [`${path}.${k}`]
          : []),
        ...walk(x, `${path}.${k}`),
      ]);
    };
    expect(walk(served.liveness, "liveness")).toEqual([]);
    for (const r of (served.liveness as Liveness).rows) {
      expect(Object.keys(r).sort()).toEqual([
        "bound_under",
        "device_id",
        "host_sockets_open",
        "last_seen_at",
        "sockets_open",
      ]);
    }
  });
});

describe("the relay never reduces", () => {
  it("no relay source file calls the roster reduction (verifyHostRoster)", () => {
    // The one rule: a relay that cannot compute a roster cannot compute a
    // wrong one. Every non-test source under services/relay/src.
    const root = resolve(__dirname, "..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          if (name !== "__tests__") walk(p);
        } else if (/\.(ts|tsx|js|mjs)$/.test(name)) {
          files.push(p);
        }
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(50); // the aperture: the whole relay, not a sample
    // A call or an import — prose that NAMES the law (to say it is not
    // called here) is not a use of it.
    const USE = /\bverifyHostRoster\s*\(|import[^;]*\bverifyHostRoster\b/;
    const offenders = files.filter((f) => USE.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
