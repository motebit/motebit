/**
 * #868 — the relay-ingest-sequence pull cursor, unit by unit: the fallback to
 * an older relay, the advance-after-apply ordering, paging, a relay whose
 * sequence went backwards, where the cursor lives, and the transport `seq`
 * never reaching a stored entry.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { InMemoryEventStore } from "@motebit/event-log";
import type { EventStoreAdapter } from "@motebit/event-log";
import { EventType } from "@motebit/sdk";
import type { EventLogEntry } from "@motebit/sdk";
import {
  SyncEngine,
  HttpEventStoreAdapter,
  EncryptedEventStoreAdapter,
  InMemorySyncSeqCursorStore,
  isSeqPullSource,
  pullBySeq,
  resolveSeqCursorStore,
} from "../index.js";
import { FakeRelay } from "./fake-relay.js";

const MID = "motebit-seq";

function entry(id: string, clock: number, mid = MID): EventLogEntry {
  return {
    event_id: id,
    motebit_id: mid as EventLogEntry["motebit_id"],
    timestamp: 1_700_000_000_000 + clock,
    event_type: EventType.StateUpdated,
    payload: { id },
    version_clock: clock,
    tombstoned: false,
  };
}

/** An in-memory local store that also persists a cursor, as the SQLite/IDB stores do. */
class CursorStore extends InMemoryEventStore {
  cursors = new Map<string, number>();
  getSyncSeqCursor(key: string): Promise<number | null> {
    return Promise.resolve(this.cursors.get(key) ?? null);
  }
  setSyncSeqCursor(key: string, seq: number): Promise<void> {
    this.cursors.set(key, seq);
    return Promise.resolve();
  }
}

const idsOf = async (s: EventStoreAdapter): Promise<string[]> =>
  (await s.query({ motebit_id: MID as EventLogEntry["motebit_id"] })).map((e) => e.event_id).sort();

describe("#868 seq cursor", () => {
  let relay: FakeRelay;
  let http: HttpEventStoreAdapter;
  beforeEach(() => {
    relay = new FakeRelay();
    vi.stubGlobal("fetch", relay.fetch);
    http = new HttpEventStoreAdapter({ baseUrl: relay.baseUrl, motebitId: MID, maxRetries: 0 });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("one request carries both cursors; the seq is stripped before any entry is stored", async () => {
    relay.ingest(entry("e1", 1));
    const res = await http.pullAfterSeq(0, 7);
    expect(relay.pulls[0]!.searchParams.get("after_seq")).toBe("0");
    expect(relay.pulls[0]!.searchParams.get("after_clock")).toBe("7");
    expect(res.kind).toBe("seq");
    expect("seq" in res.events[0]!).toBe(false);
    const local = new CursorStore();
    await pullBySeq({
      source: http,
      localStore: local,
      cursorStore: local,
      motebitId: MID,
      fallbackAfterClock: 0,
    });
    const [stored] = await local.query({});
    expect(stored && "seq" in stored).toBe(false);
  });

  it("an older relay (no seq in its answer) is read by the clock it was sent; the seq cursor is not advanced", async () => {
    relay.servesSeq = false;
    relay.ingest(entry("e1", 1));
    relay.ingest(entry("e2", 2));
    const local = new CursorStore();
    const out = await pullBySeq({
      source: http,
      localStore: local,
      cursorStore: local,
      motebitId: MID,
      fallbackAfterClock: 1,
    });
    expect(out.mode).toBe("clock");
    expect(out.fresh.map((e) => e.event_id)).toEqual(["e2"]);
    expect(local.cursors.size).toBe(0);
    // …and once the relay is upgraded, the first seq pull (from 0) fills the gap.
    relay.servesSeq = true;
    const up = await pullBySeq({
      source: http,
      localStore: local,
      cursorStore: local,
      motebitId: MID,
      fallbackAfterClock: 2,
    });
    expect(up.mode).toBe("seq");
    expect(up.fresh.map((e) => e.event_id)).toEqual(["e1"]);
  });

  it("the cursor passes a page only after the page is appended: a failed append leaves it where it was", async () => {
    for (let i = 1; i <= 3; i++) relay.ingest(entry(`e${i}`, i));
    const local = new CursorStore();
    let failOn: string | null = "e2";
    const flaky: EventStoreAdapter = {
      append: (e) => (e.event_id === failOn ? Promise.reject(new Error("disk")) : local.append(e)),
      query: (f) => local.query(f),
      getLatestClock: (m) => local.getLatestClock(m),
      tombstone: (i, m) => local.tombstone(i, m),
    };
    await expect(
      pullBySeq({
        source: http,
        localStore: flaky,
        cursorStore: local,
        motebitId: MID,
        fallbackAfterClock: 0,
      }),
    ).rejects.toThrow("disk");
    expect(local.cursors.size).toBe(0);
    failOn = null;
    await pullBySeq({
      source: http,
      localStore: flaky,
      cursorStore: local,
      motebitId: MID,
      fallbackAfterClock: 0,
    });
    expect(await idsOf(local)).toEqual(["e1", "e2", "e3"]);
    expect([...local.cursors.values()]).toEqual([3]);
  });

  it("pages until has_more is false, and stops at maxPages (the next pull resumes from the saved cursor)", async () => {
    relay.pageMax = 2;
    for (let i = 1; i <= 5; i++) relay.ingest(entry(`e${i}`, i));
    const local = new CursorStore();
    const bounded = await pullBySeq({
      source: http,
      localStore: local,
      cursorStore: local,
      motebitId: MID,
      fallbackAfterClock: 0,
      maxPages: 2,
    });
    expect(bounded.fresh).toHaveLength(4);
    const rest = await pullBySeq({
      source: http,
      localStore: local,
      cursorStore: local,
      motebitId: MID,
      fallbackAfterClock: 0,
    });
    expect(rest.fresh.map((e) => e.event_id)).toEqual(["e5"]);
    expect(relay.pulls.length).toBe(3);
  });

  it("a relay whose sequence went backwards (restored database) is re-read from 0, deduped", async () => {
    for (let i = 1; i <= 4; i++) relay.ingest(entry(`e${i}`, i));
    const local = new CursorStore();
    await pullBySeq({
      source: http,
      localStore: local,
      cursorStore: local,
      motebitId: MID,
      fallbackAfterClock: 0,
    });
    expect([...local.cursors.values()]).toEqual([4]);
    relay.rewindTo(1); // holds e1 only; its next seq is 2
    relay.ingest(entry("after-restore", 9)); // seq 2 < this device's cursor 4
    const out = await pullBySeq({
      source: http,
      localStore: local,
      cursorStore: local,
      motebitId: MID,
      fallbackAfterClock: 4,
    });
    expect(out.fresh.map((e) => e.event_id)).toEqual(["after-restore"]);
    expect([...local.cursors.values()]).toEqual([2]);
  });

  it("never applies an event of another identity, whatever the relay returns", async () => {
    relay.ingest(entry("mine", 1));
    const foreign = entry("theirs", 2, "someone-else");
    const source = {
      seqCursorKey: "k",
      pullAfterSeq: async () => ({
        kind: "seq" as const,
        events: [entry("mine", 1), foreign],
        nextSeq: 2,
        hasMore: false,
        latestSeq: 2,
      }),
    };
    const local = new CursorStore();
    const out = await pullBySeq({
      source,
      localStore: local,
      cursorStore: local,
      motebitId: MID,
      fallbackAfterClock: 0,
    });
    expect(out.fresh.map((e) => e.event_id)).toEqual(["mine"]);
    expect((await local.query({})).map((e) => e.event_id)).toEqual(["mine"]);
  });

  describe("where the cursor lives", () => {
    it("in the local store when it persists cursors — a new engine (new process) resumes from it", async () => {
      relay.ingest(entry("e1", 1));
      const local = new CursorStore();
      const first = new SyncEngine(local, MID);
      first.connectRemote(http);
      await first.sync();
      expect([...local.cursors.entries()]).toEqual([[http.seqCursorKey, 1]]);
      relay.ingest(entry("e2", 1)); // same clock
      const second = new SyncEngine(local, MID);
      second.connectRemote(http);
      const r = await second.sync();
      expect(r.pulled).toBe(1);
      expect(relay.pulls[relay.pulls.length - 1]!.searchParams.get("after_seq")).toBe("1");
    });

    it("otherwise in process memory keyed by the store OBJECT: shared by adapters over one store, never across stores", async () => {
      const a = new InMemoryEventStore();
      const b = new InMemoryEventStore();
      expect(resolveSeqCursorStore(a)).toBe(resolveSeqCursorStore(a));
      expect(resolveSeqCursorStore(a)).not.toBe(resolveSeqCursorStore(b));
      const explicit = new InMemorySyncSeqCursorStore();
      expect(resolveSeqCursorStore(a, explicit)).toBe(explicit);
      const persisting = new CursorStore();
      expect(resolveSeqCursorStore(persisting)).toBe(persisting);
    });

    it("the key names the relay and the identity, so one relay's cursor never applies to another", () => {
      const other = new HttpEventStoreAdapter({ baseUrl: "http://other.relay/", motebitId: MID });
      expect(http.seqCursorKey).toBe(`${relay.baseUrl}#${MID}`);
      expect(other.seqCursorKey).toBe(`http://other.relay#${MID}`);
    });
  });

  it("the encrypting wrapper is a seq source exactly when its inner adapter is, and decrypts what it pulls", async () => {
    const key = new Uint8Array(32).fill(7);
    const enc = new EncryptedEventStoreAdapter({ inner: http, key });
    expect(isSeqPullSource(enc)).toBe(true);
    expect(
      isSeqPullSource(new EncryptedEventStoreAdapter({ inner: new InMemoryEventStore(), key })),
    ).toBe(false);
    await enc.append(entry("secret", 1));
    const res = await enc.pullAfterSeq(0, 0);
    expect(res.events[0]!.payload).toEqual({ id: "secret" });
  });
});
