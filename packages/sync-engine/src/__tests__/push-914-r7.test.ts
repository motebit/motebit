/**
 * #914 round 7 — "a deadline changes adaptation only", mechanism by
 * mechanism, over the simulated network the liveness harness uses
 * (`sim-net.ts`, fake timers). Each test names the clause it holds; the
 * harness (`liveness-harness-914.ts`) holds the same clauses end to end.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { InMemoryEventStore } from "@motebit/event-log";
import type { EventLogEntry } from "@motebit/sdk";
import { EventType } from "@motebit/sdk";
import { SyncEngine, HttpEventStoreAdapter, WebSocketEventStoreAdapter } from "../index.js";
import { SimNet, SimRelay } from "./sim-net.js";

const MID = "motebit-r7";
let n = 0;

function event(id: string, clock: number, device = "phone"): EventLogEntry {
  return {
    event_id: id,
    motebit_id: MID as EventLogEntry["motebit_id"],
    device_id: device,
    timestamp: 1_700_000_000_000 + clock,
    event_type: EventType.StateUpdated,
    payload: { id },
    version_clock: clock,
    tombstoned: false,
  };
}

/** A fresh network; push frames sent on any of its sockets are counted. */
function network(latencyMs: number, cfg: { upMs?: number; downMs?: number } = {}) {
  const relay = new SimRelay(MID, latencyMs);
  const net = new SimNet(relay, { upMs: cfg.upMs ?? 10, downMs: cfg.downMs ?? 10 });
  const frames: string[][] = [];
  const Base = net.socketClass();
  class Counting extends (Base as unknown as new (url: string) => {
    send(data: string): void;
  }) {
    override send(data: string): void {
      const msg = JSON.parse(data) as { type: string; events?: EventLogEntry[] };
      if (msg.type === "push") frames.push((msg.events ?? []).map((e) => e.event_id));
      super.send(data);
    }
  }
  vi.stubGlobal("WebSocket", Counting);
  vi.stubGlobal("fetch", net.fetch);
  const k = ++n;
  return {
    relay,
    net,
    frames,
    base: `http://relay-r7-${k}.test`,
    wsUrl: `ws://relay-r7-${k}.test/ws/sync/${MID}`,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("#914 r7: a socket retired while a frame is on the wire drains it", () => {
  it("the frame's late ack still resolves its append after disconnect()", async () => {
    const w = network(5_000); // the relay acks 5 s after the frame arrives
    const ws = new WebSocketEventStoreAdapter({ url: w.wsUrl, motebitId: MID, deviceId: "phone" });
    ws.connect();
    await vi.advanceTimersByTimeAsync(100);
    let outcome = "pending";
    ws.append(event("d1", 1)).then(
      () => (outcome = "acked"),
      (err: unknown) => (outcome = `rejected: ${err instanceof Error ? err.message : ""}`),
    );
    await vi.advanceTimersByTimeAsync(200); // linger, send, arrive
    expect(w.relay.holds("d1")).toBe(true);
    ws.disconnect(); // a token refresh retires the adapter
    await vi.advanceTimersByTimeAsync(6_000);
    expect(outcome).toBe("acked");
  });
});

describe("#914 r7: an acknowledgment outlives its sync", () => {
  it("a late ack moves the cursor between syncs, and no later sync sends the frame again", async () => {
    const w = network(10_000);
    const local = new InMemoryEventStore();
    await local.append(event("s1", 1));
    const ws = new WebSocketEventStoreAdapter({ url: w.wsUrl, motebitId: MID, deviceId: "phone" });
    ws.connect();
    await vi.advanceTimersByTimeAsync(100);
    const engine = new SyncEngine(local, MID, { push_patience_ms: 1_000 });
    engine.connectRemote(ws);

    const first = engine.sync();
    await vi.advanceTimersByTimeAsync(1_500);
    await first; // ended at its patience, the frame still in flight
    expect(engine.getStatus()).toBe("idle");
    expect(engine.getCursor().last_version_clock).toBe(0);

    const second = engine.sync(); // joins the frame in flight
    await vi.advanceTimersByTimeAsync(1_500);
    await second;
    expect(w.frames).toEqual([["s1"]]); // sent once

    await vi.advanceTimersByTimeAsync(10_000); // the ack arrives, no sync running
    expect(engine.getCursor().last_version_clock).toBe(1);
    ws.disconnect();
  });
});

describe("#914 r7: a slow pull never holds back the next sync's push", () => {
  it("a sync ends at its patience while the pull is still coming; the next pushes at once and joins that pull", async () => {
    const w = network(60_000); // every answer takes a minute
    let pulls = 0;
    const inner = w.net.fetch;
    vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) => {
      if (String(input).includes("/pull")) pulls++;
      return inner(input, init);
    });
    const local = new InMemoryEventStore();
    const engine = new SyncEngine(local, MID, { push_patience_ms: 1_000 });
    engine.connectRemote(new HttpEventStoreAdapter({ baseUrl: w.base, motebitId: MID }));

    let firstDone = false;
    void engine.sync().then(() => (firstDone = true));
    await vi.advanceTimersByTimeAsync(1_500);
    expect([firstDone, engine.getStatus(), pulls]).toEqual([true, "idle", 1]);
    expect(pulls).toBe(1);

    await local.append(event("p1", 1));
    let secondDone = false;
    void engine.sync().then(() => (secondDone = true));
    await vi.advanceTimersByTimeAsync(2_500); // its push's patience, then the pull's
    expect(secondDone).toBe(true);
    expect(engine.getStatus()).toBe("idle");
    expect(w.relay.holds("p1")).toBe(true); // stored on arrival, long before the pull answers
    expect(pulls).toBe(1); // the pull in flight was joined, not repeated
  });
});

describe("#914 r7: a socket's catch-ups never fetch the same pages at once over one busy link", () => {
  it("a reconnect while a catch-up is receiving waits for it, then pulls from where it ended", async () => {
    const w = network(0, { downMs: 1_000 }); // a slow downlink: a second per event
    for (let i = 1; i <= 10; i++) w.relay.store([event(`sib-${i}`, i, "laptop")]);
    const starts: string[] = [];
    const inner = w.net.fetch;
    vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/pull")) starts.push(url.searchParams.get("after_seq") ?? "");
      return inner(input, init);
    });
    const local = new InMemoryEventStore();
    const adapter = (): WebSocketEventStoreAdapter =>
      new WebSocketEventStoreAdapter({
        url: w.wsUrl,
        motebitId: MID,
        deviceId: "phone",
        httpFallback: new HttpEventStoreAdapter({ baseUrl: w.base, motebitId: MID }),
        localStore: local,
        onCatchUpError: () => {},
      });
    const a = adapter();
    a.connect();
    await vi.advanceTimersByTimeAsync(3_000); // A's catch-up is mid-body
    a.disconnect();
    const b = adapter(); // mobile's next cycle
    b.connect();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(starts).toEqual(["0"]); // B waits: the link is busy with A's pages
    await vi.advanceTimersByTimeAsync(20_000);
    expect(starts).toEqual(["0", "10"]); // then B pulls from where A ended
    expect((await local.query({})).length).toBe(10);
    b.disconnect();
  });
});

describe("#914 r7b: the upgrade re-push of a large log — relay-side cost and the socket rate limit", () => {
  // After upgrade the push cursor starts at 0, so the whole local log is
  // pushed once per push key. The relay stores each event_id once; this is
  // what the re-push COSTS it, and proof the socket stays under the relay's
  // 100 messages / 10 s per device.
  const N = 50_000;

  async function log(n = N): Promise<InMemoryEventStore> {
    const local = new InMemoryEventStore();
    for (let i = 1; i <= n; i++) await local.append(event(`big-${i}`, i));
    return local;
  }

  async function drain(engine: SyncEngine, done: () => boolean): Promise<number> {
    let syncs = 0;
    while (!done() && syncs < 100) {
      let over = false;
      void engine.sync().then(() => (over = true));
      // One sync cycle (30 s), then until the sync has ended.
      await vi.advanceTimersByTimeAsync(30_000);
      while (!over) await vi.advanceTimersByTimeAsync(1_000);
      syncs++;
    }
    return syncs;
  }

  it("socket: 50 000 events cross as frames of ≤ 500, never over 50 frames in any 10 s, no rate refusal, each event sent once", async () => {
    const w = network(0, { upMs: 1 });
    const sentAt: number[] = [];
    const Base = WebSocket as unknown as new (url: string) => { send(d: string): void };
    class Timed extends Base {
      override send(data: string): void {
        if (data.includes('"type":"push"')) sentAt.push(Date.now());
        super.send(data);
      }
    }
    vi.stubGlobal("WebSocket", Timed);
    const local = await log();
    const ws = new WebSocketEventStoreAdapter({ url: w.wsUrl, motebitId: MID, deviceId: "phone" });
    ws.connect();
    await vi.advanceTimersByTimeAsync(100);
    const engine = new SyncEngine(local, MID);
    engine.connectRemote(ws);
    const syncs = await drain(engine, () => engine.getCursor().last_version_clock === N);

    expect(w.relay.rows).toHaveLength(N); // stored once each
    const carried = w.frames.reduce((n, f) => n + f.length, 0);
    expect(carried).toBe(N); // no event sent twice
    expect(Math.max(...w.frames.map((f) => f.length))).toBeLessThanOrEqual(500);
    expect(w.frames.length).toBe(N / 500); // 100 relay messages for 50 000 events
    let peak = 0;
    for (let i = 0, j = 0; i < sentAt.length; i++) {
      while (sentAt[i]! - sentAt[j]! >= 10_000) j++;
      peak = Math.max(peak, i - j + 1);
    }
    expect(peak).toBeLessThanOrEqual(50); // half the relay's 100 / 10 s
    expect(w.relay.rateRefusals).toBe(0);
    expect(syncs).toBe(10); // 5 000 events per sync (MAX_PUSH_BATCHES_PER_SYNC × batch_size)
    ws.disconnect();
  }, 120_000);

  // HTTP carries one event per request, so its cost is linear in the log:
  // shown at 6 000 (two syncs) — 50 000 is 50 000 requests over 10 syncs.
  it("HTTP: a 6 000-event log crosses as 6 000 single-event requests over two syncs, each event sent once", async () => {
    const M = 6_000;
    const w = network(0, { upMs: 1 });
    let pushes = 0;
    const inner = w.net.fetch;
    vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) => {
      if (String(input).endsWith("/push")) pushes++;
      return inner(input, init);
    });
    const local = await log(M);
    const engine = new SyncEngine(local, MID);
    engine.connectRemote(new HttpEventStoreAdapter({ baseUrl: w.base, motebitId: MID }));
    const syncs = await drain(engine, () => engine.getCursor().last_version_clock === M);
    expect(w.relay.rows).toHaveLength(M);
    expect(pushes).toBe(M); // one request per event, none re-sent
    expect(syncs).toBe(2);
  }, 120_000);
});
