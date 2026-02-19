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
  StorageAdapters,
} from "@motebit/runtime";
import { CloudProvider, OllamaProvider } from "@motebit/ai-core";
import { createSignedToken } from "@motebit/crypto";
import {
  bootstrapIdentity as sharedBootstrapIdentity,
  type BootstrapConfigStore,
  type BootstrapKeyStore,
} from "@motebit/core-identity";
import { PairingClient } from "@motebit/sync-engine";
import type { PairingSession, PairingStatus } from "@motebit/sync-engine";
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
  private storage: StorageAdapters | null = null;
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

    return {
      isFirstLaunch: result.isFirstLaunch,
      motebitId: result.motebitId,
      deviceId: result.deviceId,
    };
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

    const storage = this.storage ?? createExpoStorage("motebit.db");

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

  async completePairing(result: { motebitId: string; deviceId: string; deviceToken: string }): Promise<void> {
    await this.keyring.set("motebit_id", result.motebitId);
    await this.keyring.set("device_id", result.deviceId);
    await this.keyring.set("device_token", result.deviceToken);

    this.motebitId = result.motebitId;
    this.deviceId = result.deviceId;
  }
}
