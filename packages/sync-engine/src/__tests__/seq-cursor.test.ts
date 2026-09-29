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
  SKIPPED_SYNC_EVENTS_KEPT,
} from "../index.js";
import type { SeqPullSource } from "../index.js";
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
    if (res.kind !== "seq") throw new Error("expected a seq page");
    expect(res.entries[0]!.seq).toBe(1);
    expect("seq" in res.entries[0]!.event).toBe(false);
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

  it("dedups by event_id lookup when the store offers one — never by reading the local log", async () => {
    for (let i = 1; i <= 3; i++) relay.ingest(entry(`e${i}`, i));
    const local = new CursorStore();
    await local.append(entry("e2", 2));
    const lookups: string[][] = [];
    const store: EventStoreAdapter & {
      getHeldEventIds(ids: readonly string[]): Promise<Set<string>>;
    } = {
      append: (e) => local.append(e),
      query: () => Promise.reject(new Error("the pull must not scan the local log")),
      getLatestClock: (m) => local.getLatestClock(m),
      tombstone: (i, m) => local.tombstone(i, m),
      getHeldEventIds: (ids) => {
        lookups.push([...ids]);
        return Promise.resolve(new Set(ids.filter((id) => id === "e2")));
      },
    };
    const out = await pullBySeq({
      source: http,
      localStore: store,
      cursorStore: new InMemorySyncSeqCursorStore(),
      motebitId: MID,
      fallbackAfterClock: 0,
    });
    expect(out.fresh.map((e) => e.event_id)).toEqual(["e1", "e3"]);
    expect(lookups).toEqual([["e1", "e2", "e3"]]);
  });

  it("never applies an event of another identity, whatever the relay returns", async () => {
    relay.ingest(entry("mine", 1));
    const foreign = entry("theirs", 2, "someone-else");
    const source = {
      seqCursorKey: "k",
      pullAfterSeq: async () => ({
        kind: "seq" as const,
        entries: [
          { seq: 1, event: entry("mine", 1) },
          { seq: 2, event: foreign },
        ],
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
      // The pull cursor, beside the push stream's enrollment (#962: a push
      // cursor at 0 until the relay acknowledges — compaction's floor).
      expect([...local.cursors.entries()]).toEqual([
        [`push:${http.seqCursorKey}`, 0],
        [http.seqCursorKey, 1],
      ]);
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
      expect(http.seqCursorKey).toBe(`raw:${relay.baseUrl}#${MID}`);
      expect(other.seqCursorKey).toBe(`raw:http://other.relay#${MID}`);
    });
  });

  describe("the E2E path", () => {
    const k1 = new Uint8Array(32).fill(7);
    const k2 = new Uint8Array(32).fill(9);

    it("the encrypting wrapper is a seq source exactly when its inner adapter is, keyed apart from the raw path", () => {
      const enc = new EncryptedEventStoreAdapter({ inner: http, key: k1 });
      expect(isSeqPullSource(enc)).toBe(true);
      expect(enc.seqCursorKey).toBe(`e2e:${http.seqCursorKey}`);
      expect(
        isSeqPullSource(
          new EncryptedEventStoreAdapter({ inner: new InMemoryEventStore(), key: k1 }),
        ),
      ).toBe(false);
    });

    it("one undecryptable event is recorded and passed; the stream continues past it", async () => {
      await new EncryptedEventStoreAdapter({ inner: http, key: k1 }).append(entry("before", 1));
      await new EncryptedEventStoreAdapter({ inner: http, key: k2 }).append(entry("poison", 2));
      await new EncryptedEventStoreAdapter({ inner: http, key: k1 }).append(entry("after", 3));
      const enc = new EncryptedEventStoreAdapter({ inner: http, key: k1 });
      const local = new CursorStore();
      const cursors = new InMemorySyncSeqCursorStore();
      const reported: string[] = [];
      const out = await pullBySeq({
        source: enc as SeqPullSource,
        localStore: local,
        cursorStore: cursors,
        motebitId: MID,
        fallbackAfterClock: 0,
        onSkipped: (s) => reported.push(s.event_id),
      });
      expect(out.fresh.map((e) => e.event_id)).toEqual(["before", "after"]);
      expect((await local.query({})).find((e) => e.event_id === "after")!.payload).toEqual({
        id: "after",
      });
      expect(cursors.skipped.map((s) => [s.event_id, s.seq, s.reason])).toEqual([
        ["poison", 2, "undecryptable"],
      ]);
      expect(reported).toEqual(["poison"]);
      expect(await cursors.getSyncSeqCursor(enc.seqCursorKey!)).toBe(3);
    });

    it("an event already held is never decrypted again — dedup runs on the transport form first", async () => {
      await new EncryptedEventStoreAdapter({ inner: http, key: k1 }).append(entry("old", 1));
      const local = new CursorStore();
      await local.append(entry("old", 1)); // held, decrypted, before the key rotated
      // Rotated: this device now holds only k2, which cannot open "old".
      const enc = new EncryptedEventStoreAdapter({ inner: http, key: k2 });
      const decode = vi.spyOn(enc, "decodeEvent");
      const cursors = new InMemorySyncSeqCursorStore();
      const out = await pullBySeq({
        source: enc as SeqPullSource,
        localStore: local,
        cursorStore: cursors,
        motebitId: MID,
        fallbackAfterClock: 0,
      });
      expect(decode).not.toHaveBeenCalled();
      expect(out.skipped).toEqual([]);
    });

    it("a raw path records no row for an E2E payload — it counts it", async () => {
      for (let i = 1; i <= 3; i++) {
        await new EncryptedEventStoreAdapter({ inner: http, key: k1 }).append(entry(`s${i}`, i));
      }
      const cursors = new InMemorySyncSeqCursorStore();
      const record = vi.spyOn(cursors, "recordSkippedSyncEvent");
      const onSkipped = vi.fn();
      const out = await pullBySeq({
        source: http,
        localStore: new CursorStore(),
        cursorStore: cursors,
        motebitId: MID,
        fallbackAfterClock: 0,
        onSkipped,
      });
      expect(out.encryptedOnRawPath).toBe(3);
      expect(record).not.toHaveBeenCalled();
      expect(onSkipped).not.toHaveBeenCalled();
      expect(await cursors.getSyncSeqCursor(http.seqCursorKey)).toBe(3);
    });

    it(`the undecryptable record is bounded: N+5 skips leave the newest N rows and a total of N+5 (in-memory store)`, async () => {
      const store = new InMemorySyncSeqCursorStore();
      const N = SKIPPED_SYNC_EVENTS_KEPT;
      for (let i = 1; i <= N + 5; i++) {
        await store.recordSkippedSyncEvent("k", {
          event_id: `x${i}`,
          seq: i,
          reason: "undecryptable",
        });
      }
      const rows = store.skipped.filter((s) => s.key === "k");
      expect(rows).toHaveLength(N);
      expect(rows[0]!.event_id).toBe("x6");
      expect(await store.countSkippedSyncEvents("k")).toBe(N + 5);
    });

    it("the raw path never applies an E2E payload, and never advances the E2E cursor: the E2E path then applies it decrypted (rawThenEnc)", async () => {
      await new EncryptedEventStoreAdapter({ inner: http, key: k1 }).append(entry("sib", 1));
      const local = new CursorStore();
      // The raw path first (mobile syncNow / the CLI daemon's HTTP fallback)…
      const raw = await pullBySeq({
        source: http,
        localStore: local,
        cursorStore: local,
        motebitId: MID,
        fallbackAfterClock: 0,
      });
      expect(raw.fresh).toEqual([]);
      // Counted, never recorded per event: expected on a raw path, not an error.
      expect(raw.skipped).toEqual([]);
      expect(raw.encryptedOnRawPath).toBe(1);
      expect(await local.query({})).toEqual([]);
      // …then the E2E engine over the SAME store.
      const enc = new EncryptedEventStoreAdapter({ inner: http, key: k1 });
      const e2e = await pullBySeq({
        source: enc as SeqPullSource,
        localStore: local,
        cursorStore: local,
        motebitId: MID,
        fallbackAfterClock: 0,
      });
      expect(e2e.fresh.map((e) => e.event_id)).toEqual(["sib"]);
      const [held] = await local.query({});
      expect(held!.payload).toEqual({ id: "sib" });
      expect(local.cursors.get(http.seqCursorKey)).toBe(1);
      expect(local.cursors.get(enc.seqCursorKey!)).toBe(1);
    });
  });
});
