/**
 * The daemons' relay sync wiring — `motebit run`'s event remote, its socket
 * catch-up and its plan sync, and `motebit serve`'s socket catch-up — in one
 * function both daemons call (#928, #927).
 *
 * Extracted from `daemon.ts` so the wiring the daemons actually run is the
 * wiring under test: `handleRun` / `handleServe` open a database, prompt for
 * a passphrase, bind the runtime-host socket and register with a relay, so
 * they cannot be driven in a unit test. Everything that decides whether a
 * payload leaves this machine encrypted lives here instead.
 *
 * The sync key is derived HERE from the identity key, never passed in: the
 * `run` daemon held the identity key and still pushed events and plans in
 * plaintext, because the key that would have encrypted them was a separate
 * argument nobody supplied. Without an identity key (it did not decrypt)
 * there is nothing to encrypt with, and the transports stay raw — the one
 * raw-by-design case, reported through `e2e: false`.
 */
import { deriveSyncEncryptionKey } from "@motebit/encryption";
import {
  EncryptedPlanSyncAdapter,
  HttpPlanSyncAdapter,
  PlanSyncEngine,
} from "@motebit/sync-engine";
import type { PlanSyncStoreAdapter } from "@motebit/sync-engine";
import { createRelayEventTransport, type RelayEventTransport } from "./relay-sync-socket.js";

export interface DaemonRelaySyncOptions {
  syncUrl: string;
  motebitId: string;
  /** The device id minted tokens name as `did`. */
  deviceId: string | undefined;
  /**
   * The identity (device signing) key, read at each token mint and once now
   * to derive the sync encryption key. Returns nothing once erased.
   */
  privateKey: () => Uint8Array | undefined;
  /** A configured long-lived token (operator master / sync token), presented when set. */
  configuredToken?: string;
  onMintError?: (err: unknown) => void;
}

export interface DaemonRelaySync {
  /** The event transport: `remote` is the sync remote and the socket's catch-up source. */
  transport: RelayEventTransport;
  /** Whether events and plans leave this process encrypted. */
  e2e: boolean;
  /** A plan sync engine over `store`, encrypted exactly when events are. Not started. */
  planSync(store: PlanSyncStoreAdapter): PlanSyncEngine;
}

function usableKey(key: Uint8Array | undefined): key is Uint8Array {
  return key != null && key.length > 0 && !key.every((b) => b === 0);
}

export async function createDaemonRelaySync(
  opts: DaemonRelaySyncOptions,
): Promise<DaemonRelaySync> {
  const identityKey = opts.privateKey();
  const encKey = usableKey(identityKey) ? await deriveSyncEncryptionKey(identityKey) : undefined;
  const transport = createRelayEventTransport({
    syncUrl: opts.syncUrl,
    motebitId: opts.motebitId,
    deviceId: opts.deviceId,
    privateKey: opts.privateKey,
    ...(opts.configuredToken != null ? { configuredToken: opts.configuredToken } : {}),
    ...(opts.onMintError ? { onMintError: opts.onMintError } : {}),
    ...(encKey ? { encKey } : {}),
  });
  return {
    transport,
    e2e: transport.e2e,
    planSync(store: PlanSyncStoreAdapter): PlanSyncEngine {
      const engine = new PlanSyncEngine(store, opts.motebitId);
      // The plan poll resolves its credential per request (#927).
      const http = new HttpPlanSyncAdapter({
        baseUrl: opts.syncUrl,
        motebitId: opts.motebitId,
        credentialSource: transport.credentials,
      });
      engine.connectRemote(
        encKey ? new EncryptedPlanSyncAdapter({ inner: http, key: encKey }) : http,
      );
      return engine;
    },
  };
}
