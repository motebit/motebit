/**
 * SpatialApp — Platform shell for the spatial (AR/VR) surface.
 *
 * The equivalent of DesktopApp. Holds the MotebitRuntime, WebXR adapter,
 * orbital dynamics, voice pipeline, gesture recognition, and ambient heartbeat.
 * Wires them together so the creature in AR has intelligence, memory, identity,
 * and ambient voice interaction.
 *
 * Storage is IndexedDB-backed via @motebit/browser-persistence — identity,
 * memories, events, and audit log persist across page reloads. Identity
 * bootstrap via shared bootstrapIdentity() protocol. Private key encrypted
 * via EncryptedKeyStore (WebCrypto + IndexedDB).
 *
 * Presence state machine drives the creature's body language through the
 * existing pipeline: StateVector → BehaviorEngine → RenderEngine.
 *
 * Relay integration (best-effort, gated behind showNetwork setting):
 * - Registers identity on bootstrap via POST /api/v1/agents/bootstrap
 * - Registers in agent discovery via POST /api/v1/agents/register
 * - Maintains heartbeat every 5 minutes
 * - Encrypted WebSocket event sync (same as desktop/mobile/web)
 * - HTTP plan sync for cross-device goal visibility
 * - Token refresh every 4.5 minutes (tokens expire at 5 min)
 */

import {
  MotebitRuntime,
  executeCommand,
  PlanExecutionVM,
  ProxySession,
  PLANNING_TASK_ROUTER,
  cmdSelfTest,
} from "@motebit/runtime";
import type { ProxyProviderConfig, ProxySessionAdapter } from "@motebit/runtime";
import { RelayDelegationAdapter } from "@motebit/runtime";
import { createBrowserStorage } from "@motebit/browser-persistence";
import type { StreamChunk, KeyringAdapter, StorageAdapters, RelayConfig } from "@motebit/runtime";
import type { PlanChunk, ConversationMessage } from "@motebit/runtime";
import { WebXRThreeJSAdapter } from "@motebit/render-engine";
import type { InteriorColor } from "@motebit/render-engine";
import {
  CloudProvider,
  OpenAIProvider,
  resolveConfig,
  DEFAULT_OLLAMA_URL,
  type MotebitPersonalityConfig,
} from "@motebit/ai-core";
import {
  bootstrapIdentity as sharedBootstrapIdentity,
  type BootstrapConfigStore,
  type BootstrapKeyStore,
} from "@motebit/core-identity";
import { createSignedToken, deriveSyncEncryptionKey, secureErase } from "@motebit/crypto";
import { generate as generateIdentityFile } from "@motebit/identity-file";
import type { MotebitState, BehaviorCues, GovernanceConfig } from "@motebit/sdk";
import {
  DeviceCapability,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_PROXY_MODEL,
} from "@motebit/sdk";
import { McpClientAdapter, AdvisoryManifestVerifier } from "@motebit/mcp-client";
import type { McpServerConfig } from "@motebit/mcp-client";
import { InMemoryToolRegistry } from "@motebit/tools/web-safe";
import {
  IdbConversationStore,
  IdbConversationSyncStore,
  IdbPlanStore,
  IdbPlanSyncStore,
  IdbGradientStore,
} from "@motebit/browser-persistence";
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
  type SyncStatus,
} from "@motebit/sync-engine";
import { OrbitalDynamics, estimateBodyAnchors, getAnchorForReference } from "./index";
import { SpatialVoicePipeline, type VoicePipelineConfig } from "./voice-pipeline";
import { GestureRecognizer } from "./gestures";
import { AmbientHeartbeat } from "./heartbeat";
import { LocalStorageKeyringAdapter } from "./browser-keyring";
import { EncryptedKeyStore } from "./encrypted-keystore";

// === Configuration ===

/**
 * Canonical `GovernanceConfig` lives in `@motebit/sdk`. The spatial surface
 * re-exports it under its historical alias for source-compat with any
 * external consumer that imported `SpatialGovernanceConfig`.
 */
export type SpatialGovernanceConfig = GovernanceConfig;

export interface SpatialAIConfig {
  /**
   * Provider. `local-server` is the canonical name for on-device LAN
   * inference (Ollama, LM Studio, llama.cpp, Jan, vLLM, …) via the
   * OpenAI-compat shim. The historical name `ollama` is migrated in
   * `migrateLegacySpatialAIConfig` on load.
   */
  provider: "anthropic" | "local-server" | "openai" | "proxy";
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  maxTokens?: number;
  personalityConfig?: MotebitPersonalityConfig;
  governance?: SpatialGovernanceConfig;
}

export interface SpatialNetworkSettings {
  relayUrl: string;
  showNetwork: boolean;
}

// === Presence State Machine ===

export type PresenceState =
  | "dormant" // App backgrounded / headset off
  | "ambient" // Headset on, idle
  | "attentive" // Gaze hit or VAD onset
  | "engaged" // Transcript sent to AI
  | "speaking" // TTS playing
  | "processing"; // AI turn in progress

interface PresenceMapping {
  social_distance: number;
  attention: number;
  processing: number;
}

const PRESENCE_MAP: Record<PresenceState, PresenceMapping> = {
  dormant: { social_distance: 1.0, attention: 0, processing: 0 },
  ambient: { social_distance: 0.6, attention: 0.1, processing: 0 },
  attentive: { social_distance: 0.3, attention: 0.7, processing: 0.1 },
  engaged: { social_distance: 0.1, attention: 0.9, processing: 0.5 },
  speaking: { social_distance: 0.1, attention: 0.8, processing: 0.3 },
  processing: { social_distance: 0.15, attention: 0.85, processing: 0.95 },
};

// === Constants ===

const DEFAULT_RELAY_URL = "https://motebit-sync.fly.dev";
const HEARTBEAT_INTERVAL_MS = 5 * 60_000; // 5 minutes

// === Interior Color ===

export const COLOR_PRESETS: Record<string, InteriorColor> = {
  moonlight: { tint: [0.95, 0.95, 1.0], glow: [0.8, 0.85, 1.0] },
  amber: { tint: [1.0, 0.85, 0.6], glow: [0.9, 0.7, 0.3] },
  rose: { tint: [1.0, 0.82, 0.88], glow: [0.9, 0.5, 0.6] },
  violet: { tint: [0.88, 0.8, 1.0], glow: [0.6, 0.4, 0.9] },
  cyan: { tint: [0.8, 0.95, 1.0], glow: [0.3, 0.8, 0.9] },
  ember: { tint: [1.0, 0.75, 0.65], glow: [0.9, 0.35, 0.2] },
  sage: { tint: [0.82, 0.95, 0.85], glow: [0.4, 0.75, 0.5] },
};

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0,
    g = 0,
    b = 0;
  if (h < 60) {
    r = c;
    g = x;
  } else if (h < 120) {
    r = x;
    g = c;
  } else if (h < 180) {
    g = c;
    b = x;
  } else if (h < 240) {
    g = x;
    b = c;
  } else if (h < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  return [r + m, g + m, b + m];
}

export function deriveInteriorColor(hue: number, saturation: number): InteriorColor {
  const tint = hslToRgb(hue, saturation * 0.9, 0.92 - saturation * 0.12);
  const glow = hslToRgb(hue, saturation * 0.8 + 0.2, 0.72 - saturation * 0.17);
  return { tint, glow };
}

// === SpatialApp ===

export class SpatialApp {
  readonly adapter: WebXRThreeJSAdapter;
  readonly dynamics: OrbitalDynamics;
  readonly voicePipeline: SpatialVoicePipeline;
  readonly gestures: GestureRecognizer;
  readonly heartbeat: AmbientHeartbeat;

  private runtime: MotebitRuntime | null = null;
  private storage: StorageAdapters | null = null;
  private keyring: KeyringAdapter;
  private keyStore = new EncryptedKeyStore();
  private latestCues: BehaviorCues = {
    hover_distance: 0.4,
    drift_amplitude: 0.02,
    glow_intensity: 0.3,
    eye_dilation: 0.3,
    smile_curvature: 0.5,
    speaking_activity: 0,
  };
  private attentionLevel = 0.2;
  private unsubscribeState: (() => void) | null = null;
  private _presenceState: PresenceState = "ambient";

  // Network settings
  private networkSettings: SpatialNetworkSettings = {
    relayUrl: DEFAULT_RELAY_URL,
    showNetwork: true,
  };

  // Relay + sync state
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private relayAuthToken: string | null = null;
  private tokenFactory: (() => Promise<string>) | null = null;
  private _privKeyBytes: Uint8Array | null = null;
  private _wsAdapter: WebSocketEventStoreAdapter | null = null;
  private _wsTokenRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private _wsUnsubOnEvent: (() => void) | null = null;
  private _syncUnsubscribe: (() => void) | null = null;
  private _planStore: IdbPlanStore | null = null;
  private _planSyncEngine: PlanSyncEngine | null = null;
  private _convSyncEngine: ConversationSyncEngine | null = null;
  private _pendingApprovalResolve: ((approved: boolean) => void) | null = null;
  private _syncStatus:
    | "offline"
    | "connecting"
    | "connected"
    | "syncing"
    | "error"
    | "disconnected" = "offline";
  private _syncStatusListeners = new Set<(status: string) => void>();

  // MCP servers
  private mcpAdapters = new Map<string, McpClientAdapter>();
  private _mcpServers: McpServerConfig[] = [];

  // Proxy session state
  private _proxySession: ProxySession | null = null;
  private _proxyConfig: ProxyProviderConfig | null = null;

  // Interior color
  private _interiorColor: InteriorColor | null = null;

  motebitId = "spatial-local";
  deviceId = "spatial-local";
  publicKey = "";

  constructor() {
    this.adapter = new WebXRThreeJSAdapter();
    this.dynamics = new OrbitalDynamics();
    this.voicePipeline = new SpatialVoicePipeline();
    this.gestures = new GestureRecognizer();
    this.heartbeat = new AmbientHeartbeat();
    this.keyring = new LocalStorageKeyringAdapter();

    // Wire voice pipeline callbacks
    this.voicePipeline.setCallbacks({
      onTranscript: (text: string) => {
        this.setPresenceState("engaged");
        this.voicePipeline.markProcessing();
        void this.sendAndSpeak(text);
      },
      onStateChange: (state) => {
        if (state === "listening") this.setPresenceState("attentive");
        else if (state === "speaking") this.setPresenceState("speaking");
        else if (state === "processing") this.setPresenceState("processing");
        else if (state === "ambient") this.setPresenceState("ambient");
      },
      onAudioReactivity: (energy) => {
        this.adapter.setAudioReactivity(energy);
      },
    });

    // Wire gesture callbacks — pinch approves, dismiss denies pending tool calls
    this.gestures.setCallbacks({
      onGesture: (event) => {
        switch (event.type) {
          case "pinch":
            if (this._pendingApprovalResolve) {
              this._pendingApprovalResolve(true);
              this._pendingApprovalResolve = null;
            } else {
              this.bumpAttention(0.3);
            }
            break;
          case "beckon":
            this.bumpAttention(0.5);
            break;
          case "dismiss":
            if (this._pendingApprovalResolve) {
              this._pendingApprovalResolve(false);
              this._pendingApprovalResolve = null;
            } else {
              this.decayAttention();
            }
            break;
          case "pause":
            this.setPresenceState("dormant");
            break;
        }
      },
    });

    // Wire heartbeat callbacks
    this.heartbeat.setCallbacks({
      onProactiveUtterance: (text: string) => {
        void this.voicePipeline.speak(text);
      },
      getPresenceState: () => this._presenceState,
    });
  }

  // === Presence State Machine ===

  get presenceState(): PresenceState {
    return this._presenceState;
  }

  setPresenceState(state: PresenceState): void {
    if (this._presenceState === state) return;
    this._presenceState = state;

    // Push presence-derived values into the runtime state vector
    const mapping = PRESENCE_MAP[state];
    if (this.runtime) {
      this.runtime.pushStateUpdate({
        social_distance: mapping.social_distance,
        attention: mapping.attention,
        processing: mapping.processing,
      });
    }
    this.attentionLevel = mapping.attention;

    // Update listening indicator on the render adapter
    this.adapter.setListeningIndicator(
      state === "attentive" || state === "engaged" || state === "processing",
    );
  }

  // === Lifecycle ===

  /** Initialize the WebXR adapter with the canvas. */
  async init(canvas: HTMLCanvasElement): Promise<void> {
    await this.adapter.init(canvas);
  }

  /**
   * Bootstrap identity — delegates to shared bootstrapIdentity() protocol.
   * Creates identity in IndexedDB, registers device, logs event.
   * Private key stored via EncryptedKeyStore (WebCrypto + IndexedDB).
   */
  async bootstrap(): Promise<{ isFirstLaunch: boolean }> {
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

    const keyStore: BootstrapKeyStore = new EncryptedKeyStore();
    const storage = await createBrowserStorage();
    this.storage = storage;

    const result = await sharedBootstrapIdentity({
      surfaceName: "Spatial",
      identityStorage: storage.identityStorage,
      eventStoreAdapter: storage.eventStore,
      configStore,
      keyStore,
    });

    this.motebitId = result.motebitId;
    this.deviceId = result.deviceId;
    this.publicKey = result.publicKeyHex;

    // Preload caches for sync access
    const convStore = storage.conversationStore as IdbConversationStore;
    await convStore.preload(this.motebitId);
    const planStore = storage.planStore as IdbPlanStore;
    await planStore.preload(this.motebitId);
    const gradientStore = storage.gradientStore as IdbGradientStore;
    await gradientStore.preload(this.motebitId);

    // Store plan store reference for sync
    this._planStore = planStore;

    // Build a token factory for the relay (refreshes on each call — 5-min expiry)
    const privateKeyHex = await this.keyStore.loadPrivateKey();
    if (privateKeyHex != null && privateKeyHex !== "") {
      const privKeyBytes = new Uint8Array(privateKeyHex.length / 2);
      for (let i = 0; i < privateKeyHex.length; i += 2) {
        privKeyBytes[i / 2] = parseInt(privateKeyHex.slice(i, i + 2), 16);
      }
      this._privKeyBytes = privKeyBytes;
      const motebitId = this.motebitId;
      const deviceId = this.deviceId;
      this.tokenFactory = async (): Promise<string> => {
        return createSignedToken(
          {
            mid: motebitId,
            did: deviceId,
            iat: Date.now(),
            exp: Date.now() + 5 * 60 * 1000,
            jti: crypto.randomUUID(),
            aud: "sync",
          },
          privKeyBytes,
        );
      };
    }

    return { isFirstLaunch: result.isFirstLaunch };
  }

  // === Proxy Session ===

  /**
   * Attempt proxy bootstrap before requiring an API key.
   * Call after bootstrap() but before initAI(). If this returns true,
   * pass { provider: "proxy" } to initAI() — the token and model are stored internally.
   */
  async tryProxyBootstrap(): Promise<boolean> {
    const motebitId = this.motebitId;
    const adapter: ProxySessionAdapter = {
      getSyncUrl() {
        try {
          return localStorage.getItem("motebit:sync_url");
        } catch {
          return null;
        }
      },
      getMotebitId() {
        return motebitId !== "spatial-local" ? motebitId : null;
      },
      loadToken() {
        try {
          const raw = localStorage.getItem("motebit:proxy_token");
          if (raw)
            return JSON.parse(raw) as {
              token: string;
              balance: number;
              balanceUsd: number;
              expiresAt: number;
              motebitId: string;
            };
        } catch {
          // localStorage unavailable or corrupt
        }
        return null;
      },
      saveToken(data) {
        try {
          localStorage.setItem("motebit:proxy_token", JSON.stringify(data));
        } catch {
          // localStorage unavailable
        }
      },
      clearToken() {
        try {
          localStorage.removeItem("motebit:proxy_token");
        } catch {
          // localStorage unavailable
        }
      },
      onProviderReady: (config: ProxyProviderConfig) => {
        this._proxyConfig = config;
      },
    };

    this._proxySession = new ProxySession(adapter);
    return this._proxySession.bootstrap();
  }

  /** Dispose proxy session refresh timer. Call on app shutdown. */
  disposeProxySession(): void {
    this._proxySession?.dispose();
  }

  // === AI Integration ===

  /**
   * Create the AI provider and wire MotebitRuntime with persistent browser storage.
   * Returns false if the provider needs an API key that wasn't provided.
   */
  async initAI(config: SpatialAIConfig): Promise<boolean> {
    // Honor the historical `"ollama"` provider name on inbound configs
    // (e.g. from persisted IndexedDB state or old callers) by rewriting
    // to `"local-server"`. Vendor-neutral name, same runtime behavior.
    const legacyProvider = (config as unknown as { provider?: string }).provider;
    if (legacyProvider === "ollama") {
      config = { ...config, provider: "local-server" };
    }
    const resolved = config.personalityConfig ? resolveConfig(config.personalityConfig) : undefined;
    const temperature = resolved?.temperature;

    let provider;
    if (config.provider === "proxy") {
      const pc = this._proxyConfig;
      const model =
        config.model != null && config.model !== ""
          ? config.model
          : (pc?.model ?? DEFAULT_PROXY_MODEL);
      const proxyUrl = pc?.baseUrl ?? config.baseUrl ?? "https://api.motebit.com";
      const extraHeaders: Record<string, string> = {};
      if (pc?.proxyToken) extraHeaders["x-proxy-token"] = pc.proxyToken;
      provider = new CloudProvider({
        api_key: "",
        model,
        base_url: proxyUrl,
        max_tokens: config.maxTokens,
        temperature,
        extra_headers: Object.keys(extraHeaders).length > 0 ? extraHeaders : undefined,
      });
    } else if (config.provider === "local-server") {
      // Local inference via Ollama's OpenAI-compatible shim. The previous
      // OllamaProvider class was deleted (2026-04-06) — every local server
      // (Ollama, LM Studio, llama.cpp, Jan, vLLM) now goes through
      // OpenAIProvider against the /v1 endpoint.
      const model =
        config.model != null && config.model !== "" ? config.model : DEFAULT_OLLAMA_MODEL;
      provider = new OpenAIProvider({
        api_key: "local",
        model,
        base_url: `${DEFAULT_OLLAMA_URL}/v1`,
        max_tokens: config.maxTokens,
        temperature,
      });
    } else if (config.provider === "openai") {
      if (config.apiKey == null || config.apiKey === "") return false;
      const model =
        config.model != null && config.model !== "" ? config.model : DEFAULT_OPENAI_MODEL;
      // Use the real OpenAI HTTP client. The previous code constructed
      // CloudProvider with `provider: "openai"`, which produced
      // Anthropic-format requests against OpenAI's endpoint and 404'd.
      provider = new OpenAIProvider({
        api_key: config.apiKey,
        model,
        base_url: "https://api.openai.com/v1",
        max_tokens: config.maxTokens,
        temperature,
      });
    } else {
      if (config.apiKey == null || config.apiKey === "") return false;
      const model =
        config.model != null && config.model !== "" ? config.model : DEFAULT_ANTHROPIC_MODEL;
      provider = new CloudProvider({
        api_key: config.apiKey,
        model,
        max_tokens: config.maxTokens,
        temperature,
      });
    }

    const storage = this.storage ?? (await createBrowserStorage());

    // Governance config → policy + memory governance
    const gov = config.governance;
    const presetConfigs: Record<
      string,
      { maxRiskLevel: number; requireApprovalAbove: number; denyAbove: number }
    > = {
      cautious: { maxRiskLevel: 3, requireApprovalAbove: 0, denyAbove: 3 },
      balanced: { maxRiskLevel: 3, requireApprovalAbove: 1, denyAbove: 3 },
      autonomous: { maxRiskLevel: 4, requireApprovalAbove: 3, denyAbove: 4 },
    };
    const preset = gov
      ? (presetConfigs[gov.approvalPreset] ?? presetConfigs.balanced!)
      : presetConfigs.balanced!;

    this.runtime = new MotebitRuntime(
      {
        motebitId: this.motebitId,
        tickRateHz: 2,
        policy: {
          operatorMode: false,
          maxRiskLevel: preset.maxRiskLevel,
          requireApprovalAbove: preset.requireApprovalAbove,
          denyAbove: preset.denyAbove,
          budget: gov ? { maxCallsPerTurn: gov.maxCallsPerTurn } : undefined,
        },
        memoryGovernance: gov
          ? {
              persistenceThreshold: gov.persistenceThreshold,
              rejectSecrets: gov.rejectSecrets,
              maxMemoriesPerTurn: gov.maxMemoriesPerTurn,
            }
          : undefined,
        taskRouter: PLANNING_TASK_ROUTER,
      },
      { storage, renderer: this.adapter, ai: provider, keyring: this.keyring },
    );

    // Spatial surface: HTTP MCP only (no stdio, no filesystem)
    this.runtime.setLocalCapabilities([DeviceCapability.HttpMcp]);

    // Subscribe to state changes — feed attention level for orbital dynamics
    this.unsubscribeState = this.runtime.subscribe((state: MotebitState) => {
      this.attentionLevel = state.attention;
      // Feed trust mode to render adapter
      this.adapter.setTrustMode(state.trust_mode);
    });

    // Wire heartbeat to runtime
    this.heartbeat.setRuntime(this.runtime);
    this.heartbeat.start();

    // Reconnect saved MCP servers (best-effort, non-blocking)
    void this.reconnectMcpServers();

    return true;
  }

  get isAIReady(): boolean {
    return this.runtime?.isAIReady ?? false;
  }

  get isProcessing(): boolean {
    return this.runtime?.isProcessing ?? false;
  }

  // === Network Settings ===

  /**
   * Update relay / agent network settings.
   * Call this after loading settings from localStorage.
   */
  setNetworkSettings(settings: Partial<SpatialNetworkSettings>): void {
    if (settings.relayUrl !== undefined) this.networkSettings.relayUrl = settings.relayUrl;
    if (settings.showNetwork !== undefined) this.networkSettings.showNetwork = settings.showNetwork;
  }

  get networkConfig(): SpatialNetworkSettings {
    return { ...this.networkSettings };
  }

  // === Self-Awareness Accessors ===

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

  async reflect() {
    if (!this.runtime) throw new Error("AI not initialized");
    return this.runtime.reflect();
  }

  // === Interior Color ===

  setInteriorColor(presetName: string): void {
    const preset = COLOR_PRESETS[presetName];
    if (!preset) return;
    this._interiorColor = preset;
    this.adapter.setInteriorColor(preset);
  }

  setInteriorColorDirect(color: InteriorColor): void {
    this._interiorColor = color;
    this.adapter.setInteriorColor(color);
  }

  getInteriorColor(): InteriorColor | null {
    return this._interiorColor;
  }

  // === MCP Management ===

  async addMcpServer(config: McpServerConfig): Promise<void> {
    if (config.transport !== "http") {
      throw new Error(
        "Spatial only supports HTTP MCP servers. Use the desktop or CLI app for stdio servers.",
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

  // eslint-disable-next-line @typescript-eslint/require-await -- implements async interface
  async setMcpServerTrust(name: string, trusted: boolean): Promise<void> {
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

  // === Conversation Management ===

  get activeConversationId(): string | null {
    return this.runtime?.getConversationId() ?? null;
  }

  getConversationHistory(): ConversationMessage[] {
    return this.runtime?.getConversationHistory() ?? [];
  }

  resetConversation(): void {
    this.runtime?.resetConversation();
  }

  loadConversationById(id: string): ConversationMessage[] {
    if (!this.runtime) return [];
    this.runtime.loadConversation(id);
    return this.runtime.getConversationHistory();
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

  deleteConversation(id: string): void {
    this.runtime?.deleteConversation(id);
  }

  async autoTitle(): Promise<string | null> {
    return this.runtime?.autoTitle() ?? null;
  }

  async summarize(): Promise<string | null> {
    return this.runtime?.summarizeCurrentConversation() ?? null;
  }

  async housekeeping(): Promise<void> {
    await this.runtime?.housekeeping();
  }

  /** Delete a memory node by ID. */
  async deleteMemory(nodeId: string): Promise<void> {
    await this.runtime?.memory.deleteMemory(nodeId);
  }

  /** Audit memory integrity — find phantoms, conflicts, near-death nodes. */
  async auditMemory(): Promise<{
    phantoms: number;
    conflicts: number;
    nearDeath: number;
    total: number;
  }> {
    if (!this.runtime) return { phantoms: 0, conflicts: 0, nearDeath: 0, total: 0 };
    const result = await this.runtime.auditMemory();
    return {
      phantoms: result.phantomCertainties.length,
      conflicts: result.conflicts.length,
      nearDeath: result.nearDeath.length,
      total: result.nodesAudited,
    };
  }

  // === Goals (one-shot) ===

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

  // === Sync Status ===

  get syncStatus(): string {
    return this._syncStatus;
  }

  onSyncStatusChange(cb: (status: string) => void): () => void {
    this._syncStatusListeners.add(cb);
    return () => {
      this._syncStatusListeners.delete(cb);
    };
  }

  private setSyncStatus(status: typeof this._syncStatus): void {
    this._syncStatus = status;
    for (const cb of this._syncStatusListeners) cb(status);
  }

  // === Relay Integration + Multi-Device Sync ===

  /**
   * Connect to the relay: bootstrap identity, register for discovery, start heartbeat,
   * open encrypted WebSocket for real-time event sync, wire delegation adapter through
   * the WebSocket, and start plan sync.
   *
   * Best-effort — any relay error is swallowed; the app works offline.
   * Must be called after bootstrap() and initAI().
   */
  async connectRelay(): Promise<void> {
    const { relayUrl, showNetwork } = this.networkSettings;
    if (relayUrl === "" || !showNetwork) return;

    this.setSyncStatus("connecting");

    // Mint an initial token
    let authToken: string | null = null;
    if (this.tokenFactory) {
      try {
        authToken = await this.tokenFactory();
        this.relayAuthToken = authToken;
      } catch {
        // No private key — relay auth will be anonymous
      }
    }

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

    // 1. Bootstrap identity on relay
    try {
      await fetch(`${relayUrl}/api/v1/agents/bootstrap`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          motebit_id: this.motebitId,
          device_id: this.deviceId,
          public_key: this.publicKey,
        }),
      });
    } catch {
      // Best-effort
    }

    // 2. Register capabilities for discovery
    const toolNames =
      this.runtime
        ?.getToolRegistry()
        .list()
        .map((t) => t.name) ?? [];
    try {
      const regResp = await fetch(`${relayUrl}/api/v1/agents/register`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          motebit_id: this.motebitId,
          endpoint_url: relayUrl,
          capabilities: toolNames,
          metadata: { name: `spatial-${this.motebitId.slice(0, 8)}`, transport: "http" },
        }),
      });

      if (regResp.ok) {
        this.heartbeatTimer = setInterval(() => {
          void (async () => {
            try {
              const freshToken = this.tokenFactory ? await this.tokenFactory() : authToken;
              const hbHeaders: Record<string, string> = { "Content-Type": "application/json" };
              if (freshToken) hbHeaders["Authorization"] = `Bearer ${freshToken}`;
              await fetch(`${relayUrl}/api/v1/agents/heartbeat`, {
                method: "POST",
                headers: hbHeaders,
              });
            } catch {
              // Best-effort heartbeat
            }
          })();
        }, HEARTBEAT_INTERVAL_MS);
      }
    } catch {
      // Best-effort registration
    }

    // 3. Real-time event sync via encrypted WebSocket
    if (this.runtime && authToken && this._privKeyBytes) {
      try {
        const encKey = await deriveSyncEncryptionKey(this._privKeyBytes);
        const localEventStore = this.storage?.eventStore ?? null;

        // HTTP fallback adapter (for initial sync / offline recovery)
        const httpAdapter = new HttpEventStoreAdapter({
          baseUrl: relayUrl,
          motebitId: this.motebitId,
          authToken,
        });
        const encryptedHttp = new EncryptedEventStoreAdapter({ inner: httpAdapter, key: encKey });

        // WebSocket adapter (real-time)
        const wsUrl =
          relayUrl.replace(/^https?/, (m) => (m === "https" ? "wss" : "ws")) +
          "/ws/sync/" +
          this.motebitId;

        const wsAdapter = new WebSocketEventStoreAdapter({
          url: wsUrl,
          motebitId: this.motebitId,
          authToken,
          capabilities: [DeviceCapability.HttpMcp],
          httpFallback: encryptedHttp,
          localStore: localEventStore ?? undefined,
        });
        this._wsAdapter = wsAdapter;

        // Wire delegation through the WebSocket (not no-op)
        const delegationAdapter = new RelayDelegationAdapter({
          syncUrl: relayUrl,
          motebitId: this.motebitId,
          authToken: authToken ?? undefined,
          sendRaw: (data: string) => wsAdapter.sendRaw(data),
          onCustomMessage: (cb) => wsAdapter.onCustomMessage(cb),
          getExplorationDrive: () => this.runtime?.getPrecision().explorationDrive,
        });
        this.runtime.setDelegationAdapter(delegationAdapter);

        const encryptedWs = new EncryptedEventStoreAdapter({ inner: wsAdapter, key: encKey });

        // Inbound real-time events: decrypt and write to local store
        this._wsUnsubOnEvent = wsAdapter.onEvent((raw) => {
          void (async () => {
            if (!localEventStore) return;
            const dec = await decryptEventPayload(raw, encKey);
            await localEventStore.append(dec);
          })();
        });

        // Handle remote command requests (forwarded by relay)
        wsAdapter.onCustomMessage((msg) => {
          if (msg.type !== "command_request" || !this.runtime) return;
          const cmdMsg = msg as unknown as { id: string; command: string; args?: string };
          void (async () => {
            try {
              const result = await executeCommand(this.runtime!, cmdMsg.command, cmdMsg.args);
              wsAdapter.sendRaw(
                JSON.stringify({ type: "command_response", id: cmdMsg.id, result }),
              );
            } catch (err: unknown) {
              wsAdapter.sendRaw(
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
        });

        this.runtime.connectSync(encryptedWs);
        wsAdapter.connect();

        // Subscribe to sync engine status
        if (this._syncUnsubscribe) this._syncUnsubscribe();
        this._syncUnsubscribe = this.runtime.sync.onStatusChange((engineStatus: SyncStatus) => {
          if (engineStatus === "syncing") this.setSyncStatus("syncing");
          else if (engineStatus === "idle") this.setSyncStatus("connected");
          else if (engineStatus === "error") this.setSyncStatus("error");
          else if (engineStatus === "offline") this.setSyncStatus("disconnected");
        });

        this.runtime.startSync();
        this.setSyncStatus("connected");

        // 4. Plan sync — push/pull plans to relay for cross-device visibility
        if (this._planStore) {
          const planSyncStore = new IdbPlanSyncStore(this._planStore, this.motebitId);
          this._planSyncEngine = new PlanSyncEngine(planSyncStore, this.motebitId);
          const httpPlanAdapter = new HttpPlanSyncAdapter({
            baseUrl: relayUrl,
            motebitId: this.motebitId,
            authToken: authToken ?? undefined,
          });
          this._planSyncEngine.connectRemote(
            new EncryptedPlanSyncAdapter({ inner: httpPlanAdapter, key: encKey }),
          );
          void this._planSyncEngine.sync();
          this._planSyncEngine.start();
        }

        // 5. Conversation sync — encrypted, push/pull for cross-device visibility
        if (this.storage?.conversationStore) {
          const convSyncStore = new IdbConversationSyncStore(
            this.storage.conversationStore as IdbConversationStore,
            this.motebitId,
          );
          this._convSyncEngine = new ConversationSyncEngine(convSyncStore, this.motebitId);
          const httpConvAdapter = new HttpConversationSyncAdapter({
            baseUrl: relayUrl,
            motebitId: this.motebitId,
            authToken: authToken ?? undefined,
          });
          this._convSyncEngine.connectRemote(
            new EncryptedConversationSyncAdapter({ inner: httpConvAdapter, key: encKey }),
          );
          void this._convSyncEngine.sync();
          this._convSyncEngine.start();
        }

        // 6. Recover orphaned delegated steps from a previous session
        void (async () => {
          try {
            for await (const _chunk of this.runtime!.recoverDelegatedSteps()) {
              // Consumed — plan store updates propagate to UI
            }
          } catch {
            // Best-effort
          }
        })();

        // Adversarial onboarding: run self-test once after first relay connection
        void this.runOnboardingSelfTest(relayUrl, authToken ?? "");

        // 7. Token refresh every 4.5 min — rebuild WS with fresh auth
        this._wsTokenRefreshTimer = setInterval(() => {
          void (async () => {
            try {
              if (!this._wsAdapter || !this.tokenFactory || !this._privKeyBytes) return;
              this._wsAdapter.disconnect();

              const freshToken = await this.tokenFactory();
              const freshEncKey = await deriveSyncEncryptionKey(this._privKeyBytes);

              const freshWs = new WebSocketEventStoreAdapter({
                url: wsUrl,
                motebitId: this.motebitId,
                authToken: freshToken,
                capabilities: [DeviceCapability.HttpMcp],
                httpFallback: encryptedHttp,
                localStore: localEventStore ?? undefined,
              });

              // Re-wire delegation with fresh WS
              const freshDelegation = new RelayDelegationAdapter({
                syncUrl: relayUrl,
                motebitId: this.motebitId,
                authToken: freshToken ?? undefined,
                sendRaw: (data: string) => freshWs.sendRaw(data),
                onCustomMessage: (cb) => freshWs.onCustomMessage(cb),
                getExplorationDrive: () => this.runtime?.getPrecision().explorationDrive,
              });
              this.runtime?.setDelegationAdapter(freshDelegation);

              if (this._wsUnsubOnEvent) this._wsUnsubOnEvent();
              this._wsUnsubOnEvent = freshWs.onEvent((raw) => {
                void (async () => {
                  if (!localEventStore) return;
                  const dec = await decryptEventPayload(raw, freshEncKey);
                  await localEventStore.append(dec);
                })();
              });

              const freshEncrypted = new EncryptedEventStoreAdapter({
                inner: freshWs,
                key: freshEncKey,
              });
              this.runtime?.connectSync(freshEncrypted);
              freshWs.connect();
              this._wsAdapter = freshWs;
            } catch {
              // Token refresh failed — WS will retry on reconnect
            }
          })();
        }, 4.5 * 60_000);
      } catch {
        // Sync setup failed — fall back to delegation-only
        this.setSyncStatus("error");
        if (this.runtime != null && this.tokenFactory != null) {
          const tokenFactory = this.tokenFactory;
          const inner = new RelayDelegationAdapter({
            syncUrl: relayUrl,
            motebitId: this.motebitId,
            authToken: tokenFactory,
            sendRaw: () => {},
            onCustomMessage: () => () => {},
            getExplorationDrive: () => this.runtime?.getPrecision().explorationDrive,
          });
          this.runtime.setDelegationAdapter(inner);
        }
      }
    } else if (this.runtime && this.tokenFactory) {
      // No private key bytes — delegation only (no encrypted sync)
      const tokenFactory = this.tokenFactory;
      const inner = new RelayDelegationAdapter({
        syncUrl: relayUrl,
        motebitId: this.motebitId,
        authToken: tokenFactory,
        sendRaw: () => {},
        onCustomMessage: () => () => {},
        getExplorationDrive: () => this.runtime?.getPrecision().explorationDrive,
      });
      this.runtime.setDelegationAdapter(inner);
      this.setSyncStatus("disconnected");
    }
  }

  /**
   * Disconnect from the relay: stop sync, close WebSocket, deregister.
   */
  async disconnectRelay(): Promise<void> {
    // Stop token refresh
    if (this._wsTokenRefreshTimer) {
      clearInterval(this._wsTokenRefreshTimer);
      this._wsTokenRefreshTimer = null;
    }

    // Stop plan sync
    if (this._planSyncEngine) {
      this._planSyncEngine.stop();
      this._planSyncEngine = null;
    }

    // Stop conversation sync
    if (this._convSyncEngine) {
      this._convSyncEngine.stop();
      this._convSyncEngine = null;
    }

    // Unsubscribe event listeners
    if (this._wsUnsubOnEvent) {
      this._wsUnsubOnEvent();
      this._wsUnsubOnEvent = null;
    }
    if (this._syncUnsubscribe) {
      this._syncUnsubscribe();
      this._syncUnsubscribe = null;
    }

    // Close WebSocket
    if (this._wsAdapter) {
      this._wsAdapter.disconnect();
      this._wsAdapter = null;
    }

    // Stop sync engine
    this.runtime?.sync.stop();

    // Stop heartbeat
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Best-effort deregistration
    const { relayUrl } = this.networkSettings;
    if (relayUrl !== "") {
      try {
        const headers: Record<string, string> = {};
        if (this.relayAuthToken) headers["Authorization"] = `Bearer ${this.relayAuthToken}`;
        await fetch(`${relayUrl}/api/v1/agents/deregister`, { method: "DELETE", headers });
      } catch {
        // Best-effort
      }
    }

    // Erase private key bytes when disconnecting from relay
    if (this._privKeyBytes) {
      secureErase(this._privKeyBytes);
      this._privKeyBytes = null;
    }

    this.setSyncStatus("disconnected");
  }

  /**
   * Run cmdSelfTest exactly once per device. Uses localStorage flag to avoid
   * repeating on subsequent launches. Best-effort — failures are logged, never blocking.
   */
  private async runOnboardingSelfTest(relayUrl: string, authToken: string): Promise<void> {
    const FLAG = "motebit:self-test-done";
    try {
      if (localStorage.getItem(FLAG) === "true") return;
    } catch {
      return; // localStorage unavailable
    }
    if (!this.runtime) return;

    try {
      const mintToken = async (): Promise<string> => {
        if (this.tokenFactory) return this.tokenFactory();
        return authToken;
      };
      const token = await mintToken();
      if (!token) return;

      const result = await cmdSelfTest(this.runtime, {
        relay: { relayUrl, authToken: token, motebitId: this.motebitId },
        mintToken,
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

  // === Voice Commands ===

  /**
   * Try to handle a voice transcript as a command. Routes natural-language voice
   * input to the shared command layer (executeCommand) via fuzzy pattern matching.
   *
   * Returns spoken response if handled, or null to fall through to AI conversation.
   */
  private async tryVoiceCommand(text: string): Promise<string | null> {
    if (!this.runtime) return null;

    const lower = text.toLowerCase().trim();

    // Map natural-language patterns to shared command names + args
    const command = this.matchVoicePattern(lower);
    if (!command) return null;

    const { name, args } = command;

    // Surface-specific commands that can't go through the shared layer
    if (name === "clear") {
      this.resetConversation();
      return "Conversation cleared.";
    }
    if (name === "mcp") {
      const servers = this.getMcpServers();
      if (servers.length === 0) return "No MCP servers connected.";
      return `${servers.length} MCP servers: ${servers.map((s) => s.name).join(", ")}.`;
    }
    if (name === "serve") {
      return "Serving is configured through the relay. Use the CLI to start serving with a price.";
    }
    if (name === "load_conversation") {
      return this.handleLoadConversation(lower);
    }
    if (name === "delete_conversation") {
      return this.handleDeleteConversation(lower);
    }
    if (name === "goal") {
      return this.handleGoalExecution(text);
    }

    // Shared command layer — same data extraction and formatting as all surfaces
    const relay = this.getRelayConfig();
    try {
      const result = await executeCommand(this.runtime, name, args, relay ?? undefined);
      if (!result) return null;

      // For TTS: speak summary, include detail if short enough
      if (result.detail && result.detail.length < 200) {
        return `${result.summary}. ${result.detail}`;
      }
      return result.summary;
    } catch (err: unknown) {
      return `${name} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** Build RelayConfig from current connection state, or null if not connected. */
  private getRelayConfig(): RelayConfig | null {
    const { relayUrl } = this.networkSettings;
    if (!relayUrl || !this.relayAuthToken) return null;
    return { relayUrl, authToken: this.relayAuthToken, motebitId: this.motebitId };
  }

  /**
   * Match natural-language voice input to a command name.
   * Returns null if no pattern matches (fall through to AI).
   */
  private matchVoicePattern(lower: string): { name: string; args?: string } | null {
    // State
    if (/^(what('?s| is) my )?state/.test(lower) || /^show ?(me )?(the )?state/.test(lower))
      return { name: "state" };

    // Balance
    if (/^(what('?s| is) my )?balance/.test(lower) || /^show ?(me )?(the )?balance/.test(lower))
      return { name: "balance" };

    // Memories
    if (/^(show |list |what are )?(my )?memories/.test(lower)) return { name: "memories" };

    // Graph
    if (/^(memory )?graph/.test(lower)) return { name: "graph" };

    // Curiosity
    if (/^(what('?s| is) )?(my )?curios/.test(lower)) return { name: "curious" };

    // Gradient
    if (/^(what('?s| is) )?(my )?gradient/.test(lower) || /^how am i doing/.test(lower))
      return { name: "gradient" };

    // Reflect
    if (/^reflect/.test(lower) || /^self.?reflect/.test(lower)) return { name: "reflect" };

    // Discover
    if (
      /^(discover|find|search for) agent/.test(lower) ||
      /^who('?s| is) (on|available)/.test(lower)
    )
      return { name: "discover" };

    // Approvals
    if (/^(show |any |pending )?approval/.test(lower)) return { name: "approvals" };

    // Forget
    if (/^forget (about |memory )?(.+)/i.test(lower)) {
      const keyword = lower.replace(/^forget (about |memory )?/i, "").trim();
      return { name: "forget", args: keyword };
    }

    // Audit
    if (/^audit (my )?(memory|memories)/.test(lower)) return { name: "audit" };

    // Summarize
    if (/^summarize/.test(lower) || /^sum up/.test(lower)) return { name: "summarize" };

    // Conversations list
    if (/^(list |show |my )?(previous |past )?(conversation|chat|session)s/.test(lower))
      return { name: "conversations" };

    // Load conversation (surface-specific — needs state mutation)
    if (/^(load|open|resume) (conversation|chat) /.test(lower))
      return { name: "load_conversation" };

    // Delete conversation (surface-specific — needs state mutation)
    if (/^delete (conversation|chat) /.test(lower)) return { name: "delete_conversation" };

    // Goal execution (surface-specific — streaming)
    if (/^(goal|plan|do|execute|run):? (.+)/i.test(lower)) return { name: "goal" };

    // Deposits
    if (/^(show |my )?deposit/.test(lower)) return { name: "deposits" };

    // Proposals
    if (/^(show |my |list )?proposal/.test(lower)) return { name: "proposals" };

    // Clear
    if (/^(clear|reset|new) (conversation|chat|session)/.test(lower)) return { name: "clear" };

    // Model
    if (/^(what |which )?(model|ai)/.test(lower)) return { name: "model" };

    // MCP
    if (/^(list |show )?(mcp|servers)/.test(lower)) return { name: "mcp" };

    // Tools
    if (/^(list |show |what )?(my )?tools/.test(lower)) return { name: "tools" };

    // Serve
    if (/^(start |begin )?serv(e|ing)/.test(lower) || /^accept (task|delegation)/.test(lower))
      return { name: "serve" };

    return null;
  }

  // --- Surface-specific command handlers (state mutations, streaming) ---

  private handleLoadConversation(lower: string): string {
    const convs = this.listConversations();
    if (convs.length === 0) return "No conversations to load.";
    const keyword = lower.replace(/^(load|open|resume) (conversation|chat) ?/i, "").trim();
    const match = keyword ? convs.find((c) => c.title?.toLowerCase().includes(keyword)) : convs[0];
    if (!match) return `No conversation matching "${keyword}".`;
    this.loadConversationById(match.conversationId);
    return `Loaded: ${match.title ?? "untitled conversation"}.`;
  }

  private handleDeleteConversation(lower: string): string {
    const convs = this.listConversations();
    const keyword = lower.replace(/^delete (conversation|chat) ?/i, "").trim();
    const match = keyword ? convs.find((c) => c.title?.toLowerCase().includes(keyword)) : null;
    if (!match) return `No conversation matching "${keyword}".`;
    this.deleteConversation(match.conversationId);
    return `Deleted: ${match.title ?? "untitled conversation"}.`;
  }

  private async handleGoalExecution(text: string): Promise<string> {
    const prompt = text.replace(/^(goal|plan|do|execute|run):?\s*/i, "").trim();
    if (!prompt) return "What should the goal be?";
    const goalId = crypto.randomUUID();
    const evm = new PlanExecutionVM();
    try {
      for await (const chunk of this.executeGoal(goalId, prompt)) {
        evm.apply(chunk);
        // Announce step completions via TTS as they happen
        const snap = evm.snapshot();
        if (chunk.type === "step_completed" && snap.progress.total > 1) {
          await this.voicePipeline.speak(
            `Step ${snap.progress.completed} of ${snap.progress.total}: ${chunk.step.description}.`,
          );
        }
      }
      const snap = evm.snapshot();
      if (snap.status === "completed") {
        return snap.reflection ?? `Goal complete: ${snap.title}.`;
      }
      return `Goal ${snap.status}: ${snap.failureReason ?? snap.title}.`;
    } catch (err: unknown) {
      return `Goal failed: ${err instanceof Error ? err.message : String(err)}.`;
    }
  }

  // === Messaging ===

  /**
   * Send a message through the runtime. Returns an async generator of stream chunks.
   */
  async *sendMessage(text: string): AsyncGenerator<StreamChunk> {
    if (!this.runtime) return;
    yield* this.runtime.sendMessageStreaming(text);
  }

  /**
   * Send a message and speak the response. Handles voice commands, tool approvals,
   * and streaming TTS. Returns the accumulated display text.
   */
  async sendAndSpeak(text: string): Promise<string> {
    if (!this.runtime) return "";

    // Check for voice commands first
    const commandResponse = await this.tryVoiceCommand(text);
    if (commandResponse != null) {
      await this.voicePipeline.speak(commandResponse);
      return commandResponse;
    }

    this.setPresenceState("processing");

    let accumulated = "";
    for await (const chunk of this.runtime.sendMessageStreaming(text)) {
      if (chunk.type === "text") {
        accumulated += chunk.text;
      } else if (chunk.type === "approval_request") {
        // Announce the approval request via TTS
        await this.voicePipeline.speak(
          `Tool ${chunk.name} needs approval. Pinch to approve, dismiss to deny.`,
        );

        // Wait for gesture resolution
        const approved = await new Promise<boolean>((resolve) => {
          this._pendingApprovalResolve = resolve;
          // Auto-deny after 30 seconds if no gesture
          setTimeout(() => {
            if (this._pendingApprovalResolve === resolve) {
              this._pendingApprovalResolve = null;
              resolve(false);
            }
          }, 30_000);
        });

        // Resume the stream after approval
        for await (const resumeChunk of this.runtime.resolveApprovalVote(
          approved,
          this.motebitId,
        )) {
          if (resumeChunk.type === "text") {
            accumulated += resumeChunk.text;
          } else if (resumeChunk.type === "result") {
            accumulated = accumulated || resumeChunk.result.response;
          }
        }

        await this.voicePipeline.speak(approved ? "Approved." : "Denied.");
      } else if (chunk.type === "result") {
        accumulated = accumulated || chunk.result.response;
      }
    }

    // Speak the response (strips tags internally)
    if (accumulated) {
      await this.voicePipeline.speak(accumulated);
    }

    // Background housekeeping (memory decay, gradient computation)
    void this.runtime.housekeeping();
    void this.runtime.autoTitle();

    return accumulated;
  }

  // === Voice ===

  /** Start the voice pipeline. Returns false if unsupported. */
  async startVoice(config?: VoicePipelineConfig): Promise<boolean> {
    if (!SpatialVoicePipeline.isSupported()) return false;
    if (config) this.voicePipeline.updateConfig(config);
    return this.voicePipeline.start();
  }

  /** Stop the voice pipeline. */
  stopVoice(): void {
    this.voicePipeline.stop();
  }

  // === Rendering ===

  /**
   * Render a frame. If runtime is initialized, uses behavior cues from
   * the behavior engine. Otherwise, renders with idle cues.
   */
  renderFrame(dt: number, time: number): void {
    if (this.runtime) {
      this.runtime.renderFrame(dt, time);
    } else {
      this.adapter.render({
        cues: this.latestCues,
        delta_time: dt,
        time,
      });
    }
  }

  /**
   * Tick orbital dynamics and position the creature.
   * Call this each frame in the XR animation loop.
   */
  tickOrbital(dt: number, time: number, headPosition: [number, number, number]): void {
    const anchors = estimateBodyAnchors(headPosition);
    const shoulderAnchor = getAnchorForReference(anchors, "shoulder_right");

    if (shoulderAnchor) {
      const creaturePos = this.dynamics.tick(dt, time, shoulderAnchor, this.attentionLevel);
      this.adapter.setCreatureWorldPosition(creaturePos[0], creaturePos[1], creaturePos[2]);
      this.adapter.setCreatureLookAt(headPosition[0], headPosition[1], headPosition[2]);
    }
  }

  /** Get the current orbital state for gaze calculations. */
  getOrbitalState() {
    return this.dynamics.getState();
  }

  // === Attention (touch / gesture / gaze) ===

  /** Increase attention (touch/pinch/gaze). */
  bumpAttention(amount = 0.3): void {
    this.attentionLevel = Math.min(1, this.attentionLevel + amount);
    if (this.attentionLevel > 0.5 && this._presenceState === "ambient") {
      this.setPresenceState("attentive");
    }
  }

  /** Start decaying attention back to idle. */
  decayAttention(): void {
    const decay = setInterval(() => {
      this.attentionLevel = Math.max(0.2, this.attentionLevel - 0.05);
      if (this.attentionLevel <= 0.2) {
        clearInterval(decay);
        if (this._presenceState === "attentive") {
          this.setPresenceState("ambient");
        }
      }
    }, 100);
  }

  // === Operator Mode ===

  get isOperatorMode(): boolean {
    return this.runtime?.isOperatorMode ?? false;
  }

  async setOperatorMode(enabled: boolean, pin?: string) {
    if (!this.runtime) return { success: false, error: "AI not initialized" };
    return this.runtime.setOperatorMode(enabled, pin);
  }

  async setupOperatorPin(pin: string): Promise<void> {
    if (!this.runtime) throw new Error("AI not initialized");
    return this.runtime.setupOperatorPin(pin);
  }

  // === Identity Export ===

  /**
   * Export a signed motebit.md identity file as a string.
   * The browser UI layer can trigger a download via Blob URL or copy to clipboard.
   * Returns null if identity is not bootstrapped or private key unavailable.
   */
  async exportIdentity(): Promise<string | null> {
    if (this.motebitId === "spatial-local") return null;
    if (!this._privKeyBytes) return null;

    try {
      return await generateIdentityFile(
        {
          motebitId: this.motebitId,
          ownerId: this.motebitId,
          publicKeyHex: this.publicKey,
          devices: [
            {
              device_id: this.deviceId,
              name: "Spatial",
              public_key: this.publicKey,
              registered_at: new Date().toISOString(),
            },
          ],
        },
        this._privKeyBytes,
      );
    } catch {
      return null;
    }
  }

  // === Cleanup ===

  dispose(): void {
    this.voicePipeline.stop();
    this.heartbeat.stop();
    this.gestures.reset();
    this.unsubscribeState?.();
    this.runtime?.stop();

    // Clean up MCP adapters
    for (const adapter of this.mcpAdapters.values()) {
      void adapter.disconnect();
    }
    this.mcpAdapters.clear();

    // Clean up proxy session
    this.disposeProxySession();

    // Clean up relay
    void this.disconnectRelay();

    // Erase long-lived private key bytes
    if (this._privKeyBytes) {
      secureErase(this._privKeyBytes);
      this._privKeyBytes = null;
    }

    this.adapter.dispose();
  }
}
