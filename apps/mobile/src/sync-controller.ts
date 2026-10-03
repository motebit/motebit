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
import type { TokenAudience } from "@motebit/sdk";
import { loadColdStartOptIn } from "./cold-start-optin";
import type { MotebitRuntime } from "@motebit/runtime";
import {
  executeRemoteCommand,
  cmdSelfTest,
  servedToolNames,
  RelayDelegationAdapter,
  getOrPinRelayKey,
  verifyAgentCommandEnvelope,
} from "@motebit/runtime";
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
import type {
  CredentialSource,
  PlanSyncStoreAdapter,
  SyncStatus as SyncEngineStatus,
} from "@motebit/sync-engine";
import type { EventStoreAdapter } from "@motebit/event-log";
import { deriveSyncEncryptionKey, secureErase } from "@motebit/encryption";
import { registerDeviceWithRelay } from "@motebit/core-identity";
import type { ExpoStorageResult } from "./adapters/expo-sqlite";
import type { SecureStoreAdapter } from "./adapters/secure-store";
import {
  canExecuteDelegatedTask,
  mobileServingAllowed,
  MOBILE_SERVING_UNAVAILABLE,
} from "./serving-gate";

export type SyncStatus = SyncEngineStatus;

const SYNC_URL_KEY = "@motebit/sync_url";
const SYNC_INTERVAL_MS = 30_000;
/** Registration retry backoff (#962): 1 s, doubling, capped at 60 s. */
export const REGISTRATION_RETRY_BASE_MS = 1_000;
export const REGISTRATION_RETRY_MAX_MS = 60_000;

export interface SyncControllerDeps {
  getRuntime: () => MotebitRuntime | null;
  getMotebitId: () => string;
  getDeviceId: () => string;
  getPublicKey: () => string;
  getStorage: () => ExpoStorageResult | null;
  getLocalEventStore: () => EventStoreAdapter | null;
  getKeyring: () => SecureStoreAdapter;
  getPrivKeyBytes: () => Promise<Uint8Array>;
  createSyncToken: (aud?: TokenAudience) => Promise<string>;
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
  /**
   * Has the relay accepted this device's key this session (#962)? Until it
   * has, every signed token is refused, nothing is pushed, and the status
   * reads "error" — never "idle".
   */
  private _registered = false;
  private _registrationError: string | null = null;
  private _registrationTimer: ReturnType<typeof setTimeout> | null = null;
  private _registrationDelay = REGISTRATION_RETRY_BASE_MS;
  /** Bumped by stopSync: a registration of an ended session touches nothing. */
  private _session = 0;

  // Serving state
  private _serving = false;
  private _servingSyncUrl: string | null = null;
  private _servingAuthToken: string | null = null;
  private _activeTaskCount = 0;

  constructor(private deps: SyncControllerDeps) {}

  /**
   * This device's sync encryption key: the session's, else derived now from
   * the identity key (a `syncNow` before `startSync`). Mobile always holds a
   * device key, so every event push is E2E — there is no raw path (#928).
   */
  private async syncEncKey(): Promise<Uint8Array> {
    if (this._syncEncKey) return this._syncEncKey;
    const privKeyBytes = await this.deps.getPrivKeyBytes();
    try {
      return await deriveSyncEncryptionKey(privKeyBytes);
    } finally {
      secureErase(privKeyBytes);
    }
  }

  /**
   * A fresh `sync` token per request (#927): never a value captured once and
   * carried past its five-minute life.
   */
  private syncCredentials(): CredentialSource {
    return { getCredential: () => this.deps.createSyncToken() };
  }

  /**
   * The ONE event transport to the relay (#928): an HTTP adapter that
   * refuses any payload that is not an E2E envelope, under the encrypting
   * wrapper. `syncNow` pushed through a bare `HttpEventStoreAdapter`, so its
   * events reached the relay in plaintext; both push doors now come from here.
   */
  private e2eHttpEventStore(
    syncUrl: string,
    motebitId: string,
    encKey: Uint8Array,
  ): EncryptedEventStoreAdapter {
    const http = new HttpEventStoreAdapter({
      baseUrl: syncUrl,
      motebitId,
      credentialSource: this.syncCredentials(),
      payloads: "e2e",
    });
    return new EncryptedEventStoreAdapter({ inner: http, key: encKey });
  }

  /** A failed catch-up is shown in the sync status, never swallowed (#927). */
  private reportCatchUpError = (err: unknown): void => {
    // eslint-disable-next-line no-console -- the status carries no message; the log says why
    console.warn(`[sync] catch-up failed: ${err instanceof Error ? err.message : String(err)}`);
    this._syncStatus = "error";
    this._syncStatusCallback?.("error", this._lastSyncTime);
  };

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
    // Mobile is non-executing today (serving-gate.ts) — refuse before any
    // registration, so the relay never routes a delegation to this device.
    if (!mobileServingAllowed()) return { ok: false, error: MOBILE_SERVING_UNAVAILABLE };
    const runtime = this.deps.getRuntime();
    if (!runtime || !this._servingSyncUrl || !this._servingAuthToken) {
      return { ok: false, error: "Sync not connected" };
    }
    if (this._serving) return { ok: true };

    // What this surface offers other principals is derived from each
    // tool's own `localOnly` declaration (#874) — one rule for every
    // surface, never a per-surface name list that can forget a tool.
    const capabilities = servedToolNames(runtime.getToolRegistry().list());

    try {
      // Registration is the agent-registry family: `admin:query`. The cached
      // `sync` token was refused, so `/serve` never registered (#827).
      const registerToken = await this.deps.createSyncToken("admin:query");
      const res = await fetch(`${this._servingSyncUrl}/api/v1/agents/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${registerToken}`,
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
      /** Self-asserted display-name claim (trust-graph §3) — render via formatNameClaim. */
      display_name?: string | null;
      /** Listing description (self-authored). */
      description?: string | null;
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
   * Register this device's key with the relay through the signed,
   * self-attesting registration (#962). Mobile had no registration at all: a
   * phone the relay did not know had every token refused, pushed nothing,
   * and its relay-floored compaction held the log growing — while the status
   * read "idle". Idempotent on the relay side.
   */
  private async registerDevice(url: string): Promise<{ ok: true } | { ok: false; error: string }> {
    let privKeyBytes: Uint8Array;
    try {
      privKeyBytes = await this.deps.getPrivKeyBytes();
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    try {
      const res = await registerDeviceWithRelay({
        motebitId: this.deps.getMotebitId(),
        deviceId: this.deps.getDeviceId(),
        publicKey: this.deps.getPublicKey(),
        privateKey: privKeyBytes,
        syncUrl: url,
        deviceName: "Mobile",
      });
      return res.ok ? { ok: true } : { ok: false, error: `${res.code}: ${res.message}` };
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      secureErase(privKeyBytes);
    }
  }

  /**
   * One registration attempt for session `session`; on a refusal the status
   * goes to "error" and the next attempt is scheduled on backoff (1 s
   * doubling to 60 s, unref'd) until the relay accepts or sync stops.
   */
  private async attemptRegistration(url: string, session: number): Promise<void> {
    const result = await this.registerDevice(url);
    if (session !== this._session) return;
    if (result.ok) {
      this._registered = true;
      this._registrationError = null;
      return;
    }
    this._registrationError = result.error;
    // eslint-disable-next-line no-console -- the status carries no message; the log says why
    console.warn(`[sync] relay did not accept this device: ${result.error}`);
    this._syncStatus = "error";
    this._syncStatusCallback?.("error", this._lastSyncTime);
    const delay = this._registrationDelay;
    this._registrationDelay = Math.min(delay * 2, REGISTRATION_RETRY_MAX_MS);
    this._registrationTimer = setTimeout(() => {
      this._registrationTimer = null;
      void this.attemptRegistration(url, session);
    }, delay);
    (this._registrationTimer as { unref?: () => void }).unref?.();
  }

  async startSync(syncUrl?: string): Promise<void> {
    const url = syncUrl != null && syncUrl !== "" ? syncUrl : await this.getSyncUrl();
    const storage = this.deps.getStorage();
    if (url == null || url === "" || !storage) return;

    await this.setSyncUrl(url);
    const motebitId = this.deps.getMotebitId();

    // Registration is attempted BEFORE the socket connects and before the
    // first push (#962); a refusal keeps retrying on backoff below.
    const session = ++this._session;
    this._registered = false;
    this._registrationDelay = REGISTRATION_RETRY_BASE_MS;
    await this.attemptRegistration(url, session);

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

    if (this._registered) {
      this._syncStatus = "idle";
      this._syncStatusCallback?.("idle", this._lastSyncTime);
    }

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
        // Honor the requested audience (task:submit to submit, task:query to
        // poll) — the relay enforces aud binding (auth-token-v1 §5). Minting a
        // task:submit token for the /task/:id poll would 403 (audience
        // mismatch) if this surface ever served at onboarding. Matches web.
        mintToken: async (audience: TokenAudience) => this.deps.createSyncToken(audience),
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
        await AsyncStorage.setItem(FLAG, "true");
      }
    } catch (err: unknown) {
      // eslint-disable-next-line no-console
      console.warn("[self-test] error:", err instanceof Error ? err.message : String(err));
    }
  }

  stopSync(): void {
    this._session++;
    if (this._registrationTimer) {
      clearTimeout(this._registrationTimer);
      this._registrationTimer = null;
    }
    this._registered = false;
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
    const encKey = await this.syncEncKey();

    // Event sync — E2E, the same transport the sync cycle uses (#928).
    const tempEventSync = new SyncEngine(storage.eventStore, motebitId);
    tempEventSync.connectRemote(this.e2eHttpEventStore(url, motebitId, encKey));
    const eventResult = await tempEventSync.sync();
    // `sync()` never rejects: a refused or failed push is recorded, not
    // thrown. /sync must never toast "Synced" over it (#962).
    const eventError = tempEventSync.getLastError();
    if (eventError) {
      this._syncStatus = "error";
      this._syncStatusCallback?.("error", this._lastSyncTime);
      throw new Error(`event sync failed: ${eventError.message}`, { cause: eventError });
    }

    // Conversation sync (encrypted — relay stores opaque ciphertext)
    const convHttpAdapter = new HttpConversationSyncAdapter({
      baseUrl: url,
      motebitId,
      authToken: token,
    });
    const tempConvSync = new ConversationSyncEngine(storage.conversationSyncStore, motebitId);
    tempConvSync.connectRemote(
      new EncryptedConversationSyncAdapter({ inner: convHttpAdapter, key: encKey }),
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

      // Fail closed (#928): without the sync key there is no event sync at
      // all — never a raw fallback that pushes plaintext. startSync sets the
      // key together with the engines, so this is a broken session.
      if (!encKey)
        throw new Error("sync: no sync encryption key — refusing a plaintext event push");
      // Build adapter stack with encryption
      const encryptedHttp = this.e2eHttpEventStore(syncUrl, motebitId, encKey);
      const wsUrl =
        syncUrl.replace(/^https?/, (m) => (m === "https" ? "wss" : "ws")) + "/ws/sync/" + motebitId;

      const localEventStore = this.deps.getLocalEventStore();
      const mobileCapabilities = [
        DeviceCapability.HttpMcp,
        DeviceCapability.Keyring,
        DeviceCapability.PushWake,
      ];
      const wsAdapter = new WebSocketEventStoreAdapter({
        url: wsUrl,
        motebitId,
        credentialSource: this.syncCredentials(),
        capabilities: mobileCapabilities,
        httpFallback: encryptedHttp,
        localStore: localEventStore ?? undefined,
        payloads: "e2e",
        onCatchUpError: this.reportCatchUpError,
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
        // A per-audience provider: the adapter submits (`task:submit`) and
        // polls (`task:query`). The static `sync` token failed both (#827).
        const delegationAdapter = new RelayDelegationAdapter({
          syncUrl,
          motebitId,
          authToken: (audience: TokenAudience) => this.deps.createSyncToken(audience),
          sendRaw: (data: string) => wsAdapter.sendRaw(data),
          onCustomMessage: (cb) => wsAdapter.onCustomMessage(cb),
          getExplorationDrive: () => this.deps.getRuntime()?.getPrecision().explorationDrive,
        });
        runtime.setDelegationAdapter(delegationAdapter);

        // Enable interactive delegation — lets the AI transparently delegate
        // tasks to remote agents during conversation. Resolve the PINNED
        // relay key (TOFU) via AsyncStorage so a paid P2P delegation derives
        // the fee-leg treasury from a key trusted at first connect, never a
        // fetched value (the irreversible-payment MITM surface). undefined →
        // P2P disabled, relay-mode still serves the task.
        const pinnedRelayKey = await getOrPinRelayKey(syncUrl, {
          storage: {
            getItem: (k) => AsyncStorage.getItem(k),
            setItem: (k, v) => AsyncStorage.setItem(k, v),
          },
        });
        runtime.enableInteractiveDelegation({
          syncUrl,
          // Honor the audience the runtime asks for — `task:submit` to
          // submit, `task:query` to poll, `market:listing` for the P2P
          // pre-flight. A closure that ignored it sent `task:submit` to all
          // three, and the poll and pre-flight were refused (#827).
          authToken: (audience?: TokenAudience) =>
            this.deps.createSyncToken(audience ?? "task:submit"),
          ...(pinnedRelayKey != null ? { relayPublicKey: pinnedRelayKey } : {}),
          // Forward the cold-start opt-in as a LIVE getter (reads the in-memory
          // mirror of MobileSettings.coldStartOptIn) so the Governance toggle
          // governs chat-driven (delegate_to_agent) P2P delegation, not just a
          // re-enable — parity with the web fix (d6cab601).
          acknowledgeNoHistoryRisk: () => loadColdStartOptIn(),
        });

        // Store serving state
        this._servingSyncUrl = syncUrl;
        this._servingAuthToken = token ?? null;

        // Wire task handler — accept delegations while the app is open.
        wsAdapter.onCustomMessage((msg) => {
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
                  identityPublicKey: this.deps.getPublicKey(),
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
                // The one door for a relay frame.
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

          if (msg.type !== "task_request" || msg.task == null) return;
          // The single execution gate (serving-gate.ts): off by default, and
          // `/serve` cannot turn it on.
          if (!canExecuteDelegatedTask(this._serving)) return;
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
                // The result route verifies `task:result` (#827).
                const freshToken = await this.deps.createSyncToken("task:result");
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

      // Conversation sync (encrypted at relay boundary)
      const convHttpAdapter = new HttpConversationSyncAdapter({
        baseUrl: syncUrl,
        motebitId,
        authToken: token,
      });
      this.conversationSyncEngine.connectRemote(
        new EncryptedConversationSyncAdapter({ inner: convHttpAdapter, key: encKey }),
      );

      await this.syncEngine.sync();
      // `sync()` never rejects: a refused or failed push is recorded in
      // `getLastError()`. It ends this cycle in "error", never "idle" (#962).
      const eventError = this.syncEngine.getLastError();
      if (eventError) throw eventError;
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
            new EncryptedPlanSyncAdapter({ inner: httpPlanAdapter, key: encKey }),
          );
          await planSync.sync();
        } catch {
          // Plan sync failure shouldn't break the sync cycle
        }
      }

      // The relay has not accepted this device: nothing it sent was taken.
      if (!this._registered) {
        throw new Error(
          `relay has not accepted this device${this._registrationError ? `: ${this._registrationError}` : ""}`,
        );
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
