/**
 * The relay's half of the machine roster: it stores what the sovereign
 * signed, serves it back unchanged, and reports beside it — never inside
 * it — what it has observed about each machine's connection.
 *
 * `spec/machine-roster-v1.md`, `docs/doctrine/machine-roster.md`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
import type { HostEnrollment, HostRetirement } from "@motebit/protocol";
import { createTestRelay } from "./test-helpers.js";
import {
  observeHostConnection,
  pruneHostLiveness,
  recordHostLastSeen,
} from "../host-roster-store.js";

let relay: SyncRelay;
let owner: KeyPair;
let pub: string;
let motebitId: string;

const JSON_HEADERS = { "Content-Type": "application/json" };

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

async function as(
  mid: string,
  deviceId: string,
  kp: KeyPair,
  path: string,
  init: RequestInit = {},
) {
  const { token } = await mintAudienceToken(
    { mid, did: deviceId, aud: "admin:query" },
    kp.privateKey,
  );
  const res = await relay.app.request(path, {
    ...init,
    headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` },
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const present = (body: { enrollments?: unknown[]; retirements?: unknown[] }) =>
  as(motebitId, "laptop", owner, `/api/v1/agents/${motebitId}/roster`, {
    method: "POST",
    body: JSON.stringify(body),
  });

const read = () => as(motebitId, "laptop", owner, `/api/v1/agents/${motebitId}/roster`);

const enrol = (deviceId: string, at = 1_000) =>
  signHostEnrollment(
    { motebit_id: motebitId, device_id: deviceId, public_key: pub, enrolled_at: at },
    owner.privateKey,
  );

const retire = async (e: HostEnrollment) =>
  signHostRetirement(
    {
      motebit_id: motebitId,
      enrollment_id: await hostEnrollmentId(e),
      public_key: pub,
      retired_at: 2_000,
    },
    owner.privateKey,
  );

function rows(): number {
  return (
    relay.moteDb.db
      .prepare("SELECT COUNT(*) AS n FROM relay_host_roster_entries WHERE motebit_id = ?")
      .get(motebitId) as { n: number }
  ).n;
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
    // Also the assertion part A deferred to here: the signer's real
    // output passes the strict wire schema at the boundary.
    const laptop = await enrol("laptop");
    const { status, json } = await present({ enrollments: [laptop] });
    expect(status).toBe(200);
    expect(json.accepted).toEqual([
      { kind: "enrollment", id: await hostEnrollmentId(laptop), status: "stored" },
    ]);

    const served = (await read()).json;
    expect(served.enrollments).toEqual([laptop]);
    // Verbatim means a consumer can verify it without trusting the relay.
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
    // A surface re-presenting the set after the relay lost its data will
    // present entries that are months old. Refusing them would make the
    // offline machine vanish — the defect the roster exists to fix.
    const ancient = await enrol("vps", Date.now() - 400 * 24 * 60 * 60 * 1000);
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
    // A consumer reduces what it was served, against a chain IT verified.
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

describe("what the relay refuses to hold", () => {
  it("an entry under a key this identity has never held — and says so per entry", async () => {
    const stranger = await generateKeypair();
    const forged = await signHostEnrollment(
      {
        motebit_id: motebitId,
        device_id: "attacker-box",
        public_key: bytesToHex(stranger.publicKey),
        enrolled_at: 1,
      },
      stranger.privateKey,
    );
    const good = await enrol("laptop");
    const { status, json } = await present({ enrollments: [good, forged] });
    // A partial is not a success: a caller that checks only `ok` must not
    // believe its whole set was taken.
    expect(status).toBe(422);
    expect(json.refused).toEqual([{ kind: "enrollment", index: 1, reason: "untrusted_key" }]);
    // The good one is still held — refusing a neighbour is not a veto.
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

  it("an entry under a SUPERSEDED key is still held — a replica must be able to restore history", async () => {
    // After a rotation the old-key lines are how a consumer sees the
    // machine that was cut off. The relay cannot be where they are lost.
    const old = await generateKeypair();
    const oldPub = bytesToHex(old.publicKey);
    relay.moteDb.db
      .prepare(
        "INSERT INTO relay_key_successions (motebit_id, old_public_key, new_public_key, timestamp, new_key_signature) VALUES (?, ?, ?, ?, ?)",
      )
      .run(motebitId, oldPub, pub, Date.now(), "sig");
    const lost = await signHostEnrollment(
      { motebit_id: motebitId, device_id: "lost-vps", public_key: oldPub, enrolled_at: 1 },
      old.privateKey,
    );
    expect((await present({ enrollments: [lost] })).status).toBe(200);
  });

  it("a body that is not a roster presentation, and more entries than one request may carry", async () => {
    expect((await present({})).status).toBe(400);
    const many = await Promise.all(Array.from({ length: 65 }, (_, i) => enrol(`m-${i}`)));
    expect((await present({ enrollments: many })).status).toBe(413);
    expect(rows()).toBe(0);
  });
});

describe("the roster is first-person", () => {
  it("is not readable or writable without the owner's token", async () => {
    const bare = await relay.app.request(`/api/v1/agents/${motebitId}/roster`);
    expect(bare.status).toBe(401);
    const post = await relay.app.request(`/api/v1/agents/${motebitId}/roster`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ enrollments: [await enrol("laptop")] }),
    });
    expect(post.status).toBe(401);
    expect(rows()).toBe(0);
  });

  it("is not readable by another identity", async () => {
    const other = await generateKeypair();
    const otherId = crypto.randomUUID();
    await bootstrap(otherId, "their-laptop", other);
    await present({ enrollments: [await enrol("laptop")] });
    const peek = await as(otherId, "their-laptop", other, `/api/v1/agents/${motebitId}/roster`);
    expect(peek.status).toBeGreaterThanOrEqual(401);
    expect(peek.json.enrollments).toBeUndefined();
  });
});

describe("liveness is served BESIDE the signed set, never inside it", () => {
  type Liveness = {
    observed_by: string;
    members: Array<{
      device_id: string;
      socket_open: boolean;
      last_seen_at: number | null;
      last_announced: string[] | null;
    }>;
    unknown_connections: number;
  };

  function connect(deviceId: string, opts: { verified?: boolean; capabilities?: string[] } = {}) {
    const peer = {
      ws: { readyState: 1, send: () => {} },
      deviceId,
      deviceIdDeclared: true,
      deviceIdVerified: opts.verified ?? true,
      capabilities: opts.capabilities ?? ["unattended_runtime"],
    };
    const existing = relay.connections.get(motebitId) ?? [];
    relay.connections.set(motebitId, [...existing, peer] as unknown as Parameters<
      typeof relay.connections.set
    >[1]);
  }

  it("an OFFLINE member is still a line — named, with when it was last seen", async () => {
    // The whole point. A relay that lists only who is connected cannot
    // say "every machine"; this one lists who is ENROLLED.
    await present({ enrollments: [await enrol("laptop"), await enrol("vps")] });
    connect("laptop");
    recordHostLastSeen(
      relay.moteDb.db,
      motebitId,
      "vps",
      ["unattended_runtime"],
      1_700_000_000_000,
    );

    const live = (await read()).json.liveness as Liveness;
    expect(live.observed_by).toBe("relay");
    const byId = new Map(live.members.map((m) => [m.device_id, m]));
    expect(byId.get("laptop")?.socket_open).toBe(true);
    expect(byId.get("vps")).toEqual({
      device_id: "vps",
      socket_open: false,
      last_seen_at: 1_700_000_000_000,
      last_announced: ["unattended_runtime"],
    });
  });

  it("a member never seen is a line too — with nothing claimed about it", async () => {
    await present({ enrollments: [await enrol("vps")] });
    const live = (await read()).json.liveness as Liveness;
    expect(live.members).toEqual([
      { device_id: "vps", socket_open: false, last_seen_at: null, last_announced: null },
    ]);
  });

  it("a socket that only DECLARED a member's id does not light that member's line", async () => {
    // The VPS is fully registered, so the ONLY thing missing is proof:
    // this socket typed the id into its URL and its token named another.
    await bootstrap(motebitId, "vps", owner);
    await present({ enrollments: [await enrol("vps")] });
    connect("vps", { verified: false });
    const live = (await read()).json.liveness as Liveness;
    expect(live.members[0]?.socket_open).toBe(false);
    // It is reported as what it is: a connection the roster does not know.
    expect(live.unknown_connections).toBe(1);
  });

  it("a PROVEN device id is still not bound when its key is not the one the line was enrolled under", async () => {
    // A device linked without key transfer holds its own key. Its token
    // proves its device id — under a key that signed no enrolment. The
    // line belongs to whoever holds the motebit's identity key.
    const ownKey = await generateKeypair();
    relay.moteDb.db
      .prepare(
        "INSERT INTO devices (device_id, motebit_id, device_token, public_key, registered_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("vps", motebitId, crypto.randomUUID(), bytesToHex(ownKey.publicKey), Date.now());
    await present({ enrollments: [await enrol("vps")] });
    connect("vps");
    const live = (await read()).json.liveness as Liveness;
    expect(live.members[0]?.socket_open).toBe(false);
    expect(live.unknown_connections).toBe(1);
  });

  it("an unattended connection with no enrolment is counted beside the set, never added to it", async () => {
    await present({ enrollments: [await enrol("laptop")] });
    connect("laptop");
    connect("mystery-box");
    const served = (await read()).json;
    const live = served.liveness as Liveness;
    expect(live.members.map((m) => m.device_id)).toEqual(["laptop"]);
    expect(live.unknown_connections).toBe(1);
    expect((served.enrollments as unknown[]).length).toBe(1);
  });

  it("a connection that does not host unattended work is not the roster's business", async () => {
    await present({ enrollments: [await enrol("laptop")] });
    connect("phone", { capabilities: ["sync"] });
    expect(((await read()).json.liveness as Liveness).unknown_connections).toBe(0);
  });

  it("a RETIRED machine that is connected still shows as open — so a consumer can say so", async () => {
    await bootstrap(motebitId, "vps", owner);
    const vps = await enrol("vps");
    await present({ enrollments: [vps], retirements: [await retire(vps)] });
    connect("vps");
    const live = (await read()).json.liveness as Liveness;
    expect(live.members).toEqual([
      expect.objectContaining({ device_id: "vps", socket_open: true }),
    ]);
  });
});

describe("what the relay is willing to remember about a connection", () => {
  // The transparency declaration promises: nothing about a connection
  // from a device the motebit has not enrolled. The socket's close hook
  // and the periodic flush both go through this one function, so this is
  // where that promise is kept — and tested.
  const seen = () =>
    (
      relay.moteDb.db
        .prepare(
          "SELECT device_id FROM relay_host_liveness WHERE motebit_id = ? ORDER BY device_id",
        )
        .all(motebitId) as Array<{ device_id: string }>
    ).map((r) => r.device_id);

  it("records an enrolled machine whose token proved its device id", async () => {
    await present({ enrollments: [await enrol("laptop")] });
    expect(
      observeHostConnection(
        relay.moteDb.db,
        motebitId,
        { deviceId: "laptop", deviceIdVerified: true, capabilities: ["unattended_runtime"] },
        5_000,
      ),
    ).toBe(true);
    expect(seen()).toEqual(["laptop"]);
  });

  it("records NOTHING for a device the motebit has not enrolled", async () => {
    await present({ enrollments: [await enrol("laptop")] });
    expect(
      observeHostConnection(relay.moteDb.db, motebitId, {
        deviceId: "phone",
        deviceIdVerified: true,
      }),
    ).toBe(false);
    expect(seen()).toEqual([]);
  });

  it("records NOTHING for a socket that only declared an enrolled machine's id", async () => {
    await present({ enrollments: [await enrol("laptop")] });
    for (const deviceIdVerified of [false, undefined]) {
      expect(
        observeHostConnection(relay.moteDb.db, motebitId, { deviceId: "laptop", deviceIdVerified }),
      ).toBe(false);
    }
    expect(seen()).toEqual([]);
  });
});

describe("the one persisted observation", () => {
  it("is a single overwritten value per machine, never a history", () => {
    const db = relay.moteDb.db;
    recordHostLastSeen(db, motebitId, "vps", ["a"], 1_000);
    recordHostLastSeen(db, motebitId, "vps", ["b"], 2_000);
    const all = db
      .prepare("SELECT last_seen_at, last_announced FROM relay_host_liveness WHERE motebit_id = ?")
      .all(motebitId) as Array<{ last_seen_at: number; last_announced: string }>;
    expect(all).toEqual([{ last_seen_at: 2_000, last_announced: '["b"]' }]);
  });

  it("is deleted 30 days after the machine is retired, and not before", async () => {
    const db = relay.moteDb.db;
    const vps = await enrol("vps");
    const laptop = await enrol("laptop");
    await present({ enrollments: [vps, laptop], retirements: [await retire(vps)] });
    const retiredReceivedAt = (
      db
        .prepare("SELECT received_at FROM relay_host_roster_entries WHERE kind = 'retirement'")
        .get() as { received_at: number }
    ).received_at;
    recordHostLastSeen(db, motebitId, "vps", [], 1);
    recordHostLastSeen(db, motebitId, "laptop", [], 1);
    const DAY = 24 * 60 * 60 * 1000;
    const left = () =>
      (
        db.prepare("SELECT device_id FROM relay_host_liveness ORDER BY device_id").all() as Array<{
          device_id: string;
        }>
      ).map((r) => r.device_id);

    pruneHostLiveness(db, retiredReceivedAt + 29 * DAY);
    expect(left()).toEqual(["laptop", "vps"]);
    pruneHostLiveness(db, retiredReceivedAt + 31 * DAY);
    // The ACTIVE machine's line is never pruned by age: silence is not an exit.
    expect(left()).toEqual(["laptop"]);
  });
});
