/**
 * #914 round 7 — the differential liveness harness.
 *
 * Three rounds in a row, a deadline added for #914 killed work main would
 * have completed on a slow link. This harness is the method that ends that:
 * every cell runs the BRANCH (the real SyncEngine + real adapters) and a
 * faithful MODEL OF MAIN's transport (fire-and-forget socket sends, unbounded
 * HTTP, main's engine loop) over the same simulated network (sim-net.ts,
 * fake timers), and asserts:
 *
 *   1. the branch delivers at least as many events as main within the horizon;
 *   2. when main delivers everything, the branch does too;
 *   3. the branch's push cursor never passes an event the relay does not hold;
 *   4. the branch never sends an event on the socket while a frame carrying
 *      it is still in flight;
 *   5. an acknowledgment moves the branch's cursor whenever it arrives: a
 *      quiet L + 15 min after the horizon, the cursor has passed every event
 *      the relay held at the horizon (push cells).
 *
 * Dimensions:
 *   - direction: push (the device's own events) or pull (a sibling's)
 *   - per-event link time u (the uplink for push, the downlink for pull)
 *   - relay latency L: push ack / push response / pull headers — the relay
 *     STORES on arrival and answers late
 *   - lifecycle: persistent socket + liveAdapter + token swap every 4.5 min
 *     (desktop, web, spatial); socket rebuilt every 30 s with its HTTP
 *     catch-up (mobile); HTTP every 30 s (CLI, daemon)
 *   - fetch/AbortController flavour: Node, or React Native (whatwg-fetch over
 *     XHR + react-native's abort-controller@3.0.0)
 *   - backlog: 1, 150, 6000 events (plus one new event every max(5 min, 2u))
 *
 * Split across liveness-914-s<k>.test.ts so the shards run in parallel.
 *
 * What runs. By default (`pnpm test`) a GRID of about ninety cells that
 * keeps every dimension (see `gridCells`): the boundary values of the link
 * and the relay (u 0.01 s and 16 s — just past the 15 s ack deadline —
 * crossed with L 0 and 300 s, on every door), a deterministic sample of the
 * rest (u ≤ 70 s), and every cell that went red while the round-7 design was
 * built (`REGRESSIONS`). MOTEBIT_LIVENESS_FULL=1 runs the whole sweep (730
 * cells; the u = 200 and 900 s cells simulate up to 250 hours each, so it
 * takes one to two hours — run it on demand, not in CI; give it a larger
 * heap, NODE_OPTIONS=--max-old-space-size=16384: the model of main never
 * joins a sync, so on a 900 s/event link it holds thousands of overlapping
 * syncs, and the default heap runs out).
 * MOTEBIT_LIVENESS_CELL='a|b' runs the cells whose names contain a or b
 * (with MOTEBIT_LIVENESS_EXACT=1, whose names ARE a or b);
 * MOTEBIT_LIVENESS_VERBOSE prints every cell's counts, _TIMING its wall
 * time, _TRACE a wire timeline (sim-net.ts).
 *
 * Time. Fake timers throughout: `runFor` advances simulated time in
 * ten-minute jumps (`advanceTimersByTimeAsync`), each firing only the timers
 * due in it. A cell's cost is the number of timer callbacks over its horizon,
 * never real time.
 *
 * Horizon H = max(10 × u × batch, 30 min) of simulated time. Excluded, as
 * stated: a cell where one event cannot cross within 64 × the base deadline.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { InMemoryEventStore } from "@motebit/event-log";
import type { EventStoreAdapter } from "@motebit/event-log";
import { EventType } from "@motebit/sdk";
import type { EventLogEntry } from "@motebit/sdk";
import {
  SyncEngine,
  HttpEventStoreAdapter,
  WebSocketEventStoreAdapter,
  liveAdapter,
} from "../index.js";
import { SimNet, SimRelay, trace } from "./sim-net.js";

const MID = "motebit-harness-914";
/** Wall-clock time, captured before any cell fakes the timers. */
const realNow = performance.now.bind(performance);
const S = 1000;
const MIN = 60 * S;
const BATCH = 100;
const WS_BASE = 15 * S; // the socket's ack deadline
const HTTP_BASE = 20 * S; // the HTTP request deadline

type Direction = "push" | "pull";
/**
 * `steady-ws` (fault cells only): a persistent socket that is never swapped
 * — no token refresh within the horizon (a long-lived credential, the
 * daemon) — so no retirement ever ends a frame the relay dropped.
 */
type Lifecycle = "persistent-ws" | "rebuild-ws" | "http" | "steady-ws";
type Flavour = "node" | "rn";

export interface Cell {
  dir: Direction;
  life: Lifecycle;
  flavour: Flavour;
  /** Per-event link time, seconds. */
  u: number;
  /** Relay latency, seconds. */
  L: number;
  backlog: number;
  /**
   * The relay is black-holed for the first OUTAGE_MS (every HTTP request
   * accepted and never answered — a dead connection), then recovers; the
   * horizon ends RECOVERY_MS after. The cell asks: does the branch deliver
   * within a few cycles of recovery, as main (which never joins a request
   * and so sends afresh every cycle) does?
   */
  outage?: true;
  /** A relay that misbehaves (#914 round 8) — see `Fault`. */
  fault?: Fault;
}

/**
 * The relay fault model (#914 round 8). A well-behaved relay always stores,
 * answers and echoes; these are the ways a real one does not:
 *
 *   drop-first     the relay silently discards the FIRST push frame (window
 *                  1, before any echo): no ack, no error
 *   drop-mid       it discards the THIRD frame — mid-stream, after the echo
 *                  was seen, with the window at 16
 *   old-drop       a relay older than round 7 (never echoes `push_id`)
 *                  discards the third frame
 *   rollback-drop  echoes are seen, then at 10 min the relay restarts as
 *                  the no-echo version (every socket closed) and discards
 *                  the first frame it receives after that
 *   rollback-burst the same restart, at 40 s — mid-backlog, while the
 *                  echo hint still opens the window: frames overlap on the
 *                  no-echo relay, so an ack that names no frame could be
 *                  credited to the dropped one
 *   switch-fresh   the device pulls from relay A, then at 5 min a FRESH
 *                  engine every 30 s (mobile `syncNow`) syncs with relay B
 *   switch-repoint the same, but one engine re-pointed at B
 *
 * The drop faults run with sibling traffic on every socket (an event every
 * 60 s), so an unanswered frame's socket never looks dead. In every fault
 * cell the relay answers everything else, so a correct client delivers
 * EVERY event (to B, in the switch cells) — a stronger oracle than
 * main-relative, which a fire-and-forget main that loses the dropped frame
 * by construction could never make red.
 */
type Fault =
  | "drop-first"
  | "drop-mid"
  | "old-drop"
  | "rollback-drop"
  | "rollback-burst"
  | "switch-fresh"
  | "switch-repoint";

// 47.5 min: the last live event (45 min; 47 on the steady socket) has time to cross.
const FAULT_HORIZON_MS = 47.5 * 60 * 1000;
const SWITCH_AT_MS = 5 * 60 * 1000;

const OUTAGE_MS = 10 * 60 * 1000;
const RECOVERY_MS = 3 * 60 * 1000;

export interface Outcome {
  delivered: number;
  total: number;
  cursorSafe: boolean;
  /**
   * Pushes that re-sent an event while a push carrying it was still on the
   * wire and live (branch): socket frames, and HTTP requests except the one
   * exception below. Must be 0.
   */
  resentInFlight?: number;
  /**
   * The stated EXCEPTION (#914 r7b): HTTP pushes that re-sent an event while
   * every request carrying it was black-holed — the hedged second attempt,
   * started only after a deadline miss AND a probe the relay answers.
   * Allowed only in outage cells; must be 0 everywhere else.
   */
  resentHung?: number;
  /**
   * The push cursor reached, within a quiet L + 15 min after the horizon,
   * every event the relay held at the horizon (branch; push cells).
   */
  cursorLive?: boolean;
}

let cellNo = 0;

function event(id: string, clock: number, device: string): EventLogEntry {
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

export function horizonMs(c: Cell): number {
  if (c.outage) return OUTAGE_MS + RECOVERY_MS;
  if (c.fault) return FAULT_HORIZON_MS;
  return Math.max(10 * c.u * S * BATCH, 30 * MIN);
}

/** The stated exclusion: one event cannot cross within 64 × the base deadline. */
export function excluded(c: Cell): boolean {
  const base = c.life === "http" || c.dir === "pull" ? HTTP_BASE : WS_BASE;
  return (c.u + c.L) * S > 64 * base;
}

// ---------------------------------------------------------------------------
// The world a cell runs in
// ---------------------------------------------------------------------------

interface World {
  net: SimNet;
  relay: SimRelay;
  local: InMemoryEventStore;
  base: string; // HTTP origin
  wsUrl: string;
  /** Own ids (push) or sibling ids (pull) to deliver. */
  targets: string[];
  stop: Array<() => void>;
}

function world(c: Cell): World {
  const n = ++cellNo;
  const relay = new SimRelay(MID, c.L * S);
  const net = new SimNet(relay, {
    upMs: c.dir === "push" ? c.u * S : 10,
    downMs: c.dir === "pull" ? c.u * S : 10,
  });
  if (c.outage) net.blackholeUntil = Date.now() + OUTAGE_MS;
  const stop: Array<() => void> = [];
  if (c.fault === "drop-first") relay.dropFrame = (k) => k === 1;
  if (c.fault === "drop-mid") relay.dropFrame = (k) => k === 3;
  if (c.fault === "old-drop") {
    relay.echoes = false;
    relay.dropFrame = (k) => k === 3;
  }
  if (c.fault === "rollback-drop" || c.fault === "rollback-burst") {
    const t = setTimeout(
      () => {
        relay.echoes = false;
        const after = relay.pushFramesSeen;
        relay.dropFrame = (k) => k === after + 1;
        net.restart();
      },
      c.fault === "rollback-burst" ? 40 * S : 10 * MIN,
    );
    stop.push(() => clearTimeout(t));
  }
  if (c.fault && !c.fault.startsWith("switch")) stop.push(net.inboundEvery(60 * S));
  const local = new InMemoryEventStore();
  const base = `http://relay${n}.harness`;
  const wsUrl = `ws://relay${n}.harness/ws/sync/${MID}`;
  vi.stubGlobal("WebSocket", net.socketClass());
  if (c.flavour === "rn") net.installReactNative();
  else vi.stubGlobal("fetch", net.fetch);
  return { net, relay, local, base, wsUrl, targets: [], stop };
}

/**
 * New events arrive every 5 min — or every 2 × u on a link slower than that,
 * so the steady-state load never exceeds what the link can carry at all
 * (a link oversubscribed forever measures nothing but its queue).
 */
export function liveEveryMs(c: Cell): number {
  // The steady socket gets a new event every minute: its relay keeps
  // answering pushes, so its socket never looks unanswered — only the
  // OVERTAKEN rule can find the frame the relay dropped.
  if (c.life === "steady-ws") return MIN;
  return Math.max(5 * MIN, 2 * c.u * S);
}

/** Seed the backlog and schedule the live events. */
async function seed(w: World, c: Cell): Promise<void> {
  let clock = 0;
  if (c.dir === "push") {
    for (let i = 0; i < c.backlog; i++) {
      const id = `own-${i}`;
      w.targets.push(id);
      await w.local.append(event(id, ++clock, "phone"));
    }
    let k = 0;
    const t = setInterval(() => {
      const id = `own-live-${k++}`;
      w.targets.push(id);
      void w.local.appendWithClock({
        event_id: id,
        motebit_id: MID as EventLogEntry["motebit_id"],
        device_id: "phone",
        timestamp: Date.now(),
        event_type: EventType.StateUpdated,
        payload: { id },
        tombstoned: false,
      });
    }, liveEveryMs(c));
    w.stop.push(() => clearInterval(t));
  } else {
    for (let i = 0; i < c.backlog; i++) {
      const id = `sib-${i}`;
      w.targets.push(id);
      w.relay.store([event(id, ++clock, "laptop")]);
    }
    let k = 0;
    const t = setInterval(() => {
      const id = `sib-live-${k++}`;
      w.targets.push(id);
      w.relay.store([event(id, ++clock, "laptop")]);
    }, liveEveryMs(c));
    w.stop.push(() => clearInterval(t));
  }
}

async function measure(w: World, c: Cell, pushCursor?: number): Promise<Outcome> {
  let delivered = 0;
  if (c.dir === "push") {
    for (const id of w.targets) if (w.relay.holds(id)) delivered++;
  } else {
    const held = new Set((await w.local.query({})).map((e) => e.event_id));
    for (const id of w.targets) if (held.has(id)) delivered++;
  }
  let cursorSafe = true;
  if (pushCursor !== undefined) {
    const mine = await w.local.query({ motebit_id: MID });
    for (const e of mine) {
      if (e.device_id === "phone" && e.version_clock <= pushCursor && !w.relay.holds(e.event_id)) {
        cursorSafe = false;
      }
    }
  }
  return { delivered, total: w.targets.length, cursorSafe };
}

async function runFor(ms: number): Promise<void> {
  const step = 10 * MIN;
  for (let t = 0; t < ms; t += step) {
    trace(`--- t=${t / 1000}s of ${ms / 1000}s`);
    await vi.advanceTimersByTimeAsync(Math.min(step, ms - t));
  }
}

// ---------------------------------------------------------------------------
// The model of main's transport and engine
// ---------------------------------------------------------------------------

/** Main's socket adapter: fire-and-forget; a frame sent on a closed socket is dropped. */
class MainSocket {
  ws: WebSocket | null = null;
  connected = false;
  pending: EventLogEntry[] = [];
  constructor(
    private url: string,
    private onConnected: () => void,
  ) {}
  private retired = false;
  connect(): void {
    const ws = new WebSocket(this.url + "?device_id=phone");
    this.ws = ws;
    // Main's adapter reconnects after a close it did not ask for.
    ws.onclose = () => {
      this.connected = false;
      if (!this.retired) setTimeout(() => !this.retired && this.connect(), 1_000);
    };
    ws.onopen = () => {
      this.connected = true;
      if (this.pending.length > 0)
        ws.send(JSON.stringify({ type: "push", events: this.pending.splice(0) }));
      this.onConnected();
    };
  }
  disconnect(): void {
    this.retired = true;
    this.ws?.close();
    this.ws = null;
    this.connected = false;
  }
  append(e: EventLogEntry): Promise<void> {
    if (this.connected && this.ws) {
      if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ type: "push", events: [e] }));
    } else {
      this.pending.push(e);
    }
    return Promise.resolve();
  }
}

/** Main's seq pull: unbounded, whole pages. */
async function mainPull(w: World, cursor: { seq: number }, base = w.base): Promise<void> {
  for (;;) {
    const res = await fetch(`${base}/sync/${MID}/pull?after_seq=${cursor.seq}&after_clock=0`);
    const body = (await res.json()) as {
      events: Array<EventLogEntry & { seq: number }>;
      next_seq: number;
      has_more: boolean;
    };
    for (const e of body.events) {
      const { seq: _s, ...entry } = e;
      await w.local.append(entry);
    }
    if (body.next_seq > cursor.seq) cursor.seq = body.next_seq;
    if (!body.has_more) break;
  }
}

async function runMain(c: Cell): Promise<Outcome> {
  const w = world(c);
  await seed(w, c);
  const pull = { seq: 0 };
  let cursor = 0;
  let remote: { append(e: EventLogEntry): Promise<void>; pull(): Promise<void> };
  const catchUp = (): void => void mainPull(w, pull).catch(() => {});
  let sock: MainSocket | null = null;
  const socketRemote = {
    append: (e: EventLogEntry) => sock!.append(e),
    pull: () => Promise.resolve(),
  };
  if (c.life === "http") {
    remote = {
      append: async (e) => {
        const res = await fetch(`${w.base}/sync/${MID}/push`, {
          method: "POST",
          body: JSON.stringify({ events: [e] }),
        });
        if (!res.ok) throw new Error("push failed");
        await res.text();
      },
      pull: () => mainPull(w, pull),
    };
  } else {
    remote = socketRemote;
  }
  // Main's engine: every 30 s a sync, never joined, never bounded.
  const sync = (): void => {
    void (async () => {
      try {
        const evs = await w.local.query({
          motebit_id: MID,
          after_version_clock: cursor,
          limit: BATCH,
        });
        for (const e of evs) await remote.append(e);
        await remote.pull();
        cursor = await w.local.getLatestClock(MID);
      } catch {
        // main: status error, cursor unchanged
      }
    })();
  };
  if (c.life === "persistent-ws" || c.life === "steady-ws") {
    sock = new MainSocket(w.wsUrl, catchUp);
    sock.connect();
    const tick = setInterval(sync, 30 * S);
    const swap = setInterval(() => {
      if (c.life === "steady-ws") return;
      const old = sock!;
      old.disconnect();
      const fresh = new MainSocket(w.wsUrl, catchUp);
      for (const e of old.pending.splice(0)) void fresh.append(e);
      sock = fresh;
      fresh.connect();
    }, 4.5 * MIN);
    w.stop.push(() => (clearInterval(tick), clearInterval(swap), sock?.disconnect()));
  } else if (c.life === "rebuild-ws") {
    const cycle = (): void => {
      sock?.disconnect();
      sock = new MainSocket(w.wsUrl, catchUp);
      sock.connect();
      sync();
    };
    const first = setTimeout(cycle, 3 * S);
    const tick = setInterval(cycle, 30 * S);
    w.stop.push(() => (clearTimeout(first), clearInterval(tick), sock?.disconnect()));
  } else {
    const tick = setInterval(sync, 30 * S);
    w.stop.push(() => clearInterval(tick));
  }
  await runFor(horizonMs(c));
  const out = await measure(w, c);
  for (const s of w.stop) s();
  return out;
}

// ---------------------------------------------------------------------------
// The branch: the real engine and adapters, wired as each surface wires them
// ---------------------------------------------------------------------------

function httpAdapter(w: World): HttpEventStoreAdapter {
  return new HttpEventStoreAdapter({ baseUrl: w.base, motebitId: MID });
}

function socketAdapter(w: World): WebSocketEventStoreAdapter {
  return new WebSocketEventStoreAdapter({
    url: w.wsUrl,
    motebitId: MID,
    deviceId: "phone",
    httpFallback: httpAdapter(w),
    localStore: w.local,
    onCatchUpError: () => {},
    onSkippedEvent: () => {},
  });
}

async function runBranch(c: Cell): Promise<Outcome> {
  const w = world(c);
  await seed(w, c);
  const engine = new SyncEngine(w.local, MID, { onSkippedEvent: () => {} });
  if (c.life === "persistent-ws" || c.life === "steady-ws") {
    let current = socketAdapter(w);
    engine.connectRemote(liveAdapter(() => current as EventStoreAdapter));
    current.connect();
    engine.start();
    const swap = setInterval(() => {
      if (c.life === "steady-ws") return;
      const replaced = current;
      replaced.disconnect();
      const fresh = socketAdapter(w);
      for (const e of replaced.takePendingEvents()) void fresh.append(e).catch(() => {});
      current = fresh;
      fresh.connect();
    }, 4.5 * MIN);
    w.stop.push(() => (clearInterval(swap), engine.stop(), current.disconnect()));
  } else if (c.life === "rebuild-ws") {
    let current: WebSocketEventStoreAdapter | null = null;
    const cycle = (): void => {
      current?.disconnect();
      current = socketAdapter(w);
      engine.connectRemote(current);
      current.connect();
      void engine.sync();
    };
    const first = setTimeout(cycle, 3 * S);
    const tick = setInterval(cycle, 30 * S);
    w.stop.push(() => (clearTimeout(first), clearInterval(tick), current?.disconnect()));
  } else {
    engine.connectRemote(httpAdapter(w));
    engine.start();
    w.stop.push(() => engine.stop());
  }
  await runFor(horizonMs(c));
  const out = await measure(w, c, engine.getCursor().last_version_clock);
  out.resentInFlight = w.net.resentInFlight + w.net.httpResentLive;
  out.resentHung = w.net.httpResentHung;
  if (c.dir === "push") {
    // An acknowledgment moves the cursor whenever it arrives: every event
    // the relay held at the horizon is acknowledged within L, so a quiet
    // L + 15 min later the cursor has passed them all.
    const frontier = await heldFrontier(w);
    await runFor(c.L * S + 15 * MIN);
    out.cursorLive = engine.getCursor().last_version_clock >= frontier;
  }
  for (const s of w.stop) s();
  return out;
}

/** The largest clock at or below which the relay holds every one of the device's own events. */
async function heldFrontier(w: World): Promise<number> {
  const mine = (await w.local.query({ motebit_id: MID }))
    .filter((e) => e.device_id === "phone")
    .sort((a, b) => a.version_clock - b.version_clock);
  let frontier = 0;
  for (const e of mine) {
    if (!w.relay.holds(e.event_id)) break;
    frontier = e.version_clock;
  }
  return frontier;
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

const U = [0.01, 0.2, 1, 5, 14, 16, 20, 30, 45, 70, 200, 900];
const LAT = [0, 10, 20, 70, 300];
const LIVES: Lifecycle[] = ["persistent-ws", "rebuild-ws", "http"];

export function sweep(): Cell[] {
  const cells: Cell[] = [];
  const add = (c: Cell): void => {
    if (!excluded(c)) cells.push(c);
  };
  // Push: every u × L × lifecycle at backlog 150 (Node), the whole u × L at
  // backlog 1 and 6000 on the persistent socket and HTTP, and React Native
  // on the two lifecycles that use its fetch (mobile's catch-up and syncNow).
  for (const u of U) {
    for (const L of LAT) {
      for (const life of LIVES) add({ dir: "push", life, flavour: "node", u, L, backlog: 150 });
      for (const backlog of [1, 6000]) {
        add({ dir: "push", life: "persistent-ws", flavour: "node", u, L, backlog });
        add({ dir: "push", life: "http", flavour: "node", u, L, backlog });
      }
      add({ dir: "push", life: "http", flavour: "rn", u, L, backlog: 150 });
      // Pull: the downlink swept, each lifecycle's pull door.
      for (const life of LIVES) add({ dir: "pull", life, flavour: "node", u, L, backlog: 150 });
      add({ dir: "pull", life: "rebuild-ws", flavour: "rn", u, L, backlog: 150 });
      add({ dir: "pull", life: "http", flavour: "rn", u, L, backlog: 150 });
    }
  }
  // The relay fault model (#914 round 8): a dropped frame, an old relay, a
  // rollback — on both socket lifecycles — and a relay switch.
  for (const fault of [
    "drop-first",
    "drop-mid",
    "old-drop",
    "rollback-drop",
    "rollback-burst",
  ] as const) {
    for (const life of ["persistent-ws", "rebuild-ws"] as const) {
      add({ dir: "push", life, flavour: "node", u: 0.01, L: 0, backlog: 6000, fault });
    }
  }
  // A mid-stream drop on a socket nothing ever retires, whose relay keeps
  // answering (a new event a minute): the socket never looks unanswered, so
  // only the OVERTAKEN rule (a later frame answered by push_id) finds the
  // lost frame.
  add({
    dir: "push",
    life: "steady-ws",
    flavour: "node",
    u: 0.01,
    L: 0,
    backlog: 1,
    fault: "drop-mid",
  });
  add({
    dir: "push",
    life: "http",
    flavour: "node",
    u: 0.2,
    L: 0,
    backlog: 50,
    fault: "switch-fresh",
  });
  add({
    dir: "push",
    life: "http",
    flavour: "node",
    u: 0.2,
    L: 0,
    backlog: 50,
    fault: "switch-repoint",
  });
  add({
    dir: "push",
    life: "persistent-ws",
    flavour: "node",
    u: 0.2,
    L: 0,
    backlog: 50,
    fault: "switch-repoint",
  });
  // An outage (a black-holed relay) on the HTTP doors, push and pull, both flavours.
  for (const flavour of ["node", "rn"] as const) {
    for (const dir of ["push", "pull"] as const) {
      add({ dir, life: "http", flavour, u: 0.2, L: 0, backlog: 1, outage: true });
    }
  }
  return cells;
}

// ---------------------------------------------------------------------------
// The relay switch (#914 round 8, R4): pull from A, then sync with B
// ---------------------------------------------------------------------------

/**
 * The device's own backlog is already on relay A, with 20 siblings' events.
 * It syncs with A (so it pulls everything back), then at SWITCH_AT_MS turns
 * to relay B: a fresh engine every 30 s (`switch-fresh`, mobile `syncNow`),
 * or its engine re-pointed (`switch-repoint`). Delivered = what B holds.
 */
async function runSwitch(c: Cell, side: "main" | "branch"): Promise<Outcome> {
  const w = world(c);
  const relayB = new SimRelay(MID, c.L * S);
  const hostB = `relayb${cellNo}.harness`; // URL hosts are lower-case
  w.net.hosts.set(hostB, relayB);
  const baseB = `http://${hostB}`;
  const wsB = `ws://${hostB}/ws/sync/${MID}`;
  let clock = 0;
  for (let i = 0; i < c.backlog; i++) {
    const e = event(`own-${i}`, ++clock, "phone");
    w.targets.push(e.event_id);
    await w.local.append(e);
    w.relay.store([e]);
  }
  for (let i = 0; i < 20; i++) {
    const e = event(`sib-${i}`, ++clock, "laptop");
    w.targets.push(e.event_id);
    w.relay.store([e]);
  }
  let k = 0;
  const live = setInterval(() => {
    const id = `own-live-${k++}`;
    w.targets.push(id);
    void w.local.appendWithClock({
      event_id: id,
      motebit_id: MID as EventLogEntry["motebit_id"],
      device_id: "phone",
      timestamp: Date.now(),
      event_type: EventType.StateUpdated,
      payload: { id },
      tombstoned: false,
    });
  }, 5 * MIN);
  w.stop.push(() => clearInterval(live));
  let cursorOf: () => number = () => 0;

  if (side === "main") {
    // Main: push after an in-memory cursor (BATCH at a time), pull, cursor = local max.
    const mainEngine = (): { base: string; cursor: number; pull: { seq: number } } => ({
      base: w.base,
      cursor: 0,
      pull: { seq: 0 },
    });
    const syncMain = (m: { base: string; cursor: number; pull: { seq: number } }): void => {
      void (async () => {
        try {
          const evs = await w.local.query({
            motebit_id: MID,
            after_version_clock: m.cursor,
            limit: BATCH,
          });
          for (const e of evs) {
            const res = await fetch(`${m.base}/sync/${MID}/push`, {
              method: "POST",
              body: JSON.stringify({ events: [e] }),
            });
            await res.text();
          }
          await mainPull(w, m.pull, m.base);
          m.cursor = await w.local.getLatestClock(MID);
        } catch {
          // main: cursor unchanged
        }
      })();
    };
    const m = mainEngine();
    let tick = setInterval(() => syncMain(m), 30 * S);
    const sw = setTimeout(() => {
      if (c.fault === "switch-repoint") {
        m.base = baseB;
        m.pull = { seq: 0 };
      } else {
        clearInterval(tick);
        tick = setInterval(() => {
          const fresh = mainEngine();
          fresh.base = baseB;
          syncMain(fresh);
        }, 30 * S);
      }
    }, SWITCH_AT_MS);
    w.stop.push(() => (clearInterval(tick), clearTimeout(sw)));
  } else {
    const http = (base: string): HttpEventStoreAdapter =>
      new HttpEventStoreAdapter({ baseUrl: base, motebitId: MID });
    const opts = { onSkippedEvent: (): void => {} };
    const engine = new SyncEngine(w.local, MID, opts);
    cursorOf = () => engine.getCursor().last_version_clock;
    let current: WebSocketEventStoreAdapter | null = null;
    const ws = (url: string, base: string): WebSocketEventStoreAdapter =>
      new WebSocketEventStoreAdapter({
        url,
        motebitId: MID,
        deviceId: "phone",
        httpFallback: http(base),
        localStore: w.local,
        onCatchUpError: () => {},
        onSkippedEvent: () => {},
      });
    if (c.life === "persistent-ws") {
      current = ws(w.wsUrl, w.base);
      engine.connectRemote(liveAdapter(() => current as EventStoreAdapter));
      current.connect();
    } else {
      engine.connectRemote(http(w.base));
    }
    engine.start();
    let freshTick: ReturnType<typeof setInterval> | null = null;
    const sw = setTimeout(() => {
      if (c.fault === "switch-repoint") {
        if (current) {
          current.disconnect();
          current = ws(wsB, baseB);
          engine.connectRemote(liveAdapter(() => current as EventStoreAdapter));
          current.connect();
        } else {
          engine.connectRemote(http(baseB));
        }
      } else {
        engine.stop();
        freshTick = setInterval(() => {
          const fresh = new SyncEngine(w.local, MID, opts);
          fresh.connectRemote(http(baseB));
          cursorOf = () => fresh.getCursor().last_version_clock;
          void fresh.sync();
        }, 30 * S);
      }
    }, SWITCH_AT_MS);
    w.stop.push(() => {
      clearTimeout(sw);
      if (freshTick) clearInterval(freshTick);
      engine.stop();
      current?.disconnect();
    });
  }
  await runFor(horizonMs(c));
  let delivered = 0;
  for (const id of w.targets) if (relayB.holds(id)) delivered++;
  let cursorSafe = true;
  if (side === "branch") {
    const cursor = cursorOf();
    for (const e of await w.local.query({ motebit_id: MID })) {
      if (e.device_id === "phone" && e.version_clock <= cursor && !relayB.holds(e.event_id)) {
        cursorSafe = false;
      }
    }
  }
  const out: Outcome = { delivered, total: w.targets.length, cursorSafe };
  if (side === "branch") {
    out.resentInFlight = w.net.resentInFlight + w.net.httpResentLive;
    out.resentHung = w.net.httpResentHung;
  }
  for (const st of w.stop) st();
  return out;
}

export async function runCell(c: Cell): Promise<{ main: Outcome; branch: Outcome }> {
  vi.useFakeTimers();
  try {
    const t0 = realNow();
    const isSwitch = c.fault?.startsWith("switch") === true;
    const main = isSwitch ? await runSwitch(c, "main") : await runMain(c);
    vi.unstubAllGlobals();
    vi.clearAllTimers();
    const t1 = realNow();
    trace("=== branch");
    const branch = isSwitch ? await runSwitch(c, "branch") : await runBranch(c);
    if (process.env.MOTEBIT_LIVENESS_TIMING) {
      const t2 = realNow();
      process.stdout.write(
        `TIMING main ${Math.round(t1 - t0)}ms branch ${Math.round(t2 - t1)}ms\n`,
      );
    }
    return { main, branch };
  } finally {
    vi.clearAllTimers();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
}

export function cellName(c: Cell): string {
  return `${c.dir} ${c.life} ${c.flavour} u=${c.u}s L=${c.L}s backlog=${c.backlog}${c.outage ? " outage" : ""}${c.fault ? ` ${c.fault}` : ""}`;
}

export function verdict(c: Cell, r: { main: Outcome; branch: Outcome }): string | null {
  const name = cellName(c);
  if (!r.branch.cursorSafe) return `${name}: the cursor passed an event the relay does not hold`;
  if ((r.branch.resentInFlight ?? 0) > 0) {
    return `${name}: ${r.branch.resentInFlight} push(es) re-sent an event still in flight`;
  }
  if (!c.outage && (r.branch.resentHung ?? 0) > 0) {
    return `${name}: ${r.branch.resentHung} hedged HTTP push(es) outside an outage`;
  }
  if (r.branch.cursorLive === false) {
    return `${name}: an acknowledgment never moved the cursor (quiet L + 15 min after the horizon)`;
  }
  if (r.branch.delivered < r.main.delivered) {
    return `${name}: branch ${r.branch.delivered}/${r.branch.total} < main ${r.main.delivered}/${r.main.total}`;
  }
  if (c.fault && r.branch.delivered < r.branch.total) {
    return `${name}: the relay answers all but the fault, yet the branch delivered ${r.branch.delivered}/${r.branch.total}`;
  }
  if (r.main.delivered === r.main.total && r.branch.delivered < r.branch.total) {
    return `${name}: main delivered all ${r.main.total}, branch ${r.branch.delivered}/${r.branch.total}`;
  }
  return null;
}

/** Cells that went red on some iteration of the round-7 design: each a regression it fixed. */
export const REGRESSIONS: readonly string[] = [
  "push http node u=0.2s L=0s backlog=1 outage",
  "push http rn u=0.2s L=0s backlog=1 outage",
  "pull http node u=0.2s L=0s backlog=1 outage",
  "pull http rn u=0.2s L=0s backlog=1 outage",
  "push persistent-ws node u=0.01s L=300s backlog=1",
  "pull rebuild-ws node u=0.01s L=300s backlog=150",
  "pull persistent-ws node u=0.01s L=300s backlog=150",
  "pull rebuild-ws node u=0.01s L=70s backlog=150",
  "pull rebuild-ws rn u=0.01s L=300s backlog=150",
  "pull rebuild-ws rn u=0.2s L=70s backlog=150",
  "push rebuild-ws node u=0.2s L=300s backlog=150",
  "pull rebuild-ws node u=1s L=0s backlog=150",
  "pull rebuild-ws node u=0.2s L=70s backlog=150",
  "pull rebuild-ws node u=0.2s L=300s backlog=150",
  "push persistent-ws node u=0.2s L=300s backlog=1",
  "pull persistent-ws node u=0.2s L=300s backlog=150",
  "push persistent-ws node u=1s L=300s backlog=6000",
  "pull rebuild-ws rn u=0.2s L=300s backlog=150",
  "pull rebuild-ws rn u=1s L=70s backlog=150",
  "push persistent-ws node u=1s L=300s backlog=1",
  "pull rebuild-ws rn u=1s L=20s backlog=150",
  "pull rebuild-ws node u=1s L=10s backlog=150",
  "pull persistent-ws node u=1s L=300s backlog=150",
  "pull rebuild-ws node u=1s L=20s backlog=150",
  "push persistent-ws node u=5s L=300s backlog=150",
  "pull persistent-ws node u=5s L=300s backlog=150",
  "pull persistent-ws node u=5s L=20s backlog=150",
  "push persistent-ws node u=5s L=300s backlog=6000",
  "pull persistent-ws node u=14s L=0s backlog=150",
  "pull persistent-ws node u=14s L=10s backlog=150",
  "push http node u=0.01s L=300s backlog=1",
  "push http node u=0.2s L=300s backlog=1",
  "pull rebuild-ws rn u=14s L=20s backlog=150",
  "pull rebuild-ws rn u=20s L=20s backlog=150",
  "pull rebuild-ws rn u=30s L=20s backlog=150",
  "pull http rn u=30s L=20s backlog=150",
  "pull rebuild-ws rn u=45s L=20s backlog=150",
  "pull rebuild-ws rn u=70s L=20s backlog=150",
  "push persistent-ws node u=1s L=0s backlog=6000",
  "push rebuild-ws node u=5s L=0s backlog=150",
  "push http rn u=5s L=70s backlog=150",
  "pull http node u=20s L=0s backlog=150",
  "push persistent-ws node u=16s L=0s backlog=150",
  "pull rebuild-ws node u=70s L=0s backlog=150",
];

/**
 * The committed grid: every dimension at its boundary values (u 0.01 and
 * 16 s × L 0 and 300 s, on every door; the 6000 backlog at u 0.01 s), every
 * 25th cell of the sweep with u ≤ 16 s, and every regression cell. Chosen to
 * run in about a minute: a cell's cost grows with its horizon (10 × u ×
 * batch) and its backlog.
 */
export function gridCells(): Cell[] {
  const regressions = new Set(REGRESSIONS);
  return sweep().filter(
    (c, i) =>
      ((c.u === 0.01 || (c.u === 16 && c.backlog !== 6000)) && (c.L === 0 || c.L === 300)) ||
      (c.u <= 16 && i % 25 === 0) ||
      regressions.has(cellName(c)) ||
      c.fault !== undefined,
  );
}

/** The number of shard files (liveness-914-s<k>.test.ts) the sweep is split across. */
export const SHARDS = 8;

/** Declare shard `k` (1-based) of the sweep: its cells, run in order, every red cell listed. */
export function defineShard(k: number): void {
  describe(`#914 differential liveness harness — shard ${k}/${SHARDS}: branch ≥ main on every cell`, () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });
    const all = process.env.MOTEBIT_LIVENESS_FULL ? sweep() : gridCells();
    const cells = all.filter((_, i) => i % SHARDS === k - 1);
    it(
      `${cells.length} cells`,
      async () => {
        // MOTEBIT_LIVENESS_CELL: only cells whose name contains one of these ('|'-separated).
        const only = process.env.MOTEBIT_LIVENESS_CELL?.split("|").filter((x) => x !== "");
        const failures: string[] = [];
        for (const c of cells) {
          const name = cellName(c);
          const exact = Boolean(process.env.MOTEBIT_LIVENESS_EXACT);
          if (
            only &&
            only.length > 0 &&
            !only.some((o) => (exact ? name === o : name.includes(o)))
          ) {
            continue;
          }
          let r: { main: Outcome; branch: Outcome };
          try {
            r = await runCell(c);
          } catch (err: unknown) {
            failures.push(`${name}: threw ${err instanceof Error ? err.message : String(err)}`);
            continue;
          }
          if (process.env.MOTEBIT_LIVENESS_VERBOSE) {
            process.stdout.write(
              `CELL ${name}: main ${r.main.delivered}/${r.main.total} branch ${r.branch.delivered}/${r.branch.total} safe=${r.branch.cursorSafe} resent=${r.branch.resentInFlight ?? 0} hedged=${r.branch.resentHung ?? 0} live=${r.branch.cursorLive ?? "-"}\n`,
            );
          }
          const v = verdict(c, r);
          if (v) failures.push(v);
        }
        expect(failures, `${failures.length} red cell(s)`).toEqual([]);
      },
      (process.env.MOTEBIT_LIVENESS_FULL ? 8 : 1) * 3_600_000,
    ); // the full sweep's slow cells take hours
    if (k === 1) {
      it("the sweep covers every dimension named", () => {
        const all = sweep().filter((c) => !c.fault); // the fault cells add a backlog of 50
        expect(new Set(all.map((c) => c.u)).size).toBe(U.length);
        expect(new Set(all.map((c) => c.L)).size).toBe(LAT.length);
        expect(new Set(all.map((c) => c.life)).size).toBe(3);
        expect(new Set(all.map((c) => c.flavour)).size).toBe(2);
        expect(new Set(all.map((c) => c.backlog)).size).toBe(3);
        expect(new Set(all.map((c) => c.dir)).size).toBe(2);
      });
      it("the committed grid keeps every dimension: each door, flavour, backlog and direction, both boundaries of u and L", () => {
        const grid = gridCells().filter((c) => !c.fault);
        expect(new Set(grid.map((c) => c.life)).size).toBe(3);
        expect(new Set(grid.map((c) => c.flavour)).size).toBe(2);
        expect(new Set(grid.map((c) => c.backlog)).size).toBe(3);
        expect(new Set(grid.map((c) => c.dir)).size).toBe(2);
        const us = new Set(grid.map((c) => c.u));
        const ls = new Set(grid.map((c) => c.L));
        for (const u of [0.01, 16]) expect(us.has(u)).toBe(true);
        for (const L of [0, 300]) expect(ls.has(L)).toBe(true);
        expect(us.size).toBeGreaterThanOrEqual(6); // the sample reaches the middle of the range
        expect(ls.size).toBe(LAT.length);
        for (const name of REGRESSIONS) expect(grid.map(cellName)).toContain(name);
        // …and every relay fault (#914 round 8).
        const faults = new Set(
          gridCells()
            .map((c) => c.fault)
            .filter((f) => f !== undefined),
        );
        expect(faults.size).toBe(7);
      });
    }
  });
}
