/**
 * Spatial sync controller — owns the relay lifecycle: identity bootstrap,
 * agent registration + heartbeat, encrypted WebSocket event sync, plan
 * sync, conversation sync, delegation wiring, token refresh, and
 * orphaned-step recovery.
 *
 * Mirrors the desktop/mobile SyncController pattern — class owns all
 * sync state; runtime, identity, and keypair access come in via
 * getter closures.
 *
 * ### State ownership
 *
 *   - UI status projection (`_syncStatus`, listener set, setSyncStatus)
 *   - Heartbeat timer + last auth token
 *   - WebSocket state (adapter, token refresh timer, event and
 *     sync-engine status unsubscribes)
 *   - Plan + conversation sync engines
 *
 * ### Why private key bytes stay on SpatialApp
 *
 * `_privKeyBytes` also feeds `exportIdentity`, so it lives on the app
 * kernel. The sync controller reads it through a getter (`getPrivKey`)
 * and erases it via `clearPrivKey` when the relay disconnects — the
 * app kernel cooperates by nulling its own reference in that hook.
 */

import type { MotebitRuntime, StorageAdapters } from "@motebit/runtime";
import { executeCommand, cmdSelfTest, RelayDelegationAdapter } from "@motebit/runtime";
import { DeviceCapability } from "@motebit/sdk";
import type { SyncStatus as SyncEngineStatus } from "@motebit/sync-engine";
import { deriveSyncEncryptionKey, secureErase } from "@motebit/encryption";
import {
  HttpEventStoreAdapter,
  WebSocketEventStoreAdapter,
  EncryptedEventStoreAdapter,
  EncryptedConversationSyncAdapter,
  EncryptedPlanSyncAdapter,
  decryptEventPayload,
  PlanSyncEngine,
  HttpPlanSyncAdapter,
  ConversationSyncEngine,
  HttpConversationSyncAdapter,
} from "@motebit/sync-engine";
import {
  IdbConversationStore,
  IdbConversationSyncStore,
  IdbPlanStore,
  IdbPlanSyncStore,
} from "@motebit/browser-persistence";
import type { SpatialNetworkSettings } from "./spatial-app";

type InternalSyncStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "syncing"
  | "error"
  | "conflict";

const HEARTBEAT_INTERVAL_MS = 5 * 60_000; // 5 minutes

export interface SpatialSyncControllerDeps {
  getRuntime: () => MotebitRuntime | null;
  getMotebitId: () => string;
  getDeviceId: () => string;
  getPublicKey: () => string;
  getNetworkSettings: () => SpatialNetworkSettings;
  getStorage: () => StorageAdapters | null;
  getPlanStore: () => IdbPlanStore | null;
  /** Returns the ephemeral private key bytes held by SpatialApp, or null. */
  getPrivKey: () => Uint8Array | null;
  /** Erase the private key bytes owned by SpatialApp. Called on disconnectRelay. */
  clearPrivKey: () => void;
  /** Signed-token factory, null if identity not bootstrapped. */
  getTokenFactory: () => (() => Promise<string>) | null;
}

export class SpatialSyncController {
  private _syncStatus: InternalSyncStatus = "disconnected";
  private _syncStatusListeners = new Set<(status: string) => void>();

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private relayAuthToken: string | null = null;

  private _wsAdapter: WebSocketEventStoreAdapter | null = null;
  private _wsTokenRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private _wsUnsubOnEvent: (() => void) | null = null;
  private _syncUnsubscribe: (() => void) | null = null;

  private _planSyncEngine: PlanSyncEngine | null = null;
  private _convSyncEngine: ConversationSyncEngine | null = null;

  constructor(private deps: SpatialSyncControllerDeps) {}

  get syncStatus(): string {
    return this._syncStatus;
  }

  /** Last relay auth token minted during connectRelay, or null. Read by
   *  voice commands that need to construct a RelayConfig for delegation
   *  (the inner chat path uses the tokenFactory getter instead). */
  get lastAuthToken(): string | null {
    return this.relayAuthToken;
  }

  onSyncStatusChange(cb: (status: string) => void): () => void {
    this._syncStatusListeners.add(cb);
    return () => {
      this._syncStatusListeners.delete(cb);
    };
  }

  private setSyncStatus(status: InternalSyncStatus): void {
    this._syncStatus = status;
    for (const cb of this._syncStatusListeners) cb(status);
  }

  /**
   * Connect to the relay: bootstrap identity, register for discovery, start heartbeat,
   * open encrypted WebSocket for real-time event sync, wire delegation adapter through
   * the WebSocket, and start plan sync.
   *
   * Best-effort — any relay error is swallowed; the app works offline.
   * Must be called after bootstrap() and initAI().
   */
  async connectRelay(): Promise<void> {
    const { relayUrl, showNetwork } = this.deps.getNetworkSettings();
    if (relayUrl === "" || !showNetwork) return;

    this.setSyncStatus("connecting");

    const motebitId = this.deps.getMotebitId();
    const tokenFactory = this.deps.getTokenFactory();

    // Mint an initial token
    let authToken: string | null = null;
    if (tokenFactory) {
      try {
        authToken = await tokenFactory();
        this.relayAuthToken = authToken;
      } catch {
        // No private key — relay auth will be anonymous
      }
    }

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

    // 1. Bootstrap identity on relay
    try {
      await fetch(`${relayUrl}/api/v1/agents/bootstrap`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          motebit_id: motebitId,
          device_id: this.deps.getDeviceId(),
          public_key: this.deps.getPublicKey(),
        }),
      });
    } catch {
      // Best-effort
    }

    // 2. Register capabilities for discovery
    const runtime = this.deps.getRuntime();
    const toolNames =
      runtime
        ?.getToolRegistry()
        .list()
        .map((t) => t.name) ?? [];
    try {
      const regResp = await fetch(`${relayUrl}/api/v1/agents/register`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          motebit_id: motebitId,
          endpoint_url: relayUrl,
          capabilities: toolNames,
          metadata: { name: `spatial-${motebitId.slice(0, 8)}`, transport: "http" },
        }),
      });

      if (regResp.ok) {
        this.heartbeatTimer = setInterval(() => {
          void (async () => {
            try {
              const tf = this.deps.getTokenFactory();
              const freshToken = tf ? await tf() : authToken;
              const hbHeaders: Record<string, string> = { "Content-Type": "application/json" };
              if (freshToken) hbHeaders["Authorization"] = `Bearer ${freshToken}`;
              await fetch(`${relayUrl}/api/v1/agents/heartbeat`, {
                method: "POST",
                headers: hbHeaders,
              });
            } catch {
              // Best-effort heartbeat
            }
          })();
        }, HEARTBEAT_INTERVAL_MS);
      }
    } catch {
      // Best-effort registration
    }

    // 3. Real-time event sync via encrypted WebSocket
    const privKeyBytes = this.deps.getPrivKey();
    if (runtime && authToken && privKeyBytes) {
      try {
        const encKey = await deriveSyncEncryptionKey(privKeyBytes);
        const storage = this.deps.getStorage();
        const localEventStore = storage?.eventStore ?? null;

        // HTTP fallback adapter (for initial sync / offline recovery)
        const httpAdapter = new HttpEventStoreAdapter({
          baseUrl: relayUrl,
          motebitId,
          authToken,
        });
        const encryptedHttp = new EncryptedEventStoreAdapter({ inner: httpAdapter, key: encKey });

        // WebSocket adapter (real-time)
        const wsUrl =
          relayUrl.replace(/^https?/, (m) => (m === "https" ? "wss" : "ws")) +
          "/ws/sync/" +
          motebitId;

        const wsAdapter = new WebSocketEventStoreAdapter({
          url: wsUrl,
          motebitId,
          authToken,
          capabilities: [DeviceCapability.HttpMcp],
          httpFallback: encryptedHttp,
          localStore: localEventStore ?? undefined,
        });
        this._wsAdapter = wsAdapter;

        // Wire delegation through the WebSocket (not no-op)
        const delegationAdapter = new RelayDelegationAdapter({
          syncUrl: relayUrl,
          motebitId,
          authToken: authToken ?? undefined,
          sendRaw: (data: string) => wsAdapter.sendRaw(data),
          onCustomMessage: (cb) => wsAdapter.onCustomMessage(cb),
          getExplorationDrive: () => this.deps.getRuntime()?.getPrecision().explorationDrive,
        });
        runtime.setDelegationAdapter(delegationAdapter);

        const encryptedWs = new EncryptedEventStoreAdapter({ inner: wsAdapter, key: encKey });

        // Inbound real-time events: decrypt and write to local store
        this._wsUnsubOnEvent = wsAdapter.onEvent((raw) => {
          void (async () => {
            if (!localEventStore) return;
            const dec = await decryptEventPayload(raw, encKey);
            await localEventStore.append(dec);
          })();
        });

        // Handle remote command requests (forwarded by relay)
        wsAdapter.onCustomMessage((msg) => {
          const rt = this.deps.getRuntime();
          if (msg.type !== "command_request" || !rt) return;
          const cmdMsg = msg as unknown as { id: string; command: string; args?: string };
          void (async () => {
            try {
              const result = await executeCommand(rt, cmdMsg.command, cmdMsg.args);
              wsAdapter.sendRaw(
                JSON.stringify({ type: "command_response", id: cmdMsg.id, result }),
              );
            } catch (err: unknown) {
              wsAdapter.sendRaw(
                JSON.stringify({
                  type: "command_response",
                  id: cmdMsg.id,
                  result: {
                    summary: `Error: ${err instanceof Error ? err.message : String(err)}`,
                  },
                }),
              );
            }
          })();
        });

        runtime.connectSync(encryptedWs);
        wsAdapter.connect();

        // Subscribe to sync engine status
        if (this._syncUnsubscribe) this._syncUnsubscribe();
        this._syncUnsubscribe = runtime.sync.onStatusChange((engineStatus: SyncEngineStatus) => {
          if (engineStatus === "syncing") this.setSyncStatus("syncing");
          else if (engineStatus === "idle") this.setSyncStatus("connected");
          else if (engineStatus === "error") this.setSyncStatus("error");
          else if (engineStatus === "offline") this.setSyncStatus("disconnected");
        });

        runtime.startSync();
        this.setSyncStatus("connected");

        // 4. Plan sync — push/pull plans to relay for cross-device visibility
        const planStore = this.deps.getPlanStore();
        if (planStore) {
          const planSyncStore = new IdbPlanSyncStore(planStore, motebitId);
          this._planSyncEngine = new PlanSyncEngine(planSyncStore, motebitId);
          const httpPlanAdapter = new HttpPlanSyncAdapter({
            baseUrl: relayUrl,
            motebitId,
            authToken: authToken ?? undefined,
          });
          this._planSyncEngine.connectRemote(
            new EncryptedPlanSyncAdapter({ inner: httpPlanAdapter, key: encKey }),
          );
          void this._planSyncEngine.sync();
          this._planSyncEngine.start();
        }

        // 5. Conversation sync — encrypted, push/pull for cross-device visibility
        if (storage?.conversationStore) {
          const convSyncStore = new IdbConversationSyncStore(
            storage.conversationStore as IdbConversationStore,
            motebitId,
          );
          this._convSyncEngine = new ConversationSyncEngine(convSyncStore, motebitId);
          const httpConvAdapter = new HttpConversationSyncAdapter({
            baseUrl: relayUrl,
            motebitId,
            authToken: authToken ?? undefined,
          });
          this._convSyncEngine.connectRemote(
            new EncryptedConversationSyncAdapter({ inner: httpConvAdapter, key: encKey }),
          );
          void this._convSyncEngine.sync();
          this._convSyncEngine.start();
        }

        // 6. Recover orphaned delegated steps from a previous session
        void (async () => {
          try {
            const rt = this.deps.getRuntime();
            if (!rt) return;
            for await (const _chunk of rt.recoverDelegatedSteps()) {
              // Consumed — plan store updates propagate to UI
            }
          } catch {
            // Best-effort
          }
        })();

        // Adversarial onboarding: run self-test once after first relay connection
        void this.runOnboardingSelfTest(relayUrl, authToken ?? "");

        // 7. Token refresh every 4.5 min — rebuild WS with fresh auth
        this._wsTokenRefreshTimer = setInterval(() => {
          void (async () => {
            try {
              const tf = this.deps.getTokenFactory();
              const pk = this.deps.getPrivKey();
              if (!this._wsAdapter || !tf || !pk) return;
              this._wsAdapter.disconnect();

              const freshToken = await tf();
              const freshEncKey = await deriveSyncEncryptionKey(pk);

              const freshWs = new WebSocketEventStoreAdapter({
                url: wsUrl,
                motebitId,
                authToken: freshToken,
                capabilities: [DeviceCapability.HttpMcp],
                httpFallback: encryptedHttp,
                localStore: localEventStore ?? undefined,
              });

              // Re-wire delegation with fresh WS
              const freshDelegation = new RelayDelegationAdapter({
                syncUrl: relayUrl,
                motebitId,
                authToken: freshToken ?? undefined,
                sendRaw: (data: string) => freshWs.sendRaw(data),
                onCustomMessage: (cb) => freshWs.onCustomMessage(cb),
                getExplorationDrive: () => this.deps.getRuntime()?.getPrecision().explorationDrive,
              });
              this.deps.getRuntime()?.setDelegationAdapter(freshDelegation);

              if (this._wsUnsubOnEvent) this._wsUnsubOnEvent();
              this._wsUnsubOnEvent = freshWs.onEvent((raw) => {
                void (async () => {
                  if (!localEventStore) return;
                  const dec = await decryptEventPayload(raw, freshEncKey);
                  await localEventStore.append(dec);
                })();
              });

              const freshEncrypted = new EncryptedEventStoreAdapter({
                inner: freshWs,
                key: freshEncKey,
              });
              this.deps.getRuntime()?.connectSync(freshEncrypted);
              freshWs.connect();
              this._wsAdapter = freshWs;
            } catch {
              // Token refresh failed — WS will retry on reconnect
            }
          })();
        }, 4.5 * 60_000);
      } catch {
        // Sync setup failed — fall back to delegation-only
        this.setSyncStatus("error");
        const rt = this.deps.getRuntime();
        const tf = this.deps.getTokenFactory();
        if (rt != null && tf != null) {
          const inner = new RelayDelegationAdapter({
            syncUrl: relayUrl,
            motebitId,
            authToken: tf,
            sendRaw: () => {},
            onCustomMessage: () => () => {},
            getExplorationDrive: () => this.deps.getRuntime()?.getPrecision().explorationDrive,
          });
          rt.setDelegationAdapter(inner);
        }
      }
    } else if (runtime && tokenFactory) {
      // No private key bytes — delegation only (no encrypted sync)
      const inner = new RelayDelegationAdapter({
        syncUrl: relayUrl,
        motebitId,
        authToken: tokenFactory,
        sendRaw: () => {},
        onCustomMessage: () => () => {},
        getExplorationDrive: () => this.deps.getRuntime()?.getPrecision().explorationDrive,
      });
      runtime.setDelegationAdapter(inner);
      this.setSyncStatus("disconnected");
    }
  }

  /**
   * Disconnect from the relay: stop sync, close WebSocket, deregister.
   */
  async disconnectRelay(): Promise<void> {
    // Stop token refresh
    if (this._wsTokenRefreshTimer) {
      clearInterval(this._wsTokenRefreshTimer);
      this._wsTokenRefreshTimer = null;
    }

    // Stop plan sync
    if (this._planSyncEngine) {
      this._planSyncEngine.stop();
      this._planSyncEngine = null;
    }

    // Stop conversation sync
    if (this._convSyncEngine) {
      this._convSyncEngine.stop();
      this._convSyncEngine = null;
    }

    // Unsubscribe event listeners
    if (this._wsUnsubOnEvent) {
      this._wsUnsubOnEvent();
      this._wsUnsubOnEvent = null;
    }
    if (this._syncUnsubscribe) {
      this._syncUnsubscribe();
      this._syncUnsubscribe = null;
    }

    // Close WebSocket
    if (this._wsAdapter) {
      this._wsAdapter.disconnect();
      this._wsAdapter = null;
    }

    // Stop sync engine
    this.deps.getRuntime()?.sync.stop();

    // Stop heartbeat
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Best-effort deregistration
    const { relayUrl } = this.deps.getNetworkSettings();
    if (relayUrl !== "") {
      try {
        const headers: Record<string, string> = {};
        if (this.relayAuthToken) headers["Authorization"] = `Bearer ${this.relayAuthToken}`;
        await fetch(`${relayUrl}/api/v1/agents/deregister`, { method: "DELETE", headers });
      } catch {
        // Best-effort
      }
    }

    // Erase private key bytes when disconnecting from relay. The app
    // kernel cooperates by nulling its own reference — `clearPrivKey`
    // reads + erases + nulls in one hop.
    const pk = this.deps.getPrivKey();
    if (pk) {
      secureErase(pk);
      this.deps.clearPrivKey();
    }

    this.setSyncStatus("disconnected");
  }

  /**
   * Run cmdSelfTest exactly once per device. Uses localStorage flag to avoid
   * repeating on subsequent launches. Best-effort — failures are logged, never blocking.
   */
  private async runOnboardingSelfTest(relayUrl: string, authToken: string): Promise<void> {
    const FLAG = "motebit:self-test-done";
    try {
      if (localStorage.getItem(FLAG) === "true") return;
    } catch {
      return; // localStorage unavailable
    }
    const runtime = this.deps.getRuntime();
    if (!runtime) return;

    try {
      const tokenFactory = this.deps.getTokenFactory();
      const mintToken = async (): Promise<string> => {
        if (tokenFactory) return tokenFactory();
        return authToken;
      };
      const token = await mintToken();
      if (!token) return;

      const result = await cmdSelfTest(runtime, {
        relay: { relayUrl, authToken: token, motebitId: this.deps.getMotebitId() },
        mintToken,
        timeoutMs: 30_000,
      });

      // eslint-disable-next-line no-console
      console.log("[self-test]", result.summary);
      if (result.data?.status === "passed" || result.data?.status === "skipped") {
        localStorage.setItem(FLAG, "true");
      }
    } catch (err: unknown) {
      // eslint-disable-next-line no-console
      console.warn("[self-test] error:", err instanceof Error ? err.message : String(err));
    }
  }
}
