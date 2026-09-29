/**
 * #914 round 6.
 *
 *   1. What a slow link teaches the transport (the push frame size, the pull
 *      page size, the deadline stretches) survives an adapter REBUILD: mobile
 *      builds a new socket adapter and a new HTTP catch-up adapter every sync
 *      cycle. The cells below rebuild the adapter each cycle, as mobile does.
 *   2. After an outage, delivery resumes within about one cycle: a deadline
 *      stretches only while the relay is shown to answer (never against a
 *      dead one), and a cycle the watchdog abandons takes its requests with it.
 *   3. The stretches reset on success, and a pull stretches at most once per
 *      call.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { InMemoryEventStore } from "@motebit/event-log";
import { EventType } from "@motebit/sdk";
import type { EventLogEntry } from "@motebit/sdk";
import {
  SyncEngine,
  HttpEventStoreAdapter,
  WebSocketEventStoreAdapter,
  liveAdapter,
} from "../index.js";
import { FakeRelay } from "./fake-relay.js";
import { onReactNative, type RnLink } from "./rn-fetch.js";

const MID = "motebit-zz914-r6";

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
    timestamp: 0,
    event_type: EventType.StateUpdated,
    payload: { id },
    tombstoned: false,
  });
}

function http(relay: FakeRelay, requestTimeoutMs: number): HttpEventStoreAdapter {
  return new HttpEventStoreAdapter({
    baseUrl: relay.baseUrl,
    motebitId: MID,
    maxRetries: 0,
    requestTimeoutMs,
  });
}

// ---------------------------------------------------------------------------
// 1a. The socket push over a slow uplink, the adapter rebuilt every cycle
// ---------------------------------------------------------------------------

class SlowUplink {
  static all: SlowUplink[] = [];
  static busyUntil = 0;
  static delivered = new Set<string>();
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  constructor(public url: string) {
    SlowUplink.all.push(this);
    setTimeout(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.onopen?.();
    }, 0);
  }
  send(data: string): void {
    const msg = JSON.parse(data) as { type: string; events?: EventLogEntry[] };
    if (msg.type !== "push") return;
    const events = msg.events ?? [];
    const start = Math.max(Date.now(), SlowUplink.busyUntil);
    SlowUplink.busyUntil = start + 3 * events.length; // 3 ms per event on the wire
    setTimeout(() => {
      if (this.readyState !== 1) return;
      for (const e of events) SlowUplink.delivered.add(e.event_id);
      this.onmessage?.({ data: JSON.stringify({ type: "ack", accepted: events.length }) });
    }, SlowUplink.busyUntil - Date.now());
  }
  close(): void {
    this.readyState = 3;
  }
}

describe("#914 r6: a socket adapter rebuilt every cycle (mobile) still converges on a slow uplink", () => {
  let original: typeof globalThis.WebSocket;
  beforeEach(() => {
    vi.useFakeTimers();
    SlowUplink.all = [];
    SlowUplink.busyUntil = 0;
    SlowUplink.delivered = new Set();
    original = globalThis.WebSocket;
    globalThis.WebSocket = SlowUplink as unknown as typeof WebSocket;
  });
  afterEach(() => {
    globalThis.WebSocket = original;
    vi.useRealTimers();
  });

  it("300 backlog events, 3 ms/event, a 200 ms ack deadline, a new adapter every 350 ms cycle: all delivered", async () => {
    const local = new InMemoryEventStore();
    for (let i = 0; i < 300; i++) await write(local, `m${i}`);
    const engine = new SyncEngine(local, MID, { batch_size: 100 });
    let cycles = 0;
    for (; cycles < 40 && engine.getCursor().last_version_clock < 300; cycles++) {
      // Mobile's cycle: a fresh socket adapter, a sync, and a teardown.
      const ws = new WebSocketEventStoreAdapter({
        url: "ws://r/ws/sync/mobile-uplink",
        motebitId: MID,
        deviceId: "phone",
        pushAckTimeoutMs: 200,
        reconnectBaseMs: 10,
        reconnectMaxMs: 10,
      });
      ws.connect();
      await vi.advanceTimersByTimeAsync(1);
      engine.connectRemote(ws);
      void engine.sync();
      await vi.advanceTimersByTimeAsync(350);
      ws.disconnect();
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(SlowUplink.delivered.size).toBe(300);
    expect(engine.getCursor().last_version_clock).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// 1b. The pull over React Native, the adapter rebuilt every cycle
// ---------------------------------------------------------------------------

describe("#914 r6: an HTTP adapter rebuilt every cycle (mobile catch-up) still learns a slow link", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("one event needs 4× the deadline: a new adapter per sync still pulls all 3", async () => {
    const relay = new FakeRelay();
    for (let i = 1; i <= 3; i++) relay.ingest(entry(`pl${i}`, i));
    onReactNative(relay, { msPerEvent: 130, pushMs: 0, log: [] }); // 130 ms/event vs 40 ms
    const local = new InMemoryEventStore();
    const engine = new SyncEngine(local, MID);
    const held = async (): Promise<number> => (await local.query({})).length;
    for (let s = 0; s < 16 && (await held()) < 3; s++) {
      engine.connectRemote(http(relay, 40)); // rebuilt, as mobile rebuilds it
      await engine.sync();
    }
    expect(await held()).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 2. Outage recovery (the CLI / daemon over HTTP)
// ---------------------------------------------------------------------------

describe("#914 r6: after an outage, delivery resumes within about one cycle", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("black-holed relay for 10 s under 300 ms cycles: the event lands within ~one cycle of recovery", async () => {
    const relay = new FakeRelay();
    let down = true;
    vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) =>
      down ? new Promise<Response>(() => {}) : relay.fetch(input, init),
    );
    const local = new InMemoryEventStore();
    const engine = new SyncEngine(local, MID, { sync_interval_ms: 300, stall_timeout_ms: 600 });
    engine.connectRemote(http(relay, 200)); // production ratios scaled 1:100: 20 s bound, 30 s cycle, 60 s stall
    engine.start();
    await write(local, "during-outage");
    await new Promise((r) => setTimeout(r, 10_000)); // ≈ a 16-minute outage at 1:100
    down = false;
    const recovered = Date.now();
    while (relay.heldIds(MID).length === 0 && Date.now() - recovered < 5_000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const lag = Date.now() - recovered;
    engine.stop();
    expect(relay.heldIds(MID)).toEqual(["during-outage"]);
    // One cycle (300 ms) plus one base-deadline attempt (100 ms), with slack.
    expect(lag).toBeLessThan(700);
  }, 30_000);

  it("a cycle the watchdog abandons takes its requests with it — forwarded through liveAdapter", async () => {
    // A transport that reports no live work (it cannot say), so the watchdog
    // abandons the stalled cycle: its requests must be ended with it.
    const local = new InMemoryEventStore();
    await write(local, "a1");
    let aborted = 0;
    const stuck = {
      append: () => new Promise<void>(() => {}),
      query: () => Promise.resolve([]),
      getLatestClock: () => Promise.resolve(0),
      tombstone: () => Promise.resolve(),
      abortInFlight: () => {
        aborted++;
      },
    };
    const engine = new SyncEngine(local, MID, { stall_timeout_ms: 100 });
    engine.connectRemote(liveAdapter(() => stuck));
    await engine.sync(); // abandoned
    expect(engine.getStatus()).toBe("error");
    expect(aborted).toBe(1);
  });

  it("a request slower than its deadline is live work: the watchdog never abandons it, and it completes", async () => {
    const relay = new FakeRelay();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      if (String(input).includes("/push")) await held; // the relay is slow to answer
      return relay.fetch(input, init);
    });
    const local = new InMemoryEventStore();
    await write(local, "slow-1");
    const engine = new SyncEngine(local, MID, { stall_timeout_ms: 100 });
    engine.connectRemote(http(relay, 20));
    const done = engine.sync();
    await new Promise((r) => setTimeout(r, 500)); // 25 deadlines, 5 stall windows
    release();
    await done;
    expect(engine.getStatus()).toBe("idle");
    expect(relay.heldIds(MID)).toEqual(["slow-1"]);
    expect(engine.getCursor().last_version_clock).toBe(1);
  });
});

describe("#914 r7: a deadline changes adaptation only — it never kills a request that could complete", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a push whose answer takes 5 deadlines completes as ONE attempt (the relay answers the probe just as slowly)", async () => {
    const relay = new FakeRelay();
    // Every answer (the push and the clock probe alike): 200 ms vs a 40 ms deadline.
    const link: RnLink = { msPerEvent: 0, pushMs: 200, otherMs: 200, log: [] };
    onReactNative(relay, link);
    const local = new InMemoryEventStore();
    await write(local, "x1");
    const engine = new SyncEngine(local, MID);
    engine.connectRemote(http(relay, 40));
    await engine.sync();
    expect(relay.heldIds(MID)).toEqual(["x1"]);
    const pushes = link.log.filter((e) => e.path.endsWith("/push"));
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.outcome).toBe("load");
  });

  it("a slow push while the relay answers its probe at once is hedged, bounded, and still completes", async () => {
    const relay = new FakeRelay();
    const link: RnLink = { msPerEvent: 0, pushMs: 200, otherMs: 0, log: [] };
    onReactNative(relay, link);
    const local = new InMemoryEventStore();
    await write(local, "h1");
    const engine = new SyncEngine(local, MID);
    engine.connectRemote(http(relay, 40));
    await engine.sync();
    expect(engine.getStatus()).toBe("idle");
    expect(relay.heldIds(MID)).toEqual(["h1"]);
    const pushes = link.log.filter((e) => e.path.endsWith("/push"));
    expect(pushes.length).toBeGreaterThan(1); // the probe was evidence: hedged
    expect(pushes.length).toBeLessThanOrEqual(8); // MAX_ATTEMPTS
    expect(pushes.some((p) => p.outcome === "load")).toBe(true);
  });

  it("a pull page that takes 4 deadlines completes in this sync — never cut off", async () => {
    const relay = new FakeRelay();
    relay.ingest(entry("s1", 1));
    const link: RnLink = { msPerEvent: 160, pushMs: 0, log: [] }; // 160 ms vs a 40 ms deadline
    onReactNative(relay, link);
    const engine = new SyncEngine(new InMemoryEventStore(), MID);
    engine.connectRemote(http(relay, 40));
    const r = await engine.sync();
    expect(r.pulled).toBe(1);
    expect(engine.getStatus()).toBe("idle");
  });

  it("React Native's AbortController carries no reason: an owner abort is classified by the adapter's own flag, never as a timeout", async () => {
    // abort-controller@3.0.0 (react-native): `signal.reason` is undefined.
    const relay = new FakeRelay();
    const link: RnLink = { msPerEvent: 0, pushMs: 10_000, log: [] };
    onReactNative(relay, link);
    const local = new InMemoryEventStore();
    await write(local, "ab1");
    const adapter = http(relay, 40);
    const failure = adapter.append((await local.query({}))[0]!).then(
      () => "resolved",
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    await new Promise((r) => setTimeout(r, 20));
    adapter.abortInFlight();
    const msg = await failure;
    expect(msg).toMatch(/abandoned with its sync cycle/);
  });
});
