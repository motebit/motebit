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
import type { CredentialSource, SyncStatus as SyncEngineStatus } from "@motebit/sync-engine";
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
  "disconnected" | "connecting" | "connected" | "syncing" | "error" | "conflict";

const HEARTBEAT_INTERVAL_MS = 5 * 60_000; // 5 minutes
/** Sync-socket token refresh cadence: signed sync tokens expire at 5 min. */
export const WS_TOKEN_REFRESH_MS = 4.5 * 60_000;

/**
 * How long a socket for an identity or relay the app has LEFT keeps serving
 * (#816): long enough to answer a command already executing and to flush
 * what it has queued, as main's socket did until the new start replaced it;
 * never indefinitely — a socket for a place the user left must close even
 * when the new start's socket is slow or never comes. It is never retired
 * INTO the new socket (another identity or relay must not carry its events
 * or replies — `handOffTo` refuses), so it simply drains and closes.
 */
const LEFT_TARGET_DRAIN_MS = 15_000;

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
  /**
   * Sockets a re-entered connectRelay replaced, still open and answering
   * until the replacement AUTHENTICATES (#816): retiring one at the
   * replacement's `connect()` left the relay no admitted socket for the
   * handshake's round trip.
   */
  private _retiring: Array<{
    adapter: WebSocketEventStoreAdapter;
    unsubEvent: (() => void) | null;
  }> = [];
  private _retireOnAuth: (() => void) | null = null;
  /** Sockets for an identity or relay the app left, draining until their timer closes them. */
  private _leftSockets = new Map<
    WebSocketEventStoreAdapter,
    { unsubEvent: (() => void) | null; timer: ReturnType<typeof setTimeout> }
  >();
  /** When each left socket's drain ends (set when the app leaves its target). */
  private _leftDeadline = new WeakMap<WebSocketEventStoreAdapter, number>();
  /** The running socket while it drains for the target the app left. */
  private _draining: { adapter: WebSocketEventStoreAdapter; run: string } | null = null;
  private _syncUnsubscribe: (() => void) | null = null;
  /**
   * Socket ownership across overlapping starts (#816). Every start takes a
   * request number; a start CLAIMS the socket only once it has passed its
   * early-return checks and is about to build one, so a newer start that
   * bails early never supersedes a running one. A start whose request is
   * not newer than the current owner (a newer start already claimed, or a
   * stop came after it) builds nothing — with one exception: a start a stop
   * overtook may still build when the controller has since been restarted
   * against the SAME relay and no newer start has built yet (its work is
   * the restarted run's work, done sooner; the newer start then replaces it,
   * make-before-break). A stop makes every earlier request stale.
   */
  private _wsRequestSeq = 0;
  private _wsOwner = 0;
  /** The highest request that has built a socket. */
  private _wsClaimed = 0;
  /**
   * The identity and relay the current run targets (`"<motebitId> <relayUrl>"`);
   * null once disconnected. A superseded start continues only while this still
   * names its own identity and relay — never across a pairing to another id.
   */
  private _activeRun: string | null = null;

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

  /** Retire replaced sockets into `successor` once it authenticates. */
  private retireAfterAuth(successor: WebSocketEventStoreAdapter): void {
    this._retireOnAuth?.();
    this._retireOnAuth = null;
    // A socket for another identity or relay is never retired into this
    // one: it drains (answers what it is executing, flushes what it holds)
    // and closes when its LEFT_TARGET_DRAIN_MS since the app left it are up.
    this._retiring = this._retiring.filter((r) => {
      if (r.adapter.endpoint === successor.endpoint) return true;
      this.drainLeft(r.adapter, r.unsubEvent);
      return false;
    });
    if (this._retiring.length === 0) return;
    const retire = () => {
      this._retireOnAuth?.();
      this._retireOnAuth = null;
      for (const old of this._retiring.splice(0)) {
        old.unsubEvent?.();
        old.adapter.handOffTo(successor);
      }
    };
    if (successor.isConnected) retire();
    else this._retireOnAuth = successor.onAuthenticated(retire);
  }

  /**
   * Where a reply to a relay frame goes, decided when it is SENT: the relay
   * accepts an answer from the same runtime on any of its sockets until the
   * command's deadline, so it goes out on whichever socket of that relay and
   * identity is authenticated now — the current one, else one still retiring
   * — and otherwise waits in the current one's queue.
   */
  private replyChannel(arrival: WebSocketEventStoreAdapter): WebSocketEventStoreAdapter {
    const candidates = [
      this._wsAdapter,
      ...this._retiring.map((r) => r.adapter),
      ...this._leftSockets.keys(),
      arrival,
    ].filter((a): a is WebSocketEventStoreAdapter => a != null && a.endpoint === arrival.endpoint);
    return candidates.find((a) => a.isConnected) ?? candidates[0] ?? arrival;
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
    const request = ++this._wsRequestSeq;
    const motebitId = this.deps.getMotebitId();
    const run = `${motebitId} ${relayUrl}`;
    // Past the early return, this start targets the app's sync. When that
    // target moves to another identity or relay, the running socket serves
    // one the app has left: it drains (see LEFT_TARGET_DRAIN_MS) and closes,
    // unless this start's socket replaces it first.
    if (this._activeRun !== run && !this.resumeReturned(run)) this.drainLeftSocket(this._activeRun);
    this._activeRun = run;

    this.setSyncStatus("connecting");

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

        // HTTP fallback adapter (for initial sync / offline recovery). It
        // backs the socket's catch-up pull after every refresh, so it mints
        // per request — a static 5-minute token was refused from the second
        // refresh on and a refresh gap's events were never pulled (#816).
        const httpAdapter = new HttpEventStoreAdapter({
          baseUrl: relayUrl,
          motebitId,
          credentialSource: {
            getCredential: async () => {
              const tf = this.deps.getTokenFactory();
              return tf ? tf() : authToken;
            },
          },
        });
        const encryptedHttp = new EncryptedEventStoreAdapter({ inner: httpAdapter, key: encKey });

        // WebSocket adapter (real-time)
        const wsUrl =
          relayUrl.replace(/^https?/, (m) => (m === "https" ? "wss" : "ws")) +
          "/ws/sync/" +
          motebitId;

        // Claim the socket HERE, past every early return: a connectRelay that
        // bails earlier never supersedes a running one. One already
        // superseded (disconnectRelay, or a newer connectRelay that claimed
        // first) builds nothing — that socket would belong to nobody.
        // A start whose target the app has since left — a newer start for
        // another relay, or for another identity (a pairing) — builds
        // nothing: its socket would serve a place the user left, or carry
        // the new identity's events and commands under the old one.
        if (this._activeRun !== run) return;
        const newest = request > this._wsOwner;
        const restartedSameRelay = !newest && request > this._wsClaimed && this._activeRun === run;
        if (!newest && !restartedSameRelay) return;
        if (newest) this._wsOwner = request;
        this._wsClaimed = request;
        // One sync socket per controller: a re-entered connectRelay replaces
        // the running socket and its refresh timer (#816) — make-before-break:
        // the running socket stays live until this one is wired and connected
        // below, then is retired into it (queued events and in-flight replies
        // handed over).
        const replaced = {
          adapter: this._wsAdapter,
          unsubEvent: this._wsUnsubOnEvent,
          timer: this._wsTokenRefreshTimer,
        };
        this._wsTokenRefreshTimer = null;

        // The token minted above serves the first connect; every later
        // connect — the 4.5-minute refresh and any drop-and-reconnect —
        // mints a fresh one, so a reconnect never presents an expired token.
        let initialToken: string | null = authToken;
        const wsCredentialSource: CredentialSource = {
          getCredential: async () => {
            if (initialToken != null && initialToken !== "") {
              const t = initialToken;
              initialToken = null;
              return t;
            }
            const tf = this.deps.getTokenFactory();
            return tf ? tf() : null;
          },
        };

        const wsAdapter = new WebSocketEventStoreAdapter({
          url: wsUrl,
          motebitId,
          credentialSource: wsCredentialSource,
          capabilities: [DeviceCapability.HttpMcp],
          httpFallback: encryptedHttp,
          localStore: localEventStore ?? undefined,
        });
        this._wsAdapter = wsAdapter;

        // Wire delegation through the WebSocket (not no-op)
        const delegationAdapter = new RelayDelegationAdapter({
          syncUrl: relayUrl,
          motebitId,
          ...(tokenFactory != null ? { authToken: (aud: TokenAudience) => tokenFactory(aud) } : {}),
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
                this.replyChannel(wsAdapter).sendRaw(
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
              this.replyChannel(wsAdapter).sendRaw(
                JSON.stringify({ type: "command_response", id: cmdMsg.id, result }),
              );
            } catch (err: unknown) {
              this.replyChannel(wsAdapter).sendRaw(
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
        // The replaced socket keeps serving until this one authenticates.
        if (replaced.timer != null) clearInterval(replaced.timer);
        if (replaced.adapter) {
          this._retiring.push({ adapter: replaced.adapter, unsubEvent: replaced.unsubEvent });
        }
        this.retireAfterAuth(wsAdapter);

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
          // A re-entered connectRelay replaces the running engine; never two pollers.
          this._planSyncEngine?.stop();
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
          this._convSyncEngine?.stop();
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

        // 7. Token refresh every 4.5 min. The SAME adapter swaps its socket
        // and re-mints the credential, so the command handler, the
        // inbound-event handler and the delegation adapter's subscription
        // all stay attached, and the replaced socket is the one that closes
        // (#816). Never build a second adapter here.
        this._wsTokenRefreshTimer = setInterval(() => {
          wsAdapter.refreshConnection();
        }, WS_TOKEN_REFRESH_MS);
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
   * The running socket serves a target the app just left: it drains (see
   * LEFT_TARGET_DRAIN_MS) and closes, unless a newer socket replaces it
   * first or the app comes back to its target (`resumeReturned`).
   */
  private drainLeftSocket(left: string | null): void {
    const leaving = this._wsAdapter;
    if (!leaving || left == null) return;
    this._leftDeadline.set(leaving, Date.now() + LEFT_TARGET_DRAIN_MS);
    // It serves out what it holds but never reopens for the target left.
    leaving.drain(LEFT_TARGET_DRAIN_MS);
    this._draining = { adapter: leaving, run: left };
    setTimeout(() => {
      // Still the running socket (no newer socket claimed) and still
      // draining (the app did not come back): its drain is over.
      if (this._wsAdapter === leaving && this._draining?.adapter === leaving) {
        this._draining = null;
        this.closeSockets();
      }
    }, LEFT_TARGET_DRAIN_MS);
  }

  /**
   * The app came back to the target the running socket drains for, before
   * the drain ended: that socket is this run's again — it resumes instead
   * of closing and being rebuilt (main kept it throughout).
   */
  private resumeReturned(run: string): boolean {
    const d = this._draining;
    if (!d || d.adapter !== this._wsAdapter || d.run !== run) return false;
    this._draining = null;
    this._leftDeadline.delete(d.adapter);
    d.adapter.resume();
    return true;
  }

  private drainLeft(adapter: WebSocketEventStoreAdapter, unsubEvent: (() => void) | null): void {
    const deadline = this._leftDeadline.get(adapter) ?? Date.now() + LEFT_TARGET_DRAIN_MS;
    const close = (): void => {
      this._leftSockets.delete(adapter);
      unsubEvent?.();
      adapter.disconnect();
    };
    const remaining = Math.max(0, deadline - Date.now());
    // Serve out the socket, never reopen it; `close` detaches the handler.
    adapter.drain(remaining);
    this._leftSockets.set(adapter, { unsubEvent, timer: setTimeout(close, remaining) });
  }

  private closeLeftSockets(): void {
    for (const [left, { unsubEvent, timer }] of this._leftSockets) {
      clearTimeout(timer);
      unsubEvent?.();
      left.disconnect();
    }
    this._leftSockets.clear();
  }

  /** Close the running socket, any retiring one, and the refresh timer. */
  private closeSockets(): void {
    this._retireOnAuth?.();
    this._retireOnAuth = null;
    for (const old of this._retiring.splice(0)) {
      old.unsubEvent?.();
      old.adapter.disconnect();
    }
    this.closeLeftSockets();
    if (this._wsTokenRefreshTimer != null) {
      clearInterval(this._wsTokenRefreshTimer);
      this._wsTokenRefreshTimer = null;
    }
    if (this._wsUnsubOnEvent) {
      this._wsUnsubOnEvent();
      this._wsUnsubOnEvent = null;
    }
    if (this._wsAdapter) {
      this._wsAdapter.disconnect();
      this._wsAdapter = null;
    }
  }

  /**
   * Disconnect from the relay: stop sync, close WebSocket, deregister.
   */
  async disconnectRelay(): Promise<void> {
    this._retireOnAuth?.();
    this._retireOnAuth = null;
    for (const old of this._retiring.splice(0)) {
      old.unsubEvent?.();
      old.adapter.disconnect();
    }
    this.closeLeftSockets();
    this._wsOwner = ++this._wsRequestSeq;
    this._activeRun = null;
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
