import type { MotebitState, BehaviorCues, ConversationMessage, ToolRegistry } from "@motebit/sdk";
import { EventType, SensitivityLevel } from "@motebit/sdk";
import { EventStore, InMemoryEventStore } from "@motebit/event-log";
import type { EventStoreAdapter } from "@motebit/event-log";
import { MemoryGraph, InMemoryMemoryStorage, embedText, computeDecayedConfidence } from "@motebit/memory-graph";
import type { MemoryStorageAdapter } from "@motebit/memory-graph";
import { StateVectorEngine } from "@motebit/state-vector";
import { BehaviorEngine } from "@motebit/behavior-engine";
import { IdentityManager, InMemoryIdentityStorage } from "@motebit/core-identity";
import type { IdentityStorage } from "@motebit/core-identity";
import { PrivacyLayer, InMemoryAuditLog } from "@motebit/privacy-layer";
import type { AuditLogAdapter } from "@motebit/privacy-layer";
import { SyncEngine } from "@motebit/sync-engine";
import type { RenderSpec } from "@motebit/sdk";
import { CANONICAL_SPEC } from "@motebit/render-engine/spec";
import type { RenderAdapter, RenderFrame, InteriorColor, AudioReactivity } from "@motebit/render-engine/spec";
import {
  runTurn,
  runTurnStreaming,
  extractStateTags,
  extractActions,
  actionsToStateUpdates,
  getImpulsesForAction,
  trimConversation,
  summarizeConversation,
  shouldSummarize,
  reflect as aiReflect,
} from "@motebit/ai-core";
import type {
  StreamingProvider,
  MotebitLoopDependencies,
  TurnResult,
  AgenticChunk,
  ContextBudget,
  ReflectionResult,
} from "@motebit/ai-core";
// Node-only packages (@motebit/tools, @motebit/mcp-client) are imported dynamically
// to avoid bundling node:child_process / stdio into browser builds (desktop app).
type McpClientAdapter = { disconnect(): Promise<void> };
import { PlanEngine, InMemoryPlanStore } from "@motebit/planner";
import type { PlanChunk } from "@motebit/planner";
import type { PlanStoreAdapter } from "@motebit/planner";
import { PolicyGate, MemoryGovernor } from "@motebit/policy";
import type { PolicyConfig, MemoryGovernanceConfig, AuditLogSink } from "@motebit/policy";

// Re-export key types for consumers
export type { TurnResult, AgenticChunk, ReflectionResult, MotebitLoopDependencies } from "@motebit/ai-core";
export type { StreamingProvider } from "@motebit/ai-core";
export type { MotebitState, BehaviorCues, ToolRegistry, ConversationMessage } from "@motebit/sdk";
export type { EventStoreAdapter } from "@motebit/event-log";
export type { MemoryStorageAdapter } from "@motebit/memory-graph";
export type { IdentityStorage } from "@motebit/core-identity";
export type { AuditLogAdapter } from "@motebit/privacy-layer";
export type { DeletionCertificate } from "@motebit/crypto";
export type { RenderAdapter, RenderFrame, InteriorColor, AudioReactivity } from "@motebit/render-engine/spec";
export type { RenderSpec } from "@motebit/sdk";
export { PolicyGate } from "@motebit/policy";
export type { PolicyConfig, MemoryGovernanceConfig, AuditLogSink } from "@motebit/policy";
export type { PlanChunk } from "@motebit/planner";
export type { PlanStoreAdapter } from "@motebit/planner";

// === McpServerConfig (inlined to avoid importing Node-only @motebit/mcp-client) ===

export interface McpServerConfig {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  /** When false (default), all tools from this server require user approval. */
  trusted?: boolean;
  /** Origin of this config entry (e.g. "Claude Desktop", "Claude Code", "VS Code"). */
  source?: string;
  /** Set to true after user confirms spawning a command-based discovered server. */
  spawnApproved?: boolean;
  /** SHA-256 hash of the tool manifest, set on first connect. */
  toolManifestHash?: string;
  /** Tool names from the last pinned manifest, used for diffing on change. */
  pinnedToolNames?: string[];
}

// === Browser-safe Tool Registry ===
// Inlined so @motebit/tools (which pulls in node:child_process via builtins) is never eagerly imported.

import type { ToolDefinition, ToolResult, ToolHandler } from "@motebit/sdk";

class SimpleToolRegistry implements ToolRegistry {
  private tools = new Map<string, { definition: ToolDefinition; handler: ToolHandler }>();

  register(tool: ToolDefinition, handler: ToolHandler): void {
    if (this.tools.has(tool.name)) throw new Error(`Tool "${tool.name}" already registered`);
    this.tools.set(tool.name, { definition: tool, handler });
  }

  list(): ToolDefinition[] { return [...this.tools.values()].map((t) => t.definition); }
  has(name: string): boolean { return this.tools.has(name); }
  get(name: string): ToolDefinition | undefined { return this.tools.get(name)?.definition; }

  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const entry = this.tools.get(name);
    if (!entry) return { ok: false, error: `Unknown tool: ${name}` };
    try { return await entry.handler(args); }
    catch (err: unknown) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  }

  merge(other: ToolRegistry): void {
    for (const def of other.list()) {
      if (!this.tools.has(def.name)) {
        this.tools.set(def.name, { definition: def, handler: (args) => other.execute(def.name, args) });
      }
    }
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get size(): number { return this.tools.size; }
}

export { SimpleToolRegistry };

// === Platform Adapter Interfaces ===

// === Conversation Store Adapter ===

export interface ConversationStoreAdapter {
  createConversation(motebitId: string): string;
  appendMessage(conversationId: string, motebitId: string, msg: {
    role: string;
    content: string;
    toolCalls?: string;
    toolCallId?: string;
  }): void;
  loadMessages(conversationId: string, limit?: number): Array<{
    messageId: string;
    conversationId: string;
    motebitId: string;
    role: string;
    content: string;
    toolCalls: string | null;
    toolCallId: string | null;
    createdAt: number;
    tokenEstimate: number;
  }>;
  getActiveConversation(motebitId: string): {
    conversationId: string;
    startedAt: number;
    lastActiveAt: number;
    summary: string | null;
  } | null;
  updateSummary(conversationId: string, summary: string): void;
  updateTitle(conversationId: string, title: string): void;
  listConversations(motebitId: string, limit?: number): Array<{
    conversationId: string;
    startedAt: number;
    lastActiveAt: number;
    title: string | null;
    messageCount: number;
  }>;
}

export interface StateSnapshotAdapter {
  saveState(motebitId: string, stateJson: string, versionClock?: number): void;
  loadState(motebitId: string): string | null;
  /** Version clock at last snapshot — used to determine what's safe to compact. */
  getSnapshotClock?(motebitId: string): number;
}

export interface KeyringAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface StorageAdapters {
  eventStore: EventStoreAdapter;
  memoryStorage: MemoryStorageAdapter;
  identityStorage: IdentityStorage;
  auditLog: AuditLogAdapter;
  stateSnapshot?: StateSnapshotAdapter;
  toolAuditSink?: AuditLogSink;
  conversationStore?: ConversationStoreAdapter;
  planStore?: PlanStoreAdapter;
}

export interface PlatformAdapters {
  storage: StorageAdapters;
  renderer: RenderAdapter;
  ai?: StreamingProvider;
  keyring?: KeyringAdapter;
  tools?: ToolRegistry;
}

// === Null Renderer (for CLI / headless) ===

export class NullRenderer implements RenderAdapter {
  init(_target: unknown): Promise<void> { return Promise.resolve(); }
  render(_frame: RenderFrame): void {}
  getSpec(): RenderSpec { return CANONICAL_SPEC; }
  resize(_w: number, _h: number): void {}
  setBackground(_color: number | null): void {}
  setDarkEnvironment(): void {}
  setLightEnvironment(): void {}
  setInteriorColor(_color: InteriorColor): void {}
  setAudioReactivity(_energy: AudioReactivity | null): void {}
  setTrustMode(_mode: import("@motebit/sdk").TrustMode): void {}
  setListeningIndicator(_active: boolean): void {}
  dispose(): void {}
}

// === Runtime Configuration ===

export interface RuntimeConfig {
  motebitId: string;
  tickRateHz?: number;
  maxConversationHistory?: number;
  /** Compact events when count exceeds this threshold (0 = disabled, default 1000) */
  compactionThreshold?: number;
  /** MCP servers to connect to on init. Tools are discovered and merged into the registry. */
  mcpServers?: McpServerConfig[];
  /** Policy configuration. Controls operator mode, budgets, allow/deny lists. */
  policy?: Partial<PolicyConfig>;
  /** Memory governance config. Controls what gets saved, secret rejection. */
  memoryGovernance?: Partial<MemoryGovernanceConfig>;
  /** Summarize conversation after this many messages (0 = disabled, default 20). */
  summarizeAfterMessages?: number;
  /** Auto-deny pending tool approvals after this many ms (0 = disabled, default 600000 = 10 min). */
  approvalTimeoutMs?: number;
}

// === Stream Chunk ===

export type StreamChunk =
  | { type: "text"; text: string }
  | { type: "tool_status"; name: string; status: "calling" | "done"; result?: unknown }
  | { type: "approval_request"; tool_call_id: string; name: string; args: Record<string, unknown>; risk_level?: number }
  | { type: "injection_warning"; tool_name: string; patterns: string[] }
  | { type: "approval_expired"; tool_name: string }
  | { type: "result"; result: TurnResult };

// === Operator Mode Result ===

export interface OperatorModeResult {
  success: boolean;
  needsSetup?: boolean;
  error?: string;
  /** If locked out, the timestamp (ms) when the lockout expires. */
  lockedUntil?: number;
}

const OPERATOR_PIN_KEY = "operator_pin_hash";
const OPERATOR_PIN_ATTEMPTS_KEY = "operator_pin_attempts";
const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCKOUT_BASE_MS = 30_000; // 30 seconds

interface PinAttemptState {
  /** Number of consecutive failed attempts. */
  count: number;
  /** Timestamp (ms) of the last failed attempt. */
  lastFailedAt: number;
}

function pinLockoutMs(attempts: number): number {
  if (attempts < MAX_PIN_ATTEMPTS) return 0;
  // Exponential backoff: 30s, 5m, 30m, capped at 30m
  const exponent = attempts - MAX_PIN_ATTEMPTS;
  return Math.min(PIN_LOCKOUT_BASE_MS * Math.pow(10, exponent), 30 * 60_000);
}

async function hashPin(pin: string): Promise<string> {
  const data = new TextEncoder().encode(pin);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// === In-Memory Storage Factory ===

export function createInMemoryStorage(): StorageAdapters {
  return {
    eventStore: new InMemoryEventStore(),
    memoryStorage: new InMemoryMemoryStorage(),
    identityStorage: new InMemoryIdentityStorage(),
    auditLog: new InMemoryAuditLog(),
  };
}

// === MotebitRuntime ===

export class MotebitRuntime {
  readonly motebitId: string;
  readonly state: StateVectorEngine;
  readonly behavior: BehaviorEngine;
  readonly events: EventStore;
  readonly memory: MemoryGraph;
  readonly identity: IdentityManager;
  readonly privacy: PrivacyLayer;
  readonly auditLog: AuditLogAdapter;
  readonly sync: SyncEngine;
  policy: PolicyGate;
  memoryGovernor: MemoryGovernor;

  private renderer: RenderAdapter;
  private provider: StreamingProvider | null;
  private loopDeps: MotebitLoopDependencies | null = null;
  private conversationHistory: ConversationMessage[] = [];
  private maxHistory: number;
  private _isProcessing = false;
  private latestCues: BehaviorCues = {
    hover_distance: 0.4,
    drift_amplitude: 0.02,
    glow_intensity: 0.3,
    eye_dilation: 0.3,
    smile_curvature: 0,
    speaking_activity: 0,
  };
  private stateSnapshot?: StateSnapshotAdapter;
  private compactionThreshold: number;
  private lastKnownClock = 0;
  private running = false;
  private toolRegistry: SimpleToolRegistry;
  private mcpAdapters: McpClientAdapter[] = [];
  private mcpConfigs: McpServerConfig[];
  private keyring: KeyringAdapter | null;
  private toolAuditSink?: AuditLogSink;
  private conversationStore: ConversationStoreAdapter | null;
  private conversationId: string | null = null;
  private externalToolSources = new Map<string, string[]>();
  private summarizeAfterMessages: number;
  private planStore: PlanStoreAdapter;
  private planEngine: PlanEngine;
  private _pendingApproval: {
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    userMessage: string;
    runId?: string;
  } | null = null;
  private approvalTimeoutMs: number;
  private approvalTimer: ReturnType<typeof setTimeout> | null = null;
  private approvalExpiredCallback: (() => void) | null = null;
  private sessionInfo: { continued: boolean; lastActiveAt: number } | null = null;

  constructor(config: RuntimeConfig, adapters: PlatformAdapters) {
    this.motebitId = config.motebitId;
    this.maxHistory = config.maxConversationHistory ?? 40;
    this.compactionThreshold = config.compactionThreshold ?? 1000;
    this.mcpConfigs = config.mcpServers ?? [];
    this.summarizeAfterMessages = config.summarizeAfterMessages ?? 20;
    this.approvalTimeoutMs = config.approvalTimeoutMs ?? 600_000; // 10 min default
    this.renderer = adapters.renderer;
    this.provider = adapters.ai ?? null;
    this.stateSnapshot = adapters.storage.stateSnapshot;
    this.keyring = adapters.keyring ?? null;

    // Tool registry: merge platform-provided tools if any
    this.toolRegistry = new SimpleToolRegistry();
    if (adapters.tools) {
      this.toolRegistry.merge(adapters.tools);
    }

    // Core engines
    this.state = new StateVectorEngine({ tick_rate_hz: config.tickRateHz ?? 2 });
    this.behavior = new BehaviorEngine();

    // Data stores
    this.events = new EventStore(adapters.storage.eventStore);
    this.memory = new MemoryGraph(
      adapters.storage.memoryStorage,
      this.events,
      this.motebitId,
    );
    this.identity = new IdentityManager(
      adapters.storage.identityStorage,
      this.events,
    );
    this.auditLog = adapters.storage.auditLog;
    this.privacy = new PrivacyLayer(
      adapters.storage.memoryStorage,
      this.memory,
      this.events,
      adapters.storage.auditLog,
      this.motebitId,
    );
    this.sync = new SyncEngine(
      adapters.storage.eventStore,
      this.motebitId,
    );

    // State -> cue computation
    this.state.subscribe((state: MotebitState) => {
      this.latestCues = this.behavior.compute(state);
    });

    // Policy & memory governance
    this.toolAuditSink = adapters.storage.toolAuditSink;
    this.policy = new PolicyGate(config.policy, this.toolAuditSink);
    this.memoryGovernor = new MemoryGovernor(config.memoryGovernance);

    // Restore saved state
    if (this.stateSnapshot) {
      const saved = this.stateSnapshot.loadState(this.motebitId);
      if (saved != null && saved !== "") {
        this.state.deserialize(saved);
      }
    }

    // Conversation persistence — resume active conversation if within window
    this.conversationStore = adapters.storage.conversationStore ?? null;
    if (this.conversationStore) {
      const active = this.conversationStore.getActiveConversation(this.motebitId);
      if (active) {
        this.conversationId = active.conversationId;
        const messages = this.conversationStore.loadMessages(active.conversationId);
        for (const msg of messages) {
          if (msg.role === "user" || msg.role === "assistant") {
            this.conversationHistory.push({
              role: msg.role,
              content: msg.content,
            });
          }
        }
        // Mark as continued session so the LLM knows it's resuming
        if (this.conversationHistory.length > 0) {
          this.sessionInfo = { continued: true, lastActiveAt: active.lastActiveAt };
        }
      }
    }

    // Plan-execute engine
    this.planStore = adapters.storage.planStore ?? new InMemoryPlanStore();
    this.planEngine = new PlanEngine(this.planStore);

    this.wireLoopDeps();
  }

  // === Lifecycle ===

  async init(target?: unknown): Promise<void> {
    await this.renderer.init(target);

    // Connect to MCP servers and discover their tools (dynamic import — Node-only)
    if (this.mcpConfigs.length > 0) {
      const { connectMcpServers } = await import("@motebit/mcp-client");
      this.mcpAdapters = await connectMcpServers(this.mcpConfigs, this.toolRegistry as never);
      this.wireLoopDeps(); // re-wire with updated registry
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.state.start();
  }

  stop(): void {
    if (!this.running) return;
    this.sync.stop();
    this.state.stop();
    // Snapshot synchronously, compact in background
    if (this.stateSnapshot) {
      const clock = this.lastKnownClock;
      this.stateSnapshot.saveState(this.motebitId, this.state.serialize(), clock);
    }
    void this.autoCompact();
    void this.housekeeping();
    // Disconnect MCP servers in background
    void Promise.allSettled(this.mcpAdapters.map((a) => a.disconnect()));
    this.renderer.dispose();
    this.running = false;
  }

  get isRunning(): boolean {
    return this.running;
  }

  // === AI ===

  get isAIReady(): boolean {
    return this.loopDeps !== null;
  }

  get isProcessing(): boolean {
    return this._isProcessing;
  }

  get currentModel(): string | null {
    return this.provider?.model ?? null;
  }

  setModel(model: string): void {
    if (!this.provider) throw new Error("No AI provider configured");
    this.provider.setModel(model);
  }

  setProvider(provider: StreamingProvider): void {
    this.provider = provider;
    this.wireLoopDeps();
  }

  /** Access the tool registry to register additional tools at runtime. */
  getToolRegistry(): SimpleToolRegistry {
    return this.toolRegistry;
  }

  /** Access the loop dependencies for direct use by PlanEngine. */
  getLoopDeps(): MotebitLoopDependencies | null {
    return this.loopDeps;
  }

  /**
   * Create and execute a plan for a goal prompt.
   * Decomposes the goal into steps, then executes each step sequentially,
   * streaming PlanChunk events for progress tracking.
   */
  async *executePlan(goalId: string, goalPrompt: string, runId?: string): AsyncGenerator<PlanChunk> {
    if (!this.loopDeps) throw new Error("AI not initialized — call setProvider() first");

    const availableTools = this.toolRegistry.size > 0
      ? this.toolRegistry.list().map((t) => t.name)
      : undefined;

    const { plan } = await this.planEngine.createPlan(
      goalId,
      this.motebitId,
      { goalPrompt, availableTools },
      this.loopDeps,
    );

    yield* this.planEngine.executePlan(plan.plan_id, this.loopDeps, undefined, runId);
  }

  /**
   * Resume an existing plan that was paused (e.g. waiting for approval).
   * Streams PlanChunk events starting from where the plan left off.
   */
  async *resumePlan(planId: string, runId?: string): AsyncGenerator<PlanChunk> {
    if (!this.loopDeps) throw new Error("AI not initialized — call setProvider() first");
    yield* this.planEngine.resumePlan(planId, this.loopDeps, undefined, runId);
  }

  get isOperatorMode(): boolean {
    return this.policy.operatorMode;
  }

  /**
   * Enable/disable operator mode with PIN authentication.
   * Disabling never requires a PIN (safe direction).
   * If no keyring is available, falls through (dev mode).
   * Rate-limited: after 5 failed attempts, exponential lockout (30s → 5m → 30m).
   */
  async setOperatorMode(enabled: boolean, pin?: string): Promise<OperatorModeResult> {
    // Disabling is always allowed (safe direction)
    if (!enabled) {
      this.policy.setOperatorMode(false);
      this.wireLoopDeps();
      return { success: true };
    }

    // No keyring → fall through (non-Tauri dev mode)
    if (!this.keyring) {
      this.policy.setOperatorMode(true);
      this.wireLoopDeps();
      return { success: true };
    }

    // Check if PIN is set up
    const storedHash = await this.keyring.get(OPERATOR_PIN_KEY);
    if (storedHash == null || storedHash === "") {
      return { success: false, needsSetup: true };
    }

    // PIN is required
    if (pin == null || pin === "") {
      return { success: false, error: "PIN required" };
    }

    // Check rate limiting
    const attemptState = await this.getPinAttemptState();
    const lockoutMs = pinLockoutMs(attemptState.count);
    if (lockoutMs > 0) {
      const lockedUntil = attemptState.lastFailedAt + lockoutMs;
      if (Date.now() < lockedUntil) {
        return { success: false, error: "Too many failed attempts", lockedUntil };
      }
    }

    const inputHash = await hashPin(pin);
    if (inputHash !== storedHash) {
      await this.recordPinFailure(attemptState);
      return { success: false, error: "Incorrect PIN" };
    }

    // Success — reset attempt counter
    await this.clearPinAttempts();
    this.policy.setOperatorMode(true);
    this.wireLoopDeps();
    return { success: true };
  }

  private async getPinAttemptState(): Promise<PinAttemptState> {
    if (!this.keyring) return { count: 0, lastFailedAt: 0 };
    const raw = await this.keyring.get(OPERATOR_PIN_ATTEMPTS_KEY);
    if (raw == null || raw === "") return { count: 0, lastFailedAt: 0 };
    try {
      return JSON.parse(raw) as PinAttemptState;
    } catch {
      return { count: 0, lastFailedAt: 0 };
    }
  }

  private async recordPinFailure(prev: PinAttemptState): Promise<void> {
    if (!this.keyring) return;
    const state: PinAttemptState = { count: prev.count + 1, lastFailedAt: Date.now() };
    await this.keyring.set(OPERATOR_PIN_ATTEMPTS_KEY, JSON.stringify(state));
  }

  private async clearPinAttempts(): Promise<void> {
    if (!this.keyring) return;
    await this.keyring.delete(OPERATOR_PIN_ATTEMPTS_KEY);
  }

  /**
   * Set up the operator mode PIN (first-time only, or reset).
   * PIN must be 4-6 digits.
   */
  async setupOperatorPin(pin: string): Promise<void> {
    if (!this.keyring) throw new Error("Keyring not available");
    if (!/^\d{4,6}$/.test(pin)) throw new Error("PIN must be 4-6 digits");
    const hashed = await hashPin(pin);
    await this.keyring.set(OPERATOR_PIN_KEY, hashed);
  }

  /**
   * Reset the operator PIN — clears the keyring hash and disables operator mode.
   */
  async resetOperatorPin(): Promise<void> {
    if (!this.keyring) throw new Error("Keyring not available");
    await this.keyring.delete(OPERATOR_PIN_KEY);
    await this.clearPinAttempts();
    this.policy.setOperatorMode(false);
    this.wireLoopDeps();
  }

  /**
   * Replace the PolicyGate with a new instance built from the given config.
   * Immutable swap — no mutation of the existing PolicyGate.
   */
  updatePolicyConfig(config: Partial<PolicyConfig>): void {
    this.policy = new PolicyGate(config, this.toolAuditSink);
    this.wireLoopDeps();
  }

  /**
   * Replace the MemoryGovernor with a new instance built from the given config.
   * Immutable swap — no mutation of the existing MemoryGovernor.
   */
  updateMemoryGovernance(config: Partial<MemoryGovernanceConfig>): void {
    this.memoryGovernor = new MemoryGovernor(config);
    this.wireLoopDeps();
  }

  /**
   * Register external tools under a source ID (e.g. "mcp:filesystem").
   * Merges tools from the given registry, tracking names for bulk unregister.
   */
  registerExternalTools(sourceId: string, registry: ToolRegistry): void {
    const names: string[] = [];
    for (const def of registry.list()) {
      if (!this.toolRegistry.has(def.name)) {
        this.toolRegistry.register(def, (args) => registry.execute(def.name, args));
        names.push(def.name);
      }
    }
    this.externalToolSources.set(sourceId, names);
    this.wireLoopDeps();
  }

  /**
   * Remove all tools registered under a source ID.
   */
  unregisterExternalTools(sourceId: string): void {
    const names = this.externalToolSources.get(sourceId);
    if (names) {
      for (const name of names) {
        this.toolRegistry.unregister(name);
      }
      this.externalToolSources.delete(sourceId);
      this.wireLoopDeps();
    }
  }

  async sendMessage(text: string, runId?: string): Promise<TurnResult> {
    if (!this.loopDeps) throw new Error("AI not initialized — call setProvider() first");
    if (this._isProcessing) throw new Error("Already processing a message");

    this._isProcessing = true;
    this.state.pushUpdate({ processing: 0.9, attention: 0.8 });

    try {
      const trimmed = this.trimHistory();
      const result = await runTurn(this.loopDeps, text, {
        conversationHistory: trimmed,
        previousCues: this.latestCues,
        runId,
        sessionInfo: this.sessionInfo ?? undefined,
      });
      this.pushToHistory(text, result.response);
      // Session info applies only to the first message after resume
      this.sessionInfo = null;
      return result;
    } finally {
      this.state.pushUpdate({ processing: 0.1, attention: 0.3 });
      this._isProcessing = false;
    }
  }

  async *sendMessageStreaming(text: string, runId?: string): AsyncGenerator<StreamChunk> {
    if (!this.loopDeps) throw new Error("AI not initialized — call setProvider() first");
    if (this._isProcessing) throw new Error("Already processing a message");

    this._isProcessing = true;
    this._pendingApproval = null;
    this.state.pushUpdate({ processing: 0.9, attention: 0.8 });
    this.behavior.setSpeaking(true);

    try {
      const trimmed = this.trimHistory();
      const stream = runTurnStreaming(this.loopDeps, text, {
        conversationHistory: trimmed,
        previousCues: this.latestCues,
        runId,
        sessionInfo: this.sessionInfo ?? undefined,
      });
      // Session info applies only to the first message after resume
      this.sessionInfo = null;
      yield* this.processStream(stream, text, runId);
    } finally {
      this.behavior.setSpeaking(false);
      this.state.pushUpdate({ processing: 0.1, attention: 0.3 });
      this._isProcessing = false;
    }
  }

  /**
   * Resume after a tool approval decision. Executes the tool deterministically
   * (no LLM re-prompting) and continues the agentic loop with the result.
   */
  async *resumeAfterApproval(approved: boolean): AsyncGenerator<StreamChunk> {
    if (!this._pendingApproval) throw new Error("No pending approval to resume");
    if (!this.loopDeps) throw new Error("AI not initialized");

    this.clearApprovalTimeout();
    const pending = this._pendingApproval;
    this._pendingApproval = null;
    this._isProcessing = true;
    this.state.pushUpdate({ processing: 0.9, attention: 0.8 });
    this.behavior.setSpeaking(true);

    try {
      if (approved) {
        // Execute the tool directly
        yield { type: "tool_status" as const, name: pending.toolName, status: "calling" as const };
        const result = await this.toolRegistry.execute(pending.toolName, pending.args);

        // Sanitize through policy if available
        let sanitized: ToolResult = result;
        if (typeof this.policy.sanitizeAndCheck === "function") {
          const check = this.policy.sanitizeAndCheck(result, pending.toolName);
          sanitized = check.result;
          if (check.injectionDetected) {
            yield { type: "injection_warning" as const, tool_name: pending.toolName, patterns: check.injectionPatterns };
          }
        } else if (typeof this.policy.sanitizeResult === "function") {
          sanitized = this.policy.sanitizeResult(result, pending.toolName);
        }

        yield { type: "tool_status" as const, name: pending.toolName, status: "done" as const, result: sanitized.data ?? sanitized.error };
        void this.logToolUsed(pending.toolName, sanitized.data ?? sanitized.error);

        // Push tool call + result into conversation history for continuation
        this.conversationHistory.push(
          { role: "assistant" as const, content: `[tool_use: ${pending.toolName}(${JSON.stringify(pending.args)})]` },
          { role: "user" as const, content: `[tool_result: ${JSON.stringify(sanitized)}]` },
        );
      } else {
        // Push denial into conversation history
        this.conversationHistory.push(
          { role: "assistant" as const, content: `[tool_use: ${pending.toolName}(${JSON.stringify(pending.args)})]` },
          { role: "user" as const, content: `[tool_result: {"ok":false,"error":"User denied this tool call."}]` },
        );
      }

      // Run continuation turn with updated history
      const stream = runTurnStreaming(this.loopDeps, pending.userMessage, {
        conversationHistory: this.conversationHistory,
        previousCues: this.latestCues,
        runId: pending.runId,
      });
      yield* this.processStream(stream, pending.userMessage, pending.runId);
    } finally {
      this.behavior.setSpeaking(false);
      this.state.pushUpdate({ processing: 0.1, attention: 0.3 });
      this._isProcessing = false;
    }
  }

  get hasPendingApproval(): boolean {
    return this._pendingApproval !== null;
  }

  get pendingApprovalInfo(): { toolName: string; args: Record<string, unknown> } | null {
    if (!this._pendingApproval) return null;
    return { toolName: this._pendingApproval.toolName, args: this._pendingApproval.args };
  }

  /**
   * Register a callback invoked when a pending approval expires.
   * Apps should use this to auto-deny and update UI (e.g. dismiss dialog, show toast).
   */
  onApprovalExpired(cb: () => void): void {
    this.approvalExpiredCallback = cb;
  }

  private startApprovalTimeout(): void {
    this.clearApprovalTimeout();
    if (this.approvalTimeoutMs <= 0) return;
    this.approvalTimer = setTimeout(() => {
      if (!this._pendingApproval) return;
      const expired = this._pendingApproval;
      this._pendingApproval = null;
      // Push denial into conversation history so LLM sees it on next turn
      this.conversationHistory.push(
        { role: "assistant" as const, content: `[tool_use: ${expired.toolName}(${JSON.stringify(expired.args)})]` },
        { role: "user" as const, content: `[tool_result: {"ok":false,"error":"Approval timed out after ${this.approvalTimeoutMs}ms"}]` },
      );
      this.state.pushUpdate({ processing: 0.1, attention: 0.3 });
      this._isProcessing = false;
      this.approvalExpiredCallback?.();
    }, this.approvalTimeoutMs);
  }

  private clearApprovalTimeout(): void {
    if (this.approvalTimer) {
      clearTimeout(this.approvalTimer);
      this.approvalTimer = null;
    }
  }

  /** Shared stream processing — extracts state tags, actions, handles tool/approval/injection chunks. */
  private async *processStream(
    stream: AsyncGenerator<AgenticChunk>,
    userMessage: string,
    runId?: string,
  ): AsyncGenerator<StreamChunk> {
    let result: TurnResult | null = null;
    let accumulated = "";
    const appliedActions = new Set<string>();

    for await (const chunk of stream) {
      if (chunk.type === "text") {
        accumulated += chunk.text;

        const stateUpdates = extractStateTags(accumulated);
        if (Object.keys(stateUpdates).length > 0) {
          this.state.pushUpdate(stateUpdates);
        }

        const actions = extractActions(accumulated);
        const newActions = actions.filter((a) => !appliedActions.has(a));
        if (newActions.length > 0) {
          for (const a of newActions) appliedActions.add(a);
          const actionDeltas = actionsToStateUpdates(newActions);
          if (Object.keys(actionDeltas).length > 0) {
            const current = this.state.getState();
            const absolute: Record<string, number> = {};
            for (const [field, delta] of Object.entries(actionDeltas)) {
              const base = (current as unknown as Record<string, unknown>)[field];
              absolute[field] = (typeof base === "number" ? base : 0) + (delta as number);
            }
            this.state.pushUpdate(absolute as Partial<MotebitState>);
          }
          // Inject impulses for immediate visual pop
          for (const action of newActions) {
            const impulses = getImpulsesForAction(action);
            for (const imp of impulses) {
              this.behavior.injectImpulse(imp.field, imp.magnitude, imp.halfLife);
            }
          }
        }
      }

      // Creature reacts to tool activity
      if (chunk.type === "tool_status") {
        if (chunk.status === "calling") {
          this.state.pushUpdate({ processing: 0.95, attention: 0.9, curiosity: 0.7 });
        } else if (chunk.status === "done") {
          this.state.pushUpdate({ processing: 0.6, confidence: 0.7 });
          void this.logToolUsed(chunk.name, chunk.result);
        }
      }

      // Approval request: capture pending state and start timeout
      if (chunk.type === "approval_request") {
        this._pendingApproval = {
          toolCallId: chunk.tool_call_id,
          toolName: chunk.name,
          args: chunk.args,
          userMessage,
          runId,
        };
        this.startApprovalTimeout();
        this.state.pushUpdate({ processing: 0.5, attention: 0.95, affect_arousal: 0.2 });
      }

      // Injection warning
      if (chunk.type === "injection_warning") {
        this.state.pushUpdate({ confidence: 0.4, affect_valence: -0.2, attention: 0.95 });
      }

      yield chunk;
      if (chunk.type === "result") result = chunk.result;
    }

    if (result) {
      this.pushToHistory(userMessage, result.response);
    }
  }

  resetConversation(): void {
    // Trigger reflection on previous conversation before clearing (background)
    if (this.provider && this.conversationHistory.length > 0) {
      void this.runReflection();
    }
    this.conversationHistory = [];
    this.conversationId = null;
  }

  /**
   * Trigger a reflection on the current conversation.
   * The agent reviews its performance, learns insights, and stores them as memories.
   * Returns the reflection result for display (e.g. in the CLI).
   */
  async reflect(goals?: Array<{ description: string; status: string }>): Promise<ReflectionResult> {
    if (!this.provider) throw new Error("No AI provider configured");

    const summary = this.conversationId != null && this.conversationId !== "" && this.conversationStore != null
      ? this.conversationStore.getActiveConversation(this.motebitId)?.summary ?? null
      : null;

    const recentMemories = await this.memory.exportAll();
    const memories = recentMemories.nodes
      .slice(0, 10)
      .map((n) => ({ content: n.content }));

    const result = await aiReflect(
      summary,
      this.conversationHistory,
      goals ?? [],
      memories,
      this.provider,
    );

    // Store insights and plan adjustments as memories
    await this.storeReflectionInsights(result);

    // Audit: log that reflection occurred
    void this.logReflectionCompleted(result);

    return result;
  }

  private async runReflection(): Promise<void> {
    try {
      await this.reflect();
    } catch {
      // Reflection is best-effort — don't crash the runtime
    }
  }

  private async storeReflectionInsights(result: ReflectionResult): Promise<void> {
    for (const insight of result.insights) {
      try {
        const embedding = await embedText(`[reflection] ${insight}`);
        await this.memory.formMemory(
          {
            content: `[reflection] ${insight}`,
            confidence: 0.7,
            sensitivity: SensitivityLevel.None,
          },
          embedding,
        );
        // Memory formed — brief confidence + warmth spike visible through glass
        const cur = this.state.getState();
        this.state.pushUpdate({
          confidence: Math.min(1, cur.confidence + 0.2),
          affect_valence: Math.min(1, cur.affect_valence + 0.15),
        });
      } catch {
        // Memory formation is best-effort during reflection
      }
    }

    // Store plan adjustments as memories — behavioral learnings for future planning
    for (const adjustment of result.planAdjustments) {
      try {
        const embedding = await embedText(`[plan_adjustment] ${adjustment}`);
        await this.memory.formMemory(
          {
            content: `[plan_adjustment] ${adjustment}`,
            confidence: 0.6,
            sensitivity: SensitivityLevel.None,
          },
          embedding,
        );
      } catch {
        // Memory formation is best-effort during reflection
      }
    }
  }

  private async logReflectionCompleted(result: ReflectionResult): Promise<void> {
    try {
      const clock = await this.events.getLatestClock(this.motebitId);
      await this.events.append({
        event_id: crypto.randomUUID(),
        motebit_id: this.motebitId,
        timestamp: Date.now(),
        event_type: EventType.ReflectionCompleted,
        payload: {
          source: "runtime_reflect",
          insights_count: result.insights.length,
          adjustments_count: result.planAdjustments.length,
          self_assessment_preview: result.selfAssessment.slice(0, 100),
        },
        version_clock: clock + 1,
        tombstoned: false,
      });
    } catch {
      // Audit logging is best-effort
    }
  }

  /**
   * Generate a completion from the AI provider without affecting conversation
   * history or state. Useful for housekeeping tasks (title generation,
   * classification, summarization) that should not appear in the chat.
   */
  async generateCompletion(prompt: string): Promise<string> {
    if (!this.provider) throw new Error("No AI provider configured");

    const contextPack = {
      recent_events: [],
      relevant_memories: [],
      current_state: this.state.getState(),
      user_message: prompt,
    };

    const response = await this.provider.generate(contextPack);

    // Audit: log housekeeping run without affecting user-facing state
    void this.logHousekeepingRun(prompt, response.text);

    return response.text;
  }

  private async logHousekeepingRun(prompt: string, result: string): Promise<void> {
    try {
      const clock = await this.events.getLatestClock(this.motebitId);
      await this.events.append({
        event_id: crypto.randomUUID(),
        motebit_id: this.motebitId,
        timestamp: Date.now(),
        event_type: EventType.HousekeepingRun,
        payload: {
          prompt_preview: prompt.slice(0, 100),
          result_preview: result.slice(0, 100),
        },
        version_clock: clock + 1,
        tombstoned: false,
      });
    } catch {
      // Audit logging is best-effort
    }
  }

  getConversationHistory(): ConversationMessage[] {
    return [...this.conversationHistory];
  }

  getConversationId(): string | null {
    return this.conversationId;
  }

  /** Load a specific past conversation by ID, replacing current history. */
  loadConversation(conversationId: string): void {
    if (!this.conversationStore) return;
    const messages = this.conversationStore.loadMessages(conversationId);
    this.conversationHistory = [];
    for (const msg of messages) {
      if (msg.role === "user" || msg.role === "assistant") {
        this.conversationHistory.push({
          role: msg.role,
          content: msg.content,
        });
      }
    }
    this.conversationId = conversationId;
  }

  /** List recent conversations (for UI/CLI). */
  listConversations(limit?: number): Array<{
    conversationId: string;
    startedAt: number;
    lastActiveAt: number;
    title: string | null;
    messageCount: number;
  }> {
    if (!this.conversationStore) return [];
    return this.conversationStore.listConversations(this.motebitId, limit);
  }

  /** Generate a title for the current conversation via AI, with heuristic fallback. */
  async autoTitle(): Promise<string | null> {
    if (this.conversationStore == null || this.conversationId == null || this.conversationId === "") return null;
    const convos = this.conversationStore.listConversations(this.motebitId, 100);
    const current = convos.find(c => c.conversationId === this.conversationId);
    if (current?.title != null && current.title !== "") return null; // already titled

    const history = this.getConversationHistory();
    if (history.length < 4) return null;

    if (this.provider) {
      try {
        const snippet = history.slice(0, 6).map(m => `${m.role}: ${m.content.slice(0, 200)}`).join("\n");
        const prompt = `Generate a very short title (5-7 words max) for this conversation. Return ONLY the title, no quotes, no explanation.\n\n${snippet}`;
        const raw = await this.generateCompletion(prompt);
        const title = raw.trim().replace(/^["']|["']$/g, "").slice(0, 100);
        if (title.length > 0 && title.length < 100) {
          this.conversationStore.updateTitle(this.conversationId, title);
          return title;
        }
      } catch {
        // Fall through to heuristic
      }
    }

    // Heuristic fallback: first 7 words of first user message
    const first = history.find(m => m.role === "user");
    if (first) {
      const words = first.content.split(/\s+/);
      let title = words.slice(0, 7).join(" ");
      if (words.length > 7) title += "...";
      if (title.length > 0) {
        this.conversationStore.updateTitle(this.conversationId, title);
        return title;
      }
    }
    return null;
  }

  /** Manually trigger summarization of the current conversation. */
  async summarizeCurrentConversation(): Promise<string | null> {
    if (this.provider == null || this.conversationStore == null || this.conversationId == null || this.conversationId === "") return null;
    const history = this.getConversationHistory();
    if (history.length < 2) return null;
    const existingSummary = this.conversationStore.getActiveConversation(this.motebitId)?.summary ?? null;
    const summary = await summarizeConversation(history, existingSummary, this.provider);
    if (summary && this.conversationId) {
      this.conversationStore.updateSummary(this.conversationId, summary);
    }
    return summary;
  }

  // === Rendering ===

  renderFrame(deltaTime: number, time: number): void {
    this.renderer.render({
      cues: this.latestCues,
      delta_time: deltaTime,
      time,
    });
  }

  resize(width: number, height: number): void {
    this.renderer.resize(width, height);
  }

  // === Observability ===

  getState(): MotebitState {
    return this.state.getState();
  }

  getCues(): BehaviorCues {
    return { ...this.latestCues };
  }

  subscribe(fn: (state: MotebitState) => void): () => void {
    return this.state.subscribe(fn);
  }

  /**
   * Push a partial state update into the state vector.
   * Values are EMA-smoothed by the tick loop — not applied instantly.
   * Use for external signals (presence state, sensor input) that should
   * blend with AI-driven state updates.
   */
  pushStateUpdate(partial: Partial<MotebitState>): void {
    this.state.pushUpdate(partial);
  }

  // === Sync ===

  connectSync(remoteStore: EventStoreAdapter): void {
    this.sync.connectRemote(remoteStore);
  }

  startSync(): void {
    this.sync.start();
  }

  // === Compaction ===

  /**
   * Manually compact the event log, deleting events older than the last snapshot.
   * Returns the number of events deleted.
   */
  async compact(): Promise<number> {
    if (this.compactionThreshold === 0) return 0;

    const eventCount = await this.events.countEvents(this.motebitId);
    if (eventCount < 0 || eventCount < this.compactionThreshold) return 0;

    // Ensure we have a snapshot before compacting
    const clock = await this.events.getLatestClock(this.motebitId);
    if (clock === 0) return 0;

    // Save state snapshot at current clock
    if (this.stateSnapshot) {
      this.stateSnapshot.saveState(this.motebitId, this.state.serialize(), clock);
    }

    // Delete events up to (but not including) the latest clock
    // Keep the most recent event so replay can continue from it
    return this.events.compact(this.motebitId, clock - 1);
  }

  // === Internal ===

  private async autoCompact(): Promise<void> {
    if (this.compactionThreshold <= 0) return;
    try {
      const count = await this.events.countEvents(this.motebitId);
      if (count >= this.compactionThreshold) {
        const clock = await this.events.getLatestClock(this.motebitId);
        if (clock > 0) {
          await this.events.compact(this.motebitId, clock - 1);
        }
      }
    } catch {
      // Compaction is best-effort — don't crash the runtime
    }
  }

  /**
   * Prune decayed and retention-expired memories.
   * Tombstones memories where:
   *   1. Decayed confidence falls below memoryGovernor.persistenceThreshold
   *   2. Age exceeds the sensitivity-level retention period
   * Pinned memories are always preserved.
   */
  async housekeeping(): Promise<void> {
    try {
      const { nodes } = await this.memory.exportAll();
      const now = Date.now();
      const threshold = this.memoryGovernor.getConfig().persistenceThreshold;
      const MS_PER_DAY = 24 * 60 * 60 * 1000;
      let tombstonedDecay = 0;
      let tombstonedRetention = 0;
      let skippedPinned = 0;

      for (const node of nodes) {
        // Skip already tombstoned
        if (node.tombstoned) continue;

        // Never touch pinned memories
        if (node.pinned) {
          skippedPinned++;
          continue;
        }

        // Check retention period by sensitivity level
        const retention = this.privacy.getRetentionRules(node.sensitivity);
        if (retention.max_retention_days !== Infinity) {
          const ageMs = now - node.created_at;
          const maxMs = retention.max_retention_days * MS_PER_DAY;
          if (ageMs > maxMs) {
            await this.memory.deleteMemory(node.node_id);
            tombstonedRetention++;
            continue;
          }
        }

        // Check decayed confidence against persistence threshold
        const elapsed = now - node.created_at;
        const decayed = computeDecayedConfidence(node.confidence, node.half_life, elapsed);
        if (decayed < threshold) {
          await this.memory.deleteMemory(node.node_id);
          tombstonedDecay++;
        }
      }

      // Log housekeeping run
      const clock = await this.events.getLatestClock(this.motebitId);
      await this.events.append({
        event_id: crypto.randomUUID(),
        motebit_id: this.motebitId,
        timestamp: now,
        event_type: EventType.HousekeepingRun,
        payload: {
          source: "memory_housekeeping",
          total_memories: nodes.length,
          tombstoned_decay: tombstonedDecay,
          tombstoned_retention: tombstonedRetention,
          skipped_pinned: skippedPinned,
        },
        version_clock: clock + 1,
        tombstoned: false,
      });
    } catch {
      // Housekeeping is best-effort — don't crash the runtime
    }
  }

  private wireLoopDeps(): void {
    if (this.provider) {
      this.loopDeps = {
        motebitId: this.motebitId,
        eventStore: this.events,
        memoryGraph: this.memory,
        stateEngine: this.state,
        behaviorEngine: this.behavior,
        provider: this.provider,
        tools: this.toolRegistry.size > 0 ? this.toolRegistry : undefined,
        policyGate: this.policy,
        memoryGovernor: this.memoryGovernor,
      };
    }
  }

  /** Default context window budget — conservative to fit most models. */
  private static readonly CONVERSATION_BUDGET: ContextBudget = {
    maxTokens: 8000,
    reserveForResponse: 1024,
  };

  /** Trim conversation history to fit within token budget. In-memory history stays complete. */
  private trimHistory(): ConversationMessage[] {
    const summary = this.conversationId != null && this.conversationId !== "" && this.conversationStore != null
      ? this.conversationStore.getActiveConversation(this.motebitId)?.summary ?? null
      : null;
    return trimConversation(
      this.conversationHistory,
      MotebitRuntime.CONVERSATION_BUDGET,
      summary,
    );
  }

  private pushToHistory(userMessage: string, assistantResponse: string): void {
    this.conversationHistory.push(
      { role: "user", content: userMessage },
      { role: "assistant", content: assistantResponse },
    );
    if (this.conversationHistory.length > this.maxHistory) {
      this.conversationHistory = this.conversationHistory.slice(-this.maxHistory);
    }

    // Persist to conversation store
    if (this.conversationStore != null) {
      if (this.conversationId == null || this.conversationId === "") {
        this.conversationId = this.conversationStore.createConversation(this.motebitId);
      }
      this.conversationStore.appendMessage(this.conversationId, this.motebitId, {
        role: "user",
        content: userMessage,
      });
      this.conversationStore.appendMessage(this.conversationId, this.motebitId, {
        role: "assistant",
        content: assistantResponse,
      });
    }

    // Trigger background summarization at message-count intervals
    if (
      this.provider &&
      this.conversationStore != null &&
      this.conversationId != null && this.conversationId !== "" &&
      shouldSummarize(this.conversationHistory.length, this.summarizeAfterMessages)
    ) {
      void this.runSummarization();
    }
  }

  private async runSummarization(): Promise<void> {
    if (this.provider == null || this.conversationStore == null || this.conversationId == null || this.conversationId === "") return;
    try {
      const existingSummary = this.conversationStore
        .getActiveConversation(this.motebitId)?.summary ?? null;
      const summary = await summarizeConversation(
        this.conversationHistory,
        existingSummary,
        this.provider,
      );
      if (summary && this.conversationId) {
        this.conversationStore.updateSummary(this.conversationId, summary);
      }
    } catch {
      // Summarization is best-effort — don't crash the runtime
    }
  }

  private async logToolUsed(toolName: string, result: unknown): Promise<void> {
    try {
      const clock = await this.events.getLatestClock(this.motebitId);
      await this.events.append({
        event_id: crypto.randomUUID(),
        motebit_id: this.motebitId,
        timestamp: Date.now(),
        event_type: EventType.ToolUsed,
        payload: { tool: toolName, result_summary: String(result).slice(0, 500) },
        version_clock: clock + 1,
        tombstoned: false,
      });
    } catch {
      // Tool event logging is best-effort
    }
  }
}
