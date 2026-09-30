/**
 * #914 round 3 — liveness without cutting off live work.
 *
 *   1. The request bound covers time-to-first-byte and body IDLE time, never
 *      the total body time: a slow page that keeps arriving is pulled; a
 *      stalled one times out; a timed-out pull is re-asked smaller.
 *   2. The stall watchdog counts every sign of life (a pull page, a push
 *      settling, wire activity), so a slow but working cycle is never
 *      abandoned; an abandoned cycle's late status writes are ignored.
 *   3. A status listener that throws never wedges sync.
 *   4. The socket sends a batch as ONE frame, starts an event's ack deadline
 *      when its frame is sent, and paces per device across adapters.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { InMemoryEventStore } from "@motebit/event-log";
import type { EventStoreAdapter } from "@motebit/event-log";
import { EventType } from "@motebit/sdk";
import type { EventLogEntry } from "@motebit/sdk";
import { SyncEngine, HttpEventStoreAdapter, WebSocketEventStoreAdapter } from "../index.js";
import type { SeqPullResult, SyncStatus } from "../index.js";
import { FakeRelay } from "./fake-relay.js";

const MID = "motebit-zz914-r3";

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** `res`'s body re-served in `n` chunks, `gapMs` apart; `stallAfter` chunks then silence, if set. */
async function trickle(
  res: Response,
  n: number,
  gapMs: number,
  stallAfter?: number,
): Promise<Response> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  const size = Math.ceil(bytes.length / n);
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      if (stallAfter !== undefined && i >= stallAfter) {
        await new Promise(() => {}); // no byte ever again
      }
      await sleep(gapMs);
      const chunk = bytes.slice(i * size, (i + 1) * size);
      i++;
      if (chunk.length > 0) ctrl.enqueue(chunk);
      if (i * size >= bytes.length) ctrl.close();
    },
  });
  return new Response(body, { status: res.status, headers: res.headers });
}

describe("#914 r3: the HTTP bound is time-to-first-byte and body idle, never total body time", () => {
  let relay: FakeRelay;
  beforeEach(() => {
    relay = new FakeRelay();
    for (let i = 1; i <= 3; i++) relay.ingest(entry(`r${i}`, i));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function engineOver(opts: { requestTimeoutMs: number; bodyIdleTimeoutMs?: number }): {
    engine: SyncEngine;
    local: InMemoryEventStore;
  } {
    const local = new InMemoryEventStore();
    const engine = new SyncEngine(local, MID);
    engine.connectRemote(
      new HttpEventStoreAdapter({ baseUrl: relay.baseUrl, motebitId: MID, maxRetries: 0, ...opts }),
    );
    return { engine, local };
  }

  it("a page whose body trickles in for far longer than the bound is pulled", async () => {
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const res = await relay.fetch(input, init);
      return String(input).includes("/pull") ? trickle(res, 10, 40) : res; // ~400 ms of body
    });
    const { engine } = engineOver({ requestTimeoutMs: 100, bodyIdleTimeoutMs: 100 });
    const r = await engine.sync();
    expect(engine.getStatus()).toBe("idle");
    expect(r.pulled).toBe(3);
  });

  it("a body that stops arriving for good is given up at the cap (the sync fails, never hangs)", async () => {
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const res = await relay.fetch(input, init);
      return String(input).includes("/pull") ? trickle(res, 10, 5, 2) : res;
    });
    // A stalled body is never cut at its deadline — only at 64 × it (#914 round 7).
    const { engine } = engineOver({ requestTimeoutMs: 20, bodyIdleTimeoutMs: 10 });
    const started = Date.now();
    await engine.sync();
    expect(engine.getStatus()).toBe("error");
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("a pull that times out is re-asked for a smaller page, and then succeeds", async () => {
    const limits: Array<string | null> = [];
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/pull")) {
        const limit = url.searchParams.get("limit");
        limits.push(limit);
        // A big page never starts in time on this link.
        if (limit === null || Number(limit) > 250) return new Promise<Response>(() => {});
      }
      return relay.fetch(input, init);
    });
    const { engine } = engineOver({ requestTimeoutMs: 50 });
    const r = await engine.sync();
    expect(engine.getStatus()).toBe("idle");
    expect(r.pulled).toBe(3);
    expect(limits.slice(0, 3)).toEqual([null, "500", "250"]);
  });
});

describe("#914 r3: the watchdog never abandons a slow but working cycle", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A remote that pulls by seq, one event per page, each page `pageMs` slow. */
  function slowPages(
    n: number,
    pageMs: number,
  ): EventStoreAdapter & {
    seqCursorKey: string;
    pullAfterSeq(afterSeq: number): Promise<SeqPullResult>;
  } {
    return {
      seqCursorKey: "raw:slow-pages",
      async pullAfterSeq(afterSeq: number): Promise<SeqPullResult> {
        await sleep(pageMs);
        if (afterSeq >= n) {
          return { kind: "seq", entries: [], nextSeq: afterSeq, hasMore: false, latestSeq: n };
        }
        const seq = afterSeq + 1;
        return {
          kind: "seq",
          entries: [{ seq, event: entry(`page-${seq}`, 100 + seq) }],
          nextSeq: seq,
          hasMore: seq < n,
          latestSeq: n,
        };
      },
      append: () => Promise.resolve(),
      query: () => Promise.resolve([]),
      getLatestClock: () => Promise.resolve(0),
      tombstone: () => Promise.resolve(),
    };
  }

  it("5 slow pages (each under the bound, together over it): one cycle, pulled 5, never error", async () => {
    const statuses: SyncStatus[] = [];
    const engine = new SyncEngine(new InMemoryEventStore(), MID, { stall_timeout_ms: 100 });
    engine.onStatusChange((s) => statuses.push(s));
    engine.connectRemote(slowPages(5, 60));
    const r = await engine.sync();
    expect(r.pulled).toBe(5);
    expect(statuses).not.toContain("error");
    expect(engine.getStatus()).toBe("idle");
  });

  it("slow pushes (each under the bound, together over it) keep the cycle alive", async () => {
    const local = new InMemoryEventStore();
    for (let i = 0; i < 6; i++) await write(local, `sp${i}`);
    let chain = Promise.resolve();
    const stored: string[] = [];
    const slow: EventStoreAdapter = {
      append: (e) => {
        chain = chain.then(async () => {
          await sleep(40);
          stored.push(e.event_id);
        });
        return chain;
      },
      query: () => Promise.resolve([]),
      getLatestClock: () => Promise.resolve(0),
      tombstone: () => Promise.resolve(),
    };
    const engine = new SyncEngine(local, MID, { stall_timeout_ms: 100 });
    engine.connectRemote(slow);
    const r = await engine.sync();
    expect(r.pushed).toBe(6);
    expect(engine.getStatus()).toBe("idle");
  });

  it("one page whose body trickles longer than stall_timeout_ms: the wire activity keeps the cycle alive", async () => {
    const relay = new FakeRelay();
    for (let i = 1; i <= 3; i++) relay.ingest(entry(`w${i}`, i));
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const res = await relay.fetch(input, init);
      return String(input).includes("/pull") ? trickle(res, 10, 40) : res; // ~400 ms
    });
    const statuses: SyncStatus[] = [];
    const engine = new SyncEngine(new InMemoryEventStore(), MID, { stall_timeout_ms: 150 });
    engine.onStatusChange((s) => statuses.push(s));
    engine.connectRemote(
      new HttpEventStoreAdapter({
        baseUrl: relay.baseUrl,
        motebitId: MID,
        maxRetries: 0,
        requestTimeoutMs: 100,
      }),
    );
    const r = await engine.sync();
    expect(r.pulled).toBe(3);
    expect(statuses).not.toContain("error");
  });

  it("an abandoned cycle's late completion writes no status: the engine stays as the watchdog left it", async () => {
    const local = new InMemoryEventStore();
    await write(local, "late");
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const remote: EventStoreAdapter = {
      append: () => held,
      query: () => Promise.resolve([]),
      getLatestClock: () => Promise.resolve(0),
      tombstone: () => Promise.resolve(),
    };
    const statuses: SyncStatus[] = [];
    const engine = new SyncEngine(local, MID, { stall_timeout_ms: 50 });
    engine.onStatusChange((s) => statuses.push(s));
    engine.connectRemote(remote);
    await engine.sync(); // abandoned
    expect(engine.getStatus()).toBe("error");
    release(); // the abandoned cycle now completes
    await sleep(30);
    expect(engine.getStatus()).toBe("error");
    expect(statuses).toEqual(["syncing", "error"]);
  });
});

describe("#914 r3: a status listener that throws never wedges sync", () => {
  it("a listener throwing on 'error': the failed sync settles, and the next sync works", async () => {
    const local = new InMemoryEventStore();
    await write(local, "t1");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const engine = new SyncEngine(local, MID, { stall_timeout_ms: 50 });
    engine.onStatusChange((s) => {
      if (s === "error") throw new Error("listener bug");
    });
    engine.connectRemote({
      append: () => Promise.reject(new Error("down")),
      query: () => Promise.resolve([]),
      getLatestClock: () => Promise.resolve(0),
      tombstone: () => Promise.resolve(),
    });
    await engine.sync();
    expect(engine.getStatus()).toBe("error");
    // …and through the watchdog, too.
    engine.connectRemote({
      append: () => new Promise<void>(() => {}),
      query: () => Promise.resolve([]),
      getLatestClock: () => Promise.resolve(0),
      tombstone: () => Promise.resolve(),
    });
    await engine.sync();
    expect(engine.getStatus()).toBe("error");

    const remote = new InMemoryEventStore();
    engine.connectRemote(remote);
    await engine.sync();
    expect(engine.getStatus()).toBe("idle");
    expect((await remote.query({})).map((e) => e.event_id)).toEqual(["t1"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// The socket: one frame per batch; the ack deadline from the send
// ---------------------------------------------------------------------------

class LaggySocket {
  static all: LaggySocket[] = [];
  static ackMs = 5;
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  frames: string[][] = [];
  sentAt: number[] = [];
  constructor(public url: string) {
    LaggySocket.all.push(this);
  }
  send(data: string): void {
    const msg = JSON.parse(data) as { type: string; events?: EventLogEntry[] };
    if (msg.type !== "push") return;
    this.frames.push((msg.events ?? []).map((e) => e.event_id));
    this.sentAt.push(Date.now());
    setTimeout(() => {
      if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify({ type: "ack" }) });
    }, LaggySocket.ackMs);
  }
  close(): void {
    this.readyState = 3;
  }
}

describe("#914 r3: socket frames", () => {
  let original: typeof globalThis.WebSocket;
  beforeEach(() => {
    vi.useFakeTimers();
    LaggySocket.all = [];
    LaggySocket.ackMs = 5;
    original = globalThis.WebSocket;
    globalThis.WebSocket = LaggySocket as unknown as typeof WebSocket;
  });
  afterEach(() => {
    globalThis.WebSocket = original;
    vi.useRealTimers();
  });

  function socketAdapter(
    url = "ws://r/ws/sync/frames",
    deviceId?: string,
  ): WebSocketEventStoreAdapter {
    const ws = new WebSocketEventStoreAdapter({
      url,
      motebitId: MID,
      ...(deviceId ? { deviceId } : {}),
    });
    ws.connect();
    LaggySocket.all[LaggySocket.all.length - 1]!.onopen?.();
    return ws;
  }

  it("a 300-event backlog handed over together is coalesced into frames, never split per event", async () => {
    const local = new InMemoryEventStore();
    for (let i = 0; i < 300; i++) await write(local, `f${i}`);
    const ws = socketAdapter();
    const engine = new SyncEngine(local, MID, { batch_size: 100 });
    engine.connectRemote(ws);
    let done = false;
    void engine.sync().then(() => (done = true));
    for (let i = 0; i < 1000 && !done; i++) await vi.advanceTimersByTimeAsync(5);
    expect(engine.getStatus()).toBe("idle");
    // Round 7: the engine hands every batch over at once; the socket's
    // linger coalesces them into as few frames as its frame size allows.
    expect(LaggySocket.all[0]!.frames.map((f) => f.length)).toEqual([300]);
    ws.disconnect();
  });

  it("8 s relay ack latency: an event queued behind a frame is never failed by its wait — no error loop", async () => {
    LaggySocket.ackMs = 8_000;
    const ws = socketAdapter("ws://r/ws/sync/laggy");
    const states: string[] = [];
    const track = (p: Promise<void>, name: string): void => {
      p.then(
        () => states.push(`${name}:ok`),
        () => states.push(`${name}:err`),
      );
    };
    track(ws.append(entry("a", 1)), "a");
    await vi.advanceTimersByTimeAsync(100); // a's frame is on the wire
    track(ws.append(entry("b", 2)), "b"); // waits behind it for ~8 s
    await vi.advanceTimersByTimeAsync(30_000);
    expect(states.sort()).toEqual(["a:ok", "b:ok"]);
    expect(LaggySocket.all).toHaveLength(1); // never torn down
    ws.disconnect();
  });

  it("two adapters of one device draw on one pacing budget (the relay's limiter is per device)", async () => {
    const a = socketAdapter("ws://r/ws/sync/shared", "dev-1");
    const b = socketAdapter("ws://r/ws/sync/shared", "dev-1");
    for (let i = 0; i < 60; i++) {
      void a.append(entry(`a${i}`, i)).catch(() => {});
      void b.append(entry(`b${i}`, i)).catch(() => {});
      await vi.advanceTimersByTimeAsync(30);
    }
    await vi.advanceTimersByTimeAsync(60_000);
    const t = LaggySocket.all.flatMap((s) => s.sentAt).sort((x, y) => x - y);
    for (let i = 0; i < t.length; i++) {
      expect(t.filter((x) => x >= t[i]! && x < t[i]! + 10_000).length).toBeLessThanOrEqual(50);
    }
    a.disconnect();
    b.disconnect();
  });
});
