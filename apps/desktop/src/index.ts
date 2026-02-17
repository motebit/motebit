/**
 * @motebit/desktop — Tauri app (Rust + webview)
 *
 * Thin platform shell around MotebitRuntime.
 * Provides Tauri-specific storage adapters and AI provider creation.
 */

import { MotebitRuntime } from "@motebit/runtime";
import type { TurnResult, StorageAdapters, StreamChunk, KeyringAdapter, OperatorModeResult, AuditLogSink } from "@motebit/runtime";
import { ThreeJSAdapter } from "@motebit/render-engine";
import {
  CloudProvider,
  OllamaProvider,
  resolveConfig,
  type MotebitPersonalityConfig,
} from "@motebit/ai-core";
import type { ToolAuditEntry } from "@motebit/sdk";
import { InMemoryEventStore } from "@motebit/event-log";
import { InMemoryMemoryStorage } from "@motebit/memory-graph";
import { InMemoryIdentityStorage, IdentityManager } from "@motebit/core-identity";
import { InMemoryAuditLog } from "@motebit/privacy-layer";
import { generateKeypair, createSignedToken } from "@motebit/crypto";
import { EventStore } from "@motebit/event-log";
import { TauriEventStore, TauriMemoryStorage, TauriIdentityStorage, type InvokeFn } from "./tauri-storage.js";
export type { InvokeFn } from "./tauri-storage.js";

// Re-export runtime types for main.ts consumption
export type { TurnResult, StreamChunk, OperatorModeResult };

// === Tauri Command Interface ===

export interface TauriCommands {
  db_query(sql: string, params: unknown[]): Promise<unknown[]>;
  db_execute(sql: string, params: unknown[]): Promise<number>;
  keyring_get(key: string): Promise<string | null>;
  keyring_set(key: string, value: string): Promise<void>;
  keyring_delete(key: string): Promise<void>;
  read_config(): Promise<string>;
  write_config(json: string): Promise<void>;
}

// === Desktop AI Config ===

export interface DesktopAIConfig {
  provider: "anthropic" | "ollama";
  model?: string;
  apiKey?: string;
  personalityConfig?: MotebitPersonalityConfig;
  isTauri: boolean;
  invoke?: InvokeFn;
  syncUrl?: string;
  syncMasterToken?: string;
}

// === Tauri Keyring Adapter ===

class TauriKeyringAdapter implements KeyringAdapter {
  constructor(private invoke: InvokeFn) {}

  async get(key: string): Promise<string | null> {
    return this.invoke<string | null>("keyring_get", { key });
  }

  async set(key: string, value: string): Promise<void> {
    await this.invoke<void>("keyring_set", { key, value });
  }

  async delete(key: string): Promise<void> {
    await this.invoke<void>("keyring_delete", { key });
  }
}

// === Tauri Tool Audit Sink ===

class TauriToolAuditSink implements AuditLogSink {
  constructor(private invoke: InvokeFn) {}

  append(entry: ToolAuditEntry): void {
    // Fire-and-forget — audit writes are best-effort
    void this.invoke("db_execute", {
      sql: `INSERT OR REPLACE INTO tool_audit_log (call_id, turn_id, tool, args, decision, result, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [
        entry.callId,
        entry.turnId,
        entry.tool,
        JSON.stringify(entry.args),
        JSON.stringify(entry.decision),
        entry.result ? JSON.stringify(entry.result) : null,
        entry.timestamp,
      ],
    });
  }

  query(_turnId: string): ToolAuditEntry[] {
    // Sync interface — return empty. The Tauri version is async-backed but
    // the AuditLogSink interface is sync. Writes persist; reads use db_query.
    return [];
  }

  getAll(): ToolAuditEntry[] {
    return [];
  }
}

// === Storage Factory ===

function createTauriStorage(invoke: InvokeFn): StorageAdapters {
  return {
    eventStore: new TauriEventStore(invoke),
    memoryStorage: new TauriMemoryStorage(invoke),
    identityStorage: new TauriIdentityStorage(invoke),
    auditLog: new InMemoryAuditLog(),
    toolAuditSink: new TauriToolAuditSink(invoke),
  };
}

function createDesktopStorage(config: DesktopAIConfig): StorageAdapters {
  if (config.isTauri && config.invoke) {
    return createTauriStorage(config.invoke);
  }
  return {
    eventStore: new InMemoryEventStore(),
    memoryStorage: new InMemoryMemoryStorage(),
    identityStorage: new InMemoryIdentityStorage(),
    auditLog: new InMemoryAuditLog(),
  };
}

// === Desktop App (platform shell) ===

export interface BootstrapResult {
  isFirstLaunch: boolean;
  motebitId: string;
  deviceId: string;
}

export class DesktopApp {
  private runtime: MotebitRuntime | null = null;
  private renderer: ThreeJSAdapter;
  motebitId: string = "desktop-local";
  deviceId: string = "desktop-local";

  constructor() {
    this.renderer = new ThreeJSAdapter();
  }

  /**
   * Bootstrap identity on first launch or load existing identity.
   * Must be called before initAI() when running in Tauri.
   */
  async bootstrap(invoke: InvokeFn): Promise<BootstrapResult> {
    const raw = await invoke<string>("read_config");
    const config = JSON.parse(raw) as Record<string, unknown>;

    if (config.motebit_id && typeof config.motebit_id === "string") {
      // Existing identity — load from config
      this.motebitId = config.motebit_id;
      this.deviceId = (config.device_id as string) || "desktop-local";
      return { isFirstLaunch: false, motebitId: this.motebitId, deviceId: this.deviceId };
    }

    // First launch — create identity and device keypair
    const storage = createTauriStorage(invoke);
    const eventStore = new EventStore(storage.eventStore);
    const identityManager = new IdentityManager(storage.identityStorage, eventStore);

    const deviceName = "Desktop";
    const identity = await identityManager.create(deviceName);
    const keypair = await generateKeypair();

    // Hex-encode keys
    const pubKeyHex = Array.from(keypair.publicKey).map(b => b.toString(16).padStart(2, "0")).join("");
    const privKeyHex = Array.from(keypair.privateKey).map(b => b.toString(16).padStart(2, "0")).join("");

    // Register device with the identity
    const deviceId = crypto.randomUUID();
    await identityManager.registerDevice(identity.motebit_id, deviceName, pubKeyHex);

    // Persist private key to keyring
    await invoke<void>("keyring_set", { key: "device_private_key", value: privKeyHex });

    // Write motebit_id, device_id, and public key to config
    const updatedConfig = { ...config, motebit_id: identity.motebit_id, device_id: deviceId, device_public_key: pubKeyHex };
    await invoke<void>("write_config", { json: JSON.stringify(updatedConfig) });

    this.motebitId = identity.motebit_id;
    this.deviceId = deviceId;

    return { isFirstLaunch: true, motebitId: this.motebitId, deviceId: this.deviceId };
  }

  /**
   * Get the device keypair from keyring + config. Returns null if not available.
   */
  async getDeviceKeypair(invoke: InvokeFn): Promise<{ publicKey: string; privateKey: string } | null> {
    const raw = await invoke<string>("read_config");
    const config = JSON.parse(raw) as Record<string, unknown>;
    const publicKey = config.device_public_key as string | undefined;
    if (!publicKey) return null;

    let privateKey: string | null = null;
    try {
      privateKey = await invoke<string | null>("keyring_get", { key: "device_private_key" });
    } catch {
      return null;
    }
    if (!privateKey) return null;

    return { publicKey, privateKey };
  }

  /**
   * Register this device with a sync relay. Creates the identity server-side
   * if needed, then registers the device with its public key.
   * Returns a signed auth token for sync requests.
   */
  async registerWithRelay(
    invoke: InvokeFn,
    syncUrl: string,
    masterToken: string,
  ): Promise<string | null> {
    const keypair = await this.getDeviceKeypair(invoke);
    if (!keypair) return null;

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${masterToken}`,
    };

    // Check if identity exists server-side
    const identityRes = await fetch(`${syncUrl}/identity/${this.motebitId}`, { headers });
    if (identityRes.status === 404) {
      // Create identity on server
      await fetch(`${syncUrl}/identity`, {
        method: "POST",
        headers,
        body: JSON.stringify({ owner_id: this.motebitId }),
      });
    }

    // Register device with public key
    await fetch(`${syncUrl}/device/register`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        motebit_id: this.motebitId,
        device_name: "Desktop",
        public_key: keypair.publicKey,
      }),
    });

    // Generate signed token for ongoing sync
    return this.createSyncToken(keypair.privateKey);
  }

  /**
   * Create a signed token for sync authentication. Tokens expire after 5 minutes.
   */
  async createSyncToken(privateKeyHex: string): Promise<string> {
    const privKeyBytes = new Uint8Array(privateKeyHex.length / 2);
    for (let i = 0; i < privateKeyHex.length; i += 2) {
      privKeyBytes[i / 2] = parseInt(privateKeyHex.slice(i, i + 2), 16);
    }

    return createSignedToken(
      {
        mid: this.motebitId,
        did: this.deviceId,
        iat: Date.now(),
        exp: Date.now() + 5 * 60 * 1000,
      },
      privKeyBytes,
    );
  }

  async init(canvas: unknown): Promise<void> {
    await this.renderer.init(canvas);
  }

  start(): void {
    this.runtime?.start();
  }

  stop(): void {
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
      this.renderer.render({
        cues: { hover_distance: 0.4, drift_amplitude: 0.02, glow_intensity: 0.3, eye_dilation: 0.3, smile_curvature: 0 },
        delta_time: deltaTime,
        time,
      });
    }
  }

  // === AI Integration ===

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

  initAI(config: DesktopAIConfig): boolean {
    const resolved = config.personalityConfig
      ? resolveConfig(config.personalityConfig)
      : undefined;
    const temperature = resolved?.temperature;

    let provider;
    if (config.provider === "ollama") {
      const model = config.model || "llama3.2";
      const base_url = config.isTauri ? "http://localhost:11434" : "/api/ollama";
      provider = new OllamaProvider({ model, base_url, max_tokens: 1024, temperature });
    } else {
      if (!config.apiKey) return false;
      const model = config.model || "claude-sonnet-4-20250514";
      const base_url = config.isTauri ? "https://api.anthropic.com" : "/api/anthropic";
      provider = new CloudProvider({
        provider: "anthropic",
        api_key: config.apiKey,
        model,
        base_url,
        max_tokens: 1024,
        temperature,
      });
    }

    const storage = createDesktopStorage(config);
    const keyring = config.isTauri && config.invoke ? new TauriKeyringAdapter(config.invoke) : undefined;

    this.runtime = new MotebitRuntime(
      { motebitId: this.motebitId, tickRateHz: 2 },
      { storage, renderer: this.renderer, ai: provider, keyring },
    );

    return true;
  }

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

  resetConversation(): void {
    this.runtime?.resetConversation();
  }

  async sendMessage(text: string): Promise<TurnResult> {
    if (!this.runtime) throw new Error("AI not initialized — call initAI() first");
    return this.runtime.sendMessage(text);
  }

  async *sendMessageStreaming(text: string): AsyncGenerator<StreamChunk> {
    if (!this.runtime) throw new Error("AI not initialized — call initAI() first");
    yield* this.runtime.sendMessageStreaming(text);
  }
}

// === Slash Command Utilities ===

export function isSlashCommand(input: string): boolean {
  return input.startsWith("/");
}

export function parseSlashCommand(input: string): { command: string; args: string } {
  const spaceIdx = input.indexOf(" ");
  if (spaceIdx === -1) return { command: input.slice(1), args: "" };
  return { command: input.slice(1, spaceIdx), args: input.slice(spaceIdx + 1).trim() };
}
