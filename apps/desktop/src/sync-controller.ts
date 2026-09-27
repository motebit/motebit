/**
 * Sync controller — owns the desktop's relay-sync lifecycle: event-level
 * WebSocket sync, conversation + plan HTTP sync, adversarial self-test,
 * delegation task handler, and the "serving" state (whether the motebit
 * is accepting inbound delegations from the network).
 *
 * Sync is the membrane that lets the motebit live across devices — the
 * body accumulates state locally; the relay is the rail along which that
 * state replicates. Giving it a dedicated home keeps the DesktopApp shell
 * thin and makes the sync semantics reviewable in one place.
 *
 * ### State ownership
 *
 *   - UI status projection (`_lastSyncStatus`, status callback)
 *   - WebSocket state (`_wsAdapter`, token-refresh timer, event/custom
 *     message unsubscribes, sync-engine status unsubscribe)
 *   - Serving state (`_serving`, serving sync url + auth token + private
 *     key, active task count)
 *
 * ### Deps getter pattern
 *
 * Runtime, stores, identity helpers, and keypair access are all read via
 * getter closures so the controller doesn't have to re-bind when the
 * runtime lifecycle shifts. Conversation and plan stores come in via
 * getters because they're set after `initAI` completes.
 */

import type { MotebitRuntime } from "@motebit/runtime";
import type { TokenAudience } from "@motebit/sdk";
import {
  executeRemoteCommand,
  cmdSelfTest,
  getOrPinRelayKey,
  verifyAgentCommandEnvelope,
} from "@motebit/runtime";
import { DeviceCapability } from "@motebit/sdk";
import type { AgentTask, ExecutionReceipt } from "@motebit/sdk";
import type { EventStoreAdapter } from "@motebit/event-log";
import { deriveSyncEncryptionKey, secureErase } from "@motebit/encryption";
import {
  ConversationSyncEngine,
  HttpConversationSyncAdapter,
  EncryptedConversationSyncAdapter,
  EncryptedPlanSyncAdapter,
  PlanSyncEngine,
  HttpPlanSyncAdapter,
  HttpEventStoreAdapter,
  WebSocketEventStoreAdapter,
  EncryptedEventStoreAdapter,
  decryptEventPayload,
} from "@motebit/sync-engine";
import type { CredentialSource, SyncStatus } from "@motebit/sync-engine";
import type { PlanStoreAdapter } from "@motebit/planner";
import {
  TauriConversationSyncStoreAdapter,
  TauriPlanSyncStoreAdapter,
} from "./tauri-sync-adapters.js";
import type { InvokeFn, TauriConversationStore, TauriPlanStore } from "./tauri-storage.js";
import { loadColdStartOptIn } from "./cold-start-optin.js";

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

/** Sync-socket token refresh cadence: signed sync tokens expire at 5 min. */
export const WS_TOKEN_REFRESH_MS = 4.5 * 60_000;

export type SyncIndicatorStatus =
  "disconnected" | "connecting" | "connected" | "syncing" | "conflict" | "error";

export interface SyncStatusEvent {
  status: SyncIndicatorStatus;
  lastSyncAt: number | null;
  eventsPushed: number;
  eventsPulled: number;
  conflictCount: number;
  error: string | null;
}

export interface SyncControllerDeps {
  getRuntime: () => MotebitRuntime | null;
  getMotebitId: () => string;
  getDeviceId: () => string;
  getConversationStore: () => TauriConversationStore | null;
  getPlanStore: () => PlanStoreAdapter | TauriPlanStore | null;
  getLocalEventStore: () => EventStoreAdapter | null;
  getDeviceKeypair: (invoke: InvokeFn) => Promise<{ publicKey: string; privateKey: string } | null>;
  createSyncToken: (privateKeyHex: string, aud?: TokenAudience) => Promise<string>;
}

export class SyncController {
  private _syncStatusCallback: ((event: SyncStatusEvent) => void) | null = null;
  private _lastSyncStatus: SyncStatusEvent = {
    status: "disconnected",
    lastSyncAt: null,
    eventsPushed: 0,
    eventsPulled: 0,
    conflictCount: 0,
    error: null,
  };
  private _syncUnsubscribe: (() => void) | null = null;
  private _wsAdapter: WebSocketEventStoreAdapter | null = null;
  private _wsTokenRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private _wsUnsubOnEvent: (() => void) | null = null;
  private _wsUnsubOnCustom: (() => void) | null = null;
  /**
   * Sockets a newer start replaced, still open and still answering until the
   * replacement AUTHENTICATES (#816): retiring one at the replacement's
   * `connect()` left the relay no admitted socket for the handshake's round
   * trip, and a command in that window found none.
   */
  private _retiring: Array<ReturnType<SyncController["takeWs"]>> = [];
  private _retireOnAuth: (() => void) | null = null;
  /** Sockets for an identity or relay the app left, draining until their timer closes them. */
  private _leftSockets = new Map<
    ReturnType<SyncController["takeWs"]>,
    ReturnType<typeof setTimeout>
  >();
  /**
   * Socket ownership across overlapping starts (#816). Every start takes a
   * request number; a start CLAIMS the socket only once it has passed its
   * early-return checks and is about to build one, so a newer start that
   * bails early never supersedes a running one. A start whose request is
   * not newer than the current owner (a newer start already claimed, or a
   * stop came after it) builds nothing. A claiming start builds, wires and
   * connects its socket in one synchronous step; the running one keeps
   * serving until the new one AUTHENTICATES and is only then retired into it
   * (make-before-break — `retireAfterAuth` / `handOffTo` move the old
   * adapter's queued events and replies to the new one). What it does after
   * the relay-key await (delegation config) is skipped if it has lost
   * ownership meanwhile; its socket was by then already closed by the stop,
   * or retired into the newer start's socket. A stop makes every earlier
   * request stale.
   */
  private _wsRequestSeq = 0;
  private _wsOwner = 0;
  private _serving = false;
  private _servingPrivateKey: Uint8Array | null = null;
  private _servingSyncUrl: string | null = null;
  private _servingAuthToken: string | null = null;
  /**
   * Mints the bearer for a serving-side relay call, for the audience that
   * call's route verifies: an operator's master token when one was supplied,
   * else a device token for exactly that audience. The cached socket token
   * (`sync`) was reused for the result post (`task:result`) and registration
   * (`admin:query`), and both were refused (#827).
   */
  private _servingToken: ((audience: TokenAudience) => Promise<string>) | null = null;
  private _activeTaskCount = 0;

  constructor(private deps: SyncControllerDeps) {}

  /** Subscribe to sync status changes. Immediately emits the current status. */
  onSyncStatus(callback: (event: SyncStatusEvent) => void): void {
    this._syncStatusCallback = callback;
    callback(this._lastSyncStatus);
  }

  get syncStatus(): SyncStatusEvent {
    return { ...this._lastSyncStatus };
  }

  /** Emit a sync status event and update internal state. */
  private emitSyncStatus(partial: Partial<SyncStatusEvent>): void {
    this._lastSyncStatus = { ...this._lastSyncStatus, ...partial };
    this._syncStatusCallback?.(this._lastSyncStatus);
  }

  /**
   * Sync conversations with the remote relay server.
   * Creates a ConversationSyncEngine that bridges TauriConversationStore to the relay.
   */
  async syncConversations(
    syncUrl: string,
    authToken?: string,
    encryptionKey?: Uint8Array,
  ): Promise<{
    conversations_pushed: number;
    conversations_pulled: number;
    messages_pushed: number;
    messages_pulled: number;
  }> {
    const conversationStore = this.deps.getConversationStore();
    if (!conversationStore) {
      return {
        conversations_pushed: 0,
        conversations_pulled: 0,
        messages_pushed: 0,
        messages_pulled: 0,
      };
    }
    const motebitId = this.deps.getMotebitId();

    this.emitSyncStatus({ status: "syncing" });

    const storeAdapter = new TauriConversationSyncStoreAdapter(conversationStore, motebitId);
    // Pre-fetch local data before sync (async Tauri -> sync adapter bridge)
    await storeAdapter.prefetch(0);

    const syncEngine = new ConversationSyncEngine(storeAdapter, motebitId);
    const httpConvAdapter = new HttpConversationSyncAdapter({
      baseUrl: syncUrl,
      motebitId,
      authToken,
    });
    // Encrypt conversations at the sync boundary — relay stores opaque ciphertext
    syncEngine.connectRemote(
      encryptionKey
        ? new EncryptedConversationSyncAdapter({ inner: httpConvAdapter, key: encryptionKey })
        : httpConvAdapter,
    );

    try {
      const result = await syncEngine.sync();

      // Plan sync — push/pull plans for cross-device visibility
      const planStore = this.deps.getPlanStore();
      if (planStore) {
        const planSyncAdapter = new TauriPlanSyncStoreAdapter(planStore, motebitId);
        await planSyncAdapter.prefetch(0);
        const planSync = new PlanSyncEngine(planSyncAdapter, motebitId);
        const httpPlanAdapter = new HttpPlanSyncAdapter({
          baseUrl: syncUrl,
          motebitId,
          authToken,
        });
        planSync.connectRemote(
          encryptionKey
            ? new EncryptedPlanSyncAdapter({ inner: httpPlanAdapter, key: encryptionKey })
            : httpPlanAdapter,
        );
        await planSync.sync();
      }

      this.emitSyncStatus({
        status: "connected",
        lastSyncAt: Date.now(),
        eventsPushed:
          this._lastSyncStatus.eventsPushed + result.conversations_pushed + result.messages_pushed,
        eventsPulled:
          this._lastSyncStatus.eventsPulled + result.conversations_pulled + result.messages_pulled,
      });
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emitSyncStatus({ status: "error", error: msg });
      throw err;
    }
  }

  /**
   * Start full sync: event-level background polling + one-shot conversation sync.
   * Call after pairing completes or at app startup when syncUrl is configured.
   */
  /**
   * @param authToken the socket bearer — normally the device `sync` token
   *   `registerWithRelay` returned, else the operator master token.
   * @param masterToken the operator's master token, ONLY when one is
   *   configured. The serving calls (registration, task results) send it when
   *   present; otherwise they mint the audience their route verifies. They
   *   used to treat `authToken` as the master token, so a normal desktop sent
   *   its `sync` token to `/agents/register` (admin:query) and the result
   *   route (task:result) and both were refused (#827).
   */
  async startSync(
    invoke: InvokeFn,
    syncUrl: string,
    authToken?: string,
    masterToken?: string,
  ): Promise<void> {
    const request = ++this._wsRequestSeq;
    const runtime = this.deps.getRuntime();
    if (!runtime) return;
    const motebitId = this.deps.getMotebitId();

    this.emitSyncStatus({ status: "connecting", error: null });

    // Get keypair for token creation + encryption key derivation
    const keypair = await this.deps.getDeviceKeypair(invoke);
    if (!keypair) {
      this.emitSyncStatus({ status: "error", error: "No device keypair available" });
      return;
    }

    // Derive private key bytes (hex → Uint8Array)
    const privKeyBytes = new Uint8Array(keypair.privateKey.length / 2);
    for (let i = 0; i < keypair.privateKey.length; i += 2) {
      privKeyBytes[i / 2] = parseInt(keypair.privateKey.slice(i, i + 2), 16);
    }

    // Derive deterministic encryption key from private key, then erase raw bytes
    const encKey = await deriveSyncEncryptionKey(privKeyBytes);
    secureErase(privKeyBytes);

    // Get or create a signed auth token
    let token = authToken;
    if (token == null || token === "") {
      token = await this.deps.createSyncToken(keypair.privateKey);
    }

    // Build adapter stack: HTTP (fallback) → Encrypted HTTP → WS → Encrypted WS
    // The HTTP adapter backs the socket's catch-up pull, which runs after
    // every refresh — so it mints per request. A static 5-minute token here
    // was refused from the second refresh on, and events published in a
    // refresh gap were never pulled (#816).
    const catchUpMaster =
      token != null && token !== "" && (token === masterToken || !token.includes("."))
        ? token
        : null;
    const httpAdapter = new HttpEventStoreAdapter({
      baseUrl: syncUrl,
      motebitId,
      credentialSource: {
        getCredential: () =>
          catchUpMaster != null
            ? Promise.resolve(catchUpMaster)
            : this.deps.createSyncToken(keypair.privateKey),
      },
    });
    const encryptedHttp = new EncryptedEventStoreAdapter({ inner: httpAdapter, key: encKey });

    // WebSocket URL: http(s) → ws(s)
    const wsUrl =
      syncUrl.replace(/^https?/, (m) => (m === "https" ? "wss" : "ws")) + "/ws/sync/" + motebitId;

    const localEventStore = this.deps.getLocalEventStore();
    const desktopCapabilities = [
      DeviceCapability.StdioMcp,
      DeviceCapability.HttpMcp,
      DeviceCapability.FileSystem,
      DeviceCapability.Keyring,
      DeviceCapability.Background,
    ];

    // One sync socket per controller: a re-entered startSync (pairing, the
    // relay-URL "Connect" button) replaces the running socket instead of
    // leaving it open beside the new one (#816). The claim happens HERE,
    // past every early return: a start that bails earlier never supersedes
    // a running one. A start already superseded (a stop, or a newer start
    // that claimed first) builds nothing.
    if (request <= this._wsOwner) return;
    // A start for an identity the app no longer holds (a pairing adopted
    // another id meanwhile) builds nothing: its socket would carry the new
    // identity's events and commands under the old one.
    if (this.deps.getMotebitId() !== motebitId) return;
    this._wsOwner = request;
    // Make-before-break: the running socket (a re-entered start) stays live —
    // its handlers, its refresh timer, and the runtime's sync remote — until
    // this start's socket is fully wired below; only then is it retired, in
    // one synchronous step, handing its queued events and in-flight replies
    // to the new adapter (#816).

    // The caller's token (possibly the relay master token) serves the first
    // connect, exactly as before; every later connect — the 4.5-minute
    // refresh and any drop-and-reconnect — mints a fresh signed token, so a
    // reconnect never presents an expired one.
    //
    // A configured MASTER token is different: it does not expire, and a
    // device that has not registered its key has nothing else the relay
    // accepts — so it keeps being presented, on every connect and every
    // catch-up pull, exactly as before (main presented it throughout; a minted
    // token there is refused when the device was never registered). It is
    // the caller's token when it equals the configured master token, or when
    // it is not a signed token at all (the relay's own test: a signed token
    // has a `.`).
    const masterMode =
      token != null && token !== "" && (token === masterToken || !token.includes("."));
    let initialToken: string | undefined = token;
    const privateKeyForToken = keypair.privateKey;
    const wsCredentialSource: CredentialSource = {
      getCredential: async () => {
        if (masterMode) return token ?? null;
        if (initialToken != null && initialToken !== "") {
          const t = initialToken;
          initialToken = undefined;
          return t;
        }
        return this.deps.createSyncToken(privateKeyForToken);
      },
    };

    const wsAdapter = new WebSocketEventStoreAdapter({
      url: wsUrl,
      motebitId,
      credentialSource: wsCredentialSource,
      capabilities: desktopCapabilities,
      httpFallback: encryptedHttp,
      localStore: localEventStore ?? undefined,
      onCatchUp: (pulled) => {
        if (pulled > 0) {
          this.emitSyncStatus({
            lastSyncAt: Date.now(),
            eventsPulled: this._lastSyncStatus.eventsPulled + pulled,
          });
        }
      },
    });

    // Encrypted wrapper around WS adapter for outbound events
    const encryptedWs = new EncryptedEventStoreAdapter({ inner: wsAdapter, key: encKey });

    // Inbound real-time events: decrypt and write to local store
    const unsubEvent = wsAdapter.onEvent((raw) => {
      void (async () => {
        if (!localEventStore) return;
        const dec = await decryptEventPayload(raw, encKey);
        await localEventStore.append(dec);
      })();
    });

    const privKeyHex = keypair.privateKey;

    // Store serving state for task handler
    const servingPrivKey = new Uint8Array(privKeyHex.length / 2);
    for (let i = 0; i < privKeyHex.length; i += 2) {
      servingPrivKey[i / 2] = parseInt(privKeyHex.slice(i, i + 2), 16);
    }
    this._servingPrivateKey = servingPrivKey;
    this._servingSyncUrl = syncUrl;
    this._servingAuthToken = token;
    const master = masterToken != null && masterToken !== "" ? masterToken : null;
    this._servingToken = async (audience) =>
      master ?? this.deps.createSyncToken(privKeyHex, audience);

    // Wire task handler — accept delegations from the network.
    // The liquescent droplet becomes a body that works, not just a face that talks.
    const unsubCustom = wsAdapter.onCustomMessage((msg) => {
      const rt = this.deps.getRuntime();
      // Handle remote command requests (forwarded by relay)
      if (msg.type === "command_request" && rt) {
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
              identityPublicKey: keypair.publicKey,
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
            // The one door for a relay frame: it records the origin and
            // closes the return view's membrane, neither of which a
            // caller has to remember.
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
        return;
      }

      if (msg.type !== "task_request" || msg.task == null || !this._serving) return;
      if (!rt || !this._servingPrivateKey || !this._servingAuthToken) return;

      const task = msg.task as AgentTask;
      const privateKey = this._servingPrivateKey;
      const authToken = this._servingAuthToken;

      // Claim the task
      this.replyChannel(wsAdapter).sendRaw(
        JSON.stringify({ type: "task_claim", task_id: task.task_id }),
      );
      this._activeTaskCount++;

      // Execute — creature glow will rise from processing state
      void (async () => {
        try {
          let receipt: ExecutionReceipt | undefined;
          for await (const chunk of rt.handleAgentTask(
            task,
            privateKey,
            this.deps.getDeviceId(),
            undefined,
            { delegatedScope: task.delegated_scope },
          )) {
            if (chunk.type === "task_result") {
              receipt = chunk.receipt;
            }
          }

          if (receipt) {
            const resultUrl = `${syncUrl}/agent/${motebitId}/task/${task.task_id}/result`;
            const resultToken = this._servingToken
              ? await this._servingToken("task:result")
              : authToken;
            await fetch(resultUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${resultToken}`,
              },
              body: JSON.stringify(receipt),
            });
          }
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          // Task-handler diagnostic — surface failures to the desktop log so
          // operators can see why a delegation didn't complete. The serving
          // path runs detached from the chat UI, so there's no other place
          // for this to land. Log the full `task_id` (not the prior 8-char
          // prefix) so the user can match against the relay queue when
          // reporting a stuck delegation; bracketed prefix matches the
          // file's `[self-test]` convention.
          // eslint-disable-next-line no-console -- task-handler diagnostic
          console.error(`[task-handler] task error`, {
            task_id: task.task_id,
            error: errMsg,
          });
        } finally {
          this._activeTaskCount = Math.max(0, this._activeTaskCount - 1);
        }
      })();
    });

    // Wire the encrypted WS adapter as the sync remote and start
    runtime.connectSync(encryptedWs);
    wsAdapter.connect();

    // Token refresh every 4.5 min (tokens expire at 5 min). The SAME
    // adapter swaps its socket and re-mints the credential, so the
    // command/task handler above, the inbound-event handler, and onCatchUp
    // all stay attached, and the replaced socket is the one that closes
    // (#816). Never build a second adapter here.
    const refreshTimer = setInterval(() => {
      wsAdapter.refreshConnection();
    }, WS_TOKEN_REFRESH_MS);

    // Fully wired: the socket this one replaces (none on a first start) is
    // retired once this one AUTHENTICATES — until then it stays open and
    // answering, so the relay always has an admitted socket (#816).
    const replaced = this.takeWs();
    this._wsAdapter = wsAdapter;
    this._wsUnsubOnEvent = unsubEvent;
    this._wsUnsubOnCustom = unsubCustom;
    this._wsTokenRefreshTimer = refreshTimer;
    this.retireAfterAuth(replaced, wsAdapter);

    // Subscribe to SyncEngine status changes
    if (this._syncUnsubscribe) this._syncUnsubscribe();
    this._syncUnsubscribe = runtime.sync.onStatusChange((engineStatus: SyncStatus) => {
      if (engineStatus === "syncing") {
        this.emitSyncStatus({ status: "syncing" });
      } else if (engineStatus === "idle") {
        const conflicts = this.deps.getRuntime()?.sync.getConflicts() ?? [];
        this.emitSyncStatus({
          status: conflicts.length > 0 ? "conflict" : "connected",
          lastSyncAt: Date.now(),
          conflictCount: conflicts.length,
        });
      } else if (engineStatus === "error") {
        this.emitSyncStatus({ status: "error", error: "Sync cycle failed" });
      } else if (engineStatus === "offline") {
        this.emitSyncStatus({ status: "disconnected" });
      }
    });

    runtime.startSync();
    this.emitSyncStatus({ status: "connected" });

    // Enable interactive delegation — lets the AI transparently delegate tasks
    // to remote agents during conversation via the delegate_to_agent tool.
    // Resolve the PINNED relay key (TOFU) so a paid P2P delegation derives the
    // fee-leg treasury from a key trusted at first connect, never a fetched
    // value (the irreversible-payment MITM surface). undefined → P2P disabled,
    // relay-mode still serves the task. localStorage may be unavailable in some
    // desktop contexts (see runSelfTestOnce) — guard so it never blocks sync.
    let pinnedRelayKey: string | undefined;
    try {
      pinnedRelayKey = await getOrPinRelayKey(syncUrl, { storage: localStorage });
    } catch {
      pinnedRelayKey = undefined;
    }
    // Superseded while awaiting: a stop already closed this socket, or a newer
    // start already retired it into its own. Nothing of this start remains to
    // configure.
    if (this._wsOwner !== request) return;
    runtime.enableInteractiveDelegation({
      syncUrl,
      // Honor the audience the runtime asks for — `task:submit` to submit,
      // `task:query` to poll, `market:listing` for the P2P pre-flight. A
      // closure that ignored it sent `task:submit` to all three, and the poll
      // and pre-flight were refused (#827).
      authToken: async (audience?: TokenAudience) =>
        this.deps.createSyncToken(privKeyHex, audience ?? "task:submit"),
      ...(pinnedRelayKey != null ? { relayPublicKey: pinnedRelayKey } : {}),
      // Forward the cold-start opt-in as a LIVE getter so the "Pay new agents
      // directly" Governance toggle governs chat-driven (delegate_to_agent) P2P
      // delegation, not just the relay-mode fallback. Without this the toggle is
      // a no-op for the AI-loop path (the bug closed on web by d6cab601, now at
      // parity here). Read per call → no re-enable needed when the user flips it.
      acknowledgeNoHistoryRisk: () => loadColdStartOptIn(),
    });

    // One-shot conversation sync (encrypted, stays HTTP — no WS needed for conversations)
    void this.syncConversations(syncUrl, token, encKey)
      .then((result) => {
        this.emitSyncStatus({
          lastSyncAt: Date.now(),
          eventsPushed:
            this._lastSyncStatus.eventsPushed +
            result.conversations_pushed +
            result.messages_pushed,
          eventsPulled:
            this._lastSyncStatus.eventsPulled +
            result.conversations_pulled +
            result.messages_pulled,
        });
      })
      .catch(() => {});

    // Adversarial onboarding: run self-test once after first relay connection
    void this.runOnboardingSelfTest(syncUrl, keypair.privateKey);
  }

  /**
   * Run cmdSelfTest exactly once per device. Uses localStorage flag to avoid
   * repeating on subsequent launches. Best-effort — failures are logged, never blocking.
   */
  private async runOnboardingSelfTest(syncUrl: string, privateKeyHex: string): Promise<void> {
    const FLAG = "motebit:self-test-done";
    try {
      if (localStorage.getItem(FLAG) === "true") return;
    } catch {
      return; // localStorage unavailable
    }
    const runtime = this.deps.getRuntime();
    if (!runtime) return;

    try {
      const token = await this.deps.createSyncToken(privateKeyHex, "task:submit");
      if (!token) return;

      const result = await cmdSelfTest(runtime, {
        relay: { relayUrl: syncUrl, authToken: token, motebitId: this.deps.getMotebitId() },
        // Honor the requested audience (task:submit to submit, task:query to
        // poll) — the relay enforces aud binding (auth-token-v1 §5). Minting a
        // task:submit token for the /task/:id poll would 403 (audience
        // mismatch) if this surface ever served at onboarding. Matches web.
        mintToken: async (audience: TokenAudience) =>
          this.deps.createSyncToken(privateKeyHex, audience),
        // Serving is opt-in; at onboarding the agent is not a worker, so the
        // completion poll could only time out. `auth_verified` (the security
        // pass) terminates immediately and sets the done-flag below.
        serving: this._serving,
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

  /**
   * Start serving — register with relay and accept delegations.
   * The creature becomes a body that works, not just a face that talks.
   */
  async startServing(publicKey: string): Promise<{ ok: boolean; error?: string }> {
    const runtime = this.deps.getRuntime();
    if (!runtime || !this._servingSyncUrl || !this._servingAuthToken) {
      return { ok: false, error: "Sync not connected — connect to relay first" };
    }
    if (this._serving) return { ok: true };

    // Expose only network-safe tools. Operator tools (read_file, recall_memories,
    // list_events, self_reflect, delegate_to_agent) are interior — they don't cross the surface.
    // What remains: MCP tools the user connected + web_search + read_url.
    const LOCAL_ONLY = new Set([
      "read_file",
      "recall_memories",
      "list_events",
      "self_reflect",
      "delegate_to_agent",
      // Local meta-tool (the live roster read) — never a sellable capability.
      "discover_agents",
    ]);
    const tools = runtime.getToolRegistry().list();
    const capabilities = tools
      .filter((t: { name: string }) => !LOCAL_ONLY.has(t.name))
      .map((t: { name: string }) => t.name);

    try {
      const registerToken = this._servingToken
        ? await this._servingToken("admin:query")
        : this._servingAuthToken;
      const res = await fetch(`${this._servingSyncUrl}/api/v1/agents/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${registerToken}`,
        },
        body: JSON.stringify({
          motebit_id: this.deps.getMotebitId(),
          endpoint_url: `wss://${this.deps.getMotebitId()}`,
          public_key: publicKey,
          capabilities,
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        return { ok: false, error: `Registration failed: ${body}` };
      }

      this._serving = true;
      return { ok: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }

  stopServing(): void {
    this._serving = false;
  }

  isServing(): boolean {
    return this._serving;
  }

  activeTaskCount(): number {
    return this._activeTaskCount;
  }

  /** Discover agents on the relay network. Returns empty array if not connected. */
  async discoverAgents(): Promise<
    Array<{
      motebit_id: string;
      capabilities: string[];
      trust_level?: string;
      interaction_count?: number;
      pricing?: Array<{
        capability: string;
        unit_cost: number;
        currency: string;
        per: string;
      }> | null;
      last_seen_at?: number;
      /** Self-asserted display-name claim (trust-graph §3) — render via formatNameClaim. */
      display_name?: string | null;
      /** Listing description (self-authored). */
      description?: string | null;
      /** Render hint for agent liveness — never filter on this. */
      freshness?: "awake" | "recently_seen" | "dormant" | "cold";
    }>
  > {
    if (!this._servingSyncUrl || !this._servingAuthToken) return [];
    try {
      const res = await fetch(`${this._servingSyncUrl}/api/v1/agents/discover`, {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this._servingAuthToken}`,
        },
      });
      if (!res.ok) return [];
      const data = (await res.json()) as {
        agents: Array<{
          motebit_id: string;
          capabilities: string[];
          trust_level?: string;
          interaction_count?: number;
          pricing?: Array<{
            capability: string;
            unit_cost: number;
            currency: string;
            per: string;
          }> | null;
          last_seen_at?: number;
          freshness?: "awake" | "recently_seen" | "dormant" | "cold";
        }>;
      };
      return data.agents ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Close the sync socket and everything bound to it: the refresh timer, the
   * inbound-event and command/task handlers, and the adapter itself. Shared
   * by stopSync and a re-entered startSync so neither can leave a socket
   * open that nothing reads.
   */
  private teardownWs(): void {
    this._retireOnAuth?.();
    this._retireOnAuth = null;
    for (const old of this._retiring.splice(0)) {
      old.unsubEvent?.();
      old.unsubCustom?.();
      old.adapter?.disconnect();
    }
    for (const [left, timer] of this._leftSockets) {
      clearTimeout(timer);
      left.unsubEvent?.();
      left.unsubCustom?.();
      left.adapter?.disconnect();
    }
    this._leftSockets.clear();
    if (this._wsTokenRefreshTimer) {
      clearInterval(this._wsTokenRefreshTimer);
      this._wsTokenRefreshTimer = null;
    }
    if (this._wsUnsubOnEvent) {
      this._wsUnsubOnEvent();
      this._wsUnsubOnEvent = null;
    }
    if (this._wsUnsubOnCustom) {
      this._wsUnsubOnCustom();
      this._wsUnsubOnCustom = null;
    }
    if (this._wsAdapter) {
      this._wsAdapter.disconnect();
      this._wsAdapter = null;
    }
  }

  /** Detach the current socket's state from the controller (to be retired). */
  private takeWs(): {
    adapter: WebSocketEventStoreAdapter | null;
    unsubEvent: (() => void) | null;
    unsubCustom: (() => void) | null;
    timer: ReturnType<typeof setInterval> | null;
  } {
    const taken = {
      adapter: this._wsAdapter,
      unsubEvent: this._wsUnsubOnEvent,
      unsubCustom: this._wsUnsubOnCustom,
      timer: this._wsTokenRefreshTimer,
    };
    this._wsAdapter = null;
    this._wsUnsubOnEvent = null;
    this._wsUnsubOnCustom = null;
    this._wsTokenRefreshTimer = null;
    return taken;
  }

  /**
   * Retire replaced sockets into `successor` once it authenticates. Their
   * refresh timers stop now (the successor has its own); their handlers and
   * sockets keep serving until then.
   */
  private retireAfterAuth(
    old: ReturnType<SyncController["takeWs"]>,
    successor: WebSocketEventStoreAdapter,
  ): void {
    if (old.timer) clearInterval(old.timer);
    old.timer = null;
    if (old.adapter) this._retiring.push(old);
    this._retireOnAuth?.();
    this._retireOnAuth = null;
    // A socket for another identity or relay is never retired into this
    // one: it drains (answers what it is executing, flushes what it holds)
    // and closes after LEFT_TARGET_DRAIN_MS.
    this._retiring = this._retiring.filter((r) => {
      if (r.adapter?.endpoint === successor.endpoint) return true;
      this.drainLeft(r);
      return false;
    });
    if (this._retiring.length === 0) return;
    if (successor.isConnected) {
      this.retireAll(successor);
      return;
    }
    this._retireOnAuth = successor.onAuthenticated(() => this.retireAll(successor));
  }

  private drainLeft(r: ReturnType<SyncController["takeWs"]>): void {
    const close = (): void => {
      this._leftSockets.delete(r);
      r.unsubEvent?.();
      r.unsubCustom?.();
      r.adapter?.disconnect();
    };
    // Serve out the socket, never reopen it; `close` detaches the handlers.
    r.adapter?.drain(LEFT_TARGET_DRAIN_MS);
    this._leftSockets.set(r, setTimeout(close, LEFT_TARGET_DRAIN_MS));
  }

  private retireAll(successor: WebSocketEventStoreAdapter): void {
    this._retireOnAuth?.();
    this._retireOnAuth = null;
    for (const old of this._retiring.splice(0)) {
      old.unsubEvent?.();
      old.unsubCustom?.();
      old.adapter?.handOffTo(successor);
    }
  }

  /**
   * Where a reply to a relay frame goes, decided when the reply is SENT: the
   * relay accepts an answer from the same runtime on any of its sockets until
   * the command's deadline, so the reply goes out on whichever socket of that
   * relay and identity is authenticated now — the current one, else one still
   * retiring — and otherwise waits in the current one's queue (sent on its
   * next authentication). Replying through the socket the frame arrived on
   * lost every answer that outlived it (a stop and restart mid-command).
   */
  private replyChannel(arrival: WebSocketEventStoreAdapter): WebSocketEventStoreAdapter {
    const candidates = [
      this._wsAdapter,
      ...this._retiring.map((r) => r.adapter),
      ...[...this._leftSockets.keys()].map((r) => r.adapter),
      arrival,
    ].filter((a): a is WebSocketEventStoreAdapter => a != null && a.endpoint === arrival.endpoint);
    return candidates.find((a) => a.isConnected) ?? candidates[0] ?? arrival;
  }

  /** Stop background event sync. */
  stopSync(): void {
    this._wsOwner = ++this._wsRequestSeq;
    this.teardownWs();
    if (this._syncUnsubscribe) {
      this._syncUnsubscribe();
      this._syncUnsubscribe = null;
    }
    this.deps.getRuntime()?.sync.stop();
    this.emitSyncStatus({ status: "disconnected" });
  }
}
