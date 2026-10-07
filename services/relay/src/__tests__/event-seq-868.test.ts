/**
 * #868 — the relay ingest sequence is the event-sync transport cursor.
 *
 * A device pulled `after_clock = <its own max clock>`. Clocks are assigned by
 * devices, so a sibling device's event at an EQUAL clock was skipped forever.
 * The relay now stamps every stored event with a relay-assigned `seq`
 * (event-seq.ts, migration v46) and serves `after_seq` pulls; the clock path
 * is unchanged for every shipped client.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeypair, bytesToHex, mintAudienceToken } from "@motebit/crypto";
import { createMotebitDatabase } from "@motebit/persistence";
import type { SyncRelay } from "../index.js";
import { relayMigrations, runMigrations } from "../migrations.js";
import { readEventsAfterSeq } from "../event-seq.js";
import type { BoundIdentity } from "../identity-binding.js";
import { createTestRelay, AUTH_HEADER, JSON_AUTH, signedBootstrapBody } from "./test-helpers.js";

type Ev = {
  event_id: string;
  motebit_id: string;
  timestamp: number;
  event_type: string;
  payload: Record<string, unknown>;
  version_clock: number;
  tombstoned: boolean;
  device_id?: string;
};

const ev = (mid: string, id: string, clock: number, device = "dev-a"): Ev => ({
  event_id: id,
  motebit_id: mid,
  timestamp: 1_700_000_000_000 + clock,
  event_type: "state_snapshot",
  payload: { n: clock, from: device },
  version_clock: clock,
  tombstoned: false,
  device_id: device,
});

interface SeqBody {
  motebit_id: string;
  events: Array<Ev & { seq: number }>;
  after_seq: number;
  next_seq: number;
  has_more: boolean;
  latest_seq: number;
}

let relay: SyncRelay;

async function push(mid: string, events: Ev[], headers: Record<string, string> = JSON_AUTH) {
  const res = await relay.app.request(`/sync/${mid}/push`, {
    method: "POST",
    headers,
    body: JSON.stringify({ events }),
  });
  expect(res.status).toBe(200);
}

async function pullSeq(mid: string, afterSeq: number, extra = ""): Promise<SeqBody> {
  const res = await relay.app.request(`/sync/${mid}/pull?after_seq=${afterSeq}${extra}`, {
    headers: AUTH_HEADER,
  });
  expect(res.status).toBe(200);
  return (await res.json()) as SeqBody;
}

async function pullClock(mid: string, afterClock: number): Promise<{ events: Ev[] }> {
  const res = await relay.app.request(`/sync/${mid}/pull?after_clock=${afterClock}`, {
    headers: AUTH_HEADER,
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { events: Ev[] };
}

describe("#868 relay ingest sequence", () => {
  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: true });
  });
  afterEach(async () => {
    await relay.close();
  });

  it("an event a sibling device published at an EQUAL clock is skipped by the clock cursor and served by the seq cursor", async () => {
    const mid = crypto.randomUUID();
    // Device A appends at clock 11 and pushes; it pulls and learns the seq.
    await push(mid, [ev(mid, "evt-11", 11, "dev-a")]);
    const first = await pullSeq(mid, 0);
    expect(first.events.map((e) => e.event_id)).toEqual(["evt-11"]);
    const cursor = first.next_seq;

    // Device B, same identity, independently publishes at the SAME clock 11.
    await push(mid, [ev(mid, "in-11", 11, "dev-b")]);

    // The old cursor (A's own max clock = 11) never returns it — the defect.
    const byClock = await pullClock(mid, 11);
    expect(byClock.events.map((e) => e.event_id)).toEqual([]);

    // The seq cursor returns it.
    const bySeq = await pullSeq(mid, cursor);
    expect(bySeq.events.map((e) => e.event_id)).toEqual(["in-11"]);
    expect(bySeq.events[0]!.seq).toBeGreaterThan(cursor);
  });

  it("an old client's pull (no after_seq) is served exactly as before: same keys, no seq on any event", async () => {
    const mid = crypto.randomUUID();
    await push(mid, [ev(mid, "a", 1), ev(mid, "b", 2)]);
    const res = await relay.app.request(`/sync/${mid}/pull?after_clock=0`, {
      headers: AUTH_HEADER,
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["motebit_id", "events", "after_clock"]);
    expect(body.after_clock).toBe(0);
    for (const e of body.events as Record<string, unknown>[]) expect("seq" in e).toBe(false);
    // …and with no cursor at all.
    const bare = await relay.app.request(`/sync/${mid}/pull`, { headers: AUTH_HEADER });
    expect(Object.keys((await bare.json()) as object)).toEqual([
      "motebit_id",
      "events",
      "after_clock",
    ]);
  });

  it("a seq page carries the same entries the clock pull serves, redaction included", async () => {
    const mid = crypto.randomUUID();
    const secret: Ev = {
      ...ev(mid, "m-secret", 3),
      event_type: "memory_formed",
      payload: { node_id: "n1", content: "my diagnosis", sensitivity: "medical" },
    };
    await push(mid, [ev(mid, "a", 1), ev(mid, "b", 2), secret]);
    const clock = await pullClock(mid, 0);
    const seq = await pullSeq(mid, 0);
    const stripped = seq.events.map(({ seq: _s, ...rest }) => rest);
    expect(stripped).toEqual(clock.events);
    const redacted = seq.events.find((e) => e.event_id === "m-secret")!;
    expect(redacted.payload.content).not.toBe("my diagnosis");
  });

  it("seq is strictly increasing in ingest order; next_seq / has_more page the stream without a gap", async () => {
    const mid = crypto.randomUUID();
    // Clocks deliberately out of order and colliding.
    const clocks = [5, 5, 1, 9, 9, 3, 7];
    await push(
      mid,
      clocks.map((c, i) => ev(mid, `e${i}`, c, i % 2 === 0 ? "dev-a" : "dev-b")),
    );
    const got: string[] = [];
    let cursor = 0;
    let pages = 0;
    for (;;) {
      const page = await pullSeq(mid, cursor, "&limit=2");
      pages++;
      const seqs = page.events.map((e) => e.seq);
      expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
      for (const s of seqs) expect(s).toBeGreaterThan(cursor);
      got.push(...page.events.map((e) => e.event_id));
      cursor = page.next_seq;
      if (!page.has_more) break;
    }
    expect(got).toEqual(clocks.map((_, i) => `e${i}`));
    expect(pages).toBe(4);
    expect((await pullSeq(mid, cursor)).events).toEqual([]);
  });

  it("refuses a malformed after_seq", async () => {
    const mid = crypto.randomUUID();
    for (const bad of ["-1", "abc", "1.5", "1e3", "99999999999999999999"]) {
      const res = await relay.app.request(`/sync/${mid}/pull?after_seq=${bad}`, {
        headers: AUTH_HEADER,
      });
      expect(res.status).toBe(400);
    }
  });

  it("every writer is stamped — the sync door, a direct EventStore append, and raw SQL — inside the INSERT", async () => {
    const mid = crypto.randomUUID();
    await push(mid, [ev(mid, "via-door", 1)]);
    // The relay-authored path tasks.ts uses (EventStore.append, no binding).
    await relay.moteDb.eventStore.append(ev(mid, "via-store", 2) as never);
    // Any writer at all.
    relay.moteDb.db
      .prepare(
        `INSERT INTO events (event_id, motebit_id, event_type, payload, version_clock, timestamp, tombstoned)
         VALUES ('via-sql', ?, 'state_snapshot', '{}', 3, 1, 0)`,
      )
      .run(mid);
    const unstamped = relay.moteDb.db
      .prepare(
        "SELECT e.event_id FROM events e LEFT JOIN relay_event_seq s ON s.event_id = e.event_id WHERE s.seq IS NULL",
      )
      .all();
    expect(unstamped).toEqual([]);
    expect((await pullSeq(mid, 0)).events.map((e) => e.event_id)).toEqual([
      "via-door",
      "via-store",
      "via-sql",
    ]);
  });

  it("the stamp commits or rolls back WITH the event row: a rolled-back insert leaves no seq, and a later seq is never lower", async () => {
    const mid = crypto.randomUUID();
    await push(mid, [ev(mid, "before", 1)]);
    const before = (await pullSeq(mid, 0)).latest_seq;
    expect(() =>
      relay.moteDb.db.transaction(() => {
        relay.moteDb.db
          .prepare(
            `INSERT INTO events (event_id, motebit_id, event_type, payload, version_clock, timestamp, tombstoned)
             VALUES ('rolled-back', ?, 'state_snapshot', '{}', 2, 1, 0)`,
          )
          .run(mid);
        // Inside the same transaction the stamp already exists…
        const inside = relay.moteDb.db
          .prepare("SELECT seq FROM relay_event_seq WHERE event_id = 'rolled-back'")
          .get() as { seq: number } | undefined;
        expect(inside?.seq).toBeGreaterThan(before);
        throw new Error("abort");
      }),
    ).toThrow("abort");
    // …and it rolled back with the event.
    expect(
      relay.moteDb.db.prepare("SELECT 1 FROM relay_event_seq WHERE event_id = 'rolled-back'").get(),
    ).toBeUndefined();
    await push(mid, [ev(mid, "after", 3)]);
    const page = await pullSeq(mid, before);
    expect(page.events.map((e) => e.event_id)).toEqual(["after"]);
    // AUTOINCREMENT: the rolled-back number is a gap, never reissued below a cursor.
    expect(page.events[0]!.seq).toBeGreaterThan(before);
  });

  it("a duplicate push takes no new seq; a deleted-then-repushed event takes a FRESH one above every earlier seq", async () => {
    const mid = crypto.randomUUID();
    await push(mid, [ev(mid, "x", 1), ev(mid, "y", 2)]);
    const first = await pullSeq(mid, 0);
    await push(mid, [ev(mid, "x", 1)]); // replay
    expect((await pullSeq(mid, first.next_seq)).events).toEqual([]);
    // Retention deletes x; its seq row goes with it.
    await relay.moteDb.eventStore.compact(mid as never, 1);
    expect(
      relay.moteDb.db.prepare("SELECT 1 FROM relay_event_seq WHERE event_id = 'x'").get(),
    ).toBeUndefined();
    await push(mid, [ev(mid, "x", 1)]);
    const again = await pullSeq(mid, first.next_seq);
    expect(again.events.map((e) => e.event_id)).toEqual(["x"]);
    expect(again.events[0]!.seq).toBeGreaterThan(first.next_seq);
  });

  it("concurrent pushes from two devices interleaved with seq pulls: the union of the pulls is every event, each exactly once", async () => {
    const mid = crypto.randomUUID();
    const pulled: string[] = [];
    let cursor = 0;
    const puller = async (): Promise<void> => {
      const page = await pullSeq(mid, cursor);
      pulled.push(...page.events.map((e) => e.event_id));
      cursor = page.next_seq;
    };
    const writes: Promise<void>[] = [];
    const all: string[] = [];
    for (let i = 0; i < 60; i++) {
      // Both devices use the SAME clock sequence — every clock collides.
      const a = ev(mid, `a-${i}`, i, "dev-a");
      const b = ev(mid, `b-${i}`, i, "dev-b");
      all.push(a.event_id, b.event_id);
      writes.push(push(mid, [a]), push(mid, [b]));
      if (i % 7 === 0) writes.push(puller());
    }
    await Promise.all(writes);
    await puller();
    expect(new Set(pulled).size).toBe(pulled.length); // each once
    expect([...pulled].sort()).toEqual([...all].sort()); // every one
  });

  it("the seq is PER IDENTITY: another identity's writes leave no gap and no trace in this identity's stream", async () => {
    const A = crypto.randomUUID();
    const B = crypto.randomUUID();
    await push(A, [ev(A, `a1-${A}`, 1)]);
    for (let i = 0; i < 7; i++) await push(B, [ev(B, `b${i}-${B}`, i)]);
    await push(A, [ev(A, `a2-${A}`, 2)]);
    const a = await pullSeq(A, 0);
    expect(a.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(a.latest_seq).toBe(2);
    const b = await pullSeq(B, 0);
    expect(b.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("a deleted top seq is never reissued: the next event takes a number above it, and latest_seq never falls", async () => {
    const mid = crypto.randomUUID();
    await push(mid, [ev(mid, `k1-${mid}`, 1), ev(mid, `k2-${mid}`, 2), ev(mid, `k3-${mid}`, 3)]);
    const before = await pullSeq(mid, 0);
    expect(before.next_seq).toBe(3);
    // Retention removes the TOP rows (clock ≤ 3 = all three).
    await relay.moteDb.eventStore.compact(mid as never, 3);
    const emptied = await pullSeq(mid, before.next_seq);
    expect(emptied.latest_seq).toBe(3); // the counter, not MAX over the surviving rows
    // A device whose cursor sits at 3 must still receive the next event.
    await push(mid, [ev(mid, `k4-${mid}`, 4)]);
    const after = await pullSeq(mid, before.next_seq);
    expect(after.events.map((e) => [e.event_id, e.seq])).toEqual([[`k4-${mid}`, 4]]);
  });

  describe("identity binding (#846/#865): the seq read serves only the identity the token was verified for", () => {
    async function boot(id: string, device: string) {
      const kp = await generateKeypair();
      const r = await relay.app.request(`/api/v1/agents/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: await signedBootstrapBody(
          { motebit_id: id, device_id: device, public_key: bytesToHex(kp.publicKey) },
          kp.privateKey,
        ),
      });
      expect(r.status).toBeLessThan(300);
      const tok = (await mintAudienceToken({ mid: id, did: device, aud: "sync" }, kp.privateKey))
        .token;
      return { id, tok };
    }
    const bearer = (tok: string) => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${tok}`,
    });

    it("own token reads own seq stream; another identity's token is refused; no cross-identity event ever appears", async () => {
      const V = await boot(crypto.randomUUID(), "v-dev");
      const X = await boot(crypto.randomUUID(), "x-dev");
      await push(V.id, [ev(V.id, "v-1", 1)], bearer(V.tok));
      await push(X.id, [ev(X.id, "x-1", 1)], bearer(X.tok));

      const own = await relay.app.request(`/sync/${V.id}/pull?after_seq=0`, {
        headers: bearer(V.tok),
      });
      expect(own.status).toBe(200);
      const body = (await own.json()) as SeqBody;
      expect(body.events.map((e) => e.event_id)).toEqual(["v-1"]);
      expect(body.latest_seq).toBe(body.next_seq);

      const cross = await relay.app.request(`/sync/${V.id}/pull?after_seq=0`, {
        headers: bearer(X.tok),
      });
      expect(cross.status).toBe(403);
      const none = await relay.app.request(`/sync/${V.id}/pull?after_seq=0`);
      expect(none.status).toBe(401);
    });

    it("the seq reader throws on a forged owner (a cast string) and returns nothing", async () => {
      const V = await boot(crypto.randomUUID(), "v-dev");
      await push(V.id, [ev(V.id, "v-1", 1)], bearer(V.tok));
      const forged = V.id as unknown as BoundIdentity;
      expect(() => readEventsAfterSeq(relay.moteDb.db, forged, 0)).toThrow(/not a BoundIdentity/);
    });
  });
});

describe("#868 migration v46 — backfill and restart", () => {
  it("backfills every pre-existing event in ingest (rowid) order, then stamps new inserts after them", () => {
    const moteDb = createMotebitDatabase(":memory:");
    const db = moteDb.db;
    try {
      // A database as it stood before v46: events held (persistence's schema), no sequence.
      const ins = db.prepare(
        `INSERT INTO events (event_id, motebit_id, event_type, payload, version_clock, timestamp, tombstoned)
         VALUES (?, ?, 'state_snapshot', '{}', ?, 1, 0)`,
      );
      // Ingest order differs from clock order and from event_id order.
      ins.run("z-first", "m1", 9);
      ins.run("a-second", "m2", 1);
      ins.run("m-third", "m1", 1);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name = 'relay_event_seq'").get(),
      ).toBeUndefined();

      runMigrations(
        db,
        relayMigrations.filter((m) => m.version === 46),
      );

      const rows = db
        .prepare("SELECT seq, event_id, motebit_id FROM relay_event_seq ORDER BY motebit_id, seq")
        .all() as Array<{
        seq: number;
        event_id: string;
        motebit_id: string;
      }>;
      // Numbered PER IDENTITY, each in ingest order.
      expect(rows.map((r) => [r.motebit_id, r.seq, r.event_id])).toEqual([
        ["m1", 1, "z-first"],
        ["m1", 2, "m-third"],
        ["m2", 1, "a-second"],
      ]);
      const counters = db
        .prepare("SELECT motebit_id, last_seq FROM relay_event_seq_counter ORDER BY motebit_id")
        .all();
      expect(counters).toEqual([
        { motebit_id: "m1", last_seq: 2 },
        { motebit_id: "m2", last_seq: 1 },
      ]);
      ins.run("new-after", "m1", 2);
      const last = db
        .prepare("SELECT seq FROM relay_event_seq WHERE event_id = 'new-after'")
        .get() as { seq: number };
      expect(last.seq).toBe(3);
    } finally {
      moteDb.close();
    }
  });

  it("upgrading a live relay mid-sequence: events held before v46 reach a new client's first seq pull (from 0), in ingest order, then later pushes follow", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zz868-upgrade-"));
    const dbPath = join(dir, "relay.db");
    try {
      const mid = crypto.randomUUID();
      relay = await createTestRelay({ dbPath });
      // Put the database back to its pre-v46 shape: no sequence, no triggers,
      // v46 not applied — then events land the way a pre-v46 relay stored them.
      // Every LATER migration is un-recorded too: the runner skips any version
      // at or below the recorded maximum, so a recorded v47+ would keep v46
      // from re-running. (Later migrations are idempotent and re-run cleanly.)
      relay.moteDb.db.exec(`
        DROP TRIGGER relay_event_seq_stamp;
        DROP TRIGGER relay_event_seq_unstamp;
        DROP TABLE relay_event_seq;
        DROP TABLE relay_event_seq_counter;
        DELETE FROM relay_schema_migrations WHERE version >= 46;
      `);
      await push(mid, [ev(mid, "old-b", 4, "dev-b"), ev(mid, "old-a", 4, "dev-a")]);
      await push(mid, [ev(mid, "old-c", 2, "dev-c")]);
      await relay.close();

      relay = await createTestRelay({ dbPath }); // boot runs v46
      await push(mid, [ev(mid, "new-d", 4, "dev-d")]);
      const page = await pullSeq(mid, 0);
      expect(page.events.map((e) => e.event_id)).toEqual(["old-b", "old-a", "old-c", "new-d"]);
      await relay.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a relay restart on the same database keeps the sequence: a cursor taken before the restart resumes without loss or repeat", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zz868-restart-"));
    const dbPath = join(dir, "relay.db");
    try {
      const mid = crypto.randomUUID();
      relay = await createTestRelay({ dbPath });
      await push(mid, [ev(mid, "a", 1), ev(mid, "b", 1, "dev-b")]);
      const before = await pullSeq(mid, 0);
      await relay.close();

      relay = await createTestRelay({ dbPath });
      await push(mid, [ev(mid, "c", 1, "dev-c")]); // same clock again
      const after = await pullSeq(mid, before.next_seq);
      expect(after.events.map((e) => e.event_id)).toEqual(["c"]);
      expect(after.events[0]!.seq).toBeGreaterThan(before.next_seq);
      await relay.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
