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
 *   3. the branch's push cursor never passes an event the relay does not hold.
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
 * Split across liveness-914-s<k>.test.ts so the shards run in parallel. By
 * default the CORE cells run (every cell that went red while the round-7
 * design was built, each a regression it fixed); ZZ914_FULL=1 runs the whole
 * sweep. ZZ914_CELL='a|b' runs the cells whose names contain a or b;
 * ZZ914_VERBOSE prints every cell's counts; ZZ914_TRACE a wire timeline.
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
type Lifecycle = "persistent-ws" | "rebuild-ws" | "http";
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
}

export interface Outcome {
  delivered: number;
  total: number;
  cursorSafe: boolean;
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
  const local = new InMemoryEventStore();
  const base = `http://relay${n}.harness`;
  const wsUrl = `ws://relay${n}.harness/ws/sync/${MID}`;
  vi.stubGlobal("WebSocket", net.socketClass());
  if (c.flavour === "rn") net.installReactNative();
  else vi.stubGlobal("fetch", net.fetch);
  return { net, relay, local, base, wsUrl, targets: [], stop: [] };
}

/**
 * New events arrive every 5 min — or every 2 × u on a link slower than that,
 * so the steady-state load never exceeds what the link can carry at all
 * (a link oversubscribed forever measures nothing but its queue).
 */
export function liveEveryMs(c: Cell): number {
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
  connect(): void {
    const ws = new WebSocket(this.url + "?device_id=phone");
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      if (this.pending.length > 0)
        ws.send(JSON.stringify({ type: "push", events: this.pending.splice(0) }));
      this.onConnected();
    };
  }
  disconnect(): void {
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
async function mainPull(w: World, cursor: { seq: number }): Promise<void> {
  for (;;) {
    const res = await fetch(`${w.base}/sync/${MID}/pull?after_seq=${cursor.seq}&after_clock=0`);
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
  if (c.life === "persistent-ws") {
    sock = new MainSocket(w.wsUrl, catchUp);
    sock.connect();
    const tick = setInterval(sync, 30 * S);
    const swap = setInterval(() => {
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
  if (c.life === "persistent-ws") {
    let current = socketAdapter(w);
    engine.connectRemote(liveAdapter(() => current as EventStoreAdapter));
    current.connect();
    engine.start();
    const swap = setInterval(() => {
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
  for (const s of w.stop) s();
  return out;
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
  return cells;
}

export async function runCell(c: Cell): Promise<{ main: Outcome; branch: Outcome }> {
  vi.useFakeTimers();
  try {
    const t0 = realNow();
    const main = await runMain(c);
    vi.unstubAllGlobals();
    vi.clearAllTimers();
    const t1 = realNow();
    trace("=== branch");
    const branch = await runBranch(c);
    if (process.env.ZZ914_TIMING) {
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
  return `${c.dir} ${c.life} ${c.flavour} u=${c.u}s L=${c.L}s backlog=${c.backlog}`;
}

export function verdict(c: Cell, r: { main: Outcome; branch: Outcome }): string | null {
  const name = cellName(c);
  if (!r.branch.cursorSafe) return `${name}: the cursor passed an event the relay does not hold`;
  if (r.branch.delivered < r.main.delivered) {
    return `${name}: branch ${r.branch.delivered}/${r.branch.total} < main ${r.main.delivered}/${r.main.total}`;
  }
  if (r.main.delivered === r.main.total && r.branch.delivered < r.branch.total) {
    return `${name}: main delivered all ${r.main.total}, branch ${r.branch.delivered}/${r.branch.total}`;
  }
  return null;
}

/**
 * The cells run by default: each went red on some iteration of the round-7
 * design (substring match on the cell name).
 */
export const CORE: readonly string[] = [
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
  "pull rebuild-ws rn u=20s",
  "pull rebuild-ws rn u=30s",
  "pull rebuild-ws rn u=14s",
  "pull http rn u=30s",
  "pull rebuild-ws rn u=45s",
  "pull rebuild-ws rn u=70s",
  "push persistent-ws node u=1s L=0s backlog=6000",
  "push rebuild-ws node u=5s L=0s backlog=150",
  "push rebuild-ws rn u=5s L=70s backlog=150",
  "push http rn u=5s L=70s backlog=150",
  "pull http node u=20s L=0s backlog=150",
  "push persistent-ws node u=16s L=0s backlog=150",
  "pull rebuild-ws node u=70s L=0s backlog=150",
];

/** The number of shard files (liveness-914-s<k>.test.ts) the sweep is split across. */
export const SHARDS = 8;

/** Declare shard `k` (1-based) of the sweep: its cells, run in order, every red cell listed. */
export function defineShard(k: number): void {
  describe(`#914 differential liveness harness — shard ${k}/${SHARDS}: branch ≥ main on every cell`, () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });
    const all = process.env.ZZ914_FULL
      ? sweep()
      : sweep().filter((c) => CORE.some((o) => cellName(c).includes(o)));
    const cells = all.filter((_, i) => i % SHARDS === k - 1);
    it(`${cells.length} cells`, async () => {
      // ZZ914_CELL: run only cells whose name contains one of these ('|'-separated).
      const only = process.env.ZZ914_CELL?.split("|").filter((x) => x !== "");
      const failures: string[] = [];
      for (const c of cells) {
        const name = cellName(c);
        if (only && only.length > 0 && !only.some((o) => name.includes(o))) continue;
        let r: { main: Outcome; branch: Outcome };
        try {
          r = await runCell(c);
        } catch (err: unknown) {
          failures.push(`${name}: threw ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        if (process.env.ZZ914_VERBOSE) {
          process.stdout.write(
            `CELL ${name}: main ${r.main.delivered}/${r.main.total} branch ${r.branch.delivered}/${r.branch.total} safe=${r.branch.cursorSafe}\n`,
          );
        }
        const v = verdict(c, r);
        if (v) failures.push(v);
      }
      expect(failures, `${failures.length} red cell(s)`).toEqual([]);
    }, 3_600_000);
    if (k === 1) {
      it("the sweep covers every dimension named", () => {
        const all = sweep();
        expect(new Set(all.map((c) => c.u)).size).toBe(U.length);
        expect(new Set(all.map((c) => c.L)).size).toBe(LAT.length);
        expect(new Set(all.map((c) => c.life)).size).toBe(3);
        expect(new Set(all.map((c) => c.flavour)).size).toBe(2);
        expect(new Set(all.map((c) => c.backlog)).size).toBe(3);
        expect(new Set(all.map((c) => c.dir)).size).toBe(2);
      });
    }
  });
}
