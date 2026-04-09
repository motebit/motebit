import {
  MotebitRuntime,
  RelayDelegationAdapter,
  executeCommand,
  cmdSelfTest,
  PLANNING_TASK_ROUTER,
} from "@motebit/runtime";
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
import { McpClientAdapter, AdvisoryManifestVerifier } from "@motebit/mcp-client";
import type { McpServerConfig } from "@motebit/mcp-client";
import { InMemoryToolRegistry } from "@motebit/tools/web-safe";
import {
  bootstrapIdentity,
  rotateIdentityKeys,
  type BootstrapConfigStore,
} from "@motebit/core-identity";
import {
  createSignedToken,
  deriveSyncEncryptionKey,
  secureErase,
  bytesToHex,
  hexToBytes,
  generateX25519Keypair,
  buildKeyTransferPayload,
  decryptKeyTransfer,
  checkPreTransferBalance,
  formatWalletWarning,
} from "@motebit/crypto";
import type { KeyTransferPayload } from "@motebit/protocol";
import {
  HttpEventStoreAdapter,
  WebSocketEventStoreAdapter,
  EncryptedEventStoreAdapter,
  EncryptedConversationSyncAdapter,
  EncryptedPlanSyncAdapter,
  decryptEventPayload,
  PlanSyncEngine,
  HttpPlanSyncAdapter,
  ConversationSyncEngine,
  HttpConversationSyncAdapter,
  PairingClient,
  type PairingSession,
  type PairingStatus,
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
  ProxySearchProvider,
} from "@motebit/tools/web-safe";
import { embedText, setRemoteEmbedUrl } from "@motebit/memory-graph";
import { CursorPresence } from "./cursor-presence";
import { createProvider, WebLLMProvider, PROXY_BASE_URL } from "./providers";
import type { ProviderConfig } from "./storage";
import {
  needsMigration,
  loadLegacyConversations,
  markMigrationDone,
  loadGovernanceConfig,
  loadSyncUrl,
} from "./storage";
import { LocalStorageKeyringAdapter } from "./browser-keyring";
import { EncryptedKeyStore } from "./encrypted-keystore";

// Re-export shared presets for color-picker and settings modules
import { COLOR_PRESETS } from "@motebit/sdk";
import type { InteriorColor } from "@motebit/sdk";
export { COLOR_PRESETS };
export type { InteriorColor };

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
    try {
      await this.renderer.init(canvas);
      this.renderer.setLightEnvironment();
      this.renderer.enableOrbitControls();
    } catch {
      // WebGL unavailable (headless browser, low-end device).
      // Chat, identity, and all non-3D features still work.
    }
  }

  async bootstrap(): Promise<void> {
    // Configure semantic embeddings via proxy (browser can't load ONNX model locally)
    setRemoteEmbedUrl(`${PROXY_BASE_URL}/v1/embed`);

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
    const govConfig = loadGovernanceConfig();
    const presetConfigs: Record<
      string,
      { maxRiskLevel: number; requireApprovalAbove: number; denyAbove: number }
    > = {
      cautious: { maxRiskLevel: 3, requireApprovalAbove: 0, denyAbove: 3 },
      balanced: { maxRiskLevel: 3, requireApprovalAbove: 1, denyAbove: 3 },
      autonomous: { maxRiskLevel: 4, requireApprovalAbove: 3, denyAbove: 4 },
    };
    const preset = govConfig
      ? (presetConfigs[govConfig.approvalPreset] ?? presetConfigs.balanced!)
      : presetConfigs.balanced!;

    // Load identity signing keys so the runtime can construct the sovereign
    // Solana wallet (settlement-v1.md §6). The Ed25519 seed is the same 32
    // bytes that sign identity assertions — Solana derives its address from
    // this via Keypair.fromSeed (curve coincidence). Best-effort: if the
    // keystore has no key (fresh install, unlocked-but-migrated state), the
    // runtime runs without a wallet and the UX shows an em dash.
    let signingKeys: { privateKey: Uint8Array; publicKey: Uint8Array } | undefined;
    try {
      const privateKeyHex = await this.keyStore.loadPrivateKey();
      if (privateKeyHex != null && privateKeyHex !== "" && this._publicKeyHex !== "") {
        const privBytes = new Uint8Array(privateKeyHex.length / 2);
        for (let i = 0; i < privateKeyHex.length; i += 2) {
          privBytes[i / 2] = parseInt(privateKeyHex.slice(i, i + 2), 16);
        }
        const pubBytes = new Uint8Array(this._publicKeyHex.length / 2);
        for (let i = 0; i < this._publicKeyHex.length; i += 2) {
          pubBytes[i / 2] = parseInt(this._publicKeyHex.slice(i, i + 2), 16);
        }
        signingKeys = { privateKey: privBytes, publicKey: pubBytes };
      }
    } catch {
      // Keystore read failed. Runtime runs without signing keys; wallet UX
      // gracefully shows em dash. User can still use the app for everything
      // else. Re-attempting at next bootstrap.
    }

    // Solana RPC endpoint. Default to mainnet-beta public RPC (rate-limited
    // ~5 req/s, free, fine for the MVP since we only call getBalance()
    // occasionally). Override at build time via VITE_SOLANA_RPC_URL.
    const env = (import.meta as { env?: Record<string, string | undefined> }).env;
    const solanaRpcUrl = env?.VITE_SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";

    this.runtime = new MotebitRuntime(
      {
        motebitId: this._motebitId,
        tickRateHz: 2,
        policy: {
          operatorMode: false,
          maxRiskLevel: preset.maxRiskLevel,
          requireApprovalAbove: preset.requireApprovalAbove,
          denyAbove: preset.denyAbove,
          budget: govConfig ? { maxCallsPerTurn: govConfig.maxCallsPerTurn } : undefined,
        },
        memoryGovernance: govConfig
          ? {
              persistenceThreshold: govConfig.persistenceThreshold,
              rejectSecrets: govConfig.rejectSecrets,
              maxMemoriesPerTurn: govConfig.maxMemoriesPerTurn,
            }
          : undefined,
        taskRouter: PLANNING_TASK_ROUTER,
        signingKeys,
        solana: { rpcUrl: solanaRpcUrl },
      },
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

    registry.register(
      webSearchDefinition,
      createWebSearchHandler(
        new ProxySearchProvider(
          ((import.meta as unknown as Record<string, Record<string, string> | undefined>).env
            ?.VITE_SEARCH_URL ?? "https://motebit-web-search.fly.dev") + "/search",
        ),
      ),
    );
    registry.register(
      readUrlDefinition,
      createReadUrlHandler({ proxyUrl: `${PROXY_BASE_URL}/v1/fetch` }),
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
    this.clearArtifacts();
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

  // === Key Rotation ===

  /**
   * Rotate the Ed25519 keypair: generate new keys, create a signed succession
   * record (old + new keys both sign), update encrypted IndexedDB keystore,
   * and submit to relay if syncing.
   */
  async rotateKey(reason?: string): Promise<{ newPublicKey: string }> {
    // 1. Load existing private key from encrypted keystore
    const oldPrivKeyHex = await this.keyStore.loadPrivateKey();
    if (oldPrivKeyHex == null || oldPrivKeyHex === "") {
      throw new Error("No private key available — bootstrap first");
    }

    const oldPrivKeyBytes = new Uint8Array(oldPrivKeyHex.length / 2);
    for (let i = 0; i < oldPrivKeyHex.length; i += 2) {
      oldPrivKeyBytes[i / 2] = parseInt(oldPrivKeyHex.slice(i, i + 2), 16);
    }

    try {
      // 2. Derive old public key bytes from hex
      const oldPubHex = this._publicKeyHex;
      if (!oldPubHex) throw new Error("No public key available — bootstrap first");
      const oldPubKeyBytes = new Uint8Array(oldPubHex.length / 2);
      for (let i = 0; i < oldPubHex.length; i += 2) {
        oldPubKeyBytes[i / 2] = parseInt(oldPubHex.slice(i, i + 2), 16);
      }

      // 3. Rotate: generates new keypair + signed succession record
      const rotateResult = await rotateIdentityKeys({
        oldPrivateKey: oldPrivKeyBytes,
        oldPublicKey: oldPubKeyBytes,
        reason,
      });

      const newPubKeyHex = rotateResult.newPublicKeyHex;
      const newPrivKeyHex = bytesToHex(rotateResult.newPrivateKey);
      secureErase(rotateResult.newPrivateKey);

      // 4. Store new private key in encrypted IndexedDB
      await this.keyStore.storePrivateKey(newPrivKeyHex);

      // 5. Update public key in localStorage and in-memory
      localStorage.setItem("motebit:device_public_key", newPubKeyHex);
      this._publicKeyHex = newPubKeyHex;

      // 6. Submit to relay if syncing (best-effort)
      try {
        const token = await this.createSyncToken("device:auth");
        if (token != null) {
          const syncUrl = loadSyncUrl();
          if (syncUrl != null && syncUrl !== "") {
            await fetch(`${syncUrl}/api/v1/agents/${this._motebitId}/key-rotation`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({
                device_id: this._deviceId,
                new_public_key: newPubKeyHex,
                succession_record: rotateResult.successionRecord,
              }),
            });
          }
        }
      } catch {
        // Non-fatal — relay notification is best-effort
      }

      return { newPublicKey: newPubKeyHex };
    } finally {
      secureErase(oldPrivKeyBytes);
    }
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
          config.serverVerifier = new AdvisoryManifestVerifier();
          const adapter = new McpClientAdapter(config);
          await adapter.connect();

          // Persist verifier-applied config updates
          config.toolManifestHash = adapter.serverConfig.toolManifestHash;
          config.pinnedToolNames = adapter.serverConfig.pinnedToolNames;
          if (adapter.serverConfig.trusted === false) {
            config.trusted = false;
          }

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

  // === Spatial Canvas ===

  addArtifact(
    spec: import("@motebit/render-engine").ArtifactSpec,
  ): import("@motebit/render-engine").ArtifactHandle | undefined {
    return this.renderer.addArtifact?.(spec);
  }

  removeArtifact(id: string): void {
    void this.renderer.removeArtifact?.(id);
  }

  clearArtifacts(): void {
    this.renderer.clearArtifacts?.();
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
      const httpPlanAdapter = new HttpPlanSyncAdapter({
        baseUrl: relayUrl,
        motebitId: this._motebitId,
        authToken: token ?? undefined,
      });
      this._planSyncEngine.connectRemote(
        new EncryptedPlanSyncAdapter({ inner: httpPlanAdapter, key: encKey }),
      );
      // Initial plan sync, then background every 30s
      void this._planSyncEngine.sync();
      this._planSyncEngine.start();
    }

    // Wire conversation sync — push/pull conversations to relay for cross-device visibility
    // Encrypted: relay stores opaque ciphertext, same key as event encryption
    if (this._convStore) {
      // Preload all conversation messages so sync push includes locally-modified data
      await this._convStore.preloadAllMessages();
      const convSyncStore = new IdbConversationSyncStore(this._convStore, this._motebitId);
      this._conversationSyncEngine = new ConversationSyncEngine(convSyncStore, this._motebitId);
      const httpConvAdapter = new HttpConversationSyncAdapter({
        baseUrl: relayUrl,
        motebitId: this._motebitId,
        authToken: token ?? undefined,
      });
      this._conversationSyncEngine.connectRemote(
        new EncryptedConversationSyncAdapter({ inner: httpConvAdapter, key: encKey }),
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

    // Adversarial onboarding: run self-test once after first relay connection
    void this.runOnboardingSelfTest(relayUrl);
  }

  /**
   * Run cmdSelfTest exactly once per device. Uses localStorage flag to avoid
   * repeating on subsequent launches. Best-effort — failures are logged, never blocking.
   */
  private async runOnboardingSelfTest(relayUrl: string): Promise<void> {
    const FLAG = "motebit:self-test-done";
    if (localStorage.getItem(FLAG) === "true") return;
    if (!this.runtime) return;

    try {
      const token = await this.createSyncToken("task:submit");
      if (!token) return;

      const result = await cmdSelfTest(this.runtime, {
        relay: { relayUrl, authToken: token, motebitId: this._motebitId },
        mintToken: async () => {
          const t = await this.createSyncToken("task:submit");
          return t ?? "";
        },
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

  // --- Pairing (multi-device) ---

  async initiatePairing(syncUrl: string): Promise<{ pairingCode: string; pairingId: string }> {
    const token = await this.createSyncToken("pair");
    if (!token) throw new Error("No signing key — initialize identity first");
    const client = new PairingClient({ relayUrl: syncUrl });
    const result = await client.initiate(token);
    return { pairingCode: result.pairingCode, pairingId: result.pairingId };
  }

  async getPairingSession(syncUrl: string, pairingId: string): Promise<PairingSession> {
    const token = await this.createSyncToken("pair");
    if (!token) throw new Error("No signing key");
    const client = new PairingClient({ relayUrl: syncUrl });
    return client.getSession(pairingId, token);
  }

  async approvePairing(syncUrl: string, pairingId: string): Promise<{ deviceId: string }> {
    const token = await this.createSyncToken("pair");
    if (!token) throw new Error("No signing key");
    const client = new PairingClient({ relayUrl: syncUrl });

    // Build key transfer payload if Device B supports it
    let keyTransfer: KeyTransferPayload | undefined;
    const session = await client.getSession(pairingId, token);
    if (session.claiming_x25519_pubkey) {
      const privateKeyHex = await this.keyStore.loadPrivateKey();
      if (privateKeyHex) {
        const privKeyBytes = hexToBytes(privateKeyHex);
        try {
          keyTransfer = await buildKeyTransferPayload(
            privKeyBytes,
            this._publicKeyHex,
            hexToBytes(session.claiming_x25519_pubkey),
            session.pairing_code,
          );
        } finally {
          secureErase(privKeyBytes);
        }
      }
    }

    const result = await client.approve(pairingId, token, keyTransfer);
    return { deviceId: result.deviceId };
  }

  async denyPairing(syncUrl: string, pairingId: string): Promise<void> {
    const token = await this.createSyncToken("pair");
    if (!token) throw new Error("No signing key");
    const client = new PairingClient({ relayUrl: syncUrl });
    await client.deny(pairingId, token);
  }

  async claimPairing(
    syncUrl: string,
    code: string,
  ): Promise<{ pairingId: string; motebitId: string; ephemeralPrivateKey: Uint8Array }> {
    if (!this._publicKeyHex) throw new Error("No public key — initialize identity first");
    const ephemeral = generateX25519Keypair();
    const client = new PairingClient({ relayUrl: syncUrl });
    const result = await client.claim(
      code.toUpperCase(),
      "Browser",
      this._publicKeyHex,
      bytesToHex(ephemeral.publicKey),
    );
    return { ...result, ephemeralPrivateKey: ephemeral.privateKey };
  }

  async pollPairingStatus(syncUrl: string, pairingId: string): Promise<PairingStatus> {
    const client = new PairingClient({ relayUrl: syncUrl });
    return client.pollStatus(pairingId);
  }

  /**
   * Complete pairing on Device B. If key transfer payload + ephemeral key are provided,
   * decrypts the identity seed and replaces the device's private key.
   */
  async completePairing(
    { motebitId, deviceId }: { motebitId: string; deviceId: string },
    keyTransferOpts?: {
      keyTransfer: KeyTransferPayload;
      ephemeralPrivateKey: Uint8Array;
      pairingCode: string;
      syncUrl: string;
      pairingId: string;
    },
  ): Promise<string | undefined> {
    // Update in-memory identity state
    this._motebitId = motebitId;
    this._deviceId = deviceId;
    let walletWarning: string | undefined;

    if (keyTransferOpts) {
      const { keyTransfer, ephemeralPrivateKey, pairingCode, syncUrl, pairingId } = keyTransferOpts;
      try {
        const identitySeed = await decryptKeyTransfer(
          keyTransfer,
          ephemeralPrivateKey,
          pairingCode,
        );
        try {
          // Safety check: refuse key transfer if old wallet has funds
          const oldPrivKeyHex = await this.keyStore.loadPrivateKey();
          if (oldPrivKeyHex) {
            const oldSeedBytes = hexToBytes(oldPrivKeyHex);
            try {
              const walletCheck = await checkPreTransferBalance(oldSeedBytes, identitySeed);
              if (walletCheck.hasAnyValue) {
                walletWarning = formatWalletWarning(walletCheck);
              }
            } finally {
              secureErase(oldSeedBytes);
            }
          }

          if (!walletWarning) {
            const newPrivHex = bytesToHex(identitySeed);
            await this.keyStore.storePrivateKey(newPrivHex);

            // Derive and update public key
            const { getPublicKeyAsync } = await import("@noble/ed25519");
            const newPub = await getPublicKeyAsync(identitySeed);
            this._publicKeyHex = bytesToHex(newPub);

            // Update relay device registration
            const client = new PairingClient({ relayUrl: syncUrl });
            await client.updateDeviceKey(pairingId, this._publicKeyHex);
          }
        } finally {
          secureErase(identitySeed);
        }
      } catch {
        // Key transfer failed — device keeps its own keypair, wallet warning stays undefined
      } finally {
        secureErase(ephemeralPrivateKey);
      }
    }
    return walletWarning;
  }
}
