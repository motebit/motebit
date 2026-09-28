/**
 * #914 — the PUSH cursor. A device's own events must reach the relay.
 *
 * Before #914, `SyncEngine.sync()` pushed one batch after its push cursor and
 * then set the cursor to the local max clock read AFTER the pull:
 *   Probe A — an event appended while `sync()` awaited its pull was never
 *             pushed (the cursor jumped over it).
 *   Probe B — with more unpushed events than `batch_size` (a restart: the
 *             cursor was in memory), only the first batch was ever pushed.
 * And the socket door resolved `append` when a frame was SENT (or merely
 * queued), so even a correct cursor would have moved on no acknowledgment.
 *
 * The law: the push cursor moves only as far as the relay ACKNOWLEDGED, is
 * persisted after the acknowledgment (a crash in between re-pushes, never
 * loses), and a backlog drains batch by batch within bounded syncs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { InMemoryEventStore } from "@motebit/event-log";
import type { EventStoreAdapter } from "@motebit/event-log";
import { EventType } from "@motebit/sdk";
import type { EventLogEntry } from "@motebit/sdk";
import {
  SyncEngine,
  HttpEventStoreAdapter,
  WebSocketEventStoreAdapter,
  EncryptedEventStoreAdapter,
  InMemorySyncSeqCursorStore,
  MAX_PUSH_BATCHES_PER_SYNC,
  ackedPushCursor,
  pushCursorKey,
} from "../index.js";
import type { SyncSeqCursorStore } from "../index.js";
import { FakeRelay } from "./fake-relay.js";

const MID = "motebit-zz914";
const KEY = new Uint8Array(32).fill(9);

function entry(id: string, clock: number, timestamp = 1_700_000_000_000 + clock): EventLogEntry {
  return {
    event_id: id,
    motebit_id: MID as EventLogEntry["motebit_id"],
    timestamp,
    event_type: EventType.StateUpdated,
    payload: { id },
    version_clock: clock,
    tombstoned: false,
  };
}

/** Append as the runtime does: the store assigns the next clock. */
async function write(store: InMemoryEventStore, id: string): Promise<void> {
  await store.appendWithClock({
    event_id: id,
    motebit_id: MID as EventLogEntry["motebit_id"],
    timestamp: Date.now(),
    event_type: EventType.StateUpdated,
    payload: { id },
    tombstoned: false,
  });
}

function http(relay: FakeRelay): HttpEventStoreAdapter {
  return new HttpEventStoreAdapter({ baseUrl: relay.baseUrl, motebitId: MID, maxRetries: 0 });
}

const sorted = (xs: string[]): string[] => [...xs].sort();

// ---------------------------------------------------------------------------
// The engine over the HTTP door (the CLI, the daemon, mobile's syncNow)
// ---------------------------------------------------------------------------

describe("#914 SyncEngine push cursor — HTTP door", () => {
  let relay: FakeRelay;
  beforeEach(() => {
    relay = new FakeRelay();
    vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) => relay.fetch(input, init));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("Probe A: an event appended while sync() awaits its pull is pushed", async () => {
    const local = new InMemoryEventStore();
    const engine = new SyncEngine(local, MID);
    engine.connectRemote(http(relay));
    await write(local, "before");

    let armed = true;
    const inner = relay.fetch;
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      if (armed && String(input).includes("/pull")) {
        armed = false;
        await write(local, "during"); // the runtime writes while the pull is on the wire
      }
      return inner(input, init);
    });

    for (let i = 0; i < 3; i++) {
      await engine.sync();
      expect(engine.getStatus()).toBe("idle");
    }
    expect(sorted(relay.heldIds(MID))).toEqual(["before", "during"]);
  });

  it("Probe B: after a restart, a backlog larger than batch_size is pushed whole", async () => {
    const local = new InMemoryEventStore();
    for (let i = 0; i < 5; i++) await write(local, `x${i}`);
    // A fresh process: a new engine, and no cursor anywhere yet.
    const engine = new SyncEngine(local, MID, { batch_size: 2 });
    engine.connectRemote(http(relay));
    const r = await engine.sync();
    expect(r.pushed).toBe(5);
    expect(sorted(relay.heldIds(MID))).toEqual(["x0", "x1", "x2", "x3", "x4"]);
    expect(engine.getCursor().last_version_clock).toBe(5);
  });

  it("a backlog beyond MAX_PUSH_BATCHES_PER_SYNC drains over bounded syncs, from the persisted cursor", async () => {
    const local = new InMemoryEventStore();
    const total = MAX_PUSH_BATCHES_PER_SYNC + 7;
    for (let i = 0; i < total; i++) await write(local, `b${i}`);
    const cursors = new InMemorySyncSeqCursorStore();
    const engine = new SyncEngine(local, MID, { batch_size: 1, seqCursorStore: cursors });
    engine.connectRemote(http(relay));

    const first = await engine.sync();
    expect(first.pushed).toBe(MAX_PUSH_BATCHES_PER_SYNC);
    expect(relay.heldIds(MID)).toHaveLength(MAX_PUSH_BATCHES_PER_SYNC);
    // The cursor is persisted, so a restart continues where this stopped.
    const restarted = new SyncEngine(local, MID, { batch_size: 1, seqCursorStore: cursors });
    restarted.connectRemote(http(relay));
    const second = await restarted.sync();
    expect(second.pushed).toBe(7);
    expect(relay.heldIds(MID)).toHaveLength(total);
    expect(relay.pushedIds).toHaveLength(total); // nothing acknowledged was sent twice
  });

  it("restart mid-backlog: a push that fails part-way keeps what was acknowledged, and resumes after it", async () => {
    const local = new InMemoryEventStore();
    for (let i = 0; i < 6; i++) await write(local, `m${i}`);
    const cursors = new InMemorySyncSeqCursorStore();

    let accepted = 0;
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      if (String(input).includes("/push")) {
        if (accepted >= 3) return new Response("down", { status: 503 });
        accepted++;
      }
      return relay.fetch(input, init);
    });
    const engine = new SyncEngine(local, MID, { batch_size: 2, seqCursorStore: cursors });
    engine.connectRemote(http(relay));
    await engine.sync();
    expect(engine.getStatus()).toBe("error");
    // m0,m1 (batch 1) acknowledged; m2 acknowledged, m3 refused: the cursor is at m2.
    expect(engine.getCursor().last_version_clock).toBe(3);
    expect(await cursors.getSyncSeqCursor(pushCursorKey(http(relay), MID))).toBe(3);

    // The process dies; the relay recovers; a new process resumes from the cursor.
    vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) => relay.fetch(input, init));
    const restarted = new SyncEngine(local, MID, { batch_size: 2, seqCursorStore: cursors });
    restarted.connectRemote(http(relay));
    const r = await restarted.sync();
    expect(restarted.getStatus()).toBe("idle");
    expect(r.pushed).toBe(3);
    expect(sorted(relay.heldIds(MID))).toEqual(["m0", "m1", "m2", "m3", "m4", "m5"]);
  });

  it("crash between the acknowledgment and the cursor write: the next process re-pushes, the relay stores each event once", async () => {
    const local = new InMemoryEventStore();
    for (let i = 0; i < 3; i++) await write(local, `c${i}`);
    const durable = new InMemorySyncSeqCursorStore();
    let crash = true;
    const crashing: SyncSeqCursorStore = {
      getSyncSeqCursor: (k) => durable.getSyncSeqCursor(k),
      setSyncSeqCursor: (k, v) => {
        if (crash && k.startsWith("push:")) return Promise.reject(new Error("process died"));
        return durable.setSyncSeqCursor(k, v);
      },
    };
    const engine = new SyncEngine(local, MID, { seqCursorStore: crashing });
    engine.connectRemote(http(relay));
    await engine.sync();
    expect(engine.getStatus()).toBe("error");
    expect(relay.heldIds(MID)).toHaveLength(3); // the relay acknowledged them…
    expect(await durable.getSyncSeqCursor(pushCursorKey(http(relay), MID))).toBeNull(); // …the cursor never landed

    crash = false;
    const restarted = new SyncEngine(local, MID, { seqCursorStore: crashing });
    restarted.connectRemote(http(relay));
    const r = await restarted.sync();
    expect(r.pushed).toBe(3); // re-pushed: never lost
    expect(sorted(relay.heldIds(MID))).toEqual(["c0", "c1", "c2"]); // stored once each
    expect(await durable.getSyncSeqCursor(pushCursorKey(http(relay), MID))).toBe(3);
  });

  it("events pulled from the relay are never pushed back to it", async () => {
    const local = new InMemoryEventStore();
    const engine = new SyncEngine(local, MID);
    engine.connectRemote(http(relay));
    relay.ingest(entry("sibling-1", 7));
    relay.ingest(entry("sibling-2", 8));
    await engine.sync(); // pulls both
    await write(local, "mine"); // clock 9
    await engine.sync();
    await engine.sync();
    expect(relay.pushedIds).toEqual(["mine"]);
    expect(engine.getCursor().last_version_clock).toBe(9);
  });

  it("a sync called while one runs joins it — one push, never two racing cursors", async () => {
    const local = new InMemoryEventStore();
    await write(local, "once");
    const engine = new SyncEngine(local, MID);
    engine.connectRemote(http(relay));
    const [a, b] = await Promise.all([engine.sync(), engine.sync()]);
    expect(a).toBe(b);
    expect(relay.pushedIds).toEqual(["once"]);
  });

  it("the push cursor is kept apart from the pull cursor, per relay stream", () => {
    const k = pushCursorKey(http(relay), MID);
    expect(k.startsWith("push:")).toBe(true);
    expect(k).not.toBe(http(relay).seqCursorKey);
    expect(pushCursorKey(new InMemoryEventStore(), MID)).toBe(`push:#${MID}`);
  });

  it("an unordered local store (IndexedDB returns by timestamp) never lets the cursor pass an unpushed event", async () => {
    // Own event at clock 5 written at t=1000; a sibling's event pulled at
    // clock 9 but stamped t=500 by a slow wall clock. In timestamp order the
    // sibling comes first, so a `limit`-bounded read of one event would see
    // only it and move the cursor to 9 — over the own event, forever.
    const inner = new InMemoryEventStore();
    await inner.append(entry("own-5", 5, 1000));
    await inner.append(entry("sib-9", 9, 500));
    const byTimestamp: EventStoreAdapter = {
      append: (e) => inner.append(e),
      appendWithClock: (e) => inner.appendWithClock(e),
      getLatestClock: (m) => inner.getLatestClock(m),
      tombstone: (id, m) => inner.tombstone(id, m),
      query: async (f) => {
        const all = await inner.query({ ...f, limit: undefined });
        all.sort((a, b) => a.timestamp - b.timestamp);
        return f.limit !== undefined ? all.slice(0, f.limit) : all;
      },
    };
    const engine = new SyncEngine(byTimestamp, MID, { batch_size: 1 });
    engine.connectRemote(http(relay));
    await engine.sync();
    await engine.sync();
    expect(sorted(relay.heldIds(MID))).toEqual(["own-5", "sib-9"]);
  });
});

// ---------------------------------------------------------------------------
// The cursor arithmetic
// ---------------------------------------------------------------------------

describe("#914 ackedPushCursor", () => {
  const evs = [entry("a", 1), entry("b", 2), entry("c", 2), entry("d", 3)];
  it("moves over whole acknowledged clock groups only", () => {
    expect(ackedPushCursor(0, evs, new Set(["a", "b", "c", "d"]))).toBe(3);
    expect(ackedPushCursor(0, evs, new Set(["a", "b"]))).toBe(1); // c (clock 2) unacknowledged
    expect(ackedPushCursor(0, evs, new Set(["b", "c", "d"]))).toBe(0); // a unacknowledged
    expect(ackedPushCursor(0, evs, new Set(["a", "b", "c"]))).toBe(2);
  });
  it("never moves below where it was", () => {
    expect(ackedPushCursor(7, [], new Set())).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// The socket door (desktop, web, spatial, mobile): append = acknowledged
// ---------------------------------------------------------------------------

class MockSocket {
  static instances: MockSocket[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(public url: string) {
    MockSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
  open(): void {
    this.onopen?.();
  }
  frames(): string[][] {
    return this.sent
      .map((s) => JSON.parse(s) as { type: string; events?: EventLogEntry[] })
      .filter((f) => f.type === "push")
      .map((f) => (f.events ?? []).map((e) => e.event_id));
  }
  answer(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

const lastSocket = (): MockSocket => MockSocket.instances[MockSocket.instances.length - 1]!;

describe("#914 WebSocketEventStoreAdapter — an append resolves on the relay's ack", () => {
  let original: typeof globalThis.WebSocket;
  beforeEach(() => {
    vi.useFakeTimers();
    MockSocket.instances = [];
    original = globalThis.WebSocket;
    globalThis.WebSocket = MockSocket as unknown as typeof WebSocket;
  });
  afterEach(() => {
    globalThis.WebSocket = original;
    vi.useRealTimers();
  });

  function adapter(): WebSocketEventStoreAdapter {
    const a = new WebSocketEventStoreAdapter({
      url: "ws://r/ws/sync/m",
      motebitId: MID,
      pushAckTimeoutMs: 1_000,
      reconnectBaseMs: 10,
    });
    a.connect();
    lastSocket().open();
    return a;
  }

  function track(p: Promise<void>): { state: "pending" | "ok" | "err" } {
    const t = { state: "pending" as "pending" | "ok" | "err" };
    p.then(
      () => (t.state = "ok"),
      () => (t.state = "err"),
    );
    return t;
  }

  it("one frame in flight; what is appended meanwhile goes out in the next frame, after the ack", async () => {
    const a = adapter();
    const s = lastSocket();
    const p1 = track(a.append(entry("e1", 1)));
    const p2 = track(a.append(entry("e2", 2)));
    const p3 = track(a.append(entry("e3", 3)));
    expect(s.frames()).toEqual([["e1"]]);
    await vi.advanceTimersByTimeAsync(0);
    expect([p1.state, p2.state, p3.state]).toEqual(["pending", "pending", "pending"]);

    s.answer({ type: "ack", accepted: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(p1.state).toBe("ok");
    expect(s.frames()).toEqual([["e1"], ["e2", "e3"]]);
    expect(p2.state).toBe("pending");

    s.answer({ type: "ack", accepted: 2 });
    await vi.advanceTimersByTimeAsync(0);
    expect([p2.state, p3.state]).toEqual(["ok", "ok"]);
  });

  it("the socket closing before the ack rejects the frame; queued events go out on the next connection", async () => {
    const a = adapter();
    const s = lastSocket();
    const p1 = track(a.append(entry("e1", 1)));
    const p2 = track(a.append(entry("e2", 2)));
    s.drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(p1.state).toBe("err");
    expect(p2.state).toBe("pending");

    await vi.advanceTimersByTimeAsync(20); // reconnect backoff
    const s2 = lastSocket();
    expect(s2).not.toBe(s);
    s2.open();
    expect(s2.frames()).toEqual([["e2"]]);
    s2.answer({ type: "ack", accepted: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(p2.state).toBe("ok");
  });

  it("no ack in time: the frame is rejected and its socket taken down, so a late ack is never credited to the next frame", async () => {
    const a = adapter();
    const s = lastSocket();
    const p1 = track(a.append(entry("e1", 1)));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(p1.state).toBe("err");
    expect(s.closed).toBe(true);

    await vi.advanceTimersByTimeAsync(20);
    const s2 = lastSocket();
    s2.open();
    const p2 = track(a.append(entry("e2", 2)));
    expect(s2.frames()).toEqual([["e2"]]);
    s.answer({ type: "ack", accepted: 1 }); // the late ack, on the dead socket
    await vi.advanceTimersByTimeAsync(0);
    expect(p2.state).toBe("pending");
    s2.answer({ type: "ack", accepted: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(p2.state).toBe("ok");
  });

  it("a push refusal rejects the frame; a rate-limit error does not stand in for an ack", async () => {
    const a = adapter();
    const s = lastSocket();
    const p1 = track(a.append(entry("e1", 1)));
    s.answer({ type: "error", message: "Rate limit exceeded" });
    await vi.advanceTimersByTimeAsync(0);
    expect(p1.state).toBe("pending");
    s.answer({ type: "error", message: "push refused: every entry's motebit_id must be …" });
    await vi.advanceTimersByTimeAsync(0);
    expect(p1.state).toBe("err");
  });

  it("offline: the append rejects at its deadline, the event stays queued once, and goes out on connect", async () => {
    const a = new WebSocketEventStoreAdapter({
      url: "ws://r/ws/sync/m",
      motebitId: MID,
      pushAckTimeoutMs: 1_000,
    });
    const p1 = track(a.append(entry("q", 1)));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(p1.state).toBe("err"); // unknown whether the relay has it: the caller retries
    // A sync engine re-pushing through the outage joins the queued event.
    const p2 = track(a.append(entry("q", 1)));
    a.connect();
    const s = lastSocket();
    s.open();
    expect(s.frames()).toEqual([["q"]]);
    s.answer({ type: "ack", accepted: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(p2.state).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// The engine over the encrypted socket door, exactly as the surfaces wire it
// ---------------------------------------------------------------------------

describe("#914 SyncEngine over EncryptedEventStoreAdapter(socket)", () => {
  let original: typeof globalThis.WebSocket;
  beforeEach(() => {
    MockSocket.instances = [];
    original = globalThis.WebSocket;
    globalThis.WebSocket = MockSocket as unknown as typeof WebSocket;
  });
  afterEach(() => {
    globalThis.WebSocket = original;
  });

  async function until(pred: () => boolean, what: string): Promise<void> {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > 3_000) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 2));
    }
  }

  it("the cursor stays put until the relay acks, and a dropped frame is re-pushed by the next sync", async () => {
    const local = new InMemoryEventStore();
    await write(local, "s1");
    await write(local, "s2");
    const ws = new WebSocketEventStoreAdapter({
      url: "ws://r/ws/sync/m",
      motebitId: MID,
      payloads: "e2e",
      pushAckTimeoutMs: 2_000,
      reconnectBaseMs: 5,
    });
    // The surfaces' indirection: a plain object over the current socket adapter.
    const live: EventStoreAdapter = {
      append: (e) => ws.append(e),
      query: (f) => ws.query(f),
      getLatestClock: (id) => ws.getLatestClock(id),
      tombstone: (id, m) => ws.tombstone(id, m),
    };
    const engine = new SyncEngine(local, MID);
    engine.connectRemote(new EncryptedEventStoreAdapter({ inner: live, key: KEY }));
    ws.connect();
    lastSocket().open();

    // Sync 1: the frame goes out; the socket drops before the relay acks.
    const first = engine.sync();
    await until(() => lastSocket().frames().length > 0, "the first frame");
    expect(engine.getCursor().last_version_clock).toBe(0);
    lastSocket().drop();
    await first;
    expect(engine.getStatus()).toBe("error");
    expect(engine.getCursor().last_version_clock).toBe(0); // sent is not acknowledged

    // Reconnected: sync 2 re-pushes, and the relay's ack moves the cursor.
    await until(() => MockSocket.instances.length === 2, "the reconnect");
    lastSocket().open();
    const second = engine.sync();
    await until(() => lastSocket().frames().length === 1, "the re-push");
    expect(engine.getCursor().last_version_clock).toBe(0);
    // The relay acks each frame as it arrives (one in flight at a time).
    let acked = 0;
    let settled = false;
    void second.then(() => (settled = true));
    while (!settled) {
      if (lastSocket().frames().length > acked) {
        acked++;
        lastSocket().answer({ type: "ack", accepted: 1 });
      }
      await new Promise((r) => setTimeout(r, 2));
    }
    // s2 stayed queued through the drop and went out on reconnect; the re-push
    // may send it again — a duplicate the relay stores once (by event_id).
    expect([...new Set(lastSocket().frames().flat())].sort()).toEqual(["s1", "s2"]);
    expect(engine.getStatus()).toBe("idle");
    expect(engine.getCursor().last_version_clock).toBe(2);
    // Every pushed payload was an envelope (#928 still holds on the re-push).
    const pushed = MockSocket.instances.flatMap((s) =>
      s.sent
        .map((x) => JSON.parse(x) as { type: string; events?: EventLogEntry[] })
        .filter((f) => f.type === "push")
        .flatMap((f) => f.events ?? []),
    );
    expect(pushed.every((e) => (e.payload as { _encrypted?: unknown })._encrypted === true)).toBe(
      true,
    );
    ws.disconnect();
  });
});
