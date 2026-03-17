/**
 * @motebit/desktop — Tauri app (Rust + webview)
 *
 * Thin platform shell around MotebitRuntime.
 * Provides Tauri-specific storage adapters and AI provider creation.
 */

import { MotebitRuntime, SimpleToolRegistry } from "@motebit/runtime";
import type {
  TurnResult,
  StorageAdapters,
  StreamChunk,
  KeyringAdapter,
  OperatorModeResult,
  AuditLogSink,
  InteriorColor,
  McpServerConfig,
  PolicyConfig,
  MemoryGovernanceConfig,
} from "@motebit/runtime";
import { ThreeJSAdapter } from "@motebit/render-engine";
import {
  CloudProvider,
  OllamaProvider,
  detectOllama,
  resolveConfig,
  DEFAULT_OLLAMA_URL,
  type MotebitPersonalityConfig,
} from "@motebit/ai-core";
export type { OllamaDetectionResult } from "@motebit/ai-core";
import type { ToolAuditEntry, MemoryNode, MemoryEdge } from "@motebit/sdk";
import { EventType, SensitivityLevel, DeviceCapability } from "@motebit/sdk";
import { InMemoryEventStore, type EventStoreAdapter } from "@motebit/event-log";
import { InMemoryMemoryStorage, computeDecayedConfidence, embedText } from "@motebit/memory-graph";
import {
  InMemoryIdentityStorage,
  bootstrapIdentity as sharedBootstrapIdentity,
  rotateIdentityKeys,
  type BootstrapConfigStore,
  type BootstrapKeyStore,
} from "@motebit/core-identity";
import { InMemoryAuditLog } from "@motebit/privacy-layer";
import {
  createSignedToken,
  deriveSyncEncryptionKey,
  hexPublicKeyToDidKey,
  secureErase,
  bytesToHex,
} from "@motebit/crypto";
import {
  generate as generateIdentityFile,
  parse as parseIdentityFile,
  verifyIdentityFile as verifyIdentity,
  governanceToPolicyConfig,
} from "@motebit/identity-file";
import {
  PairingClient,
  ConversationSyncEngine,
  HttpConversationSyncAdapter,
  PlanSyncEngine,
  HttpPlanSyncAdapter,
  HttpEventStoreAdapter,
  WebSocketEventStoreAdapter,
  EncryptedEventStoreAdapter,
  decryptEventPayload,
} from "@motebit/sync-engine";
import type {
  PairingSession,
  PairingStatus,
  ConversationSyncStoreAdapter,
  PlanSyncStoreAdapter,
  SyncStatus,
} from "@motebit/sync-engine";
import type {
  SyncConversation,
  SyncConversationMessage,
  SyncPlan,
  SyncPlanStep,
  Plan,
  PlanStep,
} from "@motebit/sdk";
import { PlanEngine, InMemoryPlanStore } from "@motebit/planner";
import type { PlanChunk, PlanStoreAdapter } from "@motebit/planner";
import { PlanStatus } from "@motebit/sdk";
import {
  TauriEventStore,
  TauriMemoryStorage,
  TauriIdentityStorage,
  TauriAuditLog,
  TauriStateSnapshotStorage,
  TauriConversationStore,
  TauriPlanStore,
  TauriAgentTrustStore,
  type InvokeFn,
} from "./tauri-storage.js";
import { registerDesktopTools } from "./desktop-tools.js";
import {
  createSubGoalDefinition,
  completeGoalDefinition,
  reportProgressDefinition,
} from "@motebit/tools/web-safe";
export type { InvokeFn } from "./tauri-storage.js";

// Re-export runtime types for main.ts consumption
export type {
  TurnResult,
  StreamChunk,
  OperatorModeResult,
  InteriorColor,
  McpServerConfig,
  PolicyConfig,
  MemoryGovernanceConfig,
};
export type { PairingSession, PairingStatus };
export type { MemoryNode, MemoryEdge };
export type { DeletionCertificate } from "@motebit/crypto";

// === Sync Status ===

export type SyncIndicatorStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "syncing"
  | "conflict"
  | "error";

export interface SyncStatusEvent {
  status: SyncIndicatorStatus;
  lastSyncAt: number | null;
  eventsPushed: number;
  eventsPulled: number;
  conflictCount: number;
  error: string | null;
}

export interface GoalCompleteEvent {
  goalId: string;
  prompt: string;
  status: "completed" | "failed";
  summary: string | null;
  error: string | null;
  /** Plan title if the goal used plan-based execution. */
  planTitle?: string;
  /** Number of plan steps completed. */
  stepsCompleted?: number;
  /** Total plan steps. */
  totalSteps?: number;
}

/** Maximum tool calls across all turns in a single goal run (default 50). */
const MAX_TOOL_CALLS_PER_RUN = 50;

export interface GoalPlanProgressEvent {
  goalId: string;
  planTitle: string;
  stepIndex: number;
  totalSteps: number;
  stepDescription: string;
  type: "plan_created" | "step_started" | "step_completed" | "step_failed";
}

export interface GoalApprovalEvent {
  goalId: string;
  goalPrompt: string;
  toolName: string;
  args: Record<string, unknown>;
  riskLevel?: number;
}

// === Tauri Command Interface ===

export interface TauriCommands {
  db_query(sql: string, params: unknown[]): Promise<unknown[]>;
  db_execute(sql: string, params: unknown[]): Promise<number>;
  keyring_get(key: string): Promise<string | null>;
  keyring_set(key: string, value: string): Promise<void>;
  keyring_delete(key: string): Promise<void>;
  read_config(): Promise<string>;
  write_config(json: string): Promise<void>;
  read_file_tool(path: string): Promise<string>;
  write_file_tool(path: string, content: string): Promise<string>;
  shell_exec_tool(
    command: string,
    cwd: string | null,
  ): Promise<{ stdout: string; stderr: string; exit_code: number }>;
  transcribe_audio(audio_base64: string, api_key: string | null): Promise<string>;
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
  memoryGovernance?: { persistenceThreshold?: number; rejectSecrets?: boolean };
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
      sql: `INSERT OR REPLACE INTO tool_audit_log (call_id, turn_id, run_id, tool, args, decision, result, injection, cost_units, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        entry.callId,
        entry.turnId,
        entry.runId ?? null,
        entry.tool,
        JSON.stringify(entry.args),
        JSON.stringify(entry.decision),
        entry.result ? JSON.stringify(entry.result) : null,
        entry.injection ? JSON.stringify(entry.injection) : null,
        entry.costUnits ?? 0,
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

  queryStatsSince(_afterTimestamp: number): {
    distinctTurns: number;
    totalToolCalls: number;
    succeeded: number;
    blocked: number;
    failed: number;
  } {
    // Sync interface — return empty. Desktop gradient computation falls back
    // to the in-memory behavioral stats accumulator.
    return { distinctTurns: 0, totalToolCalls: 0, succeeded: 0, blocked: 0, failed: 0 };
  }
}

// === Storage Factory ===

function createTauriStorage(
  invoke: InvokeFn,
  stateSnapshot?: TauriStateSnapshotStorage,
  conversationStore?: TauriConversationStore,
): StorageAdapters {
  return {
    eventStore: new TauriEventStore(invoke),
    memoryStorage: new TauriMemoryStorage(invoke),
    identityStorage: new TauriIdentityStorage(invoke),
    auditLog: new TauriAuditLog(invoke),
    toolAuditSink: new TauriToolAuditSink(invoke),
    stateSnapshot,
    conversationStore,
    agentTrustStore: new TauriAgentTrustStore(invoke),
  };
}

function createDesktopStorage(
  config: DesktopAIConfig,
  stateSnapshot?: TauriStateSnapshotStorage,
  conversationStore?: TauriConversationStore,
): StorageAdapters {
  if (config.isTauri && config.invoke) {
    return createTauriStorage(config.invoke, stateSnapshot, conversationStore);
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
  moonlight: { tint: [0.95, 0.95, 1.0], glow: [0.8, 0.85, 1.0] },
  amber: { tint: [1.0, 0.85, 0.6], glow: [0.9, 0.7, 0.3] },
  rose: { tint: [1.0, 0.82, 0.88], glow: [0.9, 0.5, 0.6] },
  violet: { tint: [0.88, 0.8, 1.0], glow: [0.6, 0.4, 0.9] },
  cyan: { tint: [0.8, 0.95, 1.0], glow: [0.3, 0.8, 0.9] },
  ember: { tint: [1.0, 0.75, 0.65], glow: [0.9, 0.35, 0.2] },
  sage: { tint: [0.82, 0.95, 0.85], glow: [0.4, 0.75, 0.5] },
};

// === MCP Server Status ===

export interface McpServerStatus {
  name: string;
  transport: string;
  trusted: boolean;
  connected: boolean;
  toolCount: number;
  manifestChanged?: boolean;
  /** If manifest changed, tools added/removed since last pin. */
  manifestDiff?: { added: string[]; removed: string[] };
}

// === Desktop App (platform shell) ===

export interface BootstrapResult {
  isFirstLaunch: boolean;
  motebitId: string;
  deviceId: string;
}

export type GovernanceStatus = { governed: true } | { governed: false; reason: string };

export class DesktopApp {
  private runtime: MotebitRuntime | null = null;
  private renderer: ThreeJSAdapter;
  private mcpAdapters = new Map<string, { disconnect(): Promise<void> }>();
  private mcpConfigs = new Map<string, McpServerConfig>();
  private mcpToolCounts = new Map<string, number>();
  motebitId: string = "desktop-local";
  deviceId: string = "desktop-local";
  publicKey: string = "";
  private _governanceStatus: GovernanceStatus = { governed: false, reason: "not initialized" };
  private goalSchedulerTimer: ReturnType<typeof setInterval> | null = null;
  private _goalExecuting = false;
  private _currentGoalId: string | null = null;
  private _goalStatusCallback: ((executing: boolean) => void) | null = null;
  private _goalCompleteCallback: ((event: GoalCompleteEvent) => void) | null = null;
  private _goalApprovalCallback: ((event: GoalApprovalEvent) => void) | null = null;
  private _goalPlanProgressCallback: ((event: GoalPlanProgressEvent) => void) | null = null;
  private _pendingGoalApproval: {
    goalId: string;
    prompt: string;
    invoke: InvokeFn;
    mode: string;
    planId?: string;
    runId?: string;
  } | null = null;
  private planEngine: PlanEngine | null = null;
  private planStoreRef: TauriPlanStore | PlanStoreAdapter | null = null;
  private conversationStoreRef: TauriConversationStore | null = null;
  private _autoTitlePending = false;
  private _syncStatusCallback: ((event: SyncStatusEvent) => void) | null = null;
  private _lastSyncStatus: SyncStatusEvent = {
    status: "disconnected",
    lastSyncAt: null,
    eventsPushed: 0,
    eventsPulled: 0,
    conflictCount: 0,
    error: null,
  };
  private _syncUnsubscribe: (() => void) | null = null;
  private _wsAdapter: WebSocketEventStoreAdapter | null = null;
  private _wsTokenRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private _wsUnsubOnEvent: (() => void) | null = null;
  private _localEventStore: EventStoreAdapter | null = null;

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
        if (config.motebit_id == null || typeof config.motebit_id !== "string") return null;
        return {
          motebit_id: config.motebit_id,
          device_id: (config.device_id as string) ?? "",
          device_public_key: (config.device_public_key as string) ?? "",
        };
      },
      async write(state) {
        const raw = await invoke<string>("read_config");
        const config = { ...(JSON.parse(raw) as Record<string, unknown>), ...state };
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
          try {
            const identityFileContent = await generateIdentityFile(
              {
                motebitId: result.motebitId,
                ownerId: result.motebitId,
                publicKeyHex: result.publicKeyHex,
                devices: [
                  {
                    device_id: result.deviceId,
                    name: "Desktop",
                    public_key: result.publicKeyHex,
                    registered_at: new Date().toISOString(),
                  },
                ],
              },
              privKeyBytes,
            );
            const raw = await invoke<string>("read_config");
            const config = {
              ...(JSON.parse(raw) as Record<string, unknown>),
              _identity_file: identityFileContent,
            };
            await invoke<void>("write_config", { json: JSON.stringify(config) });
          } finally {
            secureErase(privKeyBytes);
          }
        }
      } catch {
        // Non-fatal — identity file generation is best-effort on desktop
      }
    }

    return {
      isFirstLaunch: result.isFirstLaunch,
      motebitId: result.motebitId,
      deviceId: result.deviceId,
    };
  }

  /**
   * Get the device keypair from keyring + config. Returns null if not available.
   */
  async getDeviceKeypair(
    invoke: InvokeFn,
  ): Promise<{ publicKey: string; privateKey: string } | null> {
    const raw = await invoke<string>("read_config");
    const config = JSON.parse(raw) as Record<string, unknown>;
    const publicKey = config.device_public_key as string | undefined;
    if (publicKey == null || publicKey === "") return null;

    let privateKey: string | null = null;
    try {
      privateKey = await invoke<string | null>("keyring_get", { key: "device_private_key" });
    } catch {
      return null;
    }
    if (privateKey == null || privateKey === "") return null;

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
   * @param aud — audience claim binding token to a specific endpoint (default: "sync")
   */
  async createSyncToken(privateKeyHex: string, aud: string = "sync"): Promise<string> {
    const privKeyBytes = new Uint8Array(privateKeyHex.length / 2);
    for (let i = 0; i < privateKeyHex.length; i += 2) {
      privKeyBytes[i / 2] = parseInt(privateKeyHex.slice(i, i + 2), 16);
    }

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

  /** The active provider type: "anthropic", "ollama", or null if not initialized. */
  private _activeProvider: "anthropic" | "ollama" | null = null;

  get currentProvider(): "anthropic" | "ollama" | null {
    return this._activeProvider;
  }

  /**
   * Detect a local Ollama instance. Never throws.
   * Times out after 2 seconds.
   */
  detectOllama(): ReturnType<typeof detectOllama> {
    return detectOllama();
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
    const resolved = config.personalityConfig ? resolveConfig(config.personalityConfig) : undefined;
    const temperature = resolved?.temperature;

    let provider;
    if (config.provider === "ollama") {
      const model = config.model != null && config.model !== "" ? config.model : "llama3.2";
      const base_url = config.isTauri ? DEFAULT_OLLAMA_URL : "/api/ollama";
      provider = new OllamaProvider({ model, base_url, max_tokens: 1024, temperature });
      this._activeProvider = "ollama";
    } else {
      if (config.apiKey == null || config.apiKey === "") return false;
      const model =
        config.model != null && config.model !== "" ? config.model : "claude-sonnet-4-20250514";
      const base_url = config.isTauri ? "https://api.anthropic.com" : "/api/anthropic";
      provider = new CloudProvider({
        provider: "anthropic",
        api_key: config.apiKey,
        model,
        base_url,
        max_tokens: 1024,
        temperature,
      });
      this._activeProvider = "anthropic";
    }

    // State snapshot + conversation persistence — preload before runtime construction
    let stateSnapshot: TauriStateSnapshotStorage | undefined;
    let conversationStore: TauriConversationStore | undefined;
    if (config.isTauri && config.invoke) {
      stateSnapshot = new TauriStateSnapshotStorage(config.invoke);
      conversationStore = new TauriConversationStore(config.invoke);
      await Promise.all([
        stateSnapshot.preload(this.motebitId),
        conversationStore.preload(this.motebitId),
      ]);
    }

    // Store ref to conversation store for async operations (listing, loading, titling)
    this.conversationStoreRef = conversationStore ?? null;

    const storage = createDesktopStorage(config, stateSnapshot, conversationStore);
    this._localEventStore = storage.eventStore;
    const keyring =
      config.isTauri && config.invoke ? new TauriKeyringAdapter(config.invoke) : undefined;

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
        if (identityFileContent != null && identityFileContent !== "") {
          const parsed = parseIdentityFile(identityFileContent);
          const gov = parsed.frontmatter.governance;
          if (
            gov?.max_risk_auto != null &&
            gov?.require_approval_above != null &&
            gov?.deny_above != null
          ) {
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
      {
        motebitId: this.motebitId,
        tickRateHz: 2,
        policy: policyConfig,
        memoryGovernance: config.memoryGovernance,
      },
      { storage, renderer: this.renderer, ai: provider, keyring },
    );

    // Advertise full desktop capabilities
    this.runtime.setLocalCapabilities([
      DeviceCapability.StdioMcp,
      DeviceCapability.HttpMcp,
      DeviceCapability.FileSystem,
      DeviceCapability.Keyring,
      DeviceCapability.Background,
    ]);

    // Create PlanEngine for multi-step goal execution
    if (config.isTauri && config.invoke) {
      const tauriPlanStore = new TauriPlanStore(config.invoke);
      this.planStoreRef = tauriPlanStore;
      this.planEngine = new PlanEngine(tauriPlanStore);
    } else {
      const memPlanStore = new InMemoryPlanStore();
      this.planStoreRef = memPlanStore;
      this.planEngine = new PlanEngine(memPlanStore);
    }

    // Fail-closed tool registration:
    // - Tauri mode: tools only register if governance thresholds are present
    // - Dev mode (non-Tauri): tools register freely (no identity to govern from)
    if (!config.isTauri || governanceLoaded) {
      registerDesktopTools(this.runtime.getToolRegistry(), this.runtime, config.invoke);
      this._governanceStatus = config.isTauri
        ? { governed: true }
        : { governed: false, reason: "dev mode" };
    } else {
      this._governanceStatus = {
        governed: false,
        reason: "missing or invalid governance in motebit.md",
      };
    }

    // Register goal-management tools (available during goal execution)
    if (config.isTauri && config.invoke) {
      this.registerGoalTools(config.invoke);
    }

    return true;
  }

  /**
   * Register goal-management tools that the agent can use during goal execution.
   * These tools let the agent create sub-goals, complete goals, and report progress.
   * They are no-ops when called outside of an active goal context.
   */
  private registerGoalTools(invoke: InvokeFn): void {
    const registry = this.runtime!.getToolRegistry();

    // Helper: parse interval strings like "1h", "30m", "1d" to milliseconds
    const parseInterval = (s: string): number => {
      const match = s.match(/^(\d+)\s*(s|m|h|d)$/i);
      if (!match) return 3_600_000; // default 1h
      const n = parseInt(match[1]!, 10);
      switch (match[2]!.toLowerCase()) {
        case "s":
          return n * 1_000;
        case "m":
          return n * 60_000;
        case "h":
          return n * 3_600_000;
        case "d":
          return n * 86_400_000;
        default:
          return 3_600_000;
      }
    };

    registry.register(createSubGoalDefinition, async (args: Record<string, unknown>) => {
      if (this._currentGoalId == null || this._currentGoalId === "") {
        return { ok: false, error: "No active goal context" };
      }
      const prompt = args.prompt as string;
      const interval = args.interval as string | undefined;
      const once = args.once as boolean | undefined;
      const intervalMs = interval != null && interval !== "" ? parseInterval(interval) : 3_600_000;
      const mode = once === true ? "once" : "recurring";
      const subGoalId = crypto.randomUUID();

      try {
        await invoke("goals_create", {
          motebit_id: this.motebitId,
          goal_id: subGoalId,
          prompt,
          interval_ms: intervalMs,
          mode,
        });
        // Set parent_goal_id
        await invoke<number>("db_execute", {
          sql: "UPDATE goals SET parent_goal_id = ? WHERE goal_id = ?",
          params: [this._currentGoalId, subGoalId],
        });
        return { ok: true, data: { goal_id: subGoalId, prompt, mode, interval_ms: intervalMs } };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
      }
    });

    registry.register(completeGoalDefinition, async (args: Record<string, unknown>) => {
      if (this._currentGoalId == null || this._currentGoalId === "") {
        return { ok: false, error: "No active goal context" };
      }
      const reason = args.reason as string;
      try {
        await invoke<number>("db_execute", {
          sql: "UPDATE goals SET status = 'completed' WHERE goal_id = ?",
          params: [this._currentGoalId],
        });
        // Best-effort event log
        try {
          await this.runtime!.events.append({
            event_id: crypto.randomUUID(),
            motebit_id: this.motebitId,
            event_type: EventType.GoalCompleted,
            payload: { goal_id: this._currentGoalId, reason },
            version_clock: (await this.runtime!.events.getLatestClock(this.motebitId)) + 1,
            timestamp: Date.now(),
            tombstoned: false,
          });
        } catch {
          /* best-effort */
        }
        return { ok: true, data: { goal_id: this._currentGoalId, status: "completed", reason } };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
      }
    });

    registry.register(reportProgressDefinition, async (args: Record<string, unknown>) => {
      if (this._currentGoalId == null || this._currentGoalId === "") {
        return { ok: false, error: "No active goal context" };
      }
      const note = args.note as string;
      try {
        await this.runtime!.events.append({
          event_id: crypto.randomUUID(),
          motebit_id: this.motebitId,
          event_type: EventType.GoalProgress,
          payload: { goal_id: this._currentGoalId, note },
          version_clock: (await this.runtime!.events.getLatestClock(this.motebitId)) + 1,
          timestamp: Date.now(),
          tombstoned: false,
        });
        return { ok: true, data: { goal_id: this._currentGoalId, note } };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
      }
    });
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

  /** Get conversation history for rendering previous messages on reopen. */
  getConversationHistory(): Array<{ role: string; content: string }> {
    return this.runtime?.getConversationHistory() ?? [];
  }

  async sendMessage(text: string, runId?: string): Promise<TurnResult> {
    if (!this.runtime) throw new Error("AI not initialized — call initAI() first");
    return this.runtime.sendMessage(text, runId);
  }

  async *sendMessageStreaming(text: string, runId?: string): AsyncGenerator<StreamChunk> {
    if (!this.runtime) throw new Error("AI not initialized — call initAI() first");
    yield* this.runtime.sendMessageStreaming(text, runId);
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

  /** Apply an arbitrary interior color directly (bypasses preset lookup). Used for custom color picker live preview. */
  setInteriorColorDirect(color: InteriorColor): void {
    this.renderer.setInteriorColor(color);
  }

  setDarkEnvironment(): void {
    this.renderer.setDarkEnvironment();
  }

  setLightEnvironment(): void {
    this.renderer.setLightEnvironment();
  }

  setAudioReactivity(energy: { rms: number; low: number; mid: number; high: number } | null): void {
    this.renderer.setAudioReactivity(energy);
  }

  // === MCP Lifecycle ===
  // @motebit/mcp-client is Node-only (stdio/child_process) — dynamic import only.

  async addMcpServer(config: McpServerConfig): Promise<McpServerStatus> {
    // Dynamic import to avoid bundling Node-only dependencies into the webview
    const mcpModule = await (import("@motebit/mcp-client") as Promise<{
      McpClientAdapter: new (config: McpServerConfig) => {
        connect(): Promise<void>;
        disconnect(): Promise<void>;
        getTools(): unknown[];
        registerInto(registry: unknown): void;
        checkManifest(
          pinnedHash?: string,
          pinnedToolNames?: string[],
        ): Promise<{
          ok: boolean;
          hash: string;
          previousHash?: string;
          toolCount: number;
          toolNames: string[];
          diff?: { added: string[]; removed: string[] };
        }>;
        readonly isMotebit: boolean;
        readonly verifiedIdentity: {
          verified: boolean;
          motebit_id?: string;
          public_key?: string;
        } | null;
        readonly serverConfig: McpServerConfig;
      };
    }>);
    const adapter = new mcpModule.McpClientAdapter(config);
    await adapter.connect();

    // Manifest pinning — verify tools haven't changed since last connection
    const manifestCheck = await adapter.checkManifest(
      config.toolManifestHash,
      config.pinnedToolNames,
    );
    let manifestChanged = false;
    let manifestDiff: { added: string[]; removed: string[] } | undefined;
    if (!manifestCheck.ok) {
      // Tools changed since last pin — revoke trust, require re-approval
      manifestChanged = true;
      manifestDiff = manifestCheck.diff;
      config.trusted = false;
    }
    // Pin the current manifest hash and tool names
    config.toolManifestHash = manifestCheck.hash;
    config.pinnedToolNames = manifestCheck.toolNames;

    // Pin motebit public key on first verified connect
    if (adapter.isMotebit && adapter.verifiedIdentity?.verified === true) {
      const verifiedKey = adapter.verifiedIdentity.public_key;
      if (verifiedKey && !config.motebitPublicKey) {
        config.motebitPublicKey = verifiedKey;
      }
    }

    // Register tools into a temporary registry, then merge into runtime
    const tempRegistry = new SimpleToolRegistry();
    adapter.registerInto(tempRegistry);

    if (this.runtime) {
      this.runtime.registerExternalTools(`mcp:${config.name}`, tempRegistry);
    }

    this.mcpAdapters.set(config.name, adapter);
    this.mcpConfigs.set(config.name, config);
    const toolCount = adapter.getTools().length;
    this.mcpToolCounts.set(config.name, toolCount);

    return {
      name: config.name,
      transport: config.transport,
      trusted: config.trusted ?? false,
      connected: true,
      toolCount,
      manifestChanged,
      manifestDiff,
    };
  }

  async removeMcpServer(name: string): Promise<void> {
    const adapter = this.mcpAdapters.get(name);
    if (adapter) {
      await adapter.disconnect();
      this.mcpAdapters.delete(name);
    }
    this.mcpConfigs.delete(name);
    this.mcpToolCounts.delete(name);
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
        toolCount: this.mcpToolCounts.get(name) ?? 0,
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

  /** Read-only snapshot of the effective memory governance config. Returns null if runtime not initialized. */
  getMemoryGovernance(): {
    persistenceThreshold: number;
    maxMemoriesPerTurn: number;
    rejectSecrets: boolean;
  } | null {
    if (!this.runtime) return null;
    return { ...this.runtime.memoryGovernor.getConfig() };
  }

  // === Governance ===

  get governanceStatus(): GovernanceStatus {
    return this._governanceStatus;
  }

  // === State & Tools ===

  /** Get the current state vector. Returns null if runtime not initialized. */
  getState(): Record<string, unknown> | null {
    if (!this.runtime) return null;
    return this.runtime.getState() as unknown as Record<string, unknown>;
  }

  /** List all registered tool names and descriptions. */
  listTools(): Array<{ name: string; description: string }> {
    if (!this.runtime) return [];
    return this.runtime
      .getToolRegistry()
      .list()
      .map((t) => ({
        name: t.name,
        description: t.description ?? "",
      }));
  }

  // === Identity ===

  getIdentityInfo(): { motebitId: string; deviceId: string; publicKey: string; did: string } {
    let did = "";
    try {
      if (this.publicKey) did = hexPublicKeyToDidKey(this.publicKey);
    } catch {
      // Non-fatal
    }
    return {
      motebitId: this.motebitId,
      deviceId: this.deviceId,
      publicKey: this.publicKey,
      did,
    };
  }

  /**
   * Generate a signed motebit.md identity file from live config.
   * Returns the file content string, or null if the keypair is unavailable.
   */
  async exportIdentityFile(invoke: InvokeFn): Promise<string | null> {
    const keypair = await this.getDeviceKeypair(invoke);
    if (!keypair) return null;

    // Read live config for governance/memory settings
    const raw = await invoke<string>("read_config");
    const configData = JSON.parse(raw) as Record<string, unknown>;

    // Map approval_preset → identity-file governance fields
    const RISK_NAMES = ["R0_READ", "R1_DRAFT", "R2_WRITE", "R3_EXECUTE", "R4_MONEY"];
    const preset = configData.approval_preset as string | undefined;
    const PRESET_GOV: Record<string, { require: number; deny: number }> = {
      cautious: { require: 0, deny: 3 },
      balanced: { require: 1, deny: 3 },
      autonomous: { require: 3, deny: 4 },
    };
    const presetGov = PRESET_GOV[preset ?? "balanced"] ?? PRESET_GOV.balanced!;
    const governance = {
      trust_mode: (preset === "autonomous" ? "full" : "guarded") as "full" | "guarded" | "minimal",
      max_risk_auto: RISK_NAMES[presetGov.require]!,
      require_approval_above: RISK_NAMES[presetGov.require]!,
      deny_above: RISK_NAMES[presetGov.deny]!,
      operator_mode: false,
    };

    // Map memory_governance config → identity-file memory fields
    const memGov = configData.memory_governance as
      | { persistence_threshold?: number; reject_secrets?: boolean }
      | undefined;
    const memory = {
      confidence_threshold: memGov?.persistence_threshold ?? 0.3,
      half_life_days: 7,
      per_turn_limit: 5,
    };

    // Build device list from current device
    const devices = [
      {
        device_id: this.deviceId,
        name: "Desktop",
        public_key: this.publicKey,
        registered_at: new Date().toISOString(),
      },
    ];

    // Convert hex private key to Uint8Array
    const privHex = keypair.privateKey;
    const privKeyBytes = new Uint8Array(privHex.length / 2);
    for (let i = 0; i < privHex.length; i += 2) {
      privKeyBytes[i / 2] = parseInt(privHex.slice(i, i + 2), 16);
    }

    try {
      return await generateIdentityFile(
        {
          motebitId: this.motebitId,
          ownerId: this.motebitId,
          publicKeyHex: this.publicKey,
          governance,
          memory,
          devices,
        },
        privKeyBytes,
      );
    } finally {
      secureErase(privKeyBytes);
    }
  }

  /**
   * Verify a motebit.md identity file's Ed25519 signature.
   */
  async verifyIdentityFile(content: string): Promise<{ valid: boolean; error?: string }> {
    const result = await verifyIdentity(content);
    return { valid: result.valid, error: result.error };
  }

  /**
   * Rotate the Ed25519 keypair: generate a new keypair, create a signed succession
   * record (both old and new keys sign), update the identity file, store the new
   * private key in keyring, and update the config with the new public key.
   * Returns the old and new public key fingerprints and the rotation count.
   */
  async rotateKey(
    invoke: InvokeFn,
    reason?: string,
  ): Promise<{ oldKeyFingerprint: string; newKeyFingerprint: string; rotationCount: number }> {
    const oldKeypair = await this.getDeviceKeypair(invoke);
    if (!oldKeypair) throw new Error("No device keypair available");

    // Parse old keys from hex
    const oldPrivKeyBytes = new Uint8Array(oldKeypair.privateKey.length / 2);
    for (let i = 0; i < oldKeypair.privateKey.length; i += 2) {
      oldPrivKeyBytes[i / 2] = parseInt(oldKeypair.privateKey.slice(i, i + 2), 16);
    }
    const oldPubKeyBytes = new Uint8Array(oldKeypair.publicKey.length / 2);
    for (let i = 0; i < oldKeypair.publicKey.length; i += 2) {
      oldPubKeyBytes[i / 2] = parseInt(oldKeypair.publicKey.slice(i, i + 2), 16);
    }

    try {
      // Read config and identity file
      const raw = await invoke<string>("read_config");
      const configData = JSON.parse(raw) as Record<string, unknown>;
      const existingIdentityFile = configData._identity_file as string | undefined;

      // Generate new keypair, sign succession, rotate identity file
      let newPubKeyHex: string;
      let newPrivKeyHex: string;
      if (existingIdentityFile != null && existingIdentityFile !== "") {
        const rotateResult = await rotateIdentityKeys({
          existingContent: existingIdentityFile,
          oldPrivateKey: oldPrivKeyBytes,
          oldPublicKey: oldPubKeyBytes,
          reason,
        });
        configData._identity_file = rotateResult.identityFileContent;
        newPubKeyHex = rotateResult.newPublicKeyHex;
        newPrivKeyHex = bytesToHex(rotateResult.newPrivateKey);
        secureErase(rotateResult.newPrivateKey);
      } else {
        // No identity file — generate raw keypair for device key rotation only
        const { generateKeypair } = await import("@motebit/crypto");
        const newKeypair = await generateKeypair();
        newPubKeyHex = bytesToHex(newKeypair.publicKey);
        newPrivKeyHex = bytesToHex(newKeypair.privateKey);
        secureErase(newKeypair.privateKey);
      }

      // Store new private key in keyring
      await invoke<void>("keyring_set", { key: "device_private_key", value: newPrivKeyHex });

      // Update config with new public key
      configData.device_public_key = newPubKeyHex;
      await invoke<void>("write_config", { json: JSON.stringify(configData) });

      // Update in-memory state
      const oldKeyFingerprint = this.publicKey.slice(0, 16);
      this.publicKey = newPubKeyHex;
      const newKeyFingerprint = newPubKeyHex.slice(0, 16);

      // Count rotations from identity file succession chain
      let rotationCount = 1;
      if (configData._identity_file != null && typeof configData._identity_file === "string") {
        try {
          const parsed = parseIdentityFile(configData._identity_file);
          const chain = (parsed.frontmatter as unknown as Record<string, unknown>).succession;
          if (Array.isArray(chain)) rotationCount = chain.length;
        } catch {
          // Non-fatal
        }
      }

      // Update relay if configured
      const syncUrl = configData.sync_url as string | undefined;
      const masterToken = configData.sync_master_token as string | undefined;
      if (syncUrl != null && syncUrl !== "") {
        try {
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
          };
          if (masterToken) headers["Authorization"] = `Bearer ${masterToken}`;

          await fetch(`${syncUrl}/device/register`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              motebit_id: this.motebitId,
              device_name: "Desktop",
              public_key: newPubKeyHex,
            }),
          });
        } catch {
          // Non-fatal — relay update is best-effort
        }
      }

      return { oldKeyFingerprint, newKeyFingerprint, rotationCount };
    } finally {
      secureErase(oldPrivKeyBytes);
    }
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

  // === Memory Browser ===

  /** List all non-tombstoned memories, sorted by created_at DESC. */
  async listMemories(): Promise<MemoryNode[]> {
    if (!this.runtime) return [];
    try {
      const { nodes } = await this.runtime.memory.exportAll();
      return nodes.filter((n) => !n.tombstoned).sort((a, b) => b.created_at - a.created_at);
    } catch {
      return [];
    }
  }

  /** List all edges for the current motebit. */
  async listMemoryEdges(): Promise<MemoryEdge[]> {
    if (!this.runtime) return [];
    try {
      const { edges } = await this.runtime.memory.exportAll();
      return edges;
    } catch {
      return [];
    }
  }

  /** Soft-delete a memory with audit trail. */
  /** Internal: form a memory directly, bypassing the agentic loop.
   * Used only for first-run greeting fallback. Local embeddings (no network). */
  async formMemoryDirect(content: string, confidence: number): Promise<MemoryNode | null> {
    if (!this.runtime) return null;
    const embedding = await embedText(content);
    return this.runtime.memory.formMemory(
      { content, confidence, sensitivity: SensitivityLevel.None },
      embedding,
    );
  }

  async deleteMemory(
    nodeId: string,
  ): Promise<import("@motebit/crypto").DeletionCertificate | null> {
    if (!this.runtime) return null;
    try {
      return await this.runtime.privacy.deleteMemory(nodeId, this.motebitId);
    } catch {
      // Fall back to direct deletion if privacy layer fails
      await this.runtime.memory.deleteMemory(nodeId);
      return null;
    }
  }

  /** List deletion certificates from the audit log. */
  async listDeletionCertificates(): Promise<
    Array<{
      auditId: string;
      timestamp: number;
      targetId: string;
      tombstoneHash: string;
      deletedBy: string;
    }>
  > {
    if (!this.runtime) return [];
    try {
      const records = await this.runtime.auditLog.query(this.motebitId);
      return records
        .filter((r) => r.action === "delete_memory")
        .map((r) => ({
          auditId: r.audit_id,
          timestamp: r.timestamp,
          targetId: r.target_id,
          tombstoneHash: (r.details as Record<string, string>).tombstone_hash ?? "",
          deletedBy: (r.details as Record<string, string>).deleted_by ?? "",
        }));
    } catch {
      return [];
    }
  }

  /** Pin or unpin a memory. */
  async pinMemory(nodeId: string, pinned: boolean): Promise<void> {
    if (!this.runtime) return;
    await this.runtime.memory.pinMemory(nodeId, pinned);
  }

  /** Compute effective confidence after half-life decay. */
  getDecayedConfidence(node: MemoryNode): number {
    return computeDecayedConfidence(node.confidence, node.half_life, Date.now() - node.created_at);
  }

  // === Pairing: Device A (existing device) ===

  /**
   * Initiate a pairing session. Returns a 6-char code to display to the user.
   */
  async initiatePairing(
    invoke: InvokeFn,
    syncUrl: string,
  ): Promise<{ pairingCode: string; pairingId: string }> {
    const keypair = await this.getDeviceKeypair(invoke);
    if (!keypair) throw new Error("No device keypair available");

    const token = await this.createSyncToken(keypair.privateKey, "device:auth");
    const client = new PairingClient({ relayUrl: syncUrl });
    const result = await client.initiate(token);
    return { pairingCode: result.pairingCode, pairingId: result.pairingId };
  }

  /**
   * Get the current state of a pairing session (Device A polls for claim).
   */
  async getPairingSession(
    invoke: InvokeFn,
    syncUrl: string,
    pairingId: string,
  ): Promise<PairingSession> {
    const keypair = await this.getDeviceKeypair(invoke);
    if (!keypair) throw new Error("No device keypair available");

    const token = await this.createSyncToken(keypair.privateKey, "device:auth");
    const client = new PairingClient({ relayUrl: syncUrl });
    return client.getSession(pairingId, token);
  }

  /**
   * Approve a claimed pairing session, registering Device B.
   */
  async approvePairing(
    invoke: InvokeFn,
    syncUrl: string,
    pairingId: string,
  ): Promise<{ deviceId: string }> {
    const keypair = await this.getDeviceKeypair(invoke);
    if (!keypair) throw new Error("No device keypair available");

    const token = await this.createSyncToken(keypair.privateKey, "device:auth");
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

    const token = await this.createSyncToken(keypair.privateKey, "device:auth");
    const client = new PairingClient({ relayUrl: syncUrl });
    await client.deny(pairingId, token);
  }

  // === Pairing: Device B (new device) ===

  /**
   * Claim a pairing session using a code from Device A.
   */
  async claimPairing(
    syncUrl: string,
    code: string,
  ): Promise<{ pairingId: string; motebitId: string }> {
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
  async completePairing(
    invoke: InvokeFn,
    result: { motebitId: string; deviceId: string; deviceToken: string },
  ): Promise<void> {
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

  // === Goal Scheduling ===

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

  /** Subscribe to plan progress events (step started/completed/failed during goal execution). */
  onGoalPlanProgress(callback: (event: GoalPlanProgressEvent) => void): void {
    this._goalPlanProgressCallback = callback;
  }

  /** Subscribe to sync status changes (for UI indicator). */
  onSyncStatus(callback: (event: SyncStatusEvent) => void): void {
    this._syncStatusCallback = callback;
    // Immediately emit current status so the UI can initialize
    callback(this._lastSyncStatus);
  }

  /** Get the current sync status snapshot. */
  get syncStatus(): SyncStatusEvent {
    return { ...this._lastSyncStatus };
  }

  /** Emit a sync status event and update internal state. */
  private emitSyncStatus(partial: Partial<SyncStatusEvent>): void {
    this._lastSyncStatus = { ...this._lastSyncStatus, ...partial };
    this._syncStatusCallback?.(this._lastSyncStatus);
  }

  /**
   * Resume a goal after the user approves/denies a tool call.
   * Streams the continuation back so main.ts can render it into chat.
   * After streaming completes, records the goal outcome and cleans up.
   *
   * If the goal was executing a plan (planId is set), this method:
   * 1. Completes the current step via runtime.resumeAfterApproval()
   * 2. Resumes the remaining plan steps via planEngine.resumePlan()
   */
  async *resumeGoalAfterApproval(approved: boolean): AsyncGenerator<StreamChunk> {
    if (!this.runtime) throw new Error("AI not initialized");
    if (!this._pendingGoalApproval) throw new Error("No pending goal approval");

    const { goalId, prompt, invoke, mode, planId, runId } = this._pendingGoalApproval;
    this._currentGoalId = goalId;

    try {
      let accumulated = "";
      let toolCallsMade = 0;
      let planTitle: string | undefined;
      let stepsCompleted: number | undefined;
      let totalSteps: number | undefined;

      // Phase 1: Complete the current tool call / step via runtime approval
      for await (const chunk of this.runtime.resumeAfterApproval(approved)) {
        if (chunk.type === "text") {
          accumulated += chunk.text;
        } else if (chunk.type === "tool_status" && chunk.status === "calling") {
          toolCallsMade++;
        }
        yield chunk;
      }

      // Phase 2: If this was a plan-based goal, resume remaining steps
      if (planId != null && planId !== "" && this.planEngine != null) {
        const loopDeps = this.runtime.getLoopDeps();
        if (loopDeps) {
          const planResult = await this.consumePlanStream(
            this.planEngine.resumePlan(planId, loopDeps, undefined, runId),
            { goal_id: goalId, prompt, mode },
            invoke,
          );

          if (planResult.suspended) {
            // Another approval request during plan continuation — stay suspended
            return;
          }

          accumulated += planResult.responseText;
          toolCallsMade += planResult.toolCallsMade;
          planTitle = planResult.planTitle;
          stepsCompleted = planResult.stepsCompleted;
          totalSteps = planResult.totalSteps;
        }
      }

      // Record outcome to DB (use runId as outcome_id for audit correlation)
      const outcomeId = runId ?? crypto.randomUUID();
      const now = Date.now();
      await invoke<number>("db_execute", {
        sql: "UPDATE goals SET last_run_at = ?, consecutive_failures = 0 WHERE goal_id = ?",
        params: [now, goalId],
      });

      await invoke<number>("db_execute", {
        sql: `INSERT INTO goal_outcomes (outcome_id, goal_id, motebit_id, ran_at, status, summary, tool_calls_made, memories_formed, error_message)
              VALUES (?, ?, ?, ?, 'completed', ?, ?, 0, NULL)`,
        params: [outcomeId, goalId, this.motebitId, now, accumulated.slice(0, 500), toolCallsMade],
      });

      // One-shot auto-complete
      if (mode === "once") {
        await invoke<number>("db_execute", {
          sql: "UPDATE goals SET status = 'completed' WHERE goal_id = ?",
          params: [goalId],
        });
      }

      // Notify UI
      this._goalCompleteCallback?.({
        goalId,
        prompt,
        status: "completed",
        summary: accumulated.slice(0, 200),
        error: null,
        planTitle,
        stepsCompleted,
        totalSteps,
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
      if (this._pendingGoalApproval == null || this._pendingGoalApproval.goalId === goalId) {
        this._goalExecuting = false;
        this._currentGoalId = null;
        this._goalStatusCallback?.(false);
        this._pendingGoalApproval = null;
        this.runtime?.resetConversation();
      }
    }
  }

  get isGoalExecuting(): boolean {
    return this._goalExecuting;
  }

  /**
   * Start background goal scheduling. Checks for active goals every 60s and
   * executes them in the background without interrupting the user's chat.
   * Goals are stored in the database as rows in a `goals` table — the desktop
   * reads them via Tauri IPC. If the goals table doesn't exist or has no active
   * goals, the tick is a no-op.
   */
  startGoalScheduler(invoke: InvokeFn): void {
    if (this.goalSchedulerTimer) return;
    this.goalSchedulerTimer = setInterval(() => {
      void this.goalTick(invoke);
    }, 60_000);
    // Run first tick after a short delay (let UI settle)
    setTimeout(() => {
      void this.goalTick(invoke);
    }, 5_000);
  }

  stopGoalScheduler(): void {
    if (this.goalSchedulerTimer) {
      clearInterval(this.goalSchedulerTimer);
      this.goalSchedulerTimer = null;
    }
  }

  private async goalTick(invoke: InvokeFn): Promise<void> {
    if (!this.runtime || this._goalExecuting || this.runtime.isProcessing) return;

    try {
      interface GoalRow {
        goal_id: string;
        motebit_id: string;
        prompt: string;
        interval_ms: number;
        last_run_at: number | null;
        enabled: number;
        status: string;
        mode: string;
        parent_goal_id: string | null;
        max_retries: number;
        consecutive_failures: number;
      }

      interface OutcomeRow {
        ran_at: number;
        status: string;
        summary: string | null;
        error_message: string | null;
      }

      const goals = await invoke<GoalRow[]>("db_query", {
        sql: "SELECT * FROM goals WHERE motebit_id = ? AND enabled = 1 AND status = 'active'",
        params: [this.motebitId],
      });

      if (goals.length === 0) return;

      const now = Date.now();
      for (const goal of goals) {
        const elapsed = goal.last_run_at != null ? now - goal.last_run_at : Infinity;
        if (elapsed < goal.interval_ms) continue;
        if (this.runtime.isProcessing) break;

        this._goalExecuting = true;
        this._currentGoalId = goal.goal_id;
        this._goalStatusCallback?.(true);

        // Generate a stable runId for this goal execution (= outcome_id for audit correlation)
        const runId = crypto.randomUUID();

        try {
          // Build enriched context with previous outcomes
          const outcomes = await invoke<OutcomeRow[]>("db_query", {
            sql: "SELECT ran_at, status, summary, error_message FROM goal_outcomes WHERE goal_id = ? ORDER BY ran_at DESC LIMIT 3",
            params: [goal.goal_id],
          });

          // Use PlanEngine for multi-step execution if available
          // Wall-clock limit: 10 minutes per goal run
          const GOAL_WALL_CLOCK_MS = 10 * 60 * 1000;
          const abortController = new AbortController();
          const deadlineTimer = setTimeout(
            () => abortController.abort(new Error("Goal exceeded 10-minute wall-clock limit")),
            GOAL_WALL_CLOCK_MS,
          );
          let result: Awaited<ReturnType<typeof this.executePlanGoal>>;
          try {
            result = await this.executePlanGoal(
              goal,
              outcomes ?? [],
              invoke,
              runId,
              abortController.signal,
            );
          } finally {
            clearTimeout(deadlineTimer);
          }

          if (result.suspended) {
            // Approval requested — _goalExecuting stays true to block further ticks.
            return;
          }

          // Normal completion: record outcome, update DB (runId = outcome_id for audit correlation)
          await invoke<number>("db_execute", {
            sql: "UPDATE goals SET last_run_at = ?, consecutive_failures = 0 WHERE goal_id = ?",
            params: [now, goal.goal_id],
          });

          await invoke<number>("db_execute", {
            sql: `INSERT INTO goal_outcomes (outcome_id, goal_id, motebit_id, ran_at, status, summary, tool_calls_made, memories_formed, error_message, tokens_used)
                  VALUES (?, ?, ?, ?, 'completed', ?, ?, 0, NULL, ?)`,
            params: [
              runId,
              goal.goal_id,
              this.motebitId,
              now,
              result.responseText.slice(0, 500),
              result.toolCallsMade,
              result.tokensUsed ?? null,
            ],
          });

          // One-shot auto-complete
          if (goal.mode === "once") {
            await invoke<number>("db_execute", {
              sql: "UPDATE goals SET status = 'completed' WHERE goal_id = ?",
              params: [goal.goal_id],
            });
          }

          // Notify UI
          this._goalCompleteCallback?.({
            goalId: goal.goal_id,
            prompt: goal.prompt,
            status: "completed",
            summary: result.responseText.slice(0, 200),
            error: null,
            planTitle: result.planTitle,
            stepsCompleted: result.stepsCompleted,
            totalSteps: result.totalSteps,
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);

          // Record failed outcome (runId = outcome_id for audit correlation)
          await invoke<number>("db_execute", {
            sql: `INSERT INTO goal_outcomes (outcome_id, goal_id, motebit_id, ran_at, status, summary, tool_calls_made, memories_formed, error_message)
                  VALUES (?, ?, ?, ?, 'failed', NULL, 0, 0, ?)`,
            params: [runId, goal.goal_id, this.motebitId, now, msg],
          }).catch(() => {});

          // Increment failures and auto-pause if threshold reached
          await invoke<number>("db_execute", {
            sql: "UPDATE goals SET consecutive_failures = consecutive_failures + 1 WHERE goal_id = ?",
            params: [goal.goal_id],
          }).catch(() => {});

          if (goal.consecutive_failures + 1 >= goal.max_retries) {
            await invoke<number>("db_execute", {
              sql: "UPDATE goals SET status = 'paused' WHERE goal_id = ?",
              params: [goal.goal_id],
            }).catch(() => {});
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
            this._currentGoalId = null;
            this._goalStatusCallback?.(false);
            this.runtime?.resetConversation();
          }
        }
      }
    } catch {
      this._goalExecuting = false;
      this._currentGoalId = null;
      this._goalStatusCallback?.(false);
    }
  }

  /**
   * Execute a goal using PlanEngine for multi-step decomposition.
   * Falls back to single-turn streaming if PlanEngine is unavailable.
   */
  private async executePlanGoal(
    goal: { goal_id: string; prompt: string; mode: string },
    outcomes: Array<{
      ran_at: number;
      status: string;
      summary: string | null;
      error_message: string | null;
    }>,
    invoke: InvokeFn,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<{
    suspended: boolean;
    toolCallsMade: number;
    responseText: string;
    planTitle?: string;
    stepsCompleted?: number;
    totalSteps?: number;
    tokensUsed?: number;
  }> {
    const loopDeps = this.runtime!.getLoopDeps();

    // If PlanEngine or loopDeps are unavailable, fall back to single-turn execution
    if (!this.planEngine || !loopDeps) {
      return this.executeSingleTurnGoal(goal, outcomes, invoke, runId, signal);
    }

    const registry = this.runtime!.getToolRegistry();

    // Pre-load any existing active plan for this goal (async cache warm-up for Tauri)
    if (this.planStoreRef && "preloadForGoal" in this.planStoreRef) {
      await this.planStoreRef.preloadForGoal(goal.goal_id);
    }

    // Check for existing active plan (resume interrupted plan)
    let plan = this.planStoreRef!.getPlanForGoal(goal.goal_id);
    let planStream: AsyncGenerator<PlanChunk>;

    if (plan && plan.status === PlanStatus.Active) {
      planStream = this.planEngine.resumePlan(plan.plan_id, loopDeps, undefined, runId);
    } else {
      const created = await this.planEngine.createPlan(
        goal.goal_id,
        this.motebitId,
        {
          goalPrompt: goal.prompt,
          previousOutcomes: outcomes.map((o) =>
            o.status === "failed"
              ? `failed: ${o.error_message ?? "unknown"}`
              : `${o.status}: ${o.summary ?? "no summary"}`,
          ),
          availableTools: registry.list().map((t) => t.name),
        },
        loopDeps,
      );
      const newPlan = created.plan;
      plan = newPlan;
      if (created.truncatedFrom != null && created.truncatedFrom > 0) {
        // eslint-disable-next-line no-console
        console.warn(
          `Plan truncated from ${created.truncatedFrom} to ${newPlan.total_steps} steps (max ${newPlan.total_steps})`,
        );
      }
      planStream = this.planEngine.executePlan(newPlan.plan_id, loopDeps, undefined, runId);
    }

    return this.consumePlanStream(planStream, goal, invoke, runId, signal);
  }

  /**
   * Fallback: single-turn goal execution (pre-PlanEngine behavior).
   */
  private async executeSingleTurnGoal(
    goal: { goal_id: string; prompt: string; mode: string },
    outcomes: Array<{
      ran_at: number;
      status: string;
      summary: string | null;
      error_message: string | null;
    }>,
    invoke: InvokeFn,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<{
    suspended: boolean;
    toolCallsMade: number;
    responseText: string;
    tokensUsed?: number;
  }> {
    const now = Date.now();
    let context = `You are executing a scheduled goal.\n\nGoal: ${goal.prompt}`;
    if (outcomes.length > 0) {
      context += "\n\nPrevious executions (most recent first):";
      for (const o of outcomes) {
        const ago = formatTimeAgo(now - o.ran_at);
        if (o.status === "failed" && o.error_message != null && o.error_message !== "") {
          context += `\n- ${ago}: failed — [error: ${o.error_message}]`;
        } else if (o.summary != null && o.summary !== "") {
          context += `\n- ${ago}: ${o.status} — "${o.summary.slice(0, 100)}"`;
        } else {
          context += `\n- ${ago}: ${o.status}`;
        }
      }
    }
    if (goal.mode === "once") {
      context += "\n\nThis is a one-time goal. Complete it fully in this execution.";
    }

    let accumulated = "";
    let toolCallsMade = 0;
    let tokensUsed = 0;

    for await (const chunk of this.runtime!.sendMessageStreaming(context, runId)) {
      if (signal?.aborted === true) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Goal aborted");
      }
      if (chunk.type === "text") {
        accumulated += chunk.text;
      } else if (chunk.type === "tool_status" && chunk.status === "calling") {
        toolCallsMade++;
        if (toolCallsMade > MAX_TOOL_CALLS_PER_RUN) {
          throw new Error(`Goal exceeded ${MAX_TOOL_CALLS_PER_RUN} tool calls — run stopped`);
        }
      } else if (
        chunk.type === "result" &&
        chunk.result.totalTokens != null &&
        chunk.result.totalTokens > 0
      ) {
        tokensUsed += chunk.result.totalTokens;
      } else if (chunk.type === "approval_request") {
        this._pendingGoalApproval = {
          goalId: goal.goal_id,
          prompt: goal.prompt,
          invoke,
          mode: goal.mode,
          runId,
        };
        this._goalApprovalCallback?.({
          goalId: goal.goal_id,
          goalPrompt: goal.prompt,
          toolName: chunk.name,
          args: chunk.args,
          riskLevel: chunk.risk_level,
        });
        return {
          suspended: true,
          toolCallsMade,
          responseText: accumulated,
          tokensUsed: tokensUsed > 0 ? tokensUsed : undefined,
        };
      }
    }

    return {
      suspended: false,
      toolCallsMade,
      responseText: accumulated,
      tokensUsed: tokensUsed > 0 ? tokensUsed : undefined,
    };
  }

  /**
   * Consume a PlanEngine stream, forwarding progress to UI callbacks.
   */
  private async consumePlanStream(
    stream: AsyncGenerator<PlanChunk>,
    goal: { goal_id: string; prompt: string; mode: string },
    invoke: InvokeFn,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<{
    suspended: boolean;
    toolCallsMade: number;
    responseText: string;
    planTitle?: string;
    stepsCompleted?: number;
    totalSteps?: number;
    tokensUsed?: number;
  }> {
    let toolCallsMade = 0;
    let responseText = "";
    let tokensUsed = 0;
    let planTitle: string | undefined;
    let totalSteps = 0;
    let stepsCompleted = 0;

    for await (const chunk of stream) {
      if (signal?.aborted === true) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Goal aborted");
      }
      switch (chunk.type) {
        case "plan_created":
          planTitle = chunk.plan.title;
          totalSteps = chunk.steps.length;
          this._goalPlanProgressCallback?.({
            goalId: goal.goal_id,
            planTitle: chunk.plan.title,
            stepIndex: 0,
            totalSteps: chunk.steps.length,
            stepDescription: chunk.steps[0]?.description ?? "",
            type: "plan_created",
          });
          break;

        case "step_started":
          this._goalPlanProgressCallback?.({
            goalId: goal.goal_id,
            planTitle: planTitle ?? "",
            stepIndex: chunk.step.ordinal + 1,
            totalSteps,
            stepDescription: chunk.step.description,
            type: "step_started",
          });
          break;

        case "step_chunk":
          // Forward inner agentic chunks
          if (chunk.chunk.type === "text") {
            responseText += chunk.chunk.text;
          } else if (chunk.chunk.type === "tool_status" && chunk.chunk.status === "calling") {
            toolCallsMade++;
            if (toolCallsMade > MAX_TOOL_CALLS_PER_RUN) {
              throw new Error(`Goal exceeded ${MAX_TOOL_CALLS_PER_RUN} tool calls — run stopped`);
            }
          } else if (
            chunk.chunk.type === "result" &&
            chunk.chunk.result.totalTokens != null &&
            chunk.chunk.result.totalTokens > 0
          ) {
            tokensUsed += chunk.chunk.result.totalTokens;
          }
          break;

        case "step_completed":
          stepsCompleted++;
          this._goalPlanProgressCallback?.({
            goalId: goal.goal_id,
            planTitle: planTitle ?? "",
            stepIndex: chunk.step.ordinal + 1,
            totalSteps,
            stepDescription: chunk.step.description,
            type: "step_completed",
          });
          break;

        case "step_failed":
          this._goalPlanProgressCallback?.({
            goalId: goal.goal_id,
            planTitle: planTitle ?? "",
            stepIndex: chunk.step.ordinal + 1,
            totalSteps,
            stepDescription: chunk.step.description,
            type: "step_failed",
          });
          break;

        case "approval_request": {
          const innerChunk = chunk.chunk;
          if (innerChunk.type !== "approval_request") break;
          this._pendingGoalApproval = {
            goalId: goal.goal_id,
            prompt: goal.prompt,
            invoke,
            mode: goal.mode,
            planId: chunk.step.plan_id,
            runId,
          };
          this._goalApprovalCallback?.({
            goalId: goal.goal_id,
            goalPrompt: goal.prompt,
            toolName: innerChunk.name,
            args: innerChunk.args,
            riskLevel: innerChunk.risk_level,
          });
          return {
            suspended: true,
            toolCallsMade,
            responseText,
            planTitle,
            stepsCompleted,
            totalSteps,
            tokensUsed: tokensUsed > 0 ? tokensUsed : undefined,
          };
        }

        case "plan_completed":
          // Plan finished successfully
          break;

        case "plan_failed":
          // Plan failed — the error will surface through the outer catch
          throw new Error(`Plan failed: ${chunk.reason}`);
      }
    }

    return {
      suspended: false,
      toolCallsMade,
      responseText,
      planTitle,
      stepsCompleted,
      totalSteps,
      tokensUsed: tokensUsed > 0 ? tokensUsed : undefined,
    };
  }

  // === MCP via Tauri Commands ===

  /**
   * Discover and connect MCP tools via Tauri shell commands.
   * Since @motebit/mcp-client uses Node child_process (not available in webview),
   * we spawn the MCP server via Tauri's shell_exec_tool and communicate over stdio.
   *
   * For now, this registers the MCP server config and attempts a dynamic import
   * of @motebit/mcp-client. If that fails (expected in webview), it falls back
   * to a Tauri IPC bridge approach.
   */
  async connectMcpServerViaTauri(
    config: McpServerConfig,
    invoke: InvokeFn,
  ): Promise<McpServerStatus> {
    // First try the existing dynamic import approach (works in Tauri sidecar context)
    try {
      return await this.addMcpServer(config);
    } catch {
      // Dynamic import failed (expected in pure webview) — use Tauri IPC bridge
    }

    // Tauri IPC bridge: spawn MCP server, discover tools, register as proxied tools
    if (config.transport !== "stdio" || config.command == null || config.command === "") {
      this.mcpConfigs.set(config.name, config);
      return {
        name: config.name,
        transport: config.transport,
        trusted: config.trusted ?? false,
        connected: false,
        toolCount: 0,
      };
    }

    try {
      // Discover tools by running the MCP server and listing tools
      // We use shell_exec to start the server with a tools/list request
      const args = config.args ?? [];
      const fullCommand = [config.command, ...args].join(" ");

      // Try to spawn and get tool list via MCP init + tools/list
      // This is a simplified approach — full MCP stdio protocol would need a Rust command
      const initPayload = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "motebit-desktop", version: "0.1.0" },
        },
      });
      const listPayload = JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      });

      // Combine payloads, escape for safe shell interpolation (single quotes → '\'' break-and-rejoin)
      const stdinData = `${initPayload}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n${listPayload}`;
      const escaped = stdinData.replace(/'/g, "'\\''");

      // Send init + initialized notification + tools/list through stdin
      const shellResult = await invoke<{ stdout: string; stderr: string; exit_code: number }>(
        "shell_exec_tool",
        {
          command: `printf '%s' '${escaped}' | ${fullCommand}`,
          cwd: null,
        },
      );

      if (shellResult.exit_code === 0 && shellResult.stdout) {
        // Parse JSON-RPC responses from stdout
        const lines = shellResult.stdout.split("\n").filter((l) => l.trim());
        let toolCount = 0;

        for (const line of lines) {
          try {
            const response = JSON.parse(line) as {
              id?: number;
              result?: {
                tools?: Array<{
                  name: string;
                  description?: string;
                  inputSchema?: Record<string, unknown>;
                }>;
              };
            };
            if (response.id === 2 && response.result?.tools) {
              const tempRegistry = new SimpleToolRegistry();
              for (const mcpTool of response.result.tools) {
                const qualifiedName = `${config.name}__${mcpTool.name}`;
                const definition = {
                  name: qualifiedName,
                  description: `[${config.name}] ${mcpTool.description ?? mcpTool.name}`,
                  inputSchema: mcpTool.inputSchema ?? { type: "object" as const, properties: {} },
                  ...(config.trusted === true ? {} : { requiresApproval: true as const }),
                };

                // Create a handler that calls the tool via Tauri shell
                const toolHandler = this.createMcpToolHandler(config, mcpTool.name, invoke);
                tempRegistry.register(definition, toolHandler);
                toolCount++;
              }

              if (this.runtime) {
                this.runtime.registerExternalTools(`mcp:${config.name}`, tempRegistry);
              }
            }
          } catch {
            // Skip unparseable lines
          }
        }

        this.mcpConfigs.set(config.name, config);
        this.mcpToolCounts.set(config.name, toolCount);
        return {
          name: config.name,
          transport: config.transport,
          trusted: config.trusted ?? false,
          connected: true,
          toolCount,
        };
      }
    } catch {
      // MCP connection failed — store config but mark as disconnected
    }

    this.mcpConfigs.set(config.name, config);
    return {
      name: config.name,
      transport: config.transport,
      trusted: config.trusted ?? false,
      connected: false,
      toolCount: 0,
    };
  }

  /** Create a tool handler that calls an MCP tool by spawning the server via Tauri. */
  private createMcpToolHandler(
    config: McpServerConfig,
    mcpToolName: string,
    invoke: InvokeFn,
  ): (args: Record<string, unknown>) => Promise<{ ok: boolean; data?: unknown; error?: string }> {
    return async (args) => {
      try {
        const fullCommand = [config.command!, ...(config.args ?? [])].join(" ");
        const callPayload = [
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2024-11-05",
              capabilities: {},
              clientInfo: { name: "motebit-desktop", version: "0.1.0" },
            },
          }),
          JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: mcpToolName, arguments: args },
          }),
        ].join("\n");

        const escapedPayload = callPayload.replace(/'/g, "'\\''");
        const result = await invoke<{ stdout: string; stderr: string; exit_code: number }>(
          "shell_exec_tool",
          { command: `printf '%s' '${escapedPayload}' | ${fullCommand}`, cwd: null },
        );

        if (result.stdout) {
          const lines = result.stdout.split("\n").filter((l) => l.trim());
          for (const line of lines) {
            try {
              const response = JSON.parse(line) as {
                id?: number;
                result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
              };
              if (response.id === 2 && response.result) {
                const textContent = (response.result.content ?? [])
                  .filter((c) => c.type === "text")
                  .map((c) => c.text ?? "")
                  .join("\n");
                return {
                  ok: response.result.isError !== true,
                  data: textContent !== "" ? textContent : response.result.content,
                  error: response.result.isError === true ? textContent : undefined,
                };
              }
            } catch {
              /* skip */
            }
          }
        }

        return { ok: false, error: `MCP tool ${mcpToolName} returned no result` };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
      }
    };
  }

  // === Conversation Browsing ===

  /** List recent conversations (async, for UI). Returns empty array if no conversation store. */
  async listConversationsAsync(limit = 20): Promise<
    Array<{
      conversationId: string;
      startedAt: number;
      lastActiveAt: number;
      title: string | null;
      summary: string | null;
      messageCount: number;
    }>
  > {
    if (!this.conversationStoreRef) return [];
    return this.conversationStoreRef.listConversationsAsync(this.motebitId, limit);
  }

  /** Load a past conversation by ID — replaces the current chat. Returns the message list. */
  async loadConversationById(
    conversationId: string,
  ): Promise<Array<{ role: string; content: string }>> {
    if (!this.runtime || !this.conversationStoreRef) return [];

    // Load messages asynchronously into the cache
    await this.conversationStoreRef.loadMessagesAsync(conversationId);

    // Now the sync loadMessages() call inside runtime will work from cache
    this.runtime.loadConversation(conversationId);

    return this.runtime.getConversationHistory();
  }

  /** Start a new conversation (clears current). */
  startNewConversation(): void {
    if (this.runtime) {
      this.runtime.resetConversation();
    }
  }

  /** Get the current conversation ID. */
  get currentConversationId(): string | null {
    return this.runtime?.getConversationId() ?? null;
  }

  /**
   * Get the summary for a specific conversation by ID.
   * Returns null if no summary exists or conversation store is unavailable.
   */
  async getConversationSummary(conversationId: string): Promise<string | null> {
    if (!this.conversationStoreRef) return null;
    const conversations = await this.conversationStoreRef.listConversationsAsync(
      this.motebitId,
      100,
    );
    const conv = conversations.find((c) => c.conversationId === conversationId);
    return conv?.summary ?? null;
  }

  /**
   * Manually trigger summarization of the current conversation.
   * Uses the AI provider via a side-channel call (no conversation pollution).
   * Returns the generated summary, or null if there's nothing to summarize.
   */
  async summarizeConversation(): Promise<string | null> {
    if (!this.runtime || !this.conversationStoreRef) return null;

    const conversationId = this.runtime.getConversationId();
    if (conversationId == null || conversationId === "") return null;

    const history = this.runtime.getConversationHistory();
    if (history.length < 2) return null;

    // Get existing summary if any
    const existingSummary = await this.getConversationSummary(conversationId);

    // Use the ai-core summarizeConversation via generateCompletion (side-channel)
    const formatted = history.map((m) => `${m.role}: ${m.content}`).join("\n");

    const prompt =
      existingSummary != null && existingSummary !== ""
        ? `Update this conversation summary with the new messages.\n\nExisting summary:\n${existingSummary}\n\nNew messages:\n${formatted}\n\nReturn ONLY the updated summary (2-4 sentences). No quotes, no explanation.`
        : `Summarize this conversation in 2-4 concise sentences. Return ONLY the summary, no quotes, no explanation.\n\n${formatted}`;

    const summary = await this.runtime.generateCompletion(prompt);
    const cleaned = summary.trim();

    if (cleaned.length > 0) {
      this.conversationStoreRef.updateSummary(conversationId, cleaned);
      return cleaned;
    }

    return null;
  }

  // === Auto-Title ===

  /**
   * Generate a title for the current conversation when it reaches 4+ messages.
   * Uses the AI provider to produce a short (5-7 word) title from the first messages.
   * Non-blocking, fires in the background.
   */
  async maybeAutoTitle(): Promise<string | null> {
    if (!this.runtime || !this.conversationStoreRef || this._autoTitlePending) return null;

    const conversationId = this.runtime.getConversationId();
    if (conversationId == null || conversationId === "") return null;

    const history = this.runtime.getConversationHistory();
    if (history.length < 4) return null;

    // Check if already titled
    const convos = await this.conversationStoreRef.listConversationsAsync(this.motebitId, 50);
    const current = convos.find((c) => c.conversationId === conversationId);
    if (current?.title != null && current.title !== "") return current.title;

    this._autoTitlePending = true;

    try {
      // Use a focused prompt to generate a short title
      const firstMessages = history
        .slice(0, 6)
        .map((m) => `${m.role}: ${m.content.slice(0, 200)}`)
        .join("\n");
      const titlePrompt = `Generate a very short title (5-7 words max) for this conversation. Return ONLY the title, no quotes, no explanation.\n\n${firstMessages}`;

      const result = await this.runtime.sendMessage(titlePrompt);
      const title = result.response
        .trim()
        .replace(/^["']|["']$/g, "")
        .slice(0, 100);

      if (title && title.length > 0 && title.length < 100) {
        this.conversationStoreRef.updateTitle(conversationId, title);
        // Reset conversation to remove the title generation exchange
        // We actually need a different approach — send via provider directly
        // For now, store the title and don't pollute chat history
        return title;
      }
    } catch {
      // Auto-titling is best-effort
    } finally {
      this._autoTitlePending = false;
    }

    return null;
  }

  /**
   * Generate a title using a lightweight AI call that doesn't affect conversation history.
   * Uses runtime.generateCompletion() (side-channel) so the title prompt never enters
   * the conversation. Falls back to heuristic (first 7 words) if the AI call fails.
   * Called after pushToHistory when message count crosses 4.
   */
  async generateTitleInBackground(): Promise<string | null> {
    if (!this.runtime || !this.conversationStoreRef) return null;

    const conversationId = this.runtime.getConversationId();
    if (conversationId == null || conversationId === "") return null;

    // Check message count
    const count = await this.conversationStoreRef.getMessageCount(conversationId);
    if (count < 4) return null;

    // Check if already titled
    const convos = await this.conversationStoreRef.listConversationsAsync(this.motebitId, 50);
    const current = convos.find((c) => c.conversationId === conversationId);
    if (current?.title != null && current.title !== "") return null; // Already has a title

    if (this._autoTitlePending) return null;
    this._autoTitlePending = true;

    try {
      const history = this.runtime.getConversationHistory();
      const firstMessages = history
        .slice(0, 6)
        .map((m) => `${m.role}: ${m.content.slice(0, 200)}`)
        .join("\n");

      // Try AI-generated title via side-channel (no conversation pollution)
      try {
        const prompt = `Generate a very short title (5-7 words max) for this conversation. Return ONLY the title, no quotes, no explanation.\n\n${firstMessages}`;
        const raw = await this.runtime.generateCompletion(prompt);
        const title = raw
          .trim()
          .replace(/^["']|["']$/g, "")
          .slice(0, 100);
        if (title.length > 0 && title.length < 100) {
          this.conversationStoreRef.updateTitle(conversationId, title);
          return title;
        }
      } catch {
        // AI title generation failed — fall through to heuristic
      }

      // Heuristic fallback: first 7 words of first user message
      const firstUserMsg = history.find((m) => m.role === "user");
      if (firstUserMsg) {
        const words = firstUserMsg.content.split(/\s+/);
        let title = words.slice(0, 7).join(" ");
        if (words.length > 7) title += "...";
        if (title.length > 0) {
          this.conversationStoreRef.updateTitle(conversationId, title);
          return title;
        }
      }
    } catch {
      // Best-effort
    } finally {
      this._autoTitlePending = false;
    }

    return null;
  }

  // === Conversation Sync ===

  /**
   * Sync conversations with the remote relay server.
   * Creates a ConversationSyncEngine that bridges TauriConversationStore to the relay.
   */
  async syncConversations(
    syncUrl: string,
    authToken?: string,
  ): Promise<{
    conversations_pushed: number;
    conversations_pulled: number;
    messages_pushed: number;
    messages_pulled: number;
  }> {
    if (!this.conversationStoreRef) {
      return {
        conversations_pushed: 0,
        conversations_pulled: 0,
        messages_pushed: 0,
        messages_pulled: 0,
      };
    }

    this.emitSyncStatus({ status: "syncing" });

    const storeAdapter = new TauriConversationSyncStoreAdapter(
      this.conversationStoreRef,
      this.motebitId,
    );
    // Pre-fetch local data before sync (async Tauri -> sync adapter bridge)
    await storeAdapter.prefetch(0);

    const syncEngine = new ConversationSyncEngine(storeAdapter, this.motebitId);
    syncEngine.connectRemote(
      new HttpConversationSyncAdapter({
        baseUrl: syncUrl,
        motebitId: this.motebitId,
        authToken,
      }),
    );

    try {
      const result = await syncEngine.sync();

      // Plan sync — push/pull plans for cross-device visibility
      if (this.planStoreRef) {
        const planSyncAdapter = new TauriPlanSyncStoreAdapter(this.planStoreRef, this.motebitId);
        await planSyncAdapter.prefetch(0);
        const planSync = new PlanSyncEngine(planSyncAdapter, this.motebitId);
        planSync.connectRemote(
          new HttpPlanSyncAdapter({ baseUrl: syncUrl, motebitId: this.motebitId, authToken }),
        );
        await planSync.sync();
      }

      this.emitSyncStatus({
        status: "connected",
        lastSyncAt: Date.now(),
        eventsPushed:
          this._lastSyncStatus.eventsPushed + result.conversations_pushed + result.messages_pushed,
        eventsPulled:
          this._lastSyncStatus.eventsPulled + result.conversations_pulled + result.messages_pulled,
      });
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emitSyncStatus({ status: "error", error: msg });
      throw err;
    }
  }

  /**
   * Start full sync: event-level background polling + one-shot conversation sync.
   * Call after pairing completes or at app startup when syncUrl is configured.
   */
  async startSync(invoke: InvokeFn, syncUrl: string, authToken?: string): Promise<void> {
    if (!this.runtime) return;

    this.emitSyncStatus({ status: "connecting", error: null });

    // Get keypair for token creation + encryption key derivation
    const keypair = await this.getDeviceKeypair(invoke);
    if (!keypair) {
      this.emitSyncStatus({ status: "error", error: "No device keypair available" });
      return;
    }

    // Derive private key bytes (hex → Uint8Array)
    const privKeyBytes = new Uint8Array(keypair.privateKey.length / 2);
    for (let i = 0; i < keypair.privateKey.length; i += 2) {
      privKeyBytes[i / 2] = parseInt(keypair.privateKey.slice(i, i + 2), 16);
    }

    // Derive deterministic encryption key from private key, then erase raw bytes
    const encKey = await deriveSyncEncryptionKey(privKeyBytes);
    secureErase(privKeyBytes);

    // Get or create a signed auth token
    let token = authToken;
    if (token == null || token === "") {
      token = await this.createSyncToken(keypair.privateKey);
    }

    // Build adapter stack: HTTP (fallback) → Encrypted HTTP → WS → Encrypted WS
    const httpAdapter = new HttpEventStoreAdapter({
      baseUrl: syncUrl,
      motebitId: this.motebitId,
      authToken: token,
    });
    const encryptedHttp = new EncryptedEventStoreAdapter({ inner: httpAdapter, key: encKey });

    // WebSocket URL: http(s) → ws(s)
    const wsUrl =
      syncUrl.replace(/^https?/, (m) => (m === "https" ? "wss" : "ws")) +
      "/ws/sync/" +
      this.motebitId;

    const localEventStore = this._localEventStore;
    const desktopCapabilities = [
      DeviceCapability.StdioMcp,
      DeviceCapability.HttpMcp,
      DeviceCapability.FileSystem,
      DeviceCapability.Keyring,
      DeviceCapability.Background,
    ];

    const wsAdapter = new WebSocketEventStoreAdapter({
      url: wsUrl,
      motebitId: this.motebitId,
      authToken: token,
      capabilities: desktopCapabilities,
      httpFallback: encryptedHttp,
      localStore: localEventStore ?? undefined,
      onCatchUp: (pulled) => {
        if (pulled > 0) {
          this.emitSyncStatus({
            lastSyncAt: Date.now(),
            eventsPulled: this._lastSyncStatus.eventsPulled + pulled,
          });
        }
      },
    });
    this._wsAdapter = wsAdapter;

    // Encrypted wrapper around WS adapter for outbound events
    const encryptedWs = new EncryptedEventStoreAdapter({ inner: wsAdapter, key: encKey });

    // Inbound real-time events: decrypt and write to local store
    this._wsUnsubOnEvent = wsAdapter.onEvent((raw) => {
      void (async () => {
        if (!localEventStore) return;
        const dec = await decryptEventPayload(raw, encKey);
        await localEventStore.append(dec);
      })();
    });

    // Wire the encrypted WS adapter as the sync remote and start
    this.runtime.connectSync(encryptedWs);
    wsAdapter.connect();

    // Subscribe to SyncEngine status changes
    if (this._syncUnsubscribe) this._syncUnsubscribe();
    this._syncUnsubscribe = this.runtime.sync.onStatusChange((engineStatus: SyncStatus) => {
      if (engineStatus === "syncing") {
        this.emitSyncStatus({ status: "syncing" });
      } else if (engineStatus === "idle") {
        const conflicts = this.runtime?.sync.getConflicts() ?? [];
        this.emitSyncStatus({
          status: conflicts.length > 0 ? "conflict" : "connected",
          lastSyncAt: Date.now(),
          conflictCount: conflicts.length,
        });
      } else if (engineStatus === "error") {
        this.emitSyncStatus({ status: "error", error: "Sync cycle failed" });
      } else if (engineStatus === "offline") {
        this.emitSyncStatus({ status: "disconnected" });
      }
    });

    this.runtime.startSync();
    this.emitSyncStatus({ status: "connected" });

    // Token refresh: rebuild WS connection every 4.5 min (tokens expire at 5 min)
    this._wsTokenRefreshTimer = setInterval(() => {
      void (async () => {
        try {
          wsAdapter.disconnect();
          const freshToken = await this.createSyncToken(keypair.privateKey);
          const freshWs = new WebSocketEventStoreAdapter({
            url: wsUrl,
            motebitId: this.motebitId,
            authToken: freshToken,
            capabilities: desktopCapabilities,
            httpFallback: encryptedHttp,
            localStore: localEventStore ?? undefined,
          });

          // Swap onEvent listener
          if (this._wsUnsubOnEvent) this._wsUnsubOnEvent();
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
          // Token refresh failed — WS will reconnect on its own
        }
      })();
    }, 4.5 * 60_000);

    // One-shot conversation sync (stays HTTP — no WS needed for conversations)
    void this.syncConversations(syncUrl, token)
      .then((result) => {
        this.emitSyncStatus({
          lastSyncAt: Date.now(),
          eventsPushed:
            this._lastSyncStatus.eventsPushed +
            result.conversations_pushed +
            result.messages_pushed,
          eventsPulled:
            this._lastSyncStatus.eventsPulled +
            result.conversations_pulled +
            result.messages_pulled,
        });
      })
      .catch(() => {});
  }

  /**
   * Stop background event sync.
   */
  stopSync(): void {
    if (this._wsTokenRefreshTimer) {
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
    this.runtime?.sync.stop();
    this.emitSyncStatus({ status: "disconnected" });
  }
}

// === Tauri Conversation Sync Store Adapter ===

/**
 * Bridges TauriConversationStore (camelCase, async) to ConversationSyncStoreAdapter (snake_case, sync).
 * Uses blocking-style approach: pre-fetches data before sync cycle.
 */
class TauriConversationSyncStoreAdapter implements ConversationSyncStoreAdapter {
  private _conversations: SyncConversation[] = [];
  private _messages: Map<string, SyncConversationMessage[]> = new Map();

  constructor(
    private store: TauriConversationStore,
    private motebitId: string,
  ) {}

  getConversationsSince(motebitId: string, since: number): SyncConversation[] {
    // Return from pre-fetched data. The sync() call pre-loads before use.
    return this._conversations.filter(
      (c) => c.motebit_id === motebitId && c.last_active_at > since,
    );
  }

  getMessagesSince(conversationId: string, since: number): SyncConversationMessage[] {
    const msgs = this._messages.get(conversationId) ?? [];
    return msgs.filter((m) => m.created_at > since);
  }

  upsertConversation(conv: SyncConversation): void {
    void this.store.upsertConversation(conv);
  }

  upsertMessage(msg: SyncConversationMessage): void {
    void this.store.upsertMessage(msg);
  }

  /** Pre-fetch data from async Tauri store. Must be called before sync(). */
  async prefetch(since: number): Promise<void> {
    const convRows = await this.store.getConversationsSince(this.motebitId, since);
    this._conversations = convRows;
    for (const conv of convRows) {
      const msgRows = await this.store.getMessagesSince(conv.conversation_id, since);
      this._messages.set(conv.conversation_id, msgRows);
    }
  }
}

/**
 * Bridges TauriPlanStore (async, in-memory cache) to PlanSyncStoreAdapter (sync).
 * Pre-fetches plans and steps before sync cycle.
 */
class TauriPlanSyncStoreAdapter implements PlanSyncStoreAdapter {
  private _plans: Plan[] = [];
  private _steps: PlanStep[] = [];

  constructor(
    private store: TauriPlanStore | PlanStoreAdapter,
    private motebitId: string,
  ) {}

  getPlansSince(_motebitId: string, since: number): SyncPlan[] {
    return this._plans
      .filter((p) => p.updated_at > since)
      .map((p) => ({
        plan_id: p.plan_id,
        goal_id: p.goal_id,
        motebit_id: p.motebit_id,
        title: p.title,
        status: p.status,
        created_at: p.created_at,
        updated_at: p.updated_at,
        current_step_index: p.current_step_index,
        total_steps: p.total_steps,
        proposal_id: p.proposal_id ?? null,
        collaborative: p.collaborative ? 1 : 0,
      }));
  }

  getStepsSince(_motebitId: string, since: number): SyncPlanStep[] {
    return this._steps
      .filter((s) => s.updated_at > since)
      .map((s) => ({
        step_id: s.step_id,
        plan_id: s.plan_id,
        motebit_id: this.motebitId,
        ordinal: s.ordinal,
        description: s.description,
        prompt: s.prompt,
        depends_on: JSON.stringify(s.depends_on),
        optional: s.optional,
        status: s.status,
        required_capabilities:
          s.required_capabilities != null ? JSON.stringify(s.required_capabilities) : null,
        delegation_task_id: s.delegation_task_id ?? null,
        assigned_motebit_id: s.assigned_motebit_id ?? null,
        result_summary: s.result_summary,
        error_message: s.error_message,
        tool_calls_made: s.tool_calls_made,
        started_at: s.started_at,
        completed_at: s.completed_at,
        retry_count: s.retry_count,
        updated_at: s.updated_at,
      }));
  }

  upsertPlan(plan: SyncPlan): void {
    const existing = this.store.getPlan(plan.plan_id);
    if (!existing || plan.updated_at >= existing.updated_at) {
      this.store.savePlan({
        plan_id: plan.plan_id,
        goal_id: plan.goal_id,
        motebit_id: plan.motebit_id,
        title: plan.title,
        status: plan.status,
        created_at: plan.created_at,
        updated_at: plan.updated_at,
        current_step_index: plan.current_step_index,
        total_steps: plan.total_steps,
        proposal_id: plan.proposal_id ?? undefined,
        collaborative: plan.collaborative === 1,
      });
    }
  }

  upsertStep(step: SyncPlanStep): void {
    const existing = this.store.getStep(step.step_id);
    if (existing) {
      const STATUS_ORDER: Record<string, number> = {
        pending: 0,
        running: 1,
        completed: 2,
        failed: 2,
        skipped: 2,
      };
      const incomingOrder = STATUS_ORDER[step.status] ?? 0;
      const existingOrder = STATUS_ORDER[existing.status] ?? 0;
      if (incomingOrder < existingOrder) return;
    }
    this.store.saveStep({
      step_id: step.step_id,
      plan_id: step.plan_id,
      ordinal: step.ordinal,
      description: step.description,
      prompt: step.prompt,
      depends_on:
        typeof step.depends_on === "string" ? (JSON.parse(step.depends_on) as string[]) : [],
      optional: step.optional,
      status: step.status,
      required_capabilities:
        step.required_capabilities != null
          ? (JSON.parse(step.required_capabilities) as PlanStep["required_capabilities"])
          : undefined,
      delegation_task_id: step.delegation_task_id ?? undefined,
      assigned_motebit_id: step.assigned_motebit_id ?? undefined,
      result_summary: step.result_summary,
      error_message: step.error_message,
      tool_calls_made: step.tool_calls_made,
      started_at: step.started_at,
      completed_at: step.completed_at,
      retry_count: step.retry_count,
      updated_at: step.updated_at,
    });
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- implements async interface
  async prefetch(_since: number): Promise<void> {
    if ("listAllPlans" in this.store && typeof this.store.listAllPlans === "function") {
      this._plans = this.store.listAllPlans(this.motebitId);
    } else if (
      "listActivePlans" in this.store &&
      typeof this.store.listActivePlans === "function"
    ) {
      this._plans = this.store.listActivePlans(this.motebitId);
    }
    const allSteps: PlanStep[] = [];
    for (const plan of this._plans) {
      allSteps.push(...this.store.getStepsForPlan(plan.plan_id));
    }
    this._steps = allSteps;
  }
}

// === Helpers ===

function formatTimeAgo(ms: number): string {
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
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
