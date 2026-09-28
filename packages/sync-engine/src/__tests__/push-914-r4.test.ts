/**
 * #914 round 4.
 *
 *   1. React Native's fetch (whatwg-fetch) gives a Response with no `body`
 *      stream. The bounded fetch must still read the body (whole), or mobile
 *      pulls and reads the clock as empty — never pulling again.
 *   2. A slow link where a full push frame cannot cross within the ack
 *      deadline converges: the frame is re-sent in halves, down to one event.
 *   3. Laws that had no test going red when broken: the linger coalesces
 *      appends spread over time; a frame is not flushed mid-linger by an ack;
 *      the pull page size grows back after a good page; the stall watchdog is
 *      on by default.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import { InMemoryEventStore } from "@motebit/event-log";
import type { EventStoreAdapter } from "@motebit/event-log";
import { EventType } from "@motebit/sdk";
import type { EventLogEntry } from "@motebit/sdk";
import { SyncEngine, HttpEventStoreAdapter, WebSocketEventStoreAdapter } from "../index.js";
import { FakeRelay } from "./fake-relay.js";

const MID = "motebit-zz914-r4";

function entry(id: string, clock: number): EventLogEntry {
  return {
    event_id: id,
    motebit_id: MID as EventLogEntry["motebit_id"],
    timestamp: 1_700_000_000_000 + clock,
    event_type: EventType.StateUpdated,
    payload: { id },
    version_clock: clock,
    tombstoned: false,
  };
}

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

// ---------------------------------------------------------------------------
// 1. React Native's fetch: whatwg-fetch, the one react-native itself ships
// ---------------------------------------------------------------------------

interface WhatwgFetch {
  Response: typeof Response;
  Headers: typeof Headers;
}
function loadWhatwgFetch(): WhatwgFetch {
  // Resolved the way the mobile app resolves it: through react-native.
  const fromMobile = createRequire(
    new URL("../../../../apps/mobile/package.json", import.meta.url),
  );
  const fromRn = createRequire(fromMobile.resolve("react-native/package.json"));
  return fromRn("whatwg-fetch") as WhatwgFetch;
}

const NativeResponse = globalThis.Response;

describe("#914 r4: React Native's fetch (a Response without a body stream)", () => {
  let relay: FakeRelay;
  const W = loadWhatwgFetch();
  beforeEach(() => {
    relay = new FakeRelay();
    for (let i = 1; i <= 3; i++) relay.ingest(entry(`rn${i}`, i));
    // Every response the adapter sees, and the one it rebuilds, is whatwg-fetch's.
    vi.stubGlobal("Response", W.Response);
    vi.stubGlobal("Headers", W.Headers);
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      // The fake relay builds its answer with the platform Response; the
      // adapter only ever sees whatwg-fetch's.
      globalThis.Response = NativeResponse;
      const pending = relay.fetch(input, init);
      globalThis.Response = W.Response;
      const res = await pending;
      const text = await res.text();
      return new W.Response(text, {
        status: res.status,
        headers: { "content-type": "application/json" },
      });
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("whatwg-fetch's Response really has no body stream (the premise)", () => {
    expect((new W.Response("x") as { body?: unknown }).body).toBeUndefined();
  });

  it("the pull and the clock read their bodies", async () => {
    const http = new HttpEventStoreAdapter({
      baseUrl: relay.baseUrl,
      motebitId: MID,
      maxRetries: 0,
    });
    expect(await http.getLatestClock(MID)).toBe(3);
    const engine = new SyncEngine(new InMemoryEventStore(), MID);
    engine.connectRemote(http);
    const r = await engine.sync();
    expect(engine.getStatus()).toBe("idle");
    expect(r.pulled).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 2. A slow link: 3 ms per event on the wire, a 200 ms ack deadline
// ---------------------------------------------------------------------------

/** A relay behind a link that carries 3 ms per event, one frame at a time. */
class SlowLink {
  static all: SlowLink[] = [];
  static busyUntil = 0;
  static delivered = new Set<string>();
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  frameSizes: number[] = [];
  constructor(public url: string) {
    SlowLink.all.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
    }, 0);
  }
  send(data: string): void {
    const msg = JSON.parse(data) as { type: string; events?: EventLogEntry[] };
    if (msg.type !== "push") return;
    const events = msg.events ?? [];
    this.frameSizes.push(events.length);
    const start = Math.max(Date.now(), SlowLink.busyUntil);
    SlowLink.busyUntil = start + 3 * events.length;
    setTimeout(() => {
      if (this.readyState !== 1) return; // the socket was dropped: no ack arrives
      for (const e of events) SlowLink.delivered.add(e.event_id);
      this.onmessage?.({ data: JSON.stringify({ type: "ack", accepted: events.length }) });
    }, SlowLink.busyUntil - Date.now());
  }
  close(): void {
    this.readyState = 3;
  }
}

describe("#914 r4: a push frame too big for the link converges", () => {
  let original: typeof globalThis.WebSocket;
  beforeEach(() => {
    vi.useFakeTimers();
    SlowLink.all = [];
    SlowLink.busyUntil = 0;
    SlowLink.delivered = new Set();
    original = globalThis.WebSocket;
    globalThis.WebSocket = SlowLink as unknown as typeof WebSocket;
  });
  afterEach(() => {
    globalThis.WebSocket = original;
    vi.useRealTimers();
  });

  it("150 events, batch 100, 200 ms deadline, 3 ms/event: every event delivered, the cursor reaches 150", async () => {
    const local = new InMemoryEventStore();
    for (let i = 0; i < 150; i++) await write(local, `s${i}`);
    const ws = new WebSocketEventStoreAdapter({
      url: "ws://r/ws/sync/slow",
      motebitId: MID,
      pushAckTimeoutMs: 200,
      reconnectBaseMs: 10,
      reconnectMaxMs: 10,
    });
    ws.connect();
    await vi.advanceTimersByTimeAsync(1);
    const engine = new SyncEngine(local, MID, { batch_size: 100 });
    engine.connectRemote(ws);
    let syncs = 0;
    while (engine.getCursor().last_version_clock < 150 && syncs < 3) {
      syncs++;
      let done = false;
      void engine.sync().then(() => (done = true));
      for (let i = 0; i < 2_000 && !done; i++) await vi.advanceTimersByTimeAsync(5);
    }
    expect(engine.getCursor().last_version_clock).toBe(150);
    expect(SlowLink.delivered.size).toBe(150);
    expect(syncs).toBe(1);
    ws.disconnect();
  });
});

// ---------------------------------------------------------------------------
// 3. Laws that must go red when broken
// ---------------------------------------------------------------------------

class AckSocket {
  static all: AckSocket[] = [];
  static ackMs = 20;
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  frames: string[][] = [];
  constructor(public url: string) {
    AckSocket.all.push(this);
  }
  send(data: string): void {
    const msg = JSON.parse(data) as { type: string; events?: EventLogEntry[] };
    if (msg.type !== "push") return;
    this.frames.push((msg.events ?? []).map((e) => e.event_id));
    setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: "ack" }) }), AckSocket.ackMs);
  }
  close(): void {
    this.readyState = 3;
  }
}

describe("#914 r4: the linger", () => {
  let original: typeof globalThis.WebSocket;
  beforeEach(() => {
    vi.useFakeTimers();
    AckSocket.all = [];
    AckSocket.ackMs = 20;
    original = globalThis.WebSocket;
    globalThis.WebSocket = AckSocket as unknown as typeof WebSocket;
  });
  afterEach(() => {
    globalThis.WebSocket = original;
    vi.useRealTimers();
  });

  function open(url: string): WebSocketEventStoreAdapter {
    const ws = new WebSocketEventStoreAdapter({ url, motebitId: MID });
    ws.connect();
    AckSocket.all[AckSocket.all.length - 1]!.onopen?.();
    return ws;
  }

  it("appends arriving 5 ms apart (an encrypting batch) go out as one frame", async () => {
    const ws = open("ws://r/ws/sync/linger-spread");
    for (let i = 0; i < 10; i++) {
      void ws.append(entry(`l${i}`, i + 1)).catch(() => {});
      await vi.advanceTimersByTimeAsync(5);
    }
    await vi.advanceTimersByTimeAsync(200);
    expect(AckSocket.all[0]!.frames.map((f) => f.length)).toEqual([10]);
    ws.disconnect();
  });

  it("an ack arriving while the next batch lingers does not flush it early", async () => {
    const ws = open("ws://r/ws/sync/linger-guard");
    void ws.append(entry("a", 1)).catch(() => {});
    await vi.advanceTimersByTimeAsync(20); // a is sent at ~15 ms; its ack is due ~20 ms later
    for (let i = 0; i < 6; i++) {
      void ws.append(entry(`b${i}`, i + 2)).catch(() => {});
      await vi.advanceTimersByTimeAsync(5); // the ack lands in the middle of these
    }
    await vi.advanceTimersByTimeAsync(200);
    expect(AckSocket.all[0]!.frames).toEqual([["a"], ["b0", "b1", "b2", "b3", "b4", "b5"]]);
    ws.disconnect();
  });
});

describe("#914 r4: the pull page size grows back after a good page", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("one slow big page shrinks the next request; a good page restores it", async () => {
    const relay = new FakeRelay();
    relay.ingest(entry("g1", 1));
    const limits: Array<string | null> = [];
    let hangFirst = true;
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/pull")) {
        limits.push(url.searchParams.get("limit"));
        if (hangFirst) {
          hangFirst = false;
          return new Promise<Response>(() => {});
        }
      }
      return relay.fetch(input, init);
    });
    const engine = new SyncEngine(new InMemoryEventStore(), MID);
    engine.connectRemote(
      new HttpEventStoreAdapter({
        baseUrl: relay.baseUrl,
        motebitId: MID,
        maxRetries: 0,
        requestTimeoutMs: 50,
      }),
    );
    await engine.sync();
    await engine.sync();
    expect(limits).toEqual([null, "500", null]); // back to the full page
  });
});

describe("#914 r4: the stall watchdog is on by default", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a remote that never answers: with no configuration, sync settles within about a minute", async () => {
    const local = new InMemoryEventStore();
    await write(local, "w1");
    const engine = new SyncEngine(local, MID);
    const stuck: EventStoreAdapter = {
      append: () => new Promise<void>(() => {}),
      query: () => Promise.resolve([]),
      getLatestClock: () => Promise.resolve(0),
      tombstone: () => Promise.resolve(),
    };
    engine.connectRemote(stuck);
    let settled = false;
    void engine.sync().then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(59_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(settled).toBe(true);
    expect(engine.getStatus()).toBe("error");
  });
});
