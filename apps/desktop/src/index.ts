/**
 * @motebit/desktop — Tauri app (Rust + webview)
 *
 * Thin platform shell around MotebitRuntime.
 * Provides Tauri-specific storage adapters and AI provider creation.
 */

import { MotebitRuntime, SimpleToolRegistry } from "@motebit/runtime";
import type { TurnResult, StorageAdapters, StreamChunk, KeyringAdapter, OperatorModeResult, AuditLogSink, InteriorColor, McpServerConfig, PolicyConfig, MemoryGovernanceConfig } from "@motebit/runtime";
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
import {
  InMemoryIdentityStorage,
  bootstrapIdentity as sharedBootstrapIdentity,
  type BootstrapConfigStore,
  type BootstrapKeyStore,
} from "@motebit/core-identity";
import { InMemoryAuditLog } from "@motebit/privacy-layer";
import { createSignedToken } from "@motebit/crypto";
import { generate as generateIdentityFile, parse as parseIdentityFile, governanceToPolicyConfig } from "@motebit/identity-file";
import { PairingClient } from "@motebit/sync-engine";
import type { PairingSession, PairingStatus } from "@motebit/sync-engine";
import { TauriEventStore, TauriMemoryStorage, TauriIdentityStorage, TauriAuditLog, TauriStateSnapshotStorage, type InvokeFn } from "./tauri-storage.js";
import { registerDesktopTools } from "./desktop-tools.js";
export type { InvokeFn } from "./tauri-storage.js";

// Re-export runtime types for main.ts consumption
export type { TurnResult, StreamChunk, OperatorModeResult, InteriorColor, McpServerConfig, PolicyConfig, MemoryGovernanceConfig };
export type { PairingSession, PairingStatus };

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

function createTauriStorage(invoke: InvokeFn, stateSnapshot?: TauriStateSnapshotStorage): StorageAdapters {
  return {
    eventStore: new TauriEventStore(invoke),
    memoryStorage: new TauriMemoryStorage(invoke),
    identityStorage: new TauriIdentityStorage(invoke),
    auditLog: new TauriAuditLog(invoke),
    toolAuditSink: new TauriToolAuditSink(invoke),
    stateSnapshot,
  };
}

function createDesktopStorage(config: DesktopAIConfig, stateSnapshot?: TauriStateSnapshotStorage): StorageAdapters {
  if (config.isTauri && config.invoke) {
    return createTauriStorage(config.invoke, stateSnapshot);
  }
  return {
    eventStore: new InMemoryEventStore(),
    memoryStorage: new InMemoryMemoryStorage(),
    identityStorage: new InMemoryIdentityStorage(),
    auditLog: new InMemoryAuditLog(),
  };
}

// === Color Presets ===

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

// === MCP Server Status ===

export interface McpServerStatus {
  name: string;
  transport: string;
  trusted: boolean;
  connected: boolean;
  toolCount: number;
}

// === Desktop App (platform shell) ===

export interface BootstrapResult {
  isFirstLaunch: boolean;
  motebitId: string;
  deviceId: string;
}

export type GovernanceStatus =
  | { governed: true }
  | { governed: false; reason: string };

export class DesktopApp {
  private runtime: MotebitRuntime | null = null;
  private renderer: ThreeJSAdapter;
  private mcpAdapters = new Map<string, { disconnect(): Promise<void> }>();
  private mcpConfigs = new Map<string, McpServerConfig>();
  motebitId: string = "desktop-local";
  deviceId: string = "desktop-local";
  publicKey: string = "";
  private _governanceStatus: GovernanceStatus = { governed: false, reason: "not initialized" };

  constructor() {
    this.renderer = new ThreeJSAdapter();
  }

  /**
   * Bootstrap identity on first launch or load existing identity.
   * Must be called before initAI() when running in Tauri.
   */
  async bootstrap(invoke: InvokeFn): Promise<BootstrapResult> {
    const configStore: BootstrapConfigStore = {
      async read() {
        const raw = await invoke<string>("read_config");
        const config = JSON.parse(raw) as Record<string, unknown>;
        if (!config.motebit_id || typeof config.motebit_id !== "string") return null;
        return {
          motebit_id: config.motebit_id,
          device_id: (config.device_id as string) ?? "",
          device_public_key: (config.device_public_key as string) ?? "",
        };
      },
      async write(state) {
        const raw = await invoke<string>("read_config");
        const config = { ...JSON.parse(raw) as Record<string, unknown>, ...state };
        await invoke<void>("write_config", { json: JSON.stringify(config) });
      },
    };

    const keyStore: BootstrapKeyStore = {
      async storePrivateKey(privKeyHex) {
        await invoke<void>("keyring_set", { key: "device_private_key", value: privKeyHex });
      },
    };

    const storage = createTauriStorage(invoke);
    const result = await sharedBootstrapIdentity({
      surfaceName: "Desktop",
      identityStorage: storage.identityStorage,
      eventStoreAdapter: storage.eventStore,
      configStore,
      keyStore,
    });

    this.motebitId = result.motebitId;
    this.deviceId = result.deviceId;
    this.publicKey = result.publicKeyHex;

    // Generate motebit.md identity file on first launch (best-effort, desktop-specific)
    if (result.isFirstLaunch) {
      try {
        const keypair = await this.getDeviceKeypair(invoke);
        if (keypair) {
          const privKeyBytes = new Uint8Array(keypair.privateKey.length / 2);
          for (let i = 0; i < keypair.privateKey.length; i += 2) {
            privKeyBytes[i / 2] = parseInt(keypair.privateKey.slice(i, i + 2), 16);
          }
          const identityFileContent = await generateIdentityFile(
            {
              motebitId: result.motebitId,
              ownerId: result.motebitId,
              publicKeyHex: result.publicKeyHex,
              devices: [{
                device_id: result.deviceId,
                name: "Desktop",
                public_key: result.publicKeyHex,
                registered_at: new Date().toISOString(),
              }],
            },
            privKeyBytes,
          );
          const raw = await invoke<string>("read_config");
          const config = { ...JSON.parse(raw) as Record<string, unknown>, _identity_file: identityFileContent };
          await invoke<void>("write_config", { json: JSON.stringify(config) });
        }
      } catch {
        // Non-fatal — identity file generation is best-effort on desktop
      }
    }

    return { isFirstLaunch: result.isFirstLaunch, motebitId: result.motebitId, deviceId: result.deviceId };
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
    this.renderer.setLightEnvironment();
    this.renderer.enableOrbitControls();
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

  /**
   * Initialize AI, tools, governance, and state persistence.
   * Must be called after bootstrap() for Tauri builds (needs motebitId).
   * Returns false only if Anthropic provider is selected but no API key is provided.
   */
  async initAI(config: DesktopAIConfig): Promise<boolean> {
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

    // State snapshot persistence — preload before runtime construction
    let stateSnapshot: TauriStateSnapshotStorage | undefined;
    if (config.isTauri && config.invoke) {
      stateSnapshot = new TauriStateSnapshotStorage(config.invoke);
      await stateSnapshot.preload(this.motebitId);
    }

    const storage = createDesktopStorage(config, stateSnapshot);
    const keyring = config.isTauri && config.invoke ? new TauriKeyringAdapter(config.invoke) : undefined;

    // Read governance from motebit.md identity file.
    // Fail-closed: in Tauri mode, tools are only registered if governance is valid.
    // In dev mode (non-Tauri), tools register freely — no identity file exists.
    let policyConfig: Partial<PolicyConfig> | undefined;
    let governanceLoaded = false;

    if (config.isTauri && config.invoke) {
      try {
        const raw = await config.invoke<string>("read_config");
        const configData = JSON.parse(raw) as Record<string, unknown>;
        const identityFileContent = configData._identity_file as string | undefined;
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
            governanceLoaded = true;
          }
        }
      } catch {
        // Parse failure — governance stays unloaded, tools won't register
      }
    }

    this.runtime = new MotebitRuntime(
      { motebitId: this.motebitId, tickRateHz: 2, policy: policyConfig },
      { storage, renderer: this.renderer, ai: provider, keyring },
    );

    // Fail-closed tool registration:
    // - Tauri mode: tools only register if governance thresholds are present
    // - Dev mode (non-Tauri): tools register freely (no identity to govern from)
    if (!config.isTauri || governanceLoaded) {
      registerDesktopTools(this.runtime.getToolRegistry(), this.runtime);
      this._governanceStatus = config.isTauri
        ? { governed: true }
        : { governed: false, reason: "dev mode" };
    } else {
      this._governanceStatus = { governed: false, reason: "missing or invalid governance in motebit.md" };
    }

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

  async *resumeAfterApproval(approved: boolean): AsyncGenerator<StreamChunk> {
    if (!this.runtime) throw new Error("AI not initialized — call initAI() first");
    yield* this.runtime.resumeAfterApproval(approved);
  }

  // === Appearance ===

  setInteriorColor(presetName: string): void {
    const preset = COLOR_PRESETS[presetName];
    if (!preset) return;
    this.renderer.setInteriorColor(preset);
  }

  setAudioReactivity(energy: { rms: number; low: number; mid: number; high: number } | null): void {
    this.renderer.setAudioReactivity(energy);
  }

  // === MCP Lifecycle ===
  // @motebit/mcp-client is Node-only (stdio/child_process) — dynamic import only.

  async addMcpServer(config: McpServerConfig): Promise<McpServerStatus> {
    // Dynamic import to avoid bundling Node-only dependencies into the webview
    // @ts-ignore — @motebit/mcp-client is a Node-only package, resolved at runtime in Tauri
    const mcpModule = await (import("@motebit/mcp-client") as Promise<{
      McpClientAdapter: new (config: McpServerConfig) => {
        connect(): Promise<void>;
        disconnect(): Promise<void>;
        getTools(): unknown[];
        registerInto(registry: unknown): void;
      };
    }>);
    const adapter = new mcpModule.McpClientAdapter(config);
    await adapter.connect();

    // Register tools into a temporary registry, then merge into runtime
    const tempRegistry = new SimpleToolRegistry();
    adapter.registerInto(tempRegistry);

    if (this.runtime) {
      this.runtime.registerExternalTools(`mcp:${config.name}`, tempRegistry);
    }

    this.mcpAdapters.set(config.name, adapter);
    this.mcpConfigs.set(config.name, config);

    return {
      name: config.name,
      transport: config.transport,
      trusted: config.trusted ?? false,
      connected: true,
      toolCount: adapter.getTools().length,
    };
  }

  async removeMcpServer(name: string): Promise<void> {
    const adapter = this.mcpAdapters.get(name);
    if (adapter) {
      await adapter.disconnect();
      this.mcpAdapters.delete(name);
    }
    this.mcpConfigs.delete(name);
    if (this.runtime) {
      this.runtime.unregisterExternalTools(`mcp:${name}`);
    }
  }

  getMcpStatus(): McpServerStatus[] {
    const result: McpServerStatus[] = [];
    for (const [name, config] of this.mcpConfigs) {
      result.push({
        name,
        transport: config.transport,
        trusted: config.trusted ?? false,
        connected: this.mcpAdapters.has(name),
        toolCount: 0, // TODO: track per-server tool count
      });
    }
    return result;
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

  // === Governance ===

  get governanceStatus(): GovernanceStatus {
    return this._governanceStatus;
  }

  // === Identity ===

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

    if (this.runtime) {
      // Export memories (nodes + edges)
      try {
        const { nodes, edges } = await this.runtime.memory.exportAll();
        data.memories = nodes;
        data.edges = edges;
      } catch {
        data.memories = [];
        data.edges = [];
      }

      // Export state vector
      data.state = this.runtime.getState();

      // Export recent events
      try {
        const events = await this.runtime.events.query({
          motebit_id: this.motebitId,
          limit: 500,
        });
        data.events = events;
      } catch {
        data.events = [];
      }
    }

    return JSON.stringify(data, null, 2);
  }

  // === Pairing: Device A (existing device) ===

  /**
   * Initiate a pairing session. Returns a 6-char code to display to the user.
   */
  async initiatePairing(invoke: InvokeFn, syncUrl: string): Promise<{ pairingCode: string; pairingId: string }> {
    const keypair = await this.getDeviceKeypair(invoke);
    if (!keypair) throw new Error("No device keypair available");

    const token = await this.createSyncToken(keypair.privateKey);
    const client = new PairingClient({ relayUrl: syncUrl });
    const result = await client.initiate(token);
    return { pairingCode: result.pairingCode, pairingId: result.pairingId };
  }

  /**
   * Get the current state of a pairing session (Device A polls for claim).
   */
  async getPairingSession(invoke: InvokeFn, syncUrl: string, pairingId: string): Promise<PairingSession> {
    const keypair = await this.getDeviceKeypair(invoke);
    if (!keypair) throw new Error("No device keypair available");

    const token = await this.createSyncToken(keypair.privateKey);
    const client = new PairingClient({ relayUrl: syncUrl });
    return client.getSession(pairingId, token);
  }

  /**
   * Approve a claimed pairing session, registering Device B.
   */
  async approvePairing(invoke: InvokeFn, syncUrl: string, pairingId: string): Promise<{ deviceId: string }> {
    const keypair = await this.getDeviceKeypair(invoke);
    if (!keypair) throw new Error("No device keypair available");

    const token = await this.createSyncToken(keypair.privateKey);
    const client = new PairingClient({ relayUrl: syncUrl });
    const result = await client.approve(pairingId, token);
    return { deviceId: result.deviceId };
  }

  /**
   * Deny a claimed pairing session.
   */
  async denyPairing(invoke: InvokeFn, syncUrl: string, pairingId: string): Promise<void> {
    const keypair = await this.getDeviceKeypair(invoke);
    if (!keypair) throw new Error("No device keypair available");

    const token = await this.createSyncToken(keypair.privateKey);
    const client = new PairingClient({ relayUrl: syncUrl });
    await client.deny(pairingId, token);
  }

  // === Pairing: Device B (new device) ===

  /**
   * Claim a pairing session using a code from Device A.
   */
  async claimPairing(syncUrl: string, code: string): Promise<{ pairingId: string; motebitId: string }> {
    if (!this.publicKey) throw new Error("No public key available — bootstrap first");

    const client = new PairingClient({ relayUrl: syncUrl });
    return client.claim(code.toUpperCase(), "Desktop", this.publicKey);
  }

  /**
   * Poll for pairing approval status (Device B).
   */
  async pollPairingStatus(syncUrl: string, pairingId: string): Promise<PairingStatus> {
    const client = new PairingClient({ relayUrl: syncUrl });
    return client.pollStatus(pairingId);
  }

  /**
   * Complete pairing by storing the received identity (Device B).
   */
  async completePairing(invoke: InvokeFn, result: { motebitId: string; deviceId: string; deviceToken: string }): Promise<void> {
    const raw = await invoke<string>("read_config");
    const config = JSON.parse(raw) as Record<string, unknown>;

    const updatedConfig = {
      ...config,
      motebit_id: result.motebitId,
      device_id: result.deviceId,
    };
    await invoke<void>("write_config", { json: JSON.stringify(updatedConfig) });

    // Store device token in keyring for sync auth
    await invoke<void>("keyring_set", { key: "device_token", value: result.deviceToken });

    this.motebitId = result.motebitId;
    this.deviceId = result.deviceId;
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
