/**
 * Where each CLI entry point starts pushing its events to its relay (#962):
 * the REPL (`replStartupSync`), `motebit run` (`startRunEventSync`),
 * `motebit serve` (`startServeEventSync`) and `motebit delegate`
 * (`openDelegateEventSync`). Each entry point calls its function here, so
 * the wiring it runs is the wiring under test
 * (`every-configured-surface-pushes-962.test.ts`): the entry points
 * themselves prompt for a passphrase, bind the runtime-host socket and
 * register with a relay, and cannot be driven in a unit test.
 */
import type { SyncEngine } from "@motebit/sync-engine";
import type { EventStoreAdapter } from "@motebit/event-log";
import type { DaemonRelaySync } from "./daemon-relay-sync.js";
import { bootstrapReplDevice, syncFailureLine } from "./runtime-factory.js";

/** The part of a `MotebitRuntime` the push wiring touches. */
export interface PushingRuntime {
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

export interface ReplStartupSyncOptions {
  runtime: PushingRuntime;
  syncUrl: string;
  motebitId: string;
  /** Present when the identity key opened: the device is bootstrapped first. */
  device?: { deviceId: string; publicKeyHex: string };
  log: (line: string) => void;
  warn: (line: string) => void;
  /** The periodic push interval (ms). */
  pushIntervalMs?: number;
}

/**
 * The REPL's sync at startup (index.ts): introduce the device's key to the
 * relay BEFORE the first push — signed device tokens do not verify
 * otherwise — then sync once, printing the result or the refusal.
 */
export async function replStartupSync(opts: ReplStartupSyncOptions): Promise<CliEventPush> {
  const { runtime, syncUrl, motebitId, device, log, warn } = opts;
  if (device) {
    const refused = await bootstrapReplDevice({
      syncUrl,
      motebitId,
      deviceId: device.deviceId,
      publicKeyHex: device.publicKeyHex,
    });
    if (refused) warn(refused);
  }
  try {
    log("Syncing...");
    const result = await runtime.sync.sync();
    // sync() never rejects: a refused push (401/403) is read here, never
    // silent — it holds compaction until the relay acknowledges (#962).
    const failed = syncFailureLine(runtime.sync);
    if (failed) {
      warn(failed);
    } else {
      log(`Synced: pulled ${result.pulled} events, pushed ${result.pushed} events`);
    }
    if (result.conflicts.length > 0) {
      log(`  [${result.conflicts.length} conflicts detected]`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    warn(`Sync failed (continuing offline): ${message}`);
  }
  return { stop() {} };
}

export interface DaemonEventSyncOptions {
  log: (line: string) => void;
  /** This daemon's device, when its identity key opened. */
  device?: PushDevice;
  syncUrl: string;
  /** The periodic push interval (ms). */
  pushIntervalMs?: number;
}

/** `motebit run`: its events sync through the daemon's relay event transport. */
export function startRunEventSync(
  runtime: PushingRuntime,
  relaySync: DaemonRelaySync,
  _opts: DaemonEventSyncOptions,
): CliEventPush {
  runtime.connectSync(relaySync.transport.remote);
  return { stop() {} };
}

/** `motebit serve` (HTTP transport with a relay): its events' sync. */
export function startServeEventSync(
  _runtime: PushingRuntime,
  _relaySync: DaemonRelaySync,
  _opts: DaemonEventSyncOptions,
): CliEventPush {
  return { stop() {} };
}

export interface DelegateEventSyncOptions extends DaemonEventSyncOptions {
  /** The identity key, when it opened (E2E + device tokens). */
  privateKey: () => Uint8Array | undefined;
  /** A configured long-lived token (operator master / sync token). */
  configuredToken?: string;
}

/** `motebit delegate`: its events' sync, closed before the command exits. */
export function openDelegateEventSync(
  _runtime: PushingRuntime,
  _opts: DelegateEventSyncOptions,
): Promise<{ close(): Promise<void> }> {
  return Promise.resolve({ close: () => Promise.resolve() });
}
