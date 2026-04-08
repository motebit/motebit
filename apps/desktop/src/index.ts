/**
 * @motebit/desktop — Tauri app (Rust + webview)
 *
 * Thin platform shell around MotebitRuntime.
 * Provides Tauri-specific storage adapters and AI provider creation.
 */

import { MotebitRuntime, ProxySession, PLANNING_TASK_ROUTER } from "@motebit/runtime";
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
import type { MemoryNode, MemoryEdge } from "@motebit/sdk";
import {
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
import { parse as parseIdentityFile, governanceToPolicyConfig } from "@motebit/identity-file";
import type { PairingSession, PairingStatus } from "@motebit/sync-engine";
import { PlanEngine, InMemoryPlanStore } from "@motebit/planner";
import type { PlanStoreAdapter } from "@motebit/planner";
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
import * as memoryCommands from "./memory-commands.js";
import * as rendererCommands from "./renderer-commands.js";
import { IdentityManager } from "./identity-manager.js";
import { McpManager } from "./mcp-manager.js";
import { registerDesktopTools } from "./desktop-tools.js";
import {
  GoalScheduler,
  type GoalCompleteEvent,
  type GoalPlanProgressEvent,
  type GoalApprovalEvent,
} from "./goal-scheduler.js";
export type {
  GoalCompleteEvent,
  GoalPlanProgressEvent,
  GoalApprovalEvent,
} from "./goal-scheduler.js";
import { SyncController, type SyncStatusEvent } from "./sync-controller.js";
export type { SyncStatusEvent, SyncIndicatorStatus } from "./sync-controller.js";
import { ConversationManager } from "./conversation-manager.js";
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

// Sync + goal event types live in ./sync-controller.ts and ./goal-scheduler.ts
// and are re-exported from the top of this file.

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
  private goals = new GoalScheduler({
    getRuntime: () => this.runtime,
    getMotebitId: () => this.motebitId,
    getPlanEngine: () => this.planEngine,
    getPlanStore: () => this.planStoreRef,
  });
  private planEngine: PlanEngine | null = null;
  private planStoreRef: TauriPlanStore | PlanStoreAdapter | null = null;
  private conversationStoreRef: TauriConversationStore | null = null;
  private conversations = new ConversationManager({
    getRuntime: () => this.runtime,
    getMotebitId: () => this.motebitId,
    getConversationStore: () => this.conversationStoreRef,
  });
  private _localEventStore: EventStoreAdapter | null = null;
  private sync = new SyncController({
    getRuntime: () => this.runtime,
    getMotebitId: () => this.motebitId,
    getDeviceId: () => this.deviceId,
    getConversationStore: () => this.conversationStoreRef,
    getPlanStore: () => this.planStoreRef,
    getLocalEventStore: () => this._localEventStore,
    getDeviceKeypair: (invoke) => this.identity.getDeviceKeypair(invoke),
    createSyncToken: (privateKeyHex, aud) => this.identity.createSyncToken(privateKeyHex, aud),
  });
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

  /** Register goal-management tools on the runtime registry. */
  private registerGoalTools(invoke: InvokeFn): void {
    this.goals.registerGoalTools(invoke);
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

    // Track any section that fails so the exported bundle can surface it
    // explicitly. A silent fallback to an empty array would make the user
    // think their motebit had no memories or events when the query actually
    // threw — that's worse than failing loudly.
    const failedSections: string[] = [];

    if (this.runtime) {
      // Export memories (nodes + edges)
      try {
        const { nodes, edges } = await this.runtime.memory.exportAll();
        data.memories = nodes;
        data.edges = edges;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console -- diagnostic for partial export
        console.warn(`[export] memory export failed — bundle will omit memories: ${msg}`);
        data.memories = [];
        data.edges = [];
        failedSections.push("memories", "edges");
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
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console -- diagnostic for partial export
        console.warn(`[export] event export failed — bundle will omit events: ${msg}`);
        data.events = [];
        failedSections.push("events");
      }
    }

    if (failedSections.length > 0) {
      data.partial_export = true;
      data.failed_sections = failedSections;
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
  // Implementations live in `./goal-scheduler.ts`. The methods below
  // are thin delegates preserving the public DesktopApp API.

  /** Subscribe to goal execution status changes (for UI indicator). */
  onGoalStatus(callback: (executing: boolean) => void): void {
    this.goals.onGoalStatus(callback);
  }

  /** Subscribe to goal completion events (success or failure, for chat surfacing). */
  onGoalComplete(callback: (event: GoalCompleteEvent) => void): void {
    this.goals.onGoalComplete(callback);
  }

  /** Subscribe to goal approval requests (tool needs user approval during background goal). */
  onGoalApproval(callback: (event: GoalApprovalEvent) => void): void {
    this.goals.onGoalApproval(callback);
  }

  /** Subscribe to plan progress events (step started/completed/failed during goal execution). */
  onGoalPlanProgress(callback: (event: GoalPlanProgressEvent) => void): void {
    this.goals.onGoalPlanProgress(callback);
  }

  // === Sync (delegates to SyncController) ===

  /** Subscribe to sync status changes (for UI indicator). */
  onSyncStatus(callback: (event: SyncStatusEvent) => void): void {
    this.sync.onSyncStatus(callback);
  }

  /** Get the current sync status snapshot. */
  get syncStatus(): SyncStatusEvent {
    return this.sync.syncStatus;
  }

  /** Current relay sync URL, or null if not configured. */
  getSyncUrl(): string | null {
    return this._proxySyncUrlCache;
  }

  /** Resume a goal after the user approves/denies a tool call. */
  async *resumeGoalAfterApproval(approved: boolean): AsyncGenerator<StreamChunk> {
    yield* this.goals.resumeGoalAfterApproval(approved);
  }

  get isGoalExecuting(): boolean {
    return this.goals.isGoalExecuting;
  }

  /** Start background goal scheduling (60s interval). */
  startGoalScheduler(invoke: InvokeFn): void {
    this.goals.start(invoke);
  }

  stopGoalScheduler(): void {
    this.goals.stop();
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

  // === Conversation Browsing (delegates to ConversationManager) ===

  listConversationsAsync(limit = 20): Promise<
    Array<{
      conversationId: string;
      startedAt: number;
      lastActiveAt: number;
      title: string | null;
      summary: string | null;
      messageCount: number;
    }>
  > {
    return this.conversations.listConversationsAsync(limit);
  }

  loadConversationById(conversationId: string): Promise<Array<{ role: string; content: string }>> {
    return this.conversations.loadConversationById(conversationId);
  }

  startNewConversation(): void {
    this.conversations.startNewConversation();
  }

  get currentConversationId(): string | null {
    return this.conversations.getCurrentConversationId();
  }

  getConversationSummary(conversationId: string): Promise<string | null> {
    return this.conversations.getConversationSummary(conversationId);
  }

  summarizeConversation(): Promise<string | null> {
    return this.conversations.summarizeConversation();
  }

  maybeAutoTitle(): Promise<string | null> {
    return this.conversations.maybeAutoTitle();
  }

  generateTitleInBackground(): Promise<string | null> {
    return this.conversations.generateTitleInBackground();
  }

  // === Sync / Serving (delegates to SyncController) ===

  /** Sync conversations + plans with the remote relay server. */
  syncConversations(
    syncUrl: string,
    authToken?: string,
    encryptionKey?: Uint8Array,
  ): Promise<{
    conversations_pushed: number;
    conversations_pulled: number;
    messages_pushed: number;
    messages_pulled: number;
  }> {
    return this.sync.syncConversations(syncUrl, authToken, encryptionKey);
  }

  /** Start full sync: event-level WS + one-shot conversation sync. */
  startSync(invoke: InvokeFn, syncUrl: string, authToken?: string): Promise<void> {
    return this.sync.startSync(invoke, syncUrl, authToken);
  }

  /** Start serving — register with relay and accept delegations. */
  startServing(): Promise<{ ok: boolean; error?: string }> {
    return this.sync.startServing(this.publicKey);
  }

  stopServing(): void {
    this.sync.stopServing();
  }

  isServing(): boolean {
    return this.sync.isServing();
  }

  activeTaskCount(): number {
    return this.sync.activeTaskCount();
  }

  discoverAgents(): Promise<
    Array<{ motebit_id: string; capabilities: string[]; trust_level?: string }>
  > {
    return this.sync.discoverAgents();
  }

  stopSync(): void {
    this.sync.stopSync();
  }
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
