/**
 * Differential probe for #914: the sync PUSH cursor.
 *
 *   pnpm tsx scripts/differential-vs-main.ts \
 *     --probe packages/sync-engine/src/__tests__/push-cursor-914.probe.ts --pkg packages/sync-engine
 *
 * The real client (`SyncEngine`, `HttpEventStoreAdapter`,
 * `WebSocketEventStoreAdapter` from each tree's own source) against a minimal
 * in-probe relay that stores by event_id, as the real relay does. Only
 * surfaces present on both trees are used.
 *
 * Expected:
 *   - DIFF probeA: an event appended while sync() awaits its pull — main never
 *     pushes it; head does.
 *   - DIFF probeB: a restart with 5 unpushed events and batch_size 2 — main
 *     pushes x0,x1 only, ever; head pushes all five.
 *   - DIFF socketAppendSettlesBeforeAck: main's socket append resolves when the
 *     frame is sent; head's waits for the relay's ack.
 *   - SAME plainPush: one event, one sync — both deliver it.
 */
import { it, afterAll, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { InMemoryEventStore } from "@motebit/event-log";
import type { EventLogEntry } from "@motebit/sdk";
import { SyncEngine, HttpEventStoreAdapter, WebSocketEventStoreAdapter } from "../index.js";

const MID = "motebit-probe-914";
const obs: Record<string, unknown> = {};

afterAll(() => {
  writeFileSync(process.env["PROBE_OUT"]!, JSON.stringify(obs, null, 2));
});

/** A relay that stores pushed events by event_id and serves the clock pull. */
function miniRelay(onPull?: () => Promise<void>) {
  const held: EventLogEntry[] = [];
  const fetchImpl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/push")) {
      const body = JSON.parse(init!.body as string) as { events: EventLogEntry[] };
      for (const e of body.events) {
        if (!held.some((h) => h.event_id === e.event_id)) held.push(e);
      }
      return Response.json({ accepted: body.events.length });
    }
    if (url.pathname.endsWith("/pull")) {
      if (onPull) await onPull();
      const after = Number(url.searchParams.get("after_clock") ?? "0");
      return Response.json({ events: held.filter((e) => e.version_clock > after) });
    }
    return Response.json({ latest_clock: 0 });
  };
  return { held, fetchImpl, ids: () => held.map((e) => e.event_id).sort() };
}

async function write(store: InMemoryEventStore, id: string): Promise<void> {
  await store.appendWithClock({
    event_id: id,
    motebit_id: MID as EventLogEntry["motebit_id"],
    timestamp: 1_700_000_000_000,
    event_type: "state_updated" as EventLogEntry["event_type"],
    payload: { id },
    tombstoned: false,
  });
}

function http(): HttpEventStoreAdapter {
  return new HttpEventStoreAdapter({
    baseUrl: "http://relay.probe",
    motebitId: MID,
    maxRetries: 0,
  });
}

it("probeA: an event appended while sync() awaits its pull", async () => {
  const local = new InMemoryEventStore();
  let armed = true;
  const relay = miniRelay(async () => {
    if (!armed) return;
    armed = false;
    await write(local, "during");
  });
  vi.stubGlobal("fetch", relay.fetchImpl);
  const engine = new SyncEngine(local, MID);
  engine.connectRemote(http());
  await write(local, "before");
  for (let i = 0; i < 3; i++) await engine.sync();
  obs["probeA.relayHolds"] = relay.ids();
  vi.unstubAllGlobals();
});

it("probeB: a restart with a backlog larger than batch_size", async () => {
  const relay = miniRelay();
  vi.stubGlobal("fetch", relay.fetchImpl);
  const local = new InMemoryEventStore();
  for (let i = 0; i < 5; i++) await write(local, `x${i}`);
  const engine = new SyncEngine(local, MID, { batch_size: 2 });
  engine.connectRemote(http());
  for (let i = 0; i < 3; i++) await engine.sync();
  obs["probeB.relayHolds"] = relay.ids();
  vi.unstubAllGlobals();
});

it("plainPush: one event, one sync", async () => {
  const relay = miniRelay();
  vi.stubGlobal("fetch", relay.fetchImpl);
  const local = new InMemoryEventStore();
  await write(local, "only");
  const engine = new SyncEngine(local, MID);
  engine.connectRemote(http());
  await engine.sync();
  obs["plainPush.relayHolds"] = relay.ids();
  vi.unstubAllGlobals();
});

it("socketAppendSettlesBeforeAck: does a socket append resolve before the relay acks?", async () => {
  class Sock {
    readyState = 1;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    sent: string[] = [];
    constructor(public url: string) {}
    send(d: string): void {
      this.sent.push(d);
    }
    close(): void {
      this.readyState = 3;
    }
  }
  let socket: Sock | null = null;
  const Ctor = function (this: unknown, url: string) {
    socket = new Sock(url);
    return socket;
  } as unknown as typeof WebSocket;
  vi.stubGlobal("WebSocket", Ctor);
  const ws = new WebSocketEventStoreAdapter({ url: "ws://relay.probe/ws/sync/x", motebitId: MID });
  ws.connect();
  (socket as unknown as Sock).onopen?.();
  let settled = false;
  const p = ws.append({
    event_id: "s",
    motebit_id: MID as EventLogEntry["motebit_id"],
    timestamp: 0,
    event_type: "state_updated" as EventLogEntry["event_type"],
    payload: {},
    version_clock: 1,
    tombstoned: false,
  });
  p.then(
    () => (settled = true),
    () => (settled = true),
  );
  await new Promise((r) => setTimeout(r, 20));
  obs["socketAppendSettlesBeforeAck"] = settled;
  ws.disconnect();
  vi.unstubAllGlobals();
});
