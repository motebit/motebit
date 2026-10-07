/**
 * Where each CLI entry point starts pushing its events to its relay (#962):
 * the REPL (`replStartupSync`), `motebit run` (`startRunEventSync`),
 * `motebit serve` (`startServeEventSync`) and `motebit delegate`
 * (`openDelegateEventSync`). Each entry point calls its function here, so
 * the wiring it runs is the wiring under test
 * (`every-configured-surface-pushes-962.test.ts`): the entry points
 * themselves prompt for a passphrase, bind the runtime-host socket and
 * register with a relay, and cannot be driven in a unit test.
 *
 * The invariant every entry point keeps: when sync is configured and the
 * relay accepts, the events this process appends are acknowledged within
 * one push interval with no user action — so compaction, floored at the
 * relay's acknowledged push cursor, keeps running — and while the relay is
 * unreachable or refusing, that is said in one line, never silently. The
 * daemons connected their event remote and never pushed (only the REPL's
 * startup, exit and `/sync` did), so a daemon-only `motebit.db` grew for
 * good with nothing said.
 */
import { recordSyncIntent } from "@motebit/sync-engine";
import type { SyncEngine, SyncResult } from "@motebit/sync-engine";
import type { EventStoreAdapter } from "@motebit/event-log";
import { createDaemonRelaySync, type DaemonRelaySync } from "./daemon-relay-sync.js";
import {
  bootstrapReplDevice,
  openMotebitDatabase,
  sanitizeRelayText,
  syncFailureLine,
} from "./runtime-factory.js";
import { bootstrapIdentity } from "./identity.js";
import { pinnedFloorNotice } from "./subcommands/sync.js";
import type { FullConfig } from "./config.js";

/** The periodic push cadence: the plan sync's (30 s). */
export const PUSH_INTERVAL_MS = 30_000;
/** The longest a failing push loop waits between tries (#962 round 5). */
export const PUSH_BACKOFF_CAP_MS = 10 * 60_000;

/**
 * The wait before the next push cycle (#962 round 5): the plain interval
 * after a success; after `failures` consecutive failures, exponential
 * (`intervalMs × 2^failures`, capped at `PUSH_BACKOFF_CAP_MS`) with jitter
 * (between half and all of it), so an unreachable relay is not asked every
 * interval for good (2 880 times a day per idle process) and many clients
 * never retry in lockstep.
 */
export function pushRetryDelay(
  intervalMs: number,
  failures: number,
  random: () => number = Math.random,
): number {
  if (failures <= 0) return intervalMs;
  const cap = Math.max(PUSH_BACKOFF_CAP_MS, intervalMs);
  const nominal = Math.min(cap, intervalMs * 2 ** Math.min(failures, 30));
  return Math.round(nominal * (0.5 + 0.5 * random()));
}

/** How long `motebit delegate` waits for its last push before it exits. */
const EXIT_FLUSH_MS = 15_000;

/** The part of a `MotebitRuntime` the push wiring touches. */
export interface PushingRuntime {
  readonly motebitId: string;
  readonly sync: SyncEngine;
  connectSync(remote: EventStoreAdapter): void;
}

/** A started push; `stop()` ends it. */
export interface CliEventPush {
  stop(): void;
}

/** The device credentials a push re-introduces to its relay. */
export interface PushDevice {
  motebitId: string;
  deviceId: string;
  publicKeyHex: string;
}

interface PushLoop extends CliEventPush {
  /** One push cycle now (joining one in flight): its result, or null when it failed. */
  cycle(): Promise<SyncResult | null>;
  /** The cycle in flight settles, then one more runs: everything appended so far is tried. */
  flush(): Promise<SyncResult | null>;
}

/** A refusal of this device's credential — the relay does not know its key (yet). */
function isAuthRefusal(err: Error): boolean {
  return /\b40[13]\b/.test(err.message);
}

/**
 * The push loop every CLI entry point runs: a push cycle now, then one every
 * `intervalMs` — backing off exponentially, with jitter, while cycles fail
 * (`pushRetryDelay`), back to the interval on the first success. A failure
 * is reported once when it starts (and again if its reason changes), and the
 * recovery once — never a line per tick. A 401/403 re-introduces the
 * device's key (`bootstrap`) once per failure streak, then pushes again at
 * once (#962 P1: a relay unreachable at start never heard the startup
 * bootstrap, and refused every push for the session). Every line carrying
 * relay text is sanitized (`sanitizeRelayText`).
 */
function startPushLoop(opts: {
  sync: SyncEngine;
  intervalMs: number;
  report: (line: string) => void;
  syncUrl: string;
  device?: PushDevice | undefined;
}): PushLoop {
  let failing: string | null = null;
  let rebootstrapped = false;
  let running: Promise<SyncResult | null> | null = null;
  let failures = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const once = async (): Promise<SyncResult | null> => {
    let result = await opts.sync.sync();
    let err = opts.sync.getLastError();
    if (err && isAuthRefusal(err) && opts.device && !rebootstrapped) {
      rebootstrapped = true;
      const refused = await bootstrapReplDevice({ syncUrl: opts.syncUrl, ...opts.device });
      if (refused) opts.report(refused);
      result = await opts.sync.sync();
      err = opts.sync.getLastError();
    }
    const line = syncFailureLine(opts.sync);
    if (line) {
      if (line !== failing) opts.report(line);
      failing = line;
      failures++;
      return null;
    }
    if (failing) opts.report("Sync resumed: the relay acknowledged the pending events");
    failing = null;
    rebootstrapped = false;
    failures = 0;
    return result;
  };
  // The next cycle, timed from the end of the last one.
  const schedule = (): void => {
    clearTimeout(timer);
    if (stopped) return;
    timer = setTimeout(() => void cycle(), pushRetryDelay(opts.intervalMs, failures));
    timer.unref?.();
  };
  const cycle = (): Promise<SyncResult | null> => {
    running ??= once()
      .catch((err: unknown) => {
        failures++;
        const line = `Sync failed (continuing offline): ${sanitizeRelayText(
          err instanceof Error ? err.message : String(err),
        )}`;
        if (line !== failing) opts.report(line);
        failing = line;
        return null;
      })
      .finally(() => {
        running = null;
        schedule();
      });
    return running;
  };
  schedule();
  return {
    cycle,
    async flush() {
      if (running) await running;
      return cycle();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

export interface ReplStartupSyncOptions {
  runtime: PushingRuntime;
  syncUrl: string;
  motebitId: string;
  /** Present when the identity key opened: the device is bootstrapped first. */
  device?: { deviceId: string; publicKeyHex: string };
  log: (line: string) => void;
  warn: (line: string) => void;
  /** The periodic push interval (ms). Default `PUSH_INTERVAL_MS`. */
  pushIntervalMs?: number;
  /**
   * The REPL's `motebit.db` event store (#962 round 6): after the first
   * cycle, a relay stream pinning compaction is named in one line
   * (`pinnedFloorNotice`). Required, so no REPL start can skip it.
   */
  eventStore: EventStoreAdapter;
}

/**
 * The REPL's sync at startup (index.ts): introduce the device's key to the
 * relay BEFORE the first push — signed device tokens do not verify
 * otherwise — then sync once, printing the result or the refusal, then keep
 * pushing every interval for the session. A relay stream pinning compaction
 * is then named once (#962 round 6).
 */
export async function replStartupSync(opts: ReplStartupSyncOptions): Promise<CliEventPush> {
  const { runtime, syncUrl, motebitId, device, log, warn } = opts;
  const pushDevice = device ? { motebitId, ...device } : undefined;
  if (pushDevice) {
    const refused = await bootstrapReplDevice({ syncUrl, ...pushDevice });
    if (refused) warn(refused);
  }
  log("Syncing...");
  const loop = startPushLoop({
    sync: runtime.sync,
    intervalMs: opts.pushIntervalMs ?? PUSH_INTERVAL_MS,
    report: warn,
    syncUrl,
    device: pushDevice,
  });
  // The first cycle reports its own refusal (warn); success is printed here.
  const result = await loop.cycle();
  if (result) {
    log(`Synced: pulled ${result.pulled} events, pushed ${result.pushed} events`);
    if (result.conflicts.length > 0) {
      log(`  [${result.conflicts.length} conflicts detected]`);
    }
  }
  // Once per session, after the first cycle (a reachable relay has acked by
  // now): a relay stream holding compaction back is never silent (#962
  // round 6). Best-effort — a report that cannot be read prints nothing.
  const pinned = await pinnedFloorNotice(opts.eventStore, motebitId, syncUrl).catch(() => null);
  if (pinned) log(pinned);
  return loop;
}

export interface DaemonEventSyncOptions {
  log: (line: string) => void;
  /** This daemon's device, when its identity key opened. */
  device?: PushDevice;
  syncUrl: string;
  /** The periodic push interval (ms). Default `PUSH_INTERVAL_MS`. */
  pushIntervalMs?: number;
}

/** A daemon's events: connected through its relay event transport, and pushed. */
function startDaemonEventSync(
  runtime: PushingRuntime,
  relaySync: DaemonRelaySync,
  opts: DaemonEventSyncOptions,
): PushLoop {
  runtime.connectSync(relaySync.transport.remote);
  const loop = startPushLoop({
    sync: runtime.sync,
    intervalMs: opts.pushIntervalMs ?? PUSH_INTERVAL_MS,
    report: opts.log,
    syncUrl: opts.syncUrl,
    device: opts.device,
  });
  void loop.cycle();
  return loop;
}

/** `motebit run`: its events sync through the daemon's relay event transport, pushed every interval. */
export function startRunEventSync(
  runtime: PushingRuntime,
  relaySync: DaemonRelaySync,
  opts: DaemonEventSyncOptions,
): CliEventPush {
  return startDaemonEventSync(runtime, relaySync, opts);
}

/**
 * `motebit serve` (HTTP transport with a relay): its events sync exactly as
 * `run`'s do. It used to connect no event remote at all.
 */
export function startServeEventSync(
  runtime: PushingRuntime,
  relaySync: DaemonRelaySync,
  opts: DaemonEventSyncOptions,
): CliEventPush {
  return startDaemonEventSync(runtime, relaySync, opts);
}

export interface DelegateEventSyncOptions extends DaemonEventSyncOptions {
  /** The identity key, when it opened (E2E + device tokens). */
  privateKey: () => Uint8Array | undefined;
  /** A configured long-lived token (operator master / sync token). */
  configuredToken?: string;
}

/**
 * `motebit delegate`: its events push while the plan runs, and once more
 * before the command exits (bounded); a last push that does not finish is
 * said, and the events stay local for the next process to push.
 */
export async function openDelegateEventSync(
  runtime: PushingRuntime,
  opts: DelegateEventSyncOptions,
): Promise<{ close(): Promise<void> }> {
  const relaySync = await createDaemonRelaySync({
    syncUrl: opts.syncUrl,
    motebitId: runtime.motebitId,
    deviceId: opts.device?.deviceId,
    privateKey: opts.privateKey,
    ...(opts.configuredToken != null ? { configuredToken: opts.configuredToken } : {}),
  });
  // The device's key is introduced before the first push, as the REPL and
  // the daemons (registration) do.
  if (opts.device) {
    const refused = await bootstrapReplDevice({ syncUrl: opts.syncUrl, ...opts.device });
    if (refused) opts.log(refused);
  }
  const loop = startDaemonEventSync(runtime, relaySync, opts);
  let closing: Promise<void> | null = null;
  return {
    close() {
      closing ??= (async () => {
        loop.stop();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const late = new Promise<"late">((r) => {
          timer = setTimeout(() => r("late"), EXIT_FLUSH_MS);
        });
        const outcome = await Promise.race([loop.flush(), late]);
        clearTimeout(timer);
        if (outcome === "late") {
          opts.log(
            "Sync on exit did not finish: the events stay in motebit.db and the next motebit process pushes them",
          );
        }
      })();
      return closing;
    },
  };
}

export interface ReplIdentityOptions {
  /** The REPL's `motebit.db`. */
  dbPath: string;
  fullConfig: FullConfig;
  passphrase: string;
  /**
   * Whether this REPL names a relay (flag, env, config.json). Relay sync is
   * opt-in (`sync-opt-in.ts`): with none, no sync intent is recorded, so
   * compaction is never floored on a relay the identity was never given.
   * Default true (the pre-opt-in behaviour).
   */
  syncConfigured?: boolean;
}

/**
 * The REPL's identity bootstrap (index.ts), before any runtime or sync: the
 * first launch mints the identity and appends its events to `motebit.db`.
 * On a machine where another motebit process already holds the runtime
 * socket, the REPL then attaches as a frontend and never connects sync
 * itself.
 */
export async function bootstrapReplIdentity(
  opts: ReplIdentityOptions,
): Promise<{ motebitId: string; isFirstLaunch: boolean }> {
  const db = await openMotebitDatabase(opts.dbPath);
  try {
    // #962 round 5: a REPL that names a relay syncs, so
    // this identity's sync intent is recorded in the DATABASE — before the
    // bootstrap appends when the identity already exists, and for a new one
    // right after it is minted, before any other process can compact. A
    // daemon that holds the runtime socket and names no relay then floors
    // compaction on it. A failed write aborts the launch (fail closed).
    // Relay sync off (opt-in): nothing is recorded.
    const syncs = opts.syncConfigured !== false;
    const known = opts.fullConfig.motebit_id;
    if (syncs && known != null && known !== "") await recordSyncIntent(db.eventStore, known);
    const result = await bootstrapIdentity(db, opts.fullConfig, opts.passphrase);
    if (syncs) await recordSyncIntent(db.eventStore, result.motebitId);
    return result;
  } finally {
    db.close();
  }
}
