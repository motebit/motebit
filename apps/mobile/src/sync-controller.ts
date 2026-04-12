/**
 * Mobile sync controller — owns the relay-sync lifecycle: WebSocket
 * event sync, conversation + plan HTTP sync, adversarial self-test,
 * delegation task handler, and serving state.
 *
 * Mirrors the desktop `SyncController` pattern — class owns every
 * sync-specific piece of state, reads runtime/storage/identity helpers
 * through getter closures.
 *
 * Also co-located here is `ExpoPlanSyncStoreAdapter`, the
 * sync-adapter bridge that used to live at the bottom of mobile-app.ts.
 * It's only used by `syncCycle`, so it belongs with the controller
 * rather than as a floating module-level class.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import type { MotebitRuntime } from "@motebit/runtime";
import { executeCommand, cmdSelfTest, RelayDelegationAdapter } from "@motebit/runtime";
import {
  DeviceCapability,
  type Plan,
  type PlanStep,
  type SyncPlan,
  type SyncPlanStep,
} from "@motebit/sdk";
import type { AgentTask, ExecutionReceipt } from "@motebit/sdk";
import {
  SyncEngine,
  HttpEventStoreAdapter,
  WebSocketEventStoreAdapter,
  EncryptedEventStoreAdapter,
  decryptEventPayload,
  ConversationSyncEngine,
  HttpConversationSyncAdapter,
  EncryptedConversationSyncAdapter,
  PlanSyncEngine,
  HttpPlanSyncAdapter,
  EncryptedPlanSyncAdapter,
} from "@motebit/sync-engine";
import type { PlanSyncStoreAdapter, SyncStatus as SyncEngineStatus } from "@motebit/sync-engine";
import type { EventStoreAdapter } from "@motebit/event-log";
import { deriveSyncEncryptionKey, secureErase } from "@motebit/encryption";
import type { ExpoStorageResult } from "./adapters/expo-sqlite";
import type { SecureStoreAdapter } from "./adapters/secure-store";

export type SyncStatus = SyncEngineStatus;

const SYNC_URL_KEY = "@motebit/sync_url";
const SYNC_INTERVAL_MS = 30_000;

export interface SyncControllerDeps {
  getRuntime: () => MotebitRuntime | null;
  getMotebitId: () => string;
  getDeviceId: () => string;
  getPublicKey: () => string;
  getStorage: () => ExpoStorageResult | null;
  getLocalEventStore: () => EventStoreAdapter | null;
  getKeyring: () => SecureStoreAdapter;
  getPrivKeyBytes: () => Promise<Uint8Array>;
  createSyncToken: (aud?: string) => Promise<string>;
  /** Called after startSync to register a push token with the relay. */
  registerPushToken: (syncUrl: string) => Promise<void>;
  startPushLifecycle: () => void;
  stopPushLifecycle: () => void;
}

export class MobileSyncController {
  private syncEngine: SyncEngine | null = null;
  private conversationSyncEngine: ConversationSyncEngine | null = null;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private _syncStatus: SyncStatus = "offline";
  private _syncStatusCallback: ((status: SyncStatus, lastSync: number) => void) | null = null;
  private _lastSyncTime = 0;
  private _wsAdapter: WebSocketEventStoreAdapter | null = null;
  private _wsUnsubOnEvent: (() => void) | null = null;
  private _syncEncKey: Uint8Array | null = null;

  // Serving state
  private _serving = false;
  private _servingSyncUrl: string | null = null;
  private _servingAuthToken: string | null = null;
  private _activeTaskCount = 0;

  constructor(private deps: SyncControllerDeps) {}

  async getSyncUrl(): Promise<string | null> {
    return AsyncStorage.getItem(SYNC_URL_KEY);
  }

  async setSyncUrl(url: string): Promise<void> {
    await AsyncStorage.setItem(SYNC_URL_KEY, url);
  }

  async clearSyncUrl(): Promise<void> {
    await AsyncStorage.removeItem(SYNC_URL_KEY);
  }

  get syncStatus(): SyncStatus {
    return this._syncStatus;
  }

  get lastSyncTime(): number {
    return this._lastSyncTime;
  }

  get isSyncConnected(): boolean {
    return this.syncEngine !== null;
  }

  onSyncStatus(callback: (status: SyncStatus, lastSync: number) => void): void {
    this._syncStatusCallback = callback;
  }

  async startServing(): Promise<{ ok: boolean; error?: string }> {
    const runtime = this.deps.getRuntime();
    if (!runtime || !this._servingSyncUrl || !this._servingAuthToken) {
      return { ok: false, error: "Sync not connected" };
    }
    if (this._serving) return { ok: true };

    const LOCAL_ONLY = new Set([
      "read_file",
      "recall_memories",
      "list_events",
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
          public_key: this.deps.getPublicKey(),
          capabilities,
        }),
      });
      if (!res.ok) return { ok: false, error: `Registration failed: ${res.status}` };
      this._serving = true;
      return { ok: true };
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
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

  async startSync(syncUrl?: string): Promise<void> {
    const url = syncUrl != null && syncUrl !== "" ? syncUrl : await this.getSyncUrl();
    const storage = this.deps.getStorage();
    if (url == null || url === "" || !storage) return;

    await this.setSyncUrl(url);
    const motebitId = this.deps.getMotebitId();

    // Derive encryption key once for the sync session, then erase raw key bytes
    const privKeyBytes = await this.deps.getPrivKeyBytes();
    this._syncEncKey = await deriveSyncEncryptionKey(privKeyBytes);
    secureErase(privKeyBytes);

    // Create engines (they don't start their own timers — we manage the interval
    // ourselves so we can refresh the auth token each cycle)
    this.syncEngine = new SyncEngine(storage.eventStore, motebitId, {
      sync_interval_ms: SYNC_INTERVAL_MS,
    });

    this.conversationSyncEngine = new ConversationSyncEngine(
      storage.conversationSyncStore,
      motebitId,
      { sync_interval_ms: SYNC_INTERVAL_MS },
    );

    this._syncStatus = "idle";
    this._syncStatusCallback?.("idle", this._lastSyncTime);

    // Run the sync loop via our own timer (to refresh tokens per cycle)
    this.syncTimer = setInterval(() => {
      void this.syncCycle(url);
    }, SYNC_INTERVAL_MS);

    // Immediate first sync after short delay (let initialization settle)
    setTimeout(() => void this.syncCycle(url), 3000);

    // Register push token for wake-on-demand background execution
    void this.deps.registerPushToken(url);
    this.deps.startPushLifecycle();

    // Adversarial onboarding: run self-test once after first relay connection
    void this.runOnboardingSelfTest(url);
  }

  /**
   * Run cmdSelfTest exactly once per device. Uses AsyncStorage flag to avoid
   * repeating on subsequent launches. Best-effort — failures are logged, never blocking.
   */
  private async runOnboardingSelfTest(syncUrl: string): Promise<void> {
    const FLAG = "motebit:self-test-done";
    try {
      const done = await AsyncStorage.getItem(FLAG);
      if (done === "true") return;
    } catch (err: unknown) {
      // eslint-disable-next-line no-console -- docstring promises logging
      console.warn(
        "[self-test] flag check failed:",
        err instanceof Error ? err.message : String(err),
      );
      return;
    }
    const runtime = this.deps.getRuntime();
    if (!runtime) return;

    try {
      const token = await this.deps.createSyncToken("task:submit");
      if (!token) return;

      const result = await cmdSelfTest(runtime, {
        relay: { relayUrl: syncUrl, authToken: token, motebitId: this.deps.getMotebitId() },
        mintToken: async () => this.deps.createSyncToken("task:submit"),
        timeoutMs: 30_000,
      });

      // eslint-disable-next-line no-console
      console.log("[self-test]", result.summary);
      if (result.data?.status === "passed" || result.data?.status === "skipped") {
        await AsyncStorage.setItem(FLAG, "true");
      }
    } catch (err: unknown) {
      // eslint-disable-next-line no-console
      console.warn("[self-test] error:", err instanceof Error ? err.message : String(err));
    }
  }

  stopSync(): void {
    this.deps.stopPushLifecycle();
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    if (this._wsUnsubOnEvent) {
      this._wsUnsubOnEvent();
      this._wsUnsubOnEvent = null;
    }
    if (this._wsAdapter) {
      this._wsAdapter.disconnect();
      this._wsAdapter = null;
    }
    this.syncEngine?.stop();
    this.conversationSyncEngine?.stop();
    this.syncEngine = null;
    this.conversationSyncEngine = null;
    this._syncEncKey = null;
    this._syncStatus = "offline";
    this._syncStatusCallback?.("offline", this._lastSyncTime);
  }

  async disconnectSync(): Promise<void> {
    this.stopSync();
    await this.clearSyncUrl();
  }

  async syncNow(): Promise<{
    events_pushed: number;
    events_pulled: number;
    conversations_pushed: number;
    conversations_pulled: number;
  }> {
    const url = await this.getSyncUrl();
    const storage = this.deps.getStorage();
    if (url == null || url === "" || !storage) throw new Error("No sync relay configured");
    const motebitId = this.deps.getMotebitId();

    const token = await this.deps.createSyncToken();

    // Event sync
    const eventAdapter = new HttpEventStoreAdapter({
      baseUrl: url,
      motebitId,
      authToken: token,
    });
    const tempEventSync = new SyncEngine(storage.eventStore, motebitId);
    tempEventSync.connectRemote(eventAdapter);
    const eventResult = await tempEventSync.sync();

    // Conversation sync (encrypted — relay stores opaque ciphertext)
    const convHttpAdapter = new HttpConversationSyncAdapter({
      baseUrl: url,
      motebitId,
      authToken: token,
    });
    const tempConvSync = new ConversationSyncEngine(storage.conversationSyncStore, motebitId);
    tempConvSync.connectRemote(
      this._syncEncKey
        ? new EncryptedConversationSyncAdapter({ inner: convHttpAdapter, key: this._syncEncKey })
        : convHttpAdapter,
    );
    const convResult = await tempConvSync.sync();

    this._lastSyncTime = Date.now();
    this._syncStatusCallback?.("idle", this._lastSyncTime);

    return {
      events_pushed: eventResult.pushed,
      events_pulled: eventResult.pulled,
      conversations_pushed: convResult.conversations_pushed,
      conversations_pulled: convResult.conversations_pulled,
    };
  }

  private async syncCycle(syncUrl: string): Promise<void> {
    if (!this.syncEngine || !this.conversationSyncEngine) return;
    const storage = this.deps.getStorage();
    if (!storage) return;
    const motebitId = this.deps.getMotebitId();

    this._syncStatus = "syncing";
    this._syncStatusCallback?.("syncing", this._lastSyncTime);

    try {
      const token = await this.deps.createSyncToken();
      const encKey = this._syncEncKey;

      // Tear down previous WS connection (token expired)
      if (this._wsUnsubOnEvent) {
        this._wsUnsubOnEvent();
        this._wsUnsubOnEvent = null;
      }
      if (this._wsAdapter) {
        this._wsAdapter.disconnect();
        this._wsAdapter = null;
      }

      // Build adapter stack with encryption
      const httpAdapter = new HttpEventStoreAdapter({
        baseUrl: syncUrl,
        motebitId,
        authToken: token,
      });

      if (encKey) {
        const encryptedHttp = new EncryptedEventStoreAdapter({ inner: httpAdapter, key: encKey });
        const wsUrl =
          syncUrl.replace(/^https?/, (m) => (m === "https" ? "wss" : "ws")) +
          "/ws/sync/" +
          motebitId;

        const localEventStore = this.deps.getLocalEventStore();
        const mobileCapabilities = [
          DeviceCapability.HttpMcp,
          DeviceCapability.Keyring,
          DeviceCapability.PushWake,
        ];
        const wsAdapter = new WebSocketEventStoreAdapter({
          url: wsUrl,
          motebitId,
          authToken: token,
          capabilities: mobileCapabilities,
          httpFallback: encryptedHttp,
          localStore: localEventStore ?? undefined,
        });
        this._wsAdapter = wsAdapter;

        const encryptedWs = new EncryptedEventStoreAdapter({ inner: wsAdapter, key: encKey });

        // Inbound real-time events
        this._wsUnsubOnEvent = wsAdapter.onEvent((raw) => {
          void (async () => {
            if (!localEventStore) return;
            const dec = await decryptEventPayload(raw, encKey);
            await localEventStore.append(dec);
          })();
        });

        // Wire delegation adapter so PlanEngine can delegate steps to capable devices
        const runtime = this.deps.getRuntime();
        if (runtime) {
          const delegationAdapter = new RelayDelegationAdapter({
            syncUrl,
            motebitId,
            authToken: token ?? undefined,
            sendRaw: (data: string) => wsAdapter.sendRaw(data),
            onCustomMessage: (cb) => wsAdapter.onCustomMessage(cb),
            getExplorationDrive: () => this.deps.getRuntime()?.getPrecision().explorationDrive,
          });
          runtime.setDelegationAdapter(delegationAdapter);

          // Enable interactive delegation — lets the AI transparently delegate
          // tasks to remote agents during conversation.
          runtime.enableInteractiveDelegation({
            syncUrl,
            authToken: () => this.deps.createSyncToken("task:submit"),
          });

          // Store serving state
          this._servingSyncUrl = syncUrl;
          this._servingAuthToken = token ?? null;

          // Wire task handler — accept delegations while the app is open.
          wsAdapter.onCustomMessage((msg) => {
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
            if (!rt) return;

            const task = msg.task as AgentTask;
            const runtimeRef = rt;

            this._wsAdapter?.sendRaw(JSON.stringify({ type: "task_claim", task_id: task.task_id }));
            this._activeTaskCount++;

            void (async () => {
              try {
                const keyring = this.deps.getKeyring();
                const privKeyHex = await keyring.get("device_private_key");
                if (!privKeyHex) return;
                const privKeyBytes = new Uint8Array(privKeyHex.length / 2);
                for (let i = 0; i < privKeyHex.length; i += 2) {
                  privKeyBytes[i / 2] = parseInt(privKeyHex.slice(i, i + 2), 16);
                }

                let receipt: ExecutionReceipt | undefined;
                for await (const chunk of runtimeRef.handleAgentTask(
                  task,
                  privKeyBytes,
                  this.deps.getDeviceId(),
                  undefined,
                  { delegatedScope: task.delegated_scope },
                )) {
                  if (chunk.type === "task_result") {
                    receipt = chunk.receipt;
                  }
                }

                if (receipt && this._servingSyncUrl) {
                  const freshToken = await this.deps.createSyncToken("task:submit");
                  await fetch(
                    `${this._servingSyncUrl}/agent/${motebitId}/task/${task.task_id}/result`,
                    {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${freshToken}`,
                      },
                      body: JSON.stringify(receipt),
                    },
                  );
                }
              } catch {
                // Task execution failed
              } finally {
                this._activeTaskCount = Math.max(0, this._activeTaskCount - 1);
              }
            })();
          });
        }

        this.syncEngine.connectRemote(encryptedWs);
        wsAdapter.connect();

        // Recover any delegated steps orphaned by a previous app close
        if (runtime) {
          void (async () => {
            try {
              for await (const _chunk of runtime.recoverDelegatedSteps()) {
                // Chunks consumed — state changes propagate through plan store
              }
            } catch {
              // Recovery is best-effort
            }
          })();
        }
      } else {
        // Fallback: no encryption key available
        this.syncEngine.connectRemote(httpAdapter);
      }

      // Conversation sync (encrypted at relay boundary)
      const convHttpAdapter = new HttpConversationSyncAdapter({
        baseUrl: syncUrl,
        motebitId,
        authToken: token,
      });
      this.conversationSyncEngine.connectRemote(
        encKey
          ? new EncryptedConversationSyncAdapter({ inner: convHttpAdapter, key: encKey })
          : convHttpAdapter,
      );

      await this.syncEngine.sync();
      await this.conversationSyncEngine.sync();

      // Plan sync — push/pull plans for cross-device visibility
      if (storage.planStore != null) {
        try {
          const planSyncStore = new ExpoPlanSyncStoreAdapter(storage.planStore, motebitId);
          const planSync = new PlanSyncEngine(planSyncStore, motebitId);
          const httpPlanAdapter = new HttpPlanSyncAdapter({
            baseUrl: syncUrl,
            motebitId,
            authToken: token ?? undefined,
          });
          planSync.connectRemote(
            encKey
              ? new EncryptedPlanSyncAdapter({ inner: httpPlanAdapter, key: encKey })
              : httpPlanAdapter,
          );
          await planSync.sync();
        } catch {
          // Plan sync failure shouldn't break the sync cycle
        }
      }

      this._lastSyncTime = Date.now();
      this._syncStatus = "idle";
      this._syncStatusCallback?.("idle", this._lastSyncTime);
    } catch {
      this._syncStatus = "error";
      this._syncStatusCallback?.("error", this._lastSyncTime);
    }
  }
}

/**
 * Bridges ExpoPlanStore (sync SQLite) to PlanSyncStoreAdapter for plan sync.
 * Previously defined at the bottom of mobile-app.ts; co-located here since
 * syncCycle is the only caller.
 */
class ExpoPlanSyncStoreAdapter implements PlanSyncStoreAdapter {
  constructor(
    private store: {
      getPlan(id: string): Plan | null;
      getStep(id: string): PlanStep | null;
      getStepsForPlan(planId: string): PlanStep[];
      savePlan(plan: Plan): void;
      saveStep(step: PlanStep): void;
      listAllPlans?(motebitId: string): Plan[];
      listActivePlans?(motebitId: string): Plan[];
      listStepsSince?(motebitId: string, since: number): PlanStep[];
    },
    private motebitId: string,
  ) {}

  getPlansSince(_motebitId: string, since: number): SyncPlan[] {
    const allPlans =
      this.store.listAllPlans?.(this.motebitId) ??
      this.store.listActivePlans?.(this.motebitId) ??
      [];
    return allPlans
      .filter((p) => p.updated_at > since)
      .map((p) => ({
        ...p,
        proposal_id: p.proposal_id ?? null,
        collaborative: p.collaborative ? 1 : 0,
      }));
  }

  getStepsSince(_motebitId: string, since: number): SyncPlanStep[] {
    const steps = this.store.listStepsSince?.(this.motebitId, since) ?? [];
    return steps.map((s) => ({
      step_id: s.step_id,
      plan_id: s.plan_id,
      motebit_id: this.motebitId,
      ordinal: s.ordinal,
      description: s.description,
      prompt: s.prompt,
      depends_on: JSON.stringify(s.depends_on),
      optional: s.optional,
      status: s.status,
      required_capabilities:
        s.required_capabilities != null ? JSON.stringify(s.required_capabilities) : null,
      delegation_task_id: s.delegation_task_id ?? null,
      assigned_motebit_id: s.assigned_motebit_id ?? null,
      result_summary: s.result_summary,
      error_message: s.error_message,
      tool_calls_made: s.tool_calls_made,
      started_at: s.started_at,
      completed_at: s.completed_at,
      retry_count: s.retry_count,
      updated_at: s.updated_at,
    }));
  }

  upsertPlan(plan: SyncPlan): void {
    const existing = this.store.getPlan(plan.plan_id);
    if (!existing || plan.updated_at >= existing.updated_at) {
      this.store.savePlan({
        ...plan,
        proposal_id: plan.proposal_id ?? undefined,
        collaborative: plan.collaborative === 1,
      });
    }
  }

  upsertStep(step: SyncPlanStep): void {
    const existing = this.store.getStep(step.step_id);
    if (existing) {
      const ORDER: Record<string, number> = {
        pending: 0,
        running: 1,
        completed: 2,
        failed: 2,
        skipped: 2,
      };
      if ((ORDER[step.status] ?? 0) < (ORDER[existing.status] ?? 0)) return;
    }
    this.store.saveStep({
      step_id: step.step_id,
      plan_id: step.plan_id,
      ordinal: step.ordinal,
      description: step.description,
      prompt: step.prompt,
      depends_on:
        typeof step.depends_on === "string" ? (JSON.parse(step.depends_on) as string[]) : [],
      optional: step.optional,
      status: step.status,
      required_capabilities:
        step.required_capabilities != null
          ? (JSON.parse(step.required_capabilities) as PlanStep["required_capabilities"])
          : undefined,
      delegation_task_id: step.delegation_task_id ?? undefined,
      assigned_motebit_id: step.assigned_motebit_id ?? undefined,
      result_summary: step.result_summary,
      error_message: step.error_message,
      tool_calls_made: step.tool_calls_made,
      started_at: step.started_at,
      completed_at: step.completed_at,
      retry_count: step.retry_count,
      updated_at: step.updated_at,
    });
  }
}
