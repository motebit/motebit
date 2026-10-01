/**
 * #962 round 6 (C1, P3) — a pinned compaction floor is never SILENT or
 * DOORLESS.
 *
 * `connectRemote` persists `push:<stream>=0` for any relay it touches and
 * the floor is the MIN over the identity's streams, so one connect to a
 * mistyped relay, or a relay switch, pinned compaction for good, and nothing
 * could say so or undo it. Absence is never evidence — a stream is never
 * auto-retired — so the doors are explicit: `syncFloorReport` (what holds
 * the floor, and how many events), `pinnedFloor` (the one-line notice),
 * `retireRelayStream` (the operator removes a stream from the floor; a
 * reconnect restores it).
 */
import { describe, it, expect } from "vitest";
import { EventType } from "@motebit/sdk";
import type { EventLogEntry } from "@motebit/sdk";
import { InMemoryEventStore } from "@motebit/event-log";
import * as syncEngine from "../index.js";
import {
  HttpEventStoreAdapter,
  SyncEngine,
  clearSyncIntent,
  pushCompactionFloor,
  recordSyncIntent,
  resolveSeqCursorStore,
} from "../index.js";

interface StreamReport {
  stream: string;
  relayUrl: string | null;
  acked: number;
  lastAckAt: number | null;
  retiredAt: number | null;
  holdsFloor: boolean;
  heldBack: number;
}
interface FloorReport {
  intent: string;
  requested: number;
  floor: number;
  streams: StreamReport[];
}
const doors = syncEngine as unknown as {
  syncFloorReport?: (
    store: InMemoryEventStore,
    motebitId: string,
    opts?: { requested?: number },
  ) => Promise<FloorReport>;
  retireRelayStream?: (
    store: InMemoryEventStore,
    motebitId: string,
    stream: string,
    opts?: { now?: number },
  ) => Promise<void>;
  relayStreamOfUrl?: (url: string, motebitId: string) => string;
  pinnedFloor?: (
    report: FloorReport,
    now?: number,
  ) => { stream: StreamReport; reason: "never-acked" | "stale" } | null;
  pushAckedAtKey?: (stream: string) => string;
};

const MID = "mote-962doors";
const DAY = 86_400_000;

function event(clock: number): EventLogEntry {
  return {
    event_id: `e${clock}`,
    motebit_id: MID as EventLogEntry["motebit_id"],
    timestamp: clock,
    event_type: EventType.StateUpdated,
    payload: {},
    version_clock: clock,
    tombstoned: false,
  };
}

async function storeWith(n: number, cursors: Record<string, number>): Promise<InMemoryEventStore> {
  const store = new InMemoryEventStore();
  for (let i = 1; i <= n; i++) await store.append(event(i));
  const cs = resolveSeqCursorStore(store);
  for (const [k, v] of Object.entries(cursors)) await cs.setSyncSeqCursor(k, v);
  await recordSyncIntent(store, MID);
  return store;
}

const TYPO = "https://typo.invalid";
const RIGHT = "http://relay.right";

describe("#962 round 6 C1 — the doors exist", () => {
  it("sync-engine exports syncFloorReport, retireRelayStream, relayStreamOfUrl, pinnedFloor", () => {
    expect(typeof doors.syncFloorReport).toBe("function");
    expect(typeof doors.retireRelayStream).toBe("function");
    expect(typeof doors.relayStreamOfUrl).toBe("function");
    expect(typeof doors.pinnedFloor).toBe("function");
  });
});

describe("#962 round 6 C1 — a typo'd stream pins the floor: reported, then retired", () => {
  it("the probe: one connect to a typo'd relay; the right relay acked 10 of 20", async () => {
    const store = new InMemoryEventStore();
    // Process 1: one connect to the typo'd relay, nothing else.
    const p1 = new SyncEngine(store, MID);
    p1.connectRemote(new HttpEventStoreAdapter({ baseUrl: TYPO, motebitId: MID }));
    await recordSyncIntent(store, MID);
    await new Promise((r) => setTimeout(r, 0));
    // Process 2: 20 events; the right relay acknowledged 10.
    for (let i = 1; i <= 20; i++) await store.append(event(i));
    await resolveSeqCursorStore(store).setSyncSeqCursor(`push:raw:${RIGHT}#${MID}`, 10);

    // Before: pinned at 0 (the round-5 behaviour, kept — absence is never evidence).
    expect(await pushCompactionFloor(store, 19, { motebitId: MID })).toBe(0);

    const report = await doors.syncFloorReport!(store, MID);
    expect(report.requested).toBe(19);
    expect(report.floor).toBe(0);
    const typo = report.streams.find((s) => s.relayUrl === TYPO);
    expect(typo).toMatchObject({ acked: 0, lastAckAt: null, holdsFloor: true, heldBack: 10 });
    const right = report.streams.find((s) => s.relayUrl === RIGHT);
    expect(right).toMatchObject({ acked: 10, holdsFloor: false, heldBack: 0 });

    const pinned = doors.pinnedFloor!(report);
    expect(pinned?.stream.relayUrl).toBe(TYPO);
    expect(pinned?.reason).toBe("never-acked");

    await doors.retireRelayStream!(store, MID, doors.relayStreamOfUrl!(TYPO, MID));
    // After: compaction frees exactly what the remaining stream acked.
    expect(await pushCompactionFloor(store, 19, { motebitId: MID })).toBe(10);
    expect(await store.compact(MID, 10)).toBe(10);
    const after = await doors.syncFloorReport!(store, MID);
    expect(after.streams.find((s) => s.relayUrl === TYPO)?.retiredAt).not.toBeNull();
    expect(doors.pinnedFloor!(after)).toBeNull();
  });

  it("relay switch: A acked 50, B acked 5000 — floor 50, and clearSyncIntent does not move it; retiring A does", async () => {
    const store = await storeWith(0, {
      [`push:raw:https://a.relay#${MID}`]: 50,
      [`push:raw:https://b.relay#${MID}`]: 5000,
    });
    expect(await pushCompactionFloor(store, 4999, { motebitId: MID })).toBe(50);
    await clearSyncIntent(store, MID);
    expect(await pushCompactionFloor(store, 4999, { motebitId: MID })).toBe(50);
    await doors.retireRelayStream!(store, MID, doors.relayStreamOfUrl!("https://a.relay/", MID));
    expect(await pushCompactionFloor(store, 4999, { motebitId: MID })).toBe(4999);
  });

  it("a retired stream that is connected again holds the floor again (retirement is not forever)", async () => {
    const store = await storeWith(20, {
      [`push:raw:${TYPO}#${MID}`]: 0,
      [`push:raw:${RIGHT}#${MID}`]: 10,
    });
    await doors.retireRelayStream!(store, MID, doors.relayStreamOfUrl!(TYPO, MID));
    expect(await pushCompactionFloor(store, 19, { motebitId: MID })).toBe(10);
    const engine = new SyncEngine(store, MID);
    engine.connectRemote(new HttpEventStoreAdapter({ baseUrl: TYPO, motebitId: MID }));
    await new Promise((r) => setTimeout(r, 0));
    expect(await pushCompactionFloor(store, 19, { motebitId: MID })).toBe(0);
  });

  it("retiring every stream never frees what the recorded intent holds", async () => {
    const store = await storeWith(20, { [`push:raw:${TYPO}#${MID}`]: 0 });
    await doors.retireRelayStream!(store, MID, doors.relayStreamOfUrl!(TYPO, MID));
    expect(await pushCompactionFloor(store, 19, { motebitId: MID })).toBe(0);
  });

  it("an unreadable retirement marker fails closed", async () => {
    const store = await storeWith(20, {
      [`push:raw:${TYPO}#${MID}`]: 0,
      [`push:raw:${RIGHT}#${MID}`]: 10,
    });
    await doors.retireRelayStream!(store, MID, doors.relayStreamOfUrl!(TYPO, MID));
    const cs = resolveSeqCursorStore(store);
    const get = cs.getSyncSeqCursor.bind(cs);
    cs.getSyncSeqCursor = (key: string) =>
      key.startsWith("retired:") ? Promise.reject(new Error("disk")) : get(key);
    expect(await pushCompactionFloor(store, 19, { motebitId: MID })).toBe(0);
  });
});

describe("#962 round 6 — the pinned-floor notice: never-acked, or stale past 7 days", () => {
  it("a stream that acked, then stopped for > 7 days while another acked past it, is stale", async () => {
    const now = Date.UTC(2026, 9, 1);
    const store = await storeWith(100, {
      [`push:raw:https://old.relay#${MID}`]: 40,
      [`push:raw:${RIGHT}#${MID}`]: 90,
    });
    const cs = resolveSeqCursorStore(store);
    await cs.setSyncSeqCursor(doors.pushAckedAtKey!(`https://old.relay#${MID}`), now - 8 * DAY);
    await cs.setSyncSeqCursor(doors.pushAckedAtKey!(`${RIGHT}#${MID}`), now - DAY);
    const report = await doors.syncFloorReport!(store, MID);
    expect(report.floor).toBe(40);
    const pinned = doors.pinnedFloor!(report, now);
    expect(pinned?.stream.relayUrl).toBe("https://old.relay");
    expect(pinned?.reason).toBe("stale");
    expect(pinned?.stream.heldBack).toBe(50);
    // Six days: not yet.
    await cs.setSyncSeqCursor(doors.pushAckedAtKey!(`https://old.relay#${MID}`), now - 6 * DAY);
    expect(doors.pinnedFloor!(await doors.syncFloorReport!(store, MID), now)).toBeNull();
  });

  it("the only stream, never acked: no notice (retiring it would free nothing)", async () => {
    const store = await storeWith(20, { [`push:raw:${RIGHT}#${MID}`]: 0 });
    const report = await doors.syncFloorReport!(store, MID);
    expect(report.streams[0]).toMatchObject({ holdsFloor: true, heldBack: 0 });
    expect(doors.pinnedFloor!(report)).toBeNull();
  });

  it("an acknowledgment records its time (last ack is reported)", async () => {
    const store = new InMemoryEventStore();
    for (let i = 1; i <= 3; i++) await store.append(event(i));
    const remote = new InMemoryEventStore();
    const relay = Object.assign(Object.create(remote) as InMemoryEventStore, {
      relayStreamKey: `${RIGHT}#${MID}`,
      append: (e: EventLogEntry) => remote.append(e),
    });
    const engine = new SyncEngine(store, MID);
    engine.connectRemote(relay);
    const before = Date.now();
    await engine.sync();
    const report = await doors.syncFloorReport!(store, MID);
    const s = report.streams.find((x) => x.relayUrl === RIGHT);
    expect(s?.acked).toBe(3);
    expect(s?.lastAckAt).toBeGreaterThanOrEqual(before);
  });
});
