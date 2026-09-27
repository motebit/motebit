/**
 * Differential interleaving harness for the sync socket (#816).
 *
 * Four review rounds each found a new interleaving the per-case tests had
 * not imagined. This harness stops imagining: it drives a surface's REAL
 * sync controller through EVERY sequence of lifecycle operations up to a
 * bounded length, crossed with every relay-key latency, against a fake
 * relay and a fake clock, and measures what a user of the relay would see.
 * The same matrix is run against origin/main's controller once and its
 * per-cell results committed as a baseline; the acceptance test asserts,
 * cell by cell, that the branch is never worse than main.
 *
 * The file is duplicated verbatim in each surface's __tests__/ (desktop,
 * web, spatial, mobile) — apps cannot import each other's test code — and
 * each copy is paired with that surface's driver and baseline.
 *
 * ## Operations
 * Every sequence begins with `start` (relay A) and continues with up to
 * `maxOps` more of:
 *   stop · restart-same (stop + start A) · restart-other (stop + start B) ·
 *   reenter (start A again, no stop) · bail (a start that returns early) ·
 *   refresh (advance to the 4.5-minute token refresh) · drop (the relay
 *   closes every open socket).
 * After every operation, one command is sent through the relay and one
 * event is appended to the surface's current sync remote; then the clock
 * advances one step. After the sequence the clock runs a settle period,
 * and a final command and event are sent.
 *
 * ## The fake relay
 * Each socket belongs to the relay its URL names. A socket is accepted
 * (opened, auth ok) on the next clock tick after it is created. A command
 * goes to the OLDEST open accepted socket of the target relay (main's
 * pick for undeclared peers — the relay's command-route `sendToOne`) and
 * counts as answered only if a `command_response` with its id is sent
 * before that socket closes (the relay answers 504 "closed after delivery"
 * the moment the delivered socket closes). An event counts as delivered
 * when a `push` frame carrying it is sent on an open socket, or an HTTP
 * push carrying it is accepted.
 *
 * ## Metrics per cell
 * Only what the user asked for counts: a command or an HTTP sync counts
 * while the surface is RUNNING (after a start, before a stop) and, for a
 * sync, only against the relay the latest start targets. A socket still
 * answering after the user stopped sync, or syncing with a relay the user
 * left, is a leak, not service — main's zombie sockets did both.
 *   commands  — commands answered (probed while running)
 *   events    — distinct outbound events delivered to any relay
 *   inbound   — distinct inbound events (published by another device at
 *               each step) that reached the surface's local store, by the
 *               live socket or by a catch-up pull — counting those published
 *               while running to the relay the user ends on (an event on a
 *               relay the user has left is not owed); if the sequence ends
 *               stopped, what had arrived by that stop (arrivals after a
 *               stop come only from a socket that outlived it)
 *   timely    — the same, summed over every probe while running: how many
 *               owed events had already arrived at each probe (latency at
 *               probe granularity — the catch-up pull's real job)
 *   http      — OVERDUE time (lower is better): while running, how long
 *               the surface went past its 30 s cadence (+5 s grace) with no
 *               HTTP sync (`/sync/…`) to the target relay, summed over every
 *               gap — from the start of each running interval, between syncs,
 *               and from the last sync to the interval's end (a surface that
 *               never syncs is overdue the whole time).
 *               Volume is not credit: a leaked second poller halves the gaps
 *               but is double load, not service.
 *   firstHttp — time from the LAST run's start to its first HTTP sync
 *               (whole ticks; null if none)
 *   openEnd   — sockets open after the settle period
 *   leak      — sockets open after a final stop (only when the last op is a stop)
 *   zombies   — sockets that outlived a stop (still open right after it),
 *               were opened while stopped, or were opened to a relay other
 *               than the one the surface currently targets
 *
 * ## Zombies, and the reaped baseline
 * main's controllers leak sockets, and a leaked socket can SERVE: a socket
 * that survived a stop answers the command sent right after a restart that
 * a correctly closed controller is still reconnecting for. Counting that as
 * main being "better" would make closing sockets on stop a regression. So
 * main is recorded twice: raw, and REAPED — the same run with the fake relay
 * black-holing every zombie (closing it silently, as if the surface had
 * closed it). The acceptance bar is the reaped baseline; the raw one is
 * kept to prove attribution: every cell where raw main beats the branch
 * must be one where main had a zombie. The branch must have none.
 */
import { vi } from "vitest";

// ---------------------------------------------------------------------------
// Node I/O without Node types: the browser surfaces (web, spatial) typecheck
// without @types/node, so the harness reaches the environment and the file
// system through narrow, untyped doors that only run under vitest (Node).
// ---------------------------------------------------------------------------

type EnvMap = Record<string, string | undefined>;
export const harnessEnv: EnvMap = (globalThis as { process?: { env: EnvMap } }).process?.env ?? {};

interface Fs {
  readFileSync(path: string | URL, encoding: "utf-8"): string;
  writeFileSync(path: string | URL, data: string): void;
  appendFileSync(path: string | URL, data: string): void;
  existsSync(path: string | URL): boolean;
}
const FS_MODULE = "node:fs";
export async function fs(): Promise<Fs> {
  return (await import(/* @vite-ignore */ FS_MODULE)) as Fs;
}

export const RELAY_A = "https://relay-a.test";
export const RELAY_B = "https://relay-b.test";
export const OPS = [
  "stop",
  "restart-same",
  "restart-other",
  "reenter",
  "bail",
  "refresh",
  "drop",
] as const;
export type Op = (typeof OPS)[number];
export const LATENCIES = [0, 5_000, 31_000, 40_000, "hung"] as const;
export type Latency = (typeof LATENCIES)[number];

export const STEP_MS = 10_000;
export const TICK_MS = 1_000;
export const SETTLE_MS = 120_000;
export const DRAIN_MS = 40_000;
/** A periodic HTTP sync is overdue this long after the previous one. */
export const HTTP_BUDGET_MS = 35_000;
export const REFRESH_MS = 4.5 * 60_000;

export interface CellResult {
  commands: number;
  events: number;
  inbound: number;
  timely: number;
  zombies: number;
  http: number;
  firstHttp: number | null;
  openEnd: number;
  leak: number | null;
}

/** Every sequence: `start` then 0..maxOps operations. */
export function sequences(maxOps: number): Op[][] {
  const out: Op[][] = [[]];
  let frontier: Op[][] = [[]];
  for (let n = 1; n <= maxOps; n++) {
    const next: Op[][] = [];
    for (const seq of frontier) for (const op of OPS) next.push([...seq, op]);
    out.push(...next);
    frontier = next;
  }
  return out;
}

export function cellKey(seq: Op[], latency: Latency): string {
  return `${String(latency)}|start${seq.map((o) => ">" + o).join("")}`;
}

// ---------------------------------------------------------------------------
// Fake relay
// ---------------------------------------------------------------------------

let clock = 0; // monotonically increasing sequence number for ordering
const tick = () => ++clock;
/** Whether the surface is running, and its target (the harness's view), for zombie detection. */
let surfaceRunning = false;
let surfaceTarget = RELAY_A;
/** Reaped mode: black-hole every zombie socket (see the header). */
let reap = false;

/** Events other devices published, per relay (the relay's sync log). */
const relayLogs = new Map<string, Array<Record<string, unknown>>>();

/** What a catch-up pull (`GET /sync/:id/pull?after_clock=N`) returns. */
export function relayPull(url: string): Array<Record<string, unknown>> {
  const relay = url.includes("relay-b") ? RELAY_B : RELAY_A;
  const after = Number(/after_clock=(\d+)/.exec(url)?.[1] ?? 0);
  return (relayLogs.get(relay) ?? []).filter((e) => (e["version_clock"] as number) > after);
}

export class RelaySocket {
  static all: RelaySocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  relay: string;
  accepted = false;
  closedAt: number | null = null;
  zombie = false;
  /** Opened while stopped, or to a relay the surface does not target. */
  readonly createdStale: boolean;
  sent: Array<{ at: number; data: string; open: boolean }> = [];
  constructor(public url: string) {
    this.relay = url.includes("relay-b") ? RELAY_B : RELAY_A;
    this.createdStale = !surfaceRunning || this.relay !== surfaceTarget;
    RelaySocket.all.push(this);
  }
  /** Close silently: the adapter is not told (so it does not reconnect). */
  blackhole(): void {
    if (this.closedAt == null) this.closedAt = tick();
    this.readyState = 3;
  }
  send(data: string): void {
    this.sent.push({ at: tick(), data, open: this.readyState === 1 });
  }
  close(): void {
    if (this.closedAt == null) this.closedAt = tick();
    this.readyState = 3;
  }
  /** The relay drops the connection. */
  drop(): void {
    if (this.readyState === 3) return;
    this.close();
    this.onclose?.();
  }
  accept(): void {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    this.accepted = true;
    this.onopen?.();
    if (this.readyState === 1) this.deliver({ type: "auth_result", ok: true });
  }
  deliver(msg: unknown): void {
    if (this.readyState !== 1) return;
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  get isOpen(): boolean {
    return this.readyState === 1 && this.closedAt == null;
  }
}

export interface Driver {
  /** Fire-and-forget: a start that must not be awaited (the relay key may hang). */
  start(relay: string, opts: { bail: boolean }): void;
  stop(): void;
  /** Append an event to the surface's current sync remote, as its sync push would. */
  appendEvent(eventId: string): Promise<void>;
  /** The command frame for `id` (a signed envelope where the surface verifies one). */
  commandFrame(id: string): Promise<Record<string, unknown>>;
  /** Event ids in the surface's local event store. */
  localEventIds(): Promise<string[]>;
}

export interface HarnessEnv {
  /** Relay-key latency for the next relay-key fetch(es). */
  latency: Latency;
  /** Every HTTP sync request: absolute fake-clock time and URL. */
  httpSyncs: Array<{ at: number; url: string }>;
  /** Events the surface delivered over HTTP (`/sync/…/push` bodies), if any. */
  httpDelivered?: Set<string>;
}

export function openSockets(): RelaySocket[] {
  return RelaySocket.all.filter((s) => s.isOpen);
}

function acceptPending(): void {
  for (const s of RelaySocket.all) {
    if (s.readyState !== 0 || s.closedAt != null) continue;
    if (s.createdStale) {
      s.zombie = true;
      if (reap) {
        s.blackhole();
        continue;
      }
    }
    s.accept();
  }
}

/** Right after a stop: any socket still open outlived it. */
function markStopSurvivors(): void {
  for (const s of RelaySocket.all) {
    if (s.closedAt != null || s.readyState === 3) continue;
    s.zombie = true;
    if (reap) s.blackhole();
  }
}

/**
 * Let REAL asynchronous work finish (fake-indexeddb, host crypto): the fake
 * clock cannot step it, so without this a surface that awaits real I/O
 * would progress by host speed and the matrix would not be deterministic.
 */
const setImmediateReal = (globalThis as { setImmediate?: (cb: () => void) => void }).setImmediate;
let settleTurns = 0;
async function settleReal(turns = settleTurns): Promise<void> {
  if (!setImmediateReal) return;
  for (let i = 0; i < turns; i++) {
    await new Promise<void>((r) => setImmediateReal(r));
    await vi.advanceTimersByTimeAsync(0);
  }
}

async function advance(ms: number): Promise<void> {
  for (let t = 0; t < ms; t += TICK_MS) {
    acceptPending();
    await settleReal();
    await vi.advanceTimersByTimeAsync(TICK_MS);
  }
  acceptPending();
  await settleReal();
}

/** Run one cell. `makeDriver` builds a fresh controller + fakes. */
export async function runCell(
  seq: Op[],
  env: HarnessEnv,
  driver: Driver,
  opts: { reap?: boolean; settleTurns?: number; settleAfterOpTurns?: number } = {},
): Promise<CellResult> {
  settleTurns = opts.settleTurns ?? 0;
  // After a lifecycle op, let the surface's real async work (a start's
  // key/storage reads) run to quiescence before the clock moves: the races
  // that remain are then the ones the clock orders, not the host.
  const afterOp = () => settleReal(opts.settleAfterOpTurns ?? settleTurns);
  RelaySocket.all = [];
  clock = 0;
  reap = opts.reap === true;
  surfaceRunning = false;
  surfaceTarget = RELAY_A;
  relayLogs.clear();
  let inboundN = 0;
  const published: Array<{ id: string; relay: string; running: boolean }> = [];
  const t0 = Date.now();
  let target = RELAY_A;
  let running = false;
  let lastRunStart = 0;
  // Run-state timeline: [time, running, target] from each lifecycle op.
  const timeline: Array<[number, boolean, string]> = [];
  const mark = () => timeline.push([Date.now(), running, target]);
  const startRun = (relay: string) => {
    target = relay;
    running = true;
    surfaceRunning = true;
    surfaceTarget = relay;
    lastRunStart = Date.now();
    mark();
  };
  // Local-store snapshots: at every probe while running, and at every stop.
  const snapshots: Array<{ running: boolean; ids: Set<string>; publishedBefore: number }> = [];
  let lastStopIds: Set<string> | null = null;
  const stopRun = async () => {
    // The moment the surface became stopped (a second stop changes nothing).
    if (running) lastStopIds = new Set(await driver.localEventIds());
    running = false;
    surfaceRunning = false;
    mark();
  };
  const commands: Array<{
    id: string;
    socket: RelaySocket | null;
    at: number;
    running: boolean;
  }> = [];
  let nEvents = 0;
  let cmdN = 0;

  const probe = async () => {
    if (running) {
      snapshots.push({
        running,
        ids: new Set(await driver.localEventIds()),
        publishedBefore: published.length,
      });
    }
    const id = `cmd-${++cmdN}`;
    const socket =
      RelaySocket.all.find((s) => s.relay === target && s.isOpen && s.accepted) ?? null;
    const at = tick();
    commands.push({ id, socket, at, running });
    if (socket) {
      socket.deliver(await driver.commandFrame(id));
      // A command's execution is real async work: give it until it answers
      // (bounded) before the clock moves, so the outcome is host-independent.
      for (let i = 0; i < 50; i++) {
        if (socket.sent.some((f) => f.data.includes(`"${id}"`))) break;
        await settleReal(5);
      }
    }
    await driver.appendEvent(`evt-${++nEvents}`).catch(() => {});
    // Another device publishes an event to the target relay: stored in the
    // relay's log (for catch-up pulls) and fanned out to its open sockets.
    const log = relayLogs.get(target) ?? [];
    relayLogs.set(target, log);
    const n = ++inboundN;
    const inbound = {
      event_id: `in-${n}`,
      motebit_id: "motebit-1",
      device_id: "other-device",
      timestamp: 1,
      event_type: "state_updated",
      payload: { n },
      version_clock: 1000 + n,
      tombstoned: false,
    };
    log.push(inbound);
    published.push({ id: inbound.event_id, relay: target, running });
    for (const s of RelaySocket.all)
      if (s.relay === target && s.isOpen && s.accepted)
        s.deliver({ type: "event", event: inbound });
    await vi.advanceTimersByTimeAsync(0);
  };

  startRun(RELAY_A);
  driver.start(RELAY_A, { bail: false });
  await afterOp();
  await advance(TICK_MS);
  await probe();
  await advance(STEP_MS);

  for (const op of seq) {
    switch (op) {
      case "stop":
        await stopRun();
        driver.stop();
        markStopSurvivors();
        break;
      case "restart-same":
        await stopRun();
        driver.stop();
        markStopSurvivors();
        startRun(RELAY_A);
        driver.start(RELAY_A, { bail: false });
        break;
      case "restart-other":
        await stopRun();
        driver.stop();
        markStopSurvivors();
        startRun(RELAY_B);
        driver.start(RELAY_B, { bail: false });
        break;
      case "reenter":
        startRun(target);
        driver.start(target, { bail: false });
        break;
      case "bail":
        driver.start(target, { bail: true });
        break;
      case "refresh":
        await advance(REFRESH_MS - STEP_MS);
        break;
      case "drop":
        for (const s of openSockets()) s.drop();
        break;
    }
    await afterOp();
    await advance(TICK_MS);
    await probe();
    await advance(STEP_MS);
  }

  await advance(SETTLE_MS);
  const drainFrom = Date.now();
  await probe();
  // Long enough for a surface that pushes on a cycle (mobile: 30 s) to
  // deliver the final event.
  await advance(DRAIN_MS);

  const answered = commands.filter(({ id, socket, running: wasRunning }) => {
    if (!socket || !wasRunning) return false;
    const deadline = socket.closedAt ?? Number.POSITIVE_INFINITY;
    return RelaySocket.all.some((s) =>
      s.sent.some(
        (f) =>
          f.open &&
          f.at < deadline &&
          f.data.includes('"command_response"') &&
          f.data.includes(`"${id}"`),
      ),
    );
  }).length;
  const delivered = new Set<string>(env.httpDelivered ?? []);
  for (const s of RelaySocket.all)
    for (const f of s.sent)
      if (f.open && f.data.includes('"push"'))
        for (const m of f.data.matchAll(/"event_id":"(evt-\d+)"/g)) delivered.add(m[1]!);
  const debugPath = harnessEnv["INTERLEAVING_DEBUG"];
  if (debugPath) {
    (await fs()).appendFileSync(
      debugPath,
      JSON.stringify(
        {
          seq,
          timeline: timeline.map(([at, r, tg]) => [at - t0, r, tg]),
          http: env.httpSyncs.map(({ at, url }) => `${at - t0} ${url}`),
          commands: commands.map((c) => ({
            id: c.id,
            at: c.at,
            running: c.running,
            socket: c.socket ? RelaySocket.all.indexOf(c.socket) : null,
          })),
          sockets: RelaySocket.all.map((s, i) => ({
            i,
            relay: s.relay,
            closedAt: s.closedAt,
            accepted: s.accepted,
            sent: s.sent.map((f) => `${f.at}${f.open ? "" : "(closed)"}:${f.data.slice(0, 70)}`),
          })),
        },
        null,
        1,
      ) + "\n",
    );
  }
  const stateAt = (t: number): [boolean, string] => {
    let st: [boolean, string] = [false, RELAY_A];
    for (const [at, r, tg] of timeline) if (at <= t) st = [r, tg];
    return st;
  };
  let firstInLastRun: number | null = null;
  const legit: Array<{ at: number; url: string }> = [];
  for (const { at, url } of env.httpSyncs) {
    // Syncs before the final drain only (the drain is not a running window
    // the surface is judged on).
    if (at >= drainFrom) continue;
    const [isRunning, tgt] = stateAt(at);
    if (!isRunning || !url.startsWith(tgt)) continue;
    legit.push({ at, url });
    if (at >= lastRunStart && firstInLastRun == null) firstInLastRun = at - lastRunStart;
  }
  // Running intervals: merge consecutive running timeline entries that keep
  // the target (a re-entered start does not reset the clock).
  const intervals: Array<{ from: number; to: number; target: string }> = [];
  for (let i = 0; i < timeline.length; i++) {
    const [at, isRunning, tgt] = timeline[i]!;
    const next = i + 1 < timeline.length ? timeline[i + 1]![0] : drainFrom;
    if (!isRunning || next <= at) continue;
    const last = intervals[intervals.length - 1];
    if (last && last.to === at && last.target === tgt) last.to = Math.min(next, drainFrom);
    else intervals.push({ from: at, to: Math.min(next, drainFrom), target: tgt });
  }
  // Whole ticks since the cell began: sub-tick placement can depend on
  // host speed where a surface awaits real I/O.
  const q = (at: number) => Math.floor((at - t0) / TICK_MS) * TICK_MS;
  let overdue = 0;
  for (const iv of intervals) {
    const times = [
      q(iv.from),
      ...legit
        .filter((x) => x.at >= iv.from && x.at < iv.to && x.url.startsWith(iv.target))
        .map((x) => q(x.at)),
      q(iv.to),
    ];
    for (let i = 1; i < times.length; i++) {
      overdue += Math.max(0, times[i]! - times[i - 1]! - HTTP_BUDGET_MS);
    }
  }
  const lastIsStop = seq.length > 0 && seq[seq.length - 1] === "stop";
  const openEnd = openSockets().length;
  const owed = new Set(published.filter((p) => p.running && p.relay === target).map((p) => p.id));
  const finalIds =
    running || lastStopIds == null ? new Set(await driver.localEventIds()) : lastStopIds;
  const inboundIds = new Set([...finalIds].filter((id) => owed.has(id)));
  let timely = 0;
  for (const snap of snapshots) {
    for (const p of published.slice(0, snap.publishedBefore)) {
      if (owed.has(p.id) && snap.ids.has(p.id)) timely++;
    }
  }
  return {
    commands: answered,
    events: delivered.size,
    inbound: inboundIds.size,
    timely,
    zombies: RelaySocket.all.filter((s) => s.zombie).length,
    http: overdue,
    // Whole ticks: the clock is stepped a tick at a time, and sub-tick
    // placement can depend on host speed where a surface awaits real I/O.
    firstHttp: firstInLastRun == null ? null : Math.floor(firstInLastRun / TICK_MS) * TICK_MS,
    openEnd,
    leak: lastIsStop ? openEnd : null,
  };
}

/** Relay-key fetch delay per the cell's latency. */
export function relayKeyDelay(latency: Latency): Promise<void> {
  if (latency === "hung") return new Promise<void>(() => {});
  if (latency === 0) return Promise.resolve();
  return new Promise<void>((r) => setTimeout(r, latency));
}

export interface Comparison {
  cells: number;
  mainBetter: string[];
  branchBetter: string[];
  invariantBreaks: string[];
}

/**
 * Attribution for the RAW baseline: every cell where raw main beats the
 * branch must be one where main had a zombie socket. Returns the cells that
 * are not (must be empty).
 */
export function unattributed(
  branch: Record<string, CellResult>,
  mainRaw: Record<string, CellResult>,
  opts: CompareOptions,
): string[] {
  const raw = compare(branch, mainRaw, opts);
  return raw.mainBetter.filter((line) => {
    const key = line.slice(0, line.indexOf(": "));
    return (mainRaw[key]?.zombies ?? 0) === 0;
  });
}

export interface CompareOptions {
  periodicHttp: boolean;
  /**
   * Host-jitter allowance, for a surface whose cells are not bit-for-bit
   * reproducible (web: fake-indexeddb and the real runtime do real async
   * work the fake clock cannot order). Zero everywhere else.
   */
  tolerance?: { commands: number; overdueMs: number; firstHttpMs: number };
}

/** Compare a branch run against main's baseline, cell by cell. */
export function compare(
  branch: Record<string, CellResult>,
  main: Record<string, CellResult>,
  opts: CompareOptions,
): Comparison {
  const tol = opts.tolerance ?? { commands: 0, overdueMs: 0, firstHttpMs: 0 };
  const mainBetter: string[] = [];
  const branchBetter: string[] = [];
  const invariantBreaks: string[] = [];
  for (const [key, b] of Object.entries(branch)) {
    const m = main[key];
    if (!m) {
      invariantBreaks.push(`${key}: no main baseline for this cell`);
      continue;
    }
    const worse: string[] = [];
    const better: string[] = [];
    const cmp = (name: string, bv: number, mv: number, allowance = 0) => {
      if (bv + allowance < mv) worse.push(`${name} ${bv} < main ${mv}`);
      else if (bv > mv) better.push(`${name} ${bv} > main ${mv}`);
    };
    cmp("commands", b.commands, m.commands, tol.commands);
    cmp("events", b.events, m.events);
    cmp("inbound", b.inbound, m.inbound);
    cmp("timely", b.timely, m.timely);
    // A surface whose only HTTP sync is the socket's catch-up pull (desktop,
    // spatial) is judged by what that pull is for — `inbound` and `timely`:
    // counting its pulls would reward main's duplicate and zombie sockets,
    // each of which pulls again. Surfaces that poll over HTTP on a cadence
    // (web's plan/conversation engines, mobile's 30 s cycle) are judged on
    // their HTTP coverage and first sync too.
    if (opts.periodicHttp) {
      // Overdue time: lower is better.
      cmp("http (-overdue)", -b.http, -m.http, tol.overdueMs);
      if (
        m.firstHttp != null &&
        (b.firstHttp == null || b.firstHttp > m.firstHttp + tol.firstHttpMs)
      )
        worse.push(`firstHttp ${String(b.firstHttp)} later than main ${m.firstHttp}`);
      else if (b.firstHttp != null && (m.firstHttp == null || b.firstHttp < m.firstHttp))
        better.push(`firstHttp ${b.firstHttp} earlier than main ${String(m.firstHttp)}`);
    }
    if (b.openEnd < m.openEnd) better.push(`openEnd ${b.openEnd} < main ${m.openEnd}`);
    if (worse.length) mainBetter.push(`${key}: ${worse.join("; ")}`);
    if (better.length) branchBetter.push(`${key}: ${better.join("; ")}`);
    if (b.openEnd > 1) invariantBreaks.push(`${key}: ${b.openEnd} sockets open at quiescence`);
    if (b.zombies > 0) invariantBreaks.push(`${key}: ${b.zombies} zombie socket(s)`);
    if (b.leak != null && b.leak > 0)
      invariantBreaks.push(`${key}: ${b.leak} socket(s) open after stop`);
  }
  return { cells: Object.keys(branch).length, mainBetter, branchBetter, invariantBreaks };
}
