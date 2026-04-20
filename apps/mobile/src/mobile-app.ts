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
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { MotebitRuntime, ProxySession, PLANNING_TASK_ROUTER } from "@motebit/runtime";
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
import { AnthropicProvider, OpenAIProvider, DEFAULT_OLLAMA_URL } from "@motebit/ai-core";
import {
  resolveProviderSpec,
  UnsupportedBackendError,
  DEFAULT_VOICE_CONFIG,
  DEFAULT_APPEARANCE_CONFIG,
  migrateVoiceConfig,
  migrateAppearanceConfig,
  type ProviderSpec,
  type ResolverEnv,
  type UnifiedProviderConfig,
  type VoiceConfig,
  type AppearanceConfig,
} from "@motebit/sdk";
import { createSignedToken, secureErase, bytesToHex } from "@motebit/encryption";
import {
  bootstrapIdentity as sharedBootstrapIdentity,
  rotateIdentityKeys,
  type BootstrapConfigStore,
  type BootstrapKeyStore,
} from "@motebit/core-identity";
import type { McpServerConfig } from "@motebit/mcp-client";
export type { McpServerConfig } from "@motebit/mcp-client";
export type { MemoryNode } from "@motebit/sdk";
import { PlanEngine } from "@motebit/planner";
import { DeviceCapability, DEFAULT_OLLAMA_MODEL, DEFAULT_MOTEBIT_CLOUD_URL } from "@motebit/sdk";
import type { AgentTask, ExecutionReceipt } from "@motebit/sdk";
import type { PairingSession, PairingStatus } from "@motebit/sync-engine";
import type { MotebitState, BehaviorCues, MemoryNode } from "@motebit/sdk";
import { computeDecayedConfidence, embedText } from "@motebit/memory-graph";
import {
  registerBrowserSafeBuiltins,
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
import { ASYNC_STORAGE_KEYS, KEYRING_KEYS } from "./storage-keys";
import { SecureStoreAdapter } from "./adapters/secure-store";
import {
  MobileGoalScheduler,
  type GoalCompleteEvent,
  type GoalApprovalEvent,
} from "./goal-scheduler";
export type { GoalCompleteEvent, GoalApprovalEvent } from "./goal-scheduler";
import { MobileSyncController, type SyncStatus } from "./sync-controller";
export type { SyncStatus } from "./sync-controller";
import { MobileMcpManager } from "./mcp-manager";
import { MobilePairingManager } from "./pairing-manager";
import { MobilePushTokenManager } from "./push-token-manager";

// Color presets — canonical source in @motebit/sdk. Re-exported so any
// existing `import { COLOR_PRESETS } from "./mobile-app"` consumer keeps
// working. Adding a new preset means editing packages/sdk/src/color-presets.ts.
import { COLOR_PRESETS } from "@motebit/sdk";
export { COLOR_PRESETS } from "@motebit/sdk";

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

/**
 * Mobile provider union — surface-specific flat shape that drives the settings
 * UI's radio buttons. At the package boundary (cross-surface wire format) we
 * convert to `UnifiedProviderConfig` via `mobileSettingsToUnifiedProvider()`.
 *
 * The three-mode mental model maps onto this flat union as:
 *   on-device     → "on-device" (apple-fm/mlx) or "local-server" (LAN inference)
 *   motebit-cloud → "proxy"
 *   byok          → "anthropic" | "openai" | "google"
 *
 * The historical value `"ollama"` was renamed to `"local-server"` for vendor
 * neutrality. `migrateLegacyMobileSettings` rewrites old persisted settings
 * on load so existing installs continue to work.
 */
export type MobileProvider =
  | "local-server"
  | "anthropic"
  | "openai"
  | "google"
  | "proxy"
  | "on-device";

/** On-device backend sub-selector. `"local-server"` is for users running their own LAN server. */
export type MobileLocalBackend = "apple-fm" | "mlx" | "local-server";

export interface MobileSettings {
  provider: MobileProvider;
  localBackend?: MobileLocalBackend;
  model: string;
  /**
   * URL of the local inference server (Ollama, LM Studio, llama.cpp, Jan,
   * vLLM, …). Persisted as `localServerEndpoint` in JSON settings. The
   * historical name `ollamaEndpoint` is accepted on load via
   * `migrateLegacyMobileSettings`.
   */
  localServerEndpoint: string;
  /**
   * Appearance settings — nested under the canonical `@motebit/sdk`
   * `AppearanceConfig` shape. Historical flat fields (`colorPreset`,
   * `customHue`, `customSaturation`, `theme`) are accepted on load via
   * `migrateLegacyMobileSettings` → `migrateAppearanceConfig`.
   */
  appearance: AppearanceConfig;
  approvalPreset: string;
  persistenceThreshold: number;
  rejectSecrets: boolean;
  maxMemoriesPerTurn: number;
  maxCallsPerTurn: number;
  /**
   * Voice settings — nested under the canonical `@motebit/sdk` `VoiceConfig`
   * shape. Historical flat fields (`voiceEnabled`, `voiceAutoSend`,
   * `voiceResponseEnabled`, `ttsVoice`, `neuralVadEnabled`) are accepted on
   * load via `migrateLegacyMobileSettings` → `migrateVoiceConfig`.
   */
  voice: VoiceConfig;
  maxTokens: number;
}

const DEFAULT_SETTINGS: MobileSettings = {
  provider: "local-server",
  model: DEFAULT_OLLAMA_MODEL,
  localServerEndpoint: DEFAULT_OLLAMA_URL,
  appearance: { ...DEFAULT_APPEARANCE_CONFIG, theme: "dark" },
  approvalPreset: "balanced",
  persistenceThreshold: 0.5,
  rejectSecrets: true,
  maxMemoriesPerTurn: 5,
  maxCallsPerTurn: 20,
  voice: { ...DEFAULT_VOICE_CONFIG },
  maxTokens: 4096,
};

// Legacy module-level constants kept for call-site compatibility. The
// canonical source of truth is `./storage-keys.ts`.
const SETTINGS_KEY = ASYNC_STORAGE_KEYS.settings;
const IDENTITY_FILE_KEY = ASYNC_STORAGE_KEYS.identityFile;

// === AI Config ===

export interface MobileAIConfig {
  provider: MobileProvider;
  localBackend?: MobileLocalBackend;
  model?: string;
  apiKey?: string;
  localServerEndpoint?: string;
  maxTokens?: number;
}

/**
 * Convert mobile-native settings to the surface-agnostic `UnifiedProviderConfig`.
 * Used when mobile needs to hand the config off to a package (sync, relay, tests).
 */
export function mobileSettingsToUnifiedProvider(
  settings: Pick<
    MobileSettings,
    "provider" | "localBackend" | "model" | "localServerEndpoint" | "maxTokens"
  >,
  apiKey?: string,
): import("@motebit/sdk").UnifiedProviderConfig {
  switch (settings.provider) {
    case "proxy":
      return {
        mode: "motebit-cloud",
        model: settings.model,
        maxTokens: settings.maxTokens,
      };
    case "anthropic":
      return {
        mode: "byok",
        vendor: "anthropic",
        apiKey: apiKey ?? "",
        model: settings.model,
        maxTokens: settings.maxTokens,
      };
    case "openai":
      return {
        mode: "byok",
        vendor: "openai",
        apiKey: apiKey ?? "",
        model: settings.model,
        maxTokens: settings.maxTokens,
      };
    case "google":
      return {
        mode: "byok",
        vendor: "google",
        apiKey: apiKey ?? "",
        model: settings.model,
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        maxTokens: settings.maxTokens,
      };
    case "local-server":
      return {
        mode: "on-device",
        backend: "local-server",
        model: settings.model,
        endpoint: settings.localServerEndpoint,
        maxTokens: settings.maxTokens,
      };
    case "on-device":
      return {
        mode: "on-device",
        backend: settings.localBackend ?? "apple-fm",
        model: settings.model,
        endpoint:
          settings.localBackend === "local-server" ? settings.localServerEndpoint : undefined,
        maxTokens: settings.maxTokens,
      };
  }
}

/**
 * Reverse migration: collapse an old persisted settings object onto the
 * current `MobileSettings` shape. Called from `loadSettings`. Historical
 * renames honored:
 *   - `"local"`  → `"on-device"`  (renamed when the three-mode UI shipped)
 *   - `"ollama"` → `"local-server"`  (renamed for vendor neutrality)
 *   - `ollamaEndpoint` → `localServerEndpoint`  (field rename, same reason)
 *   - `budgetMaxCalls`  → `maxCallsPerTurn`     (align with sdk GovernanceConfig)
 *   - flat `voiceEnabled`/`voiceAutoSend`/`voiceResponseEnabled`/`ttsVoice`/
 *     `neuralVadEnabled`  →  nested `voice: VoiceConfig` (align with sdk
 *     VoiceConfig; canonical shape uses `enabled`/`autoSend`/`speakResponses`).
 *   - flat `colorPreset`/`customHue`/`customSaturation`/`theme`  →  nested
 *     `appearance: AppearanceConfig` (align with sdk AppearanceConfig).
 */
function migrateLegacyMobileSettings(
  raw: (Partial<MobileSettings> & { provider?: string }) | Record<string, unknown>,
): void {
  const obj = raw as {
    provider?: string;
    ollamaEndpoint?: string;
    localServerEndpoint?: string;
    budgetMaxCalls?: number;
    maxCallsPerTurn?: number;
    voice?: VoiceConfig;
    voiceEnabled?: boolean;
    voiceAutoSend?: boolean;
    voiceResponseEnabled?: boolean;
    ttsVoice?: string;
    neuralVadEnabled?: boolean;
    appearance?: AppearanceConfig;
    colorPreset?: string;
    customHue?: number;
    customSaturation?: number;
    theme?: "light" | "dark" | "system";
  };
  if (obj.provider === "local") {
    obj.provider = "on-device";
  } else if (obj.provider === "ollama") {
    obj.provider = "local-server";
  }
  if (obj.ollamaEndpoint !== undefined && obj.localServerEndpoint === undefined) {
    obj.localServerEndpoint = obj.ollamaEndpoint;
  }
  delete obj.ollamaEndpoint;
  if (obj.budgetMaxCalls !== undefined && obj.maxCallsPerTurn === undefined) {
    obj.maxCallsPerTurn = obj.budgetMaxCalls;
  }
  delete obj.budgetMaxCalls;

  // Voice: if any legacy flat fields exist and no nested `voice` yet,
  // normalize through the canonical `migrateVoiceConfig` helper which
  // knows every legacy shape. Drop the flat fields afterwards.
  const hasLegacyVoice =
    obj.voiceEnabled !== undefined ||
    obj.voiceAutoSend !== undefined ||
    obj.voiceResponseEnabled !== undefined ||
    obj.ttsVoice !== undefined ||
    obj.neuralVadEnabled !== undefined;
  if (obj.voice === undefined && hasLegacyVoice) {
    obj.voice = migrateVoiceConfig({
      voiceEnabled: obj.voiceEnabled,
      voiceAutoSend: obj.voiceAutoSend,
      voiceResponseEnabled: obj.voiceResponseEnabled,
      ttsVoice: obj.ttsVoice,
      neuralVadEnabled: obj.neuralVadEnabled,
    });
  }
  delete obj.voiceEnabled;
  delete obj.voiceAutoSend;
  delete obj.voiceResponseEnabled;
  delete obj.ttsVoice;
  delete obj.neuralVadEnabled;

  // Appearance: same shape as voice — if any legacy flat field exists and
  // no nested `appearance` yet, normalize through the canonical helper.
  const hasLegacyAppearance =
    obj.colorPreset !== undefined ||
    obj.customHue !== undefined ||
    obj.customSaturation !== undefined ||
    obj.theme !== undefined;
  if (obj.appearance === undefined && hasLegacyAppearance) {
    obj.appearance = migrateAppearanceConfig({
      colorPreset: obj.colorPreset,
      customHue: obj.customHue,
      customSaturation: obj.customSaturation,
      theme: obj.theme,
    });
  }
  delete obj.colorPreset;
  delete obj.customHue;
  delete obj.customSaturation;
  delete obj.theme;
}

/**
 * Map a mobile flat `MobileAIConfig` to the unified shape the SDK resolver
 * speaks.
 *
 * The mobile UI's "local-server" provider value is the canonical name for
 * the on-device LAN inference backend. The legacy "ollama" name is migrated
 * on settings load by `migrateLegacyMobileSettings`.
 */
function mobileConfigToUnified(config: MobileAIConfig): UnifiedProviderConfig {
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
    case "on-device":
      return {
        mode: "on-device",
        backend: config.localBackend ?? "apple-fm",
        model: config.model,
        endpoint: config.localBackend === "local-server" ? config.localServerEndpoint : undefined,
        maxTokens: config.maxTokens,
      };
  }
}

/**
 * Map a resolved `ProviderSpec` to a mobile-side concrete provider instance.
 * This is async because the native on-device backends (Apple FM, MLX) require
 * an async init step to bind to the underlying iOS/Apple Silicon runtimes.
 */
async function mobileSpecToProvider(
  spec: ProviderSpec,
  maxTokensFromConfig?: number,
): Promise<
  AnthropicProvider | OpenAIProvider | import("./adapters/local-inference").LocalInferenceProvider
> {
  switch (spec.kind) {
    case "cloud":
      // Cloud kind dispatches on wireProtocol: anthropic → AnthropicProvider,
      // openai → OpenAIProvider (used for BYOK OpenAI/Google and any local
      // server via the OpenAI-compat shim).
      if (spec.wireProtocol === "openai") {
        return new OpenAIProvider({
          api_key: spec.apiKey,
          model: spec.model,
          base_url: spec.baseUrl,
          max_tokens: spec.maxTokens,
          temperature: spec.temperature,
          extra_headers: spec.extraHeaders,
        });
      }
      return new AnthropicProvider({
        api_key: spec.apiKey,
        model: spec.model,
        base_url: spec.baseUrl,
        max_tokens: spec.maxTokens,
        temperature: spec.temperature,
        extra_headers: spec.extraHeaders,
      });
    case "apple-fm":
    case "mlx": {
      const { LocalInferenceProvider } = await import("./adapters/local-inference");
      const localProvider = new LocalInferenceProvider({
        backend: spec.kind,
        maxTokens: spec.maxTokens ?? maxTokensFromConfig,
      });
      await localProvider.init();
      return localProvider;
    }
    case "webllm":
      // Mobile's env doesn't list webllm in supportedBackends, so the
      // resolver should never return this. Defensive throw.
      throw new UnsupportedBackendError(spec.kind);
  }
}

// === Bootstrap Result ===

export interface MobileBootstrapResult {
  isFirstLaunch: boolean;
  motebitId: string;
  deviceId: string;
}

// Goal event types (GoalCompleteEvent, GoalApprovalEvent) live in ./goal-scheduler
// and are re-exported from the top of this file. formatTimeAgo is also in the scheduler.

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

  // Local event store — populated in initAI so the sync controller can
  // append decrypted events received from the relay WS. Held here because
  // initAI owns the storage-creation lifecycle.
  private _localEventStore: EventStoreAdapter | null = null;

  // Sync controller — class extracted to ./sync-controller.ts. All sync
  // state lives inside. MobileApp only needs to keep a reference so its
  // delegate methods can forward calls.
  private sync = new MobileSyncController({
    getRuntime: () => this.runtime,
    getMotebitId: () => this.motebitId,
    getDeviceId: () => this.deviceId,
    getPublicKey: () => this.publicKey,
    getStorage: () => this.storage,
    getLocalEventStore: () => this._localEventStore,
    getKeyring: () => this.keyring,
    getPrivKeyBytes: () => this.getPrivKeyBytes(),
    createSyncToken: (aud) => this.createSyncToken(aud),
    registerPushToken: (url) => this.registerPushToken(url),
    startPushLifecycle: () => this.startPushLifecycle(),
    stopPushLifecycle: () => this.stopPushLifecycle(),
  });

  // MCP — class extracted to ./mcp-manager.ts.
  private mcp = new MobileMcpManager({
    getRuntime: () => this.runtime,
  });

  // Pairing — class extracted to ./pairing-manager.ts.
  private pairing = new MobilePairingManager({
    getKeyring: () => this.keyring,
    getPublicKey: () => this.publicKey,
    getPrivKeyHex: async () => {
      const hex = await this.keyring.get("device_private_key");
      if (!hex) throw new Error("No device private key in keyring");
      return hex;
    },
    createSyncToken: (aud) => this.createSyncToken(aud),
    setIdentity: (motebitId, deviceId) => {
      this.motebitId = motebitId;
      this.deviceId = deviceId;
    },
    setPublicKey: (pubKeyHex) => {
      this.publicKey = pubKeyHex;
    },
    setSyncUrl: (url) => this.setSyncUrl(url),
  });

  // Push token lifecycle — class extracted to ./push-token-manager.ts.
  private pushTokens = new MobilePushTokenManager({
    getDeviceId: () => this.deviceId,
    createSyncToken: (aud) => this.createSyncToken(aud),
    getSyncUrl: () => this.getSyncUrl(),
  });

  // Plan engine
  private planEngine: PlanEngine | null = null;

  // Goal scheduler — class extracted to ./goal-scheduler.ts. State lives inside.
  private goals = new MobileGoalScheduler({
    getRuntime: () => this.runtime,
    getMotebitId: () => this.motebitId,
    getPlanEngine: () => this.planEngine,
    getStorage: () => this.storage,
  });

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
        const mid = await keyring.get(KEYRING_KEYS.motebitId);
        if (mid == null || mid === "") return null;
        return {
          motebit_id: mid,
          device_id: (await keyring.get("device_id")) ?? "",
          device_public_key: (await keyring.get("device_public_key")) ?? "",
        };
      },
      async write(state) {
        await keyring.set(KEYRING_KEYS.motebitId, state.motebit_id);
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

  private static readonly PROXY_TOKEN_KEY = ASYNC_STORAGE_KEYS.proxyToken;

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
        AsyncStorage.getItem("@motebit/sync_url"),
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
    // BYOK validation: surfaces decide whether they have credentials before
    // calling the resolver. The resolver assumes its inputs are well-formed.
    const needsByokKey =
      config.provider === "anthropic" ||
      config.provider === "openai" ||
      config.provider === "google";
    if (needsByokKey && (config.apiKey == null || config.apiKey === "")) {
      return false;
    }

    // Resolve the motebit cloud relay base URL from session state, with
    // AsyncStorage as a persisted user override. Mobile's proxy config and
    // relay URL live on different paths, so we resolve here rather than
    // inside the env.
    //
    // Resolution order:
    //   1. session-state proxyConfig.baseUrl
    //   2. AsyncStorage canonical key `@motebit/relay_url`
    //   3. AsyncStorage legacy key `@motebit/proxy_url` (one-shot migration:
    //      copy → canonical key, then continue using it)
    //   4. EXPO_PUBLIC_MOTEBIT_RELAY_URL build-time env (Expo public env)
    //   5. DEFAULT_MOTEBIT_CLOUD_URL
    const pc = this._proxyConfig;
    let asyncStoredRelayUrl = await AsyncStorage.getItem(ASYNC_STORAGE_KEYS.relayUrl);
    if (asyncStoredRelayUrl == null || asyncStoredRelayUrl === "") {
      const legacy = await AsyncStorage.getItem(ASYNC_STORAGE_KEYS.legacyRelayUrl);
      if (legacy != null && legacy !== "") {
        // One-shot deprecation diagnostic — fires at most once per install,
        // when an older AsyncStorage key is read for the first time.
        // eslint-disable-next-line no-console -- one-shot migration warning
        console.warn("[motebit] migrating @motebit/proxy_url → @motebit/relay_url");
        await AsyncStorage.setItem(ASYNC_STORAGE_KEYS.relayUrl, legacy);
        asyncStoredRelayUrl = legacy;
      }
    }
    // `process.env` on React Native is typed loosely; coerce to a precise
    // string-or-undefined for the strict-boolean-expression rule.
    const expoEnvRelayUrl: string | undefined = (process.env as Record<string, string | undefined>)
      .EXPO_PUBLIC_MOTEBIT_RELAY_URL;
    const motebitCloudBaseUrl: string =
      pc?.baseUrl ??
      asyncStoredRelayUrl ??
      (expoEnvRelayUrl != null && expoEnvRelayUrl !== "" ? expoEnvRelayUrl : null) ??
      DEFAULT_MOTEBIT_CLOUD_URL;
    const motebitCloudHeaders =
      pc?.proxyToken !== undefined ? { "x-proxy-token": pc.proxyToken } : undefined;
    const motebitCloudDefaultModel = pc?.model;

    // Mobile supports the full set of on-device backends — Apple Foundation
    // Models on iOS 26+, MLX on Apple Silicon, and a LAN local-server.
    // Native on-device backends require an async init step (model load,
    // module bind), so the spec→provider mapper below is async.
    const env: ResolverEnv = {
      cloudBaseUrl: (_wireProtocol, canonical) => canonical,
      defaultLocalServerUrl: DEFAULT_OLLAMA_URL,
      supportedBackends: new Set(["apple-fm", "mlx", "local-server"]),
      motebitCloudBaseUrl,
      motebitCloudHeaders,
      motebitCloudDefaultModel,
    };

    const unified = mobileConfigToUnified(config);
    const spec = resolveProviderSpec(unified, env);
    const provider = await mobileSpecToProvider(spec, config.maxTokens);

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

    // Load identity signing keys for credential issuance + sovereign
    // Solana wallet rail. Same pattern as web-app.ts — load private key
    // hex from secure storage, convert to bytes, pass to RuntimeConfig.
    let signingKeys: { privateKey: Uint8Array; publicKey: Uint8Array } | undefined;
    try {
      const privKeyHex = await this.keyring.get("device_private_key");
      if (privKeyHex != null && privKeyHex !== "" && this.publicKey !== "") {
        const privBytes = new Uint8Array(privKeyHex.length / 2);
        for (let i = 0; i < privKeyHex.length; i += 2) {
          privBytes[i / 2] = parseInt(privKeyHex.slice(i, i + 2), 16);
        }
        const pubBytes = new Uint8Array(this.publicKey.length / 2);
        for (let i = 0; i < this.publicKey.length; i += 2) {
          pubBytes[i / 2] = parseInt(this.publicKey.slice(i, i + 2), 16);
        }
        signingKeys = { privateKey: privBytes, publicKey: pubBytes };
      }
    } catch {
      // Secure store read failed — runtime runs without signing keys
    }

    this.runtime = new MotebitRuntime(
      {
        motebitId: this.motebitId,
        tickRateHz: 2,
        policy: policyConfig,
        taskRouter: PLANNING_TASK_ROUTER,
        signingKeys,
        solana: signingKeys ? { rpcUrl: "https://api.mainnet-beta.solana.com" } : undefined,
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

    registerBrowserSafeBuiltins(registry, {
      searchProvider: new DuckDuckGoSearchProvider(),
      memorySearchFn: async (query, limit) => {
        const queryEmbedding = await embedText(query);
        const nodes = await runtime.memory.recallRelevant(queryEmbedding, { limit });
        return nodes.map((n) => ({ content: n.content, confidence: n.confidence }));
      },
      eventQueryFn: async (limit, eventType) => {
        const filter: EventFilter = { motebit_id: runtime.motebitId, limit };
        if (eventType != null && eventType !== "") {
          filter.event_types = [eventType as EventType];
        }
        const events = await runtime.events.query(filter);
        return events.map((e) => ({
          event_type: e.event_type,
          timestamp: e.timestamp,
          payload: e.payload,
        }));
      },
      reflectFn: () => runtime.reflect(),
      rewriteMemoryDeps: {
        resolveNodeId: (shortIdOrUuid) => runtime.memory.resolveNodeIdPrefix(shortIdOrUuid),
        supersedeMemory: (nodeId, newContent, reason) =>
          runtime.memory.supersedeMemoryByNodeId(nodeId, newContent, reason),
      },
    });

    // Goal management tools (available during goal execution).
    // Read currentGoalId through the scheduler so the tool handlers stay
    // in sync with the active goal even though the state lives there now.
    const goalStore = this.storage?.goalStore;
    registry.register(createSubGoalDefinition, (args: Record<string, unknown>) => {
      const currentGoalId = this.goals.currentGoalId;
      if (currentGoalId == null || currentGoalId === "" || goalStore == null) {
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
      const currentGoalId = this.goals.currentGoalId;
      if (currentGoalId == null || currentGoalId === "" || goalStore == null) {
        return Promise.resolve({ ok: false, error: "No active goal context" });
      }
      const reason = args.reason as string;
      goalStore.setStatus(currentGoalId, "completed");
      return Promise.resolve({
        ok: true,
        data: { goal_id: currentGoalId, status: "completed", reason },
      });
    });

    registry.register(reportProgressDefinition, (args: Record<string, unknown>) => {
      const currentGoalId = this.goals.currentGoalId;
      if (currentGoalId == null || currentGoalId === "") {
        return Promise.resolve({ ok: false, error: "No active goal context" });
      }
      const note = args.note as string;
      return Promise.resolve({ ok: true, data: { goal_id: currentGoalId, note } });
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

  // === MCP (delegates to MobileMcpManager in ./mcp-manager.ts) ===

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
    motebitPublicKey?: string;
  }> {
    return this.mcp.getMcpServers();
  }

  setMcpServerTrust(name: string, trusted: boolean): Promise<void> {
    return this.mcp.setMcpServerTrust(name, trusted);
  }

  onToolsChanged(callback: () => void): void {
    this.mcp.onToolsChanged(callback);
  }

  private reconnectMcpServers(): Promise<void> {
    return this.mcp.reconnectMcpServers();
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
      const parsed = JSON.parse(raw) as Partial<MobileSettings> & { provider?: string };
      // Migrate provider union renames and legacy flat fields (e.g.,
      // "local" → "on-device", voiceEnabled → voice.enabled) before merging.
      migrateLegacyMobileSettings(parsed);
      const loaded: MobileSettings = {
        ...DEFAULT_SETTINGS,
        ...(parsed as Partial<MobileSettings>),
        // Deep-merge the nested `voice` and `appearance` objects so partial
        // saves don't clobber defaults for fields the UI didn't touch.
        voice: { ...DEFAULT_SETTINGS.voice, ...(parsed.voice ?? {}) },
        appearance: { ...DEFAULT_SETTINGS.appearance, ...(parsed.appearance ?? {}) },
      };
      // Migration: borosilicate was removed — remap to moonlight
      if (loaded.appearance.colorPreset === "borosilicate") {
        loaded.appearance = { ...loaded.appearance, colorPreset: "moonlight" };
      }
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
    const oldPrivKeyBytes = await this.getPrivKeyBytes();

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
        const { generateKeypair } = await import("@motebit/encryption");
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

  // === Identity helpers (used by pairing, sync, rotate) ===

  /** Load device private key bytes from secure store. Caller must secureErase() when done. */
  async getPrivKeyBytes(): Promise<Uint8Array> {
    const privKeyHex = await this.keyring.get("device_private_key");
    if (privKeyHex == null || privKeyHex === "") throw new Error("No device private key available");
    const bytes = new Uint8Array(privKeyHex.length / 2);
    for (let i = 0; i < privKeyHex.length; i += 2) {
      bytes[i / 2] = parseInt(privKeyHex.slice(i, i + 2), 16);
    }
    return bytes;
  }

  async createSyncToken(aud: string = "sync"): Promise<string> {
    const privKeyBytes = await this.getPrivKeyBytes();

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

  // === Pairing (delegates to MobilePairingManager in ./pairing-manager.ts) ===

  initiatePairing(syncUrl: string): Promise<{ pairingCode: string; pairingId: string }> {
    return this.pairing.initiatePairing(syncUrl);
  }

  getPairingSession(syncUrl: string, pairingId: string): Promise<PairingSession> {
    return this.pairing.getPairingSession(syncUrl, pairingId);
  }

  approvePairing(syncUrl: string, pairingId: string): Promise<{ deviceId: string }> {
    return this.pairing.approvePairing(syncUrl, pairingId);
  }

  denyPairing(syncUrl: string, pairingId: string): Promise<void> {
    return this.pairing.denyPairing(syncUrl, pairingId);
  }

  claimPairing(
    syncUrl: string,
    code: string,
  ): Promise<{ pairingId: string; motebitId: string; ephemeralPrivateKey: Uint8Array }> {
    return this.pairing.claimPairing(syncUrl, code);
  }

  pollPairingStatus(syncUrl: string, pairingId: string): Promise<PairingStatus> {
    return this.pairing.pollPairingStatus(syncUrl, pairingId);
  }

  completePairing(
    result: { motebitId: string; deviceId: string },
    syncUrl?: string,
    keyTransferOpts?: Parameters<typeof this.pairing.completePairing>[2],
  ): Promise<string | undefined> {
    return this.pairing.completePairing(result, syncUrl, keyTransferOpts);
  }

  // === Push Token Lifecycle (delegates to MobilePushTokenManager) ===

  registerPushToken(syncUrl: string): Promise<void> {
    return this.pushTokens.registerPushToken(syncUrl);
  }

  removePushToken(syncUrl: string): Promise<void> {
    return this.pushTokens.removePushToken(syncUrl);
  }

  startPushLifecycle(): void {
    this.pushTokens.startPushLifecycle();
  }

  stopPushLifecycle(): void {
    this.pushTokens.stopPushLifecycle();
  }

  // === Credentials ===

  /** Return locally-issued credentials (peer-issued reputation, trust, gradient). */
  getLocalCredentials(): Array<{
    credential_id: string;
    credential_type: string;
    credential: Record<string, unknown>;
    issued_at: number;
  }> {
    if (!this.runtime) return [];
    return this.runtime
      .getIssuedCredentials()
      .map((vc: { type: string[]; validFrom?: string }) => ({
        credential_id: crypto.randomUUID(),
        credential_type:
          vc.type.find((t: string) => t !== "VerifiableCredential") ?? "VerifiableCredential",
        credential: vc as unknown as Record<string, unknown>,
        issued_at: vc.validFrom != null ? new Date(vc.validFrom).getTime() : Date.now(),
      }));
  }

  // === Sync (delegates to MobileSyncController in ./sync-controller.ts) ===

  getSyncUrl(): Promise<string | null> {
    return this.sync.getSyncUrl();
  }

  setSyncUrl(url: string): Promise<void> {
    return this.sync.setSyncUrl(url);
  }

  clearSyncUrl(): Promise<void> {
    return this.sync.clearSyncUrl();
  }

  get syncStatus(): SyncStatus {
    return this.sync.syncStatus;
  }

  get lastSyncTime(): number {
    return this.sync.lastSyncTime;
  }

  get isSyncConnected(): boolean {
    return this.sync.isSyncConnected;
  }

  onSyncStatus(callback: (status: SyncStatus, lastSync: number) => void): void {
    this.sync.onSyncStatus(callback);
  }

  startSync(syncUrl?: string): Promise<void> {
    return this.sync.startSync(syncUrl);
  }

  stopSync(): void {
    this.sync.stopSync();
  }

  disconnectSync(): Promise<void> {
    return this.sync.disconnectSync();
  }

  syncNow(): Promise<{
    events_pushed: number;
    events_pulled: number;
    conversations_pushed: number;
    conversations_pulled: number;
  }> {
    return this.sync.syncNow();
  }

  startServing(): Promise<{ ok: boolean; error?: string }> {
    return this.sync.startServing();
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
      freshness?: "awake" | "recently_seen" | "dormant" | "cold";
    }>
  > {
    return this.sync.discoverAgents();
  }

  // === Goal Scheduler (delegates to MobileGoalScheduler in ./goal-scheduler.ts) ===

  /** Get the goal store for direct UI access (listing, adding, removing goals). */
  getGoalStore(): ExpoGoalStore | null {
    return this.storage?.goalStore ?? null;
  }

  get isGoalExecuting(): boolean {
    return this.goals.isGoalExecuting;
  }

  onGoalStatus(callback: (executing: boolean) => void): void {
    this.goals.onGoalStatus(callback);
  }

  onGoalComplete(callback: (event: GoalCompleteEvent) => void): void {
    this.goals.onGoalComplete(callback);
  }

  onGoalApproval(callback: (event: GoalApprovalEvent) => void): void {
    this.goals.onGoalApproval(callback);
  }

  startGoalScheduler(): void {
    this.goals.start();
  }

  stopGoalScheduler(): void {
    this.goals.stop();
  }

  async *resumeGoalAfterApproval(approved: boolean): AsyncGenerator<StreamChunk> {
    yield* this.goals.resumeGoalAfterApproval(approved);
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

// ---------------------------------------------------------------------------
// Background push notification handler — module-level registration required
// by expo-task-manager. Runs when a silent push arrives while app is
// backgrounded. iOS gives ~30s; Android foreground service extends the window.
//
// The handler spins up an ephemeral WebSocket, claims the pending task,
// executes it through the runtime, signs a receipt, and POSTs it back —
// all within the OS execution window. This is the autonomous mobile
// execution loop: the 30-second daemon.
// ---------------------------------------------------------------------------

const BACKGROUND_TASK_WAKE = "MOTEBIT_TASK_WAKE";

/** Module-level reference to the active MobileApp. Set by App.tsx on init. */
let _backgroundApp: MobileApp | null = null;

/** Register the app instance for background task execution. */
export function setBackgroundApp(app: MobileApp | null): void {
  _backgroundApp = app;
}

/** iOS execution budget: 25s (5s margin from the ~30s OS limit). */
const BACKGROUND_EXECUTION_BUDGET_MS = 25_000;

TaskManager.defineTask(BACKGROUND_TASK_WAKE, async () => {
  const app = _backgroundApp;
  const runtime = app?.getRuntime();
  if (!app || !runtime || !app.motebitId) return;

  const syncUrl = await app.getSyncUrl();
  if (!syncUrl) return;

  const token = await app.createSyncToken("sync");
  if (!token) return;

  // Build ephemeral WebSocket URL
  const wsUrl =
    syncUrl.replace(/^https?/, (m: string) => (m === "https" ? "wss" : "ws")) +
    "/ws/sync/" +
    app.motebitId;

  // Race: task execution vs timeout guard
  const deadline = Date.now() + BACKGROUND_EXECUTION_BUDGET_MS;

  await new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };

    // Timeout guard — if execution exceeds budget, bail cleanly
    const timer = setTimeout(done, BACKGROUND_EXECUTION_BUDGET_MS);

    // Ephemeral WebSocket connection
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      // Authenticate with post-connect auth frame
      ws.send(JSON.stringify({ type: "auth", token }));
    };

    ws.onmessage = (event) => {
      if (settled) return;
      let msg: { type?: string; task?: AgentTask; ok?: boolean };
      try {
        msg = JSON.parse(typeof event.data === "string" ? event.data : "") as typeof msg;
      } catch {
        return;
      }

      // Wait for auth confirmation, then we'll get task_request from recovery
      if (msg.type === "auth_result" && !msg.ok) {
        ws.close();
        clearTimeout(timer);
        done();
        return;
      }

      if (msg.type !== "task_request" || msg.task == null) return;

      const task = msg.task;

      // Claim the task
      ws.send(JSON.stringify({ type: "task_claim", task_id: task.task_id }));

      // Execute with time budget
      void (async () => {
        try {
          let privKeyBytes: Uint8Array;
          try {
            privKeyBytes = await app.getPrivKeyBytes();
          } catch {
            done();
            return;
          }

          const remainingMs = deadline - Date.now();
          if (remainingMs < 5000) {
            // Not enough time to execute — let it expire for next foreground
            secureErase(privKeyBytes);
            done();
            return;
          }

          let receipt: ExecutionReceipt | undefined;

          // Race execution against remaining budget
          const executionPromise = (async () => {
            for await (const chunk of runtime.handleAgentTask(
              task,
              privKeyBytes,
              app.deviceId,
              undefined,
              { delegatedScope: task.delegated_scope },
            )) {
              if (chunk.type === "task_result") {
                receipt = chunk.receipt;
              }
            }
          })();

          const timeoutPromise = new Promise<"timeout">(
            (r) => setTimeout(() => r("timeout"), remainingMs - 3000), // 3s margin for receipt POST
          );

          const result = await Promise.race([executionPromise, timeoutPromise]);

          secureErase(privKeyBytes);

          // POST receipt if we got one (even on timeout — partial work is valuable)
          if (receipt) {
            const freshToken = await app.createSyncToken("task:submit");
            await fetch(`${syncUrl}/agent/${app.motebitId}/task/${task.task_id}/result`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${freshToken}`,
              },
              body: JSON.stringify(receipt),
              signal: AbortSignal.timeout(3000),
            });
          }

          if (result === "timeout") {
            // Execution timed out — receipt may or may not have been posted
            // Task stays in relay queue for retry on next wake
          }
        } catch {
          // Background execution failed — task stays in queue
        } finally {
          ws.close();
          clearTimeout(timer);
          done();
        }
      })();
    };

    ws.onerror = () => {
      clearTimeout(timer);
      done();
    };

    ws.onclose = () => {
      clearTimeout(timer);
      done();
    };
  });
});

// Silent notification handler — don't show alerts for task wake pushes
Notifications.setNotificationHandler({
  // eslint-disable-next-line @typescript-eslint/require-await -- Expo API requires async
  handleNotification: async () => ({
    shouldShowAlert: false,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});
