/**
 * The long-lived relay socket a daemon holds — `motebit run` and
 * `motebit serve` both build theirs here (#820).
 *
 * The socket authenticates with a signed `sync` token, and a signed token
 * expires (5 minutes by default). The adapter reconnects on its own after a
 * sleep, a network flap or a relay deploy, and each reconnect presents a
 * token again. Both daemon paths used to mint ONE token at startup and hand
 * the adapter that string, so every reconnect after five minutes of uptime
 * presented an expired token, the relay refused it, and the daemon stayed
 * disconnected for good: no remote halt reached it, and the roster saw it
 * go. An always-on runtime that cannot stay reachable.
 *
 * So the adapter gets a `CredentialSource` instead of a string. The
 * adapter resolves it on every (re)connect, and this one mints a fresh
 * token from the device key each time.
 *
 * The key is read through a getter at each mint. On shutdown the daemon
 * zero-fills the key buffer in place (`secureErase`) and then drops its
 * reference, so the getter returns nothing and the source falls back. The
 * source also refuses an all-zero key outright: a reconnect that reads the
 * buffer after it was zero-filled, before the reference was dropped, must
 * not mint a token from an all-zero seed (the relay would refuse it, and
 * the configured fallback would never be tried).
 *
 * A `disconnect()` that lands while a reconnect is still minting opens no
 * socket afterwards: the adapter's `connect()` checks a connect generation
 * that `disconnect()` bumps before it opens one, and a pending auth timeout
 * from the closed socket no longer acts on the adapter (`ws-adapter.ts`,
 * #816).
 */
import { mintAudienceToken } from "@motebit/encryption";
import { WebSocketEventStoreAdapter } from "@motebit/sync-engine";
import type { CredentialSource } from "@motebit/sync-engine";
import type { EventStoreAdapter } from "@motebit/event-log";

export interface DeviceSyncCredentialOptions {
  motebitId: string;
  /** The device id the token names as `did`. No id ⇒ no signed token. */
  deviceId: string | undefined;
  /** The device's signing key, read at each mint. Absent ⇒ the fallback. */
  privateKey: () => Uint8Array | undefined;
  /**
   * The static token to present when no signed token can be minted — the
   * configured sync / master token, exactly what each path fell back to
   * before. Absent ⇒ connect without one.
   */
  fallbackToken?: string;
  /** Token lifetime. Default: `mintAudienceToken`'s own (5 minutes). A test seam. */
  ttlMs?: number;
  /**
   * Told when a mint fails and the fallback is used instead — once per
   * failed mint. Never passed the token or the key.
   */
  onMintError?: (err: unknown) => void;
}

/**
 * A credential source that mints a fresh `sync` token from the device key
 * on every call. Never rejects: the adapter awaits it without a catch, so a
 * rejection would leave the socket unconnected with no reconnect scheduled.
 */
export function deviceSyncCredentialSource(opts: DeviceSyncCredentialOptions): CredentialSource {
  return {
    async getCredential(): Promise<string | null> {
      const key = opts.privateKey();
      if (key != null && !isErased(key) && opts.deviceId != null && opts.deviceId !== "") {
        try {
          return (
            await mintAudienceToken(
              {
                mid: opts.motebitId,
                did: opts.deviceId,
                aud: "sync",
                ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
              },
              key,
            )
          ).token;
        } catch (err: unknown) {
          opts.onMintError?.(err);
        }
      }
      return opts.fallbackToken ?? null;
    },
  };
}

/** A zero-filled buffer is an erased key, not a key: never mint from it. */
function isErased(key: Uint8Array): boolean {
  return key.every((b) => b === 0);
}

export interface RelaySyncSocketOptions extends DeviceSyncCredentialOptions {
  /** The relay's HTTP(S) base URL; the socket URL is derived from it. */
  syncUrl: string;
  /** Capabilities announced on every connect. */
  capabilities: string[];
  httpFallback?: EventStoreAdapter;
  localStore?: EventStoreAdapter;
  /** Reconnect backoff base. Default: the adapter's own. A test seam. */
  reconnectBaseMs?: number;
}

/**
 * The daemon's relay socket: a `WebSocketEventStoreAdapter` whose token is
 * minted fresh on every connect. Not connected yet — the caller wires its
 * handlers first, then calls `connect()`.
 */
export function createRelaySyncSocket(opts: RelaySyncSocketOptions): WebSocketEventStoreAdapter {
  return new WebSocketEventStoreAdapter({
    url: opts.syncUrl.replace(/^http/, "ws") + `/ws/sync/${opts.motebitId}`,
    motebitId: opts.motebitId,
    credentialSource: deviceSyncCredentialSource(opts),
    capabilities: opts.capabilities,
    // Declared, not invented: the relay groups peers by machine.
    ...(opts.deviceId != null && opts.deviceId !== "" ? { deviceId: opts.deviceId } : {}),
    ...(opts.httpFallback ? { httpFallback: opts.httpFallback } : {}),
    ...(opts.localStore ? { localStore: opts.localStore } : {}),
    ...(opts.reconnectBaseMs !== undefined ? { reconnectBaseMs: opts.reconnectBaseMs } : {}),
  });
}
