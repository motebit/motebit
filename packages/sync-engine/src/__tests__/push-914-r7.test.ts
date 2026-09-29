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
