/**
 * @motebit/mobile — MobileApp platform shell
 *
 * Wraps MotebitRuntime with Expo-specific adapters:
 * - expo-secure-store for keyring (iOS Keychain / Android Keystore)
 * - expo-sqlite for persistent storage
 * - WebView for Three.js rendering (full WebGL2 via WKWebView)
 * - AsyncStorage for non-secret settings
 *
 * Modeled on DesktopApp / SpatialApp — same pattern, different adapters.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  MotebitRuntime,
  RelayDelegationAdapter,
  executeCommand,
  ProxySession,
  cmdSelfTest,
  PLANNING_TASK_ROUTER,
} from "@motebit/runtime";
import type {
  StreamChunk,
  OperatorModeResult,
  InteriorColor,
  PolicyConfig,
  MemoryGovernanceConfig,
  ReflectionResult,
  CuriosityTarget,
  ProxyProviderConfig,
  ProxySessionAdapter,
} from "@motebit/runtime";
import type { GradientSnapshot } from "@motebit/runtime";
import {
  CloudProvider,
  OllamaProvider,
  HybridProvider,
  DEFAULT_OLLAMA_URL,
} from "@motebit/ai-core";
import {
  createSignedToken,
  deriveSyncEncryptionKey,
  secureErase,
  bytesToHex,
} from "@motebit/crypto";
import {
  bootstrapIdentity as sharedBootstrapIdentity,
  rotateIdentityKeys,
  type BootstrapConfigStore,
  type BootstrapKeyStore,
} from "@motebit/core-identity";
import {
  PairingClient,
  SyncEngine,
  HttpEventStoreAdapter,
  WebSocketEventStoreAdapter,
  EncryptedEventStoreAdapter,
  decryptEventPayload,
  ConversationSyncEngine,
  HttpConversationSyncAdapter,
  EncryptedConversationSyncAdapter,
  EncryptedPlanSyncAdapter,
  PlanSyncEngine,
  HttpPlanSyncAdapter,
} from "@motebit/sync-engine";
import type { PlanSyncStoreAdapter } from "@motebit/sync-engine";
import { McpClientAdapter, AdvisoryManifestVerifier } from "@motebit/mcp-client";
import type { McpServerConfig } from "@motebit/mcp-client";
export type { McpServerConfig } from "@motebit/mcp-client";
export type { MemoryNode } from "@motebit/sdk";
import { InMemoryToolRegistry } from "@motebit/tools";
import { PlanEngine } from "@motebit/planner";
import type { PlanChunk } from "@motebit/planner";
import {
  PlanStatus,
  DeviceCapability,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_PROXY_MODEL,
} from "@motebit/sdk";
import type { AgentTask, ExecutionReceipt } from "@motebit/sdk";
import type { PairingSession, PairingStatus, SyncStatus } from "@motebit/sync-engine";
import type {
  MotebitState,
  BehaviorCues,
  MemoryNode,
  SyncPlan,
  SyncPlanStep,
  Plan,
  PlanStep,
} from "@motebit/sdk";
import { computeDecayedConfidence, embedText } from "@motebit/memory-graph";
import {
  webSearchDefinition,
  createWebSearchHandler,
  readUrlDefinition,
  createReadUrlHandler,
  recallMemoriesDefinition,
  createRecallMemoriesHandler,
  listEventsDefinition,
  createListEventsHandler,
  selfReflectDefinition,
  createSelfReflectHandler,
  DuckDuckGoSearchProvider,
  createSubGoalDefinition,
  completeGoalDefinition,
  reportProgressDefinition,
} from "@motebit/tools/web-safe";
import type { EventFilter, EventStoreAdapter } from "@motebit/event-log";
import type { EventType } from "@motebit/sdk";
import {
  generate as generateIdentityFile,
  parse as parseIdentityFile,
  governanceToPolicyConfig,
  rotate as rotateIdentityFile,
} from "@motebit/identity-file";
import { createExpoStorage, ExpoGoalStore } from "./adapters/expo-sqlite";
import type { ExpoStorageResult } from "./adapters/expo-sqlite";
import { WebViewGLAdapter } from "./adapters/webview-gl";
import { SecureStoreAdapter } from "./adapters/secure-store";

// === Color Presets (same 7 as desktop) ===

export const COLOR_PRESETS: Record<string, InteriorColor> = {
  moonlight: { tint: [0.95, 0.95, 1.0], glow: [0.8, 0.85, 1.0] },
  amber: { tint: [1.0, 0.85, 0.6], glow: [0.9, 0.7, 0.3] },
  rose: { tint: [1.0, 0.82, 0.88], glow: [0.9, 0.5, 0.6] },
  violet: { tint: [0.88, 0.8, 1.0], glow: [0.6, 0.4, 0.9] },
  cyan: { tint: [0.8, 0.95, 1.0], glow: [0.3, 0.8, 0.9] },
  ember: { tint: [1.0, 0.75, 0.65], glow: [0.9, 0.35, 0.2] },
  sage: { tint: [0.82, 0.95, 0.85], glow: [0.4, 0.75, 0.5] },
};

// === Approval Presets ===

export interface ApprovalPresetConfig {
  label: string;
  description: string;
  requireApprovalAbove: number;
  denyAbove: number;
}

export const APPROVAL_PRESET_CONFIGS: Record<string, ApprovalPresetConfig> = {
  cautious: {
    label: "Cautious",
    description: "Approve everything above read-only",
    requireApprovalAbove: 0,
    denyAbove: 3,
  },
  balanced: {
    label: "Balanced",
    description: "Auto-allow low risk, approve medium",
    requireApprovalAbove: 1,
    denyAbove: 4,
  },
  autonomous: {
    label: "Autonomous",
    description: "Auto-allow most, deny only dangerous",
    requireApprovalAbove: 2,
    denyAbove: 4,
  },
};

// === Settings ===

export interface MobileSettings {
  provider: "ollama" | "anthropic" | "openai" | "hybrid" | "proxy";
  model: string;
  ollamaEndpoint: string;
  colorPreset: string;
  customHue: number;
  customSaturation: number;
  theme: "light" | "dark" | "system";
  approvalPreset: string;
  persistenceThreshold: number;
  rejectSecrets: boolean;
  maxMemoriesPerTurn: number;
  budgetMaxCalls: number;
  voiceEnabled: boolean;
  ttsVoice: string;
  voiceAutoSend: boolean;
  voiceResponseEnabled: boolean;
  neuralVadEnabled: boolean;
  maxTokens: number;
}

const DEFAULT_SETTINGS: MobileSettings = {
  provider: "ollama",
  model: DEFAULT_OLLAMA_MODEL,
  ollamaEndpoint: DEFAULT_OLLAMA_URL,
  colorPreset: "moonlight",
  customHue: 220,
  customSaturation: 0.7,
  theme: "dark",
  approvalPreset: "balanced",
  persistenceThreshold: 0.5,
  rejectSecrets: true,
  maxMemoriesPerTurn: 5,
  budgetMaxCalls: 20,
  voiceEnabled: false,
  ttsVoice: "alloy",
  voiceAutoSend: true,
  voiceResponseEnabled: true,
  neuralVadEnabled: true,
  maxTokens: 4096,
};

const SETTINGS_KEY = "@motebit/settings";
const IDENTITY_FILE_KEY = "@motebit/identity_file";

// === AI Config ===

export interface MobileAIConfig {
  provider: "ollama" | "anthropic" | "openai" | "hybrid" | "proxy";
  model?: string;
  apiKey?: string;
  ollamaEndpoint?: string;
  maxTokens?: number;
}

// === Bootstrap Result ===

export interface MobileBootstrapResult {
  isFirstLaunch: boolean;
  motebitId: string;
  deviceId: string;
}

// === Goal Event Types ===

export interface GoalCompleteEvent {
  goalId: string;
  prompt: string;
  status: "completed" | "failed";
  summary: string | null;
  error: string | null;
}

export interface GoalApprovalEvent {
  goalId: string;
  goalPrompt: string;
  toolName: string;
  args: Record<string, unknown>;
  riskLevel?: number;
}

// === Utilities ===

function formatTimeAgo(ms: number): string {
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

/** Parse interval strings like "1h", "30m", "1d", "1w" to milliseconds. */
function parseInterval(s: string): number {
  const match = s.match(/^(\d+)\s*(m|h|d|w)$/i);
  if (!match) return 3_600_000;
  const n = parseInt(match[1]!, 10);
  switch (match[2]!.toLowerCase()) {
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    case "d":
      return n * 86_400_000;
    case "w":
      return n * 604_800_000;
    default:
      return 3_600_000;
  }
}

// === MobileApp ===

export class MobileApp {
  private runtime: MotebitRuntime | null = null;
  private storage: ExpoStorageResult | null = null;
  private renderer: WebViewGLAdapter;
  private keyring: SecureStoreAdapter;

  // Governance status
  private _governanceStatus: { governed: boolean; reason?: string } = {
    governed: false,
    reason: "not initialized",
  };

  // Sync state
  private syncEngine: SyncEngine | null = null;
  private conversationSyncEngine: ConversationSyncEngine | null = null;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private _syncStatus: SyncStatus = "offline";
  private _syncStatusCallback: ((status: SyncStatus, lastSync: number) => void) | null = null;
  private _lastSyncTime = 0;
  private _wsAdapter: WebSocketEventStoreAdapter | null = null;
  private _wsUnsubOnEvent: (() => void) | null = null;
  private _syncEncKey: Uint8Array | null = null;
  private _localEventStore: EventStoreAdapter | null = null;

  // Serving state
  private _serving = false;
  private _servingSyncUrl: string | null = null;
  private _servingAuthToken: string | null = null;
  private _activeTaskCount = 0;

  // MCP state
  private mcpAdapters: Map<string, McpClientAdapter> = new Map();
  private _mcpServers: McpServerConfig[] = [];
  private _toolsChangedCallback: (() => void) | null = null;
  private static readonly MCP_SERVERS_KEY = "@motebit/mcp_servers";

  // Plan engine
  private planEngine: PlanEngine | null = null;

  // Goal scheduler state
  private goalSchedulerTimer: ReturnType<typeof setInterval> | null = null;
  private goalTickCount = 0;
  private _goalExecuting = false;
  private _goalStatusCallback: ((executing: boolean) => void) | null = null;
  private _goalCompleteCallback: ((event: GoalCompleteEvent) => void) | null = null;
  private _goalApprovalCallback: ((event: GoalApprovalEvent) => void) | null = null;
  private _currentGoalId: string | null = null;
  private _pendingGoalApproval: {
    goalId: string;
    prompt: string;
    mode: string;
    planId?: string;
  } | null = null;

  motebitId = "mobile-local";
  deviceId = "mobile-local";
  publicKey = "";

  // Proxy session state
  private _proxySession: ProxySession | null = null;
  private _proxyConfig: ProxyProviderConfig | null = null;

  constructor() {
    this.renderer = new WebViewGLAdapter();
    this.keyring = new SecureStoreAdapter();
  }

  // === Identity ===

  async bootstrap(): Promise<MobileBootstrapResult> {
    const keyring = this.keyring;

    const configStore: BootstrapConfigStore = {
      async read() {
        const mid = await keyring.get("motebit_id");
        if (mid == null || mid === "") return null;
        return {
          motebit_id: mid,
          device_id: (await keyring.get("device_id")) ?? "",
          device_public_key: (await keyring.get("device_public_key")) ?? "",
        };
      },
      async write(state) {
        await keyring.set("motebit_id", state.motebit_id);
        await keyring.set("device_id", state.device_id);
        await keyring.set("device_public_key", state.device_public_key);
      },
    };

    const keyStore: BootstrapKeyStore = {
      async storePrivateKey(hex: string) {
        await keyring.set("device_private_key", hex);
      },
    };

    const storage = createExpoStorage("motebit.db");
    this.storage = storage;
    this._localEventStore = storage.eventStore;

    const result = await sharedBootstrapIdentity({
      surfaceName: "Mobile",
      identityStorage: storage.identityStorage,
      eventStoreAdapter: storage.eventStore,
      configStore,
      keyStore,
    });

    this.motebitId = result.motebitId;
    this.deviceId = result.deviceId;
    this.publicKey = result.publicKeyHex;

    // Generate motebit.md identity file on first launch (best-effort)
    if (result.isFirstLaunch) {
      try {
        const privKeyHex = await this.keyring.get("device_private_key");
        if (privKeyHex != null && privKeyHex !== "") {
          const privKeyBytes = new Uint8Array(privKeyHex.length / 2);
          for (let i = 0; i < privKeyHex.length; i += 2) {
            privKeyBytes[i / 2] = parseInt(privKeyHex.slice(i, i + 2), 16);
          }
          try {
            const identityFileContent = await generateIdentityFile(
              {
                motebitId: result.motebitId,
                ownerId: result.motebitId,
                publicKeyHex: result.publicKeyHex,
                devices: [
                  {
                    device_id: result.deviceId,
                    name: "Mobile",
                    public_key: result.publicKeyHex,
                    registered_at: new Date().toISOString(),
                  },
                ],
              },
              privKeyBytes,
            );
            await AsyncStorage.setItem(IDENTITY_FILE_KEY, identityFileContent);
          } finally {
            secureErase(privKeyBytes);
          }
        }
      } catch {
        // Non-fatal — identity file generation is best-effort
      }
    }

    return {
      isFirstLaunch: result.isFirstLaunch,
      motebitId: result.motebitId,
      deviceId: result.deviceId,
    };
  }

  // === Proxy Bootstrap ===

  private static readonly PROXY_TOKEN_KEY = "@motebit/proxy_token";

  /**
   * Attempt proxy bootstrap before requiring an API key.
   * Call after bootstrap() but before initAI(). If this returns true,
   * pass { provider: "proxy" } to initAI() — the token and model are stored internally.
   */
  async tryProxyBootstrap(): Promise<boolean> {
    const adapter: ProxySessionAdapter = {
      getSyncUrl: () => {
        return this._proxySyncUrlCache;
      },
      getMotebitId: () => {
        return this.motebitId !== "mobile-local" ? this.motebitId : null;
      },
      loadToken: () => {
        return this._proxyTokenCache;
      },
      saveToken: (data) => {
        this._proxyTokenCache = data;
        void AsyncStorage.setItem(MobileApp.PROXY_TOKEN_KEY, JSON.stringify(data)).catch(() => {});
      },
      clearToken: () => {
        this._proxyTokenCache = null;
        void AsyncStorage.removeItem(MobileApp.PROXY_TOKEN_KEY).catch(() => {});
      },
      onProviderReady: (config: ProxyProviderConfig) => {
        this._proxyConfig = config;
      },
    };

    // Pre-load sync URL and cached token from AsyncStorage
    try {
      const [syncUrl, tokenRaw] = await Promise.all([
        AsyncStorage.getItem(MobileApp.SYNC_URL_KEY),
        AsyncStorage.getItem(MobileApp.PROXY_TOKEN_KEY),
      ]);
      this._proxySyncUrlCache = syncUrl;
      this._proxyTokenCache = tokenRaw
        ? (JSON.parse(tokenRaw) as {
            token: string;
            balance: number;
            balanceUsd: number;
            expiresAt: number;
            motebitId: string;
          })
        : null;
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

  // === AI ===

  async initAI(config: MobileAIConfig): Promise<boolean> {
    let provider;
    if (config.provider === "ollama") {
      const model = config.model ?? DEFAULT_OLLAMA_MODEL;
      const base_url = config.ollamaEndpoint ?? DEFAULT_OLLAMA_URL;
      provider = new OllamaProvider({ model, base_url, max_tokens: config.maxTokens });
    } else if (config.provider === "openai") {
      if (config.apiKey == null || config.apiKey === "") return false;
      const model = config.model ?? DEFAULT_OPENAI_MODEL;
      provider = new CloudProvider({
        provider: "openai",
        api_key: config.apiKey,
        model,
        base_url: "https://api.openai.com/v1",
        max_tokens: config.maxTokens,
      });
    } else if (config.provider === "proxy") {
      const pc = this._proxyConfig;
      const model = pc?.model ?? DEFAULT_PROXY_MODEL;
      const proxyUrl =
        pc?.baseUrl ??
        (await AsyncStorage.getItem("@motebit/proxy_url")) ??
        "https://api.motebit.com";
      const extraHeaders: Record<string, string> = {};
      if (pc?.proxyToken) extraHeaders["x-proxy-token"] = pc.proxyToken;
      provider = new CloudProvider({
        provider: "anthropic",
        api_key: "",
        model,
        base_url: proxyUrl,
        max_tokens: config.maxTokens,
        extra_headers: Object.keys(extraHeaders).length > 0 ? extraHeaders : undefined,
      });
    } else if (config.provider === "hybrid") {
      if (config.apiKey == null || config.apiKey === "") return false;
      const model = config.model ?? DEFAULT_ANTHROPIC_MODEL;
      provider = new HybridProvider({
        cloud: {
          provider: "anthropic",
          api_key: config.apiKey,
          model,
          base_url: "https://api.anthropic.com",
          max_tokens: config.maxTokens,
        },
        ollama: {
          model: DEFAULT_OLLAMA_MODEL,
          base_url: config.ollamaEndpoint ?? DEFAULT_OLLAMA_URL,
          max_tokens: config.maxTokens,
        },
        fallback_to_local: true,
      });
    } else {
      if (config.apiKey == null || config.apiKey === "") return false;
      const model = config.model ?? DEFAULT_ANTHROPIC_MODEL;
      provider = new CloudProvider({
        provider: "anthropic",
        api_key: config.apiKey,
        model,
        base_url: "https://api.anthropic.com",
        max_tokens: config.maxTokens,
      });
    }

    const storage = this.storage ?? createExpoStorage("motebit.db");

    // Read governance from identity file if available
    let policyConfig: Partial<PolicyConfig> | undefined;
    try {
      const identityFileContent = await AsyncStorage.getItem(IDENTITY_FILE_KEY);
      if (identityFileContent != null && identityFileContent !== "") {
        const parsed = parseIdentityFile(identityFileContent);
        const gov = parsed.frontmatter.governance;
        if (
          gov?.max_risk_auto != null &&
          gov.max_risk_auto !== "" &&
          gov.require_approval_above != null &&
          gov.require_approval_above !== "" &&
          gov.deny_above != null &&
          gov.deny_above !== ""
        ) {
          const govPolicy = governanceToPolicyConfig(gov);
          policyConfig = {
            maxRiskLevel: govPolicy.maxRiskAuto,
            requireApprovalAbove: govPolicy.requireApprovalAbove,
            denyAbove: govPolicy.denyAbove,
          };
          this._governanceStatus = { governed: true };
        } else {
          this._governanceStatus = {
            governed: false,
            reason: "incomplete governance in identity file",
          };
        }
      } else {
        this._governanceStatus = { governed: false, reason: "no identity file" };
      }
    } catch {
      // Non-fatal — governance parsing is best-effort
      this._governanceStatus = { governed: false, reason: "identity file parse error" };
    }

    this.runtime = new MotebitRuntime(
      {
        motebitId: this.motebitId,
        tickRateHz: 2,
        policy: policyConfig,
        taskRouter: PLANNING_TASK_ROUTER,
      },
      { storage, renderer: this.renderer, ai: provider, keyring: this.keyring },
    );

    // Mobile capabilities: HTTP MCP + secure keyring
    this.runtime.setLocalCapabilities([DeviceCapability.HttpMcp, DeviceCapability.Keyring]);

    // Create PlanEngine for multi-step goal execution
    if (storage.planStore != null) {
      this.planEngine = new PlanEngine(storage.planStore);
    }

    // Register builtin tools (web_search, read_url, recall_memories, list_events, goal tools)
    this.registerBuiltinTools();

    // Reconnect any persisted MCP servers
    void this.reconnectMcpServers();

    return true;
  }

  /** Register builtin tools into the runtime's tool registry. */
  private registerBuiltinTools(): void {
    if (!this.runtime) return;
    const registry = this.runtime.getToolRegistry();
    const runtime = this.runtime;

    // web_search — DuckDuckGo (no API key needed)
    registry.register(webSearchDefinition, createWebSearchHandler(new DuckDuckGoSearchProvider()));

    // read_url — fetch + clean HTML
    registry.register(readUrlDefinition, createReadUrlHandler());

    // recall_memories — semantic search via embeddings
    registry.register(
      recallMemoriesDefinition,
      createRecallMemoriesHandler(async (query, limit) => {
        const queryEmbedding = await embedText(query);
        const nodes = await runtime.memory.retrieve(queryEmbedding, { limit });
        return nodes.map((n) => ({ content: n.content, confidence: n.confidence }));
      }),
    );

    // list_events — query event log
    registry.register(
      listEventsDefinition,
      createListEventsHandler(async (limit, eventType) => {
        const filter: EventFilter = {
          motebit_id: runtime.motebitId,
          limit,
        };
        if (eventType != null && eventType !== "") {
          filter.event_types = [eventType as EventType];
        }
        const events = await runtime.events.query(filter);
        return events.map((e) => ({
          event_type: e.event_type,
          timestamp: e.timestamp,
          payload: e.payload,
        }));
      }),
    );

    // Self-reflection — creature can introspect on its own behavior
    registry.register(
      selfReflectDefinition,
      createSelfReflectHandler(async () => runtime.reflect()),
    );

    // Goal management tools (available during goal execution)
    const goalStore = this.storage?.goalStore;
    registry.register(createSubGoalDefinition, (args: Record<string, unknown>) => {
      if (this._currentGoalId == null || this._currentGoalId === "" || goalStore == null) {
        return Promise.resolve({ ok: false, error: "No active goal context" });
      }
      const prompt = args.prompt as string;
      const interval = args.interval as string | undefined;
      const once = args.once as boolean | undefined;
      const intervalMs = interval != null && interval !== "" ? parseInterval(interval) : 3_600_000;
      const mode = once === true ? "once" : "recurring";
      const subGoalId = goalStore.addGoal(this.motebitId, prompt, intervalMs, mode);
      return Promise.resolve({
        ok: true,
        data: { goal_id: subGoalId, prompt, mode, interval_ms: intervalMs },
      });
    });

    registry.register(completeGoalDefinition, (args: Record<string, unknown>) => {
      if (this._currentGoalId == null || this._currentGoalId === "" || goalStore == null) {
        return Promise.resolve({ ok: false, error: "No active goal context" });
      }
      const reason = args.reason as string;
      goalStore.setStatus(this._currentGoalId, "completed");
      return Promise.resolve({
        ok: true,
        data: { goal_id: this._currentGoalId, status: "completed", reason },
      });
    });

    registry.register(reportProgressDefinition, (args: Record<string, unknown>) => {
      if (this._currentGoalId == null || this._currentGoalId === "") {
        return Promise.resolve({ ok: false, error: "No active goal context" });
      }
      const note = args.note as string;
      return Promise.resolve({ ok: true, data: { goal_id: this._currentGoalId, note } });
    });
  }

  // === GL Init ===

  async init(gl: unknown): Promise<void> {
    await this.renderer.init(gl);
  }

  // === Lifecycle ===

  start(): void {
    this.runtime?.start();
  }

  stop(): void {
    this.runtime?.stop();
    this.renderer.dispose();
    this.stopSync();
  }

  // === Rendering ===

  renderFrame(deltaTime: number, time: number): void {
    if (this.runtime) {
      this.runtime.renderFrame(deltaTime, time);
    } else {
      this.renderer.render({
        cues: {
          hover_distance: 0.4,
          drift_amplitude: 0.02,
          glow_intensity: 0.3,
          eye_dilation: 0.3,
          smile_curvature: 0,
          speaking_activity: 0,
        },
        delta_time: deltaTime,
        time,
      });
    }
  }

  resize(width: number, height: number): void {
    this.renderer.resize(width, height);
  }

  // === Camera orbit controls ===

  handleOrbitTouchStart(): void {
    this.renderer.handleTouchStart();
  }

  handleOrbitTouchEnd(): void {
    this.renderer.handleTouchEnd();
  }

  handleOrbitPan(dx: number, dy: number): void {
    this.renderer.handlePan(dx, dy);
  }

  handleOrbitPinch(scale: number): void {
    this.renderer.handlePinch(scale);
  }

  handleOrbitDoubleTap(): void {
    this.renderer.handleDoubleTap();
  }

  // === AI Delegation ===

  get isAIReady(): boolean {
    return this.runtime?.isAIReady ?? false;
  }

  get isProcessing(): boolean {
    return this.runtime?.isProcessing ?? false;
  }

  getRuntime(): MotebitRuntime | null {
    return this.runtime;
  }

  getRenderer(): WebViewGLAdapter {
    return this.renderer;
  }

  get currentModel(): string | null {
    return this.runtime?.currentModel ?? null;
  }

  setModel(model: string): void {
    if (!this.runtime) throw new Error("AI not initialized — call initAI() first");
    this.runtime.setModel(model);
  }

  // === Messaging ===

  async *sendMessageStreaming(text: string): AsyncGenerator<StreamChunk> {
    if (!this.runtime) throw new Error("AI not initialized — call initAI() first");
    yield* this.runtime.sendMessageStreaming(text);
  }

  async *resumeAfterApproval(approved: boolean): AsyncGenerator<StreamChunk> {
    if (!this.runtime) throw new Error("AI not initialized — call initAI() first");
    yield* this.runtime.resumeAfterApproval(approved);
  }

  async *resolveApprovalVote(approved: boolean, approverId: string): AsyncGenerator<StreamChunk> {
    if (!this.runtime) throw new Error("AI not initialized — call initAI() first");
    yield* this.runtime.resolveApprovalVote(approved, approverId);
  }

  resetConversation(): void {
    this.runtime?.resetConversation();
  }

  /** Get conversation history for rendering previous messages on reopen. */
  getConversationHistory(): Array<{ role: string; content: string }> {
    return this.runtime?.getConversationHistory() ?? [];
  }

  // === Operator Mode ===

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

  // === Policy ===

  updatePolicyConfig(config: Partial<PolicyConfig>): void {
    if (!this.runtime) return;
    this.runtime.updatePolicyConfig(config);
  }

  updateMemoryGovernance(config: Partial<MemoryGovernanceConfig>): void {
    if (!this.runtime) return;
    this.runtime.updateMemoryGovernance(config);
  }

  // === Audio Reactivity ===

  setAudioReactivity(energy: { rms: number; low: number; mid: number; high: number } | null): void {
    this.renderer.setAudioReactivity(energy);
  }

  // === Appearance ===

  setInteriorColor(presetName: string): void {
    const preset = COLOR_PRESETS[presetName];
    if (!preset) return;
    this.renderer.setInteriorColor(preset);
  }

  setInteriorColorDirect(color: InteriorColor): void {
    this.renderer.setInteriorColor(color);
  }

  setDarkEnvironment(): void {
    this.renderer.setDarkEnvironment();
  }

  setLightEnvironment(): void {
    this.renderer.setLightEnvironment();
  }

  // === MCP ===

  async addMcpServer(config: McpServerConfig): Promise<void> {
    if (config.transport !== "http") {
      throw new Error(
        "Mobile only supports HTTP MCP servers. Use the desktop or CLI app for stdio servers.",
      );
    }
    if (config.url == null || config.url === "") {
      throw new Error("HTTP MCP server requires a url");
    }

    // Attach advisory verifier: always accepts, revokes trust on manifest change
    config.serverVerifier = new AdvisoryManifestVerifier();
    const adapter = new McpClientAdapter(config);
    await adapter.connect();

    // Persist verifier-applied config updates
    config.toolManifestHash = adapter.serverConfig.toolManifestHash;
    config.pinnedToolNames = adapter.serverConfig.pinnedToolNames;
    if (adapter.serverConfig.trusted === false) {
      config.trusted = false;
    }

    // Persist motebit public key if newly pinned during connect
    if (adapter.isMotebit && adapter.verifiedIdentity?.verified) {
      const pinnedKey = adapter.serverConfig.motebitPublicKey;
      if (pinnedKey && !config.motebitPublicKey) {
        config.motebitPublicKey = pinnedKey;
      }
    }

    // Register tools with trust-aware approval flags
    this.registerMcpTools(adapter, config);

    this.mcpAdapters.set(config.name, adapter);
    this._mcpServers = this._mcpServers.filter((s) => s.name !== config.name);
    this._mcpServers.push(config);

    // Persist
    await AsyncStorage.setItem(MobileApp.MCP_SERVERS_KEY, JSON.stringify(this._mcpServers));
    this._toolsChangedCallback?.();
  }

  async removeMcpServer(name: string): Promise<void> {
    const adapter = this.mcpAdapters.get(name);
    if (adapter) {
      await adapter.disconnect();
      this.mcpAdapters.delete(name);
    }
    if (this.runtime) {
      this.runtime.unregisterExternalTools(`mcp:${name}`);
    }

    this._mcpServers = this._mcpServers.filter((s) => s.name !== name);
    await AsyncStorage.setItem(MobileApp.MCP_SERVERS_KEY, JSON.stringify(this._mcpServers));
    this._toolsChangedCallback?.();
  }

  getMcpServers(): Array<{
    name: string;
    url: string;
    connected: boolean;
    toolCount: number;
    trusted: boolean;
    motebit: boolean;
    motebitPublicKey?: string;
  }> {
    return this._mcpServers.map((config) => {
      const adapter = this.mcpAdapters.get(config.name);
      return {
        name: config.name,
        url: config.url ?? "",
        connected: adapter?.isConnected ?? false,
        toolCount: adapter?.getTools().length ?? 0,
        trusted: config.trusted ?? false,
        motebit: config.motebit ?? false,
        motebitPublicKey: config.motebitPublicKey,
      };
    });
  }

  /** Toggle trust for an MCP server. Re-registers tools with updated approval requirements. */
  async setMcpServerTrust(name: string, trusted: boolean): Promise<void> {
    const config = this._mcpServers.find((s) => s.name === name);
    if (!config) return;
    config.trusted = trusted;

    // Re-register tools with updated approval flags
    const adapter = this.mcpAdapters.get(name);
    if (adapter && this.runtime) {
      this.runtime.unregisterExternalTools(`mcp:${name}`);
      this.registerMcpTools(adapter, config);
    }

    await AsyncStorage.setItem(MobileApp.MCP_SERVERS_KEY, JSON.stringify(this._mcpServers));
    this._toolsChangedCallback?.();
  }

  onToolsChanged(callback: () => void): void {
    this._toolsChangedCallback = callback;
  }

  /** Register MCP tools into the runtime with trust-aware approval flags. */
  private registerMcpTools(adapter: McpClientAdapter, config: McpServerConfig): void {
    const tempRegistry = new InMemoryToolRegistry();
    for (const mcpTool of adapter.getTools()) {
      const def = {
        name: mcpTool.name,
        description: `[${config.name}] ${mcpTool.description ?? mcpTool.name}`,
        inputSchema: mcpTool.inputSchema ?? { type: "object", properties: {} },
        ...(config.trusted === true ? {} : { requiresApproval: true as const }),
      };
      tempRegistry.register(def, (args: Record<string, unknown>) =>
        adapter.executeTool(mcpTool.name, args),
      );
    }
    if (this.runtime) {
      this.runtime.registerExternalTools(`mcp:${config.name}`, tempRegistry);
    }
  }

  private async reconnectMcpServers(): Promise<void> {
    const raw = await AsyncStorage.getItem(MobileApp.MCP_SERVERS_KEY);
    if (raw == null || raw === "") return;
    try {
      const configs = JSON.parse(raw) as McpServerConfig[];
      this._mcpServers = configs;
      let changed = false;
      for (const config of configs) {
        try {
          config.serverVerifier = new AdvisoryManifestVerifier();
          const adapter = new McpClientAdapter(config);
          await adapter.connect();

          // Persist verifier-applied config updates
          config.toolManifestHash = adapter.serverConfig.toolManifestHash;
          config.pinnedToolNames = adapter.serverConfig.pinnedToolNames;
          if (adapter.serverConfig.trusted === false) {
            config.trusted = false;
          }

          // Persist motebit public key if newly pinned during connect
          if (adapter.isMotebit && adapter.verifiedIdentity?.verified) {
            const pinnedKey = adapter.serverConfig.motebitPublicKey;
            if (pinnedKey && !config.motebitPublicKey) {
              config.motebitPublicKey = pinnedKey;
            }
          }

          this.registerMcpTools(adapter, config);
          this.mcpAdapters.set(config.name, adapter);
          changed = true;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          // eslint-disable-next-line no-console
          console.warn(`Failed to reconnect MCP server "${config.name}": ${msg}`);
        }
      }
      if (changed) {
        // Persist any manifest hash / trust updates
        await AsyncStorage.setItem(MobileApp.MCP_SERVERS_KEY, JSON.stringify(this._mcpServers));
        this._toolsChangedCallback?.();
      }
    } catch {
      // Non-fatal — corrupted storage
    }
  }

  // === Observability ===

  getState(): MotebitState | null {
    return this.runtime?.getState() ?? null;
  }

  getCues(): BehaviorCues | null {
    return this.runtime?.getCues() ?? null;
  }

  getCuriosityTargets(): CuriosityTarget[] {
    return this.runtime?.getCuriosityTargets() ?? [];
  }

  async reflect(): Promise<ReflectionResult> {
    if (!this.runtime) throw new Error("Runtime not initialized");
    return this.runtime.reflect();
  }

  getGradient(): GradientSnapshot | null {
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
    if (!this.runtime) throw new Error("Runtime not initialized");
    return this.runtime.auditMemory();
  }

  async getMemoryGraphStats(): Promise<{
    nodes: MemoryNode[];
    edges: Array<{ source_id: string; target_id: string; relation_type: string }>;
  }> {
    if (!this.runtime) throw new Error("Runtime not initialized");
    return this.runtime.memory.exportAll();
  }

  async listTrustedAgents() {
    if (!this.runtime) return [];
    return this.runtime.listTrustedAgents();
  }

  get hasPendingApproval(): boolean {
    return this.runtime?.hasPendingApproval ?? false;
  }

  get pendingApprovalInfo(): { toolName: string; args: Record<string, unknown> } | null {
    return this.runtime?.pendingApprovalInfo ?? null;
  }

  /** Fetch from relay API with signed token auth. */
  async relayFetch(path: string): Promise<unknown> {
    const syncUrl = await this.getSyncUrl();
    if (!syncUrl) throw new Error("No relay configured — connect in Settings > Sync");
    const token = await this.createSyncToken();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(`${syncUrl}${path}`, { headers });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${res.status}: ${text}`);
    }
    return res.json() as Promise<unknown>;
  }

  subscribe(fn: (state: MotebitState) => void): () => void {
    if (!this.runtime) return () => {};
    return this.runtime.subscribe(fn);
  }

  // === Settings Persistence ===

  async loadSettings(): Promise<MobileSettings> {
    const raw = await AsyncStorage.getItem(SETTINGS_KEY);
    if (raw == null || raw === "") return { ...DEFAULT_SETTINGS };
    try {
      const loaded = { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<MobileSettings>) };
      // Migration: borosilicate was removed — remap to moonlight
      if (loaded.colorPreset === "borosilicate") loaded.colorPreset = "moonlight";
      return loaded;
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  async saveSettings(settings: MobileSettings): Promise<void> {
    await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }

  // === Identity Info ===

  getIdentityInfo(): { motebitId: string; deviceId: string; publicKey: string } {
    return {
      motebitId: this.motebitId,
      deviceId: this.deviceId,
      publicKey: this.publicKey,
    };
  }

  // === Key Rotation ===

  /**
   * Rotate the Ed25519 keypair: generate new keys, create a signed succession
   * record (old + new keys both sign), update identity file, store new private
   * key in expo-secure-store, and submit to relay if configured.
   */
  async rotateKey(reason?: string): Promise<{ newPublicKey: string }> {
    // 1. Load existing private key
    const oldPrivKeyBytes = await this._getPrivKeyBytes();

    try {
      // 2. Derive old public key from the stored hex
      const oldPubKeyHex = this.publicKey;
      if (!oldPubKeyHex) throw new Error("No public key available — bootstrap first");
      const oldPubKeyBytes = new Uint8Array(oldPubKeyHex.length / 2);
      for (let i = 0; i < oldPubKeyHex.length; i += 2) {
        oldPubKeyBytes[i / 2] = parseInt(oldPubKeyHex.slice(i, i + 2), 16);
      }

      // 3. Rotate identity file if it exists (generates keypair + succession internally)
      const existingIdentityFile = await AsyncStorage.getItem(IDENTITY_FILE_KEY);
      let newPubKeyHex: string;
      let newPrivKeyHex: string;
      let successionRecord: unknown;

      if (existingIdentityFile != null && existingIdentityFile !== "") {
        const rotateResult = await rotateIdentityKeys({
          oldPrivateKey: oldPrivKeyBytes,
          oldPublicKey: oldPubKeyBytes,
          reason,
        });
        const rotatedContent = await rotateIdentityFile({
          existingContent: existingIdentityFile,
          newPublicKey: rotateResult.newPublicKey,
          newPrivateKey: rotateResult.newPrivateKey,
          successionRecord: rotateResult.successionRecord,
        });
        await AsyncStorage.setItem(IDENTITY_FILE_KEY, rotatedContent);
        newPubKeyHex = rotateResult.newPublicKeyHex;
        newPrivKeyHex = bytesToHex(rotateResult.newPrivateKey);
        successionRecord = rotateResult.successionRecord;
        secureErase(rotateResult.newPrivateKey);
      } else {
        // No identity file — generate raw keypair for device key rotation only
        const { generateKeypair } = await import("@motebit/crypto");
        const newKeypair = await generateKeypair();
        newPubKeyHex = bytesToHex(newKeypair.publicKey);
        newPrivKeyHex = bytesToHex(newKeypair.privateKey);
        secureErase(newKeypair.privateKey);
      }

      // 4. Store new private key in secure store
      await this.keyring.set("device_private_key", newPrivKeyHex);

      // 5. Update public key in secure store and in-memory
      await this.keyring.set("device_public_key", newPubKeyHex);
      this.publicKey = newPubKeyHex;

      // 6. Submit to relay if configured (best-effort)
      try {
        const syncUrl = await this.getSyncUrl();
        if (syncUrl != null && syncUrl !== "") {
          const token = await this.createSyncToken("device:auth");
          await fetch(`${syncUrl}/api/v1/agents/${this.motebitId}/key-rotation`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              device_id: this.deviceId,
              new_public_key: newPubKeyHex,
              ...(successionRecord != null ? { succession_record: successionRecord } : {}),
            }),
          });
        }
      } catch {
        // Non-fatal — relay notification is best-effort
      }

      return { newPublicKey: newPubKeyHex };
    } finally {
      secureErase(oldPrivKeyBytes);
    }
  }

  // === Governance ===

  get governanceStatus(): { governed: boolean; reason?: string } {
    return this._governanceStatus;
  }

  // === Auto-Titling ===

  /**
   * Auto-generate a conversation title via AI (runtime.autoTitle),
   * with heuristic fallback. Fire-and-forget — matches web/spatial pattern.
   */
  autoTitle(): void {
    void this.runtime?.autoTitle();
  }

  /** Manually trigger conversation summarization. */
  async summarizeConversation(): Promise<string | null> {
    if (!this.runtime) return null;
    return this.runtime.summarizeCurrentConversation();
  }

  // === Memory Browser ===

  /** List all non-tombstoned memories, sorted by created_at DESC. */
  async listMemories(): Promise<MemoryNode[]> {
    if (!this.runtime) return [];
    try {
      const { nodes } = await this.runtime.memory.exportAll();
      const now = Date.now();
      return nodes
        .filter((n: MemoryNode) => !n.tombstoned && (n.valid_until == null || n.valid_until > now))
        .sort((a: MemoryNode, b: MemoryNode) => b.created_at - a.created_at);
    } catch {
      return [];
    }
  }

  /** Soft-delete a memory with audit trail. */
  async deleteMemory(nodeId: string): Promise<void> {
    if (!this.runtime) return;
    await this.runtime.memory.deleteMemory(nodeId);
  }

  /** Compute effective confidence after half-life decay. */
  getDecayedConfidence(node: MemoryNode): number {
    return computeDecayedConfidence(node.confidence, node.half_life, Date.now() - node.created_at);
  }

  // === Conversation Browsing ===

  /** List recent conversations. */
  listConversations(limit?: number): Array<{
    conversationId: string;
    startedAt: number;
    lastActiveAt: number;
    title: string | null;
    messageCount: number;
  }> {
    if (!this.runtime) return [];
    return this.runtime.listConversations(limit ?? 20);
  }

  /** Load a past conversation by ID — replaces the current chat. Returns the message list. */
  loadConversationById(conversationId: string): Array<{ role: string; content: string }> {
    if (!this.runtime) return [];
    this.runtime.loadConversation(conversationId);
    return this.runtime.getConversationHistory();
  }

  /** Start a new conversation (clears current). */
  startNewConversation(): void {
    this.runtime?.resetConversation();
  }

  /** Get the current conversation ID. */
  get currentConversationId(): string | null {
    return this.runtime?.getConversationId() ?? null;
  }

  // === Identity File ===

  /** Get the stored identity file content. */
  async getIdentityFile(): Promise<string | null> {
    return AsyncStorage.getItem(IDENTITY_FILE_KEY);
  }

  async exportAllData(): Promise<string> {
    const data: Record<string, unknown> = {
      motebit_id: this.motebitId,
      device_id: this.deviceId,
      public_key: this.publicKey,
      exported_at: new Date().toISOString(),
    };

    // Include identity file if available
    try {
      const identityFile = await AsyncStorage.getItem(IDENTITY_FILE_KEY);
      if (identityFile != null && identityFile !== "") {
        data.identity_file = identityFile;
      }
    } catch {
      // Non-fatal
    }

    // Include all non-tombstoned memories
    if (this.runtime) {
      try {
        const { nodes, edges } = await this.runtime.memory.exportAll();
        data.memories = nodes;
        data.edges = edges;
      } catch {
        // Non-fatal
      }

      // Include recent events
      try {
        const events = await this.runtime.events.query({
          motebit_id: this.motebitId,
          limit: 500,
        });
        data.events = events;
      } catch {
        // Non-fatal
      }

      // Include current state vector
      try {
        const state = this.runtime.getState();
        if (state != null) {
          data.state = state;
        }
      } catch {
        // Non-fatal
      }

      // Include conversation count
      try {
        const conversations = this.runtime.listConversations();
        data.conversation_count = conversations.length;
      } catch {
        // Non-fatal
      }
    }

    return JSON.stringify(data, null, 2);
  }

  // === Pairing: Device A (existing device) ===

  private async _getPrivKeyBytes(): Promise<Uint8Array> {
    const privKeyHex = await this.keyring.get("device_private_key");
    if (privKeyHex == null || privKeyHex === "") throw new Error("No device private key available");
    const bytes = new Uint8Array(privKeyHex.length / 2);
    for (let i = 0; i < privKeyHex.length; i += 2) {
      bytes[i / 2] = parseInt(privKeyHex.slice(i, i + 2), 16);
    }
    return bytes;
  }

  private async createSyncToken(aud: string = "sync"): Promise<string> {
    const privKeyBytes = await this._getPrivKeyBytes();

    try {
      return await createSignedToken(
        {
          mid: this.motebitId,
          did: this.deviceId,
          iat: Date.now(),
          exp: Date.now() + 5 * 60 * 1000,
          jti: crypto.randomUUID(),
          aud,
        },
        privKeyBytes,
      );
    } finally {
      secureErase(privKeyBytes);
    }
  }

  async initiatePairing(syncUrl: string): Promise<{ pairingCode: string; pairingId: string }> {
    const token = await this.createSyncToken("device:auth");
    const client = new PairingClient({ relayUrl: syncUrl });
    const result = await client.initiate(token);
    return { pairingCode: result.pairingCode, pairingId: result.pairingId };
  }

  async getPairingSession(syncUrl: string, pairingId: string): Promise<PairingSession> {
    const token = await this.createSyncToken("device:auth");
    const client = new PairingClient({ relayUrl: syncUrl });
    return client.getSession(pairingId, token);
  }

  async approvePairing(syncUrl: string, pairingId: string): Promise<{ deviceId: string }> {
    const token = await this.createSyncToken("device:auth");
    const client = new PairingClient({ relayUrl: syncUrl });
    const result = await client.approve(pairingId, token);
    return { deviceId: result.deviceId };
  }

  async denyPairing(syncUrl: string, pairingId: string): Promise<void> {
    const token = await this.createSyncToken("device:auth");
    const client = new PairingClient({ relayUrl: syncUrl });
    await client.deny(pairingId, token);
  }

  // === Pairing: Device B (new device) ===

  async claimPairing(
    syncUrl: string,
    code: string,
  ): Promise<{ pairingId: string; motebitId: string }> {
    if (!this.publicKey) throw new Error("No public key available — bootstrap first");
    const client = new PairingClient({ relayUrl: syncUrl });
    return client.claim(code.toUpperCase(), "Mobile", this.publicKey);
  }

  async pollPairingStatus(syncUrl: string, pairingId: string): Promise<PairingStatus> {
    const client = new PairingClient({ relayUrl: syncUrl });
    return client.pollStatus(pairingId);
  }

  async completePairing(
    result: { motebitId: string; deviceId: string },
    syncUrl?: string,
  ): Promise<void> {
    await this.keyring.set("motebit_id", result.motebitId);
    await this.keyring.set("device_id", result.deviceId);

    // Auth uses signed JWTs — no device_token storage needed

    this.motebitId = result.motebitId;
    this.deviceId = result.deviceId;

    if (syncUrl != null && syncUrl !== "") {
      await this.setSyncUrl(syncUrl);
    }
  }

  // === Sync ===

  private static readonly SYNC_URL_KEY = "@motebit/sync_url";
  private static readonly SYNC_INTERVAL_MS = 30_000;

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

  async getSyncUrl(): Promise<string | null> {
    return AsyncStorage.getItem(MobileApp.SYNC_URL_KEY);
  }

  async setSyncUrl(url: string): Promise<void> {
    await AsyncStorage.setItem(MobileApp.SYNC_URL_KEY, url);
  }

  async clearSyncUrl(): Promise<void> {
    await AsyncStorage.removeItem(MobileApp.SYNC_URL_KEY);
  }

  async startServing(): Promise<{ ok: boolean; error?: string }> {
    if (!this.runtime || !this._servingSyncUrl || !this._servingAuthToken) {
      return { ok: false, error: "Sync not connected" };
    }
    if (this._serving) return { ok: true };

    const LOCAL_ONLY = new Set([
      "read_file",
      "recall_memories",
      "list_events",
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

  async startSync(syncUrl?: string): Promise<void> {
    const url = syncUrl != null && syncUrl !== "" ? syncUrl : await this.getSyncUrl();
    if (url == null || url === "" || !this.storage) return;

    await this.setSyncUrl(url);

    // Derive encryption key once for the sync session, then erase raw key bytes
    const privKeyBytes = await this._getPrivKeyBytes();
    this._syncEncKey = await deriveSyncEncryptionKey(privKeyBytes);
    secureErase(privKeyBytes);

    // Create engines (they don't start their own timers — we manage the interval
    // ourselves so we can refresh the auth token each cycle)
    this.syncEngine = new SyncEngine(this.storage.eventStore, this.motebitId, {
      sync_interval_ms: MobileApp.SYNC_INTERVAL_MS,
    });

    this.conversationSyncEngine = new ConversationSyncEngine(
      this.storage.conversationSyncStore,
      this.motebitId,
      { sync_interval_ms: MobileApp.SYNC_INTERVAL_MS },
    );

    this._syncStatus = "idle";
    this._syncStatusCallback?.("idle", this._lastSyncTime);

    // Run the sync loop via our own timer (to refresh tokens per cycle)
    this.syncTimer = setInterval(() => {
      void this.syncCycle(url);
    }, MobileApp.SYNC_INTERVAL_MS);

    // Immediate first sync after short delay (let initialization settle)
    setTimeout(() => void this.syncCycle(url), 3000);

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
    } catch {
      return;
    }
    if (!this.runtime) return;

    try {
      const token = await this.createSyncToken("task:submit");
      if (!token) return;

      const result = await cmdSelfTest(this.runtime, {
        relay: { relayUrl: syncUrl, authToken: token, motebitId: this.motebitId },
        mintToken: async () => this.createSyncToken("task:submit"),
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
    if (url == null || url === "" || !this.storage) throw new Error("No sync relay configured");

    const token = await this.createSyncToken();

    // Event sync
    const eventAdapter = new HttpEventStoreAdapter({
      baseUrl: url,
      motebitId: this.motebitId,
      authToken: token,
    });
    const tempEventSync = new SyncEngine(this.storage.eventStore, this.motebitId);
    tempEventSync.connectRemote(eventAdapter);
    const eventResult = await tempEventSync.sync();

    // Conversation sync (encrypted — relay stores opaque ciphertext)
    const convHttpAdapter = new HttpConversationSyncAdapter({
      baseUrl: url,
      motebitId: this.motebitId,
      authToken: token,
    });
    const tempConvSync = new ConversationSyncEngine(
      this.storage.conversationSyncStore,
      this.motebitId,
    );
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

    this._syncStatus = "syncing";
    this._syncStatusCallback?.("syncing", this._lastSyncTime);

    try {
      const token = await this.createSyncToken();
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
        motebitId: this.motebitId,
        authToken: token,
      });

      if (encKey) {
        const encryptedHttp = new EncryptedEventStoreAdapter({ inner: httpAdapter, key: encKey });
        const wsUrl =
          syncUrl.replace(/^https?/, (m) => (m === "https" ? "wss" : "ws")) +
          "/ws/sync/" +
          this.motebitId;

        const localEventStore = this._localEventStore;
        const mobileCapabilities = [DeviceCapability.HttpMcp, DeviceCapability.Keyring];
        const wsAdapter = new WebSocketEventStoreAdapter({
          url: wsUrl,
          motebitId: this.motebitId,
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
        if (this.runtime) {
          const delegationAdapter = new RelayDelegationAdapter({
            syncUrl,
            motebitId: this.motebitId,
            authToken: token ?? undefined,
            sendRaw: (data: string) => wsAdapter.sendRaw(data),
            onCustomMessage: (cb) => wsAdapter.onCustomMessage(cb),
            getExplorationDrive: () => this.runtime?.getPrecision().explorationDrive,
          });
          this.runtime.setDelegationAdapter(delegationAdapter);

          // Enable interactive delegation — lets the AI transparently delegate
          // tasks to remote agents during conversation.
          this.runtime.enableInteractiveDelegation({
            syncUrl,
            authToken: () => this.createSyncToken("task:submit"),
          });

          // Store serving state
          this._servingSyncUrl = syncUrl;
          this._servingAuthToken = token ?? null;

          // Wire task handler — accept delegations while the app is open.
          wsAdapter.onCustomMessage((msg) => {
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
            if (!this.runtime) return;

            const task = msg.task as AgentTask;
            const runtime = this.runtime;

            this._wsAdapter?.sendRaw(JSON.stringify({ type: "task_claim", task_id: task.task_id }));
            this._activeTaskCount++;

            void (async () => {
              try {
                const privKeyHex = await this.keyring.get("device_private_key");
                if (!privKeyHex) return;
                const privKeyBytes = new Uint8Array(privKeyHex.length / 2);
                for (let i = 0; i < privKeyHex.length; i += 2) {
                  privKeyBytes[i / 2] = parseInt(privKeyHex.slice(i, i + 2), 16);
                }

                let receipt: ExecutionReceipt | undefined;
                for await (const chunk of runtime.handleAgentTask(
                  task,
                  privKeyBytes,
                  this.deviceId,
                  undefined,
                  { delegatedScope: task.delegated_scope },
                )) {
                  if (chunk.type === "task_result") {
                    receipt = chunk.receipt;
                  }
                }

                if (receipt && this._servingSyncUrl) {
                  const freshToken = await this.createSyncToken("task:submit");
                  await fetch(
                    `${this._servingSyncUrl}/agent/${this.motebitId}/task/${task.task_id}/result`,
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
        if (this.runtime) {
          void (async () => {
            try {
              for await (const _chunk of this.runtime!.recoverDelegatedSteps()) {
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
        motebitId: this.motebitId,
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
      if (this.storage?.planStore) {
        try {
          const planSyncStore = new ExpoPlanSyncStoreAdapter(
            this.storage.planStore,
            this.motebitId,
          );
          const planSync = new PlanSyncEngine(planSyncStore, this.motebitId);
          const httpPlanAdapter = new HttpPlanSyncAdapter({
            baseUrl: syncUrl,
            motebitId: this.motebitId,
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

  // === Goal Scheduler ===

  /** Get the goal store for direct UI access (listing, adding, removing goals). */
  getGoalStore(): ExpoGoalStore | null {
    return this.storage?.goalStore ?? null;
  }

  get isGoalExecuting(): boolean {
    return this._goalExecuting;
  }

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

  /**
   * Start background goal scheduling. Checks for active goals every 60s and
   * executes them in the background without interrupting the user's chat.
   */
  startGoalScheduler(): void {
    if (this.goalSchedulerTimer) return;
    this.goalSchedulerTimer = setInterval(() => {
      void this.goalTick();
    }, 60_000);
    // Run first tick after a short delay (let UI settle)
    setTimeout(() => {
      void this.goalTick();
    }, 5_000);
  }

  stopGoalScheduler(): void {
    if (this.goalSchedulerTimer) {
      clearInterval(this.goalSchedulerTimer);
      this.goalSchedulerTimer = null;
    }
    // Final housekeeping on stop
    void this.runtime?.housekeeping();
  }

  /**
   * Resume a goal after the user approves/denies a tool call.
   * Streams the continuation back so App.tsx can render it into chat.
   * After streaming completes, records the goal outcome and cleans up.
   */
  async *resumeGoalAfterApproval(approved: boolean): AsyncGenerator<StreamChunk> {
    if (!this.runtime) throw new Error("AI not initialized");
    if (!this._pendingGoalApproval) throw new Error("No pending goal approval");

    const goalStore = this.storage?.goalStore;
    if (!goalStore) throw new Error("Goal store not available");

    const { goalId, prompt, mode, planId } = this._pendingGoalApproval;

    try {
      let accumulated = "";

      // Phase 1: Complete the current step via runtime approval resume
      for await (const chunk of this.runtime.resumeAfterApproval(approved)) {
        if (chunk.type === "text") {
          accumulated += chunk.text;
        }
        yield chunk;
      }

      // Phase 2: If plan-based goal, resume remaining plan steps
      if (planId != null && planId !== "" && this.planEngine != null) {
        const loopDeps = this.runtime.getLoopDeps();
        if (loopDeps) {
          const planResult = await this.consumePlanStream(
            this.planEngine.resumePlan(planId, loopDeps),
            { goal_id: goalId, prompt, mode },
            planId,
          );
          accumulated += planResult.summary;
          if (planResult.suspended) return; // Another approval needed
        }
      }

      // Record outcome
      const now = Date.now();
      this.finishGoalSuccess({ goal_id: goalId, prompt, mode }, accumulated.slice(0, 500), now);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.finishGoalFailure({ goal_id: goalId, prompt, mode }, msg, Date.now());
      throw err;
    } finally {
      this._goalExecuting = false;
      this._currentGoalId = null;
      this._goalStatusCallback?.(false);
      this._pendingGoalApproval = null;
      this.runtime?.resetConversation();
    }
  }

  private async goalTick(): Promise<void> {
    if (!this.runtime || this._goalExecuting || this.runtime.isProcessing) return;

    const goalStore = this.storage?.goalStore;
    if (!goalStore) return;

    // Periodic housekeeping (every 10 ticks ≈ 10 min at 60s default)
    this.goalTickCount++;
    if (this.goalTickCount % 10 === 0) {
      void this.runtime.housekeeping();
    }

    try {
      const goals = goalStore.listActiveGoals(this.motebitId);
      if (goals.length === 0) return;

      const now = Date.now();
      for (const goal of goals) {
        const elapsed = goal.last_run_at != null ? now - goal.last_run_at : Infinity;
        if (elapsed < goal.interval_ms) continue;
        if (this.runtime.isProcessing) break;

        this._goalExecuting = true;
        this._currentGoalId = goal.goal_id;
        this._goalStatusCallback?.(true);

        try {
          const outcomes = goalStore.getRecentOutcomes(goal.goal_id, 3);
          const loopDeps = this.runtime.getLoopDeps();

          // Plan-based execution when PlanEngine is available
          if (this.planEngine && loopDeps) {
            const result = await this.executePlanGoal(goal, outcomes);
            if (result.suspended) return; // Waiting for approval
            this.finishGoalSuccess(goal, result.summary, now);
          } else {
            // Fallback: single-turn streaming
            const result = await this.executeSingleTurnGoal(goal, outcomes, now);
            if (result.suspended) return;
            this.finishGoalSuccess(goal, result.summary, now);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.finishGoalFailure(goal, msg, now);
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

  /** Execute a goal with PlanEngine multi-step decomposition. */
  private async executePlanGoal(
    goal: { goal_id: string; prompt: string; mode: string },
    outcomes: Array<{
      ran_at: number;
      status: string;
      summary: string | null;
      error_message: string | null;
    }>,
  ): Promise<{ suspended: boolean; summary: string }> {
    const loopDeps = this.runtime!.getLoopDeps()!;
    const planStore = this.storage!.planStore;
    const registry = this.runtime!.getToolRegistry();

    // Check for existing active plan (resume interrupted plan)
    let plan = planStore.getPlanForGoal(goal.goal_id);
    let planStream: AsyncGenerator<PlanChunk>;

    if (plan && plan.status === PlanStatus.Active) {
      planStream = this.planEngine!.resumePlan(plan.plan_id, loopDeps);
    } else {
      const created = await this.planEngine!.createPlan(
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
      plan = created.plan;
      planStream = this.planEngine!.executePlan(created.plan.plan_id, loopDeps);
    }

    return this.consumePlanStream(planStream, goal, plan.plan_id);
  }

  /** Consume a PlanEngine stream, handling approval requests. */
  private async consumePlanStream(
    stream: AsyncGenerator<PlanChunk>,
    goal: { goal_id: string; prompt: string; mode: string },
    planId: string,
  ): Promise<{ suspended: boolean; summary: string }> {
    let accumulated = "";

    for await (const chunk of stream) {
      switch (chunk.type) {
        case "step_chunk":
          if (chunk.chunk.type === "text") {
            accumulated += chunk.chunk.text;
          }
          break;
        case "approval_request": {
          this._pendingGoalApproval = {
            goalId: goal.goal_id,
            prompt: goal.prompt,
            mode: goal.mode,
            planId,
          };
          this._goalApprovalCallback?.({
            goalId: goal.goal_id,
            goalPrompt: goal.prompt,
            toolName: chunk.chunk.type === "approval_request" ? chunk.chunk.name : "unknown",
            args: chunk.chunk.type === "approval_request" ? chunk.chunk.args : {},
            riskLevel: chunk.chunk.type === "approval_request" ? chunk.chunk.risk_level : undefined,
          });
          return { suspended: true, summary: accumulated.slice(0, 500) };
        }
        case "plan_completed":
        case "plan_failed":
          break;
      }
    }

    return { suspended: false, summary: accumulated.slice(0, 500) };
  }

  /** Execute a goal with simple single-turn streaming (fallback). */
  private async executeSingleTurnGoal(
    goal: { goal_id: string; prompt: string; mode: string },
    outcomes: Array<{
      ran_at: number;
      status: string;
      summary: string | null;
      error_message: string | null;
    }>,
    now: number,
  ): Promise<{ suspended: boolean; summary: string }> {
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
    for await (const chunk of this.runtime!.sendMessageStreaming(context)) {
      if (chunk.type === "text") {
        accumulated += chunk.text;
      } else if (chunk.type === "approval_request") {
        this._pendingGoalApproval = {
          goalId: goal.goal_id,
          prompt: goal.prompt,
          mode: goal.mode,
        };
        this._goalApprovalCallback?.({
          goalId: goal.goal_id,
          goalPrompt: goal.prompt,
          toolName: chunk.name,
          args: chunk.args,
          riskLevel: chunk.risk_level,
        });
        return { suspended: true, summary: accumulated.slice(0, 500) };
      }
    }

    return { suspended: false, summary: accumulated.slice(0, 500) };
  }

  private finishGoalSuccess(
    goal: { goal_id: string; prompt: string; mode: string },
    summary: string,
    now: number,
  ): void {
    const goalStore = this.storage?.goalStore;
    if (!goalStore) return;

    goalStore.updateLastRun(goal.goal_id, now);
    goalStore.resetFailures(goal.goal_id);

    goalStore.insertOutcome({
      outcome_id: crypto.randomUUID(),
      goal_id: goal.goal_id,
      motebit_id: this.motebitId,
      ran_at: now,
      status: "completed",
      summary,
      tool_calls_made: 0,
      memories_formed: 0,
      error_message: null,
    });

    if (goal.mode === "once") {
      goalStore.setStatus(goal.goal_id, "completed");
    }

    this._goalCompleteCallback?.({
      goalId: goal.goal_id,
      prompt: goal.prompt,
      status: "completed",
      summary: summary.slice(0, 200),
      error: null,
    });
  }

  private finishGoalFailure(
    goal: { goal_id: string; prompt: string; mode: string },
    error: string,
    now: number,
  ): void {
    const goalStore = this.storage?.goalStore;
    if (!goalStore) return;

    try {
      goalStore.insertOutcome({
        outcome_id: crypto.randomUUID(),
        goal_id: goal.goal_id,
        motebit_id: this.motebitId,
        ran_at: now,
        status: "failed",
        summary: null,
        tool_calls_made: 0,
        memories_formed: 0,
        error_message: error,
      });
    } catch {
      /* non-fatal */
    }

    try {
      goalStore.incrementFailures(goal.goal_id);
    } catch {
      /* non-fatal */
    }

    this._goalCompleteCallback?.({
      goalId: goal.goal_id,
      prompt: goal.prompt,
      status: "failed",
      summary: null,
      error,
    });
  }

  /**
   * Export a signed motebit.md identity file as a string.
   * The React Native UI layer can present this via Share sheet or clipboard.
   * Returns null if identity is not bootstrapped or private key unavailable.
   */
  async exportIdentity(): Promise<string | null> {
    if (this.motebitId === "mobile-local") return null;

    const privKeyHex = await this.keyring.get("device_private_key");
    if (privKeyHex == null || privKeyHex === "") return null;

    const privKeyBytes = new Uint8Array(privKeyHex.length / 2);
    for (let i = 0; i < privKeyHex.length; i += 2) {
      privKeyBytes[i / 2] = parseInt(privKeyHex.slice(i, i + 2), 16);
    }

    try {
      return await generateIdentityFile(
        {
          motebitId: this.motebitId,
          ownerId: this.motebitId,
          publicKeyHex: this.publicKey,
          devices: [
            {
              device_id: this.deviceId,
              name: "Mobile",
              public_key: this.publicKey,
              registered_at: new Date().toISOString(),
            },
          ],
        },
        privKeyBytes,
      );
    } finally {
      secureErase(privKeyBytes);
    }
  }
}

/**
 * Bridges ExpoPlanStore (sync SQLite) to PlanSyncStoreAdapter for plan sync.
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
