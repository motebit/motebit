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
  TaskClaimCoordinator,
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
import { RelaySession, isRelaySessionDisposed, type RelayChannel } from "./relay-session";
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
/** One device-registration attempt is abandoned after this (a black-holed network). */
export const REGISTRATION_TIMEOUT_MS = 15_000;
/** Relay OFF waits at most this long for the push-token unregister. */
export const PUSH_UNREGISTER_TIMEOUT_MS = 5_000;

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
  /**
   * Called once the relay accepted the device, to register a push token with
   * it — under the attempt's relay session: the POST goes through
   * `session.fetch`, which refuses once relay OFF (or a restart) disposed it.
   */
  registerPushToken: (syncUrl: string, session: RelayChannel) => Promise<void>;
  /** Called on relay OFF — after the session is disposed — with the URL captured before. */
  removePushToken: (syncUrl: string) => Promise<void>;
  /** Push listeners for this session; stopped when the session is disposed. */
  startPushLifecycle: (session: RelayChannel) => void;
  stopPushLifecycle: () => void;
}

/**
 * One relay attempt (one startSync): the `RelaySession` that owns every relay
 * handle, plus that attempt's sync state. A restart replaces it whole and OFF
 * drops it whole — nothing an attempt started can act in the next one.
 */
interface RelayAttempt {
  readonly session: RelaySession<SyncStatus>;
  /** Mints a token only while the session is live. */
  readonly mint: (aud?: TokenAudience) => Promise<string>;
  readonly taskClaims: TaskClaimCoordinator;
  url: string | null;
  /**
   * Has the relay accepted this device's key in this attempt (#962)? Until
   * it has, every signed token is refused, nothing is pushed, and the status
   * reads "error" — never "idle".
   */
  registered: boolean;
  registrationError: string | null;
  registrationDelay: number;
  syncEngine: SyncEngine | null;
  conversationSyncEngine: ConversationSyncEngine | null;
  encKey: Uint8Array | null;
  ws: WebSocketEventStoreAdapter | null;
  wsUnsub: (() => void) | null;
  serving: boolean;
  servingUrl: string | null;
  servingAuthToken: string | null;
}

export class MobileSyncController {
  /** The live attempt, if any. Relay work is reachable ONLY through its session. */
  private attempt: RelayAttempt | null = null;
  /** Sessions not tied to an attempt (a syncNow before startSync); OFF ends them too. */
  private readonly detached = new Set<RelaySession<SyncStatus>>();
  /** Bumped by every startSync and stopSync (`relayGeneration`). */
  private _generation = 0;
  private _syncStatus: SyncStatus = "offline";
  private _syncStatusCallback: ((status: SyncStatus, lastSync: number) => void) | null = null;
  private _lastSyncTime = 0;
  private _activeTaskCount = 0;

  constructor(private deps: SyncControllerDeps) {}

  private setStatus(status: SyncStatus): void {
    this._syncStatus = status;
    this._syncStatusCallback?.(status, this._lastSyncTime);
  }

  /** A session whose status reports reach the UI only while it is live. */
  private newSession(): RelaySession<SyncStatus> {
    return new RelaySession<SyncStatus>((status) => this.setStatus(status));
  }

  /**
   * Start a new attempt: the previous one (and any detached session) is
   * disposed FIRST — a second startSync (pairing over a live relay) leaves no
   * orphan timer, socket or continuation behind.
   */
  private beginAttempt(): RelayAttempt {
    this.endAttempts();
    this._generation++;
    const session = this.newSession();
    const attempt: RelayAttempt = {
      session,
      mint: session.token((aud?: TokenAudience) => this.deps.createSyncToken(aud)),
      // One task, one body: the relay hands a task to every serving body of
      // this identity and grants exactly one claim — run only on the grant.
      taskClaims: new TaskClaimCoordinator({
        send: (frame) => {
          if (session.live) attempt.ws?.sendRaw(frame);
        },
      }),
      url: null,
      registered: false,
      registrationError: null,
      registrationDelay: REGISTRATION_RETRY_BASE_MS,
      syncEngine: null,
      conversationSyncEngine: null,
      encKey: null,
      ws: null,
      wsUnsub: null,
      serving: false,
      servingUrl: null,
      servingAuthToken: null,
    };
    session.own(() => {
      attempt.taskClaims.dispose();
      attempt.wsUnsub?.();
      attempt.wsUnsub = null;
      attempt.ws?.disconnect();
      attempt.ws = null;
      attempt.syncEngine?.stop();
      attempt.conversationSyncEngine?.stop();
      attempt.syncEngine = null;
      attempt.conversationSyncEngine = null;
      attempt.encKey = null;
      // Drop every live relay handle: discovery/serving coordinates, the
      // runtime's interactive delegation (delegate_to_agent & co.) and the
      // PlanEngine delegation adapter. The next attempt rewires them.
      attempt.serving = false;
      attempt.servingUrl = null;
      attempt.servingAuthToken = null;
      this.dropDelegation();
    });
    this.attempt = attempt;
    return attempt;
  }

  /** Dispose the attempt and every detached session, synchronously. */
  private endAttempts(): void {
    const attempt = this.attempt;
    this.attempt = null;
    attempt?.session.dispose();
    for (const session of this.detached) session.dispose();
    this.detached.clear();
  }

  private dropDelegation(): void {
    const runtime = this.deps.getRuntime();
    runtime?.disableInteractiveDelegation();
    runtime?.setDelegationAdapter(undefined);
  }

  /**
   * This device's sync encryption key, derived now from the identity key
   * (a `syncNow` before `startSync`). Mobile always holds a device key, so
   * every event push is E2E — there is no raw path (#928).
   */
  private async deriveEncKey(): Promise<Uint8Array> {
    const privKeyBytes = await this.deps.getPrivKeyBytes();
    try {
      return await deriveSyncEncryptionKey(privKeyBytes);
    } finally {
      secureErase(privKeyBytes);
    }
  }

  /**
   * A fresh `sync` token per request (#927), minted through the session:
   * never a value captured once and carried past its five-minute life, and
   * never minted once the session is disposed.
   */
  private sessionCredentials(mint: (aud?: TokenAudience) => Promise<string>): CredentialSource {
    return { getCredential: () => mint() };
  }

  /**
   * The ONE event transport to the relay (#928): an HTTP adapter that
   * refuses any payload that is not an E2E envelope, under the encrypting
   * wrapper. `syncNow` pushed through a bare `HttpEventStoreAdapter`, so its
   * events reached the relay in plaintext; both push doors now come from here.
   */
  private e2eHttpEventStore(
    session: RelaySession<SyncStatus>,
    syncUrl: string,
    motebitId: string,
    encKey: Uint8Array,
    credentialSource: CredentialSource,
  ): EncryptedEventStoreAdapter {
    const http = new HttpEventStoreAdapter({
      baseUrl: syncUrl,
      motebitId,
      credentialSource,
      fetch: session.fetch,
      payloads: "e2e",
    });
    return new EncryptedEventStoreAdapter({ inner: http, key: encKey });
  }

  /** A failed catch-up is shown in the sync status, never swallowed (#927). */
  private reportCatchUpError(session: RelaySession<SyncStatus>, err: unknown): void {
    if (!session.live) return;
    // eslint-disable-next-line no-console -- the status carries no message; the log says why
    console.warn(`[sync] catch-up failed: ${err instanceof Error ? err.message : String(err)}`);
    session.status("error");
  }

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
    return this.attempt?.syncEngine != null;
  }

  /**
   * Bumped by every startSync and stopSync: a caller that started an attempt
   * can tell whether a newer start or an OFF superseded it before reading the
   * shared `syncStatus` (relay-optin's rollback).
   */
  get relayGeneration(): number {
    return this._generation;
  }

  onSyncStatus(callback: (status: SyncStatus, lastSync: number) => void): void {
    this._syncStatusCallback = callback;
  }

  async startServing(): Promise<{ ok: boolean; error?: string }> {
    // Mobile is non-executing today (serving-gate.ts) — refuse before any
    // registration, so the relay never routes a delegation to this device.
    if (!mobileServingAllowed()) return { ok: false, error: MOBILE_SERVING_UNAVAILABLE };
    const runtime = this.deps.getRuntime();
    const attempt = this.attempt;
    if (!runtime || !attempt?.servingUrl || !attempt.servingAuthToken) {
      return { ok: false, error: "Sync not connected" };
    }
    if (attempt.serving) return { ok: true };

    // What this surface offers other principals is derived from each
    // tool's own `localOnly` declaration (#874) — one rule for every
    // surface, never a per-surface name list that can forget a tool.
    const capabilities = servedToolNames(runtime.getToolRegistry().list());

    try {
      // Registration is the agent-registry family: `admin:query`. The cached
      // `sync` token was refused, so `/serve` never registered (#827).
      const registerToken = await attempt.mint("admin:query");
      const res = await attempt.session.fetch(`${attempt.servingUrl}/api/v1/agents/register`, {
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
      attempt.serving = true;
      return { ok: true };
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  stopServing(): void {
    if (this.attempt) this.attempt.serving = false;
  }

  isServing(): boolean {
    return this.attempt?.serving ?? false;
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
    const attempt = this.attempt;
    if (!attempt?.servingUrl || !attempt.servingAuthToken) return [];
    try {
      const res = await attempt.session.fetch(`${attempt.servingUrl}/api/v1/agents/discover`, {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${attempt.servingAuthToken}`,
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
   * read "idle". Idempotent on the relay side. Aborted by the session's
   * dispose; throws `RelaySessionDisposedError` once the session ended.
   */
  private async registerDevice(
    attempt: RelayAttempt,
    url: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const { session } = attempt;
    let privKeyBytes: Uint8Array;
    try {
      privKeyBytes = await this.deps.getPrivKeyBytes();
    } catch (err: unknown) {
      session.assertLive();
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    // Bounded: a black-holed network resolves as a refusal (and the
    // Settings switch re-enables) instead of hanging the opt-in. The
    // session's dispose aborts it too.
    const abort = new AbortController();
    const onDispose = (): void => abort.abort();
    session.signal.addEventListener("abort", onDispose);
    const cancelTimeout = session.setTimeout(() => abort.abort(), REGISTRATION_TIMEOUT_MS);
    try {
      session.assertLive();
      const res = await registerDeviceWithRelay({
        motebitId: this.deps.getMotebitId(),
        deviceId: this.deps.getDeviceId(),
        publicKey: this.deps.getPublicKey(),
        privateKey: privKeyBytes,
        syncUrl: url,
        deviceName: "Mobile",
        signal: abort.signal,
      });
      session.assertLive();
      return res.ok ? { ok: true } : { ok: false, error: `${res.code}: ${res.message}` };
    } catch (err: unknown) {
      session.assertLive();
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      cancelTimeout();
      session.signal.removeEventListener("abort", onDispose);
      secureErase(privKeyBytes);
    }
  }

  /**
   * One registration attempt; on a refusal the status goes to "error" and
   * the next attempt is scheduled on backoff (1 s doubling to 60 s) on the
   * session's own timer, until the relay accepts or the session ends.
   */
  private async attemptRegistration(attempt: RelayAttempt, url: string): Promise<void> {
    const { session } = attempt;
    const result = await this.registerDevice(attempt, url);
    if (result.ok) {
      attempt.registered = true;
      attempt.registrationError = null;
      this.onDeviceAccepted(attempt, url);
      return;
    }
    attempt.registrationError = result.error;
    // eslint-disable-next-line no-console -- the status carries no message; the log says why
    console.warn(`[sync] relay did not accept this device: ${result.error}`);
    session.status("error");
    const delay = attempt.registrationDelay;
    attempt.registrationDelay = Math.min(delay * 2, REGISTRATION_RETRY_MAX_MS);
    session.setTimeout(() => {
      void this.attemptRegistration(attempt, url).catch(ignoreDisposed);
    }, delay);
  }

  /**
   * The relay accepted this device (once per attempt): only now register
   * the push token (which may prompt for notification permission) and run
   * the onboarding self-test — a relay that refused the device, or an
   * opt-in rolled back, prompts for nothing. Both run under the session.
   */
  private onDeviceAccepted(attempt: RelayAttempt, url: string): void {
    const { session } = attempt;
    void this.deps.registerPushToken(url, session);
    this.deps.startPushLifecycle(session);
    session.own(() => this.deps.stopPushLifecycle());
    // Adversarial onboarding: run self-test once after first relay connection
    void this.runOnboardingSelfTest(attempt, url);
  }

  async startSync(syncUrl?: string): Promise<void> {
    const attempt = this.beginAttempt();
    const { session } = attempt;
    try {
      const url =
        syncUrl != null && syncUrl !== "" ? syncUrl : await session.run(() => this.getSyncUrl());
      const storage = this.deps.getStorage();
      if (url == null || url === "" || !storage) {
        if (this.attempt === attempt) this.endAttempts();
        return;
      }
      attempt.url = url;
      await session.run(() => this.setSyncUrl(url));
      const motebitId = this.deps.getMotebitId();

      // Registration is attempted BEFORE the socket connects and before the
      // first push (#962); a refusal keeps retrying on backoff.
      await this.attemptRegistration(attempt, url);

      // Derive encryption key once for the attempt, then erase raw key bytes
      const syncEncKey = await this.deriveEncKey();
      session.assertLive();
      attempt.encKey = syncEncKey;

      // Create engines (they don't start their own timers — the session owns
      // the interval so the auth token is refreshed each cycle)
      attempt.syncEngine = new SyncEngine(storage.eventStore, motebitId, {
        sync_interval_ms: SYNC_INTERVAL_MS,
      });
      attempt.conversationSyncEngine = new ConversationSyncEngine(
        storage.conversationSyncStore,
        motebitId,
        { sync_interval_ms: SYNC_INTERVAL_MS },
      );

      if (attempt.registered) session.status("idle");

      session.setInterval(() => void this.syncCycle(attempt), SYNC_INTERVAL_MS);
      // Immediate first sync after short delay (let initialization settle)
      session.setTimeout(() => void this.syncCycle(attempt), 3000);

      // Push registration (wake-on-demand) and the onboarding self-test fire
      // from onDeviceAccepted, once the relay has accepted the device.
    } catch (err: unknown) {
      // OFF or a newer start ended this attempt: it has nothing left to undo.
      if (isRelaySessionDisposed(err)) return;
      throw err;
    }
  }

  /**
   * Run cmdSelfTest exactly once per device. Uses AsyncStorage flag to avoid
   * repeating on subsequent launches. Best-effort — failures are logged, never
   * blocking. Its tokens are minted through the session, so a self-test the
   * session outlived submits nothing.
   */
  private async runOnboardingSelfTest(attempt: RelayAttempt, syncUrl: string): Promise<void> {
    const FLAG = "motebit:self-test-done";
    const { session } = attempt;
    try {
      const done = await session.run(() => AsyncStorage.getItem(FLAG));
      if (done === "true") return;
    } catch (err: unknown) {
      if (isRelaySessionDisposed(err)) return;
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
      const token = await attempt.mint("task:submit");
      if (!token) return;

      const result = await session.run(() =>
        cmdSelfTest(runtime, {
          relay: { relayUrl: syncUrl, authToken: token, motebitId: this.deps.getMotebitId() },
          // Honor the requested audience (task:submit to submit, task:query to
          // poll) — the relay enforces aud binding (auth-token-v1 §5). Minting a
          // task:submit token for the /task/:id poll would 403 (audience
          // mismatch) if this surface ever served at onboarding. Matches web.
          mintToken: (audience: TokenAudience) => attempt.mint(audience),
          // Serving is opt-in; at onboarding the agent is not a worker, so the
          // completion poll could only time out. `auth_verified` (the security
          // pass) terminates immediately and sets the done-flag below.
          serving: attempt.serving,
          timeoutMs: 30_000,
          // The submission (and any poll) rides the session: OFF aborts it on the wire.
          fetch: session.fetch,
        }),
      );

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
      if (isRelaySessionDisposed(err)) return;
      // eslint-disable-next-line no-console
      console.warn("[self-test] error:", err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Stop sync. The session is disposed FIRST and synchronously — every timer
   * cancelled, the socket closed, in-flight fetches aborted, delegation and
   * the push lifecycle stopped — so nothing it started can act afterwards.
   */
  stopSync(): void {
    this._generation++;
    this.endAttempts();
    // Idempotent: also when no attempt was ever started.
    this.dropDelegation();
    this.deps.stopPushLifecycle();
    this.setStatus("offline");
  }

  /**
   * Relay OFF. Dispose the session first (stopSync), with the relay URL
   * captured beforehand; clear the saved URL so the next launch stays
   * offline; then unregister the push token with the captured URL — bounded
   * and fail-soft, so an unreachable relay never blocks OFF. Nothing the
   * session started can re-register the token after this DELETE: it could
   * only post through the disposed session.
   */
  async disconnectSync(): Promise<void> {
    const capturedUrl = this.attempt?.url ?? null;
    this.stopSync();
    const generation = this._generation;
    const url = capturedUrl ?? (await this.getSyncUrl());
    // A newer startSync (relay re-enabled meanwhile) owns the saved URL.
    if (this._generation === generation) await this.clearSyncUrl();
    if (url == null || url === "") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.deps.removePushToken(url),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, PUSH_UNREGISTER_TIMEOUT_MS);
        }),
      ]);
    } catch (err: unknown) {
      // eslint-disable-next-line no-console -- fail-soft: OFF proceeds, the log says why
      console.warn(
        "[sync] push-token unregister failed:",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * One user-requested sync round, under the live attempt's session (or a
   * detached one before startSync, which OFF also disposes). Rejects when
   * the relay was turned off mid-round; reports nothing after OFF.
   */
  async syncNow(): Promise<{
    events_pushed: number;
    events_pulled: number;
    conversations_pushed: number;
    conversations_pulled: number;
  }> {
    const attempt = this.attempt?.session.live === true ? this.attempt : null;
    const session = attempt?.session ?? this.newSession();
    if (!attempt) this.detached.add(session);
    try {
      return await this.syncNowIn(session, attempt);
    } catch (err: unknown) {
      if (isRelaySessionDisposed(err)) {
        throw new Error("Relay sync stopped: the relay was turned off", { cause: err });
      }
      throw err;
    } finally {
      if (!attempt) {
        session.dispose();
        this.detached.delete(session);
      }
    }
  }

  private async syncNowIn(
    session: RelaySession<SyncStatus>,
    attempt: RelayAttempt | null,
  ): Promise<{
    events_pushed: number;
    events_pulled: number;
    conversations_pushed: number;
    conversations_pulled: number;
  }> {
    const url = await session.run(() => this.getSyncUrl());
    const storage = this.deps.getStorage();
    if (url == null || url === "" || !storage) throw new Error("No sync relay configured");
    const motebitId = this.deps.getMotebitId();
    const mint =
      attempt?.mint ?? session.token((aud?: TokenAudience) => this.deps.createSyncToken(aud));

    // Fail before any work when the relay cannot mint (or OFF came first).
    await mint();
    const encKey = attempt?.encKey ?? (await session.run(() => this.deriveEncKey()));
    const credentials = this.sessionCredentials(mint);

    // Event sync — E2E, the same transport the sync cycle uses (#928).
    const tempEventSync = new SyncEngine(storage.eventStore, motebitId);
    tempEventSync.connectRemote(
      session.guard(this.e2eHttpEventStore(session, url, motebitId, encKey, credentials)),
    );
    const eventResult = await session.run(() => tempEventSync.sync());
    // `sync()` never rejects: a refused or failed push is recorded, not
    // thrown. /sync must never toast "Synced" over it (#962).
    const eventError = tempEventSync.getLastError();
    if (eventError) {
      session.status("error");
      throw new Error(`event sync failed: ${eventError.message}`, { cause: eventError });
    }

    // Conversation sync (encrypted — relay stores opaque ciphertext)
    const convHttpAdapter = new HttpConversationSyncAdapter({
      baseUrl: url,
      motebitId,
      credentialSource: credentials,
      fetch: session.fetch,
    });
    const tempConvSync = new ConversationSyncEngine(storage.conversationSyncStore, motebitId);
    tempConvSync.connectRemote(
      session.guard(new EncryptedConversationSyncAdapter({ inner: convHttpAdapter, key: encKey })),
    );
    const convResult = await session.run(() => tempConvSync.sync());

    this._lastSyncTime = Date.now();
    session.status("idle");

    return {
      events_pushed: eventResult.pushed,
      events_pulled: eventResult.pulled,
      conversations_pushed: convResult.conversations_pushed,
      conversations_pulled: convResult.conversations_pulled,
    };
  }

  /** One sync round for `attempt`, entirely through its session. */
  private async syncCycle(attempt: RelayAttempt): Promise<void> {
    const { session } = attempt;
    const syncUrl = attempt.url;
    const syncEngine = attempt.syncEngine;
    const conversationSyncEngine = attempt.conversationSyncEngine;
    if (!session.live || syncUrl == null || !syncEngine || !conversationSyncEngine) return;
    const storage = this.deps.getStorage();
    if (!storage) return;
    const motebitId = this.deps.getMotebitId();

    session.status("syncing");

    try {
      const token = await attempt.mint();
      const encKey = attempt.encKey;

      // Tear down previous WS connection (token expired)
      attempt.wsUnsub?.();
      attempt.wsUnsub = null;
      attempt.ws?.disconnect();
      attempt.ws = null;

      // Fail closed (#928): without the sync key there is no event sync at
      // all — never a raw fallback that pushes plaintext. startSync sets the
      // key together with the engines, so this is a broken session.
      if (!encKey)
        throw new Error("sync: no sync encryption key — refusing a plaintext event push");
      // Build adapter stack with encryption — every adapter session-guarded,
      // every credential session-minted.
      const credentials = this.sessionCredentials(attempt.mint);
      const encryptedHttp = session.guard(
        this.e2eHttpEventStore(session, syncUrl, motebitId, encKey, credentials),
      );
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
        credentialSource: credentials,
        capabilities: mobileCapabilities,
        httpFallback: encryptedHttp,
        localStore: localEventStore ?? undefined,
        payloads: "e2e",
        onCatchUpError: (err: unknown) => this.reportCatchUpError(session, err),
      });
      attempt.ws = wsAdapter;

      const encryptedWs = session.guard(
        new EncryptedEventStoreAdapter({ inner: wsAdapter, key: encKey }),
      );

      // Inbound real-time events
      attempt.wsUnsub = wsAdapter.onEvent((raw) => {
        if (!session.live) return;
        void (async () => {
          if (!localEventStore) return;
          const dec = await decryptEventPayload(raw, encKey);
          if (!session.live) return;
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
          authToken: (audience: TokenAudience) => attempt.mint(audience),
          fetch: session.fetch,
          sendRaw: (data: string) => {
            if (session.live) wsAdapter.sendRaw(data);
          },
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
        const pinnedRelayKey = await session.run(() =>
          getOrPinRelayKey(syncUrl, {
            storage: {
              getItem: (k) => AsyncStorage.getItem(k),
              setItem: (k, v) => AsyncStorage.setItem(k, v),
            },
            fetchImpl: session.fetch,
          }),
        );
        runtime.enableInteractiveDelegation({
          syncUrl,
          // Honor the audience the runtime asks for — `task:submit` to
          // submit, `task:query` to poll, `market:listing` for the P2P
          // pre-flight. A closure that ignored it sent `task:submit` to all
          // three, and the poll and pre-flight were refused (#827).
          authToken: (audience?: TokenAudience) => attempt.mint(audience ?? "task:submit"),
          ...(pinnedRelayKey != null ? { relayPublicKey: pinnedRelayKey } : {}),
          // Forward the cold-start opt-in as a LIVE getter (reads the in-memory
          // mirror of MobileSettings.coldStartOptIn) so the Governance toggle
          // governs chat-driven (delegate_to_agent) P2P delegation, not just a
          // re-enable — parity with the web fix (d6cab601).
          acknowledgeNoHistoryRisk: () => loadColdStartOptIn(),
        });

        // Store serving state
        attempt.servingUrl = syncUrl;
        attempt.servingAuthToken = token ?? null;

        // Wire task handler — accept delegations while the app is open.
        wsAdapter.onCustomMessage((msg) => this.onRelayFrame(attempt, msg, motebitId));
      }

      syncEngine.connectRemote(encryptedWs);
      wsAdapter.connect();

      // Recover any delegated steps orphaned by a previous app close; stops
      // with the session (its relay calls mint through the session).
      if (runtime) {
        void (async () => {
          try {
            for await (const _chunk of runtime.recoverDelegatedSteps()) {
              // Chunks consumed — state changes propagate through plan store
              if (!session.live) break;
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
        credentialSource: credentials,
        fetch: session.fetch,
      });
      conversationSyncEngine.connectRemote(
        session.guard(
          new EncryptedConversationSyncAdapter({ inner: convHttpAdapter, key: encKey }),
        ),
      );

      await session.run(() => syncEngine.sync());
      // `sync()` never rejects: a refused or failed push is recorded in
      // `getLastError()`. It ends this cycle in "error", never "idle" (#962).
      const eventError = syncEngine.getLastError();
      if (eventError) throw eventError;
      await session.run(() => conversationSyncEngine.sync());

      // Plan sync — push/pull plans for cross-device visibility
      if (storage.planStore != null) {
        try {
          const planSyncStore = new ExpoPlanSyncStoreAdapter(storage.planStore, motebitId);
          const planSync = new PlanSyncEngine(planSyncStore, motebitId);
          const httpPlanAdapter = new HttpPlanSyncAdapter({
            baseUrl: syncUrl,
            motebitId,
            credentialSource: credentials,
            fetch: session.fetch,
          });
          planSync.connectRemote(
            session.guard(new EncryptedPlanSyncAdapter({ inner: httpPlanAdapter, key: encKey })),
          );
          await session.run(() => planSync.sync());
        } catch (err: unknown) {
          // Plan sync failure shouldn't break the sync cycle — OFF does.
          if (isRelaySessionDisposed(err)) throw err;
        }
      }

      // The relay has not accepted this device: nothing it sent was taken.
      if (!attempt.registered) {
        throw new Error(
          `relay has not accepted this device${attempt.registrationError ? `: ${attempt.registrationError}` : ""}`,
        );
      }
      this._lastSyncTime = Date.now();
      session.status("idle");
    } catch {
      // A disposed session reports nothing (status is a no-op once disposed).
      session.status("error");
    }
  }

  /** A relay frame on `attempt`'s socket: replies only through that attempt, only while live. */
  private onRelayFrame(
    attempt: RelayAttempt,
    msg: { type: string; [key: string]: unknown },
    motebitId: string,
  ): void {
    const { session } = attempt;
    if (!session.live) return;
    if (attempt.taskClaims.handleFrame(msg)) return;
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
      const reply = (result: unknown): void => {
        if (!session.live) return;
        attempt.ws?.sendRaw(JSON.stringify({ type: "command_response", id: cmdMsg.id, result }));
      };
      void (async () => {
        try {
          const verdict = await session.run(() =>
            verifyAgentCommandEnvelope({
              envelope: cmdMsg.envelope,
              command: cmdMsg.command,
              args: cmdMsg.args,
              motebitId: this.deps.getMotebitId(),
              identityPublicKey: this.deps.getPublicKey(),
            }),
          );
          if (!verdict.ok) {
            reply({ summary: verdict.reason });
            return;
          }
          // The one door for a relay frame.
          const result = await session.run(() =>
            executeRemoteCommand(rt, cmdMsg.command, cmdMsg.args),
          );
          reply(result);
        } catch (err: unknown) {
          if (isRelaySessionDisposed(err)) return;
          reply({ summary: `Error: ${err instanceof Error ? err.message : String(err)}` });
        }
      })();
      return;
    }

    if (msg.type !== "task_request" || msg.task == null) return;
    // The single execution gate (serving-gate.ts): off by default, and
    // `/serve` cannot turn it on.
    if (!canExecuteDelegatedTask(attempt.serving)) return;
    if (!rt) return;

    const task = msg.task as AgentTask;
    const runtimeRef = rt;

    // Claim the task; execute only on the relay's grant — another body
    // of this identity may hold it.
    attempt.taskClaims.offer(task.task_id, async () => {
      this._activeTaskCount++;
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

        if (receipt && attempt.servingUrl) {
          // The result route verifies `task:result` (#827).
          const freshToken = await attempt.mint("task:result");
          await session.fetch(
            `${attempt.servingUrl}/agent/${motebitId}/task/${task.task_id}/result`,
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
        // Task execution failed (or the session ended)
      } finally {
        this._activeTaskCount = Math.max(0, this._activeTaskCount - 1);
      }
    });
  }
}

/** A detached continuation that the session outlived ends quietly; anything else is logged. */
function ignoreDisposed(err: unknown): void {
  if (isRelaySessionDisposed(err)) return;
  // eslint-disable-next-line no-console -- a background relay step failed; the log says why
  console.warn("[sync]", err instanceof Error ? err.message : String(err));
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
