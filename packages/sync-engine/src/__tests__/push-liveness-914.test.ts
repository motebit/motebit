/**
 * #914 round 2 — liveness and order of the push.
 *
 * The acknowledged push cursor made one push wait on the relay, and a sync
 * called during it joins it. A push that never answered (a black-holed
 * request, a credential lookup that hangs) therefore wedged every later sync
 * with it — bounded only by undici's 300 s default times the retries. Main
 * did not wedge (it did not join), so this was a liveness regression.
 *
 * Law: every HTTP attempt (credential, fetch, body) is bounded by
 * `requestTimeoutMs`; a timed-out push rejects its append and the cursor does
 * not move; and a sync cycle without progress for `stall_timeout_ms` is
 * abandoned, so nobody waits on it past that bound, whatever the remote does.
 *
 * And the order: the relay receives a device's pushes in clock order (one
 * HTTP push on the wire at a time; the encrypting wrapper hands pushes on in
 * call order), which a client still pulling by clock relies on. The socket
 * paces its frames under the relay's per-connection message limit.
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
  WebSocketEventStoreAdapter,
} from "../index.js";
import { FakeRelay } from "./fake-relay.js";

const MID = "motebit-zz914-live";
const KEY = new Uint8Array(32).fill(4);

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

const sorted = (xs: string[]): string[] => [...xs].sort();

describe("#914 round 2: a push that never answers cannot wedge sync", () => {
  let relay: FakeRelay;
  beforeEach(() => {
    relay = new FakeRelay();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a black-holed push (ignoring its abort signal) times out; the joined sync settles; the next sync delivers e1, e2", async () => {
    const local = new InMemoryEventStore();
    await write(local, "e1");
    await write(local, "e2");
    // The relay is black-holed: every request hangs, ignoring its abort signal.
    let down = true;
    vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) => {
      if (down) return new Promise<Response>(() => {});
      return relay.fetch(input, init);
    });
    const engine = new SyncEngine(local, MID);
    engine.connectRemote(
      new HttpEventStoreAdapter({
        baseUrl: relay.baseUrl,
        motebitId: MID,
        maxRetries: 0,
        requestTimeoutMs: 20, // a request is given up at 64 × this
      }),
    );

    const first = engine.sync();
    let secondSettled = false;
    const second = engine.sync().then(() => (secondSettled = true));
    await first;
    await second;
    expect(secondSettled).toBe(true);
    expect(engine.getStatus()).toBe("error");
    expect(relay.heldIds(MID)).toEqual([]);
    expect(engine.getCursor().last_version_clock).toBe(0); // a timed-out push moves nothing

    down = false; // the relay recovers
    await engine.sync();
    expect(engine.getStatus()).toBe("idle");
    expect(sorted(relay.heldIds(MID))).toEqual(["e1", "e2"]);
  });

  it("a credential lookup that hangs is bounded the same way", async () => {
    const local = new InMemoryEventStore();
    await write(local, "c1");
    vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) => relay.fetch(input, init));
    let hang = true;
    const engine = new SyncEngine(local, MID);
    engine.connectRemote(
      new HttpEventStoreAdapter({
        baseUrl: relay.baseUrl,
        motebitId: MID,
        maxRetries: 0,
        requestTimeoutMs: 100,
        credentialSource: {
          getCredential: () => {
            if (hang) {
              hang = false;
              return new Promise<string>(() => {});
            }
            return Promise.resolve("tok");
          },
        },
      }),
    );
    // The hung lookup ends at the bound (the sync settles); once the source
    // answers, the event goes through — in this sync or the next.
    await engine.sync();
    if (engine.getStatus() !== "idle") await engine.sync();
    expect(engine.getStatus()).toBe("idle");
    expect(relay.heldIds(MID)).toEqual(["c1"]);
  });

  it("a remote that never settles: the cycle is abandoned after stall_timeout_ms, joined callers included, and a later sync proceeds", async () => {
    const local = new InMemoryEventStore();
    await write(local, "s1");
    const stuck: EventStoreAdapter = {
      append: () => new Promise<void>(() => {}),
      query: () => Promise.resolve([]),
      getLatestClock: () => Promise.resolve(0),
      tombstone: () => Promise.resolve(),
    };
    const engine = new SyncEngine(local, MID, { stall_timeout_ms: 100 });
    engine.connectRemote(stuck);
    const [a, b] = await Promise.all([engine.sync(), engine.sync()]);
    expect(a).toEqual({ pushed: 0, pulled: 0, conflicts: [] });
    expect(b).toEqual(a);
    expect(engine.getStatus()).toBe("error");
    expect(engine.getCursor().last_version_clock).toBe(0);

    vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) => relay.fetch(input, init));
    engine.connectRemote(
      new HttpEventStoreAdapter({ baseUrl: relay.baseUrl, motebitId: MID, maxRetries: 0 }),
    );
    await engine.sync();
    expect(engine.getStatus()).toBe("idle");
    expect(relay.heldIds(MID)).toEqual(["s1"]);
  });

  it("a push that fails fails the pushes queued behind it at once — bounded overlap, never one timeout per event", async () => {
    const local = new InMemoryEventStore();
    for (let i = 0; i < 20; i++) await write(local, `q${i}`);
    let pushes = 0;
    vi.stubGlobal("fetch", (input: string | URL) => {
      if (String(input).includes("/push")) pushes++;
      return new Promise<Response>(() => {}); // the relay is black-holed
    });
    const engine = new SyncEngine(local, MID);
    engine.connectRemote(
      new HttpEventStoreAdapter({
        baseUrl: relay.baseUrl,
        motebitId: MID,
        maxRetries: 0,
        requestTimeoutMs: 10, // given up at 64 × this
      }),
    );
    const started = Date.now();
    await engine.sync();
    expect(engine.getStatus()).toBe("error");
    // A push that misses its deadline hands its slot on (round 7): at most
    // one in the slot plus MAX_OVERLAPPING_PUSHES (8) ever go out; the
    // other 11 are failed with the first failure, never tried one by one.
    expect(pushes).toBeGreaterThanOrEqual(1);
    expect(pushes).toBeLessThanOrEqual(9);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("#914 round 2: the relay receives a device's pushes in clock order", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A relay that stores a push when its request COMPLETES — later requests complete sooner. */
  function slowFirstRelay(): { relay: FakeRelay; stored: number[] } {
    const relay = new FakeRelay();
    const stored: number[] = [];
    let n = 0;
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      if (String(input).includes("/push")) {
        const delay = Math.max(1, 40 - 5 * n++);
        await new Promise((r) => setTimeout(r, delay));
        const body = JSON.parse(init!.body as string) as { events: EventLogEntry[] };
        for (const e of body.events) stored.push(e.version_clock);
      }
      return relay.fetch(input, init);
    });
    return { relay, stored };
  }

  for (const door of ["raw", "e2e"] as const) {
    it(`${door}: 8 events arrive at the relay in clock order`, async () => {
      const { relay, stored } = slowFirstRelay();
      const local = new InMemoryEventStore();
      for (let i = 0; i < 8; i++) await write(local, `o${i}`);
      const http = new HttpEventStoreAdapter({
        baseUrl: relay.baseUrl,
        motebitId: MID,
        maxRetries: 0,
        payloads: door,
      });
      const engine = new SyncEngine(local, MID);
      engine.connectRemote(
        door === "e2e" ? new EncryptedEventStoreAdapter({ inner: http, key: KEY }) : http,
      );
      await engine.sync();
      expect(engine.getStatus()).toBe("idle");
      expect(stored).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });
  }
});

// ---------------------------------------------------------------------------
// The socket paces its push frames under the relay's per-connection limit
// ---------------------------------------------------------------------------

class PacedSocket {
  static last: PacedSocket | null = null;
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  pushTimes: number[] = [];
  constructor(public url: string) {
    PacedSocket.last = this;
  }
  send(data: string): void {
    const msg = JSON.parse(data) as { type: string; events?: unknown[] };
    if (msg.type !== "push") return;
    this.pushTimes.push(Date.now());
    // The relay acks at once.
    void Promise.resolve().then(() =>
      this.onmessage?.({ data: JSON.stringify({ type: "ack", accepted: msg.events?.length }) }),
    );
  }
  close(): void {
    this.readyState = 3;
  }
}

describe("#914 round 2: socket push pacing", () => {
  let original: typeof globalThis.WebSocket;
  beforeEach(() => {
    vi.useFakeTimers();
    original = globalThis.WebSocket;
    globalThis.WebSocket = PacedSocket as unknown as typeof WebSocket;
  });
  afterEach(() => {
    globalThis.WebSocket = original;
    vi.useRealTimers();
  });

  it("a stream of pushes never exceeds 50 frames in any 10 s window (the relay admits 100 messages), and every append is acked", async () => {
    const ws = new WebSocketEventStoreAdapter({
      url: "ws://r/ws/sync/m",
      motebitId: MID,
      pushAckTimeoutMs: 60_000,
    });
    ws.connect();
    PacedSocket.last!.onopen?.();
    const acks: Array<Promise<void>> = [];
    // One event at a time, as fast as they are acked: the worst case for frame count.
    for (let i = 0; i < 150; i++) {
      acks.push(
        ws.append({
          event_id: `p${i}`,
          motebit_id: MID as EventLogEntry["motebit_id"],
          timestamp: 0,
          event_type: EventType.StateUpdated,
          payload: {},
          version_clock: i + 1,
          tombstoned: false,
        }),
      );
      await vi.advanceTimersByTimeAsync(30);
    }
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.all(acks);
    const t = PacedSocket.last!.pushTimes;
    for (let i = 0; i < t.length; i++) {
      const inWindow = t.filter((x) => x >= t[i]! && x < t[i]! + 10_000).length;
      expect(inWindow).toBeLessThanOrEqual(50);
    }
    ws.disconnect();
  });
});
