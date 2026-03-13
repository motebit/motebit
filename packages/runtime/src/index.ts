import type {
  MotebitState,
  BehaviorCues,
  ConversationMessage,
  ToolRegistry,
  AgentTask,
  ExecutionReceipt,
  AgentTrustRecord,
  GoalExecutionManifest,
  ExecutionTimelineEntry,
  ExecutionStepSummary,
  DelegationReceiptSummary,
  ToolAuditEntry,
} from "@motebit/sdk";
import { EventType, SensitivityLevel, AgentTrustLevel } from "@motebit/sdk";
import { EventStore, InMemoryEventStore } from "@motebit/event-log";
import type { EventStoreAdapter } from "@motebit/event-log";
import {
  MemoryGraph,
  InMemoryMemoryStorage,
  embedText,
  computeDecayedConfidence,
  buildConsolidationPrompt,
  parseConsolidationResponse,
  clusterBySimilarity,
  findCuriosityTargets,
} from "@motebit/memory-graph";
import type { ConsolidationProvider, CuriosityTarget } from "@motebit/memory-graph";
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
import type {
  RenderAdapter,
  RenderFrame,
  InteriorColor,
  AudioReactivity,
} from "@motebit/render-engine/spec";
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
  TaskRouter,
  withTaskConfig,
} from "@motebit/ai-core";
import type {
  StreamingProvider,
  MotebitLoopDependencies,
  TurnResult,
  AgenticChunk,
  ContextBudget,
  ReflectionResult,
  TaskRouterConfig,
  TaskType,
} from "@motebit/ai-core";
// Node-only packages (@motebit/tools, @motebit/mcp-client) are imported dynamically
// to avoid bundling node:child_process / stdio into browser builds (desktop app).
type McpClientAdapter = {
  disconnect(): Promise<void>;
  getAndResetDelegationReceipts?(): import("@motebit/sdk").ExecutionReceipt[];
  isMotebit?: boolean;
  motebitType?: "personal" | "service" | "collaborative";
  serverName?: string;
  getTools?(): import("@motebit/sdk").ToolDefinition[];
};
import { PlanEngine, InMemoryPlanStore } from "@motebit/planner";
import type { PlanChunk, StepDelegationAdapter } from "@motebit/planner";
import type { PlanStoreAdapter } from "@motebit/planner";
import type { DeviceCapability } from "@motebit/sdk";
import { PolicyGate, MemoryGovernor, MemoryClass } from "@motebit/policy";
import type { PolicyConfig, MemoryGovernanceConfig, AuditLogSink } from "@motebit/policy";
import { computeGradient, InMemoryGradientStore } from "./gradient.js";
import type { GradientSnapshot, GradientStoreAdapter, BehavioralStats } from "./gradient.js";

// Re-export key types for consumers
export type {
  TurnResult,
  AgenticChunk,
  ReflectionResult,
  MotebitLoopDependencies,
} from "@motebit/ai-core";
export type { StreamingProvider } from "@motebit/ai-core";
export type { TaskRouterConfig, TaskType, ResolvedTaskConfig } from "@motebit/ai-core";
export type {
  MotebitState,
  BehaviorCues,
  ToolRegistry,
  ConversationMessage,
  AgentTrustRecord,
} from "@motebit/sdk";
export { AgentTrustLevel } from "@motebit/sdk";
export type { EventStoreAdapter } from "@motebit/event-log";
export type { MemoryStorageAdapter, CuriosityTarget } from "@motebit/memory-graph";
export type { IdentityStorage } from "@motebit/core-identity";
export type { AuditLogAdapter } from "@motebit/privacy-layer";
export type { DeletionCertificate } from "@motebit/crypto";
export type {
  RenderAdapter,
  RenderFrame,
  InteriorColor,
  AudioReactivity,
} from "@motebit/render-engine/spec";
export type { RenderSpec } from "@motebit/sdk";
export { PolicyGate } from "@motebit/policy";
export type { PolicyConfig, MemoryGovernanceConfig, AuditLogSink } from "@motebit/policy";
export type { GoalExecutionManifest, ExecutionTimelineEntry, ExecutionStepSummary, DelegationReceiptSummary } from "@motebit/sdk";
export type { PlanChunk, StepDelegationAdapter } from "@motebit/planner";
export type { PlanStoreAdapter } from "@motebit/planner";
export { RelayDelegationAdapter } from "@motebit/planner";
export type { RelayDelegationConfig } from "@motebit/planner";
export type { GradientSnapshot, GradientStoreAdapter, GradientConfig, BehavioralStats } from "./gradient.js";
export { computeGradient, InMemoryGradientStore } from "./gradient.js";

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
  /** This server is a motebit — verify identity on connect. */
  motebit?: boolean;
  /** Type of the remote motebit — determines default trust and policy behavior. */
  motebitType?: "personal" | "service" | "collaborative";
  /** Pinned public key hex (set on first verified connect). */
  motebitPublicKey?: string;
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

  list(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => t.definition);
  }
  has(name: string): boolean {
    return this.tools.has(name);
  }
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)?.definition;
  }

  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const entry = this.tools.get(name);
    if (!entry) return { ok: false, error: `Unknown tool: ${name}` };
    try {
      return await entry.handler(args);
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  merge(other: ToolRegistry): void {
    for (const def of other.list()) {
      if (!this.tools.has(def.name)) {
        this.tools.set(def.name, {
          definition: def,
          handler: (args) => other.execute(def.name, args),
        });
      }
    }
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get size(): number {
    return this.tools.size;
  }
}

export { SimpleToolRegistry };

// === Platform Adapter Interfaces ===

// === Conversation Store Adapter ===

export interface ConversationStoreAdapter {
  createConversation(motebitId: string): string;
  appendMessage(
    conversationId: string,
    motebitId: string,
    msg: {
      role: string;
      content: string;
      toolCalls?: string;
      toolCallId?: string;
    },
  ): void;
  loadMessages(
    conversationId: string,
    limit?: number,
  ): Array<{
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
  listConversations(
    motebitId: string,
    limit?: number,
  ): Array<{
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

export interface AgentTrustStoreAdapter {
  getAgentTrust(motebitId: string, remoteMotebitId: string): Promise<AgentTrustRecord | null>;
  setAgentTrust(record: AgentTrustRecord): Promise<void>;
  listAgentTrust(motebitId: string): Promise<AgentTrustRecord[]>;
  updateTrustLevel(
    motebitId: string,
    remoteMotebitId: string,
    level: AgentTrustLevel,
  ): Promise<void>;
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
  gradientStore?: GradientStoreAdapter;
  agentTrustStore?: AgentTrustStoreAdapter;
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
  init(_target: unknown): Promise<void> {
    return Promise.resolve();
  }
  render(_frame: RenderFrame): void {}
  getSpec(): RenderSpec {
    return CANONICAL_SPEC;
  }
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
  /** Task router config for routing housekeeping tasks to cheaper/faster models. */
  taskRouter?: TaskRouterConfig;
  /** Enable episodic memory consolidation during housekeeping. Default false. */
  episodicConsolidation?: boolean;
}

// === Stream Chunk ===

export type StreamChunk =
  | { type: "text"; text: string }
  | { type: "tool_status"; name: string; status: "calling" | "done"; result?: unknown }
  | {
      type: "approval_request";
      tool_call_id: string;
      name: string;
      args: Record<string, unknown>;
      risk_level?: number;
    }
  | { type: "injection_warning"; tool_name: string; patterns: string[] }
  | { type: "approval_expired"; tool_name: string }
  | { type: "result"; result: TurnResult }
  | { type: "task_result"; receipt: ExecutionReceipt }
  | { type: "delegation_start"; server: string; tool: string; motebit_id?: string }
  | {
      type: "delegation_complete";
      server: string;
      tool: string;
      receipt?: { task_id: string; status: string; tools_used: string[] };
    };

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

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hashPin(pin: string, existingSalt?: string): Promise<string> {
  const salt = existingSalt
    ? new Uint8Array(existingSalt.match(/.{2}/g)!.map((h) => parseInt(h, 16)))
    : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return `${toHex(salt.buffer)}:${toHex(derived)}`;
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

// === Canonical JSON (deterministic serialization for hashing) ===

function canonicalJson(obj: unknown): string {
  if (obj === null || obj === undefined) return JSON.stringify(obj);
  if (typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return "[" + obj.map((item) => canonicalJson(item)).join(",") + "]";
  }
  const sorted = Object.keys(obj as Record<string, unknown>).sort();
  const entries = sorted.map(
    (key) => JSON.stringify(key) + ":" + canonicalJson((obj as Record<string, unknown>)[key]),
  );
  return "{" + entries.join(",") + "}";
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
  /** Maps tool names to motebit server names (only for motebit MCP adapters). */
  private motebitToolServers = new Map<string, string>();
  private keyring: KeyringAdapter | null;
  private toolAuditSink?: AuditLogSink;
  private conversationStore: ConversationStoreAdapter | null;
  private conversationId: string | null = null;
  private externalToolSources = new Map<string, string[]>();
  private summarizeAfterMessages: number;
  private planStore: PlanStoreAdapter;
  private planEngine: PlanEngine;
  private _localCapabilities: DeviceCapability[] = [];
  private _pendingApproval: {
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    userMessage: string;
    runId?: string;
  } | null = null;
  private approvalTimeoutMs: number;
  private taskRouter: TaskRouter | null;
  private approvalTimer: ReturnType<typeof setTimeout> | null = null;
  private approvalExpiredCallback: (() => void) | null = null;
  private sessionInfo: { continued: boolean; lastActiveAt: number } | null = null;
  private episodicConsolidation: boolean;
  private gradientStore: GradientStoreAdapter;
  private _behavioralStats: BehavioralStats = {
    turnCount: 0,
    totalIterations: 0,
    toolCallsSucceeded: 0,
    toolCallsBlocked: 0,
    toolCallsFailed: 0,
  };
  private agentTrustStore: AgentTrustStoreAdapter | null;
  private _curiosityTargets: CuriosityTarget[] = [];

  constructor(config: RuntimeConfig, adapters: PlatformAdapters) {
    this.motebitId = config.motebitId;
    this.maxHistory = config.maxConversationHistory ?? 40;
    this.compactionThreshold = config.compactionThreshold ?? 1000;
    this.mcpConfigs = config.mcpServers ?? [];
    this.summarizeAfterMessages = config.summarizeAfterMessages ?? 20;
    this.approvalTimeoutMs = config.approvalTimeoutMs ?? 600_000; // 10 min default
    this.taskRouter = config.taskRouter ? new TaskRouter(config.taskRouter) : null;
    this.episodicConsolidation = config.episodicConsolidation ?? false;
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
    this.memory = new MemoryGraph(adapters.storage.memoryStorage, this.events, this.motebitId);
    this.identity = new IdentityManager(adapters.storage.identityStorage, this.events);
    this.auditLog = adapters.storage.auditLog;
    this.privacy = new PrivacyLayer(
      adapters.storage.memoryStorage,
      this.memory,
      this.events,
      adapters.storage.auditLog,
      this.motebitId,
    );
    this.sync = new SyncEngine(adapters.storage.eventStore, this.motebitId);

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

    // Intelligence gradient
    this.gradientStore = adapters.storage.gradientStore ?? new InMemoryGradientStore();

    // Agent trust
    this.agentTrustStore = adapters.storage.agentTrustStore ?? null;

    this.wireLoopDeps();
  }

  // === Lifecycle ===

  async init(target?: unknown): Promise<void> {
    await this.renderer.init(target);

    // Connect to MCP servers and discover their tools (dynamic import — Node-only)
    if (this.mcpConfigs.length > 0) {
      const { connectMcpServers } = await import("@motebit/mcp-client");
      this.mcpAdapters = await connectMcpServers(this.mcpConfigs, this.toolRegistry as never);

      // Build motebit tool-to-server mapping for delegation visibility
      for (const adapter of this.mcpAdapters) {
        if (adapter.isMotebit && adapter.serverName && adapter.getTools) {
          const serverName = adapter.serverName;
          for (const tool of adapter.getTools()) {
            this.motebitToolServers.set(tool.name, serverName);
          }
        }
      }

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

  setLocalCapabilities(caps: DeviceCapability[]): void {
    this._localCapabilities = caps;
    this.planEngine.setLocalCapabilities(caps);
  }

  setDelegationAdapter(adapter: StepDelegationAdapter): void {
    this.planEngine.setDelegationAdapter(adapter);
  }

  /**
   * Create and execute a plan for a goal prompt.
   * Decomposes the goal into steps, then executes each step sequentially,
   * streaming PlanChunk events for progress tracking.
   */
  async *executePlan(
    goalId: string,
    goalPrompt: string,
    runId?: string,
  ): AsyncGenerator<PlanChunk> {
    if (!this.loopDeps) throw new Error("AI not initialized — call setProvider() first");

    const availableTools =
      this.toolRegistry.size > 0 ? this.toolRegistry.list().map((t) => t.name) : undefined;

    const { plan } = await this.planEngine.createPlan(
      goalId,
      this.motebitId,
      {
        goalPrompt,
        availableTools,
        localCapabilities: this._localCapabilities.length > 0 ? this._localCapabilities : undefined,
      },
      this.loopDeps,
    );

    for await (const chunk of this.planEngine.executePlan(plan.plan_id, this.loopDeps, undefined, runId)) {
      this._logPlanChunkEvent(chunk, goalId);
      yield chunk;
    }
  }

  /**
   * Resume an existing plan that was paused (e.g. waiting for approval).
   * Streams PlanChunk events starting from where the plan left off.
   */
  async *resumePlan(planId: string, runId?: string): AsyncGenerator<PlanChunk> {
    if (!this.loopDeps) throw new Error("AI not initialized — call setProvider() first");
    const plan = this.planStore.getPlan(planId);
    const goalId = plan?.goal_id;
    for await (const chunk of this.planEngine.resumePlan(planId, this.loopDeps, undefined, runId)) {
      this._logPlanChunkEvent(chunk, goalId);
      yield chunk;
    }
  }

  /**
   * Recover delegated steps that were orphaned (e.g. tab closed during delegation).
   * Polls relay for results and resumes plans where possible.
   */
  async *recoverDelegatedSteps(): AsyncGenerator<PlanChunk> {
    if (!this.loopDeps) return;
    for await (const chunk of this.planEngine.recoverDelegatedSteps(this.motebitId, this.loopDeps)) {
      this._logPlanChunkEvent(chunk);
      yield chunk;
    }
  }

  /**
   * Log plan lifecycle events centrally so all consumers (CLI, desktop, mobile, web)
   * get audit history without duplicating event-logging logic.
   */
  private _logPlanChunkEvent(chunk: PlanChunk, goalId?: string): void {
    let eventType: EventType | undefined;
    let payload: Record<string, unknown> | undefined;

    switch (chunk.type) {
      case "plan_created":
        eventType = EventType.PlanCreated;
        payload = { plan_id: chunk.plan.plan_id, title: chunk.plan.title, total_steps: chunk.steps.length };
        break;
      case "step_started":
        eventType = EventType.PlanStepStarted;
        payload = { plan_id: chunk.step.plan_id, step_id: chunk.step.step_id, ordinal: chunk.step.ordinal, description: chunk.step.description };
        break;
      case "step_completed":
        eventType = EventType.PlanStepCompleted;
        payload = { plan_id: chunk.step.plan_id, step_id: chunk.step.step_id, ordinal: chunk.step.ordinal, tool_calls_made: chunk.step.tool_calls_made };
        break;
      case "step_failed":
        eventType = EventType.PlanStepFailed;
        payload = { plan_id: chunk.step.plan_id, step_id: chunk.step.step_id, ordinal: chunk.step.ordinal, error: chunk.error };
        break;
      case "step_delegated":
        eventType = EventType.PlanStepDelegated;
        payload = { plan_id: chunk.step.plan_id, step_id: chunk.step.step_id, ordinal: chunk.step.ordinal, task_id: chunk.task_id };
        break;
      case "plan_completed":
        eventType = EventType.PlanCompleted;
        payload = { plan_id: chunk.plan.plan_id };
        break;
      case "plan_failed":
        eventType = EventType.PlanFailed;
        payload = { plan_id: chunk.plan.plan_id, reason: chunk.reason };
        break;
      default:
        return; // step_chunk, approval_request, reflection, plan_retrying, plan_truncated — handled by consumers
    }

    if (goalId != null) {
      payload.goal_id = goalId;
    }

    void (async () => {
      try {
        const clock = await this.events.getLatestClock(this.motebitId);
        await this.events.append({
          event_id: crypto.randomUUID(),
          motebit_id: this.motebitId,
          timestamp: Date.now(),
          event_type: eventType!,
          payload,
          version_clock: clock + 1,
          tombstoned: false,
        });
      } catch {
        // Fire-and-forget — consistent with existing event logging patterns
      }
    })();
  }

  /**
   * Reconstruct a complete execution manifest for a goal from the event log
   * and tool audit trail. The manifest is a verifiable, replayable record
   * of everything the agent did during goal execution.
   *
   * If `privateKey` is provided, the content_hash is Ed25519-signed, making
   * the manifest independently verifiable by any party with the public key.
   */
  async replayGoal(goalId: string, privateKey?: Uint8Array): Promise<GoalExecutionManifest | null> {
    // 1. Get plan for goal
    const plan = this.planStore.getPlanForGoal(goalId);
    if (!plan) return null;

    const steps = this.planStore.getStepsForPlan(plan.plan_id);

    // 2. Query plan lifecycle events + delegation task events
    const planEventTypes = [
      EventType.PlanCreated, EventType.PlanStepStarted, EventType.PlanStepCompleted,
      EventType.PlanStepFailed, EventType.PlanStepDelegated, EventType.PlanCompleted,
      EventType.PlanFailed, EventType.GoalCreated, EventType.GoalExecuted,
      EventType.GoalCompleted, EventType.AgentTaskCompleted, EventType.AgentTaskFailed,
    ];
    const events = await this.events.query({
      motebit_id: this.motebitId,
      event_types: planEventTypes,
    });

    // Filter to events related to this goal/plan
    const relevantEvents = events.filter((e) => {
      const p = e.payload as Record<string, unknown>;
      return p.goal_id === goalId || p.plan_id === plan.plan_id;
    });

    // 3. Collect delegation task_ids from steps, then find matching receipt events
    const delegationTaskIds = new Set(
      steps.filter((s) => s.delegation_task_id).map((s) => s.delegation_task_id!),
    );
    const receiptEvents = events.filter((e) => {
      if (e.event_type !== EventType.AgentTaskCompleted && e.event_type !== EventType.AgentTaskFailed) return false;
      const p = e.payload as Record<string, unknown>;
      return delegationTaskIds.has(p.task_id as string);
    });

    // 4. Query tool audit entries for this plan's run_id
    const toolEntries: ToolAuditEntry[] = [];
    if (this.toolAuditSink?.queryByRunId != null) {
      toolEntries.push(...this.toolAuditSink.queryByRunId(plan.plan_id));
    }

    // 5. Build timeline
    const timeline: ExecutionTimelineEntry[] = [];

    // Goal start
    const goalStartEvent = relevantEvents.find(
      (e) => e.event_type === EventType.GoalCreated || e.event_type === EventType.GoalExecuted,
    );
    if (goalStartEvent) {
      timeline.push({ timestamp: goalStartEvent.timestamp, type: "goal_started", payload: { goal_id: goalId } });
    }

    // Plan lifecycle events — only emit recognized fields (no raw payload leak)
    for (const event of relevantEvents) {
      const p = event.payload as Record<string, unknown>;
      switch (event.event_type) {
        case EventType.PlanCreated:
          timeline.push({ timestamp: event.timestamp, type: "plan_created", payload: { plan_id: p.plan_id, title: p.title, total_steps: p.total_steps } });
          break;
        case EventType.PlanStepStarted:
          timeline.push({ timestamp: event.timestamp, type: "step_started", payload: { plan_id: p.plan_id, step_id: p.step_id, ordinal: p.ordinal, description: p.description } });
          break;
        case EventType.PlanStepCompleted:
          timeline.push({ timestamp: event.timestamp, type: "step_completed", payload: { plan_id: p.plan_id, step_id: p.step_id, ordinal: p.ordinal, tool_calls_made: p.tool_calls_made } });
          break;
        case EventType.PlanStepFailed:
          timeline.push({ timestamp: event.timestamp, type: "step_failed", payload: { plan_id: p.plan_id, step_id: p.step_id, ordinal: p.ordinal, error: p.error } });
          break;
        case EventType.PlanStepDelegated:
          timeline.push({ timestamp: event.timestamp, type: "step_delegated", payload: { plan_id: p.plan_id, step_id: p.step_id, ordinal: p.ordinal, task_id: p.task_id } });
          break;
        case EventType.PlanCompleted:
          timeline.push({ timestamp: event.timestamp, type: "plan_completed", payload: { plan_id: p.plan_id } });
          break;
        case EventType.PlanFailed:
          timeline.push({ timestamp: event.timestamp, type: "plan_failed", payload: { plan_id: p.plan_id, reason: p.reason } });
          break;
      }
    }

    // Tool audit entries — hash args for privacy, include both invocation and result
    for (const entry of toolEntries) {
      if (!entry.decision.allowed) continue;

      const argsHash = await this._hashString(
        JSON.stringify(entry.args, Object.keys(entry.args).sort()),
      );

      timeline.push({
        timestamp: entry.timestamp,
        type: "tool_invoked",
        payload: { tool: entry.tool, args_hash: argsHash, call_id: entry.callId },
      });

      if (entry.result) {
        timeline.push({
          timestamp: entry.timestamp + (entry.result.durationMs ?? 0),
          type: "tool_result",
          payload: { tool: entry.tool, ok: entry.result.ok, duration_ms: entry.result.durationMs, call_id: entry.callId },
        });
      }
    }

    // Goal completion
    const goalEndEvent = relevantEvents.find((e) => e.event_type === EventType.GoalCompleted);
    if (goalEndEvent) {
      timeline.push({ timestamp: goalEndEvent.timestamp, type: "goal_completed", payload: { goal_id: goalId, status: plan.status } });
    }

    // Sort by timestamp, stable (preserving insertion order for same-timestamp entries)
    timeline.sort((a, b) => a.timestamp - b.timestamp);

    // 6. Build step summaries
    const stepSummaries: ExecutionStepSummary[] = steps.map((s) => {
      // Only count tools that fall within this step's time window
      const stepToolEntries = toolEntries.filter((t) => {
        if (s.started_at == null) return false;
        const end = s.completed_at ?? Infinity;
        return t.timestamp >= s.started_at && t.timestamp <= end;
      });
      const uniqueTools = [...new Set(stepToolEntries.map((t) => t.tool))];

      const summary: ExecutionStepSummary = {
        step_id: s.step_id,
        ordinal: s.ordinal,
        description: s.description,
        status: s.status,
        tools_used: uniqueTools,
        tool_calls: s.tool_calls_made,
        started_at: s.started_at,
        completed_at: s.completed_at,
      };

      if (s.delegation_task_id) {
        // Find matching receipt event to include receipt hash
        const receiptEvent = receiptEvents.find((e) => {
          const p = e.payload as Record<string, unknown>;
          return p.task_id === s.delegation_task_id;
        });
        const receiptPayload = receiptEvent?.payload as Record<string, unknown> | undefined;
        const receipt = receiptPayload?.receipt as Record<string, unknown> | undefined;
        summary.delegation = {
          task_id: s.delegation_task_id,
          receipt_hash: receipt?.signature as string | undefined,
        };
      }

      return summary;
    });

    // 7. Extract delegation receipt summaries from event log
    const delegationReceipts: DelegationReceiptSummary[] = receiptEvents.map((e) => {
      const p = e.payload as Record<string, unknown>;
      const receipt = p.receipt as Record<string, unknown> | undefined;
      return {
        task_id: p.task_id as string,
        motebit_id: (receipt?.motebit_id ?? "") as string,
        device_id: (receipt?.device_id ?? "") as string,
        status: (p.status ?? "unknown") as string,
        completed_at: (receipt?.completed_at ?? e.timestamp) as number,
        tools_used: (p.tools_used ?? []) as string[],
        signature_prefix: (receipt?.signature ?? "") as string,
      };
    });

    // 8. Compute content hash (SHA-256 of canonical timeline)
    const contentHash = await this._computeTimelineHash(timeline);

    // 9. Map plan status
    const statusMap: Record<string, GoalExecutionManifest["status"]> = {
      completed: "completed",
      failed: "failed",
      paused: "paused",
      active: "active",
    };
    const manifestStatus = statusMap[plan.status] ?? "failed";

    // 10. Determine timing
    const startedAt = timeline[0]?.timestamp ?? plan.created_at;
    const completedAt = timeline[timeline.length - 1]?.timestamp ?? plan.updated_at;

    const manifest: GoalExecutionManifest = {
      spec: "motebit/execution-ledger@1.0",
      motebit_id: this.motebitId,
      goal_id: goalId,
      plan_id: plan.plan_id,
      started_at: startedAt,
      completed_at: completedAt,
      status: manifestStatus,
      timeline,
      steps: stepSummaries,
      delegation_receipts: delegationReceipts,
      content_hash: contentHash,
    };

    // 11. Sign if private key provided — sign raw 32-byte hash per spec §6
    if (privateKey) {
      const { sign, toBase64Url, hexToBytes } = await import("@motebit/crypto");
      const hashBytes = hexToBytes(contentHash);
      const sig = await sign(hashBytes, privateKey);
      manifest.signature = toBase64Url(sig);
    }

    return manifest;
  }

  /**
   * SHA-256 hash of canonical timeline. Each entry serialized as canonical JSON
   * (sorted keys, no whitespace), joined by newline. Deterministic across platforms.
   */
  private async _computeTimelineHash(timeline: ExecutionTimelineEntry[]): Promise<string> {
    const lines = timeline.map((entry) => canonicalJson(entry));
    return this._hashString(lines.join("\n"));
  }

  private async _hashString(data: string): Promise<string> {
    const hashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
    return Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, "0")).join("");
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

    // Support both legacy (plain hex) and salted (salt:key) formats
    const parts = storedHash.split(":");
    const inputHash = parts.length === 2 ? await hashPin(pin, parts[0]) : await hashPin(pin);
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

  /** Convert curiosity targets to lightweight hints for the context pack. */
  private buildCuriosityHints(): Array<{ content: string; daysSinceDiscussed: number }> | undefined {
    if (this._curiosityTargets.length === 0) return undefined;
    const DAY = 86_400_000;
    const now = Date.now();
    return this._curiosityTargets.slice(0, 2).map(t => ({
      content: t.node.content,
      daysSinceDiscussed: Math.round((now - t.node.last_accessed) / DAY),
    }));
  }

  async sendMessage(text: string, runId?: string): Promise<TurnResult> {
    if (!this.loopDeps) throw new Error("AI not initialized — call setProvider() first");
    if (this._isProcessing) throw new Error("Already processing a message");

    this._isProcessing = true;
    this.state.pushUpdate({ processing: 0.9, attention: 0.8 });

    try {
      const trimmed = this.trimHistory();
      const knownAgents = await this.listTrustedAgents();
      const result = await runTurn(this.loopDeps, text, {
        conversationHistory: trimmed,
        previousCues: this.latestCues,
        runId,
        sessionInfo: this.sessionInfo ?? undefined,
        curiosityHints: this.buildCuriosityHints(),
        knownAgents: knownAgents.length > 0 ? knownAgents : undefined,
      });
      this.pushToHistory(text, result.response);
      // Accumulate behavioral stats for the intelligence gradient
      this._behavioralStats.turnCount++;
      this._behavioralStats.totalIterations += result.iterations;
      this._behavioralStats.toolCallsSucceeded += result.toolCallsSucceeded;
      this._behavioralStats.toolCallsBlocked += result.toolCallsBlocked;
      this._behavioralStats.toolCallsFailed += result.toolCallsFailed;
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
      const knownAgents = await this.listTrustedAgents();
      const stream = runTurnStreaming(this.loopDeps, text, {
        conversationHistory: trimmed,
        previousCues: this.latestCues,
        runId,
        sessionInfo: this.sessionInfo ?? undefined,
        curiosityHints: this.buildCuriosityHints(),
        knownAgents: knownAgents.length > 0 ? knownAgents : undefined,
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
   * Handle an externally submitted agent task. Runs in an isolated conversation
   * context, signs the result as an ExecutionReceipt, and yields the receipt.
   */
  async *handleAgentTask(
    task: AgentTask,
    privateKey: Uint8Array,
    deviceId: string,
  ): AsyncGenerator<StreamChunk> {
    if (!this.loopDeps) throw new Error("AI not initialized — call setProvider() first");

    // Save current conversation context
    const savedHistory = [...this.conversationHistory];
    const savedConversationId = this.conversationId;
    this.conversationHistory = [];
    this.conversationId = null;

    const wallClockMs = task.wall_clock_ms ?? 60_000;
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), wallClockMs);

    let responseText = "";
    const toolsUsed: string[] = [];
    let memoriesFormed = 0;
    let status: "completed" | "failed" | "denied" = "completed";

    try {
      const stream = this.sendMessageStreaming(task.prompt);

      for await (const chunk of stream) {
        if (abortController.signal.aborted) {
          status = "failed";
          responseText = responseText || "Task timed out";
          break;
        }

        if (chunk.type === "text") {
          responseText += chunk.text;
        } else if (chunk.type === "tool_status" && chunk.status === "done") {
          if (!toolsUsed.includes(chunk.name)) {
            toolsUsed.push(chunk.name);
          }
        } else if (chunk.type === "result") {
          responseText = chunk.result.response;
          memoriesFormed = chunk.result.memoriesFormed.length;
        }

        yield chunk;
      }
    } catch (err: unknown) {
      status = "failed";
      responseText = responseText || (err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timeout);

      // Restore user conversation context
      this.conversationHistory = savedHistory;
      this.conversationId = savedConversationId;
    }

    // Drain delegation receipts from motebit MCP adapters
    const delegationReceipts: ExecutionReceipt[] = [];
    for (const adapter of this.mcpAdapters) {
      if (adapter.getAndResetDelegationReceipts) {
        delegationReceipts.push(...adapter.getAndResetDelegationReceipts());
      }
    }

    // Bump trust from verified delegation receipts (best-effort)
    if (delegationReceipts.length > 0 && this.agentTrustStore != null) {
      try {
        const { verifyExecutionReceipt } = await import("@motebit/crypto");
        for (const dr of delegationReceipts) {
          // Look up stored public key for the delegatee
          const trustRecord = await this.agentTrustStore.getAgentTrust(
            this.motebitId,
            dr.motebit_id,
          );
          if (trustRecord?.public_key) {
            const fromHex = (hex: string): Uint8Array => {
              const bytes = new Uint8Array(hex.length / 2);
              for (let i = 0; i < hex.length; i += 2) {
                bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
              }
              return bytes;
            };
            const pubKey = fromHex(trustRecord.public_key);
            const verified = await verifyExecutionReceipt(dr, pubKey);
            await this.bumpTrustFromReceipt(dr, verified);
          } else {
            // No stored key — record as unverified first contact
            await this.bumpTrustFromReceipt(dr, true);
          }
        }
      } catch {
        // Trust bumping is best-effort — don't break the task
      }
    }

    // Hash prompt and result
    const { hash, signExecutionReceipt } = await import("@motebit/crypto");
    const promptHash = await hash(new TextEncoder().encode(task.prompt));
    const resultHash = await hash(new TextEncoder().encode(responseText));

    // Build and sign receipt
    const receiptBody: Record<string, unknown> = {
      task_id: task.task_id,
      motebit_id: task.motebit_id,
      device_id: deviceId,
      submitted_at: task.submitted_at,
      completed_at: Date.now(),
      status,
      result: responseText,
      tools_used: toolsUsed,
      memories_formed: memoriesFormed,
      prompt_hash: promptHash,
      result_hash: resultHash,
    };
    if (delegationReceipts.length > 0) {
      receiptBody.delegation_receipts = delegationReceipts;
    }

    const receipt = await signExecutionReceipt(
      receiptBody as Omit<ExecutionReceipt, "signature">,
      privateKey,
    );

    // Log event
    const eventTypeMap: Record<string, EventType> = {
      completed: EventType.AgentTaskCompleted,
      denied: EventType.AgentTaskDenied,
      failed: EventType.AgentTaskFailed,
    };
    const eventType = eventTypeMap[status] ?? EventType.AgentTaskFailed;

    try {
      const clock = await this.events.getLatestClock(this.motebitId);
      await this.events.append({
        event_id: crypto.randomUUID(),
        motebit_id: this.motebitId,
        device_id: deviceId,
        timestamp: Date.now(),
        event_type: eventType,
        payload: {
          task_id: task.task_id,
          status,
          tools_used: toolsUsed,
          memories_formed: memoriesFormed,
          receipt: {
            motebit_id: receipt.motebit_id,
            device_id: receipt.device_id,
            completed_at: receipt.completed_at,
            signature: receipt.signature.slice(0, 16),
            delegation_receipts: receipt.delegation_receipts?.map(function summarize(
              dr: ExecutionReceipt,
            ): Record<string, unknown> {
              return {
                task_id: dr.task_id,
                motebit_id: dr.motebit_id,
                device_id: dr.device_id,
                status: dr.status,
                completed_at: dr.completed_at,
                tools_used: dr.tools_used,
                memories_formed: dr.memories_formed,
                signature: dr.signature.slice(0, 16),
                delegation_receipts: dr.delegation_receipts?.map(summarize),
              };
            }),
          },
        },
        version_clock: clock + 1,
        tombstoned: false,
      });
    } catch {
      // Event logging is best-effort
    }

    yield { type: "task_result", receipt };
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
            yield {
              type: "injection_warning" as const,
              tool_name: pending.toolName,
              patterns: check.injectionPatterns,
            };
          }
        } else if (typeof this.policy.sanitizeResult === "function") {
          sanitized = this.policy.sanitizeResult(result, pending.toolName);
        }

        yield {
          type: "tool_status" as const,
          name: pending.toolName,
          status: "done" as const,
          result: sanitized.data ?? sanitized.error,
        };
        void this.logToolUsed(pending.toolName, sanitized.data ?? sanitized.error);

        // Push tool call + result into conversation history for continuation
        this.conversationHistory.push(
          {
            role: "assistant" as const,
            content: `[tool_use: ${pending.toolName}(${JSON.stringify(pending.args)})]`,
          },
          { role: "user" as const, content: `[tool_result: ${JSON.stringify(sanitized)}]` },
        );
      } else {
        // Push denial into conversation history
        this.conversationHistory.push(
          {
            role: "assistant" as const,
            content: `[tool_use: ${pending.toolName}(${JSON.stringify(pending.args)})]`,
          },
          {
            role: "user" as const,
            content: `[tool_result: {"ok":false,"error":"User denied this tool call."}]`,
          },
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
        {
          role: "assistant" as const,
          content: `[tool_use: ${expired.toolName}(${JSON.stringify(expired.args)})]`,
        },
        {
          role: "user" as const,
          content: `[tool_result: {"ok":false,"error":"Approval timed out after ${this.approvalTimeoutMs}ms"}]`,
        },
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
        const motebitServer = this.motebitToolServers.get(chunk.name);
        if (chunk.status === "calling") {
          this.state.pushUpdate({ processing: 0.95, attention: 0.9, curiosity: 0.7 });
          // Emit delegation_start for motebit MCP tools
          if (motebitServer) {
            this.behavior.setDelegating(true);
            yield { type: "delegation_start", server: motebitServer, tool: chunk.name };
          }
        } else if (chunk.status === "done") {
          this.state.pushUpdate({ processing: 0.6, confidence: 0.7 });
          void this.logToolUsed(chunk.name, chunk.result);
          // Emit delegation_complete for motebit MCP tools
          if (motebitServer) {
            // Extract receipt summary if this was a motebit_task call with a receipt result
            let receiptSummary:
              | { task_id: string; status: string; tools_used: string[] }
              | undefined;
            if (chunk.result != null && typeof chunk.result === "object") {
              const r = chunk.result as Record<string, unknown>;
              if (
                typeof r.task_id === "string" &&
                typeof r.status === "string" &&
                Array.isArray(r.tools_used)
              ) {
                receiptSummary = {
                  task_id: r.task_id,
                  status: r.status,
                  tools_used: r.tools_used as string[],
                };
              }
            }
            this.behavior.setDelegating(false);
            yield {
              type: "delegation_complete",
              server: motebitServer,
              tool: chunk.name,
              receipt: receiptSummary,
            };
          }
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
      if (chunk.type === "result") {
        result = chunk.result;
        // Accumulate behavioral stats for the intelligence gradient
        this._behavioralStats.turnCount++;
        this._behavioralStats.totalIterations += result.iterations;
        this._behavioralStats.toolCallsSucceeded += result.toolCallsSucceeded;
        this._behavioralStats.toolCallsBlocked += result.toolCallsBlocked;
        this._behavioralStats.toolCallsFailed += result.toolCallsFailed;
      }
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

    const summary =
      this.conversationId != null && this.conversationId !== "" && this.conversationStore != null
        ? (this.conversationStore.getActiveConversation(this.motebitId)?.summary ?? null)
        : null;

    const recentMemories = await this.memory.exportAll();
    const memories = recentMemories.nodes.slice(0, 10).map((n) => ({ content: n.content }));

    const result = await aiReflect(
      summary,
      this.conversationHistory,
      goals ?? [],
      memories,
      this.provider,
      this.taskRouter ?? undefined,
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
        const candidate = {
          content: `[reflection] ${insight}`,
          confidence: 0.7,
          sensitivity: SensitivityLevel.None,
        };
        const [decision] = this.memoryGovernor.evaluate([candidate]);
        if (decision && decision.memoryClass === MemoryClass.REJECTED) {
          continue;
        }
        const embedding = await embedText(candidate.content);
        await this.memory.formMemory(candidate, embedding);
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
        const candidate = {
          content: `[plan_adjustment] ${adjustment}`,
          confidence: 0.6,
          sensitivity: SensitivityLevel.None,
        };
        const [decision] = this.memoryGovernor.evaluate([candidate]);
        if (decision && decision.memoryClass === MemoryClass.REJECTED) {
          continue;
        }
        const embedding = await embedText(candidate.content);
        await this.memory.formMemory(candidate, embedding);
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
  async generateCompletion(prompt: string, taskType?: TaskType): Promise<string> {
    if (!this.provider) throw new Error("No AI provider configured");

    const contextPack = {
      recent_events: [],
      relevant_memories: [],
      current_state: this.state.getState(),
      user_message: prompt,
    };

    const doGenerate = async (p: import("@motebit/sdk").IntelligenceProvider) =>
      (await p.generate(contextPack)).text;

    let result: string;
    if (taskType && this.taskRouter) {
      result = await withTaskConfig(this.provider, this.taskRouter.resolve(taskType), doGenerate);
    } else {
      result = await doGenerate(this.provider);
    }

    // Audit: log housekeeping run without affecting user-facing state
    void this.logHousekeepingRun(prompt, result);

    return result;
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
    if (this.conversationStore == null || this.conversationId == null || this.conversationId === "")
      return null;
    const convos = this.conversationStore.listConversations(this.motebitId, 100);
    const current = convos.find((c) => c.conversationId === this.conversationId);
    if (current?.title != null && current.title !== "") return null; // already titled

    const history = this.getConversationHistory();
    if (history.length < 4) return null;

    if (this.provider) {
      try {
        const snippet = history
          .slice(0, 6)
          .map((m) => `${m.role}: ${m.content.slice(0, 200)}`)
          .join("\n");
        const prompt = `Generate a very short title (5-7 words max) for this conversation. Return ONLY the title, no quotes, no explanation.\n\n${snippet}`;
        const raw = await this.generateCompletion(prompt, "title_generation");
        const title = raw
          .trim()
          .replace(/^["']|["']$/g, "")
          .slice(0, 100);
        if (title.length > 0 && title.length < 100) {
          this.conversationStore.updateTitle(this.conversationId, title);
          return title;
        }
      } catch {
        // Fall through to heuristic
      }
    }

    // Heuristic fallback: first 7 words of first user message
    const first = history.find((m) => m.role === "user");
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
    if (
      this.provider == null ||
      this.conversationStore == null ||
      this.conversationId == null ||
      this.conversationId === ""
    )
      return null;
    const history = this.getConversationHistory();
    if (history.length < 2) return null;
    const existingSummary =
      this.conversationStore.getActiveConversation(this.motebitId)?.summary ?? null;
    const summary = await summarizeConversation(
      history,
      existingSummary,
      this.provider,
      this.taskRouter ?? undefined,
    );
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

      // Compute curiosity targets — decaying high-value memories worth asking about
      this._curiosityTargets = findCuriosityTargets(
        nodes.filter(n => !n.tombstoned && !n.pinned),
      );

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
          curiosity_targets: this._curiosityTargets.length,
        },
        version_clock: clock + 1,
        tombstoned: false,
      });

      // Episodic consolidation (guarded by config flag)
      if (this.episodicConsolidation && this.provider) {
        await this.consolidateEpisodicMemories(nodes, now);
      }

      // Compute intelligence gradient — data already loaded
      await this.computeAndStoreGradient(nodes);
    } catch {
      // Housekeeping is best-effort — don't crash the runtime
    }
  }

  /**
   * Consolidate aging episodic memories into semantic summaries.
   * Groups similar episodic memories by embedding, asks LLM to summarize each cluster,
   * and forms a new semantic memory from the summary.
   */
  private async consolidateEpisodicMemories(
    allNodes: import("@motebit/sdk").MemoryNode[],
    now: number,
  ): Promise<void> {
    const { MemoryType: MT } = await import("@motebit/sdk");

    // Find episodic memories past 50% of their half-life, not tombstoned, not pinned
    const candidates = allNodes.filter((n) => {
      if (n.tombstoned || n.pinned) return false;
      if (n.memory_type !== MT.Episodic) return false;
      const elapsed = now - n.created_at;
      return elapsed > n.half_life * 0.5;
    });

    if (candidates.length < 3) return; // Not enough to consolidate

    // Cluster by cosine similarity
    const clusters = clusterBySimilarity(candidates, 0.6);

    for (const cluster of clusters) {
      if (cluster.length < 2) continue;

      // Summarize cluster via LLM
      const contents = cluster.map((n) => `- ${n.content}`).join("\n");
      const prompt = `Summarize the following episodic observations into a single factual statement:\n${contents}\n\nRespond with ONLY the summary sentence.`;

      try {
        if (!this.provider) return; // Provider may have been cleared concurrently
        const result = await this.provider.generate({
          recent_events: [],
          relevant_memories: [],
          current_state: this.state.getState(),
          user_message: prompt,
        });

        const summary = result.text.trim();
        if (summary.length < 5) continue;

        // Compute average confidence + boost
        const avgConf = cluster.reduce((sum, n) => sum + n.confidence, 0) / cluster.length;
        const newConf = Math.min(1.0, avgConf + 0.1);

        // Form new semantic memory — governor checks for secrets in the summary text
        const candidate = {
          content: summary,
          confidence: newConf,
          sensitivity: cluster[0]!.sensitivity,
          memory_type: MT.Semantic,
        };
        const [decision] = this.memoryGovernor.evaluate([candidate]);
        if (decision && decision.memoryClass === MemoryClass.REJECTED) {
          continue;
        }
        const embedding = await embedText(summary);
        const synthesized = await this.memory.formMemory(
          candidate,
          embedding,
          MemoryGraph.HALF_LIFE_SEMANTIC,
        );

        // Create PartOf edges — lineage trail from synthesis to each source
        const { RelationType: SynthRT } = await import("@motebit/sdk");
        for (const sourceNode of cluster) {
          await this.memory.link(synthesized.node_id, sourceNode.node_id, SynthRT.PartOf);
        }

        // Tombstone the episodic cluster members (edges preserved for lineage)
        for (const node of cluster) {
          await this.memory.deleteMemory(node.node_id);
        }
      } catch {
        // Consolidation is best-effort per cluster
      }
    }
  }

  // === Curiosity Targets ===

  /** Get curiosity targets computed during last housekeeping cycle. */
  getCuriosityTargets(): CuriosityTarget[] {
    return this._curiosityTargets;
  }

  // === Intelligence Gradient ===

  /** Get the latest gradient snapshot, or null if none computed yet. */
  getGradient(): GradientSnapshot | null {
    return this.gradientStore.latest(this.motebitId);
  }

  /** Get gradient history (most recent first). */
  getGradientHistory(limit?: number): GradientSnapshot[] {
    return this.gradientStore.list(this.motebitId, limit);
  }

  /** Return accumulated behavioral stats and reset the accumulator. */
  getAndResetBehavioralStats(): BehavioralStats {
    const stats = { ...this._behavioralStats };
    this._behavioralStats = {
      turnCount: 0,
      totalIterations: 0,
      toolCallsSucceeded: 0,
      toolCallsBlocked: 0,
      toolCallsFailed: 0,
    };
    return stats;
  }

  /** Force a gradient computation right now (useful for CLI/debug). */
  async computeGradientNow(): Promise<GradientSnapshot> {
    const { nodes } = await this.memory.exportAll();
    return this.computeAndStoreGradient(nodes);
  }

  private async computeAndStoreGradient(
    allNodes: import("@motebit/sdk").MemoryNode[],
  ): Promise<GradientSnapshot> {
    // Fetch edges and recent consolidation events
    const exported = await this.memory.exportAll();
    const edges = exported.edges;

    // Query consolidation events from last 7 days
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const consolidationEvents = await this.events.query({
      motebit_id: this.motebitId,
      event_types: [EventType.MemoryConsolidated],
      after_timestamp: sevenDaysAgo,
    });

    const previous = this.gradientStore.latest(this.motebitId);
    const previousGradient = previous ? previous.gradient : null;

    const retrievalStats = this.memory.getAndResetRetrievalStats();

    // Derive behavioral stats from audit log (crash-safe source of truth)
    // instead of the volatile in-memory accumulator.
    let behavioralStats: BehavioralStats;
    if (this.toolAuditSink) {
      const sinceTs = previous ? previous.timestamp : 0;
      const auditStats = this.toolAuditSink.queryStatsSince(sinceTs);
      behavioralStats = {
        turnCount: auditStats.distinctTurns,
        // Approximate: each tool call ≈ 1 loop iteration
        totalIterations: auditStats.totalToolCalls,
        toolCallsSucceeded: auditStats.succeeded,
        toolCallsBlocked: auditStats.blocked,
        toolCallsFailed: auditStats.failed,
      };
    } else {
      behavioralStats = this.getAndResetBehavioralStats();
    }

    // Compute curiosity pressure from current targets
    let curiosityPressure: { avgScore: number; count: number } | undefined;
    if (this._curiosityTargets.length > 0) {
      const totalScore = this._curiosityTargets.reduce((sum, t) => sum + t.curiosityScore, 0);
      curiosityPressure = {
        avgScore: totalScore / this._curiosityTargets.length,
        count: this._curiosityTargets.length,
      };
    }

    const snapshot = computeGradient(
      this.motebitId,
      allNodes,
      edges,
      consolidationEvents,
      previousGradient,
      undefined,
      retrievalStats,
      behavioralStats,
      curiosityPressure,
    );

    this.gradientStore.save(snapshot);
    return snapshot;
  }

  private wireLoopDeps(): void {
    if (this.provider) {
      const provider = this.provider;
      const stateEngine = this.state;

      const consolidationProvider: ConsolidationProvider = {
        async classify(newContent, existing) {
          const prompt = buildConsolidationPrompt(newContent, existing);
          const result = await provider.generate({
            recent_events: [],
            relevant_memories: [],
            current_state: stateEngine.getState(),
            user_message: prompt,
          });
          return parseConsolidationResponse(
            result.text,
            existing.map((e) => e.node_id),
          );
        },
      };

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
        consolidationProvider,
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
    const summary =
      this.conversationId != null && this.conversationId !== "" && this.conversationStore != null
        ? (this.conversationStore.getActiveConversation(this.motebitId)?.summary ?? null)
        : null;
    return trimConversation(this.conversationHistory, MotebitRuntime.CONVERSATION_BUDGET, summary);
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
      this.conversationId != null &&
      this.conversationId !== "" &&
      shouldSummarize(this.conversationHistory.length, this.summarizeAfterMessages)
    ) {
      void this.runSummarization();
    }
  }

  private async runSummarization(): Promise<void> {
    if (
      this.provider == null ||
      this.conversationStore == null ||
      this.conversationId == null ||
      this.conversationId === ""
    )
      return;
    try {
      const existingSummary =
        this.conversationStore.getActiveConversation(this.motebitId)?.summary ?? null;
      const summary = await summarizeConversation(
        this.conversationHistory,
        existingSummary,
        this.provider,
        this.taskRouter ?? undefined,
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

  // === Agent Trust ===

  /**
   * Bump trust level for a remote motebit based on a verified execution receipt.
   * Trust progression: Unknown → FirstContact (on first interaction) → Verified (after 5+ verified).
   * Never auto-promotes to Trusted — requires explicit owner action.
   */
  async bumpTrustFromReceipt(receipt: ExecutionReceipt, verified: boolean): Promise<void> {
    if (this.agentTrustStore == null) return;
    if (!verified) return; // Unverified receipts don't affect trust

    const remoteMotebitId = receipt.motebit_id;
    const now = Date.now();
    const existing = await this.agentTrustStore.getAgentTrust(this.motebitId, remoteMotebitId);

    const taskSucceeded = receipt.status === "completed";
    const taskFailed = receipt.status === "failed";

    if (existing != null) {
      const updated: AgentTrustRecord = {
        ...existing,
        last_seen_at: now,
        interaction_count: existing.interaction_count + 1,
        successful_tasks: (existing.successful_tasks ?? 0) + (taskSucceeded ? 1 : 0),
        failed_tasks: (existing.failed_tasks ?? 0) + (taskFailed ? 1 : 0),
      };
      // Auto-promote FirstContact → Verified after 5 verified interactions
      if (existing.trust_level === AgentTrustLevel.FirstContact && updated.interaction_count >= 5) {
        updated.trust_level = AgentTrustLevel.Verified;
      }
      // Never auto-promote beyond Verified
      await this.agentTrustStore.setAgentTrust(updated);
    } else {
      // First interaction — create at FirstContact
      const record: AgentTrustRecord = {
        motebit_id: this.motebitId,
        remote_motebit_id: remoteMotebitId,
        trust_level: AgentTrustLevel.FirstContact,
        first_seen_at: now,
        last_seen_at: now,
        interaction_count: 1,
        successful_tasks: taskSucceeded ? 1 : 0,
        failed_tasks: taskFailed ? 1 : 0,
      };
      await this.agentTrustStore.setAgentTrust(record);
    }
  }

  /**
   * Record or update trust for a remote motebit after an MCP interaction.
   * If no record exists, creates one at FirstContact level.
   * If one exists, bumps interaction_count and last_seen_at.
   */
  async recordAgentInteraction(
    remoteMotebitId: string,
    publicKey?: string,
    motebitType?: string,
  ): Promise<AgentTrustRecord | null> {
    if (this.agentTrustStore == null) return null;
    const now = Date.now();
    const existing = await this.agentTrustStore.getAgentTrust(this.motebitId, remoteMotebitId);
    if (existing != null) {
      const updated: AgentTrustRecord = {
        ...existing,
        last_seen_at: now,
        interaction_count: existing.interaction_count + 1,
        public_key: publicKey ?? existing.public_key,
        notes: motebitType ? `type:${motebitType}` : existing.notes,
      };
      await this.agentTrustStore.setAgentTrust(updated);
      return updated;
    }
    const record: AgentTrustRecord = {
      motebit_id: this.motebitId,
      remote_motebit_id: remoteMotebitId,
      trust_level: AgentTrustLevel.FirstContact,
      public_key: publicKey,
      first_seen_at: now,
      last_seen_at: now,
      interaction_count: 1,
      notes: motebitType ? `type:${motebitType}` : undefined,
    };
    await this.agentTrustStore.setAgentTrust(record);
    return record;
  }

  /** Get trust record for a specific remote motebit. */
  async getAgentTrust(remoteMotebitId: string): Promise<AgentTrustRecord | null> {
    if (this.agentTrustStore == null) return null;
    return this.agentTrustStore.getAgentTrust(this.motebitId, remoteMotebitId);
  }

  /** List all known agent trust records for this motebit. */
  async listTrustedAgents(): Promise<AgentTrustRecord[]> {
    if (this.agentTrustStore == null) return [];
    return this.agentTrustStore.listAgentTrust(this.motebitId);
  }

  /** Update trust level for a remote motebit. */
  async setAgentTrustLevel(remoteMotebitId: string, level: AgentTrustLevel): Promise<void> {
    if (this.agentTrustStore == null) return;
    await this.agentTrustStore.updateTrustLevel(this.motebitId, remoteMotebitId, level);
  }
}
