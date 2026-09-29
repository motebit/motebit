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
import {
  executeRemoteCommand,
  cmdSelfTest,
  RelayDelegationAdapter,
  verifyAgentCommandEnvelope,
} from "@motebit/runtime";
import { DeviceCapability } from "@motebit/sdk";
import type { TokenAudience } from "@motebit/sdk";
import type {
  CredentialSource,
  CustomMessageCallback,
  EventReceivedCallback,
  SyncStatus as SyncEngineStatus,
} from "@motebit/sync-engine";
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
  liveAdapter,
} from "@motebit/sync-engine";
import {
  IdbConversationStore,
  IdbConversationSyncStore,
  IdbPlanStore,
  IdbPlanSyncStore,
} from "@motebit/browser-persistence";
import type { SpatialNetworkSettings } from "./spatial-app";

type InternalSyncStatus =
  "disconnected" | "connecting" | "connected" | "syncing" | "error" | "conflict";

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
  /**
   * Signed-token factory, null if identity not bootstrapped. Takes the
   * audience the relay route verifies (default `sync`, the socket's own):
   * register / heartbeat / deregister verify `admin:query`, task submit and
   * poll `task:submit` / `task:query`. A factory hard-coded to `sync` sent
   * the socket's audience to every one of them and all were refused (#827).
   */
  getTokenFactory: () => ((audience?: TokenAudience) => Promise<string>) | null;
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
      // Registration is the agent-registry family: `admin:query`.
      const regToken = tokenFactory ? await tokenFactory("admin:query") : null;
      const regResp = await fetch(`${relayUrl}/api/v1/agents/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(regToken ? { Authorization: `Bearer ${regToken}` } : {}),
        },
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
              const freshToken = tf ? await tf("admin:query") : null;
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

        // A fresh token per request (#927): the catch-up, plan and
        // conversation adapters each outlive a five-minute token — the plan
        // and conversation engines poll on their own timers — and each held
        // the first one, so after five minutes every request was refused.
        const syncCredentials: CredentialSource = {
          getCredential: async () => {
            const tf = this.deps.getTokenFactory();
            return tf ? tf() : null;
          },
        };
        // HTTP fallback adapter (for initial sync / offline recovery).
        // E2E-only (#928): a plaintext payload is refused before it leaves.
        const httpAdapter = new HttpEventStoreAdapter({
          baseUrl: relayUrl,
          motebitId,
          credentialSource: syncCredentials,
          payloads: "e2e",
        });
        // A failed catch-up is shown, never swallowed (#927).
        const onCatchUpError = (err: unknown): void => {
          // eslint-disable-next-line no-console -- the status carries no message; the log says why
          console.warn(
            `[sync] catch-up failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          this.setSyncStatus("error");
        };
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
          onCatchUpError,
          payloads: "e2e",
        });
        this._wsAdapter = wsAdapter;
        // The socket adapter in use now. A token refresh replaces it (#816);
        // every consumer below reaches the socket through this.
        let currentWs = wsAdapter;

        // Wire delegation through the WebSocket (not no-op). ONE adapter for
        // the session, following the current socket: a step in flight waits
        // (up to 300s) for its task_result on the listeners it registered,
        // and a refresh (every 270s) replaces the socket under it. Its
        // listeners live here and `onRelayFrame` feeds them from whichever
        // socket is current; bound to the submitting socket, the result was
        // lost with it, the step timed out, and the retry submitted — and
        // paid for — the task again (#816).
        const delegationListeners = new Set<CustomMessageCallback>();
        const delegationAdapter = new RelayDelegationAdapter({
          syncUrl: relayUrl,
          motebitId,
          ...(tokenFactory != null ? { authToken: (aud: TokenAudience) => tokenFactory(aud) } : {}),
          sendRaw: (data: string) => currentWs.sendRaw(data),
          onCustomMessage: (cb) => {
            delegationListeners.add(cb);
            return () => {
              delegationListeners.delete(cb);
            };
          },
          getExplorationDrive: () => this.deps.getRuntime()?.getPrecision().explorationDrive,
        });
        runtime.setDelegationAdapter(delegationAdapter);

        // Encrypted wrapper for outbound events, over whichever socket adapter
        // is current: an append still encrypting when a token refresh swaps
        // the adapter lands on the replacement, not on the retired one (#816).
        // `liveAdapter` also forwards the socket's wire activity to the sync
        // engine's stall watchdog (#914 round 5).
        const liveWs = liveAdapter(() => currentWs);
        const encryptedWs = new EncryptedEventStoreAdapter({ inner: liveWs, key: encKey });

        // Inbound real-time events: decrypt and write to local store
        const onInboundEvent: EventReceivedCallback = (raw) => {
          void (async () => {
            if (!localEventStore) return;
            const dec = await decryptEventPayload(raw, encKey);
            await localEventStore.append(dec);
          })();
        };
        this._wsUnsubOnEvent = wsAdapter.onEvent(onInboundEvent);

        // Handle remote command requests (forwarded by relay). One named
        // handler, attached to whichever adapter is current and answering on
        // it — a token refresh moves it to the replacement (#816).
        const onRelayFrame: CustomMessageCallback = (msg) => {
          for (const listener of [...delegationListeners]) listener(msg);
          const rt = this.deps.getRuntime();
          if (msg.type !== "command_request" || !rt) return;
          // Fail-closed remote ingress: only a signed-request-envelope@1.0
          // from this agent's own identity executes (daemon-desktop
          // unification, increment 4).
          const cmdMsg = msg as unknown as {
            id: string;
            command: string;
            args?: string;
            envelope?: unknown;
          };
          void (async () => {
            try {
              const verdict = await verifyAgentCommandEnvelope({
                envelope: cmdMsg.envelope,
                command: cmdMsg.command,
                args: cmdMsg.args,
                motebitId: this.deps.getMotebitId(),
                identityPublicKey: this.deps.getPublicKey(),
              });
              if (!verdict.ok) {
                currentWs.sendRaw(
                  JSON.stringify({
                    type: "command_response",
                    id: cmdMsg.id,
                    result: { summary: verdict.reason },
                  }),
                );
                return;
              }
              // The one door for a relay frame. The envelope is the
              // authorization; the origin is recorded, never trusted —
              // but a command arriving over the wire and answering as
              // if it were typed here writes a halt record saying the
              // sovereign stopped their motebit from this machine, and
              // lets a view that masks for the wire decide it is not on
              // one.
              const result = await executeRemoteCommand(rt, cmdMsg.command, cmdMsg.args);
              currentWs.sendRaw(
                JSON.stringify({ type: "command_response", id: cmdMsg.id, result }),
              );
            } catch (err: unknown) {
              currentWs.sendRaw(
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
        };
        let unsubRelayFrame = wsAdapter.onCustomMessage(onRelayFrame);

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
            credentialSource: syncCredentials,
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
            credentialSource: syncCredentials,
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

        // 7. Token refresh every 4.5 min — rebuild WS with fresh auth. Each
        // refresh retires the adapter it REPLACES (`currentWs`) and attaches
        // every handler to the replacement, so exactly one socket is open and
        // it is the one that answers (#816).
        const refreshTimer = setInterval(() => {
          void (async () => {
            try {
              const tf = this.deps.getTokenFactory();
              if (!tf || !this.deps.getPrivKey()) return;
              const freshToken = await tf();
              // disconnectRelay ended this session while the token was
              // minting: touch nothing of whatever replaced it.
              if (this._wsTokenRefreshTimer !== refreshTimer) {
                clearInterval(refreshTimer);
                currentWs.disconnect();
                return;
              }

              if (this._wsUnsubOnEvent) this._wsUnsubOnEvent();
              this._wsUnsubOnEvent = null;
              unsubRelayFrame();
              const replaced = currentWs;
              replaced.disconnect();

              const freshWs = new WebSocketEventStoreAdapter({
                url: wsUrl,
                motebitId,
                authToken: freshToken,
                capabilities: [DeviceCapability.HttpMcp],
                httpFallback: encryptedHttp,
                localStore: localEventStore ?? undefined,
                onCatchUpError,
                payloads: "e2e",
              });
              // Events the sync engine handed the replaced adapter while it
              // was offline are counted as pushed; they go out on the
              // replacement.
              for (const queued of replaced.takePendingEvents()) void freshWs.append(queued);
              currentWs = freshWs;

              // The session's one delegation adapter follows `currentWs`;
              // its listeners hear the replacement through `onRelayFrame`.

              this._wsUnsubOnEvent = freshWs.onEvent(onInboundEvent);
              unsubRelayFrame = freshWs.onCustomMessage(onRelayFrame);

              freshWs.connect();
              this._wsAdapter = freshWs;
            } catch {
              // Token refresh failed — WS will retry on reconnect
            }
          })();
        }, 4.5 * 60_000);
        this._wsTokenRefreshTimer = refreshTimer;
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
        // `admin:query`, like register; the cached `sync` socket token was
        // refused (#827).
        const tf = this.deps.getTokenFactory();
        const token = tf ? await tf("admin:query") : null;
        const headers: Record<string, string> = {};
        if (token) headers["Authorization"] = `Bearer ${token}`;
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
      // Honors the audience cmdSelfTest asks for (`task:submit`, then
      // `task:query`); a factory that ignored it sent `sync` to both (#827).
      const mintToken = async (audience?: TokenAudience): Promise<string> => {
        if (tokenFactory) return tokenFactory(audience);
        return authToken;
      };
      const token = await mintToken();
      if (!token) return;

      const result = await cmdSelfTest(runtime, {
        relay: { relayUrl, authToken: token, motebitId: this.deps.getMotebitId() },
        mintToken,
        // Spatial has no serving path — it is never a worker, so the completion
        // poll could only time out. `auth_verified` (the security pass)
        // terminates immediately and sets the done-flag below.
        serving: false,
        timeoutMs: 30_000,
      });

      // eslint-disable-next-line no-console
      console.log("[self-test]", result.summary);
      if (
        result.data?.status === "passed" ||
        result.data?.status === "auth_verified" ||
        result.data?.status === "skipped"
      ) {
        localStorage.setItem(FLAG, "true");
      }
    } catch (err: unknown) {
      // eslint-disable-next-line no-console
      console.warn("[self-test] error:", err instanceof Error ? err.message : String(err));
    }
  }
}
