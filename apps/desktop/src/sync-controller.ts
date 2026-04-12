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
import { executeCommand, cmdSelfTest } from "@motebit/runtime";
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
import type { SyncStatus } from "@motebit/sync-engine";
import type { PlanStoreAdapter } from "@motebit/planner";
import {
  TauriConversationSyncStoreAdapter,
  TauriPlanSyncStoreAdapter,
} from "./tauri-sync-adapters.js";
import type { InvokeFn, TauriConversationStore, TauriPlanStore } from "./tauri-storage.js";

export type SyncIndicatorStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "syncing"
  | "conflict"
  | "error";

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
  createSyncToken: (privateKeyHex: string, aud?: string) => Promise<string>;
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
  async startSync(invoke: InvokeFn, syncUrl: string, authToken?: string): Promise<void> {
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
    const httpAdapter = new HttpEventStoreAdapter({
      baseUrl: syncUrl,
      motebitId,
      authToken: token,
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

    const wsAdapter = new WebSocketEventStoreAdapter({
      url: wsUrl,
      motebitId,
      authToken: token,
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
    this._wsAdapter = wsAdapter;

    // Encrypted wrapper around WS adapter for outbound events
    const encryptedWs = new EncryptedEventStoreAdapter({ inner: wsAdapter, key: encKey });

    // Inbound real-time events: decrypt and write to local store
    this._wsUnsubOnEvent = wsAdapter.onEvent((raw) => {
      void (async () => {
        if (!localEventStore) return;
        const dec = await decryptEventPayload(raw, encKey);
        await localEventStore.append(dec);
      })();
    });

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
    const privKeyHex = keypair.privateKey;
    runtime.enableInteractiveDelegation({
      syncUrl,
      authToken: async () => this.deps.createSyncToken(privKeyHex, "task:submit"),
    });

    // Store serving state for task handler
    const servingPrivKey = new Uint8Array(privKeyHex.length / 2);
    for (let i = 0; i < privKeyHex.length; i += 2) {
      servingPrivKey[i / 2] = parseInt(privKeyHex.slice(i, i + 2), 16);
    }
    this._servingPrivateKey = servingPrivKey;
    this._servingSyncUrl = syncUrl;
    this._servingAuthToken = token;

    // Wire task handler — accept delegations from the network.
    // The glass droplet becomes a body that works, not just a face that talks.
    if (this._wsUnsubOnCustom) this._wsUnsubOnCustom();
    this._wsUnsubOnCustom = wsAdapter.onCustomMessage((msg) => {
      const rt = this.deps.getRuntime();
      // Handle remote command requests (forwarded by relay)
      if (msg.type === "command_request" && rt) {
        const cmdMsg = msg as unknown as { id: string; command: string; args?: string };
        void (async () => {
          try {
            const result = await executeCommand(rt, cmdMsg.command, cmdMsg.args);
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
            await fetch(resultUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${authToken}`,
              },
              body: JSON.stringify(receipt),
            });
          }
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          // Task-handler diagnostic — surface failures to the desktop log so
          // operators can see why a delegation didn't complete. The serving
          // path runs detached from the chat UI, so there's no other place
          // for this to land.
          // eslint-disable-next-line no-console -- task-handler diagnostic
          console.error(`Task ${task.task_id.slice(0, 8)}... error: ${errMsg}`);
        } finally {
          this._activeTaskCount = Math.max(0, this._activeTaskCount - 1);
        }
      })();
    });

    // Token refresh: rebuild WS connection every 4.5 min (tokens expire at 5 min)
    this._wsTokenRefreshTimer = setInterval(() => {
      void (async () => {
        try {
          wsAdapter.disconnect();
          const freshToken = await this.deps.createSyncToken(keypair.privateKey);
          const freshWs = new WebSocketEventStoreAdapter({
            url: wsUrl,
            motebitId,
            authToken: freshToken,
            capabilities: desktopCapabilities,
            httpFallback: encryptedHttp,
            localStore: localEventStore ?? undefined,
          });

          // Swap onEvent listener
          if (this._wsUnsubOnEvent) this._wsUnsubOnEvent();
          this._wsUnsubOnEvent = freshWs.onEvent((raw) => {
            void (async () => {
              if (!localEventStore) return;
              const dec = await decryptEventPayload(raw, encKey);
              await localEventStore.append(dec);
            })();
          });

          const freshEncrypted = new EncryptedEventStoreAdapter({ inner: freshWs, key: encKey });
          this.deps.getRuntime()?.connectSync(freshEncrypted);
          freshWs.connect();
          this._wsAdapter = freshWs;
        } catch {
          // Token refresh failed — WS will reconnect on its own
        }
      })();
    }, 4.5 * 60_000);

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
        mintToken: async () => this.deps.createSyncToken(privateKeyHex, "task:submit"),
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
    ]);
    const tools = runtime.getToolRegistry().list();
    const capabilities = tools
      .filter((t: { name: string }) => !LOCAL_ONLY.has(t.name))
      .map((t: { name: string }) => t.name);

    try {
      const res = await fetch(`${this._servingSyncUrl}/api/v1/agents/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this._servingAuthToken}`,
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
        }>;
      };
      return data.agents ?? [];
    } catch {
      return [];
    }
  }

  /** Stop background event sync. */
  stopSync(): void {
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
