/**
 * @motebit/mobile — MobileApp platform shell
 *
 * Wraps MotebitRuntime with Expo-specific adapters:
 * - expo-secure-store for keyring (iOS Keychain / Android Keystore)
 * - expo-sqlite for persistent storage
 * - expo-gl for Three.js rendering
 * - AsyncStorage for non-secret settings
 *
 * Modeled on DesktopApp / SpatialApp — same pattern, different adapters.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { MotebitRuntime } from "@motebit/runtime";
import type {
  StreamChunk,
  OperatorModeResult,
  InteriorColor,
  PolicyConfig,
  MemoryGovernanceConfig,
} from "@motebit/runtime";
import { CloudProvider, OllamaProvider, HybridProvider } from "@motebit/ai-core";
import { createSignedToken } from "@motebit/crypto";
import {
  bootstrapIdentity as sharedBootstrapIdentity,
  type BootstrapConfigStore,
  type BootstrapKeyStore,
} from "@motebit/core-identity";
import {
  PairingClient,
  SyncEngine,
  HttpEventStoreAdapter,
  ConversationSyncEngine,
  HttpConversationSyncAdapter,
} from "@motebit/sync-engine";
import { McpClientAdapter } from "@motebit/mcp-client";
import type { McpServerConfig } from "@motebit/mcp-client";
export type { McpServerConfig } from "@motebit/mcp-client";
export type { MemoryNode } from "@motebit/sdk";
import { InMemoryToolRegistry } from "@motebit/tools";
import { PlanEngine } from "@motebit/planner";
import type { PlanChunk } from "@motebit/planner";
import { PlanStatus } from "@motebit/sdk";
import type { PairingSession, PairingStatus, SyncStatus } from "@motebit/sync-engine";
import type { MotebitState, BehaviorCues, MemoryNode } from "@motebit/sdk";
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
  DuckDuckGoSearchProvider,
  createSubGoalDefinition,
  completeGoalDefinition,
  reportProgressDefinition,
} from "@motebit/tools/web-safe";
import type { EventFilter } from "@motebit/event-log";
import type { EventType } from "@motebit/sdk";
import {
  generate as generateIdentityFile,
  parse as parseIdentityFile,
  governanceToPolicyConfig,
} from "@motebit/identity-file";
import { createExpoStorage, ExpoGoalStore, ExpoSqliteConversationStore } from "./adapters/expo-sqlite";
import type { ExpoStorageResult } from "./adapters/expo-sqlite";
import { ExpoGLAdapter } from "./adapters/expo-gl";
import { SecureStoreAdapter } from "./adapters/secure-store";

// === Color Presets (same 8 as desktop) ===

export const COLOR_PRESETS: Record<string, InteriorColor> = {
  borosilicate: { tint: [0.9, 0.92, 1.0], glow: [0.6, 0.7, 0.9] },
  amber:        { tint: [1.0, 0.85, 0.6], glow: [0.9, 0.7, 0.3] },
  rose:         { tint: [1.0, 0.82, 0.88], glow: [0.9, 0.5, 0.6] },
  violet:       { tint: [0.88, 0.8, 1.0], glow: [0.6, 0.4, 0.9] },
  cyan:         { tint: [0.8, 0.95, 1.0], glow: [0.3, 0.8, 0.9] },
  ember:        { tint: [1.0, 0.75, 0.65], glow: [0.9, 0.35, 0.2] },
  sage:         { tint: [0.82, 0.95, 0.85], glow: [0.4, 0.75, 0.5] },
  moonlight:    { tint: [0.95, 0.95, 1.0], glow: [0.8, 0.85, 1.0] },
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
  provider: "ollama" | "anthropic" | "hybrid";
  model: string;
  ollamaEndpoint: string;
  colorPreset: string;
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
}

const DEFAULT_SETTINGS: MobileSettings = {
  provider: "ollama",
  model: "llama3.2",
  ollamaEndpoint: "http://localhost:11434",
  colorPreset: "borosilicate",
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
};

const SETTINGS_KEY = "@motebit/settings";
const IDENTITY_FILE_KEY = "@motebit/identity_file";

// === AI Config ===

export interface MobileAIConfig {
  provider: "ollama" | "anthropic" | "hybrid";
  model?: string;
  apiKey?: string;
  ollamaEndpoint?: string;
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
    case "m": return n * 60_000;
    case "h": return n * 3_600_000;
    case "d": return n * 86_400_000;
    case "w": return n * 604_800_000;
    default: return 3_600_000;
  }
}

// === MobileApp ===

export class MobileApp {
  private runtime: MotebitRuntime | null = null;
  private storage: ExpoStorageResult | null = null;
  private renderer: ExpoGLAdapter;
  private keyring: SecureStoreAdapter;

  // Governance status
  private _governanceStatus: { governed: boolean; reason?: string } = { governed: false, reason: "not initialized" };

  // Sync state
  private syncEngine: SyncEngine | null = null;
  private conversationSyncEngine: ConversationSyncEngine | null = null;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private _syncStatus: SyncStatus = "offline";
  private _syncStatusCallback: ((status: SyncStatus, lastSync: number) => void) | null = null;
  private _lastSyncTime = 0;

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

  constructor() {
    this.renderer = new ExpoGLAdapter();
    this.keyring = new SecureStoreAdapter();
  }

  // === Identity ===

  async bootstrap(): Promise<MobileBootstrapResult> {
    const keyring = this.keyring;

    const configStore: BootstrapConfigStore = {
      async read() {
        const mid = await keyring.get("motebit_id");
        if (!mid) return null;
        return {
          motebit_id: mid,
          device_id: (await keyring.get("device_id")) || "",
          device_public_key: (await keyring.get("device_public_key")) || "",
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
        if (privKeyHex) {
          const privKeyBytes = new Uint8Array(privKeyHex.length / 2);
          for (let i = 0; i < privKeyHex.length; i += 2) {
            privKeyBytes[i / 2] = parseInt(privKeyHex.slice(i, i + 2), 16);
          }
          const identityFileContent = await generateIdentityFile(
            {
              motebitId: result.motebitId,
              ownerId: result.motebitId,
              publicKeyHex: result.publicKeyHex,
              devices: [{
                device_id: result.deviceId,
                name: "Mobile",
                public_key: result.publicKeyHex,
                registered_at: new Date().toISOString(),
              }],
            },
            privKeyBytes,
          );
          await AsyncStorage.setItem(IDENTITY_FILE_KEY, identityFileContent);
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

  // === AI ===

  async initAI(config: MobileAIConfig): Promise<boolean> {
    let provider;
    if (config.provider === "ollama") {
      const model = config.model || "llama3.2";
      const base_url = config.ollamaEndpoint || "http://localhost:11434";
      provider = new OllamaProvider({ model, base_url, max_tokens: 1024 });
    } else if (config.provider === "hybrid") {
      if (!config.apiKey) return false;
      const model = config.model || "claude-sonnet-4-20250514";
      provider = new HybridProvider({
        cloud: {
          provider: "anthropic",
          api_key: config.apiKey,
          model,
          base_url: "https://api.anthropic.com",
          max_tokens: 1024,
        },
        ollama: {
          model: "llama3.2",
          base_url: config.ollamaEndpoint || "http://localhost:11434",
          max_tokens: 1024,
        },
        fallback_to_local: true,
      });
    } else {
      if (!config.apiKey) return false;
      const model = config.model || "claude-sonnet-4-20250514";
      provider = new CloudProvider({
        provider: "anthropic",
        api_key: config.apiKey,
        model,
        base_url: "https://api.anthropic.com",
        max_tokens: 1024,
      });
    }

    const storage = this.storage ?? createExpoStorage("motebit.db");

    // Read governance from identity file if available
    let policyConfig: Partial<PolicyConfig> | undefined;
    try {
      const identityFileContent = await AsyncStorage.getItem(IDENTITY_FILE_KEY);
      if (identityFileContent) {
        const parsed = parseIdentityFile(identityFileContent);
        const gov = parsed.frontmatter.governance;
        if (gov?.max_risk_auto && gov?.require_approval_above && gov?.deny_above) {
          const govPolicy = governanceToPolicyConfig(gov);
          policyConfig = {
            maxRiskLevel: govPolicy.maxRiskAuto,
            requireApprovalAbove: govPolicy.requireApprovalAbove,
            denyAbove: govPolicy.denyAbove,
          };
          this._governanceStatus = { governed: true };
        } else {
          this._governanceStatus = { governed: false, reason: "incomplete governance in identity file" };
        }
      } else {
        this._governanceStatus = { governed: false, reason: "no identity file" };
      }
    } catch {
      // Non-fatal — governance parsing is best-effort
      this._governanceStatus = { governed: false, reason: "identity file parse error" };
    }

    this.runtime = new MotebitRuntime(
      { motebitId: this.motebitId, tickRateHz: 2, policy: policyConfig },
      { storage, renderer: this.renderer, ai: provider, keyring: this.keyring },
    );

    // Create PlanEngine for multi-step goal execution
    if (storage.planStore) {
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
        if (eventType) {
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

    // Goal management tools (available during goal execution)
    const goalStore = this.storage?.goalStore;
    registry.register(createSubGoalDefinition, (args: Record<string, unknown>) => {
      if (!this._currentGoalId || !goalStore) {
        return Promise.resolve({ ok: false, error: "No active goal context" });
      }
      const prompt = args.prompt as string;
      const interval = args.interval as string | undefined;
      const once = args.once as boolean | undefined;
      const intervalMs = interval ? parseInterval(interval) : 3_600_000;
      const mode = once ? "once" : "recurring";
      const subGoalId = goalStore.addGoal(this.motebitId, prompt, intervalMs, mode);
      return Promise.resolve({ ok: true, data: { goal_id: subGoalId, prompt, mode, interval_ms: intervalMs } });
    });

    registry.register(completeGoalDefinition, (args: Record<string, unknown>) => {
      if (!this._currentGoalId || !goalStore) {
        return Promise.resolve({ ok: false, error: "No active goal context" });
      }
      const reason = args.reason as string;
      goalStore.setStatus(this._currentGoalId, "completed");
      return Promise.resolve({ ok: true, data: { goal_id: this._currentGoalId, status: "completed", reason } });
    });

    registry.register(reportProgressDefinition, (args: Record<string, unknown>) => {
      if (!this._currentGoalId) {
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
        cues: { hover_distance: 0.4, drift_amplitude: 0.02, glow_intensity: 0.3, eye_dilation: 0.3, smile_curvature: 0 },
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

  // === MCP ===

  async addMcpServer(config: McpServerConfig): Promise<void> {
    if (config.transport !== "http") {
      throw new Error("Mobile only supports HTTP MCP servers. Use the desktop or CLI app for stdio servers.");
    }
    if (!config.url) {
      throw new Error("HTTP MCP server requires a url");
    }

    const adapter = new McpClientAdapter(config);
    await adapter.connect();

    // Manifest pinning: pin hash on first connect, revoke trust on mismatch
    const manifestResult = await adapter.checkManifest(config.toolManifestHash, config.pinnedToolNames);
    if (!manifestResult.ok) {
      config.trusted = false; // Tools changed — revoke trust
    }
    config.toolManifestHash = manifestResult.hash;
    config.pinnedToolNames = manifestResult.toolNames;

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

  getMcpServers(): Array<{ name: string; url: string; connected: boolean; toolCount: number; trusted: boolean }> {
    return this._mcpServers.map((config) => {
      const adapter = this.mcpAdapters.get(config.name);
      return {
        name: config.name,
        url: config.url || "",
        connected: adapter?.isConnected ?? false,
        toolCount: adapter?.getTools().length ?? 0,
        trusted: config.trusted ?? false,
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
        inputSchema: (mcpTool.inputSchema ?? { type: "object", properties: {} }),
        ...(config.trusted ? {} : { requiresApproval: true as const }),
      };
      tempRegistry.register(def, (args: Record<string, unknown>) => adapter.executeTool(mcpTool.name, args));
    }
    if (this.runtime) {
      this.runtime.registerExternalTools(`mcp:${config.name}`, tempRegistry);
    }
  }

  private async reconnectMcpServers(): Promise<void> {
    const raw = await AsyncStorage.getItem(MobileApp.MCP_SERVERS_KEY);
    if (!raw) return;
    try {
      const configs = JSON.parse(raw) as McpServerConfig[];
      this._mcpServers = configs;
      let changed = false;
      for (const config of configs) {
        try {
          const adapter = new McpClientAdapter(config);
          await adapter.connect();

          // Check manifest integrity on reconnect
          const manifestResult = await adapter.checkManifest(config.toolManifestHash, config.pinnedToolNames);
          if (!manifestResult.ok) {
            config.trusted = false;
          }
          config.toolManifestHash = manifestResult.hash;
          config.pinnedToolNames = manifestResult.toolNames;

          this.registerMcpTools(adapter, config);
          this.mcpAdapters.set(config.name, adapter);
          changed = true;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
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

  subscribe(fn: (state: MotebitState) => void): () => void {
    if (!this.runtime) return () => {};
    return this.runtime.subscribe(fn);
  }

  // === Settings Persistence ===

  async loadSettings(): Promise<MobileSettings> {
    const raw = await AsyncStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) as Partial<MobileSettings> };
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

  // === Governance ===

  get governanceStatus(): { governed: boolean; reason?: string } {
    return this._governanceStatus;
  }

  // === Auto-Titling ===

  private _autoTitlePending = false;

  /**
   * Generate a title for the current conversation if it has enough messages
   * and no title yet. Uses first 7 words of first user message (heuristic).
   */
  generateTitleInBackground(): void {
    if (this._autoTitlePending || !this.runtime || !this.storage) return;

    const conversationId = this.runtime.getConversationId();
    if (!conversationId) return;

    const convStore = this.storage.conversationStore as ExpoSqliteConversationStore;
    const count = convStore.getMessageCount(conversationId);
    if (count < 4) return;

    // Check if title already set
    const conversations = convStore.listConversations(this.motebitId, 1);
    const current = conversations.find((c) => c.conversationId === conversationId);
    if (current?.title) return;

    this._autoTitlePending = true;

    const history = this.runtime.getConversationHistory();
    const firstUserMsg = history.find((m) => m.role === "user");
    if (firstUserMsg) {
      const words = firstUserMsg.content.split(/\s+/).slice(0, 7);
      let title = words.join(" ");
      if (firstUserMsg.content.split(/\s+/).length > 7) {
        title += "...";
      }
      convStore.updateTitle(conversationId, title);
    }

    this._autoTitlePending = false;
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
      return nodes
        .filter((n: MemoryNode) => !n.tombstoned)
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
    return computeDecayedConfidence(
      node.confidence,
      node.half_life,
      Date.now() - node.created_at,
    );
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
      if (identityFile) {
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
        if (state) {
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

  private async createSyncToken(): Promise<string> {
    const privKeyHex = await this.keyring.get("device_private_key");
    if (!privKeyHex) throw new Error("No device private key available");

    const privKeyBytes = new Uint8Array(privKeyHex.length / 2);
    for (let i = 0; i < privKeyHex.length; i += 2) {
      privKeyBytes[i / 2] = parseInt(privKeyHex.slice(i, i + 2), 16);
    }

    return createSignedToken(
      { mid: this.motebitId, did: this.deviceId, iat: Date.now(), exp: Date.now() + 5 * 60 * 1000 },
      privKeyBytes,
    );
  }

  async initiatePairing(syncUrl: string): Promise<{ pairingCode: string; pairingId: string }> {
    const token = await this.createSyncToken();
    const client = new PairingClient({ relayUrl: syncUrl });
    const result = await client.initiate(token);
    return { pairingCode: result.pairingCode, pairingId: result.pairingId };
  }

  async getPairingSession(syncUrl: string, pairingId: string): Promise<PairingSession> {
    const token = await this.createSyncToken();
    const client = new PairingClient({ relayUrl: syncUrl });
    return client.getSession(pairingId, token);
  }

  async approvePairing(syncUrl: string, pairingId: string): Promise<{ deviceId: string }> {
    const token = await this.createSyncToken();
    const client = new PairingClient({ relayUrl: syncUrl });
    const result = await client.approve(pairingId, token);
    return { deviceId: result.deviceId };
  }

  async denyPairing(syncUrl: string, pairingId: string): Promise<void> {
    const token = await this.createSyncToken();
    const client = new PairingClient({ relayUrl: syncUrl });
    await client.deny(pairingId, token);
  }

  // === Pairing: Device B (new device) ===

  async claimPairing(syncUrl: string, code: string): Promise<{ pairingId: string; motebitId: string }> {
    if (!this.publicKey) throw new Error("No public key available — bootstrap first");
    const client = new PairingClient({ relayUrl: syncUrl });
    return client.claim(code.toUpperCase(), "Mobile", this.publicKey);
  }

  async pollPairingStatus(syncUrl: string, pairingId: string): Promise<PairingStatus> {
    const client = new PairingClient({ relayUrl: syncUrl });
    return client.pollStatus(pairingId);
  }

  async completePairing(result: { motebitId: string; deviceId: string; deviceToken: string }, syncUrl?: string): Promise<void> {
    await this.keyring.set("motebit_id", result.motebitId);
    await this.keyring.set("device_id", result.deviceId);
    await this.keyring.set("device_token", result.deviceToken);

    this.motebitId = result.motebitId;
    this.deviceId = result.deviceId;

    if (syncUrl) {
      await this.setSyncUrl(syncUrl);
    }
  }

  // === Sync ===

  private static readonly SYNC_URL_KEY = "@motebit/sync_url";
  private static readonly SYNC_INTERVAL_MS = 30_000;

  async getSyncUrl(): Promise<string | null> {
    return AsyncStorage.getItem(MobileApp.SYNC_URL_KEY);
  }

  async setSyncUrl(url: string): Promise<void> {
    await AsyncStorage.setItem(MobileApp.SYNC_URL_KEY, url);
  }

  async clearSyncUrl(): Promise<void> {
    await AsyncStorage.removeItem(MobileApp.SYNC_URL_KEY);
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
    const url = syncUrl || (await this.getSyncUrl());
    if (!url || !this.storage) return;

    await this.setSyncUrl(url);

    // Create engines (they don't start their own timers — we manage the interval
    // ourselves so we can refresh the auth token each cycle)
    this.syncEngine = new SyncEngine(
      this.storage.eventStore,
      this.motebitId,
      { sync_interval_ms: MobileApp.SYNC_INTERVAL_MS },
    );

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
  }

  stopSync(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    this.syncEngine?.stop();
    this.conversationSyncEngine?.stop();
    this.syncEngine = null;
    this.conversationSyncEngine = null;
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
    if (!url || !this.storage) throw new Error("No sync relay configured");

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

    // Conversation sync
    const convAdapter = new HttpConversationSyncAdapter({
      baseUrl: url,
      motebitId: this.motebitId,
      authToken: token,
    });
    const tempConvSync = new ConversationSyncEngine(
      this.storage.conversationSyncStore,
      this.motebitId,
    );
    tempConvSync.connectRemote(convAdapter);
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

      this.syncEngine.connectRemote(
        new HttpEventStoreAdapter({
          baseUrl: syncUrl,
          motebitId: this.motebitId,
          authToken: token,
        }),
      );

      this.conversationSyncEngine.connectRemote(
        new HttpConversationSyncAdapter({
          baseUrl: syncUrl,
          motebitId: this.motebitId,
          authToken: token,
        }),
      );

      await this.syncEngine.sync();
      await this.conversationSyncEngine.sync();

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
    setTimeout(() => { void this.goalTick(); }, 5_000);
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
      if (planId && this.planEngine) {
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
        const elapsed = goal.last_run_at ? now - goal.last_run_at : Infinity;
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
    outcomes: Array<{ ran_at: number; status: string; summary: string | null; error_message: string | null }>,
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
      const created = await this.planEngine!.createPlan(goal.goal_id, this.motebitId, {
        goalPrompt: goal.prompt,
        previousOutcomes: outcomes.map((o) =>
          o.status === "failed" ? `failed: ${o.error_message ?? "unknown"}` : `${o.status}: ${o.summary ?? "no summary"}`,
        ),
        availableTools: registry.list().map((t) => t.name),
      }, loopDeps);
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
    outcomes: Array<{ ran_at: number; status: string; summary: string | null; error_message: string | null }>,
    now: number,
  ): Promise<{ suspended: boolean; summary: string }> {
    let context = `You are executing a scheduled goal.\n\nGoal: ${goal.prompt}`;
    if (outcomes.length > 0) {
      context += "\n\nPrevious executions (most recent first):";
      for (const o of outcomes) {
        const ago = formatTimeAgo(now - o.ran_at);
        if (o.status === "failed" && o.error_message) {
          context += `\n- ${ago}: failed — [error: ${o.error_message}]`;
        } else if (o.summary) {
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
    } catch { /* non-fatal */ }

    try {
      goalStore.incrementFailures(goal.goal_id);
    } catch { /* non-fatal */ }

    this._goalCompleteCallback?.({
      goalId: goal.goal_id,
      prompt: goal.prompt,
      status: "failed",
      summary: null,
      error,
    });
  }
}
