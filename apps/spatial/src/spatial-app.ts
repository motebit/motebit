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

import { MotebitRuntime, ProxySession, PLANNING_TASK_ROUTER } from "@motebit/runtime";
import type { ProxyProviderConfig, ProxySessionAdapter } from "@motebit/runtime";
import { createBrowserStorage } from "@motebit/browser-persistence";
import type { StreamChunk, KeyringAdapter, StorageAdapters, RelayConfig } from "@motebit/runtime";
import type { PlanChunk, ConversationMessage } from "@motebit/runtime";
import { WebXRThreeJSAdapter } from "@motebit/render-engine";
import type { InteriorColor } from "@motebit/render-engine";
import { resolveConfig, DEFAULT_OLLAMA_URL, type MotebitPersonalityConfig } from "@motebit/ai-core";
import {
  bootstrapIdentity as sharedBootstrapIdentity,
  type BootstrapConfigStore,
  type BootstrapKeyStore,
} from "@motebit/core-identity";
import { createSignedToken, secureErase } from "@motebit/encryption";
import { generate as generateIdentityFile } from "@motebit/identity-file";
import type {
  MotebitState,
  BehaviorCues,
  GovernanceConfig,
  UnifiedProviderConfig,
  ProviderSpec,
  ResolverEnv,
} from "@motebit/sdk";
import {
  DeviceCapability,
  resolveProviderSpec,
  UnsupportedBackendError,
  migrateLegacyProvider,
  type LegacyProviderConfig,
} from "@motebit/sdk";
import type { McpServerConfig } from "@motebit/mcp-client";
import { IdbConversationStore, IdbPlanStore, IdbGradientStore } from "@motebit/browser-persistence";
import { OrbitalDynamics, estimateBodyAnchors, getAnchorForReference } from "./index";
import { SpatialVoicePipeline, type VoicePipelineConfig } from "./voice-pipeline";
import { GestureRecognizer } from "./gestures";
import { AmbientHeartbeat } from "./heartbeat";
import { LocalStorageKeyringAdapter } from "./browser-keyring";
import { EncryptedKeyStore } from "./encrypted-keystore";
import { spatialSpecToProvider } from "./providers";
export { WebLLMProvider } from "./providers";
import { SpatialSyncController } from "./sync-controller";
import { SpatialMcpManager } from "./mcp-manager";
import { tryVoiceCommand } from "./voice-commands";

// === Configuration ===

/**
 * Canonical `GovernanceConfig` lives in `@motebit/sdk`. The spatial surface
 * re-exports it under its historical alias for source-compat with any
 * external consumer that imported `SpatialGovernanceConfig`.
 */
export type SpatialGovernanceConfig = GovernanceConfig;

/**
 * Spatial uses the canonical `UnifiedProviderConfig` from `@motebit/sdk` like
 * the other surfaces. Web is the closest analog because both run in a browser:
 * `SPATIAL_RESOLVER_ENV` mirrors web's — anthropic must go through the proxy
 * (CORS), openai is direct, and the on-device backends are `webllm` and
 * `local-server` (no apple-fm/mlx, those are mobile-only).
 *
 * `SpatialAIConfig` is a thin wrapper around `UnifiedProviderConfig` that
 * carries the spatial-specific surface concerns (`personalityConfig`,
 * `governance`, `maxTokens` override). The `provider` field replaces the
 * legacy flat discriminator. Old persisted shapes flow through
 * `migrateLegacyProvider` from sdk on load.
 */
export interface SpatialAIConfig {
  provider: UnifiedProviderConfig;
  /** Optional surface-level max-tokens override propagated to the provider. */
  maxTokens?: number;
  personalityConfig?: MotebitPersonalityConfig;
  governance?: SpatialGovernanceConfig;
}

/** LLM proxy / cloud relay base URL. Override at build time via VITE_PROXY_URL. */
const SPATIAL_PROXY_BASE_URL: string =
  (import.meta as unknown as Record<string, Record<string, string> | undefined>).env
    ?.VITE_PROXY_URL ?? "https://api.motebit.com";

/**
 * Spatial's `ResolverEnv`. Mirrors web: the browser can't reach
 * `api.anthropic.com` directly (CORS), so anthropic routes through the
 * motebit proxy. OpenAI's CORS allows direct browser calls. The two on-device
 * backends are `webllm` (in-browser via WebGPU) and `local-server` (a LAN
 * inference server the user runs themselves).
 */
export const SPATIAL_RESOLVER_ENV: ResolverEnv = {
  cloudBaseUrl: (wireProtocol, canonical) => {
    if (wireProtocol === "anthropic") return SPATIAL_PROXY_BASE_URL;
    return canonical;
  },
  defaultLocalServerUrl: DEFAULT_OLLAMA_URL,
  supportedBackends: new Set(["webllm", "local-server"]),
  motebitCloudBaseUrl: SPATIAL_PROXY_BASE_URL,
};

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

// Interior color presets — canonical source in @motebit/sdk.
import { COLOR_PRESETS } from "@motebit/sdk";
export { COLOR_PRESETS } from "@motebit/sdk";

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
  /** Get the runtime instance. Null before initAI completes. */
  getRuntime(): MotebitRuntime | null {
    return this.runtime;
  }
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

  // Relay auth state — tokenFactory is populated during initAI, privKeyBytes
  // during bootstrap. Both are read by the sync controller through getters,
  // and exportIdentity also reads privKeyBytes for motebit.md generation.
  private tokenFactory: (() => Promise<string>) | null = null;
  private _privKeyBytes: Uint8Array | null = null;
  private _planStore: IdbPlanStore | null = null;
  private _pendingApprovalResolve: ((approved: boolean) => void) | null = null;

  // Sync controller owns all relay-side state. Lazy-initialized in the
  // constructor so its deps getters can close over `this`.
  private sync!: SpatialSyncController;

  // MCP — class extracted to ./mcp-manager.ts. State lives inside.
  private mcp!: SpatialMcpManager;

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

    this.mcp = new SpatialMcpManager({
      getRuntime: () => this.runtime,
    });

    // Sync controller — reads runtime/identity/keypair through getters so
    // the constructor can wire it before initAI, bootstrap, or any relay
    // activity. See ./sync-controller.ts for the full deps contract.
    this.sync = new SpatialSyncController({
      getRuntime: () => this.runtime,
      getMotebitId: () => this.motebitId,
      getDeviceId: () => this.deviceId,
      getPublicKey: () => this.publicKey,
      getNetworkSettings: () => this.networkSettings,
      getStorage: () => this.storage,
      getPlanStore: () => this._planStore,
      getPrivKey: () => this._privKeyBytes,
      clearPrivKey: () => {
        this._privKeyBytes = null;
      },
      getTokenFactory: () => this.tokenFactory,
    });

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
    const resolvedPersonality = config.personalityConfig
      ? resolveConfig(config.personalityConfig)
      : undefined;
    const temperature = resolvedPersonality?.temperature;

    // Migrate legacy persisted shapes (`{provider: "ollama" | "anthropic" | ...}`)
    // through the sdk's canonical migration. Already-unified configs pass
    // through unchanged. Spatial users have persisted state from before the
    // three-mode refactor, so this path is required.
    const unified: UnifiedProviderConfig =
      "mode" in config.provider
        ? config.provider
        : (migrateLegacyProvider(config.provider as unknown as LegacyProviderConfig) ?? {
            mode: "motebit-cloud",
          });

    // Layer in proxy session state, temperature, and the surface-level
    // maxTokens override before resolving. The proxy session (when present)
    // supplies the signed token and may override the default model.
    const env: ResolverEnv = {
      ...SPATIAL_RESOLVER_ENV,
      motebitCloudHeaders:
        this._proxyConfig?.proxyToken !== undefined
          ? { "x-proxy-token": this._proxyConfig.proxyToken }
          : undefined,
      motebitCloudBaseUrl: this._proxyConfig?.baseUrl ?? SPATIAL_RESOLVER_ENV.motebitCloudBaseUrl,
      motebitCloudDefaultModel: this._proxyConfig?.model,
    };

    // Apply temperature + surface-level maxTokens to the unified config so
    // the resolver propagates them into the spec.
    const enriched: UnifiedProviderConfig = {
      ...unified,
      temperature: unified.temperature ?? temperature,
      maxTokens: unified.maxTokens ?? config.maxTokens,
    } as UnifiedProviderConfig;

    // BYOK requires an API key. Fail closed before constructing anything.
    if (enriched.mode === "byok" && (enriched.apiKey == null || enriched.apiKey === "")) {
      return false;
    }

    let spec: ProviderSpec;
    try {
      spec = resolveProviderSpec(enriched, env);
    } catch (err) {
      if (err instanceof UnsupportedBackendError) return false;
      throw err;
    }
    const provider = spatialSpecToProvider(spec);

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

    // Build signing keys from the already-loaded private key bytes (line ~425).
    // The same key signs identity assertions AND derives the sovereign Solana
    // wallet via Keypair.fromSeed (settlement-v1.md §6, curve coincidence).
    let signingKeys: { privateKey: Uint8Array; publicKey: Uint8Array } | undefined;
    if (this._privKeyBytes && this.publicKey) {
      try {
        const pubBytes = new Uint8Array(this.publicKey.length / 2);
        for (let i = 0; i < this.publicKey.length; i += 2) {
          pubBytes[i / 2] = parseInt(this.publicKey.slice(i, i + 2), 16);
        }
        signingKeys = { privateKey: this._privKeyBytes, publicKey: pubBytes };
      } catch {
        // Hex parse failed — runtime runs without signing keys
      }
    }

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
        signingKeys,
        solana: signingKeys ? { rpcUrl: "https://api.mainnet-beta.solana.com" } : undefined,
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

  // === MCP Management (delegates to SpatialMcpManager in ./mcp-manager.ts) ===

  addMcpServer(config: McpServerConfig): Promise<void> {
    return this.mcp.addMcpServer(config);
  }

  removeMcpServer(name: string): Promise<void> {
    return this.mcp.removeMcpServer(name);
  }

  getMcpServers(): Array<{
    name: string;
    url: string;
    connected: boolean;
    toolCount: number;
    trusted: boolean;
    motebit: boolean;
  }> {
    return this.mcp.getMcpServers();
  }

  setMcpServerTrust(name: string, trusted: boolean): Promise<void> {
    return this.mcp.setMcpServerTrust(name, trusted);
  }

  private reconnectMcpServers(): Promise<void> {
    return this.mcp.reconnectMcpServers();
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

  // === Sync + Relay (delegates to SpatialSyncController in ./sync-controller.ts) ===

  get syncStatus(): string {
    return this.sync.syncStatus;
  }

  onSyncStatusChange(cb: (status: string) => void): () => void {
    return this.sync.onSyncStatusChange(cb);
  }

  connectRelay(): Promise<void> {
    return this.sync.connectRelay();
  }

  disconnectRelay(): Promise<void> {
    return this.sync.disconnectRelay();
  }

  // === Voice Commands (delegates to ./voice-commands.ts) ===

  /**
   * Try to handle a voice transcript as a command. Routes natural-language voice
   * input to the shared command layer (executeCommand) via fuzzy pattern matching.
   *
   * Returns spoken response if handled, or null to fall through to AI conversation.
   */
  private tryVoiceCommand(text: string): Promise<string | null> {
    return tryVoiceCommand(text, {
      getRuntime: () => this.runtime,
      getRelayConfig: () => this.getRelayConfig(),
      voicePipeline: this.voicePipeline,
      resetConversation: () => this.resetConversation(),
      getMcpServers: () => this.getMcpServers(),
      listConversations: () => this.listConversations(),
      loadConversationById: (id) => {
        this.loadConversationById(id);
      },
      deleteConversation: (id) => {
        this.deleteConversation(id);
      },
      executeGoal: (goalId, prompt) => this.executeGoal(goalId, prompt),
    });
  }

  /** Build RelayConfig from current connection state, or null if not connected. */
  private getRelayConfig(): RelayConfig | null {
    const { relayUrl } = this.networkSettings;
    const authToken = this.sync.lastAuthToken;
    if (!relayUrl || !authToken) return null;
    return { relayUrl, authToken, motebitId: this.motebitId };
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
    this.mcp.dispose();

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
