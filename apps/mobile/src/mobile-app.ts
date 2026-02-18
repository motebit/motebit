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
import { generateKeypair } from "@motebit/crypto";
import { IdentityManager } from "@motebit/core-identity";
import { EventStore } from "@motebit/event-log";
import type { MotebitState, BehaviorCues } from "@motebit/sdk";
import { createExpoStorage } from "./adapters/expo-sqlite";
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
  colorPreset: string;
  approvalPreset: string;
  persistenceThreshold: number;
  rejectSecrets: boolean;
  maxMemoriesPerTurn: number;
  budgetMaxCalls: number;
}

const DEFAULT_SETTINGS: MobileSettings = {
  provider: "ollama",
  model: "llama3.2",
  colorPreset: "borosilicate",
  approvalPreset: "balanced",
  persistenceThreshold: 0.5,
  rejectSecrets: true,
  maxMemoriesPerTurn: 5,
  budgetMaxCalls: 20,
};

const SETTINGS_KEY = "@motebit/settings";

// === AI Config ===

export interface MobileAIConfig {
  provider: "ollama" | "anthropic";
  model?: string;
  apiKey?: string;
}

// === Bootstrap Result ===

export interface MobileBootstrapResult {
  isFirstLaunch: boolean;
  motebitId: string;
  deviceId: string;
}

// === MobileApp ===

export class MobileApp {
  private runtime: MotebitRuntime | null = null;
  private renderer: ExpoGLAdapter;
  private keyring: SecureStoreAdapter;

  motebitId = "mobile-local";
  deviceId = "mobile-local";
  publicKey = "";

  constructor() {
    this.renderer = new ExpoGLAdapter();
    this.keyring = new SecureStoreAdapter();
  }

  // === Identity ===

  async bootstrap(): Promise<MobileBootstrapResult> {
    // Check for existing identity in secure store
    const existingId = await this.keyring.get("motebit_id");
    if (existingId) {
      this.motebitId = existingId;
      this.deviceId = (await this.keyring.get("device_id")) || "mobile-local";
      this.publicKey = (await this.keyring.get("device_public_key")) || "";
      return { isFirstLaunch: false, motebitId: this.motebitId, deviceId: this.deviceId };
    }

    // First launch — create identity and device keypair
    const storage = createExpoStorage("motebit.db");
    const eventStore = new EventStore(storage.eventStore);
    const identityManager = new IdentityManager(storage.identityStorage, eventStore);

    const deviceName = "Mobile";
    const identity = await identityManager.create(deviceName);
    const keypair = await generateKeypair();

    // Hex-encode keys
    const pubKeyHex = Array.from(keypair.publicKey as Uint8Array).map((b: number) => b.toString(16).padStart(2, "0")).join("");
    const privKeyHex = Array.from(keypair.privateKey as Uint8Array).map((b: number) => b.toString(16).padStart(2, "0")).join("");

    const deviceId = crypto.randomUUID();

    // Register device
    await identityManager.registerDevice(identity.motebit_id, deviceName, pubKeyHex);

    // Persist to secure store
    await this.keyring.set("motebit_id", identity.motebit_id);
    await this.keyring.set("device_id", deviceId);
    await this.keyring.set("device_public_key", pubKeyHex);
    await this.keyring.set("device_private_key", privKeyHex);

    this.motebitId = identity.motebit_id;
    this.deviceId = deviceId;
    this.publicKey = pubKeyHex;

    return { isFirstLaunch: true, motebitId: this.motebitId, deviceId: this.deviceId };
  }

  // === AI ===

  initAI(config: MobileAIConfig): boolean {
    let provider;
    if (config.provider === "ollama") {
      const model = config.model || "llama3.2";
      provider = new OllamaProvider({ model, base_url: "http://localhost:11434", max_tokens: 1024 });
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

    const storage = createExpoStorage("motebit.db");

    this.runtime = new MotebitRuntime(
      { motebitId: this.motebitId, tickRateHz: 2 },
      { storage, renderer: this.renderer, ai: provider, keyring: this.keyring },
    );

    return true;
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

  // === Appearance ===

  setInteriorColor(presetName: string): void {
    const preset = COLOR_PRESETS[presetName];
    if (!preset) return;
    this.renderer.setInteriorColor(preset);
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

  async exportAllData(): Promise<string> {
    const data: Record<string, unknown> = {
      motebit_id: this.motebitId,
      device_id: this.deviceId,
      public_key: this.publicKey,
      exported_at: new Date().toISOString(),
    };
    return JSON.stringify(data, null, 2);
  }
}
