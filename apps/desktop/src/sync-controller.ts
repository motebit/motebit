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
  servedToolNames,
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
  liveAdapter,
} from "@motebit/sync-engine";
import type {
  CustomMessageCallback,
  EventReceivedCallback,
  SyncStatus,
} from "@motebit/sync-engine";
import type { PlanStoreAdapter } from "@motebit/planner";
import {
  TauriConversationSyncStoreAdapter,
  TauriPlanSyncStoreAdapter,
} from "./tauri-sync-adapters.js";
import type { InvokeFn, TauriConversationStore, TauriPlanStore } from "./tauri-storage.js";
import { loadColdStartOptIn } from "./cold-start-optin.js";

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

  /** Work bound to this sync session (a registration retry), ended by `stopSync`. */
  private _onStop = new Set<() => void>();

  constructor(private deps: SyncControllerDeps) {}

  /**
   * Run `stop` when sync stops (`stopSync`). Returns an unsubscribe for work
   * that ended on its own.
   */
  onStop(stop: () => void): () => void {
    this._onStop.add(stop);
    return () => {
      this._onStop.delete(stop);
    };
  }

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
   * Sync conversations and plans with the relay — the `/sync` command's door.
   *
   * The sync key is derived HERE, from this device's keypair, exactly as
   * `startSync` derives it (#928 round 2). The key used to be an optional
   * argument the `/sync` caller never passed, so a manual sync put message
   * text, titles and plans on the wire in plaintext. No keypair ⇒ refused:
   * there is no unencrypted conversation or plan sync on desktop.
   *
   * @param authToken a configured master token; absent ⇒ a device `sync`
   *   token is minted for this call.
   */
  async syncConversations(
    invoke: InvokeFn,
    syncUrl: string,
    authToken?: string,
  ): Promise<{
    conversations_pushed: number;
    conversations_pulled: number;
    messages_pushed: number;
    messages_pulled: number;
  }> {
    if (!this.deps.getConversationStore()) {
      return {
        conversations_pushed: 0,
        conversations_pulled: 0,
        messages_pushed: 0,
        messages_pulled: 0,
      };
    }
    const keypair = await this.deps.getDeviceKeypair(invoke);
    if (!keypair) {
      const msg = "No device keypair — refusing to sync conversations unencrypted";
      this.emitSyncStatus({ status: "error", error: msg });
      throw new Error(msg);
    }
    const privKeyBytes = new Uint8Array(keypair.privateKey.length / 2);
    for (let i = 0; i < keypair.privateKey.length; i += 2) {
      privKeyBytes[i / 2] = parseInt(keypair.privateKey.slice(i, i + 2), 16);
    }
    let encKey: Uint8Array;
    try {
      encKey = await deriveSyncEncryptionKey(privKeyBytes);
    } finally {
      secureErase(privKeyBytes);
    }
    const token =
      authToken != null && authToken !== ""
        ? authToken
        : await this.deps.createSyncToken(keypair.privateKey);
    return this.syncConversationsE2E(syncUrl, token, encKey);
  }

  /**
   * The one conversation + plan sync body. The key is REQUIRED: both remotes
   * are always the encrypting adapters — no raw branch exists to reach.
   */
  private async syncConversationsE2E(
    syncUrl: string,
    authToken: string | undefined,
    encryptionKey: Uint8Array,
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
      new EncryptedConversationSyncAdapter({ inner: httpConvAdapter, key: encryptionKey }),
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
          new EncryptedPlanSyncAdapter({ inner: httpPlanAdapter, key: encryptionKey }),
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
    //
    // The catch-up adapter resolves a FRESH `sync` token per request — the
    // same mint the socket refresh below uses (#927). It used to hold the
    // first token for the session: the socket was refreshed every 4.5 min,
    // the catch-up was not, so after five minutes every catch-up was refused
    // and the refusal swallowed — desktop's only pull door went deaf. Every
    // transport is E2E-only (#928): a plaintext payload is refused before it
    // leaves the device.
    const httpAdapter = new HttpEventStoreAdapter({
      baseUrl: syncUrl,
      motebitId,
      credentialSource: {
        getCredential: () => this.deps.createSyncToken(keypair.privateKey),
      },
      payloads: "e2e",
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

    const onCatchUp = (pulled: number): void => {
      if (pulled > 0) {
        this.emitSyncStatus({
          lastSyncAt: Date.now(),
          eventsPulled: this._lastSyncStatus.eventsPulled + pulled,
        });
      }
    };
    // A failed catch-up is shown, never swallowed (#927).
    const onCatchUpError = (err: unknown): void => {
      this.emitSyncStatus({
        status: "error",
        error: `Catch-up failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    };
    const wsAdapter = new WebSocketEventStoreAdapter({
      url: wsUrl,
      motebitId,
      authToken: token,
      capabilities: desktopCapabilities,
      httpFallback: encryptedHttp,
      localStore: localEventStore ?? undefined,
      onCatchUp,
      onCatchUpError,
      payloads: "e2e",
    });
    this._wsAdapter = wsAdapter;

    // Encrypted wrapper for outbound events, over whichever socket adapter is
    // current: an append still encrypting when a token refresh swaps the
    // adapter lands on the replacement, not on the retired one (#816).
    let currentWs = wsAdapter;
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

    // Wire the encrypted WS adapter as the sync remote and start
    runtime.connectSync(encryptedWs);
    wsAdapter.connect();

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
    const privKeyHex = keypair.privateKey;
    let pinnedRelayKey: string | undefined;
    try {
      pinnedRelayKey = await getOrPinRelayKey(syncUrl, { storage: localStorage });
    } catch {
      pinnedRelayKey = undefined;
    }
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
    // One named handler, so a token refresh attaches the same one to the
    // replacement adapter (#816).
    const onRelayFrame: CustomMessageCallback = (msg) => {
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
              this._wsAdapter?.sendRaw(
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
            this._wsAdapter?.sendRaw(
              JSON.stringify({ type: "command_response", id: cmdMsg.id, result }),
            );
          } catch (err: unknown) {
            this._wsAdapter?.sendRaw(
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
      this._wsAdapter?.sendRaw(JSON.stringify({ type: "task_claim", task_id: task.task_id }));
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
    };
    if (this._wsUnsubOnCustom) this._wsUnsubOnCustom();
    this._wsUnsubOnCustom = wsAdapter.onCustomMessage(onRelayFrame);

    // Token refresh: rebuild WS connection every 4.5 min (tokens expire at 5 min).
    // Each refresh retires the adapter it REPLACES — `currentWs`, not the
    // first one — and attaches every handler to the replacement, so exactly
    // one socket is open and it is the one that answers (#816).
    const refreshTimer = setInterval(() => {
      void (async () => {
        try {
          const freshToken = await this.deps.createSyncToken(keypair.privateKey);
          // stopSync (or a later startSync) ended this session while the
          // token was minting: touch nothing of the session that replaced it.
          if (this._wsTokenRefreshTimer !== refreshTimer) {
            clearInterval(refreshTimer);
            currentWs.disconnect();
            return;
          }
          const replaced = currentWs;
          replaced.disconnect();
          const freshWs = new WebSocketEventStoreAdapter({
            url: wsUrl,
            motebitId,
            authToken: freshToken,
            capabilities: desktopCapabilities,
            httpFallback: encryptedHttp,
            localStore: localEventStore ?? undefined,
            onCatchUp,
            onCatchUpError,
            payloads: "e2e",
          });
          // Events the sync engine handed the replaced adapter while it was
          // offline are counted as pushed; they go out on the replacement.
          for (const queued of replaced.takePendingEvents()) void freshWs.append(queued);
          currentWs = freshWs;

          // Swap the listeners onto the replacement
          if (this._wsUnsubOnEvent) this._wsUnsubOnEvent();
          this._wsUnsubOnEvent = freshWs.onEvent(onInboundEvent);
          if (this._wsUnsubOnCustom) this._wsUnsubOnCustom();
          this._wsUnsubOnCustom = freshWs.onCustomMessage(onRelayFrame);

          freshWs.connect();
          this._wsAdapter = freshWs;
        } catch {
          // Token refresh failed — WS will reconnect on its own
        }
      })();
    }, 4.5 * 60_000);
    this._wsTokenRefreshTimer = refreshTimer;

    // One-shot conversation sync (encrypted, stays HTTP — no WS needed for conversations)
    void this.syncConversationsE2E(syncUrl, token, encKey)
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
    // What this surface offers other principals is derived from each
    // tool's own `localOnly` declaration (#874) — one rule for every
    // surface, never a per-surface name list that can forget a tool.
    const capabilities = servedToolNames(runtime.getToolRegistry().list());

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

  /** Stop background event sync. */
  stopSync(): void {
    const hooks = [...this._onStop];
    this._onStop.clear();
    for (const stop of hooks) stop();
    if (this._wsTokenRefreshTimer) {
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
    if (this._syncUnsubscribe) {
      this._syncUnsubscribe();
      this._syncUnsubscribe = null;
    }
    this.deps.getRuntime()?.sync.stop();
    this.emitSyncStatus({ status: "disconnected" });
  }
}
