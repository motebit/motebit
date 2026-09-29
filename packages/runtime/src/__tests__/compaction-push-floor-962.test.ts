/**
 * #962 — compaction never deletes an event the relay has not acknowledged,
 * on any surface store, by any trigger.
 *
 * `runtime.stop()` compacts (`autoCompact`) BEFORE the CLI's sync-on-exit,
 * and compaction used to delete every event below the latest clock without
 * reading the push cursor (#914). An event appended but not yet pushed was
 * deleted before it reached the relay — and so never reached the owner's
 * other devices.
 *
 * Matrix: trigger (`stop()`, `compact()`) × local store (in-memory, SQLite,
 * IndexedDB) × push state (never pushed, pushed-not-acked, partly acked,
 * all acked) × relay (none, one, two streams, a separate engine on the same
 * store, a later process, an unreadable cursor).
 *
 * Invariant: after compaction every event above the acked push cursor is
 * still present, and a later sync delivers it to the relay exactly once.
 */
import "fake-indexeddb/auto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventType } from "@motebit/sdk";
import type { EventFilter, EventLogEntry, EventStoreAdapter } from "@motebit/sdk";
import { InMemoryEventStore } from "@motebit/event-log";
import { SyncEngine } from "@motebit/sync-engine";
import { createMotebitDatabase } from "@motebit/persistence";
import { IdbEventStore, openMotebitDB } from "@motebit/browser-persistence";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index";

const MID = "mote-962";

/** A relay: stores each event once (dedup by event_id), counts every push. */
class FakeRelay implements EventStoreAdapter {
  held = new Map<string, EventLogEntry>();
  received: string[] = [];
  mode: "ack" | "reject" = "ack";
  constructor(readonly relayStreamKey?: string) {}
  append(e: EventLogEntry): Promise<void> {
    this.received.push(e.event_id);
    if (this.mode === "reject") return Promise.reject(new Error("relay unreachable"));
    if (!this.held.has(e.event_id)) this.held.set(e.event_id, { ...e });
    return Promise.resolve();
  }
  query(filter: EventFilter): Promise<EventLogEntry[]> {
    const after = filter.after_version_clock ?? 0;
    return Promise.resolve(
      [...this.held.values()].filter(
        (e) => e.motebit_id === filter.motebit_id && e.version_clock > after,
      ),
    );
  }
  getLatestClock(): Promise<number> {
    return Promise.resolve(Math.max(0, ...[...this.held.values()].map((e) => e.version_clock)));
  }
  tombstone(): Promise<void> {
    return Promise.resolve();
  }
  /** How many times `id` was pushed. */
  times(id: string): number {
    return this.received.filter((r) => r === id).length;
  }
}

type Kind = "memory" | "sqlite" | "idb";

/** A surface's local event store, and a way to open the same store again (a later process). */
async function openStore(kind: Kind): Promise<{
  store: EventStoreAdapter;
  reopen: () => Promise<EventStoreAdapter>;
}> {
  if (kind === "memory") {
    const store = new InMemoryEventStore();
    return { store, reopen: () => Promise.resolve(store) };
  }
  if (kind === "sqlite") {
    const path = join(mkdtempSync(join(tmpdir(), "motebit-962-")), "motebit.db");
    const db = createMotebitDatabase(path);
    return {
      store: db.eventStore,
      reopen: () => Promise.resolve(createMotebitDatabase(path).eventStore),
    };
  }
  const name = `motebit-962-${crypto.randomUUID()}`;
  const store = new IdbEventStore(await openMotebitDB(name));
  return { store, reopen: async () => new IdbEventStore(await openMotebitDB(name)) };
}

const live: MotebitRuntime[] = [];
const engines: SyncEngine[] = [];
afterEach(() => {
  for (const rt of live.splice(0)) {
    rt.sync.stop();
    rt.stop();
  }
  for (const e of engines.splice(0)) e.stop();
});

function runtimeOver(store: EventStoreAdapter): MotebitRuntime {
  const storage = { ...createInMemoryStorage(), eventStore: store };
  const rt = new MotebitRuntime(
    { motebitId: MID, compactionThreshold: 1, tickRateHz: 0 },
    { storage, renderer: new NullRenderer() },
  );
  rt.start();
  live.push(rt);
  return rt;
}

async function appendN(store: EventStoreAdapter, from: number, to: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = from; i <= to; i++) {
    const id = `e-${i}`;
    await store.append({
      event_id: id,
      motebit_id: MID,
      timestamp: Date.now(),
      event_type: EventType.StateUpdated,
      payload: {},
      version_clock: i,
      tombstoned: false,
    });
    ids.push(id);
  }
  return ids;
}

async function present(store: EventStoreAdapter): Promise<Set<string>> {
  return new Set((await store.query({ motebit_id: MID })).map((e) => e.event_id));
}

/** `stop()` compacts fire-and-forget: let it land. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10));
}

type Trigger = "stop" | "compact";
async function trigger(rt: MotebitRuntime, t: Trigger): Promise<void> {
  if (t === "stop") {
    rt.stop();
    await settle();
  } else {
    await rt.compact();
  }
}

const KINDS: Kind[] = ["memory", "sqlite", "idb"];
const TRIGGERS: Trigger[] = ["stop", "compact"];

describe.each(KINDS)("#962 compaction push floor — %s store", (kind) => {
  describe.each(TRIGGERS)("trigger %s()", (t) => {
    it("no relay configured: compaction proceeds as before", async () => {
      const { store } = await openStore(kind);
      const rt = runtimeOver(store);
      await appendN(store, 1, 5);
      await trigger(rt, t);
      expect((await present(store)).size).toBe(1);
    });

    it("never pushed: an appended event survives compaction and a later sync delivers it once", async () => {
      const { store } = await openStore(kind);
      const rt = runtimeOver(store);
      const relay = new FakeRelay();
      rt.connectSync(relay);
      const ids = await appendN(store, 1, 5);
      await trigger(rt, t);
      expect([...(await present(store))].sort()).toEqual(ids);
      await rt.sync.sync();
      for (const id of ids) {
        expect(relay.held.has(id)).toBe(true);
        expect(relay.times(id)).toBe(1);
      }
    });

    it("pushed but not acknowledged: nothing unacknowledged is compacted", async () => {
      const { store } = await openStore(kind);
      const rt = runtimeOver(store);
      const relay = new FakeRelay();
      relay.mode = "reject";
      rt.connectSync(relay);
      const ids = await appendN(store, 1, 5);
      await rt.sync.sync();
      expect(relay.held.size).toBe(0);
      await trigger(rt, t);
      expect([...(await present(store))].sort()).toEqual(ids);
      relay.mode = "ack";
      await rt.sync.sync();
      for (const id of ids) expect(relay.held.has(id)).toBe(true);
    });

    it("partly acknowledged: compaction stops at the acked push cursor", async () => {
      const { store } = await openStore(kind);
      const rt = runtimeOver(store);
      const relay = new FakeRelay();
      rt.connectSync(relay);
      const acked = await appendN(store, 1, 3);
      await rt.sync.sync();
      const unpushed = await appendN(store, 4, 5);
      await trigger(rt, t);
      const after = await present(store);
      for (const id of unpushed) expect(after.has(id)).toBe(true);
      await rt.sync.sync();
      for (const id of [...acked, ...unpushed]) {
        expect(relay.held.has(id)).toBe(true);
        expect(relay.times(id)).toBe(1);
      }
    });

    it("all acknowledged: compaction proceeds and nothing is pushed twice", async () => {
      const { store } = await openStore(kind);
      const rt = runtimeOver(store);
      const relay = new FakeRelay();
      rt.connectSync(relay);
      const ids = await appendN(store, 1, 5);
      await rt.sync.sync();
      await trigger(rt, t);
      expect((await present(store)).size).toBe(1);
      await rt.sync.sync();
      for (const id of ids) expect(relay.times(id)).toBe(1);
    });

    it("a separate sync engine on the same store (the mobile shape) holds the floor", async () => {
      const { store } = await openStore(kind);
      const rt = runtimeOver(store);
      const relay = new FakeRelay("relay.mobile#mote-962");
      const engine = new SyncEngine(store, MID);
      engines.push(engine);
      engine.connectRemote(relay);
      const ids = await appendN(store, 1, 5);
      await trigger(rt, t);
      expect([...(await present(store))].sort()).toEqual(ids);
      await engine.sync();
      for (const id of ids) expect(relay.times(id)).toBe(1);
    });

    it("two relay streams: the floor is the minimum across them", async () => {
      const { store } = await openStore(kind);
      const rt = runtimeOver(store);
      const a = new FakeRelay("relay.a#mote-962");
      const b = new FakeRelay("relay.b#mote-962");
      rt.connectSync(a);
      const other = new SyncEngine(store, MID);
      engines.push(other);
      other.connectRemote(b);
      const ids = await appendN(store, 1, 5);
      await rt.sync.sync(); // stream a acks everything; stream b nothing
      await trigger(rt, t);
      expect([...(await present(store))].sort()).toEqual(ids);
      await other.sync();
      for (const id of ids) expect(b.times(id)).toBe(1);
    });
  });

  if (kind !== "memory") {
    it("a later process, before it connects sync, keeps what the relay never acknowledged", async () => {
      const { store, reopen } = await openStore(kind);
      const first = runtimeOver(store);
      const relay = new FakeRelay("relay.persist#mote-962");
      first.connectSync(relay);
      const ids = await appendN(store, 1, 5);
      await settle();
      // The first process ends without compacting or syncing (a crash).
      first.sync.stop();
      live.splice(live.indexOf(first), 1);

      const store2 = await reopen();
      const second = runtimeOver(store2);
      await trigger(second, "stop");
      expect([...(await present(store2))].sort()).toEqual(ids);
      second.connectSync(relay);
      await second.sync.sync();
      for (const id of ids) expect(relay.times(id)).toBe(1);
    });
  }
});

describe("#962 compaction push floor — fail closed", () => {
  /** A store whose cursor cannot be read. */
  class UnreadableCursorStore extends InMemoryEventStore {
    getSyncSeqCursor(): Promise<number | null> {
      return Promise.reject(new Error("cursor store unreadable"));
    }
    setSyncSeqCursor(): Promise<void> {
      return Promise.reject(new Error("cursor store unwritable"));
    }
  }

  it.each(TRIGGERS)(
    "sync configured but the cursor unreadable: %s() compacts nothing",
    async (t) => {
      const store = new UnreadableCursorStore();
      const rt = runtimeOver(store);
      rt.connectSync(new FakeRelay());
      const ids = await appendN(store, 1, 5);
      await trigger(rt, t);
      expect([...(await present(store))].sort()).toEqual(ids);
    },
  );
});
