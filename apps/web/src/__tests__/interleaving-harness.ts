/**
 * Differential interleaving harness for the sync socket (#816).
 *
 * Several review rounds each found a new interleaving the per-case tests had
 * not imagined. This harness stops imagining: it drives a surface's REAL
 * sync controller through EVERY sequence of lifecycle operations up to a
 * bounded length, crossed with every relay-key latency and command
 * execution time, against a fake relay and a fake clock, and measures what a
 * user of the relay would see. The same matrix is run against origin/main's
 * controller and its per-cell results committed as baselines; the acceptance
 * test asserts, cell by cell, that the branch is never worse than main.
 *
 * The file is duplicated verbatim in each surface's __tests__/ (desktop,
 * web, spatial, mobile) — apps cannot import each other's test code — and
 * each copy is paired with that surface's driver and baselines.
 *
 * ## Operations
 * Every sequence begins with `start` (relay A, identity 1) and continues
 * with up to `maxOps` more of:
 *   stop · restart-same (stop + start A) · restart-other (stop + start B) ·
 *   reenter (start again, same relay, no stop) · reenter-other (start on the
 *   other relay, no stop) · identity (a pairing switches the motebit id,
 *   then starts again) · bail (a start that returns early) · refresh
 *   (advance to the 4.5-minute token refresh) · drop (the relay closes every
 *   open socket) · stall (the relay admits no socket for 15 s).
 * After every operation the harness probes three times — before any new
 * socket opens, after it opens but before the relay admits it, and a step
 * later — each probe sending one command through the relay, appending one
 * event to the surface's current sync remote, and publishing one inbound
 * event from another device. After the sequence the clock runs a settle
 * period and a final probe, then a drain.
 *
 * Each cell also fixes a relay-key latency (0, 5 s, 31 s, 40 s, hung) and a
 * command execution time (0, 1 tick, 2 s, 15 s), so replies span later ops.
 *
 * ## The fake relay (modelled on command-route.ts / websocket.ts on main)
 * A socket's URL names its relay and its motebit. The relay OPENS a new
 * socket on its next tick and ADMITS it (auth_result ok) on the tick after,
 * once the client has sent its auth frame; frames on a socket it has not
 * admitted are ignored (#771). A command goes to main's pick — the first
 * admitted open socket of the target relay and motebit, in admission order
 * (`sendToOne` for undeclared peers) — and is ANSWERED if a
 * `command_response` with its id arrives on ANY admitted socket of the same
 * relay and motebit before its 30 s deadline, whatever happened to the
 * delivered socket (`handleCommandResponse`: the answer key for a peer with
 * no declared device id and no token `did` is the motebit). An outbound
 * event counts as delivered when a `push` frame carrying it arrives, while
 * the surface is running, on an admitted socket of the event's own motebit
 * AND of the relay and identity the surface targets at that moment (a push
 * to a relay or identity the user left is not what they asked for), or an
 * HTTP push carrying it is accepted; a push on another motebit's socket is
 * MISROUTED.
 *
 * ## Metrics per cell
 * Only what the user asked for counts: a command or an HTTP sync counts
 * while the surface is RUNNING (after a start, before a stop) and, for a
 * sync, only against the relay the latest start targets. A socket still
 * answering after the user stopped sync, or serving a relay or identity the
 * user left, is a leak, not service — main's zombie sockets did both.
 *   commands  — commands answered (probed while running)
 *   events    — distinct outbound events delivered on their own identity,
 *               to the target relay, while running
 *   misrouted — outbound events pushed on another identity's socket, or
 *               over HTTP to another identity's `/sync/<id>/push`
 *   inbound   — distinct inbound events that reached the local store,
 *               counting those published while running to the relay and
 *               identity the user ends on; if the sequence ends stopped,
 *               what had arrived by that stop
 *   timely    — the same, summed over every probe while running (latency at
 *               probe granularity — the catch-up pull's real job)
 *   http      — OVERDUE time (lower is better): while running, how long the
 *               surface went past its 30 s cadence (+5 s grace) with no HTTP
 *               sync (`/sync/<id>/…`) to the target relay for the target
 *               identity
 *   firstHttp — time from the LAST run's start to its first HTTP sync
 *   openEnd   — sockets the relay has admitted and still holds at the end
 *               (a socket mid-handshake at that instant is not counted)
 *   leak      — sockets open at all after a final stop (only when the last
 *               op is a stop)
 *   zombies   — sockets that outlived a stop, were opened while stopped,
 *               were opened by the client in the instant it closed a zombie
 *               of the same relay and identity (its continuation),
 *               were opened for a relay or identity the surface had already
 *               left (even if the user later returns to it), were opened by
 *               a zombie's refresh timer (REFRESH_MS after the zombie, same
 *               relay and identity), stayed open
 *               20 s after the surface moved away from their relay or
 *               identity, or stayed admitted 20 s after a newer socket of the
 *               same relay and identity was admitted (a duplicate: the relay
 *               serves one). The 20 s grace is for a socket that was the
 *               surface's own when opened; one opened off target, like one
 *               opened while stopped, never was.
 *
 * ## Zombies, and the reaped baseline
 * main's controllers leak sockets, and a leaked socket can SERVE. Counting
 * that as main being "better" would make closing sockets a regression. So
 * main is recorded twice: raw, and REAPED — the same run with the fake
 * relay black-holing every zombie the moment it becomes one (closing it
 * silently, as if the surface had; one reaped mid-handshake is first told
 * it is up, so the reaping itself spawns no reconnect). The acceptance bar is the reaped
 * baseline, which is what supplies causation: a cell the branch loses to
 * raw main but not to reaped main is one where main's lead came from a
 * socket it should have closed. The raw comparison is kept as a check that
 * points the same way — every cell where raw main beats the branch must be
 * one where main had a zombie (the check verifies the zombie's presence in
 * that cell, not that it caused the lead; the reaped comparison does that).
 * The branch must have no zombie and no misrouted event.
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
export const FIRST_IDENTITY = "motebit-1";
export const OPS = [
  "stop",
  "restart-same",
  "restart-other",
  "reenter",
  "reenter-other",
  "identity",
  "bail",
  "refresh",
  "drop",
  "stall",
] as const;
export type Op = (typeof OPS)[number];
export const LATENCIES = [0, 5_000, 31_000, 40_000, "hung"] as const;
export type Latency = (typeof LATENCIES)[number];
/** How long a command takes to execute (fake time). */
export const DURATIONS = [0, 1_000, 2_000, 15_000] as const;
export type Duration = (typeof DURATIONS)[number];

export const STEP_MS = 10_000;
export const TICK_MS = 1_000;
export const SETTLE_MS = 120_000;
export const DRAIN_MS = 40_000;
/** A periodic HTTP sync is overdue this long after the previous one. */
export const HTTP_BUDGET_MS = 35_000;
export const REFRESH_MS = 4.5 * 60_000;
/** The relay's deadline for a command's answer (command-route.ts). */
export const COMMAND_DEADLINE_MS = 30_000;
/** How long a `stall` op keeps the relay from admitting anything. */
export const STALL_MS = 15_000;
/** A socket for a relay or identity the surface left is a zombie after this. */
export const STALE_GRACE_MS = 20_000;

export interface CellResult {
  commands: number;
  events: number;
  misrouted: number;
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

export function cellKey(seq: Op[], latency: Latency, duration: Duration): string {
  return `${String(latency)}|${duration}|start${seq.map((o) => ">" + o).join("")}`;
}

// ---------------------------------------------------------------------------
// Fake relay
// ---------------------------------------------------------------------------

let seqNo = 0; // monotonically increasing sequence number for ordering
const tick = () => ++seqNo;
/** The harness's view of the surface, for zombie detection. */
let surfaceRunning = false;
let surfaceTarget = RELAY_A;
let surfaceIdentity = FIRST_IDENTITY;
/** Reaped mode: black-hole every zombie socket (see the header). */
let reap = false;
let stallUntil = 0;
let admissionOrder = 0;
/** The last client-side close of a zombie socket (see `RelaySocket.close`). */
let lastZombieClose: { time: number; relay: string; motebit: string } | null = null;

/** Events other devices published, per relay and identity (the relay's sync log). */
const relayLogs = new Map<string, Array<Record<string, unknown>>>();
const logKey = (relay: string, motebit: string) => `${relay} ${motebit}`;

function relayOf(url: string): string {
  return url.includes("relay-b") ? RELAY_B : RELAY_A;
}
function motebitOf(url: string): string {
  return /\/sync\/([^/?]+)/.exec(url)?.[1] ?? "";
}

/**
 * What a catch-up pull (`GET /sync/:id/pull?after_clock=N`) returns. Only
 * a pull the user asked for — while running, against the relay and identity
 * the surface targets — brings
 * events: a pull by a leaked or superseded start (a socket's catch-up on a
 * relay the user has left, or after a stop) is answered empty, so it cannot
 * pre-fill the store the `inbound` / `timely` metrics read. Without this a
 * reaped zombie still fed them (its catch-up is HTTP, not socket traffic).
 */
export function relayPull(url: string): Array<Record<string, unknown>> {
  if (!surfaceRunning || relayOf(url) !== surfaceTarget || motebitOf(url) !== surfaceIdentity)
    return [];
  const after = Number(/after_clock=(\d+)/.exec(url)?.[1] ?? 0);
  return (relayLogs.get(logKey(relayOf(url), motebitOf(url))) ?? []).filter(
    (e) => (e["version_clock"] as number) > after,
  );
}

interface Frame {
  seq: number;
  time: number;
  data: string;
  /** Sent on a socket the relay had admitted and not closed. */
  admitted: boolean;
}

export class RelaySocket {
  static all: RelaySocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  readonly relay: string;
  readonly motebit: string;
  opened = false;
  sentAuth = false;
  accepted = false;
  admittedAt = 0;
  /** Fake-clock time of admission. */
  admittedTime = 0;
  closedAt: number | null = null;
  zombie = false;
  /** Opened while stopped: a zombie from birth. */
  readonly bornStopped: boolean;
  /** Opened for a relay or identity the surface had already left. */
  readonly bornStale: boolean;
  /** Fake-clock time the client opened it. */
  readonly createdAt: number = Date.now();
  /** When the surface moved away from this socket's relay or identity. */
  staleSince: number | null;
  sent: Frame[] = [];
  constructor(public url: string) {
    this.relay = relayOf(url);
    this.motebit = motebitOf(url);
    this.bornStopped = !surfaceRunning;
    this.bornStale = this.relay !== surfaceTarget || this.motebit !== surfaceIdentity;
    this.staleSince = this.bornStale ? Date.now() : null;
    RelaySocket.all.push(this);
    // A socket the client opens in the same instant it closes a zombie of
    // the same relay and identity is that zombie's continuation (a refresh
    // timer or reconnect of an adapter the surface should have shut): it is
    // a zombie too. Without this, reaping a zombie's socket still left its
    // adapter's timers running, and their next socket served in the reaped
    // baseline as if main had never leaked.
    const z = lastZombieClose;
    if (z && z.time === Date.now() && z.relay === this.relay && z.motebit === this.motebit) {
      markZombie(this);
    }
    // Opened for a relay or identity the surface had already left: a start
    // the user superseded (a stop, a switch) still built it. It is a zombie
    // from birth, like one opened while stopped — even if the user later
    // returns to that target, it was never the returning start's socket.
    if (this.bornStale) markZombie(this);
    // A zombie's refresh timer: main arms a 4.5-min refresh when it opens a
    // socket, and a zombie's timer outlives the zombie (the reaper closes
    // the socket, not the timer). A socket opened exactly REFRESH_MS after a
    // zombie of the same relay and identity — when no live socket of that
    // relay and identity was opened in the same instant as the zombie — is
    // that timer's socket: a zombie too.
    const now = Date.now();
    const sameTarget = (o: RelaySocket) => o.relay === this.relay && o.motebit === this.motebit;
    const parent = RelaySocket.all.find(
      (o) => o !== this && o.zombie && sameTarget(o) && o.createdAt + REFRESH_MS === now,
    );
    if (
      parent &&
      !RelaySocket.all.some(
        (o) => o !== this && !o.zombie && sameTarget(o) && o.createdAt === parent.createdAt,
      )
    ) {
      markZombie(this);
    }
  }
  /** Close silently: the adapter is not told (so it does not reconnect). */
  blackhole(): void {
    if (this.closedAt == null) this.closedAt = tick();
    this.readyState = 3;
  }
  send(data: string): void {
    if (!this.accepted && data.includes('"type":"auth"')) this.sentAuth = true;
    this.sent.push({
      seq: tick(),
      time: Date.now(),
      data,
      admitted: this.accepted && this.readyState === 1 && this.closedAt == null,
    });
  }
  close(): void {
    if (this.closedAt == null) this.closedAt = tick();
    this.readyState = 3;
    if (this.zombie) {
      lastZombieClose = { time: Date.now(), relay: this.relay, motebit: this.motebit };
    }
  }
  /** The relay drops the connection. */
  drop(): void {
    if (this.readyState === 3) return;
    this.close();
    this.onclose?.();
  }
  open(): void {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    this.opened = true;
    this.onopen?.();
  }
  admit(): void {
    if (this.readyState !== 1 || this.accepted) return;
    this.accepted = true;
    this.admittedAt = ++admissionOrder;
    this.admittedTime = Date.now();
    this.deliver({ type: "auth_result", ok: true });
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
  /** The surface's motebit id at the start (default `FIRST_IDENTITY`). */
  initialIdentity?: string;
  /** Fire-and-forget: a start that must not be awaited (the relay key may hang). */
  start(relay: string, opts: { bail: boolean }): void;
  stop(): void;
  /** A pairing: the surface's motebit id becomes `motebitId` (a start follows). */
  switchIdentity(motebitId: string): void;
  /** Append an event (of `motebitId`) as the surface's sync push would. */
  appendEvent(eventId: string, motebitId: string): Promise<void>;
  /** The command frame for `id` (a signed envelope where the surface verifies one). */
  commandFrame(id: string): Promise<Record<string, unknown>>;
  /** Event ids in the surface's local event store. */
  localEventIds(): Promise<string[]>;
}

export interface HarnessEnv {
  /** Relay-key latency for the relay-key fetch(es). */
  latency: Latency;
  /** How long each command takes to execute (drivers delay their executor). */
  duration: Duration;
  /** Every HTTP sync request: absolute fake-clock time and URL. */
  httpSyncs: Array<{ at: number; url: string }>;
  /** Events the surface delivered over HTTP (`/sync/…/push` bodies), if any. */
  httpDelivered?: Set<string>;
  /** Events pushed over HTTP to another identity's `/sync/<id>/push` (misrouted). */
  httpMisrouted?: number;
}

export function openSockets(): RelaySocket[] {
  return RelaySocket.all.filter((s) => s.isOpen);
}

function markZombie(s: RelaySocket): void {
  s.zombie = true;
  if (reap && s.closedAt == null) s.blackhole();
}

/** One relay tick: admit sockets opened last tick, open new ones, age stale ones. */
function relayTick(): void {
  const now = Date.now();
  markDuplicates(now);
  for (const s of RelaySocket.all) {
    if (s.closedAt != null || s.readyState === 3) continue;
    if (s.staleSince != null && now - s.staleSince >= STALE_GRACE_MS) markZombie(s);
    if (s.closedAt != null) continue;
    if (now < stallUntil) continue;
    if (s.readyState === 1 && !s.accepted && s.sentAuth) {
      if (s.bornStopped || s.zombie) {
        // Reaped: the client is told it is up, then the relay goes silent —
        // as if the surface had closed it. Black-holing it mid-handshake
        // instead would fire the client's auth timeout and its reconnect: a
        // socket the reaper itself spawned.
        if (reap) s.admit();
        markZombie(s);
        if (s.closedAt != null) continue;
      }
      s.admit();
    } else if (s.readyState === 0) {
      if (s.bornStopped && reap) {
        markZombie(s);
        continue;
      }
      s.open();
    }
  }
}

/**
 * A socket still admitted 20 s after a NEWER socket of the same relay and
 * identity was admitted is a duplicate the surface leaked: the relay serves
 * one socket per peer, and make-before-break never needs the old one that
 * long.
 */
function markDuplicates(now: number): void {
  const live = RelaySocket.all.filter((s) => s.isOpen && s.accepted && !s.zombie);
  for (const s of live) {
    const newer = live.some(
      (o) =>
        o !== s &&
        o.relay === s.relay &&
        o.motebit === s.motebit &&
        o.admittedAt > s.admittedAt &&
        now - o.admittedTime >= STALE_GRACE_MS,
    );
    if (newer) markZombie(s);
  }
}

/** Right after a stop: any socket still open outlived it. */
function markStopSurvivors(): void {
  for (const s of RelaySocket.all) {
    if (s.closedAt != null || s.readyState === 3) continue;
    markZombie(s);
  }
}

/**
 * The surface moved to another relay or identity: open sockets of the old one
 * start aging; a socket of the target it moved (back) to serves again.
 */
function markTargetChange(): void {
  const now = Date.now();
  for (const s of RelaySocket.all) {
    if (s.closedAt != null) continue;
    if (s.relay !== surfaceTarget || s.motebit !== surfaceIdentity) s.staleSince ??= now;
    else s.staleSince = null;
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
    relayTick();
    await settleReal();
    await vi.advanceTimersByTimeAsync(TICK_MS);
  }
}

/** Delay a driver's command executor by the cell's execution time. */
export function commandDelay(duration: Duration): Promise<void> {
  if (duration === 0) return Promise.resolve();
  return new Promise<void>((r) => setTimeout(r, duration));
}

/** Relay-key fetch delay per the cell's latency. */
export function relayKeyDelay(latency: Latency): Promise<void> {
  if (latency === "hung") return new Promise<void>(() => {});
  if (latency === 0) return Promise.resolve();
  return new Promise<void>((r) => setTimeout(r, latency));
}

/** Run one cell against a fresh driver. */
export async function runCell(
  seq: Op[],
  env: HarnessEnv,
  driver: Driver,
  opts: { reap?: boolean; settleTurns?: number; settleAfterOpTurns?: number } = {},
): Promise<CellResult> {
  settleTurns = opts.settleTurns ?? 0;
  // After a lifecycle op, let the surface's real async work (a start's
  // key/storage reads) run to quiescence before the clock moves.
  const afterOp = () => settleReal(opts.settleAfterOpTurns ?? settleTurns);
  RelaySocket.all = [];
  seqNo = 0;
  admissionOrder = 0;
  stallUntil = 0;
  lastZombieClose = null;
  reap = opts.reap === true;
  surfaceRunning = false;
  surfaceTarget = RELAY_A;
  const firstIdentity = driver.initialIdentity ?? FIRST_IDENTITY;
  surfaceIdentity = firstIdentity;
  relayLogs.clear();
  let inboundN = 0;
  let identityN = 1;
  const published: Array<{ id: string; relay: string; motebit: string; running: boolean }> = [];
  const t0 = Date.now();
  let target = RELAY_A;
  let identity = firstIdentity;
  let running = false;
  let lastRunStart = 0;
  // Run-state timeline: [time, running, target] from each lifecycle op.
  const timeline: Array<[number, boolean, string]> = [];
  /**
   * [frame sequence, running, relay, identity] at each lifecycle op: frames
   * are ordered against ops by sequence, not by clock — a push sent in the
   * same millisecond as a stop, but before it, was sent while running.
   */
  const targetLine: Array<[number, boolean, string, string]> = [];
  /** The same marks by clock time, with identity (for HTTP syncs). */
  const timelineIds: Array<[number, boolean, string, string]> = [];
  const mark = () => {
    timeline.push([Date.now(), running, target]);
    targetLine.push([seqNo, running, target, identity]);
    timelineIds.push([Date.now(), running, target, identity]);
  };
  const startRun = (relay: string, motebit = identity) => {
    const moved = relay !== target || motebit !== identity;
    target = relay;
    identity = motebit;
    running = true;
    surfaceRunning = true;
    surfaceTarget = relay;
    surfaceIdentity = motebit;
    lastRunStart = Date.now();
    if (moved) markTargetChange();
    mark();
  };
  // Local-store snapshots: at every probe while running, and at every stop.
  const snapshots: Array<{ ids: Set<string>; publishedBefore: number }> = [];
  let lastStopIds: Set<string> | null = null;
  const stopRun = async () => {
    if (running) lastStopIds = new Set(await driver.localEventIds());
    running = false;
    surfaceRunning = false;
    mark();
  };
  const commands: Array<{
    id: string;
    socket: RelaySocket | null;
    deliveredAt: number;
    running: boolean;
  }> = [];
  let nEvents = 0;
  let cmdN = 0;

  const probe = async () => {
    if (running) {
      snapshots.push({
        ids: new Set(await driver.localEventIds()),
        publishedBefore: published.length,
      });
    }
    const id = `cmd-${++cmdN}`;
    // main's pick: the first admitted open socket of the target, in admission order
    const socket =
      RelaySocket.all
        .filter((s) => s.relay === target && s.motebit === identity && s.isOpen && s.accepted)
        .sort((a, b) => a.admittedAt - b.admittedAt)[0] ?? null;
    commands.push({ id, socket, deliveredAt: Date.now(), running });
    if (socket) {
      socket.deliver(await driver.commandFrame(id));
      if (settleTurns > 0 && env.duration === 0) {
        // Real async execution (web): let it answer before the clock moves.
        for (let i = 0; i < 50; i++) {
          if (RelaySocket.all.some((s) => s.sent.some((f) => f.data.includes(`"${id}"`)))) break;
          await settleReal(5);
        }
      }
    }
    await driver.appendEvent(`evt-${++nEvents}`, identity).catch(() => {});
    // Another device publishes an event to the target relay and identity:
    // stored in the relay's log (for catch-up pulls) and fanned out to the
    // identity's admitted sockets.
    const key = logKey(target, identity);
    const log = relayLogs.get(key) ?? [];
    relayLogs.set(key, log);
    const n = ++inboundN;
    const inbound = {
      event_id: `in-${n}`,
      motebit_id: identity,
      device_id: "other-device",
      timestamp: 1,
      event_type: "state_updated",
      payload: { n },
      // Spaced far above anything this device can assign itself: the relay
      // stores device-assigned clocks, and a pull cursor is the local max
      // clock, so an event another device publishes with the SAME clock as
      // one this device appended meanwhile is never pulled (a pre-existing
      // SyncEngine property, unchanged by #816 and demonstrated on its own by
      // a sync-engine probe). With adjacent clocks, whether that race fires
      // depends only on when a controller happens to pull — noise in a
      // comparison of controllers, not a controller difference.
      version_clock: 1_000_000 * n,
      tombstoned: false,
    };
    log.push(inbound);
    published.push({ id: inbound.event_id, relay: target, motebit: identity, running });
    for (const s of RelaySocket.all)
      if (s.relay === target && s.motebit === identity && s.isOpen && s.accepted)
        s.deliver({ type: "event", event: inbound });
    await vi.advanceTimersByTimeAsync(0);
  };

  /** Probe before any new socket opens, after it opens, and a step later. */
  const probeOp = async () => {
    await afterOp();
    await probe();
    await advance(TICK_MS);
    await probe();
    await advance(STEP_MS);
    await probe();
  };

  startRun(RELAY_A);
  driver.start(RELAY_A, { bail: false });
  await probeOp();

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
        startRun(target === RELAY_A ? RELAY_B : RELAY_A);
        driver.start(target, { bail: false });
        break;
      case "reenter":
        startRun(target);
        driver.start(target, { bail: false });
        break;
      case "reenter-other":
        startRun(target === RELAY_A ? RELAY_B : RELAY_A);
        driver.start(target, { bail: false });
        break;
      case "identity": {
        const next = `motebit-${++identityN}`;
        driver.switchIdentity(next);
        startRun(target, next);
        driver.start(target, { bail: false });
        break;
      }
      case "bail":
        driver.start(target, { bail: true });
        break;
      case "refresh":
        await advance(REFRESH_MS - STEP_MS);
        break;
      case "drop":
        for (const s of openSockets()) s.drop();
        break;
      case "stall":
        stallUntil = Date.now() + STALL_MS;
        break;
    }
    await probeOp();
  }

  await advance(SETTLE_MS);
  const drainFrom = Date.now();
  await probe();
  // Long enough for a surface that pushes on a cycle (mobile: 30 s) to
  // deliver the final event, and for the last command's deadline to pass.
  await advance(DRAIN_MS);

  // --- commands: answered on any admitted socket of the delivered peer's
  // relay and identity, before the deadline ---
  const answered = commands.filter(({ id, socket, deliveredAt, running: wasRunning }) => {
    if (!socket || !wasRunning) return false;
    const deadline = deliveredAt + COMMAND_DEADLINE_MS;
    return RelaySocket.all.some(
      (s) =>
        s.relay === socket.relay &&
        s.motebit === socket.motebit &&
        s.sent.some(
          (f) =>
            f.admitted &&
            f.time <= deadline &&
            f.data.includes('"command_response"') &&
            f.data.includes(`"${id}"`),
        ),
    );
  }).length;

  // --- outbound events: delivered on their own identity's admitted socket,
  // to the relay and identity the running surface targets at that moment ---
  const delivered = new Set<string>(env.httpDelivered ?? []);
  let misrouted = env.httpMisrouted ?? 0;
  const targetAt = (seq: number): { running: boolean; relay: string; motebit: string } => {
    let st = { running: false, relay: RELAY_A, motebit: firstIdentity };
    for (const [markSeq, r, tg, id] of targetLine) {
      if (markSeq < seq) st = { running: r, relay: tg, motebit: id };
    }
    return st;
  };
  for (const s of RelaySocket.all)
    for (const f of s.sent) {
      if (!f.admitted || !f.data.includes('"push"')) continue;
      const at = targetAt(f.seq);
      const onTarget = at.running && s.relay === at.relay && s.motebit === at.motebit;
      let events: Array<{ event_id?: string; motebit_id?: string }> = [];
      try {
        events = (JSON.parse(f.data) as { events?: typeof events }).events ?? [];
      } catch {
        continue;
      }
      for (const e of events) {
        if (e.event_id == null || !e.event_id.startsWith("evt-")) continue;
        if (e.motebit_id !== s.motebit) misrouted++;
        else if (onTarget) delivered.add(e.event_id);
      }
    }

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
            at: c.deliveredAt - t0,
            running: c.running,
            socket: c.socket ? RelaySocket.all.indexOf(c.socket) : null,
          })),
          sockets: RelaySocket.all.map((s, i) => ({
            i,
            relay: s.relay,
            motebit: s.motebit,
            admittedAt: s.admittedAt,
            closedAt: s.closedAt,
            zombie: s.zombie,
            sent: s.sent.map(
              (f) =>
                `${f.time - t0}${f.admitted ? "" : "(unadmitted)"}:${f.data.slice(0, 70)}` +
                ` ${(f.data.match(/evt-\d+/g) ?? []).join(",")}`,
            ),
          })),
        },
        null,
        1,
      ) + "\n",
    );
  }

  // --- HTTP: overdue time and first sync of the last run ---
  // The run state at a time, by clock (HTTP syncs carry no frame sequence):
  // running, target relay, target identity.
  const stateAt = (t: number): [boolean, string, string] => {
    let st: [boolean, string, string] = [false, RELAY_A, firstIdentity];
    for (const [markSeqTime, r, tg, id] of timelineIds) if (markSeqTime <= t) st = [r, tg, id];
    return st;
  };
  let firstInLastRun: number | null = null;
  const legit: Array<{ at: number; url: string }> = [];
  for (const { at, url } of env.httpSyncs) {
    if (at >= drainFrom) continue;
    const [isRunning, tgt, id] = stateAt(at);
    // A sync the user asked for: running, to the target relay, for the
    // target identity (a pull for an identity the surface has left is not).
    if (!isRunning || !url.startsWith(tgt) || motebitOf(url) !== id) continue;
    legit.push({ at, url });
    if (at >= lastRunStart && firstInLastRun == null) firstInLastRun = at - lastRunStart;
  }
  const intervals: Array<{ from: number; to: number; target: string }> = [];
  for (let i = 0; i < timeline.length; i++) {
    const [at, isRunning, tgt] = timeline[i]!;
    const next = i + 1 < timeline.length ? timeline[i + 1]![0] : drainFrom;
    if (!isRunning || next <= at) continue;
    const last = intervals[intervals.length - 1];
    if (last && last.to === at && last.target === tgt) last.to = Math.min(next, drainFrom);
    else intervals.push({ from: at, to: Math.min(next, drainFrom), target: tgt });
  }
  // Whole ticks since the cell began: sub-tick placement can depend on host
  // speed where a surface awaits real I/O.
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

  // --- inbound ---
  const lastIsStop = seq.length > 0 && seq[seq.length - 1] === "stop";
  const openEnd = openSockets().filter((s) => s.accepted).length;
  const openAtAll = openSockets().length;
  const owed = new Set(
    published
      .filter((p) => p.running && p.relay === target && p.motebit === identity)
      .map((p) => p.id),
  );
  const finalIds =
    running || lastStopIds == null ? new Set(await driver.localEventIds()) : lastStopIds;
  const inboundIds = new Set([...finalIds].filter((id) => owed.has(id)));
  if (debugPath) {
    (await fs()).appendFileSync(
      `${debugPath}.inbound`,
      JSON.stringify({
        owed: [...owed],
        inbound: [...inboundIds],
        published: published.map((p) => [p.id, p.relay, p.running]),
        snapshots: snapshots.map((x) => [...x.ids].filter((id) => id.startsWith("in-"))),
      }) + "\n",
    );
  }
  let timely = 0;
  for (const snap of snapshots) {
    for (const p of published.slice(0, snap.publishedBefore)) {
      if (owed.has(p.id) && snap.ids.has(p.id)) timely++;
    }
  }
  return {
    commands: answered,
    events: delivered.size,
    misrouted,
    inbound: inboundIds.size,
    timely,
    zombies: RelaySocket.all.filter((s) => s.zombie).length,
    http: overdue,
    firstHttp: firstInLastRun == null ? null : Math.floor(firstInLastRun / TICK_MS) * TICK_MS,
    openEnd,
    leak: lastIsStop ? openAtAll : null,
  };
}

export interface Comparison {
  cells: number;
  mainBetter: string[];
  branchBetter: string[];
  invariantBreaks: string[];
}

/**
 * The raw-baseline check: every cell where RAW main beats the branch must
 * be one where main had a zombie socket. It verifies the zombie's presence
 * in that cell; causation is the reaped comparison's job. Returns the cells
 * that fail it (must be empty).
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

/** Compare a branch run against a main baseline, cell by cell. */
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
    // their HTTP overdue time and first sync too.
    if (opts.periodicHttp) {
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
    if (b.misrouted > 0) invariantBreaks.push(`${key}: ${b.misrouted} misrouted event(s)`);
    if (b.leak != null && b.leak > 0)
      invariantBreaks.push(`${key}: ${b.leak} socket(s) open after stop`);
  }
  return { cells: Object.keys(branch).length, mainBetter, branchBetter, invariantBreaks };
}
