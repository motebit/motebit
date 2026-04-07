/**
 * @motebit/desktop — Tauri app (Rust + webview)
 *
 * Thin platform shell around MotebitRuntime.
 * Provides Tauri-specific storage adapters and AI provider creation.
 */

import {
  MotebitRuntime,
  executeCommand,
  ProxySession,
  cmdSelfTest,
  PLANNING_TASK_ROUTER,
} from "@motebit/runtime";
import type { ProxyProviderConfig, ProxySessionAdapter } from "@motebit/runtime";
import type {
  TurnResult,
  StorageAdapters,
  StreamChunk,
  OperatorModeResult,
  InteriorColor,
  McpServerConfig,
  PolicyConfig,
  MemoryGovernanceConfig,
} from "@motebit/runtime";
import { ThreeJSAdapter } from "@motebit/render-engine";
import {
  AnthropicProvider,
  OpenAIProvider,
  detectLocalInference,
  resolveConfig,
  DEFAULT_OLLAMA_URL,
  type MotebitPersonalityConfig,
} from "@motebit/ai-core";
export type { LocalInferenceDetectionResult, OllamaDetectionResult } from "@motebit/ai-core";
import type { MemoryNode, MemoryEdge, AgentTask, ExecutionReceipt } from "@motebit/sdk";
import {
  EventType,
  DeviceCapability,
  resolveProviderSpec,
  UnsupportedBackendError,
  APPROVAL_PRESET_CONFIGS,
  DEFAULT_GOVERNANCE_CONFIG,
  DEFAULT_MOTEBIT_CLOUD_URL,
  type GovernanceConfig,
  type AppearanceConfig,
} from "@motebit/sdk";
import type { UnifiedProviderConfig, ProviderSpec, ResolverEnv } from "@motebit/sdk";
import { InMemoryEventStore, type EventStoreAdapter } from "@motebit/event-log";
import { InMemoryMemoryStorage } from "@motebit/memory-graph";
import { InMemoryIdentityStorage } from "@motebit/core-identity";
import { InMemoryAuditLog } from "@motebit/privacy-layer";
import { deriveSyncEncryptionKey, secureErase } from "@motebit/crypto";
import { parse as parseIdentityFile, governanceToPolicyConfig } from "@motebit/identity-file";
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
import type { PairingSession, PairingStatus, SyncStatus } from "@motebit/sync-engine";
import { PlanEngine, InMemoryPlanStore } from "@motebit/planner";
import type { PlanChunk, PlanStoreAdapter } from "@motebit/planner";
import { PlanStatus } from "@motebit/sdk";
import {
  TauriEventStore,
  TauriMemoryStorage,
  TauriIdentityStorage,
  TauriAuditLog,
  TauriStateSnapshotStorage,
  TauriConversationStore,
  TauriPlanStore,
  TauriGradientStore,
  TauriAgentTrustStore,
  TauriServiceListingStore,
  TauriBudgetAllocationStore,
  TauriSettlementStore,
  TauriLatencyStatsStore,
  TauriCredentialStore,
  TauriApprovalStore,
  type InvokeFn,
} from "./tauri-storage.js";
import { TauriKeyringAdapter, TauriToolAuditSink } from "./tauri-system-adapters.js";
import {
  TauriConversationSyncStoreAdapter,
  TauriPlanSyncStoreAdapter,
} from "./tauri-sync-adapters.js";
import * as memoryCommands from "./memory-commands.js";
import * as rendererCommands from "./renderer-commands.js";
import { IdentityManager } from "./identity-manager.js";
import { McpManager } from "./mcp-manager.js";
import { registerDesktopTools } from "./desktop-tools.js";
import {
  createSubGoalDefinition,
  completeGoalDefinition,
  reportProgressDefinition,
} from "@motebit/tools/web-safe";
export type { InvokeFn } from "./tauri-storage.js";

// Re-export runtime types for main.ts consumption
export type {
  TurnResult,
  StreamChunk,
  OperatorModeResult,
  InteriorColor,
  McpServerConfig,
  PolicyConfig,
  MemoryGovernanceConfig,
};
export type { PairingSession, PairingStatus };
export type { MemoryNode, MemoryEdge };
export type { DeletionCertificate } from "@motebit/crypto";

// === Sync Status ===

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

export interface GoalCompleteEvent {
  goalId: string;
  prompt: string;
  status: "completed" | "failed";
  summary: string | null;
  error: string | null;
  /** Plan title if the goal used plan-based execution. */
  planTitle?: string;
  /** Number of plan steps completed. */
  stepsCompleted?: number;
  /** Total plan steps. */
  totalSteps?: number;
}

/** Maximum tool calls across all turns in a single goal run (default 50). */
const MAX_TOOL_CALLS_PER_RUN = 50;

export interface GoalPlanProgressEvent {
  goalId: string;
  planTitle: string;
  stepIndex: number;
  totalSteps: number;
  stepDescription: string;
  type: "plan_created" | "step_started" | "step_completed" | "step_failed";
}

export interface GoalApprovalEvent {
  goalId: string;
  goalPrompt: string;
  toolName: string;
  args: Record<string, unknown>;
  riskLevel?: number;
}

// === Tauri Command Interface ===

export interface TauriCommands {
  db_query(sql: string, params: unknown[]): Promise<unknown[]>;
  db_execute(sql: string, params: unknown[]): Promise<number>;
  keyring_get(key: string): Promise<string | null>;
  keyring_set(key: string, value: string): Promise<void>;
  keyring_delete(key: string): Promise<void>;
  read_config(): Promise<string>;
  write_config(json: string): Promise<void>;
  read_file_tool(path: string): Promise<string>;
  write_file_tool(path: string, content: string): Promise<string>;
  shell_exec_tool(
    command: string,
    cwd: string | null,
  ): Promise<{ stdout: string; stderr: string; exit_code: number }>;
  transcribe_audio(audio_base64: string, api_key: string | null): Promise<string>;
}

// === Desktop AI Config ===

/**
 * Desktop provider union — flat shape driving the settings dropdown.
 * Maps onto the three-mode architecture in `@motebit/sdk`:
 *   motebit-cloud → "proxy"
 *   byok          → "anthropic" | "openai" | "google"
 *   on-device     → "local-server"  (Ollama, LM Studio, llama.cpp, etc.)
 *
 * The historical value `"ollama"` was renamed to `"local-server"` for vendor
 * neutrality. `loadDesktopConfig` migrates persisted Tauri config values
 * transparently so existing installs continue to work.
 */
export type DesktopProvider = "anthropic" | "local-server" | "openai" | "google" | "proxy";

export interface DesktopAIConfig {
  provider: DesktopProvider;
  model?: string;
  apiKey?: string;
  /**
   * Local inference server URL (Ollama, LM Studio, llama.cpp, Jan, vLLM, …).
   * Defaults to `DEFAULT_OLLAMA_URL` (http://127.0.0.1:11434). Users running
   * the server on a LAN machine can point at that host here. Persisted as
   * `local_server_endpoint` in the Tauri JSON config; the historical key
   * `ollama_endpoint` is still accepted on load for migration.
   */
  localServerEndpoint?: string;
  personalityConfig?: MotebitPersonalityConfig;
  isTauri: boolean;
  maxTokens?: number;
  invoke?: InvokeFn;
  syncUrl?: string;
  syncMasterToken?: string;
  /**
   * Canonical governance config. Single source of truth for approval preset,
   * memory persistence threshold, secret rejection, and per-turn budget caps.
   * Missing fields fall back to `DEFAULT_GOVERNANCE_CONFIG` at initAI time.
   */
  governance?: GovernanceConfig;
  /**
   * Canonical appearance config. Single source of truth for color preset,
   * custom hue/saturation, and theme. Missing fields fall back to
   * `DEFAULT_APPEARANCE_CONFIG` at hydration time. Loaded from the
   * canonical `appearance` JSON key OR legacy `interior_color_preset` +
   * `custom_soul_color` keys via `parseAppearanceFromConfig`.
   */
  appearance?: AppearanceConfig;
}

// === Provider unification + spec mapping ===

/**
 * Map a desktop flat `DesktopAIConfig` to the unified shape the SDK resolver
 * speaks. Hybrid is excluded — it's a composite that doesn't reduce to a
 * single ProviderSpec and is built directly in `initAI`.
 *
 * The field `localServerEndpoint` on `DesktopAIConfig` maps to the unified
 * `endpoint` for on-device local-server. The resolver then normalizes the
 * URL and dispatches to the OpenAI-compat shim every supported local server
 * exposes.
 */
function desktopConfigToUnified(config: DesktopAIConfig): UnifiedProviderConfig {
  switch (config.provider) {
    case "local-server":
      return {
        mode: "on-device",
        backend: "local-server",
        model: config.model,
        endpoint: config.localServerEndpoint,
        maxTokens: config.maxTokens,
      };
    case "anthropic":
      return {
        mode: "byok",
        vendor: "anthropic",
        apiKey: config.apiKey ?? "",
        model: config.model,
        maxTokens: config.maxTokens,
      };
    case "openai":
      return {
        mode: "byok",
        vendor: "openai",
        apiKey: config.apiKey ?? "",
        model: config.model,
        maxTokens: config.maxTokens,
      };
    case "google":
      return {
        mode: "byok",
        vendor: "google",
        apiKey: config.apiKey ?? "",
        model: config.model,
        maxTokens: config.maxTokens,
      };
    case "proxy":
      return {
        mode: "motebit-cloud",
        model: config.model,
        maxTokens: config.maxTokens,
      };
  }
}

/**
 * Map a resolved `ProviderSpec` to a desktop-side concrete provider instance.
 * Desktop only supports cloud and ollama transports — apple-fm/mlx/webllm
 * are gated by `supportedBackends` in the env, so reaching them here is a
 * misconfiguration.
 *
 * `temperature` is a desktop-side concern (pulled from `personalityConfig`)
 * and is merged with the spec's value, with the spec winning when set.
 */
function desktopSpecToProvider(
  spec: ProviderSpec,
  temperature: number | undefined,
): AnthropicProvider | OpenAIProvider {
  switch (spec.kind) {
    case "cloud":
      // Cloud kind dispatches on wireProtocol: anthropic → AnthropicProvider,
      // openai → OpenAIProvider (used for BYOK OpenAI/Google and local-server
      // inference via the OpenAI-compat shim).
      if (spec.wireProtocol === "openai") {
        return new OpenAIProvider({
          api_key: spec.apiKey,
          model: spec.model,
          base_url: spec.baseUrl,
          max_tokens: spec.maxTokens,
          temperature: spec.temperature ?? temperature,
          extra_headers: spec.extraHeaders,
        });
      }
      return new AnthropicProvider({
        api_key: spec.apiKey,
        model: spec.model,
        base_url: spec.baseUrl,
        max_tokens: spec.maxTokens,
        temperature: spec.temperature ?? temperature,
        extra_headers: spec.extraHeaders,
      });
    case "webllm":
    case "apple-fm":
    case "mlx":
      throw new UnsupportedBackendError(spec.kind);
  }
}

// === Storage Factory ===

export function createTauriStorage(
  invoke: InvokeFn,
  stateSnapshot?: TauriStateSnapshotStorage,
  conversationStore?: TauriConversationStore,
): StorageAdapters {
  return {
    eventStore: new TauriEventStore(invoke),
    memoryStorage: new TauriMemoryStorage(invoke),
    identityStorage: new TauriIdentityStorage(invoke),
    auditLog: new TauriAuditLog(invoke),
    toolAuditSink: new TauriToolAuditSink(invoke),
    stateSnapshot,
    conversationStore,
    agentTrustStore: new TauriAgentTrustStore(invoke),
    planStore: new TauriPlanStore(invoke),
    gradientStore: new TauriGradientStore(invoke),
    serviceListingStore: new TauriServiceListingStore(invoke),
    budgetAllocationStore: new TauriBudgetAllocationStore(invoke),
    settlementStore: new TauriSettlementStore(invoke),
    latencyStatsStore: new TauriLatencyStatsStore(invoke),
    credentialStore: new TauriCredentialStore(invoke),
    approvalStore: new TauriApprovalStore(invoke),
  };
}

function createDesktopStorage(
  config: DesktopAIConfig,
  stateSnapshot?: TauriStateSnapshotStorage,
  conversationStore?: TauriConversationStore,
): StorageAdapters {
  if (config.isTauri && config.invoke) {
    return createTauriStorage(config.invoke, stateSnapshot, conversationStore);
  }
  return {
    eventStore: new InMemoryEventStore(),
    memoryStorage: new InMemoryMemoryStorage(),
    identityStorage: new InMemoryIdentityStorage(),
    auditLog: new InMemoryAuditLog(),
  };
}

// === Color Presets ===
// Defined in `./color-presets.ts` so renderer-commands can import them
// without taking a dep on this index file. Re-exported here for backwards
// compat with every external consumer that still does
// `import { COLOR_PRESETS } from "@motebit/desktop"` (or the relative
// equivalent inside the desktop surface).
export { COLOR_PRESETS } from "./color-presets.js";

// === MCP Server Status ===
// Interface lives alongside the MCP manager in `./mcp-manager.ts`.
// Imported into local scope so DesktopApp's MCP delegate methods can
// use it as a return type, and re-exported so every existing consumer
// that imported it from `@motebit/desktop` (or the relative equivalent)
// keeps working.
import type { McpServerStatus } from "./mcp-manager.js";
export type { McpServerStatus };

// === Desktop App (platform shell) ===

export interface BootstrapResult {
  isFirstLaunch: boolean;
  motebitId: string;
  deviceId: string;
}

export type GovernanceStatus = { governed: true } | { governed: false; reason: string };

export class DesktopApp {
  private runtime: MotebitRuntime | null = null;
  private renderer: ThreeJSAdapter;
  /**
   * The MCP manager owns the mcpAdapters / mcpConfigs / mcpToolCounts
   * maps + the connect / disconnect / tool-dispatch lifecycle. It reads
   * the runtime lazily via a getter so DesktopApp can swap the runtime
   * without re-binding the manager.
   */
  private mcp = new McpManager(() => this.runtime);
  /**
   * The identity manager owns motebitId/deviceId/publicKey state + all
   * identity operations (bootstrap, key rotation, identity file, pairing).
   * The three public fields below are getters that read from it so every
   * existing `this.motebitId` / `this.deviceId` / `this.publicKey` read
   * in the rest of DesktopApp works unchanged.
   */
  private identity = new IdentityManager();
  get motebitId(): string {
    return this.identity.motebitId;
  }
  get deviceId(): string {
    return this.identity.deviceId;
  }
  get publicKey(): string {
    return this.identity.publicKey;
  }
  private _governanceStatus: GovernanceStatus = { governed: false, reason: "not initialized" };
  private goalSchedulerTimer: ReturnType<typeof setInterval> | null = null;
  private _goalExecuting = false;
  private _currentGoalId: string | null = null;
  private _goalStatusCallback: ((executing: boolean) => void) | null = null;
  private _goalCompleteCallback: ((event: GoalCompleteEvent) => void) | null = null;
  private _goalApprovalCallback: ((event: GoalApprovalEvent) => void) | null = null;
  private _goalPlanProgressCallback: ((event: GoalPlanProgressEvent) => void) | null = null;
  private _pendingGoalApproval: {
    goalId: string;
    prompt: string;
    invoke: InvokeFn;
    mode: string;
    planId?: string;
    runId?: string;
  } | null = null;
  private planEngine: PlanEngine | null = null;
  private planStoreRef: TauriPlanStore | PlanStoreAdapter | null = null;
  private conversationStoreRef: TauriConversationStore | null = null;
  private _autoTitlePending = false;
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
  private _localEventStore: EventStoreAdapter | null = null;
  private _serving = false;
  private _servingPrivateKey: Uint8Array | null = null;
  private _servingSyncUrl: string | null = null;
  private _servingAuthToken: string | null = null;
  private _activeTaskCount = 0;
  private _proxySession: ProxySession | null = null;
  private _proxyConfig: ProxyProviderConfig | null = null;

  constructor() {
    this.renderer = new ThreeJSAdapter();
  }

  // === Identity bootstrap + keypair + relay registration ===
  // Implementations live in `./identity-manager.ts`. The methods below
  // are one-line delegates that preserve the public DesktopApp API.

  bootstrap(invoke: InvokeFn): Promise<BootstrapResult> {
    return this.identity.bootstrap(invoke);
  }

  getDeviceKeypair(invoke: InvokeFn): Promise<{ publicKey: string; privateKey: string } | null> {
    return this.identity.getDeviceKeypair(invoke);
  }

  registerWithRelay(
    invoke: InvokeFn,
    syncUrl: string,
    masterToken: string,
  ): Promise<string | null> {
    return this.identity.registerWithRelay(invoke, syncUrl, masterToken);
  }

  createSyncToken(privateKeyHex: string, aud: string = "sync"): Promise<string> {
    return this.identity.createSyncToken(privateKeyHex, aud);
  }

  // === Renderer lifecycle ===
  // Pure render ops live in `./renderer-commands.ts`. The methods below
  // are one-line delegates that preserve the public DesktopApp API.
  // Lifecycle methods (start, stop) stay here because they coordinate the
  // runtime + renderer together.

  init(canvas: unknown): Promise<void> {
    return rendererCommands.initRenderer(this.renderer, canvas);
  }

  start(): void {
    this.runtime?.start();
  }

  stop(): void {
    this.runtime?.stop();
    this.renderer.dispose();
  }

  resize(width: number, height: number): void {
    rendererCommands.resizeRenderer(this.renderer, width, height);
  }

  renderFrame(deltaTime: number, time: number): void {
    rendererCommands.renderFrame(this.renderer, this.runtime, deltaTime, time);
  }

  // === AI Integration ===

  get isAIReady(): boolean {
    return this.runtime?.isAIReady ?? false;
  }

  get isProcessing(): boolean {
    return this.runtime?.isProcessing ?? false;
  }

  getRuntime(): MotebitRuntime | null {
    return this.runtime;
  }

  get currentModel(): string | null {
    return this.runtime?.currentModel ?? null;
  }

  /** The active provider type or null if not initialized. */
  private _activeProvider: DesktopProvider | null = null;

  get currentProvider(): DesktopProvider | null {
    return this._activeProvider;
  }

  /**
   * Detect a local Ollama instance. Never throws.
   * Times out after 2 seconds.
   */
  detectLocalInference(): ReturnType<typeof detectLocalInference> {
    return detectLocalInference();
  }

  setModel(model: string): void {
    if (!this.runtime) throw new Error("AI not initialized — call initAI() first");
    this.runtime.setModel(model);
  }

  /**
   * Attempt proxy bootstrap before requiring an API key.
   * Call after bootstrap() but before initAI(). If this returns true,
   * pass { provider: "proxy" } to initAI() — the token and model are stored internally.
   */
  async tryProxyBootstrap(invoke: InvokeFn): Promise<boolean> {
    const adapter: ProxySessionAdapter = {
      getSyncUrl: () => {
        // syncUrl is read synchronously from the last config read.
        // For the adapter, we cache it during bootstrap.
        return this._proxySyncUrlCache;
      },
      getMotebitId: () => {
        return this.motebitId !== "desktop-local" ? this.motebitId : null;
      },
      loadToken: () => {
        return this._proxyTokenCache;
      },
      saveToken: (data) => {
        this._proxyTokenCache = data;
        // Persist to Tauri config (best-effort, non-blocking)
        void invoke<string>("read_config")
          .then((raw) => {
            const config = { ...(JSON.parse(raw) as Record<string, unknown>), _proxy_token: data };
            return invoke<void>("write_config", { json: JSON.stringify(config) });
          })
          .catch(() => {});
      },
      clearToken: () => {
        this._proxyTokenCache = null;
        void invoke<string>("read_config")
          .then((raw) => {
            const config = JSON.parse(raw) as Record<string, unknown>;
            delete config._proxy_token;
            return invoke<void>("write_config", { json: JSON.stringify(config) });
          })
          .catch(() => {});
      },
      onProviderReady: (config: ProxyProviderConfig) => {
        this._proxyConfig = config;
      },
    };

    // Pre-load sync URL and cached token from Tauri config
    try {
      const raw = await invoke<string>("read_config");
      const configData = JSON.parse(raw) as Record<string, unknown>;
      this._proxySyncUrlCache = (configData.sync_url as string) ?? null;
      const cached = configData._proxy_token as
        | {
            token: string;
            balance: number;
            balanceUsd: number;
            expiresAt: number;
            motebitId: string;
          }
        | undefined;
      this._proxyTokenCache = cached ?? null;
    } catch {
      this._proxySyncUrlCache = null;
      this._proxyTokenCache = null;
    }

    this._proxySession = new ProxySession(adapter);
    return this._proxySession.bootstrap();
  }

  // Internal cache fields for proxy adapter (synchronous access required by ProxySessionAdapter)
  private _proxySyncUrlCache: string | null = null;
  private _proxyTokenCache: {
    token: string;
    balance: number;
    balanceUsd: number;
    expiresAt: number;
    motebitId: string;
  } | null = null;
  /** Dispose proxy session refresh timer. Call on app shutdown. */
  disposeProxySession(): void {
    this._proxySession?.dispose();
  }

  /**
   * Initialize AI, tools, governance, and state persistence.
   * Must be called after bootstrap() for Tauri builds (needs motebitId).
   * Returns false only if Anthropic provider is selected but no API key is provided.
   */
  async initAI(config: DesktopAIConfig): Promise<boolean> {
    const resolved = config.personalityConfig ? resolveConfig(config.personalityConfig) : undefined;
    const temperature = resolved?.temperature;

    // BYOK validation: surfaces decide whether they have credentials before
    // calling the resolver. The resolver assumes inputs are well-formed.
    const needsByokKey =
      config.provider === "anthropic" ||
      config.provider === "openai" ||
      config.provider === "google";
    if (needsByokKey && (config.apiKey == null || config.apiKey === "")) {
      return false;
    }

    // All providers go through the unified resolver. The desktop env captures
    // Tauri vs dev-mode URL routing: Tauri builds talk to vendor APIs directly;
    // dev builds go through Vite's proxy routes (`/api/anthropic`, `/api/openai`,
    // `/api/ollama`) because the dev server can't bypass browser CORS for
    // arbitrary vendor URLs.
    const pc = this._proxyConfig;
    // Resolve the motebit cloud relay URL. Canonical env var:
    // `VITE_MOTEBIT_RELAY_URL`. Legacy `VITE_PROXY_URL` still works for one
    // release cycle. Falls back to `DEFAULT_MOTEBIT_CLOUD_URL`.
    const viteEnv = import.meta.env as Record<string, string | undefined> | undefined;
    let envRelayUrl = viteEnv?.VITE_MOTEBIT_RELAY_URL;
    if (envRelayUrl == null || envRelayUrl === "") {
      const legacy = viteEnv?.VITE_PROXY_URL;
      if (legacy != null && legacy !== "") {
        // One-shot deprecation diagnostic — fires at most once per build,
        // when an older `.env` file is read for the first time.
        // eslint-disable-next-line no-console -- one-shot deprecation warning
        console.warn("[motebit] VITE_PROXY_URL is deprecated, use VITE_MOTEBIT_RELAY_URL instead");
        envRelayUrl = legacy;
      }
    }
    const motebitCloudBaseUrl = pc?.baseUrl ?? envRelayUrl ?? DEFAULT_MOTEBIT_CLOUD_URL;
    const motebitCloudHeaders =
      pc?.proxyToken !== undefined ? { "x-proxy-token": pc.proxyToken } : undefined;

    const env: ResolverEnv = {
      cloudBaseUrl: (wireProtocol, canonical) => {
        if (config.isTauri) return canonical;
        // Dev mode — Vite proxy paths configured in vite.config
        return wireProtocol === "anthropic" ? "/api/anthropic" : "/api/openai";
      },
      // Logical URL for local-server. Always the canonical Ollama form so
      // the dispatch heuristic recognizes it. The actual transport URL is
      // substituted by `localServerBaseUrl` below.
      defaultLocalServerUrl:
        config.localServerEndpoint != null && config.localServerEndpoint !== ""
          ? config.localServerEndpoint
          : DEFAULT_OLLAMA_URL,
      // Tauri builds talk to Ollama directly. Dev builds go through Vite's
      // `/api/ollama` proxy because the dev server can't bypass browser
      // CORS for arbitrary local ports. Either way, the dispatch decision
      // already happened on the logical URL — this is pure transport.
      localServerBaseUrl: (logical) => (config.isTauri ? logical : "/api/ollama"),
      supportedBackends: new Set(["local-server"]),
      motebitCloudBaseUrl,
      motebitCloudHeaders,
      motebitCloudDefaultModel: pc?.model,
    };

    const unified = desktopConfigToUnified(config);
    const spec = resolveProviderSpec(unified, env);
    const provider = desktopSpecToProvider(spec, temperature);

    // Track the active provider on the surface for the model indicator.
    this._activeProvider = config.provider;

    // State snapshot + conversation persistence — preload before runtime construction
    let stateSnapshot: TauriStateSnapshotStorage | undefined;
    let conversationStore: TauriConversationStore | undefined;
    if (config.isTauri && config.invoke) {
      stateSnapshot = new TauriStateSnapshotStorage(config.invoke);
      conversationStore = new TauriConversationStore(config.invoke);
      await Promise.all([
        stateSnapshot.preload(this.motebitId),
        conversationStore.preload(this.motebitId),
      ]);
    }

    // Store ref to conversation store for async operations (listing, loading, titling)
    this.conversationStoreRef = conversationStore ?? null;

    const storage = createDesktopStorage(config, stateSnapshot, conversationStore);
    this._localEventStore = storage.eventStore;
    const keyring =
      config.isTauri && config.invoke ? new TauriKeyringAdapter(config.invoke) : undefined;

    // Read governance from motebit.md identity file.
    // Fail-closed: in Tauri mode, tools are only registered if governance is valid.
    // In dev mode (non-Tauri), tools register freely — no identity file exists.
    let policyConfig: Partial<PolicyConfig> | undefined;
    let governanceLoaded = false;

    if (config.isTauri && config.invoke) {
      try {
        const raw = await config.invoke<string>("read_config");
        const configData = JSON.parse(raw) as Record<string, unknown>;
        const identityFileContent = configData._identity_file as string | undefined;
        if (identityFileContent != null && identityFileContent !== "") {
          const parsed = parseIdentityFile(identityFileContent);
          const gov = parsed.frontmatter.governance;
          if (
            gov?.max_risk_auto != null &&
            gov?.require_approval_above != null &&
            gov?.deny_above != null
          ) {
            const govPolicy = governanceToPolicyConfig(gov);
            policyConfig = {
              maxRiskLevel: govPolicy.maxRiskAuto,
              requireApprovalAbove: govPolicy.requireApprovalAbove,
              denyAbove: govPolicy.denyAbove,
            };
            governanceLoaded = true;
          }
        }
      } catch {
        // Parse failure — governance stays unloaded, tools won't register
      }
    }

    // Canonical governance → runtime config. Precedence:
    //   1. `config.governance` (canonical, from settings UI / config file)
    //   2. `policyConfig` from motebit.md identity file (Tauri-only, for
    //      max_risk / require_approval / deny bounds — these override preset)
    //   3. `DEFAULT_GOVERNANCE_CONFIG` for anything still missing
    const gov: GovernanceConfig = {
      ...DEFAULT_GOVERNANCE_CONFIG,
      ...(config.governance ?? {}),
    };
    const presetPolicy = APPROVAL_PRESET_CONFIGS[gov.approvalPreset];
    const mergedPolicy: Partial<PolicyConfig> = {
      ...(presetPolicy != null
        ? {
            maxRiskLevel: presetPolicy.maxRiskLevel,
            requireApprovalAbove: presetPolicy.requireApprovalAbove,
            denyAbove: presetPolicy.denyAbove,
          }
        : {}),
      // Identity-file governance (if present) wins over preset — it's
      // cryptographically anchored in motebit.md and is the declared bound.
      ...(policyConfig ?? {}),
      budget: { maxCallsPerTurn: gov.maxCallsPerTurn },
    };

    this.runtime = new MotebitRuntime(
      {
        motebitId: this.motebitId,
        tickRateHz: 2,
        policy: mergedPolicy,
        memoryGovernance: {
          persistenceThreshold: gov.persistenceThreshold,
          rejectSecrets: gov.rejectSecrets,
          maxMemoriesPerTurn: gov.maxMemoriesPerTurn,
        },
        taskRouter: PLANNING_TASK_ROUTER,
      },
      { storage, renderer: this.renderer, ai: provider, keyring },
    );

    // Advertise full desktop capabilities
    this.runtime.setLocalCapabilities([
      DeviceCapability.StdioMcp,
      DeviceCapability.HttpMcp,
      DeviceCapability.FileSystem,
      DeviceCapability.Keyring,
      DeviceCapability.Background,
    ]);

    // Create PlanEngine for multi-step goal execution
    if (config.isTauri && config.invoke) {
      const tauriPlanStore = new TauriPlanStore(config.invoke);
      this.planStoreRef = tauriPlanStore;
      this.planEngine = new PlanEngine(tauriPlanStore);
    } else {
      const memPlanStore = new InMemoryPlanStore();
      this.planStoreRef = memPlanStore;
      this.planEngine = new PlanEngine(memPlanStore);
    }

    // Fail-closed tool registration:
    // - Tauri mode: tools only register if governance thresholds are present
    // - Dev mode (non-Tauri): tools register freely (no identity to govern from)
    if (!config.isTauri || governanceLoaded) {
      registerDesktopTools(this.runtime.getToolRegistry(), this.runtime, config.invoke);
      this._governanceStatus = config.isTauri
        ? { governed: true }
        : { governed: false, reason: "dev mode" };
    } else {
      this._governanceStatus = {
        governed: false,
        reason: "missing or invalid governance in motebit.md",
      };
    }

    // Register goal-management tools (available during goal execution)
    if (config.isTauri && config.invoke) {
      this.registerGoalTools(config.invoke);
    }

    return true;
  }

  /**
   * Register goal-management tools that the agent can use during goal execution.
   * These tools let the agent create sub-goals, complete goals, and report progress.
   * They are no-ops when called outside of an active goal context.
   */
  private registerGoalTools(invoke: InvokeFn): void {
    const registry = this.runtime!.getToolRegistry();

    // Helper: parse interval strings like "1h", "30m", "1d" to milliseconds
    const parseInterval = (s: string): number => {
      const match = s.match(/^(\d+)\s*(s|m|h|d)$/i);
      if (!match) return 3_600_000; // default 1h
      const n = parseInt(match[1]!, 10);
      switch (match[2]!.toLowerCase()) {
        case "s":
          return n * 1_000;
        case "m":
          return n * 60_000;
        case "h":
          return n * 3_600_000;
        case "d":
          return n * 86_400_000;
        default:
          return 3_600_000;
      }
    };

    registry.register(createSubGoalDefinition, async (args: Record<string, unknown>) => {
      if (this._currentGoalId == null || this._currentGoalId === "") {
        return { ok: false, error: "No active goal context" };
      }
      const prompt = args.prompt as string;
      const interval = args.interval as string | undefined;
      const once = args.once as boolean | undefined;
      const intervalMs = interval != null && interval !== "" ? parseInterval(interval) : 3_600_000;
      const mode = once === true ? "once" : "recurring";
      const subGoalId = crypto.randomUUID();

      try {
        await invoke("goals_create", {
          motebit_id: this.motebitId,
          goal_id: subGoalId,
          prompt,
          interval_ms: intervalMs,
          mode,
        });
        // Set parent_goal_id
        await invoke<number>("db_execute", {
          sql: "UPDATE goals SET parent_goal_id = ? WHERE goal_id = ?",
          params: [this._currentGoalId, subGoalId],
        });
        return { ok: true, data: { goal_id: subGoalId, prompt, mode, interval_ms: intervalMs } };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
      }
    });

    registry.register(completeGoalDefinition, async (args: Record<string, unknown>) => {
      if (this._currentGoalId == null || this._currentGoalId === "") {
        return { ok: false, error: "No active goal context" };
      }
      const reason = args.reason as string;
      try {
        await invoke<number>("db_execute", {
          sql: "UPDATE goals SET status = 'completed' WHERE goal_id = ?",
          params: [this._currentGoalId],
        });
        // Best-effort event log
        try {
          await this.runtime!.events.append({
            event_id: crypto.randomUUID(),
            motebit_id: this.motebitId,
            event_type: EventType.GoalCompleted,
            payload: { goal_id: this._currentGoalId, reason },
            version_clock: (await this.runtime!.events.getLatestClock(this.motebitId)) + 1,
            timestamp: Date.now(),
            tombstoned: false,
          });
        } catch {
          /* best-effort */
        }
        return { ok: true, data: { goal_id: this._currentGoalId, status: "completed", reason } };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
      }
    });

    registry.register(reportProgressDefinition, async (args: Record<string, unknown>) => {
      if (this._currentGoalId == null || this._currentGoalId === "") {
        return { ok: false, error: "No active goal context" };
      }
      const note = args.note as string;
      try {
        await this.runtime!.events.append({
          event_id: crypto.randomUUID(),
          motebit_id: this.motebitId,
          event_type: EventType.GoalProgress,
          payload: { goal_id: this._currentGoalId, note },
          version_clock: (await this.runtime!.events.getLatestClock(this.motebitId)) + 1,
          timestamp: Date.now(),
          tombstoned: false,
        });
        return { ok: true, data: { goal_id: this._currentGoalId, note } };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
      }
    });
  }

  get isOperatorMode(): boolean {
    return this.runtime?.isOperatorMode ?? false;
  }

  async setOperatorMode(enabled: boolean, pin?: string): Promise<OperatorModeResult> {
    if (!this.runtime) return { success: false, error: "AI not initialized" };
    return this.runtime.setOperatorMode(enabled, pin);
  }

  async setupOperatorPin(pin: string): Promise<void> {
    if (!this.runtime) throw new Error("AI not initialized — call initAI() first");
    return this.runtime.setupOperatorPin(pin);
  }

  async resetOperatorPin(): Promise<void> {
    if (!this.runtime) throw new Error("AI not initialized — call initAI() first");
    return this.runtime.resetOperatorPin();
  }

  resetConversation(): void {
    this.runtime?.resetConversation();
  }

  /** Get conversation history for rendering previous messages on reopen. */
  getConversationHistory(): Array<{ role: string; content: string }> {
    return this.runtime?.getConversationHistory() ?? [];
  }

  async sendMessage(text: string, runId?: string): Promise<TurnResult> {
    if (!this.runtime) throw new Error("AI not initialized — call initAI() first");
    return this.runtime.sendMessage(text, runId);
  }

  async *sendMessageStreaming(text: string, runId?: string): AsyncGenerator<StreamChunk> {
    if (!this.runtime) throw new Error("AI not initialized — call initAI() first");
    yield* this.runtime.sendMessageStreaming(text, runId);
  }

  async *resumeAfterApproval(approved: boolean): AsyncGenerator<StreamChunk> {
    if (!this.runtime) throw new Error("AI not initialized — call initAI() first");
    yield* this.runtime.resumeAfterApproval(approved);
  }

  async *resolveApprovalVote(approved: boolean, approverId: string): AsyncGenerator<StreamChunk> {
    if (!this.runtime) throw new Error("AI not initialized — call initAI() first");
    yield* this.runtime.resolveApprovalVote(approved, approverId);
  }

  // === Appearance ===
  // Implementations in `./renderer-commands.ts`. One-line delegates here.

  setInteriorColor(presetName: string): void {
    rendererCommands.setInteriorColor(this.renderer, presetName);
  }

  /** Apply an arbitrary interior color directly (bypasses preset lookup). Used for custom color picker live preview. */
  setInteriorColorDirect(color: InteriorColor): void {
    rendererCommands.setInteriorColorDirect(this.renderer, color);
  }

  setDarkEnvironment(): void {
    rendererCommands.setDarkEnvironment(this.renderer);
  }

  setLightEnvironment(): void {
    rendererCommands.setLightEnvironment(this.renderer);
  }

  setAudioReactivity(energy: { rms: number; low: number; mid: number; high: number } | null): void {
    rendererCommands.setAudioReactivity(this.renderer, energy);
  }

  // === MCP Lifecycle ===
  // @motebit/mcp-client is Node-only (stdio/child_process) — dynamic import only.

  // === MCP server lifecycle ===
  // Implementations live in `./mcp-manager.ts`. One-line delegates here.

  addMcpServer(config: McpServerConfig): Promise<McpServerStatus> {
    return this.mcp.addMcpServer(config);
  }

  removeMcpServer(name: string): Promise<void> {
    return this.mcp.removeMcpServer(name);
  }

  getMcpStatus(): McpServerStatus[] {
    return this.mcp.getMcpStatus();
  }

  // === Policy ===

  updatePolicyConfig(config: Partial<PolicyConfig>): void {
    if (!this.runtime) return;
    this.runtime.updatePolicyConfig(config);
  }

  /**
   * Update the full canonical `GovernanceConfig`. The `approvalPreset` field
   * (if present) drives the policy gate via `APPROVAL_PRESET_CONFIGS`; the
   * memory-related fields flow to `MemoryGovernor`; `maxCallsPerTurn` updates
   * the runtime's budget cap via `updatePolicyConfig`.
   */
  updateGovernance(config: Partial<GovernanceConfig>): void {
    if (!this.runtime) return;
    const memoryPatch: Partial<MemoryGovernanceConfig> = {};
    if (config.persistenceThreshold !== undefined)
      memoryPatch.persistenceThreshold = config.persistenceThreshold;
    if (config.rejectSecrets !== undefined) memoryPatch.rejectSecrets = config.rejectSecrets;
    if (config.maxMemoriesPerTurn !== undefined)
      memoryPatch.maxMemoriesPerTurn = config.maxMemoriesPerTurn;
    if (Object.keys(memoryPatch).length > 0) {
      this.runtime.updateMemoryGovernance(memoryPatch);
    }
    const policyPatch: Partial<PolicyConfig> = {};
    if (config.approvalPreset !== undefined) {
      const preset = APPROVAL_PRESET_CONFIGS[config.approvalPreset];
      if (preset != null) {
        policyPatch.maxRiskLevel = preset.maxRiskLevel;
        policyPatch.requireApprovalAbove = preset.requireApprovalAbove;
        policyPatch.denyAbove = preset.denyAbove;
      }
    }
    if (config.maxCallsPerTurn !== undefined) {
      policyPatch.budget = { maxCallsPerTurn: config.maxCallsPerTurn };
    }
    if (Object.keys(policyPatch).length > 0) {
      this.runtime.updatePolicyConfig(policyPatch);
    }
  }

  /**
   * Back-compat: update only the memory-governance subset. New callers should
   * prefer `updateGovernance`. Kept so existing callers (settings.ts legacy
   * path) continue to work during migration.
   */
  updateMemoryGovernance(config: Partial<MemoryGovernanceConfig>): void {
    if (!this.runtime) return;
    this.runtime.updateMemoryGovernance(config);
  }

  /** Read-only snapshot of the effective memory governance config. Returns null if runtime not initialized. */
  getMemoryGovernance(): {
    persistenceThreshold: number;
    maxMemoriesPerTurn: number;
    rejectSecrets: boolean;
  } | null {
    if (!this.runtime) return null;
    return { ...this.runtime.memoryGovernor.getConfig() };
  }

  // === Governance ===

  get governanceStatus(): GovernanceStatus {
    return this._governanceStatus;
  }

  // === State & Tools ===

  /** Get the current state vector. Returns null if runtime not initialized. */
  getState(): Record<string, unknown> | null {
    if (!this.runtime) return null;
    return this.runtime.getState() as unknown as Record<string, unknown>;
  }

  /** List all registered tool names and descriptions. */
  listTools(): Array<{ name: string; description: string }> {
    if (!this.runtime) return [];
    return this.runtime
      .getToolRegistry()
      .list()
      .map((t) => ({
        name: t.name,
        description: t.description ?? "",
      }));
  }

  /** Return locally-issued credentials (peer-issued reputation, trust, gradient). */
  getLocalCredentials(): Array<{
    credential_id: string;
    credential_type: string;
    credential: Record<string, unknown>;
    issued_at: number;
  }> {
    if (!this.runtime) return [];
    return this.runtime.getIssuedCredentials().map((vc) => ({
      credential_id: crypto.randomUUID(),
      credential_type:
        vc.type.find((t: string) => t !== "VerifiableCredential") ?? "VerifiableCredential",
      credential: vc as unknown as Record<string, unknown>,
      issued_at:
        (vc as unknown as Record<string, unknown>).validFrom != null
          ? new Date((vc as unknown as Record<string, unknown>).validFrom as string).getTime()
          : Date.now(),
    }));
  }

  // === Curiosity, Gradient, Reflection, Agents, Approvals ===

  getCuriosityTargets() {
    if (!this.runtime) return [];
    return this.runtime.getCuriosityTargets();
  }

  async getMemoryGraphStats() {
    if (!this.runtime) return null;
    const { nodes, edges } = await this.runtime.memory.exportAll();
    const now = Date.now();
    const active = nodes.filter(
      (n) => !n.tombstoned && (n.valid_until == null || n.valid_until > now),
    );
    const pinned = active.filter((n) => n.pinned);
    return { nodes: active.length, edges: edges.length, pinned: pinned.length };
  }

  getGradient() {
    return this.runtime?.getGradient() ?? null;
  }

  getGradientSummary() {
    return (
      this.runtime?.getGradientSummary() ?? {
        trajectory: "",
        overall: "",
        strengths: [],
        weaknesses: [],
        posture: "",
        gradient: 0,
        delta: 0,
        snapshotCount: 0,
      }
    );
  }

  getLastReflection() {
    return this.runtime?.getLastReflection() ?? null;
  }

  async auditMemory() {
    if (!this.runtime) throw new Error("AI not initialized");
    return this.runtime.auditMemory();
  }

  async reflect() {
    if (!this.runtime) throw new Error("AI not initialized");
    return this.runtime.reflect();
  }

  async listTrustedAgents() {
    if (!this.runtime) return [];
    return this.runtime.listTrustedAgents();
  }

  hasPendingApproval(): boolean {
    return this.runtime?.hasPendingApproval ?? false;
  }

  get pendingApprovalInfo() {
    return this.runtime?.pendingApprovalInfo ?? null;
  }

  // === Identity (info, file, rotation) ===
  // Implementations live in `./identity-manager.ts`.

  getIdentityInfo(): { motebitId: string; deviceId: string; publicKey: string; did: string } {
    return this.identity.getIdentityInfo();
  }

  /**
   * Generate a signed motebit.md identity file from live config.
   * Returns the file content string, or null if the keypair is unavailable.
   */
  exportIdentityFile(invoke: InvokeFn): Promise<string | null> {
    return this.identity.exportIdentityFile(invoke);
  }

  /** Verify a motebit.md identity file's Ed25519 signature. */
  verifyIdentityFile(content: string): Promise<{ valid: boolean; error?: string }> {
    return this.identity.verifyIdentityFile(content);
  }

  /**
   * Rotate the Ed25519 keypair with signed succession record. See
   * `IdentityManager.rotateKey` for full semantics.
   */
  rotateKey(
    invoke: InvokeFn,
    reason?: string,
  ): Promise<{ oldKeyFingerprint: string; newKeyFingerprint: string; rotationCount: number }> {
    return this.identity.rotateKey(invoke, reason);
  }

  async exportAllData(): Promise<string> {
    const data: Record<string, unknown> = {
      motebit_id: this.motebitId,
      device_id: this.deviceId,
      public_key: this.publicKey,
      exported_at: new Date().toISOString(),
    };

    if (this.runtime) {
      // Export memories (nodes + edges)
      try {
        const { nodes, edges } = await this.runtime.memory.exportAll();
        data.memories = nodes;
        data.edges = edges;
      } catch {
        data.memories = [];
        data.edges = [];
      }

      // Export state vector
      data.state = this.runtime.getState();

      // Export recent events
      try {
        const events = await this.runtime.events.query({
          motebit_id: this.motebitId,
          limit: 500,
        });
        data.events = events;
      } catch {
        data.events = [];
      }
    }

    return JSON.stringify(data, null, 2);
  }

  // === Memory Browser ===
  // Implementations live in `./memory-commands.ts`. The methods here are
  // one-line delegates that preserve the public DesktopApp API contract.

  /** List all non-tombstoned memories, sorted by created_at DESC. */
  listMemories(): Promise<MemoryNode[]> {
    return memoryCommands.listMemories(this.runtime);
  }

  /** List all edges for the current motebit. */
  listMemoryEdges(): Promise<MemoryEdge[]> {
    return memoryCommands.listMemoryEdges(this.runtime);
  }

  /** Internal: form a memory directly, bypassing the agentic loop.
   * Used only for first-run greeting fallback. Local embeddings (no network). */
  formMemoryDirect(content: string, confidence: number): Promise<MemoryNode | null> {
    return memoryCommands.formMemoryDirect(this.runtime, content, confidence);
  }

  /** Soft-delete a memory with audit trail. */
  deleteMemory(nodeId: string): Promise<import("@motebit/crypto").DeletionCertificate | null> {
    return memoryCommands.deleteMemory(this.runtime, this.motebitId, nodeId);
  }

  /** List deletion certificates from the audit log. */
  listDeletionCertificates(): ReturnType<typeof memoryCommands.listDeletionCertificates> {
    return memoryCommands.listDeletionCertificates(this.runtime, this.motebitId);
  }

  /** Pin or unpin a memory. */
  pinMemory(nodeId: string, pinned: boolean): Promise<void> {
    return memoryCommands.pinMemory(this.runtime, nodeId, pinned);
  }

  /** Compute effective confidence after half-life decay. */
  getDecayedConfidence(node: MemoryNode): number {
    return memoryCommands.getDecayedConfidence(node);
  }

  // === Pairing ===
  // Device A (existing device) initiates and approves. Device B (new
  // device) claims and completes. Both halves live in the IdentityManager
  // because they share keypair access, sync token creation, and — on
  // Device B — write-back of motebitId/deviceId. One-line delegates here.

  initiatePairing(
    invoke: InvokeFn,
    syncUrl: string,
  ): Promise<{ pairingCode: string; pairingId: string }> {
    return this.identity.initiatePairing(invoke, syncUrl);
  }

  getPairingSession(invoke: InvokeFn, syncUrl: string, pairingId: string): Promise<PairingSession> {
    return this.identity.getPairingSession(invoke, syncUrl, pairingId);
  }

  approvePairing(
    invoke: InvokeFn,
    syncUrl: string,
    pairingId: string,
  ): Promise<{ deviceId: string }> {
    return this.identity.approvePairing(invoke, syncUrl, pairingId);
  }

  denyPairing(invoke: InvokeFn, syncUrl: string, pairingId: string): Promise<void> {
    return this.identity.denyPairing(invoke, syncUrl, pairingId);
  }

  claimPairing(syncUrl: string, code: string): Promise<{ pairingId: string; motebitId: string }> {
    return this.identity.claimPairing(syncUrl, code);
  }

  pollPairingStatus(syncUrl: string, pairingId: string): Promise<PairingStatus> {
    return this.identity.pollPairingStatus(syncUrl, pairingId);
  }

  completePairing(
    invoke: InvokeFn,
    result: { motebitId: string; deviceId: string },
  ): Promise<void> {
    return this.identity.completePairing(invoke, result);
  }

  // === Goal Scheduling ===

  /** Subscribe to goal execution status changes (for UI indicator). */
  onGoalStatus(callback: (executing: boolean) => void): void {
    this._goalStatusCallback = callback;
  }

  /** Subscribe to goal completion events (success or failure, for chat surfacing). */
  onGoalComplete(callback: (event: GoalCompleteEvent) => void): void {
    this._goalCompleteCallback = callback;
  }

  /** Subscribe to goal approval requests (tool needs user approval during background goal). */
  onGoalApproval(callback: (event: GoalApprovalEvent) => void): void {
    this._goalApprovalCallback = callback;
  }

  /** Subscribe to plan progress events (step started/completed/failed during goal execution). */
  onGoalPlanProgress(callback: (event: GoalPlanProgressEvent) => void): void {
    this._goalPlanProgressCallback = callback;
  }

  /** Subscribe to sync status changes (for UI indicator). */
  onSyncStatus(callback: (event: SyncStatusEvent) => void): void {
    this._syncStatusCallback = callback;
    // Immediately emit current status so the UI can initialize
    callback(this._lastSyncStatus);
  }

  /** Get the current sync status snapshot. */
  get syncStatus(): SyncStatusEvent {
    return { ...this._lastSyncStatus };
  }

  /** Current relay sync URL, or null if not configured. */
  getSyncUrl(): string | null {
    return this._proxySyncUrlCache;
  }

  /** Emit a sync status event and update internal state. */
  private emitSyncStatus(partial: Partial<SyncStatusEvent>): void {
    this._lastSyncStatus = { ...this._lastSyncStatus, ...partial };
    this._syncStatusCallback?.(this._lastSyncStatus);
  }

  /**
   * Resume a goal after the user approves/denies a tool call.
   * Streams the continuation back so main.ts can render it into chat.
   * After streaming completes, records the goal outcome and cleans up.
   *
   * If the goal was executing a plan (planId is set), this method:
   * 1. Completes the current step via runtime.resumeAfterApproval()
   * 2. Resumes the remaining plan steps via planEngine.resumePlan()
   */
  async *resumeGoalAfterApproval(approved: boolean): AsyncGenerator<StreamChunk> {
    if (!this.runtime) throw new Error("AI not initialized");
    if (!this._pendingGoalApproval) throw new Error("No pending goal approval");

    const { goalId, prompt, invoke, mode, planId, runId } = this._pendingGoalApproval;
    this._currentGoalId = goalId;

    try {
      let accumulated = "";
      let toolCallsMade = 0;
      let planTitle: string | undefined;
      let stepsCompleted: number | undefined;
      let totalSteps: number | undefined;

      // Phase 1: Complete the current tool call / step via runtime approval
      for await (const chunk of this.runtime.resumeAfterApproval(approved)) {
        if (chunk.type === "text") {
          accumulated += chunk.text;
        } else if (chunk.type === "tool_status" && chunk.status === "calling") {
          toolCallsMade++;
        }
        yield chunk;
      }

      // Phase 2: If this was a plan-based goal, resume remaining steps
      if (planId != null && planId !== "" && this.planEngine != null) {
        const loopDeps = this.runtime.getLoopDeps();
        if (loopDeps) {
          const planResult = await this.consumePlanStream(
            this.planEngine.resumePlan(planId, loopDeps, undefined, runId),
            { goal_id: goalId, prompt, mode },
            invoke,
          );

          if (planResult.suspended) {
            // Another approval request during plan continuation — stay suspended
            return;
          }

          accumulated += planResult.responseText;
          toolCallsMade += planResult.toolCallsMade;
          planTitle = planResult.planTitle;
          stepsCompleted = planResult.stepsCompleted;
          totalSteps = planResult.totalSteps;
        }
      }

      // Record outcome to DB (use runId as outcome_id for audit correlation)
      const outcomeId = runId ?? crypto.randomUUID();
      const now = Date.now();
      await invoke<number>("db_execute", {
        sql: "UPDATE goals SET last_run_at = ?, consecutive_failures = 0 WHERE goal_id = ?",
        params: [now, goalId],
      });

      await invoke<number>("db_execute", {
        sql: `INSERT INTO goal_outcomes (outcome_id, goal_id, motebit_id, ran_at, status, summary, tool_calls_made, memories_formed, error_message)
              VALUES (?, ?, ?, ?, 'completed', ?, ?, 0, NULL)`,
        params: [outcomeId, goalId, this.motebitId, now, accumulated.slice(0, 500), toolCallsMade],
      });

      // One-shot auto-complete
      if (mode === "once") {
        await invoke<number>("db_execute", {
          sql: "UPDATE goals SET status = 'completed' WHERE goal_id = ?",
          params: [goalId],
        });
      }

      // Notify UI
      this._goalCompleteCallback?.({
        goalId,
        prompt,
        status: "completed",
        summary: accumulated.slice(0, 200),
        error: null,
        planTitle,
        stepsCompleted,
        totalSteps,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this._goalCompleteCallback?.({
        goalId,
        prompt,
        status: "failed",
        summary: null,
        error: msg,
      });
      throw err;
    } finally {
      if (this._pendingGoalApproval == null || this._pendingGoalApproval.goalId === goalId) {
        this._goalExecuting = false;
        this._currentGoalId = null;
        this._goalStatusCallback?.(false);
        this._pendingGoalApproval = null;
        this.runtime?.resetConversation();
      }
    }
  }

  get isGoalExecuting(): boolean {
    return this._goalExecuting;
  }

  /**
   * Start background goal scheduling. Checks for active goals every 60s and
   * executes them in the background without interrupting the user's chat.
   * Goals are stored in the database as rows in a `goals` table — the desktop
   * reads them via Tauri IPC. If the goals table doesn't exist or has no active
   * goals, the tick is a no-op.
   */
  startGoalScheduler(invoke: InvokeFn): void {
    if (this.goalSchedulerTimer) return;
    this.goalSchedulerTimer = setInterval(() => {
      void this.goalTick(invoke);
    }, 60_000);
    // Run first tick after a short delay (let UI settle)
    setTimeout(() => {
      void this.goalTick(invoke);
    }, 5_000);
  }

  stopGoalScheduler(): void {
    if (this.goalSchedulerTimer) {
      clearInterval(this.goalSchedulerTimer);
      this.goalSchedulerTimer = null;
    }
  }

  private async goalTick(invoke: InvokeFn): Promise<void> {
    if (!this.runtime || this._goalExecuting || this.runtime.isProcessing) return;

    try {
      interface GoalRow {
        goal_id: string;
        motebit_id: string;
        prompt: string;
        interval_ms: number;
        last_run_at: number | null;
        enabled: number;
        status: string;
        mode: string;
        parent_goal_id: string | null;
        max_retries: number;
        consecutive_failures: number;
      }

      interface OutcomeRow {
        ran_at: number;
        status: string;
        summary: string | null;
        error_message: string | null;
      }

      const goals = await invoke<GoalRow[]>("db_query", {
        sql: "SELECT * FROM goals WHERE motebit_id = ? AND enabled = 1 AND status = 'active'",
        params: [this.motebitId],
      });

      if (goals.length === 0) return;

      const now = Date.now();
      for (const goal of goals) {
        const elapsed = goal.last_run_at != null ? now - goal.last_run_at : Infinity;
        if (elapsed < goal.interval_ms) continue;
        if (this.runtime.isProcessing) break;

        this._goalExecuting = true;
        this._currentGoalId = goal.goal_id;
        this._goalStatusCallback?.(true);

        // Generate a stable runId for this goal execution (= outcome_id for audit correlation)
        const runId = crypto.randomUUID();

        try {
          // Build enriched context with previous outcomes
          const outcomes = await invoke<OutcomeRow[]>("db_query", {
            sql: "SELECT ran_at, status, summary, error_message FROM goal_outcomes WHERE goal_id = ? ORDER BY ran_at DESC LIMIT 3",
            params: [goal.goal_id],
          });

          // Use PlanEngine for multi-step execution if available
          // Wall-clock limit: 10 minutes per goal run
          const GOAL_WALL_CLOCK_MS = 10 * 60 * 1000;
          const abortController = new AbortController();
          const deadlineTimer = setTimeout(
            () => abortController.abort(new Error("Goal exceeded 10-minute wall-clock limit")),
            GOAL_WALL_CLOCK_MS,
          );
          let result: Awaited<ReturnType<typeof this.executePlanGoal>>;
          try {
            result = await this.executePlanGoal(
              goal,
              outcomes ?? [],
              invoke,
              runId,
              abortController.signal,
            );
          } finally {
            clearTimeout(deadlineTimer);
          }

          if (result.suspended) {
            // Approval requested — _goalExecuting stays true to block further ticks.
            return;
          }

          // Normal completion: record outcome, update DB (runId = outcome_id for audit correlation)
          await invoke<number>("db_execute", {
            sql: "UPDATE goals SET last_run_at = ?, consecutive_failures = 0 WHERE goal_id = ?",
            params: [now, goal.goal_id],
          });

          await invoke<number>("db_execute", {
            sql: `INSERT INTO goal_outcomes (outcome_id, goal_id, motebit_id, ran_at, status, summary, tool_calls_made, memories_formed, error_message, tokens_used)
                  VALUES (?, ?, ?, ?, 'completed', ?, ?, 0, NULL, ?)`,
            params: [
              runId,
              goal.goal_id,
              this.motebitId,
              now,
              result.responseText.slice(0, 500),
              result.toolCallsMade,
              result.tokensUsed ?? null,
            ],
          });

          // One-shot auto-complete
          if (goal.mode === "once") {
            await invoke<number>("db_execute", {
              sql: "UPDATE goals SET status = 'completed' WHERE goal_id = ?",
              params: [goal.goal_id],
            });
          }

          // Notify UI
          this._goalCompleteCallback?.({
            goalId: goal.goal_id,
            prompt: goal.prompt,
            status: "completed",
            summary: result.responseText.slice(0, 200),
            error: null,
            planTitle: result.planTitle,
            stepsCompleted: result.stepsCompleted,
            totalSteps: result.totalSteps,
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);

          // Record failed outcome (runId = outcome_id for audit correlation)
          await invoke<number>("db_execute", {
            sql: `INSERT INTO goal_outcomes (outcome_id, goal_id, motebit_id, ran_at, status, summary, tool_calls_made, memories_formed, error_message)
                  VALUES (?, ?, ?, ?, 'failed', NULL, 0, 0, ?)`,
            params: [runId, goal.goal_id, this.motebitId, now, msg],
          }).catch(() => {});

          // Increment failures and auto-pause if threshold reached
          await invoke<number>("db_execute", {
            sql: "UPDATE goals SET consecutive_failures = consecutive_failures + 1 WHERE goal_id = ?",
            params: [goal.goal_id],
          }).catch(() => {});

          if (goal.consecutive_failures + 1 >= goal.max_retries) {
            await invoke<number>("db_execute", {
              sql: "UPDATE goals SET status = 'paused' WHERE goal_id = ?",
              params: [goal.goal_id],
            }).catch(() => {});
          }

          // Notify UI
          this._goalCompleteCallback?.({
            goalId: goal.goal_id,
            prompt: goal.prompt,
            status: "failed",
            summary: null,
            error: msg,
          });
        } finally {
          if (!this._pendingGoalApproval) {
            this._goalExecuting = false;
            this._currentGoalId = null;
            this._goalStatusCallback?.(false);
            this.runtime?.resetConversation();
          }
        }
      }
    } catch {
      this._goalExecuting = false;
      this._currentGoalId = null;
      this._goalStatusCallback?.(false);
    }
  }

  /**
   * Execute a goal using PlanEngine for multi-step decomposition.
   * Falls back to single-turn streaming if PlanEngine is unavailable.
   */
  private async executePlanGoal(
    goal: { goal_id: string; prompt: string; mode: string },
    outcomes: Array<{
      ran_at: number;
      status: string;
      summary: string | null;
      error_message: string | null;
    }>,
    invoke: InvokeFn,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<{
    suspended: boolean;
    toolCallsMade: number;
    responseText: string;
    planTitle?: string;
    stepsCompleted?: number;
    totalSteps?: number;
    tokensUsed?: number;
  }> {
    const loopDeps = this.runtime!.getLoopDeps();

    // If PlanEngine or loopDeps are unavailable, fall back to single-turn execution
    if (!this.planEngine || !loopDeps) {
      return this.executeSingleTurnGoal(goal, outcomes, invoke, runId, signal);
    }

    const registry = this.runtime!.getToolRegistry();

    // Pre-load any existing active plan for this goal (async cache warm-up for Tauri)
    if (this.planStoreRef && "preloadForGoal" in this.planStoreRef) {
      await this.planStoreRef.preloadForGoal(goal.goal_id);
    }

    // Check for existing active plan (resume interrupted plan)
    let plan = this.planStoreRef!.getPlanForGoal(goal.goal_id);
    let planStream: AsyncGenerator<PlanChunk>;

    if (plan && plan.status === PlanStatus.Active) {
      planStream = this.planEngine.resumePlan(plan.plan_id, loopDeps, undefined, runId);
    } else {
      const created = await this.planEngine.createPlan(
        goal.goal_id,
        this.motebitId,
        {
          goalPrompt: goal.prompt,
          previousOutcomes: outcomes.map((o) =>
            o.status === "failed"
              ? `failed: ${o.error_message ?? "unknown"}`
              : `${o.status}: ${o.summary ?? "no summary"}`,
          ),
          availableTools: registry.list().map((t) => t.name),
        },
        loopDeps,
      );
      const newPlan = created.plan;
      plan = newPlan;
      if (created.truncatedFrom != null && created.truncatedFrom > 0) {
        // eslint-disable-next-line no-console
        console.warn(
          `Plan truncated from ${created.truncatedFrom} to ${newPlan.total_steps} steps (max ${newPlan.total_steps})`,
        );
      }
      planStream = this.planEngine.executePlan(newPlan.plan_id, loopDeps, undefined, runId);
    }

    return this.consumePlanStream(planStream, goal, invoke, runId, signal);
  }

  /**
   * Fallback: single-turn goal execution (pre-PlanEngine behavior).
   */
  private async executeSingleTurnGoal(
    goal: { goal_id: string; prompt: string; mode: string },
    outcomes: Array<{
      ran_at: number;
      status: string;
      summary: string | null;
      error_message: string | null;
    }>,
    invoke: InvokeFn,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<{
    suspended: boolean;
    toolCallsMade: number;
    responseText: string;
    tokensUsed?: number;
  }> {
    const now = Date.now();
    let context = `You are executing a scheduled goal.\n\nGoal: ${goal.prompt}`;
    if (outcomes.length > 0) {
      context += "\n\nPrevious executions (most recent first):";
      for (const o of outcomes) {
        const ago = formatTimeAgo(now - o.ran_at);
        if (o.status === "failed" && o.error_message != null && o.error_message !== "") {
          context += `\n- ${ago}: failed — [error: ${o.error_message}]`;
        } else if (o.summary != null && o.summary !== "") {
          context += `\n- ${ago}: ${o.status} — "${o.summary.slice(0, 100)}"`;
        } else {
          context += `\n- ${ago}: ${o.status}`;
        }
      }
    }
    if (goal.mode === "once") {
      context += "\n\nThis is a one-time goal. Complete it fully in this execution.";
    }

    let accumulated = "";
    let toolCallsMade = 0;
    let tokensUsed = 0;

    for await (const chunk of this.runtime!.sendMessageStreaming(context, runId)) {
      if (signal?.aborted === true) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Goal aborted");
      }
      if (chunk.type === "text") {
        accumulated += chunk.text;
      } else if (chunk.type === "tool_status" && chunk.status === "calling") {
        toolCallsMade++;
        if (toolCallsMade > MAX_TOOL_CALLS_PER_RUN) {
          throw new Error(`Goal exceeded ${MAX_TOOL_CALLS_PER_RUN} tool calls — run stopped`);
        }
      } else if (
        chunk.type === "result" &&
        chunk.result.totalTokens != null &&
        chunk.result.totalTokens > 0
      ) {
        tokensUsed += chunk.result.totalTokens;
      } else if (chunk.type === "approval_request") {
        this._pendingGoalApproval = {
          goalId: goal.goal_id,
          prompt: goal.prompt,
          invoke,
          mode: goal.mode,
          runId,
        };
        this._goalApprovalCallback?.({
          goalId: goal.goal_id,
          goalPrompt: goal.prompt,
          toolName: chunk.name,
          args: chunk.args,
          riskLevel: chunk.risk_level,
        });
        return {
          suspended: true,
          toolCallsMade,
          responseText: accumulated,
          tokensUsed: tokensUsed > 0 ? tokensUsed : undefined,
        };
      }
    }

    return {
      suspended: false,
      toolCallsMade,
      responseText: accumulated,
      tokensUsed: tokensUsed > 0 ? tokensUsed : undefined,
    };
  }

  /**
   * Consume a PlanEngine stream, forwarding progress to UI callbacks.
   */
  private async consumePlanStream(
    stream: AsyncGenerator<PlanChunk>,
    goal: { goal_id: string; prompt: string; mode: string },
    invoke: InvokeFn,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<{
    suspended: boolean;
    toolCallsMade: number;
    responseText: string;
    planTitle?: string;
    stepsCompleted?: number;
    totalSteps?: number;
    tokensUsed?: number;
  }> {
    let toolCallsMade = 0;
    let responseText = "";
    let tokensUsed = 0;
    let planTitle: string | undefined;
    let totalSteps = 0;
    let stepsCompleted = 0;

    for await (const chunk of stream) {
      if (signal?.aborted === true) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Goal aborted");
      }
      switch (chunk.type) {
        case "plan_created":
          planTitle = chunk.plan.title;
          totalSteps = chunk.steps.length;
          this._goalPlanProgressCallback?.({
            goalId: goal.goal_id,
            planTitle: chunk.plan.title,
            stepIndex: 0,
            totalSteps: chunk.steps.length,
            stepDescription: chunk.steps[0]?.description ?? "",
            type: "plan_created",
          });
          break;

        case "step_started":
          this._goalPlanProgressCallback?.({
            goalId: goal.goal_id,
            planTitle: planTitle ?? "",
            stepIndex: chunk.step.ordinal + 1,
            totalSteps,
            stepDescription: chunk.step.description,
            type: "step_started",
          });
          break;

        case "step_chunk":
          // Forward inner agentic chunks
          if (chunk.chunk.type === "text") {
            responseText += chunk.chunk.text;
          } else if (chunk.chunk.type === "tool_status" && chunk.chunk.status === "calling") {
            toolCallsMade++;
            if (toolCallsMade > MAX_TOOL_CALLS_PER_RUN) {
              throw new Error(`Goal exceeded ${MAX_TOOL_CALLS_PER_RUN} tool calls — run stopped`);
            }
          } else if (
            chunk.chunk.type === "result" &&
            chunk.chunk.result.totalTokens != null &&
            chunk.chunk.result.totalTokens > 0
          ) {
            tokensUsed += chunk.chunk.result.totalTokens;
          }
          break;

        case "step_completed":
          stepsCompleted++;
          this._goalPlanProgressCallback?.({
            goalId: goal.goal_id,
            planTitle: planTitle ?? "",
            stepIndex: chunk.step.ordinal + 1,
            totalSteps,
            stepDescription: chunk.step.description,
            type: "step_completed",
          });
          break;

        case "step_delegated": {
          const rc = chunk.routing_choice;
          const agentId = rc?.selected_agent ?? chunk.task_id?.slice(0, 8) ?? "network";
          const agentShort = agentId.length > 12 ? agentId.slice(0, 8) + "…" : agentId;
          let desc = `→ agent ${agentShort}: ${chunk.step.description}`;
          if (rc?.alternatives_considered != null && rc.alternatives_considered > 0)
            desc += ` (${rc.alternatives_considered + 1} evaluated)`;
          this._goalPlanProgressCallback?.({
            goalId: goal.goal_id,
            planTitle: planTitle ?? "",
            stepIndex: chunk.step.ordinal + 1,
            totalSteps,
            stepDescription: desc,
            type: "step_started",
          });
          break;
        }

        case "step_failed":
          this._goalPlanProgressCallback?.({
            goalId: goal.goal_id,
            planTitle: planTitle ?? "",
            stepIndex: chunk.step.ordinal + 1,
            totalSteps,
            stepDescription: chunk.step.description,
            type: "step_failed",
          });
          break;

        case "approval_request": {
          const innerChunk = chunk.chunk;
          if (innerChunk.type !== "approval_request") break;
          this._pendingGoalApproval = {
            goalId: goal.goal_id,
            prompt: goal.prompt,
            invoke,
            mode: goal.mode,
            planId: chunk.step.plan_id,
            runId,
          };
          this._goalApprovalCallback?.({
            goalId: goal.goal_id,
            goalPrompt: goal.prompt,
            toolName: innerChunk.name,
            args: innerChunk.args,
            riskLevel: innerChunk.risk_level,
          });
          return {
            suspended: true,
            toolCallsMade,
            responseText,
            planTitle,
            stepsCompleted,
            totalSteps,
            tokensUsed: tokensUsed > 0 ? tokensUsed : undefined,
          };
        }

        case "plan_completed":
          // Plan finished successfully
          break;

        case "plan_failed":
          // Plan failed — the error will surface through the outer catch
          throw new Error(`Plan failed: ${chunk.reason}`);
      }
    }

    return {
      suspended: false,
      toolCallsMade,
      responseText,
      planTitle,
      stepsCompleted,
      totalSteps,
      tokensUsed: tokensUsed > 0 ? tokensUsed : undefined,
    };
  }

  // === MCP via Tauri Commands ===

  /**
   * Discover and connect MCP tools via Tauri shell commands.
   * Since @motebit/mcp-client uses Node child_process (not available in webview),
   * we spawn the MCP server via Tauri's shell_exec_tool and communicate over stdio.
   *
   * For now, this registers the MCP server config and attempts a dynamic import
   * of @motebit/mcp-client. If that fails (expected in webview), it falls back
   * to a Tauri IPC bridge approach.
   */
  /**
   * Connect to an MCP server with Tauri IPC fallback. See
   * `McpManager.connectMcpServerViaTauri` for the two-path semantics
   * (native dynamic import, then shell-exec bridge).
   */
  connectMcpServerViaTauri(config: McpServerConfig, invoke: InvokeFn): Promise<McpServerStatus> {
    return this.mcp.connectMcpServerViaTauri(config, invoke);
  }

  // === Conversation Browsing ===

  /** List recent conversations (async, for UI). Returns empty array if no conversation store. */
  async listConversationsAsync(limit = 20): Promise<
    Array<{
      conversationId: string;
      startedAt: number;
      lastActiveAt: number;
      title: string | null;
      summary: string | null;
      messageCount: number;
    }>
  > {
    if (!this.conversationStoreRef) return [];
    return this.conversationStoreRef.listConversationsAsync(this.motebitId, limit);
  }

  /** Load a past conversation by ID — replaces the current chat. Returns the message list. */
  async loadConversationById(
    conversationId: string,
  ): Promise<Array<{ role: string; content: string }>> {
    if (!this.runtime || !this.conversationStoreRef) return [];

    // Load messages asynchronously into the cache
    await this.conversationStoreRef.loadMessagesAsync(conversationId);

    // Now the sync loadMessages() call inside runtime will work from cache
    this.runtime.loadConversation(conversationId);

    return this.runtime.getConversationHistory();
  }

  /** Start a new conversation (clears current). */
  startNewConversation(): void {
    if (this.runtime) {
      this.runtime.resetConversation();
    }
  }

  /** Get the current conversation ID. */
  get currentConversationId(): string | null {
    return this.runtime?.getConversationId() ?? null;
  }

  /**
   * Get the summary for a specific conversation by ID.
   * Returns null if no summary exists or conversation store is unavailable.
   */
  async getConversationSummary(conversationId: string): Promise<string | null> {
    if (!this.conversationStoreRef) return null;
    const conversations = await this.conversationStoreRef.listConversationsAsync(
      this.motebitId,
      100,
    );
    const conv = conversations.find((c) => c.conversationId === conversationId);
    return conv?.summary ?? null;
  }

  /**
   * Manually trigger summarization of the current conversation.
   * Uses the AI provider via a side-channel call (no conversation pollution).
   * Returns the generated summary, or null if there's nothing to summarize.
   */
  async summarizeConversation(): Promise<string | null> {
    if (!this.runtime || !this.conversationStoreRef) return null;

    const conversationId = this.runtime.getConversationId();
    if (conversationId == null || conversationId === "") return null;

    const history = this.runtime.getConversationHistory();
    if (history.length < 2) return null;

    // Get existing summary if any
    const existingSummary = await this.getConversationSummary(conversationId);

    // Use the ai-core summarizeConversation via generateCompletion (side-channel)
    const formatted = history.map((m) => `${m.role}: ${m.content}`).join("\n");

    const prompt =
      existingSummary != null && existingSummary !== ""
        ? `Update this conversation summary with the new messages.\n\nExisting summary:\n${existingSummary}\n\nNew messages:\n${formatted}\n\nReturn ONLY the updated summary (2-4 sentences). No quotes, no explanation.`
        : `Summarize this conversation in 2-4 concise sentences. Return ONLY the summary, no quotes, no explanation.\n\n${formatted}`;

    const summary = await this.runtime.generateCompletion(prompt);
    const cleaned = summary.trim();

    if (cleaned.length > 0) {
      this.conversationStoreRef.updateSummary(conversationId, cleaned);
      return cleaned;
    }

    return null;
  }

  // === Auto-Title ===

  /**
   * Generate a title for the current conversation when it reaches 4+ messages.
   * Uses the AI provider to produce a short (5-7 word) title from the first messages.
   * Non-blocking, fires in the background.
   */
  async maybeAutoTitle(): Promise<string | null> {
    if (!this.runtime || !this.conversationStoreRef || this._autoTitlePending) return null;

    const conversationId = this.runtime.getConversationId();
    if (conversationId == null || conversationId === "") return null;

    const history = this.runtime.getConversationHistory();
    if (history.length < 4) return null;

    // Check if already titled
    const convos = await this.conversationStoreRef.listConversationsAsync(this.motebitId, 50);
    const current = convos.find((c) => c.conversationId === conversationId);
    if (current?.title != null && current.title !== "") return current.title;

    this._autoTitlePending = true;

    try {
      // Use a focused prompt to generate a short title
      const firstMessages = history
        .slice(0, 6)
        .map((m) => `${m.role}: ${m.content.slice(0, 200)}`)
        .join("\n");
      const titlePrompt = `Generate a very short title (5-7 words max) for this conversation. Return ONLY the title, no quotes, no explanation.\n\n${firstMessages}`;

      const result = await this.runtime.sendMessage(titlePrompt);
      const title = result.response
        .trim()
        .replace(/^["']|["']$/g, "")
        .slice(0, 100);

      if (title && title.length > 0 && title.length < 100) {
        this.conversationStoreRef.updateTitle(conversationId, title);
        // Reset conversation to remove the title generation exchange
        // We actually need a different approach — send via provider directly
        // For now, store the title and don't pollute chat history
        return title;
      }
    } catch {
      // Auto-titling is best-effort
    } finally {
      this._autoTitlePending = false;
    }

    return null;
  }

  /**
   * Generate a title using a lightweight AI call that doesn't affect conversation history.
   * Uses runtime.generateCompletion() (side-channel) so the title prompt never enters
   * the conversation. Falls back to heuristic (first 7 words) if the AI call fails.
   * Called after pushToHistory when message count crosses 4.
   */
  async generateTitleInBackground(): Promise<string | null> {
    if (!this.runtime || !this.conversationStoreRef) return null;

    const conversationId = this.runtime.getConversationId();
    if (conversationId == null || conversationId === "") return null;

    // Check message count
    const count = await this.conversationStoreRef.getMessageCount(conversationId);
    if (count < 4) return null;

    // Check if already titled
    const convos = await this.conversationStoreRef.listConversationsAsync(this.motebitId, 50);
    const current = convos.find((c) => c.conversationId === conversationId);
    if (current?.title != null && current.title !== "") return null; // Already has a title

    if (this._autoTitlePending) return null;
    this._autoTitlePending = true;

    try {
      const history = this.runtime.getConversationHistory();
      const firstMessages = history
        .slice(0, 6)
        .map((m) => `${m.role}: ${m.content.slice(0, 200)}`)
        .join("\n");

      // Try AI-generated title via side-channel (no conversation pollution)
      try {
        const prompt = `Generate a very short title (5-7 words max) for this conversation. Return ONLY the title, no quotes, no explanation.\n\n${firstMessages}`;
        const raw = await this.runtime.generateCompletion(prompt);
        const title = raw
          .trim()
          .replace(/^["']|["']$/g, "")
          .slice(0, 100);
        if (title.length > 0 && title.length < 100) {
          this.conversationStoreRef.updateTitle(conversationId, title);
          return title;
        }
      } catch {
        // AI title generation failed — fall through to heuristic
      }

      // Heuristic fallback: first 7 words of first user message
      const firstUserMsg = history.find((m) => m.role === "user");
      if (firstUserMsg) {
        const words = firstUserMsg.content.split(/\s+/);
        let title = words.slice(0, 7).join(" ");
        if (words.length > 7) title += "...";
        if (title.length > 0) {
          this.conversationStoreRef.updateTitle(conversationId, title);
          return title;
        }
      }
    } catch {
      // Best-effort
    } finally {
      this._autoTitlePending = false;
    }

    return null;
  }

  // === Conversation Sync ===

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
    if (!this.conversationStoreRef) {
      return {
        conversations_pushed: 0,
        conversations_pulled: 0,
        messages_pushed: 0,
        messages_pulled: 0,
      };
    }

    this.emitSyncStatus({ status: "syncing" });

    const storeAdapter = new TauriConversationSyncStoreAdapter(
      this.conversationStoreRef,
      this.motebitId,
    );
    // Pre-fetch local data before sync (async Tauri -> sync adapter bridge)
    await storeAdapter.prefetch(0);

    const syncEngine = new ConversationSyncEngine(storeAdapter, this.motebitId);
    const httpConvAdapter = new HttpConversationSyncAdapter({
      baseUrl: syncUrl,
      motebitId: this.motebitId,
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
      if (this.planStoreRef) {
        const planSyncAdapter = new TauriPlanSyncStoreAdapter(this.planStoreRef, this.motebitId);
        await planSyncAdapter.prefetch(0);
        const planSync = new PlanSyncEngine(planSyncAdapter, this.motebitId);
        const httpPlanAdapter = new HttpPlanSyncAdapter({
          baseUrl: syncUrl,
          motebitId: this.motebitId,
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
    if (!this.runtime) return;

    this.emitSyncStatus({ status: "connecting", error: null });

    // Get keypair for token creation + encryption key derivation
    const keypair = await this.getDeviceKeypair(invoke);
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
      token = await this.createSyncToken(keypair.privateKey);
    }

    // Build adapter stack: HTTP (fallback) → Encrypted HTTP → WS → Encrypted WS
    const httpAdapter = new HttpEventStoreAdapter({
      baseUrl: syncUrl,
      motebitId: this.motebitId,
      authToken: token,
    });
    const encryptedHttp = new EncryptedEventStoreAdapter({ inner: httpAdapter, key: encKey });

    // WebSocket URL: http(s) → ws(s)
    const wsUrl =
      syncUrl.replace(/^https?/, (m) => (m === "https" ? "wss" : "ws")) +
      "/ws/sync/" +
      this.motebitId;

    const localEventStore = this._localEventStore;
    const desktopCapabilities = [
      DeviceCapability.StdioMcp,
      DeviceCapability.HttpMcp,
      DeviceCapability.FileSystem,
      DeviceCapability.Keyring,
      DeviceCapability.Background,
    ];

    const wsAdapter = new WebSocketEventStoreAdapter({
      url: wsUrl,
      motebitId: this.motebitId,
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
    this.runtime.connectSync(encryptedWs);
    wsAdapter.connect();

    // Subscribe to SyncEngine status changes
    if (this._syncUnsubscribe) this._syncUnsubscribe();
    this._syncUnsubscribe = this.runtime.sync.onStatusChange((engineStatus: SyncStatus) => {
      if (engineStatus === "syncing") {
        this.emitSyncStatus({ status: "syncing" });
      } else if (engineStatus === "idle") {
        const conflicts = this.runtime?.sync.getConflicts() ?? [];
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

    this.runtime.startSync();
    this.emitSyncStatus({ status: "connected" });

    // Enable interactive delegation — lets the AI transparently delegate tasks
    // to remote agents during conversation via the delegate_to_agent tool.
    const privKeyHex = keypair.privateKey;
    this.runtime.enableInteractiveDelegation({
      syncUrl,
      authToken: async () => this.createSyncToken(privKeyHex, "task:submit"),
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
      // Handle remote command requests (forwarded by relay)
      if (msg.type === "command_request" && this.runtime) {
        const cmdMsg = msg as unknown as { id: string; command: string; args?: string };
        void (async () => {
          try {
            const result = await executeCommand(this.runtime!, cmdMsg.command, cmdMsg.args);
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
      if (!this.runtime || !this._servingPrivateKey) return;

      const task = msg.task as AgentTask;
      const runtime = this.runtime;
      const privateKey = this._servingPrivateKey;

      // Claim the task
      this._wsAdapter?.sendRaw(JSON.stringify({ type: "task_claim", task_id: task.task_id }));
      this._activeTaskCount++;

      // Execute — creature glow will rise from processing state
      void (async () => {
        try {
          let receipt: ExecutionReceipt | undefined;
          for await (const chunk of runtime.handleAgentTask(
            task,
            privateKey,
            this.deviceId,
            undefined,
            { delegatedScope: task.delegated_scope },
          )) {
            if (chunk.type === "task_result") {
              receipt = chunk.receipt;
            }
          }

          if (receipt) {
            const resultUrl = `${syncUrl}/agent/${this.motebitId}/task/${task.task_id}/result`;
            await fetch(resultUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${this._servingAuthToken ?? ""}`,
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
          const freshToken = await this.createSyncToken(keypair.privateKey);
          const freshWs = new WebSocketEventStoreAdapter({
            url: wsUrl,
            motebitId: this.motebitId,
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
          this.runtime?.connectSync(freshEncrypted);
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
    if (!this.runtime) return;

    try {
      const token = await this.createSyncToken(privateKeyHex, "task:submit");
      if (!token) return;

      const result = await cmdSelfTest(this.runtime, {
        relay: { relayUrl: syncUrl, authToken: token, motebitId: this.motebitId },
        mintToken: async () => this.createSyncToken(privateKeyHex, "task:submit"),
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
  async startServing(): Promise<{ ok: boolean; error?: string }> {
    if (!this.runtime || !this._servingSyncUrl || !this._servingAuthToken) {
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
    const tools = this.runtime.getToolRegistry().list();
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
          motebit_id: this.motebitId,
          endpoint_url: `ws://${this.motebitId}`,
          public_key: this.publicKey,
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

  /**
   * Stop serving — stop accepting delegations.
   */
  stopServing(): void {
    this._serving = false;
  }

  /** Whether the desktop is currently accepting delegations. */
  isServing(): boolean {
    return this._serving;
  }

  /** Number of tasks currently executing. */
  activeTaskCount(): number {
    return this._activeTaskCount;
  }

  /** Discover agents on the relay network. Returns empty array if not connected. */
  async discoverAgents(): Promise<
    Array<{ motebit_id: string; capabilities: string[]; trust_level?: string }>
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
        agents: Array<{ motebit_id: string; capabilities: string[]; trust_level?: string }>;
      };
      return data.agents ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Stop background event sync.
   */
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
    this.runtime?.sync.stop();
    this.emitSyncStatus({ status: "disconnected" });
  }
}

// === Helpers ===

function formatTimeAgo(ms: number): string {
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

// === Slash Command Utilities ===

export function isSlashCommand(input: string): boolean {
  return input.startsWith("/");
}

export function parseSlashCommand(input: string): { command: string; args: string } {
  const spaceIdx = input.indexOf(" ");
  if (spaceIdx === -1) return { command: input.slice(1), args: "" };
  return { command: input.slice(1, spaceIdx), args: input.slice(spaceIdx + 1).trim() };
}
