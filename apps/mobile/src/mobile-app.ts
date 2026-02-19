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
import { CloudProvider, OllamaProvider } from "@motebit/ai-core";
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
  provider: "ollama" | "anthropic";
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
};

const SETTINGS_KEY = "@motebit/settings";
const IDENTITY_FILE_KEY = "@motebit/identity_file";

// === AI Config ===

export interface MobileAIConfig {
  provider: "ollama" | "anthropic";
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

  // Goal scheduler state
  private goalSchedulerTimer: ReturnType<typeof setInterval> | null = null;
  private _goalExecuting = false;
  private _goalStatusCallback: ((executing: boolean) => void) | null = null;
  private _goalCompleteCallback: ((event: GoalCompleteEvent) => void) | null = null;
  private _goalApprovalCallback: ((event: GoalApprovalEvent) => void) | null = null;
  private _pendingGoalApproval: {
    goalId: string;
    prompt: string;
    mode: string;
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

    // Register builtin tools (web_search, read_url, recall_memories, list_events)
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

    // Register tools into runtime
    const tempRegistry = new InMemoryToolRegistry();
    adapter.registerInto(tempRegistry);
    if (this.runtime) {
      this.runtime.registerExternalTools(`mcp:${config.name}`, tempRegistry);
    }

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

  getMcpServers(): Array<{ name: string; url: string; connected: boolean; toolCount: number }> {
    return this._mcpServers.map((config) => {
      const adapter = this.mcpAdapters.get(config.name);
      return {
        name: config.name,
        url: config.url || "",
        connected: adapter?.isConnected ?? false,
        toolCount: adapter?.getTools().length ?? 0,
      };
    });
  }

  onToolsChanged(callback: () => void): void {
    this._toolsChangedCallback = callback;
  }

  private async reconnectMcpServers(): Promise<void> {
    const raw = await AsyncStorage.getItem(MobileApp.MCP_SERVERS_KEY);
    if (!raw) return;
    try {
      const configs: McpServerConfig[] = JSON.parse(raw);
      this._mcpServers = configs;
      for (const config of configs) {
        try {
          const adapter = new McpClientAdapter(config);
          await adapter.connect();
          const tempRegistry = new InMemoryToolRegistry();
          adapter.registerInto(tempRegistry);
          if (this.runtime) {
            this.runtime.registerExternalTools(`mcp:${config.name}`, tempRegistry);
          }
          this.mcpAdapters.set(config.name, adapter);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`Failed to reconnect MCP server "${config.name}": ${msg}`);
        }
      }
      if (this.mcpAdapters.size > 0) {
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
        data.memories = nodes.filter((n: MemoryNode) => !n.tombstoned);
        data.memory_edges = edges;
      } catch {
        // Non-fatal
      }

      // Include recent events
      try {
        const events = await this.runtime.events.query({
          motebit_id: this.motebitId,
          limit: 100,
        });
        data.events = events;
      } catch {
        // Non-fatal
      }

      // Include current state vector
      try {
        const state = this.runtime.getState();
        if (state) {
          data.state_vector = state;
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

    const { goalId, prompt, mode } = this._pendingGoalApproval;

    try {
      let accumulated = "";
      for await (const chunk of this.runtime.resumeAfterApproval(approved)) {
        if (chunk.type === "text") {
          accumulated += chunk.text;
        }
        yield chunk;
      }

      // Record outcome to DB
      const now = Date.now();
      goalStore.updateLastRun(goalId, now);
      goalStore.resetFailures(goalId);

      goalStore.insertOutcome({
        outcome_id: crypto.randomUUID(),
        goal_id: goalId,
        motebit_id: this.motebitId,
        ran_at: now,
        status: "completed",
        summary: accumulated.slice(0, 500),
        tool_calls_made: 0,
        memories_formed: 0,
        error_message: null,
      });

      // One-shot auto-complete
      if (mode === "once") {
        goalStore.setStatus(goalId, "completed");
      }

      // Notify UI
      this._goalCompleteCallback?.({
        goalId,
        prompt,
        status: "completed",
        summary: accumulated.slice(0, 200),
        error: null,
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
      this._goalExecuting = false;
      this._goalStatusCallback?.(false);
      this._pendingGoalApproval = null;
      this.runtime?.resetConversation();
    }
  }

  private async goalTick(): Promise<void> {
    if (!this.runtime || this._goalExecuting || this.runtime.isProcessing) return;

    const goalStore = this.storage?.goalStore;
    if (!goalStore) return;

    try {
      const goals = goalStore.listActiveGoals(this.motebitId);
      if (goals.length === 0) return;

      const now = Date.now();
      for (const goal of goals) {
        const elapsed = goal.last_run_at ? now - goal.last_run_at : Infinity;
        if (elapsed < goal.interval_ms) continue;
        if (this.runtime.isProcessing) break;

        this._goalExecuting = true;
        this._goalStatusCallback?.(true);

        try {
          // Build enriched context with previous outcomes
          const outcomes = goalStore.getRecentOutcomes(goal.goal_id, 3);

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

          // Stream so approval_request chunks surface
          let accumulated = "";
          let approvalRequested = false;

          for await (const chunk of this.runtime.sendMessageStreaming(context)) {
            if (chunk.type === "text") {
              accumulated += chunk.text;
            } else if (chunk.type === "approval_request") {
              approvalRequested = true;
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
            }
          }

          if (approvalRequested) {
            // Don't record outcome — waiting for user decision.
            // _goalExecuting stays true to block further ticks.
            return;
          }

          // Normal completion: record outcome, update DB
          goalStore.updateLastRun(goal.goal_id, now);
          goalStore.resetFailures(goal.goal_id);

          goalStore.insertOutcome({
            outcome_id: crypto.randomUUID(),
            goal_id: goal.goal_id,
            motebit_id: this.motebitId,
            ran_at: now,
            status: "completed",
            summary: accumulated.slice(0, 500),
            tool_calls_made: 0,
            memories_formed: 0,
            error_message: null,
          });

          // One-shot auto-complete
          if (goal.mode === "once") {
            goalStore.setStatus(goal.goal_id, "completed");
          }

          // Notify UI
          this._goalCompleteCallback?.({
            goalId: goal.goal_id,
            prompt: goal.prompt,
            status: "completed",
            summary: accumulated.slice(0, 200),
            error: null,
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);

          // Record failed outcome
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
              error_message: msg,
            });
          } catch {
            // Non-fatal
          }

          // Increment failures and auto-pause if threshold reached
          try {
            goalStore.incrementFailures(goal.goal_id);
          } catch {
            // Non-fatal
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
            this._goalStatusCallback?.(false);
            this.runtime?.resetConversation();
          }
        }
      }
    } catch {
      this._goalExecuting = false;
      this._goalStatusCallback?.(false);
    }
  }
}
