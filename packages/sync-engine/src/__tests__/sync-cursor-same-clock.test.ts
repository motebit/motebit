/**
 * #868 characterization, now a regression test: an event another device of
 * the SAME identity published at an EQUAL `version_clock` is pulled.
 *
 * Before #868 the pull cursor was this device's own max clock. Device A
 * appended at clock N and pushed; device B independently published its own
 * event at clock N before A's next pull; A's next pull asked `after_clock=N`
 * and B's event was skipped forever (the #816 harness trace: the store held
 * evt-11:1011 and evt-12:1012, never in-11:1011 or in-12:1012, and every
 * later pull asked `after_clock=1012`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { InMemoryEventStore } from "@motebit/event-log";
import { EventType } from "@motebit/sdk";
import type { EventLogEntry } from "@motebit/sdk";
import { SyncEngine } from "../index.js";
import { HttpEventStoreAdapter } from "../http-adapter.js";
import { WebSocketEventStoreAdapter } from "../ws-adapter.js";
import { FakeRelay } from "./fake-relay.js";

const MID = "motebit-868";

function entry(id: string, clock: number, device: string): EventLogEntry {
  return {
    event_id: id,
    motebit_id: MID as EventLogEntry["motebit_id"],
    device_id: device,
    timestamp: 1_700_000_000_000 + clock,
    event_type: EventType.StateUpdated,
    payload: { from: device },
    version_clock: clock,
    tombstoned: false,
  };
}

async function ids(store: InMemoryEventStore): Promise<string[]> {
  return (await store.query({ motebit_id: MID as EventLogEntry["motebit_id"] }))
    .map((e) => e.event_id)
    .sort();
}

describe("#868 same-clock sync loss", () => {
  let relay: FakeRelay;
  beforeEach(() => {
    relay = new FakeRelay();
    vi.stubGlobal("fetch", relay.fetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function device(): { store: InMemoryEventStore; engine: SyncEngine } {
    const store = new InMemoryEventStore();
    const engine = new SyncEngine(store, MID);
    engine.connectRemote(
      new HttpEventStoreAdapter({ baseUrl: relay.baseUrl, motebitId: MID, maxRetries: 0 }),
    );
    return { store, engine };
  }

  it("the #816 trace: evt-11/evt-12 here, in-11/in-12 from a sibling at the same clocks — all four are held after the next pull", async () => {
    const A = device();
    await A.store.append(entry("evt-11", 1011, "mobile"));
    await A.store.append(entry("evt-12", 1012, "mobile"));
    await A.engine.sync(); // pushes evt-11, evt-12; cursor clock → 1012

    // The sibling device of the same identity publishes at the SAME clocks.
    relay.ingest(entry("in-11", 1011, "desktop"));
    relay.ingest(entry("in-12", 1012, "desktop"));

    const r = await A.engine.sync();
    expect(r.pulled).toBe(2);
    expect(await ids(A.store)).toEqual(["evt-11", "evt-12", "in-11", "in-12"]);

    // The pull asked by seq; the clock rides along only as a fallback.
    const last = relay.pulls[relay.pulls.length - 1]!;
    expect(last.searchParams.get("after_seq")).not.toBeNull();
  });

  it("two devices, equal clock, both sync in either order: each ends with both events", async () => {
    const A = device();
    const B = device();
    await A.store.appendWithClock!({ ...entry("a-1", 0, "a") });
    await B.store.appendWithClock!({ ...entry("b-1", 0, "b") });
    // Both hold clock 1.
    await A.engine.sync(); // A pushes a-1
    await B.engine.sync(); // B pushes b-1, pulls a-1
    await A.engine.sync(); // A pulls b-1 — at A's own max clock (1)
    expect(await ids(A.store)).toEqual(["a-1", "b-1"]);
    expect(await ids(B.store)).toEqual(["a-1", "b-1"]);
  });

  it("the socket catch-up pulls by seq too: a same-clock sibling event missed while offline reaches the store and the listeners once", async () => {
    const store = new InMemoryEventStore();
    const http = new HttpEventStoreAdapter({
      baseUrl: relay.baseUrl,
      motebitId: MID,
      maxRetries: 0,
    });
    await store.append(entry("mine-5", 5, "a"));
    relay.ingest(entry("mine-5", 5, "a"));
    relay.ingest(entry("theirs-5", 5, "b")); // same clock, never seen here

    class FakeSocket {
      static instances: FakeSocket[] = [];
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(readonly url: string) {
        FakeSocket.instances.push(this);
      }
      send(): void {}
      close(): void {}
    }
    vi.stubGlobal("WebSocket", FakeSocket);
    const seen: string[] = [];
    let caughtUp = -1;
    const ws = new WebSocketEventStoreAdapter({
      url: "ws://relay.fake/ws/sync/" + MID,
      motebitId: MID,
      httpFallback: http,
      localStore: store,
      onCatchUp: (n) => (caughtUp = n),
    });
    ws.onEvent((e) => seen.push(e.event_id));
    ws.connect();
    FakeSocket.instances[0]!.onopen?.();
    await vi.waitFor(() => expect(caughtUp).toBe(1));
    expect(await ids(store)).toEqual(["mine-5", "theirs-5"]);
    expect(seen).toEqual(["theirs-5"]); // the held event is not re-announced
    ws.disconnect();
  });
});
