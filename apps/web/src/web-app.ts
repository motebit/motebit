import { MotebitRuntime, RelayDelegationAdapter } from "@motebit/runtime";
import type { StreamChunk, StorageAdapters, PlanChunk } from "@motebit/runtime";
import type {
  ConversationMessage,
  BehaviorCues,
  EventType,
  AgentTask,
  ExecutionReceipt,
} from "@motebit/sdk";
import { DeviceCapability } from "@motebit/sdk";
import { ThreeJSAdapter } from "@motebit/render-engine";
import type { AudioReactivity } from "@motebit/render-engine";
import type { StreamingProvider } from "@motebit/ai-core/browser";
import {
  createBrowserStorage,
  IdbConversationStore,
  IdbConversationSyncStore,
  IdbPlanStore,
  IdbPlanSyncStore,
  IdbGradientStore,
} from "@motebit/browser-persistence";
import { McpClientAdapter } from "@motebit/mcp-client";
import type { McpServerConfig } from "@motebit/mcp-client";
import { InMemoryToolRegistry } from "@motebit/tools/web-safe";
import { bootstrapIdentity, type BootstrapConfigStore } from "@motebit/core-identity";
import { createSignedToken, deriveSyncEncryptionKey, secureErase } from "@motebit/crypto";
import {
  HttpEventStoreAdapter,
  WebSocketEventStoreAdapter,
  EncryptedEventStoreAdapter,
  decryptEventPayload,
  PlanSyncEngine,
  HttpPlanSyncAdapter,
  ConversationSyncEngine,
  HttpConversationSyncAdapter,
  type SyncStatus,
} from "@motebit/sync-engine";
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
} from "@motebit/tools/web-safe";
import { embedText, setRemoteEmbedUrl } from "@motebit/memory-graph";
import { CursorPresence } from "./cursor-presence";
import { createProvider, WebLLMProvider } from "./providers";
import type { ProviderConfig } from "./storage";
import { needsMigration, loadLegacyConversations, markMigrationDone } from "./storage";
import { LocalStorageKeyringAdapter } from "./browser-keyring";
import { EncryptedKeyStore } from "./encrypted-keystore";

// Re-export for color-picker module
export type InteriorColor = { tint: [number, number, number]; glow: [number, number, number] };

export const COLOR_PRESETS: Record<string, InteriorColor> = {
  moonlight: { tint: [0.95, 0.95, 1.0], glow: [0.8, 0.85, 1.0] },
  amber: { tint: [1.0, 0.85, 0.6], glow: [0.9, 0.7, 0.3] },
  rose: { tint: [1.0, 0.82, 0.88], glow: [0.9, 0.5, 0.6] },
  violet: { tint: [0.88, 0.8, 1.0], glow: [0.6, 0.4, 0.9] },
  cyan: { tint: [0.8, 0.95, 1.0], glow: [0.3, 0.8, 0.9] },
  ember: { tint: [1.0, 0.75, 0.65], glow: [0.9, 0.35, 0.2] },
  sage: { tint: [0.82, 0.95, 0.85], glow: [0.4, 0.75, 0.5] },
};

// Re-export provider utilities
export { createProvider, WebLLMProvider };

// Legacy Tier 1 localStorage key — will be migrated to cryptographic identity
const LEGACY_MOTEBIT_ID_KEY = "motebit-web-id";

export type WebSyncStatus =
  | "offline"
  | "connecting"
  | "connected"
  | "syncing"
  | "error"
  | "disconnected";

export class WebApp {
  private renderer = new ThreeJSAdapter();
  private cursorPresence = new CursorPresence();
  private runtime: MotebitRuntime | null = null;
  private _motebitId = "";
  private _deviceId = "";
  private _publicKeyHex = "";
  private _isProcessing = false;
  private _interiorColor: InteriorColor | null = null;
  private _syncStatus: WebSyncStatus = "offline";
  private _syncStatusListeners = new Set<(status: WebSyncStatus) => void>();
  private _syncUnsubscribe: (() => void) | null = null;
  private _wsAdapter: WebSocketEventStoreAdapter | null = null;
  private _wsTokenRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private _wsUnsubOnEvent: (() => void) | null = null;
  private _wsUnsubOnCustom: (() => void) | null = null;
  private _serving = false;
  private _servingSyncUrl: string | null = null;
  private _activeTaskCount = 0;
  private _localEventStore: StorageAdapters["eventStore"] | null = null;
  private _planStore: IdbPlanStore | null = null;
  private _planSyncEngine: PlanSyncEngine | null = null;
  private keyStore = new EncryptedKeyStore();
  private mcpAdapters = new Map<string, McpClientAdapter>();
  private _mcpServers: McpServerConfig[] = [];
  private _convStore: IdbConversationStore | null = null;
  private _conversationSyncEngine: ConversationSyncEngine | null = null;
  private cuesTickInterval: ReturnType<typeof setInterval> | null = null;
  private housekeepingInterval: ReturnType<typeof setInterval> | null = null;
  private idleCues: BehaviorCues = {
    hover_distance: 0.4,
    drift_amplitude: 0.02,
    glow_intensity: 0.3,
    eye_dilation: 0.3,
    smile_curvature: 0,
    speaking_activity: 0,
  };

  async init(canvas: HTMLCanvasElement): Promise<void> {
    await this.renderer.init(canvas);
    this.renderer.setLightEnvironment();
    this.renderer.enableOrbitControls();
  }

  async bootstrap(): Promise<void> {
    // Configure semantic embeddings via proxy (browser can't load ONNX model locally)
    setRemoteEmbedUrl("https://api.motebit.com/v1/embed");

    // Open IndexedDB storage
    const storage = await createBrowserStorage();

    // Bootstrap cryptographic identity
    const configStore: BootstrapConfigStore = {
      read() {
        const mid = localStorage.getItem("motebit:motebit_id");
        if (mid == null) return Promise.resolve(null);
        return Promise.resolve({
          motebit_id: mid,
          device_id: localStorage.getItem("motebit:device_id") ?? "",
          device_public_key: localStorage.getItem("motebit:device_public_key") ?? "",
        });
      },
      write(state): Promise<void> {
        localStorage.setItem("motebit:motebit_id", state.motebit_id);
        localStorage.setItem("motebit:device_id", state.device_id);
        localStorage.setItem("motebit:device_public_key", state.device_public_key);
        return Promise.resolve();
      },
    };

    const result = await bootstrapIdentity({
      surfaceName: "Web",
      identityStorage: storage.identityStorage,
      eventStoreAdapter: storage.eventStore,
      configStore,
      keyStore: this.keyStore,
    });

    this._motebitId = result.motebitId;
    this._deviceId = result.deviceId;
    this._publicKeyHex = result.publicKeyHex;
    this._localEventStore = storage.eventStore;

    // Tier 1 → Tier 2 migration: re-associate existing IDB conversations
    await this.migrateTier1Identity(storage);

    // Migrate legacy localStorage conversations to IDB
    if (needsMigration()) {
      this.migrateLegacyConversations(storage);
    }

    // Preload caches for sync access
    const convStore = storage.conversationStore as IdbConversationStore;
    this._convStore = convStore;
    await convStore.preload(this._motebitId);
    const planStore = storage.planStore as IdbPlanStore;
    this._planStore = planStore;
    await planStore.preload(this._motebitId);
    const gradientStore = storage.gradientStore as IdbGradientStore;
    await gradientStore.preload(this._motebitId);

    // Create runtime — no AI provider yet, will be set via connectProvider()
    const keyring = new LocalStorageKeyringAdapter();
    this.runtime = new MotebitRuntime(
      { motebitId: this._motebitId, tickRateHz: 2 },
      { storage, renderer: this.renderer, ai: undefined, keyring },
    );

    // Web surface: HTTP MCP only (no stdio, no filesystem, no secure keyring)
    this.runtime.setLocalCapabilities([DeviceCapability.HttpMcp]);

    // Register web-safe tools
    this.registerWebTools();

    // Start ticking
    this.runtime.start();
    this.cursorPresence.start();

    // 30fps cursor tick: merge cursor presence into runtime state
    this.cuesTickInterval = setInterval(() => {
      const cursorUpdates = this.cursorPresence.getUpdates();
      if (this.runtime) {
        this.runtime.pushStateUpdate(cursorUpdates);
      }
    }, 33);

    // Periodic housekeeping (memory decay, gradient computation)
    this.housekeepingInterval = setInterval(() => {
      void this.housekeeping();
    }, 10 * 60_000);

    // Reconnect saved MCP servers
    void this.reconnectMcpServers();
  }

  /**
   * Tier 1 → Tier 2 migration.
   * Existing web users have a `motebit-web-id` localStorage key with a random UUID.
   * After bootstrapIdentity() creates a new cryptographic identity, we re-associate
   * existing IDB conversations with the new motebitId and clean up the old key.
   */
  private async migrateTier1Identity(storage: StorageAdapters): Promise<void> {
    const legacyId = localStorage.getItem(LEGACY_MOTEBIT_ID_KEY);
    if (legacyId == null || legacyId === "") return;

    // Only migrate if this is actually a new identity (different from legacy)
    if (legacyId === this._motebitId) {
      localStorage.removeItem(LEGACY_MOTEBIT_ID_KEY);
      return;
    }

    const convStore = storage.conversationStore as IdbConversationStore | undefined;
    if (convStore) {
      // Preload under the old ID so we can see what needs migrating
      await convStore.preload(legacyId);
      const oldConversations = convStore.listConversations(legacyId);

      if (oldConversations.length > 0) {
        // Re-preload under new ID, then re-associate conversations
        // The IDB store uses motebitId as an index — we need to update the records.
        // Since IdbConversationStore doesn't expose a migration method, we'll
        // re-create conversations under the new identity.
        for (const oldConv of oldConversations) {
          const newConvId = convStore.createConversation(this._motebitId);
          const messages = convStore.loadMessages(oldConv.conversationId);
          for (const msg of messages) {
            convStore.appendMessage(newConvId, this._motebitId, {
              role: msg.role,
              content: msg.content,
            });
          }
          if (oldConv.title) {
            convStore.updateTitle(newConvId, oldConv.title);
          }
        }
      }
    }

    // Remove legacy key — migration complete
    localStorage.removeItem(LEGACY_MOTEBIT_ID_KEY);
  }

  private migrateLegacyConversations(storage: StorageAdapters): void {
    const convStore = storage.conversationStore;
    if (!convStore) {
      markMigrationDone();
      return;
    }

    const legacy = loadLegacyConversations();
    for (const conv of legacy) {
      const convId = convStore.createConversation(this._motebitId);
      for (const msg of conv.messages) {
        if (msg.role === "user" || msg.role === "assistant") {
          convStore.appendMessage(convId, this._motebitId, {
            role: msg.role,
            content: msg.content,
          });
        }
      }
      if (conv.title) {
        convStore.updateTitle(convId, conv.title);
      }
    }

    markMigrationDone();
  }

  private registerWebTools(): void {
    if (!this.runtime) return;
    const registry = this.runtime.getToolRegistry();

    registry.register(webSearchDefinition, createWebSearchHandler(new DuckDuckGoSearchProvider()));
    registry.register(
      readUrlDefinition,
      createReadUrlHandler({ proxyUrl: "https://api.motebit.com/v1/fetch" }),
    );
    registry.register(
      recallMemoriesDefinition,
      createRecallMemoriesHandler(async (query, limit) => {
        if (!this.runtime) return [];
        const embedding = await embedText(query);
        const nodes = await this.runtime.memory.retrieve(embedding, { limit });
        return nodes.map((n) => ({ content: n.content, confidence: n.confidence }));
      }),
    );
    registry.register(
      listEventsDefinition,
      createListEventsHandler(async (limit, eventType) => {
        if (!this.runtime) return [];
        const events = await this.runtime.events.query({
          motebit_id: this.runtime.motebitId,
          limit,
          event_types: eventType ? [eventType as EventType] : undefined,
        });
        return events.map((e) => ({
          event_type: e.event_type,
          timestamp: e.timestamp,
          payload: e.payload,
        }));
      }),
    );
    registry.register(
      selfReflectDefinition,
      createSelfReflectHandler(async () => {
        if (!this.runtime) throw new Error("Runtime not initialized");
        return this.runtime.reflect();
      }),
    );
  }

  stop(): void {
    this.cursorPresence.stop();
    if (this.cuesTickInterval != null) {
      clearInterval(this.cuesTickInterval);
      this.cuesTickInterval = null;
    }
    if (this.housekeepingInterval != null) {
      clearInterval(this.housekeepingInterval);
      this.housekeepingInterval = null;
    }
    this.runtime?.stop();
    this.renderer.dispose();
  }

  resize(width: number, height: number): void {
    this.renderer.resize(width, height);
  }

  renderFrame(deltaTime: number, time: number): void {
    if (this.runtime) {
      this.runtime.renderFrame(deltaTime, time);
    } else {
      // Pre-bootstrap: render with idle cues
      this.renderer.render({
        cues: this.idleCues,
        delta_time: deltaTime,
        time,
      });
    }
  }

  // === Provider Management ===

  get isProviderConnected(): boolean {
    return this.runtime?.isAIReady ?? false;
  }

  get isProcessing(): boolean {
    return this._isProcessing;
  }

  get currentModel(): string | null {
    return this.runtime?.currentModel ?? null;
  }

  connectProvider(config: ProviderConfig): void {
    const provider = createProvider(config) as StreamingProvider;
    if (this.runtime) {
      this.runtime.setProvider(provider);
    }
  }

  setProviderDirect(provider: StreamingProvider): void {
    if (this.runtime) {
      this.runtime.setProvider(provider);
    }
  }

  disconnectProvider(): void {
    // No direct "unset provider" on runtime — reconnect with a different one
  }

  // === Appearance ===

  setInteriorColor(presetName: string): void {
    const preset = COLOR_PRESETS[presetName];
    if (!preset) return;
    this._interiorColor = preset;
    this.renderer.setInteriorColor(preset);
  }

  setInteriorColorDirect(color: InteriorColor): void {
    this._interiorColor = color;
    this.renderer.setInteriorColor(color);
  }

  getInteriorColor(): InteriorColor | null {
    return this._interiorColor;
  }

  setAudioReactivity(energy: AudioReactivity | null): void {
    this.renderer.setAudioReactivity(energy);
  }

  setLightEnvironment(): void {
    this.renderer.setLightEnvironment();
  }

  setDarkEnvironment(): void {
    this.renderer.setDarkEnvironment();
  }

  // === Conversation ===

  get activeConversationId(): string | null {
    return this.runtime?.getConversationId() ?? null;
  }

  getConversationHistory(): ConversationMessage[] {
    return this.runtime?.getConversationHistory() ?? [];
  }

  resetConversation(): void {
    this.runtime?.resetConversation();
  }

  async loadConversationById(id: string): Promise<ConversationMessage[]> {
    if (!this.runtime) return [];
    // Preload messages from IDB into sync cache before loading
    if (this._convStore) await this._convStore.preloadConversation(id);
    this.runtime.loadConversation(id);
    return this.runtime.getConversationHistory();
  }

  deleteConversation(id: string): void {
    this.runtime?.deleteConversation(id);
  }

  listConversations(): Array<{
    conversationId: string;
    startedAt: number;
    lastActiveAt: number;
    title: string | null;
    messageCount: number;
  }> {
    return this.runtime?.listConversations() ?? [];
  }

  // === Streaming Chat ===

  async *sendMessageStreaming(text: string): AsyncGenerator<StreamChunk> {
    if (!this.runtime) throw new Error("Runtime not initialized");
    if (!this.runtime.isAIReady) throw new Error("No provider connected");
    if (this._isProcessing) throw new Error("Already processing");

    this._isProcessing = true;
    try {
      yield* this.runtime.sendMessageStreaming(text);
    } finally {
      this._isProcessing = false;
    }
  }

  // === Approval Flow ===

  get hasPendingApproval(): boolean {
    return this.runtime?.hasPendingApproval ?? false;
  }

  get pendingApprovalInfo(): { toolName: string; args: Record<string, unknown> } | null {
    return this.runtime?.pendingApprovalInfo ?? null;
  }

  async *resumeAfterApproval(approved: boolean): AsyncGenerator<StreamChunk> {
    if (!this.runtime) return;
    yield* this.runtime.resumeAfterApproval(approved);
  }

  async *resolveApprovalVote(approved: boolean, approverId: string): AsyncGenerator<StreamChunk> {
    if (!this.runtime) return;
    yield* this.runtime.resolveApprovalVote(approved, approverId);
  }

  // === Sovereign Features ===

  async autoTitle(): Promise<string | null> {
    return this.runtime?.autoTitle() ?? null;
  }

  async summarize(): Promise<string | null> {
    return this.runtime?.summarizeCurrentConversation() ?? null;
  }

  async housekeeping(): Promise<void> {
    await this.runtime?.housekeeping();
  }

  async exportData(): Promise<string> {
    const runtime = this.runtime;
    const identity = {
      motebitId: this._motebitId,
      deviceId: this._deviceId,
      publicKeyHex: this._publicKeyHex,
    };
    const memories = runtime ? await runtime.memory.exportAll() : { nodes: [], edges: [] };
    const conversations = runtime ? runtime.listConversations() : [];
    const credentials = runtime ? runtime.getIssuedCredentials() : [];
    const gradient = runtime ? runtime.getGradient() : null;

    return JSON.stringify(
      {
        exported_at: new Date().toISOString(),
        identity,
        memories: {
          nodes: memories.nodes.filter(
            (n) => !n.tombstoned && (n.valid_until == null || n.valid_until > Date.now()),
          ),
          edges: memories.edges,
        },
        conversations,
        credentials,
        gradient,
      },
      null,
      2,
    );
  }

  getRuntime(): MotebitRuntime | null {
    return this.runtime;
  }

  get motebitId(): string {
    return this._motebitId;
  }

  get deviceId(): string {
    return this._deviceId;
  }

  get publicKeyHex(): string {
    return this._publicKeyHex;
  }

  // === MCP Management ===

  async addMcpServer(config: McpServerConfig): Promise<void> {
    if (config.transport !== "http") {
      throw new Error(
        "Web only supports HTTP MCP servers. Use the desktop or CLI app for stdio servers.",
      );
    }
    if (config.url == null || config.url === "") {
      throw new Error("HTTP MCP server requires a url");
    }

    const adapter = new McpClientAdapter(config);
    await adapter.connect();

    // Manifest pinning: pin hash on first connect, revoke trust on mismatch
    const manifestResult = await adapter.checkManifest(
      config.toolManifestHash,
      config.pinnedToolNames,
    );
    if (!manifestResult.ok) {
      config.trusted = false;
    }
    config.toolManifestHash = manifestResult.hash;
    config.pinnedToolNames = manifestResult.toolNames;

    // Persist motebit public key if newly pinned during connect
    if (adapter.isMotebit && adapter.verifiedIdentity?.verified) {
      const pinnedKey = adapter.serverConfig.motebitPublicKey;
      if (pinnedKey && !config.motebitPublicKey) {
        config.motebitPublicKey = pinnedKey;
      }
    }

    this.registerMcpTools(adapter, config);

    this.mcpAdapters.set(config.name, adapter);
    this._mcpServers = this._mcpServers.filter((s) => s.name !== config.name);
    this._mcpServers.push(config);
    this.persistMcpServers();
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
    this.persistMcpServers();
  }

  getMcpServers(): Array<{
    name: string;
    url: string;
    connected: boolean;
    toolCount: number;
    trusted: boolean;
    motebit: boolean;
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
      };
    });
  }

  setMcpServerTrust(name: string, trusted: boolean): void {
    const config = this._mcpServers.find((s) => s.name === name);
    if (!config) return;
    config.trusted = trusted;

    const adapter = this.mcpAdapters.get(name);
    if (adapter && this.runtime) {
      this.runtime.unregisterExternalTools(`mcp:${name}`);
      this.registerMcpTools(adapter, config);
    }

    this.persistMcpServers();
  }

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
    const raw = localStorage.getItem("motebit:mcp_servers");
    if (raw == null || raw === "") return;
    try {
      const configs = JSON.parse(raw) as McpServerConfig[];
      this._mcpServers = configs;
      let changed = false;
      for (const config of configs) {
        try {
          const adapter = new McpClientAdapter(config);
          await adapter.connect();

          const manifestResult = await adapter.checkManifest(
            config.toolManifestHash,
            config.pinnedToolNames,
          );
          if (!manifestResult.ok) {
            config.trusted = false;
          }
          config.toolManifestHash = manifestResult.hash;
          config.pinnedToolNames = manifestResult.toolNames;

          if (adapter.isMotebit && adapter.verifiedIdentity?.verified) {
            const pinnedKey = adapter.serverConfig.motebitPublicKey;
            if (pinnedKey && !config.motebitPublicKey) {
              config.motebitPublicKey = pinnedKey;
            }
          }

          this.registerMcpTools(adapter, config);
          this.mcpAdapters.set(config.name, adapter);
          changed = true;
        } catch {
          // Non-fatal — server may be offline
        }
      }
      if (changed) {
        this.persistMcpServers();
      }
    } catch {
      // Non-fatal — corrupted localStorage
    }
  }

  private persistMcpServers(): void {
    localStorage.setItem("motebit:mcp_servers", JSON.stringify(this._mcpServers));
  }

  // === Goals (one-shot, user-triggered) ===

  async *executeGoal(goalId: string, prompt: string): AsyncGenerator<PlanChunk> {
    if (!this.runtime) throw new Error("Runtime not initialized");
    if (!this.runtime.isAIReady) throw new Error("No provider connected");

    yield* this.runtime.executePlan(goalId, prompt);
  }

  async *resumeGoal(planId: string): AsyncGenerator<PlanChunk> {
    if (!this.runtime) throw new Error("Runtime not initialized");
    if (!this.runtime.isAIReady) throw new Error("No provider connected");

    yield* this.runtime.resumePlan(planId);
  }

  // === Sync ===

  get syncStatus(): WebSyncStatus {
    return this._syncStatus;
  }

  onSyncStatusChange(cb: (status: WebSyncStatus) => void): () => void {
    this._syncStatusListeners.add(cb);
    return () => {
      this._syncStatusListeners.delete(cb);
    };
  }

  private setSyncStatus(status: WebSyncStatus): void {
    this._syncStatus = status;
    for (const cb of this._syncStatusListeners) cb(status);
  }

  async createSyncToken(aud: string = "sync"): Promise<string | null> {
    const privateKeyHex = await this.keyStore.loadPrivateKey();
    if (privateKeyHex == null || privateKeyHex === "") return null;

    const privKeyBytes = new Uint8Array(privateKeyHex.length / 2);
    for (let i = 0; i < privateKeyHex.length; i += 2) {
      privKeyBytes[i / 2] = parseInt(privateKeyHex.slice(i, i + 2), 16);
    }

    try {
      return await createSignedToken(
        {
          mid: this._motebitId,
          did: this._deviceId,
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

  async startSync(relayUrl: string): Promise<void> {
    if (!this.runtime) throw new Error("Runtime not initialized");

    this.setSyncStatus("connecting");

    // Get private key for token + encryption key derivation
    const privateKeyHex = await this.keyStore.loadPrivateKey();
    if (privateKeyHex == null || privateKeyHex === "") {
      this.setSyncStatus("error");
      throw new Error("No device keypair available for sync authentication");
    }

    const privKeyBytes = new Uint8Array(privateKeyHex.length / 2);
    for (let i = 0; i < privateKeyHex.length; i += 2) {
      privKeyBytes[i / 2] = parseInt(privateKeyHex.slice(i, i + 2), 16);
    }

    // Derive deterministic encryption key, then erase raw key bytes
    const encKey = await deriveSyncEncryptionKey(privKeyBytes);
    secureErase(privKeyBytes);

    const token = await this.createSyncToken();
    if (token == null) {
      this.setSyncStatus("error");
      throw new Error("No device keypair available for sync authentication");
    }

    // Build adapter stack: HTTP → Encrypted HTTP → WS → Encrypted WS
    const httpAdapter = new HttpEventStoreAdapter({
      baseUrl: relayUrl,
      motebitId: this._motebitId,
      authToken: token,
    });
    const encryptedHttp = new EncryptedEventStoreAdapter({ inner: httpAdapter, key: encKey });

    // WebSocket URL
    const wsUrl =
      relayUrl.replace(/^https?/, (m) => (m === "https" ? "wss" : "ws")) +
      "/ws/sync/" +
      this._motebitId;

    const localEventStore = this._localEventStore;
    const wsAdapter = new WebSocketEventStoreAdapter({
      url: wsUrl,
      motebitId: this._motebitId,
      authToken: token,
      capabilities: [DeviceCapability.HttpMcp],
      httpFallback: encryptedHttp,
      localStore: localEventStore ?? undefined,
    });
    this._wsAdapter = wsAdapter;

    // Wire delegation adapter so PlanEngine can delegate steps to capable devices
    const delegationAdapter = new RelayDelegationAdapter({
      syncUrl: relayUrl,
      motebitId: this._motebitId,
      authToken: token ?? undefined,
      sendRaw: (data: string) => wsAdapter.sendRaw(data),
      onCustomMessage: (cb) => wsAdapter.onCustomMessage(cb),
      getExplorationDrive: () => this.runtime?.getPrecision().explorationDrive,
    });
    this.runtime.setDelegationAdapter(delegationAdapter);

    // Enable interactive delegation — lets the AI transparently delegate
    // tasks to remote agents during conversation.
    this.runtime.enableInteractiveDelegation({
      syncUrl: relayUrl,
      authToken: async () => {
        const t = await this.createSyncToken("task:submit");
        return t ?? "";
      },
    });

    this._servingSyncUrl = relayUrl;

    // Wire task handler — accept delegations while the tab is open.
    if (this._wsUnsubOnCustom) this._wsUnsubOnCustom();
    this._wsUnsubOnCustom = wsAdapter.onCustomMessage((msg) => {
      if (msg.type !== "task_request" || msg.task == null || !this._serving) return;
      if (!this.runtime) return;

      const task = msg.task as AgentTask;
      const runtime = this.runtime;

      this._wsAdapter?.sendRaw(JSON.stringify({ type: "task_claim", task_id: task.task_id }));
      this._activeTaskCount++;

      void (async () => {
        try {
          const privateKeyHex = await this.keyStore.loadPrivateKey();
          if (!privateKeyHex) return;
          const privKeyBytes = new Uint8Array(privateKeyHex.length / 2);
          for (let i = 0; i < privateKeyHex.length; i += 2) {
            privKeyBytes[i / 2] = parseInt(privateKeyHex.slice(i, i + 2), 16);
          }

          let receipt: ExecutionReceipt | undefined;
          for await (const chunk of runtime.handleAgentTask(
            task,
            privKeyBytes,
            this._deviceId,
            undefined,
            { delegatedScope: task.delegated_scope },
          )) {
            if (chunk.type === "task_result") {
              receipt = chunk.receipt;
            }
          }
          secureErase(privKeyBytes);

          if (receipt) {
            const token = await this.createSyncToken("task:submit");
            await fetch(`${relayUrl}/agent/${this._motebitId}/task/${task.task_id}/result`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
              },
              body: JSON.stringify(receipt),
            });
          }
        } catch {
          // Task execution failed — receipt not submitted
        } finally {
          this._activeTaskCount = Math.max(0, this._activeTaskCount - 1);
        }
      })();
    });

    const encryptedWs = new EncryptedEventStoreAdapter({ inner: wsAdapter, key: encKey });

    // Inbound real-time events: decrypt and write to local store
    this._wsUnsubOnEvent = wsAdapter.onEvent((raw) => {
      void (async () => {
        if (!localEventStore) return;
        const dec = await decryptEventPayload(raw, encKey);
        await localEventStore.append(dec);
      })();
    });

    this.runtime.connectSync(encryptedWs);
    wsAdapter.connect();

    // Subscribe to SyncEngine status changes
    if (this._syncUnsubscribe) this._syncUnsubscribe();
    this._syncUnsubscribe = this.runtime.sync.onStatusChange((engineStatus: SyncStatus) => {
      if (engineStatus === "syncing") {
        this.setSyncStatus("syncing");
      } else if (engineStatus === "idle") {
        this.setSyncStatus("connected");
      } else if (engineStatus === "error") {
        this.setSyncStatus("error");
      } else if (engineStatus === "offline") {
        this.setSyncStatus("disconnected");
      }
    });

    this.runtime.startSync();
    this.setSyncStatus("connected");

    // Wire plan sync — push/pull plans to relay for cross-device visibility
    if (this._planStore) {
      const planSyncStore = new IdbPlanSyncStore(this._planStore, this._motebitId);
      this._planSyncEngine = new PlanSyncEngine(planSyncStore, this._motebitId);
      this._planSyncEngine.connectRemote(
        new HttpPlanSyncAdapter({
          baseUrl: relayUrl,
          motebitId: this._motebitId,
          authToken: token ?? undefined,
        }),
      );
      // Initial plan sync, then background every 30s
      void this._planSyncEngine.sync();
      this._planSyncEngine.start();
    }

    // Wire conversation sync — push/pull conversations to relay for cross-device visibility
    if (this._convStore) {
      // Preload all conversation messages so sync push includes locally-modified data
      await this._convStore.preloadAllMessages();
      const convSyncStore = new IdbConversationSyncStore(this._convStore, this._motebitId);
      this._conversationSyncEngine = new ConversationSyncEngine(convSyncStore, this._motebitId);
      this._conversationSyncEngine.connectRemote(
        new HttpConversationSyncAdapter({
          baseUrl: relayUrl,
          motebitId: this._motebitId,
          authToken: token ?? undefined,
        }),
      );
      void this._conversationSyncEngine.sync();
      this._conversationSyncEngine.start();
    }

    // Recover any delegated steps orphaned by a previous tab close
    void (async () => {
      try {
        for await (const _chunk of this.runtime!.recoverDelegatedSteps()) {
          // Chunks consumed — UI will pick up state changes from the plan store
        }
      } catch {
        // Recovery is best-effort — don't break sync startup
      }
    })();

    // Token refresh every 4.5 min
    this._wsTokenRefreshTimer = setInterval(() => {
      void (async () => {
        try {
          // Unsubscribe old event handler before disconnect to prevent
          // orphaned callbacks firing during the refresh window.
          if (this._wsUnsubOnEvent) {
            this._wsUnsubOnEvent();
            this._wsUnsubOnEvent = null;
          }
          wsAdapter.disconnect();
          const freshToken = await this.createSyncToken();
          if (freshToken == null) return;

          const freshWs = new WebSocketEventStoreAdapter({
            url: wsUrl,
            motebitId: this._motebitId,
            authToken: freshToken,
            capabilities: [DeviceCapability.HttpMcp],
            httpFallback: encryptedHttp,
            localStore: localEventStore ?? undefined,
          });

          // Re-wire delegation adapter with fresh wsAdapter
          const freshDelegation = new RelayDelegationAdapter({
            syncUrl: relayUrl,
            motebitId: this._motebitId,
            authToken: freshToken ?? undefined,
            sendRaw: (data: string) => freshWs.sendRaw(data),
            onCustomMessage: (cb) => freshWs.onCustomMessage(cb),
            getExplorationDrive: () => this.runtime?.getPrecision().explorationDrive,
          });
          this.runtime?.setDelegationAdapter(freshDelegation);

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
          // Token refresh failed — WS adapter reconnect will retry
        }
      })();
    }, 4.5 * 60_000);
  }

  async startServing(): Promise<{ ok: boolean; error?: string }> {
    if (!this.runtime || !this._servingSyncUrl) {
      return { ok: false, error: "Sync not connected" };
    }
    if (this._serving) return { ok: true };

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
      const token = await this.createSyncToken();
      const res = await fetch(`${this._servingSyncUrl}/api/v1/agents/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          motebit_id: this._motebitId,
          endpoint_url: `ws://${this._motebitId}`,
          public_key: this._publicKeyHex,
          capabilities,
        }),
      });
      if (!res.ok) {
        return { ok: false, error: `Registration failed: ${res.status}` };
      }
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

  stopSync(): void {
    this._serving = false;
    if (this._wsTokenRefreshTimer != null) {
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
    if (this._planSyncEngine) {
      this._planSyncEngine.stop();
      this._planSyncEngine = null;
    }
    if (this._conversationSyncEngine) {
      this._conversationSyncEngine.stop();
      this._conversationSyncEngine = null;
    }
    this.runtime?.sync.stop();
    this.setSyncStatus("disconnected");
  }
}
