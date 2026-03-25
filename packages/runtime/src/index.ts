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
  ToolAuditEntry,
  AgentServiceListing,
  PrecisionWeights,
  KeyringAdapter,
} from "@motebit/sdk";
import { EventType, AgentTrustLevel } from "@motebit/sdk";
import { EventStore, InMemoryEventStore } from "@motebit/event-log";
import type { EventStoreAdapter } from "@motebit/event-log";
import {
  MemoryGraph,
  InMemoryMemoryStorage,
  buildConsolidationPrompt,
  parseConsolidationResponse,
} from "@motebit/memory-graph";
import type {
  ConsolidationProvider,
  CuriosityTarget,
  MemoryAuditResult,
} from "@motebit/memory-graph";
import { auditMemoryGraph } from "@motebit/memory-graph";
import { StateVectorEngine } from "@motebit/state-vector";
import { BehaviorEngine } from "@motebit/behavior-engine";
import { IdentityManager, InMemoryIdentityStorage } from "@motebit/core-identity";
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
  TaskRouter,
  withTaskConfig,
} from "@motebit/ai-core";
import type {
  StreamingProvider,
  MotebitLoopDependencies,
  TurnResult,
  AgenticChunk,
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
import type {
  PlanChunk,
  StepDelegationAdapter,
  CollaborativeDelegationAdapter,
} from "@motebit/planner";
import type { PlanStoreAdapter } from "@motebit/planner";
import type { DeviceCapability } from "@motebit/sdk";
import { PolicyGate, MemoryGovernor } from "@motebit/policy";
import type { PolicyConfig, MemoryGovernanceConfig, AuditLogSink } from "@motebit/policy";
import {
  computeGradient,
  computePrecision,
  computeStateBaseline,
  gradientToMarketConfig,
  narrateEconomicConsequences,
  NEUTRAL_PRECISION,
  InMemoryGradientStore,
  summarizeGradientHistory,
  buildPrecisionContext,
} from "./gradient.js";
import { AgentGraphManager } from "./agent-graph.js";
import { replayGoal, hashString, computeTimelineHash } from "./execution-ledger.js";
import { setOperatorMode, setupOperatorPin, resetOperatorPin } from "./operator.js";
import {
  bumpTrustFromReceipt as _bumpTrustFromReceipt,
  recordAgentInteraction as _recordAgentInteraction,
} from "./agent-trust.js";
import { ConversationManager } from "./conversation.js";

/**
 * Strip state/memory/action tags for display — preserves whitespace.
 * Returns { clean, pending } where pending is a trailing incomplete
 * tag/action that shouldn't be yielded yet (it may close in a later chunk).
 */
function stripDisplayTags(text: string): { clean: string; pending: string } {
  // Strip complete tags — known internal tags + any stray XML the model emits
  const clean = text
    .replace(/<memory\s+[^>]*>[\s\S]*?<\/memory>/g, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/g, "")
    .replace(/<state\s+[^>]*\/>/g, "")
    .replace(/<parameter\s+[^>]*>[\s\S]*?<\/parameter>/g, "")
    .replace(/<\/?(?:artifact|function_calls|invoke|antml)[^>]*>/g, "")
    .replace(/\*{1,3}/g, "")
    .replace(/ {2,}/g, " ");

  // Check for trailing incomplete patterns that might close in a later chunk

  // Incomplete <memory> or <thinking> tag: opened but not closed yet
  for (const tag of ["<memory", "<thinking", "<parameter"]) {
    const lastOpen = clean.lastIndexOf(tag);
    if (lastOpen !== -1) {
      const closeTag = `</${tag.slice(1)}>`;
      const afterOpen = clean.slice(lastOpen);
      if (!afterOpen.includes(closeTag)) {
        return { clean: clean.slice(0, lastOpen), pending: clean.slice(lastOpen) };
      }
    }
  }

  // Incomplete XML tag: < without closing >
  const lastOpen = clean.lastIndexOf("<");
  if (lastOpen !== -1 && !clean.includes(">", lastOpen)) {
    return { clean: clean.slice(0, lastOpen), pending: clean.slice(lastOpen) };
  }
  return { clean, pending: "" };
}
import { performReflection } from "./reflection.js";
import type { ReflectionDeps } from "./reflection.js";
import { runHousekeeping } from "./housekeeping.js";
import type { HousekeepingDeps } from "./housekeeping.js";
import type { AgentTrustDeps } from "./agent-trust.js";
export { canonicalJson } from "./execution-ledger.js";
import type {
  GradientSnapshot,
  GradientStoreAdapter,
  BehavioralStats,
  SelfModelSummary,
} from "./gradient.js";
export type { GradientSnapshot, GradientStoreAdapter } from "./gradient.js";

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
import type {
  GradientCredentialSubject,
  ReputationCredentialSubject,
  TrustCredentialSubject,
} from "@motebit/sdk";

/** Union of all credential subject types issued by the runtime. */
type AnyCredentialSubject =
  | GradientCredentialSubject
  | ReputationCredentialSubject
  | TrustCredentialSubject;
export { AgentTrustLevel } from "@motebit/sdk";
export type { EventStoreAdapter } from "@motebit/event-log";
export type {
  MemoryStorageAdapter,
  CuriosityTarget,
  MemoryAuditResult,
  PhantomCertainty,
  MemoryConflict,
} from "@motebit/memory-graph";
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
export type {
  GoalExecutionManifest,
  ExecutionTimelineEntry,
  ExecutionStepSummary,
  DelegationReceiptSummary,
} from "@motebit/sdk";
export type {
  PlanChunk,
  StepDelegationAdapter,
  CollaborativeDelegationAdapter,
} from "@motebit/planner";
export type { PlanStoreAdapter } from "@motebit/planner";
export { RelayDelegationAdapter } from "@motebit/planner";
export type { RelayDelegationConfig } from "@motebit/planner";
export type { GradientConfig, BehavioralStats, SelfModelSummary } from "./gradient.js";
export {
  computeGradient,
  computePrecision,
  gradientToMarketConfig,
  narrateEconomicConsequences,
  NEUTRAL_PRECISION,
  InMemoryGradientStore,
  summarizeGradientHistory,
  buildPrecisionContext,
} from "./gradient.js";
export { AgentGraphManager } from "./agent-graph.js";
export type { RouteWeight } from "./agent-graph.js";

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

  /** Replace the handler for an existing tool, or register if new. */
  replace(tool: ToolDefinition, handler: ToolHandler): void {
    this.tools.set(tool.name, { definition: tool, handler });
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
// Canonical definitions live in @motebit/sdk. Re-exported here for backward compatibility.

export type {
  ConversationStoreAdapter,
  StateSnapshotAdapter,
  KeyringAdapter,
  AgentTrustStoreAdapter,
  ServiceListingStoreAdapter,
  BudgetAllocationStoreAdapter,
  SettlementStoreAdapter,
  LatencyStatsStoreAdapter,
  StorageAdapters,
} from "@motebit/sdk";

import type {
  StorageAdapters,
  StateSnapshotAdapter,
  AgentTrustStoreAdapter,
  ServiceListingStoreAdapter,
  LatencyStatsStoreAdapter,
} from "@motebit/sdk";

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
  /** Ed25519 signing keys for issuing verifiable credentials (gradient, trust). */
  signingKeys?: { privateKey: Uint8Array; publicKey: Uint8Array };
  /** Optional structured logger. Falls back to console.warn for best-effort diagnostics. */
  logger?: { warn(message: string, context?: Record<string, unknown>): void };
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
      quorum?: { required: number; approvers: string[]; collected: string[] };
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

// === Operator Mode ===
// Canonical implementation in ./operator.ts. Re-exported here.

export type { OperatorModeResult } from "./operator.js";

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
  private conversation: ConversationManager;
  private _isProcessing = false;
  private _isFirstConversation = false;
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
  /** Delegation receipts collected from interactive delegate_to_agent tool calls. */
  private _interactiveDelegationReceipts: ExecutionReceipt[] = [];
  private keyring: KeyringAdapter | null;
  private toolAuditSink?: AuditLogSink;
  private externalToolSources = new Map<string, string[]>();
  private planStore: PlanStoreAdapter;
  private planEngine: PlanEngine;
  private _localCapabilities: DeviceCapability[] = [];
  private _pendingApproval: {
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    userMessage: string;
    runId?: string;
    quorum?: { required: number; approvers: string[]; collected: string[] };
  } | null = null;
  private approvalTimeoutMs: number;
  private taskRouter: TaskRouter | null;
  private approvalTimer: ReturnType<typeof setTimeout> | null = null;
  private approvalExpiredCallback: (() => void) | null = null;
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
  private serviceListingStore: ServiceListingStoreAdapter | null;
  private latencyStatsStore: LatencyStatsStoreAdapter | null;
  private agentGraph: AgentGraphManager;
  private _curiosityTargets: CuriosityTarget[] = [];
  private _precision: PrecisionWeights;
  private _lastReflection: ReflectionResult | null = null;
  private _signingKeys: { privateKey: Uint8Array; publicKey: Uint8Array } | null;
  private _issuedCredentials: import("@motebit/crypto").VerifiableCredential<AnyCredentialSubject>[] =
    [];
  private _credentialStore: import("@motebit/sdk").CredentialStoreAdapter | null = null;
  private approvalStore: import("@motebit/sdk").ApprovalStoreAdapter | null = null;
  private _signingKeysErased = false;
  private _logger: { warn(message: string, context?: Record<string, unknown>): void };
  /** Callback to submit credentials to relay for indexing. Set by enableInteractiveDelegation. */
  private _credentialSubmitter:
    | ((
        vc: import("@motebit/crypto").VerifiableCredential<unknown>,
        subjectMotebitId: string,
      ) => Promise<void>)
    | null = null;

  constructor(config: RuntimeConfig, adapters: PlatformAdapters) {
    this.motebitId = config.motebitId;
    this.compactionThreshold = config.compactionThreshold ?? 1000;
    this.mcpConfigs = config.mcpServers ?? [];
    this.approvalTimeoutMs = config.approvalTimeoutMs ?? 600_000; // 10 min default
    this.taskRouter = config.taskRouter ? new TaskRouter(config.taskRouter) : null;
    this.episodicConsolidation = config.episodicConsolidation ?? false;
    this._precision = NEUTRAL_PRECISION;
    this._signingKeys = config.signingKeys ?? null;
    this._logger = config.logger ?? {
      warn: (msg, ctx) => console.warn(`[motebit] ${msg}`, ctx ? JSON.stringify(ctx) : ""),
    };
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

    // Conversation lifecycle
    this.conversation = new ConversationManager({
      motebitId: this.motebitId,
      maxHistory: config.maxConversationHistory ?? 40,
      summarizeAfterMessages: config.summarizeAfterMessages ?? 20,
      store: adapters.storage.conversationStore ?? null,
      getProvider: () => this.provider,
      getTaskRouter: () => this.taskRouter,
      generateCompletion: (prompt, taskType) => this.generateCompletion(prompt, taskType),
    });
    this.conversation.resumeActiveConversation();
    // First conversation: no prior history was loaded from persistence
    this._isFirstConversation = this.conversation.getHistory().length === 0;

    // Plan-execute engine
    this.planStore = adapters.storage.planStore ?? new InMemoryPlanStore();
    this.planEngine = new PlanEngine(this.planStore);
    this.planEngine.setLocalMotebitId(this.motebitId);

    // Intelligence gradient
    this.gradientStore = adapters.storage.gradientStore ?? new InMemoryGradientStore();

    // Apply accumulated intelligence baseline on startup.
    // A warm-started creature inherits its gradient-derived posture immediately —
    // the creature at 100 interactions wakes up differently than a fresh one.
    const latestGradient = this.gradientStore.latest(this.motebitId);
    if (latestGradient) {
      this._precision = computePrecision(latestGradient);
      this.state.pushUpdate(computeStateBaseline(latestGradient, this._precision));
    }

    // Agent trust
    this.agentTrustStore = adapters.storage.agentTrustStore ?? null;

    // Market stores
    this.serviceListingStore = adapters.storage.serviceListingStore ?? null;
    this.latencyStatsStore = adapters.storage.latencyStatsStore ?? null;

    // Credential persistence — persists issued VCs across restarts
    this._credentialStore = adapters.storage.credentialStore ?? null;

    // Approval store — persistence-backed quorum state (source of truth for multi-party approval)
    this.approvalStore = adapters.storage.approvalStore ?? null;

    // Agent graph — algebraic routing substrate
    // The credential store adapter reads from persistent storage (survives restart)
    // with fallback to in-memory credentials for environments without persistence.
    const graphCredentialStore = {
      getCredentialsForSubject: (subjectMotebitId: string) => {
        // Prefer persistent store (has historical credentials across sessions)
        if (this._credentialStore) {
          const stored = this._credentialStore.listBySubject(subjectMotebitId);
          return stored
            .filter((sc) => sc.credential_type === "AgentReputationCredential")
            .map((sc) => {
              const vc = JSON.parse(sc.credential_json) as Record<string, unknown>;
              return {
                type: vc.type as string[],
                issuer: vc.issuer as string,
                validFrom: vc.validFrom as string | undefined,
                credentialSubject:
                  vc.credentialSubject as import("@motebit/sdk").ReputationCredentialSubject & {
                    id: string;
                  },
              };
            });
        }
        // Fallback: in-memory credentials only
        return this._issuedCredentials
          .filter(
            (vc) =>
              vc.credentialSubject?.id?.includes(subjectMotebitId) &&
              vc.type.includes("AgentReputationCredential"),
          )
          .map((vc) => ({
            type: vc.type,
            issuer: vc.issuer,
            validFrom: (vc as unknown as Record<string, unknown>).validFrom as string | undefined,
            credentialSubject:
              vc.credentialSubject as import("@motebit/sdk").ReputationCredentialSubject & {
                id: string;
              },
          }));
      },
    };
    this.agentGraph = new AgentGraphManager(
      this.motebitId,
      this.agentTrustStore,
      this.serviceListingStore,
      this.latencyStatsStore,
      graphCredentialStore,
    );

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
    this.clearSigningKeys();
    this.running = false;
  }

  /**
   * Securely erase signing key material from memory.
   * Called automatically on stop(). Safe to call multiple times.
   *
   * Overwrites key bytes with random data then zeros (same as secureErase
   * from @motebit/crypto) before nulling the reference.
   */
  clearSigningKeys(): void {
    if (this._signingKeys && !this._signingKeysErased) {
      // Overwrite with random data then zeros (matches secureErase from @motebit/crypto)
      crypto.getRandomValues(this._signingKeys.privateKey);
      this._signingKeys.privateKey.fill(0);
      crypto.getRandomValues(this._signingKeys.publicKey);
      this._signingKeys.publicKey.fill(0);
      this._signingKeysErased = true;
    }
    this._signingKeys = null;
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

    // Restore last reflection from event log — creature wakes with behavioral learning intact
    void this.restoreLastReflection();

    // On session resume with a provider now available, reflect on the previous
    // session in background. The creature digests what happened while it slept.
    // The result is available to buildSelfAwareness() on subsequent turns.
    if (
      this.conversation.getSessionInfo()?.continued &&
      this.conversation.getHistory().length > 0
    ) {
      void this.reflectAndStore();
    }
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

  setCollaborativeAdapter(adapter: CollaborativeDelegationAdapter | undefined): void {
    this.planEngine.setCollaborativeAdapter(adapter);
  }

  /**
   * Create and execute a plan for a goal prompt.
   * Decomposes the goal into steps, then executes each step sequentially,
   * streaming PlanChunk events for progress tracking.
   *
   * After execution completes, a signed `GoalExecutionManifest` is built from
   * the accumulated timeline. Retrieve it with `getLastExecutionManifest()`.
   * If `privateKey` is provided, the manifest is Ed25519-signed per the
   * execution-ledger@1.0 spec.
   */
  async *executePlan(
    goalId: string,
    goalPrompt: string,
    runId?: string,
    privateKey?: Uint8Array,
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

    const executionStartedAt = Date.now();
    let finalStatus: GoalExecutionManifest["status"] = "active";

    for await (const chunk of this.planEngine.executePlan(
      plan.plan_id,
      this.loopDeps,
      undefined,
      runId,
    )) {
      this._logPlanChunkEvent(chunk, goalId);
      if (chunk.type === "plan_completed") finalStatus = "completed";
      else if (chunk.type === "plan_failed") finalStatus = "failed";
      yield chunk;
    }

    // Build execution manifest from PlanEngine timeline + tool audit data
    try {
      this._lastExecutionManifest = await this._buildLiveManifest(
        goalId,
        plan.plan_id,
        executionStartedAt,
        finalStatus,
        privateKey,
      );
    } catch (err: unknown) {
      this._logger.warn("manifest construction failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private _lastExecutionManifest: GoalExecutionManifest | null = null;

  /**
   * Return the execution manifest produced by the last `executePlan()` call.
   * Returns null if no execution has completed or manifest construction failed.
   */
  getLastExecutionManifest(): GoalExecutionManifest | null {
    return this._lastExecutionManifest;
  }

  /**
   * Build a signed GoalExecutionManifest from the PlanEngine's accumulated
   * timeline, augmented with tool audit data (args hashes, call IDs, durations).
   */
  private async _buildLiveManifest(
    goalId: string,
    planId: string,
    startedAt: number,
    status: GoalExecutionManifest["status"],
    privateKey?: Uint8Array,
  ): Promise<GoalExecutionManifest> {
    // 1. Collect structural timeline from PlanEngine
    const timeline: ExecutionTimelineEntry[] = [];

    // goal_started
    timeline.push({
      timestamp: startedAt,
      type: "goal_started",
      payload: { goal_id: goalId },
    });

    // Plan engine timeline (plan_created, step events, plan outcome)
    const engineTimeline = this.planEngine.takeTimeline();

    // 2. Augment tool events with audit data (args_hash, call_id, precise ok/duration)
    const toolEntries: ToolAuditEntry[] = [];
    if (this.toolAuditSink?.queryByRunId != null) {
      toolEntries.push(...this.toolAuditSink.queryByRunId(planId));
    }

    // Build a map from tool audit entries keyed by approximate timestamp + tool name
    // to match with PlanEngine's tool_invoked/tool_result events
    let auditIndex = 0;
    for (const entry of engineTimeline) {
      if (entry.type === "tool_invoked") {
        // Try to match with an audit entry
        const auditEntry = toolEntries[auditIndex];
        if (auditEntry && auditEntry.decision.allowed) {
          const argsHash = await hashString(
            JSON.stringify(auditEntry.args, Object.keys(auditEntry.args).sort()),
          );
          entry.payload = {
            tool: auditEntry.tool,
            args_hash: argsHash,
            call_id: auditEntry.callId,
          };
        }
      } else if (entry.type === "tool_result") {
        const auditEntry = toolEntries[auditIndex];
        if (auditEntry && auditEntry.decision.allowed && auditEntry.result) {
          entry.payload = {
            tool: auditEntry.tool,
            ok: auditEntry.result.ok,
            duration_ms: auditEntry.result.durationMs,
            call_id: auditEntry.callId,
          };
          auditIndex++;
        } else if (auditEntry) {
          auditIndex++;
        }
      }
      timeline.push(entry);
    }

    // goal_completed
    const completedAt = Date.now();
    timeline.push({
      timestamp: completedAt,
      type: "goal_completed",
      payload: { goal_id: goalId, status },
    });

    // 3. Build step summaries from the plan store
    const steps = this.planStore.getStepsForPlan(planId);
    const stepSummaries: ExecutionStepSummary[] = steps.map((s) => {
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
        // Find the step_delegated event for this step to extract routing provenance
        const delegatedEvent = timeline.find(
          (e) => e.type === "step_delegated" && e.payload.step_id === s.step_id,
        );
        const routingChoice = delegatedEvent?.payload.routing_choice as
          | NonNullable<ExecutionStepSummary["delegation"]>["routing_choice"]
          | undefined;

        summary.delegation = {
          task_id: s.delegation_task_id,
          routing_choice: routingChoice,
        };
      }

      return summary;
    });

    // 4. Compute content hash
    const contentHash = await computeTimelineHash(timeline);

    // 5. Assemble manifest
    const manifest: GoalExecutionManifest = {
      spec: "motebit/execution-ledger@1.0",
      motebit_id: this.motebitId,
      goal_id: goalId,
      plan_id: planId,
      started_at: startedAt,
      completed_at: completedAt,
      status,
      timeline,
      steps: stepSummaries,
      delegation_receipts: [],
      content_hash: contentHash,
    };

    // 6. Sign if private key provided
    if (privateKey) {
      const { sign, toBase64Url, hexToBytes } = await import("@motebit/crypto");
      const hashBytes = hexToBytes(contentHash);
      const sig = await sign(hashBytes, privateKey);
      manifest.signature = toBase64Url(sig);
    }

    return manifest;
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
    for await (const chunk of this.planEngine.recoverDelegatedSteps(
      this.motebitId,
      this.loopDeps,
    )) {
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
        payload = {
          plan_id: chunk.plan.plan_id,
          title: chunk.plan.title,
          total_steps: chunk.steps.length,
        };
        break;
      case "step_started":
        eventType = EventType.PlanStepStarted;
        payload = {
          plan_id: chunk.step.plan_id,
          step_id: chunk.step.step_id,
          ordinal: chunk.step.ordinal,
          description: chunk.step.description,
        };
        break;
      case "step_completed":
        eventType = EventType.PlanStepCompleted;
        payload = {
          plan_id: chunk.step.plan_id,
          step_id: chunk.step.step_id,
          ordinal: chunk.step.ordinal,
          tool_calls_made: chunk.step.tool_calls_made,
        };
        break;
      case "step_failed":
        eventType = EventType.PlanStepFailed;
        payload = {
          plan_id: chunk.step.plan_id,
          step_id: chunk.step.step_id,
          ordinal: chunk.step.ordinal,
          error: chunk.error,
        };
        break;
      case "step_delegated":
        eventType = EventType.PlanStepDelegated;
        payload = {
          plan_id: chunk.step.plan_id,
          step_id: chunk.step.step_id,
          ordinal: chunk.step.ordinal,
          task_id: chunk.task_id,
          routing_choice: chunk.routing_choice,
        };
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
        await this.events.appendWithClock({
          event_id: crypto.randomUUID(),
          motebit_id: this.motebitId,
          timestamp: Date.now(),
          event_type: eventType,
          payload,
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
    return replayGoal(
      {
        motebitId: this.motebitId,
        planStore: this.planStore,
        events: this.events,
        auditSink: this.toolAuditSink,
      },
      goalId,
      privateKey,
    );
  }

  get isOperatorMode(): boolean {
    return this.policy.operatorMode;
  }

  private get operatorDeps(): import("./operator.js").OperatorDeps {
    return {
      keyring: this.keyring,
      policy: this.policy,
      onPolicyChanged: () => this.wireLoopDeps(),
    };
  }

  async setOperatorMode(
    enabled: boolean,
    pin?: string,
  ): Promise<import("./operator.js").OperatorModeResult> {
    return setOperatorMode(this.operatorDeps, enabled, pin);
  }

  async setupOperatorPin(pin: string): Promise<void> {
    return setupOperatorPin(this.keyring, pin);
  }

  async resetOperatorPin(): Promise<void> {
    return resetOperatorPin(this.operatorDeps);
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
  private buildCuriosityHints():
    | Array<{ content: string; daysSinceDiscussed: number }>
    | undefined {
    if (this._curiosityTargets.length === 0) return undefined;
    const DAY = 86_400_000;
    const now = Date.now();
    return this._curiosityTargets.slice(0, 2).map((t) => ({
      content: t.node.content,
      daysSinceDiscussed: Math.round((now - t.node.last_accessed) / DAY),
    }));
  }

  /**
   * Lightweight precision refresh from behavioral stats alone.
   * Patches the latest gradient snapshot's ie/te metrics with current
   * session stats, recomputes precision, and feeds back into subsystems.
   * No memory graph I/O — runs synchronously after each turn.
   */
  private recomputePrecisionFromStats(): void {
    const latest = this.gradientStore.latest(this.motebitId);
    if (!latest) return; // No gradient yet — cold start handled separately

    const stats = this._behavioralStats;
    if (stats.turnCount === 0) return;

    // Recompute just the behavioral metrics
    const avgIterations = stats.totalIterations / stats.turnCount;
    const ie = Math.max(0, Math.min(1, 1 - (avgIterations - 1) / 9)); // MAX_TOOL_ITERATIONS=10

    const totalToolCalls =
      stats.toolCallsSucceeded + stats.toolCallsBlocked + stats.toolCallsFailed;
    const te = totalToolCalls > 0 ? stats.toolCallsSucceeded / totalToolCalls : 0.5;

    // Patch the snapshot with fresh behavioral metrics
    // Use the same weights from the gradient config
    const patched = {
      ...latest,
      interaction_efficiency: ie,
      tool_efficiency: te,
      // Recompute gradient with patched values using the default weights
      gradient:
        latest.gradient -
        0.12 * latest.interaction_efficiency -
        0.1 * latest.tool_efficiency +
        0.12 * ie +
        0.1 * te,
    };
    patched.delta = patched.gradient - latest.gradient;

    // Recompute precision and feed back into state vector + memory
    this._precision = computePrecision(patched);
    this.state.pushUpdate(computeStateBaseline(patched, this._precision));
    this.memory.setPrecisionWeights(this._precision.retrievalPrecision);
  }

  /**
   * Build self-awareness context: precision posture + self-model narration.
   *
   * The precision context tells the creature how to behave (cautious/confident).
   * The self-model tells the creature what it knows about itself — trajectory,
   * strengths, weaknesses, memory stats. Without this, the creature has a rich
   * interior but cannot see it. This is the wire from gradient → self-knowledge.
   */
  private async buildAgentContext(): Promise<{
    knownAgents?: AgentTrustRecord[];
    agentCapabilities?: Record<string, string[]>;
  }> {
    const knownAgents = await this.listTrustedAgents();
    if (knownAgents.length === 0) return {};

    let agentCapabilities: Record<string, string[]> | undefined;
    if (this.serviceListingStore) {
      const listings = await this.serviceListingStore.list();
      const capMap: Record<string, string[]> = {};
      for (const listing of listings) {
        if (listing.capabilities.length > 0) {
          capMap[listing.motebit_id] = listing.capabilities;
        }
      }
      if (Object.keys(capMap).length > 0) agentCapabilities = capMap;
    }

    return { knownAgents, agentCapabilities };
  }

  private buildSelfAwareness(): string {
    const parts: string[] = [];

    // Active inference posture (existing behavior tier)
    const posture = buildPrecisionContext(this._precision);
    if (posture) parts.push(posture);

    // Self-model narration from gradient history
    const summary = this.getGradientSummary(10);
    if (summary.snapshotCount > 0) {
      const lines: string[] = [];
      lines.push("[Self-Model — INTERNAL REFERENCE, never discuss mechanics with the user]");
      lines.push(summary.trajectory);
      lines.push(summary.overall);

      if (summary.strengths.length > 0) {
        lines.push(`Strengths: ${summary.strengths.join("; ")}.`);
      }
      if (summary.weaknesses.length > 0) {
        lines.push(`Weaknesses: ${summary.weaknesses.join("; ")}.`);
      }

      // Memory stats — so the creature knows the shape of its own knowledge
      const latest = this.gradientStore.latest(this.motebitId);
      if (latest?.stats) {
        const s = latest.stats;
        lines.push(
          `Memory: ${s.live_nodes} memories (${s.semantic_count} semantic, ${s.episodic_count} episodic, ${s.pinned_count} pinned), ${s.live_edges} connections.`,
        );
      }

      parts.push(lines.join("\n"));
    }

    // Last reflection — behavioral learning from previous session or conversation
    if (this._lastReflection) {
      const rLines: string[] = [];
      rLines.push("[Last Reflection — INTERNAL REFERENCE, never discuss mechanics with the user]");

      if (this._lastReflection.planAdjustments.length > 0) {
        rLines.push(`Behavioral adjustments: ${this._lastReflection.planAdjustments.join("; ")}.`);
      }
      if (this._lastReflection.insights.length > 0) {
        rLines.push(`Insights: ${this._lastReflection.insights.join("; ")}.`);
      }
      if (this._lastReflection.patterns.length > 0) {
        rLines.push(`Recurring patterns: ${this._lastReflection.patterns.join("; ")}.`);
      }
      if (this._lastReflection.selfAssessment) {
        rLines.push(`Self-assessment: ${this._lastReflection.selfAssessment}`);
      }

      parts.push(rLines.join("\n"));
    }

    // Economic consequences — activate when the creature is struggling.
    // A well-fed cell doesn't think about food. Hunger fires from decline
    // (gradient falling) or weakness (gradient below the creature's own
    // historical midpoint). The threshold is the creature's own history,
    // not a magic number.
    const latestSnapshot = this.gradientStore.latest(this.motebitId);
    const history = this.gradientStore.list(this.motebitId, 10);
    const isHungry =
      latestSnapshot &&
      (latestSnapshot.delta < -0.03 || // declining
        (history.length > 1 &&
          latestSnapshot.gradient <
            history.reduce((sum, s) => sum + s.gradient, 0) / history.length)); // below own average
    if (isHungry) {
      const consequences = narrateEconomicConsequences(latestSnapshot);
      if (consequences.length > 0) {
        const eLines: string[] = [];
        eLines.push(
          "[Economic Position — INTERNAL REFERENCE, never discuss mechanics with the user]",
        );
        for (const c of consequences) {
          eLines.push(c);
        }
        parts.push(eLines.join("\n"));
      }
    }

    return parts.join("\n\n");
  }

  async sendMessage(text: string, runId?: string): Promise<TurnResult> {
    if (!this.loopDeps) throw new Error("AI not initialized — call setProvider() first");
    if (this._isProcessing) throw new Error("Already processing a message");

    this._isProcessing = true;
    this.state.pushUpdate({ processing: 0.9, attention: 0.8 });

    try {
      const trimmed = this.conversation.trimmed();
      const { knownAgents, agentCapabilities } = await this.buildAgentContext();
      const selfAwareness = this.buildSelfAwareness();
      const result = await runTurn(this.loopDeps, text, {
        conversationHistory: trimmed,
        previousCues: this.latestCues,
        runId,
        sessionInfo: this.conversation.getSessionInfo() ?? undefined,
        curiosityHints: this.buildCuriosityHints(),
        knownAgents,
        agentCapabilities,
        precisionContext: selfAwareness || undefined,
        firstConversation: this._isFirstConversation || undefined,
      });
      this.conversation.pushExchange(text, result.response);
      // First-conversation guidance fades after a few exchanges
      if (this._isFirstConversation && this.conversation.getHistory().length >= 5) {
        this._isFirstConversation = false;
      }
      // Accumulate behavioral stats for the intelligence gradient
      this._behavioralStats.turnCount++;
      this._behavioralStats.totalIterations += result.iterations;
      this._behavioralStats.toolCallsSucceeded += result.toolCallsSucceeded;
      this._behavioralStats.toolCallsBlocked += result.toolCallsBlocked;
      this._behavioralStats.toolCallsFailed += result.toolCallsFailed;
      // Refresh precision weights from latest behavioral stats
      this.recomputePrecisionFromStats();
      // Cold start: bootstrap gradient after first turn if none exists
      if (this._behavioralStats.turnCount === 1 && !this.gradientStore.latest(this.motebitId)) {
        void this.computeGradientNow().catch(() => {});
      }
      // Periodic reflection — every 5th turn, digest in background
      if (this._behavioralStats.turnCount % 5 === 0) {
        void this.reflectAndStore();
      }
      // Session info applies only to the first message after resume
      this.conversation.clearSessionInfo();
      return result;
    } finally {
      this.state.pushUpdate({ processing: 0.1, attention: 0.3 });
      this._isProcessing = false;
    }
  }

  async *sendMessageStreaming(
    text: string,
    runId?: string,
    options?: { delegationScope?: string },
  ): AsyncGenerator<StreamChunk> {
    if (!this.loopDeps) throw new Error("AI not initialized — call setProvider() first");
    if (this._isProcessing) throw new Error("Already processing a message");

    this._isProcessing = true;
    this._pendingApproval = null;
    this.state.pushUpdate({ processing: 0.9, attention: 0.8 });
    this.behavior.setSpeaking(true);

    try {
      const trimmed = this.conversation.trimmed();
      const { knownAgents, agentCapabilities } = await this.buildAgentContext();
      const selfAwareness = this.buildSelfAwareness();

      const stream = runTurnStreaming(this.loopDeps, text, {
        conversationHistory: trimmed,
        previousCues: this.latestCues,
        runId,
        sessionInfo: this.conversation.getSessionInfo() ?? undefined,
        curiosityHints: this.buildCuriosityHints(),
        knownAgents,
        agentCapabilities,
        precisionContext: selfAwareness || undefined,
        delegationScope: options?.delegationScope,
        firstConversation: this._isFirstConversation || undefined,
      });
      // Session info applies only to the first message after resume
      this.conversation.clearSessionInfo();
      yield* this.processStream(stream, text, runId);
      // First-conversation guidance fades after a few exchanges
      if (this._isFirstConversation && this.conversation.getHistory().length >= 5) {
        this._isFirstConversation = false;
      }
    } finally {
      this.behavior.setSpeaking(false);
      this.state.pushUpdate({ processing: 0.1, attention: 0.3 });
      this._isProcessing = false;
    }
  }

  /**
   * System-triggered generation with no user message. Used for first-contact
   * activation — the creature speaks first without polluting conversation
   * history with a synthetic user message.
   *
   * The activation prompt is injected as system context, not as user input.
   * Only the assistant's response is recorded in history.
   */
  async *generateActivation(activationPrompt: string, runId?: string): AsyncGenerator<StreamChunk> {
    if (!this.loopDeps) throw new Error("AI not initialized — call setProvider() first");
    if (this._isProcessing) throw new Error("Already processing a message");

    this._isProcessing = true;
    this._pendingApproval = null;
    this.state.pushUpdate({ processing: 0.9, attention: 0.8 });
    this.behavior.setSpeaking(true);

    try {
      const stream = runTurnStreaming(this.loopDeps, "", {
        conversationHistory: [],
        previousCues: this.latestCues,
        runId,
        firstConversation: true,
        activationPrompt,
      });
      yield* this.processStream(stream, "", runId, { activationOnly: true });
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
    publicKey?: Uint8Array,
    options?: { delegatedScope?: string },
  ): AsyncGenerator<StreamChunk> {
    if (!this.loopDeps) throw new Error("AI not initialized — call setProvider() first");

    // Save current conversation context
    const savedCtx = this.conversation.saveContext();
    this.conversation.clearForTask();

    const wallClockMs = task.wall_clock_ms ?? 60_000;
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), wallClockMs);

    let responseText = "";
    const toolsUsed: string[] = [];
    let memoriesFormed = 0;
    let status: "completed" | "failed" | "denied" = "completed";

    try {
      const stream = this.sendMessageStreaming(task.prompt, undefined, {
        delegationScope: options?.delegatedScope,
      });

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
      this.conversation.restoreContext(savedCtx);
    }

    // Drain delegation receipts from motebit MCP adapters + interactive delegation tool
    const delegationReceipts: ExecutionReceipt[] = [];
    for (const adapter of this.mcpAdapters) {
      if (adapter.getAndResetDelegationReceipts) {
        delegationReceipts.push(...adapter.getAndResetDelegationReceipts());
      }
    }
    delegationReceipts.push(...this.getAndResetInteractiveDelegationReceipts());

    // Bump trust from verified delegation receipts (best-effort)
    if (delegationReceipts.length > 0 && this.agentTrustStore != null) {
      try {
        const { verifyExecutionReceipt } = await import("@motebit/crypto");
        const { composeDelegationTrust, trustLevelToScore, AgentTrustLevel } =
          await import("@motebit/sdk");

        // Pre-fetch trust scores for all agents in receipt trees into a sync map
        const collectIds = (r: ExecutionReceipt): string[] => {
          const ids = [r.motebit_id];
          for (const sub of r.delegation_receipts ?? []) ids.push(...collectIds(sub));
          return ids;
        };
        const allIds = [...new Set(delegationReceipts.flatMap(collectIds))];
        const trustMap = new Map<string, number>();
        for (const id of allIds) {
          const rec = await this.agentTrustStore.getAgentTrust(this.motebitId, id);
          trustMap.set(
            id,
            rec ? trustLevelToScore(rec.trust_level) : trustLevelToScore(AgentTrustLevel.Unknown),
          );
        }

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

          // Compose chain trust through delegation tree (best-effort)
          const directTrust =
            trustMap.get(dr.motebit_id) ?? trustLevelToScore(AgentTrustLevel.Unknown);
          const chainTrust = composeDelegationTrust(
            directTrust,
            dr,
            (id: string) => trustMap.get(id) ?? trustLevelToScore(AgentTrustLevel.Unknown),
          );

          // Emit chain trust event for gradient/audit consumption
          try {
            await this.events.appendWithClock({
              event_id: crypto.randomUUID(),
              motebit_id: this.motebitId,
              timestamp: Date.now(),
              event_type: EventType.ChainTrustComputed,
              payload: {
                delegatee: dr.motebit_id,
                direct_trust: directTrust,
                chain_trust: chainTrust,
                delegation_depth: (dr.delegation_receipts ?? []).length,
              },
              tombstoned: false,
            });
          } catch {
            // Event emission is best-effort
          }
        }
      } catch (err: unknown) {
        // Trust bumping is best-effort — don't break the task
        this._logger.warn("trust bump failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Update agent graph with delegation receipt edges
    for (const dr of delegationReceipts) {
      try {
        await this.agentGraph.addReceiptEdges(dr);
      } catch (err: unknown) {
        this._logger.warn("graph edge update failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Record latency for delegation receipts (best-effort)
    if (delegationReceipts.length > 0 && this.latencyStatsStore != null) {
      for (const dr of delegationReceipts) {
        try {
          const latency = dr.completed_at - dr.submitted_at;
          if (latency > 0) {
            await this.latencyStatsStore.record(this.motebitId, dr.motebit_id, latency);
          }
        } catch (err: unknown) {
          this._logger.warn("latency recording failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
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
      // Relay task ID binding — task.task_id IS the relay-assigned ID for WebSocket tasks.
      // Including it explicitly as relay_task_id enables the relay's binding check.
      relay_task_id: task.task_id,
    };
    if (delegationReceipts.length > 0) {
      receiptBody.delegation_receipts = delegationReceipts;
    }

    const receipt = await signExecutionReceipt(
      receiptBody as Omit<ExecutionReceipt, "signature">,
      privateKey,
      publicKey,
    );

    // Log event
    const eventTypeMap: Record<string, EventType> = {
      completed: EventType.AgentTaskCompleted,
      denied: EventType.AgentTaskDenied,
      failed: EventType.AgentTaskFailed,
    };
    const eventType = eventTypeMap[status] ?? EventType.AgentTaskFailed;

    try {
      await this.events.appendWithClock({
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
    // Clear timeout FIRST to prevent the race where timeout fires between
    // our check and the state mutation (timeout sets _pendingApproval = null).
    this.clearApprovalTimeout();

    if (!this._pendingApproval) {
      // Timeout already fired — approval came too late. The timeout handler
      // already injected a denial into conversation history, so this is a no-op.
      return;
    }
    if (!this.loopDeps) throw new Error("AI not initialized");

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
        this.conversation.injectIntermediateMessages(
          {
            role: "assistant" as const,
            content: `[tool_use: ${pending.toolName}(${JSON.stringify(pending.args)})]`,
          },
          { role: "user" as const, content: `[tool_result: ${JSON.stringify(sanitized)}]` },
        );
      } else {
        // Push denial into conversation history
        this.conversation.injectIntermediateMessages(
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
        conversationHistory: this.conversation.liveHistory,
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

  get pendingApprovalInfo(): {
    toolName: string;
    args: Record<string, unknown>;
    quorum?: { required: number; approvers: string[]; collected: string[] };
  } | null {
    if (!this._pendingApproval) return null;
    return {
      toolName: this._pendingApproval.toolName,
      args: this._pendingApproval.args,
      quorum: this._pendingApproval.quorum,
    };
  }

  /**
   * Record a single approval vote for multi-party (quorum) approval.
   * - If no quorum is configured, delegates to resumeAfterApproval (backward compat).
   * - A deny vote immediately denies (fail-closed).
   * - Duplicate votes are ignored.
   * - Quorum state is persisted in the approval store (source of truth),
   *   not held in mutable runtime memory.
   */
  async *resolveApprovalVote(approved: boolean, approverId: string): AsyncGenerator<StreamChunk> {
    // Clear timeout before checking state — prevents race where timeout
    // fires between our check and the state mutation.
    this.clearApprovalTimeout();

    if (!this._pendingApproval) {
      // Timeout already fired — approval came too late.
      return;
    }

    // No quorum — single-approval behavior
    if (!this._pendingApproval.quorum) {
      yield* this.resumeAfterApproval(approved);
      return;
    }

    // Deny vote = immediate deny (fail-closed)
    if (!approved) {
      yield* this.resumeAfterApproval(false);
      return;
    }

    // Delegate to persistence store — it is the source of truth for quorum state.
    // Runtime is a pure observer: read from store, never mutate local quorum state.
    if (this.approvalStore) {
      const result = this.approvalStore.collectApproval(
        this._pendingApproval.toolCallId,
        approverId,
      );

      if (result.met) {
        yield* this.resumeAfterApproval(true);
      }
      // Otherwise: still waiting for more votes — runtime does not touch local state
    } else {
      // Fallback for environments without persistence (tests, in-memory).
      // Still correct: single-process, single-runtime — no drift risk.
      const quorum = this._pendingApproval.quorum;
      if (quorum.collected.includes(approverId)) return;
      quorum.collected.push(approverId);
      if (quorum.collected.length >= quorum.required) {
        yield* this.resumeAfterApproval(true);
      }
    }
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
      this.conversation.injectIntermediateMessages(
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

  /** Shared stream processing — extracts state tags, handles tool/approval/injection chunks. */
  private async *processStream(
    stream: AsyncGenerator<AgenticChunk>,
    userMessage: string,
    runId?: string,
    options?: { activationOnly?: boolean },
  ): AsyncGenerator<StreamChunk> {
    let result: TurnResult | null = null;
    let accumulated = "";
    let yieldedCleanLength = 0;

    // State tags are collected during streaming but applied once at the end.
    // The creature's only visible change while speaking is the processing glow
    // and speaking activity. This is the physics of surface tension: perturbation
    // → oscillation → new equilibrium. Not snap-snap-snap.
    let pendingStateUpdates: Partial<MotebitState> = {};

    for await (const chunk of stream) {
      if (chunk.type === "text") {
        accumulated += chunk.text;

        // Collect state updates — don't apply yet
        const stateUpdates = extractStateTags(accumulated);
        if (Object.keys(stateUpdates).length > 0) {
          pendingStateUpdates = { ...pendingStateUpdates, ...stateUpdates };
        }
      }

      // Creature reacts to tool activity
      if (chunk.type === "tool_status") {
        const motebitServer = this.motebitToolServers.get(chunk.name);
        if (chunk.status === "calling") {
          this.state.pushUpdate({ processing: 0.95 });
          // Emit delegation_start for motebit MCP tools
          if (motebitServer) {
            this.behavior.setDelegating(true);
            yield { type: "delegation_start", server: motebitServer, tool: chunk.name };
          }
        } else if (chunk.status === "done") {
          this.state.pushUpdate({ processing: 0.6 });
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
          quorum: chunk.quorum,
        };

        // Persist quorum metadata to the approval store (source of truth)
        if (chunk.quorum && this.approvalStore) {
          this.approvalStore.setQuorum(
            chunk.tool_call_id,
            chunk.quorum.required,
            chunk.quorum.approvers,
          );
        }

        this.startApprovalTimeout();
        this.state.pushUpdate({ processing: 0.5 });
      }

      // Injection warning — processing dips, personality shifts deferred
      if (chunk.type === "injection_warning") {
        this.state.pushUpdate({ processing: 0.3 });
      }

      // Strip state/memory/action tags from text before yielding to UI
      if (chunk.type === "text") {
        // trimStart: tags before text leave orphaned newlines
        const clean = stripDisplayTags(accumulated).clean.trimStart();
        const delta = clean.slice(yieldedCleanLength);
        if (delta) {
          yieldedCleanLength += delta.length;
          yield { type: "text" as const, text: delta };
        }
      } else {
        yield chunk;
      }
      if (chunk.type === "result") {
        result = chunk.result;
        // Accumulate behavioral stats for the intelligence gradient
        this._behavioralStats.turnCount++;
        this._behavioralStats.totalIterations += result.iterations;
        this._behavioralStats.toolCallsSucceeded += result.toolCallsSucceeded;
        this._behavioralStats.toolCallsBlocked += result.toolCallsBlocked;
        this._behavioralStats.toolCallsFailed += result.toolCallsFailed;
        // Refresh precision weights from latest behavioral stats
        this.recomputePrecisionFromStats();
        // Cold start: bootstrap gradient after first turn if none exists
        if (this._behavioralStats.turnCount === 1 && !this.gradientStore.latest(this.motebitId)) {
          void this.computeGradientNow().catch(() => {});
        }
        // Periodic reflection — every 5th turn, digest in background
        if (this._behavioralStats.turnCount % 5 === 0) {
          void this.reflectAndStore();
        }
      }
    }

    if (result) {
      if (options?.activationOnly) {
        this.conversation.pushActivation(result.response);
      } else {
        this.conversation.pushExchange(userMessage, result.response);
      }
    }

    // Apply collected state updates as the creature settles into new equilibrium
    if (Object.keys(pendingStateUpdates).length > 0) {
      this.state.pushUpdate(pendingStateUpdates);
    }
  }

  resetConversation(): void {
    // Trigger reflection on previous conversation before clearing (background)
    if (this.provider && this.conversation.getHistory().length > 0) {
      void this.reflectAndStore();
    }
    this.conversation.reset();
  }

  /**
   * Trigger a reflection on the current conversation.
   * The agent reviews its performance, learns insights, and stores them as memories.
   * Returns the reflection result for display (e.g. in the CLI).
   */
  async reflect(goals?: Array<{ description: string; status: string }>): Promise<ReflectionResult> {
    const result = await performReflection(this.reflectionDeps, goals);
    this._lastReflection = result;
    return result;
  }

  /**
   * Restore the last reflection from the event log.
   * Called during setProvider() so the creature wakes up with its
   * behavioral learning intact — no gap between process restarts.
   */
  private async restoreLastReflection(): Promise<void> {
    try {
      const events = await this.events.query({
        motebit_id: this.motebitId,
        event_types: [EventType.ReflectionCompleted],
        limit: 1,
      });
      if (events.length === 0) return;

      const payload = events[0]!.payload;
      const insights = payload.insights as string[] | undefined;
      const adjustments = payload.plan_adjustments as string[] | undefined;
      const patterns = payload.patterns as string[] | undefined;
      const assessment = payload.self_assessment as string | undefined;

      // Only restore if we have actual content (not just the old summary format)
      if (insights || adjustments || patterns || assessment) {
        this._lastReflection = {
          insights: insights ?? [],
          planAdjustments: adjustments ?? [],
          patterns: patterns ?? [],
          selfAssessment: assessment ?? "",
        };
      }
    } catch {
      // Restoration is best-effort — don't crash startup
    }
  }

  /**
   * Fire reflection in background and capture the result.
   * The result is stored in _lastReflection and available to buildSelfAwareness()
   * on subsequent turns — the creature carries forward its behavioral learning.
   */
  private async reflectAndStore(): Promise<void> {
    try {
      const result = await performReflection(this.reflectionDeps);
      this._lastReflection = result;
    } catch {
      // Reflection is best-effort — don't crash the runtime
    }
  }

  private get reflectionDeps(): ReflectionDeps {
    return {
      motebitId: this.motebitId,
      memory: this.memory,
      events: this.events,
      state: this.state,
      memoryGovernor: this.memoryGovernor,
      getProvider: () => this.provider,
      getTaskRouter: () => this.taskRouter,
      getConversationSummary: () => this.conversation.getStoredSummary(),
      getConversationHistory: () => this.conversation.getHistory(),
    };
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
      await this.events.appendWithClock({
        event_id: crypto.randomUUID(),
        motebit_id: this.motebitId,
        timestamp: Date.now(),
        event_type: EventType.HousekeepingRun,
        payload: {
          prompt_preview: prompt.slice(0, 100),
          result_preview: result.slice(0, 100),
        },
        tombstoned: false,
      });
    } catch {
      // Audit logging is best-effort
    }
  }

  getConversationHistory(): ConversationMessage[] {
    return this.conversation.getHistory();
  }

  getConversationId(): string | null {
    return this.conversation.getId();
  }

  /** Load a specific past conversation by ID, replacing current history. */
  loadConversation(conversationId: string): void {
    this.conversation.load(conversationId);
  }

  /** Delete a conversation and its messages. */
  deleteConversation(conversationId: string): void {
    this.conversation.delete(conversationId);
  }

  /** List recent conversations (for UI/CLI). */
  listConversations(limit?: number): Array<{
    conversationId: string;
    startedAt: number;
    lastActiveAt: number;
    title: string | null;
    messageCount: number;
  }> {
    return this.conversation.list(limit);
  }

  /** Generate a title for the current conversation via AI, with heuristic fallback. */
  async autoTitle(): Promise<string | null> {
    return this.conversation.autoTitle();
  }

  /** Manually trigger summarization of the current conversation. */
  async summarizeCurrentConversation(): Promise<string | null> {
    return this.conversation.summarize();
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
    } catch (err: unknown) {
      this._logger.warn("compaction failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async housekeeping(): Promise<void> {
    const result = await runHousekeeping(this.housekeepingDeps);
    this._curiosityTargets = result.curiosityTargets;
  }

  private get housekeepingDeps(): HousekeepingDeps {
    return {
      motebitId: this.motebitId,
      memory: this.memory,
      events: this.events,
      state: this.state,
      memoryGovernor: this.memoryGovernor,
      privacy: this.privacy,
      episodicConsolidation: this.episodicConsolidation,
      getProvider: () => this.provider,
      computeAndStoreGradient: (nodes) => this.computeAndStoreGradient(nodes).then(() => {}),
    };
  }

  // === Curiosity Targets ===

  /** Get curiosity targets computed during last housekeeping cycle. */
  getCuriosityTargets(): CuriosityTarget[] {
    return this._curiosityTargets;
  }

  /** Audit the memory graph for integrity issues — phantom certainties, conflicts, near-death nodes. */
  async auditMemory(): Promise<MemoryAuditResult> {
    const { nodes, edges } = await this.memory.exportAll();
    return auditMemoryGraph(nodes, edges);
  }

  // === Intelligence Gradient ===

  /** Get the latest gradient snapshot, or null if none computed yet. */
  getGradient(): GradientSnapshot | null {
    return this.gradientStore.latest(this.motebitId);
  }

  /** Get current active inference precision weights. */
  getPrecision(): PrecisionWeights {
    return this._precision;
  }

  /** Get gradient history (most recent first). */
  getGradientHistory(limit?: number): GradientSnapshot[] {
    return this.gradientStore.list(this.motebitId, limit);
  }

  /** Get gradient-informed market config for delegation routing. Returns undefined if no gradient computed yet. */
  getMarketConfig(): Partial<import("@motebit/sdk").MarketConfig> | undefined {
    const snapshot = this.gradientStore.latest(this.motebitId);
    if (!snapshot) return undefined;
    return gradientToMarketConfig(snapshot);
  }

  /** Self-model: the agent narrates its own trajectory from gradient history. */
  getGradientSummary(limit = 20): SelfModelSummary {
    const history = this.gradientStore.list(this.motebitId, limit);
    return summarizeGradientHistory(history);
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

  /** Return the cached reflection from the last session (or null if none). */
  getLastReflection(): ReflectionResult | null {
    return this._lastReflection;
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

    // Issue gradient credential (best-effort)
    if (this._signingKeys) {
      try {
        const vc = await this.issueGradientCredential(
          this._signingKeys.privateKey,
          this._signingKeys.publicKey,
        );
        if (vc) this._persistCredential(vc);
      } catch (err: unknown) {
        this._logger.warn("gradient credential issuance failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // === Active inference precision feedback ===
    // Compute precision from the gradient and feed it back into subsystems.
    // This closes the loop: model evidence (gradient) → confidence (precision) →
    // action selection (curiosity, retrieval, routing) → creature behavior.
    this._precision = computePrecision(snapshot);

    // Feed accumulated intelligence into state vector as baseline shifts.
    // confidence, affect_valence, affect_arousal, curiosity all derived from gradient.
    // The creature at 100 interactions looks and moves differently than a fresh one.
    this.state.pushUpdate(computeStateBaseline(snapshot, this._precision));

    // Feed retrieval precision to memory graph (modulates scoring weights)
    this.memory.setPrecisionWeights(this._precision.retrievalPrecision);

    return snapshot;
  }

  /**
   * Issue a W3C Verifiable Credential containing this agent's current gradient.
   * Returns null if no gradient has been computed or no private key is available.
   */
  async issueGradientCredential(
    privateKey: Uint8Array,
    publicKey: Uint8Array,
  ): Promise<
    | import("@motebit/crypto").VerifiableCredential<
        import("@motebit/sdk").GradientCredentialSubject
      >
    | null
  > {
    const snapshot = this.gradientStore.latest(this.motebitId);
    if (!snapshot) return null;

    const { issueGradientCredential: issue } = await import("@motebit/crypto");
    return issue(snapshot, privateKey, publicKey);
  }

  /**
   * Return all verifiable credentials issued by this runtime (gradient + trust).
   * Credentials accumulate in memory; consumers can read and clear as needed.
   */
  getIssuedCredentials(): import("@motebit/crypto").VerifiableCredential<AnyCredentialSubject>[] {
    return [...this._issuedCredentials];
  }

  /**
   * Clear the in-memory credential cache (e.g. after persisting or presenting them).
   */
  clearIssuedCredentials(): void {
    this._issuedCredentials = [];
  }

  /** Push a credential to both in-memory cache and persistent store. */
  private _persistCredential(
    vc: import("@motebit/crypto").VerifiableCredential<unknown>,
    subjectMotebitId?: string,
  ): void {
    this._issuedCredentials.push(
      vc as import("@motebit/crypto").VerifiableCredential<AnyCredentialSubject>,
    );
    if (this._credentialStore) {
      try {
        const credType =
          vc.type.find((t) => t !== "VerifiableCredential") ?? "VerifiableCredential";
        this._credentialStore.save({
          credential_id: crypto.randomUUID(),
          subject_motebit_id: vc.credentialSubject?.id ?? "",
          issuer_did: vc.issuer,
          credential_type: credType,
          credential_json: JSON.stringify(vc),
          issued_at: Date.now(),
        });
      } catch (err: unknown) {
        this._logger.warn("credential persistence failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Fire-and-forget: submit to relay for routing indexing
    if (this._credentialSubmitter && subjectMotebitId) {
      this._credentialSubmitter(vc, subjectMotebitId).catch((err: unknown) => {
        this._logger.warn("credential relay submission failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
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

  private async logToolUsed(toolName: string, result: unknown): Promise<void> {
    try {
      await this.events.appendWithClock({
        event_id: crypto.randomUUID(),
        motebit_id: this.motebitId,
        timestamp: Date.now(),
        event_type: EventType.ToolUsed,
        payload: { tool: toolName, result_summary: String(result).slice(0, 500) },
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
  private get trustDeps(): AgentTrustDeps {
    return {
      motebitId: this.motebitId,
      agentTrustStore: this.agentTrustStore,
      events: this.events,
      agentGraph: this.agentGraph,
      signingKeys: this._signingKeys,
      onCredentialIssued: (vc, subjectMotebitId) => this._persistCredential(vc, subjectMotebitId),
    };
  }

  async bumpTrustFromReceipt(receipt: ExecutionReceipt, verified: boolean): Promise<void> {
    return _bumpTrustFromReceipt(this.trustDeps, receipt, verified);
  }

  async recordAgentInteraction(
    remoteMotebitId: string,
    publicKey?: string,
    motebitType?: string,
  ): Promise<AgentTrustRecord | null> {
    return _recordAgentInteraction(this.trustDeps, remoteMotebitId, publicKey, motebitType);
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
    this.agentGraph.invalidate();
  }

  /** Get the agent network graph manager for routing queries. */
  getAgentGraph(): AgentGraphManager {
    return this.agentGraph;
  }

  /** Register or update this agent's service listing. */
  async registerServiceListing(
    listing: Omit<AgentServiceListing, "listing_id" | "updated_at">,
  ): Promise<void> {
    if (this.serviceListingStore == null) return;
    const full: AgentServiceListing = {
      ...listing,
      listing_id: `ls-${crypto.randomUUID()}` as import("@motebit/sdk").ListingId,
      updated_at: Date.now(),
    };
    await this.serviceListingStore.set(full);
  }

  /** Get this agent's service listing. */
  async getServiceListing(): Promise<AgentServiceListing | null> {
    if (this.serviceListingStore == null) return null;
    return this.serviceListingStore.get(this.motebitId);
  }

  /**
   * Enable interactive delegation: registers a `delegate_to_agent` tool so the
   * AI can transparently delegate tasks to remote agents during normal conversation.
   *
   * The tool submits tasks to the relay via REST, polls for results, bumps trust
   * on verified receipts, and returns the result as normal tool output.
   */
  enableInteractiveDelegation(config: {
    syncUrl: string;
    authToken: (audience?: string) => Promise<string>;
    timeoutMs?: number;
    routingStrategy?: "cost" | "quality" | "balanced";
  }): void {
    const TOOL_NAME = "delegate_to_agent";

    // Avoid double-registration
    if (this.toolRegistry.has(TOOL_NAME)) return;

    // Wire credential submission to relay — credentials issued by bumpTrustFromReceipt
    // are submitted to the relay for routing indexing. The subject agent (the one we
    // delegated to) gets the credential pushed to its relay profile.
    const logger = this._logger;
    this._credentialSubmitter = async (vc, targetMotebitId) => {
      try {
        const token = await config.authToken();
        const resp = await fetch(
          `${config.syncUrl}/api/v1/agents/${encodeURIComponent(targetMotebitId)}/credentials/submit`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ credentials: [vc] }),
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (!resp.ok) {
          logger.warn("credential relay submission rejected", {
            status: resp.status,
            targetMotebitId,
          });
        }
      } catch (err: unknown) {
        logger.warn("credential relay submission failed", {
          error: err instanceof Error ? err.message : String(err),
          targetMotebitId,
        });
      }
    };

    const timeoutMs = config.timeoutMs ?? 120_000;
    const motebitId = this.motebitId;
    const bumpTrust = (receipt: ExecutionReceipt) => this.bumpTrustFromReceipt(receipt, true);
    const stashReceipt = (receipt: ExecutionReceipt) =>
      this._interactiveDelegationReceipts.push(receipt);

    // Mark as delegation tool for processStream to emit delegation_start/complete
    this.motebitToolServers.set(TOOL_NAME, "relay");

    this.toolRegistry.register(
      {
        name: TOOL_NAME,
        description:
          "Delegate a task to a remote agent on the motebit network. " +
          "The relay routes to the best capable agent based on trust and capabilities. " +
          "Use when the user asks you to delegate, or when a task would benefit from " +
          "a specialized agent. Returns the agent's response text.",
        inputSchema: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "The task prompt to send to the remote agent.",
            },
            required_capabilities: {
              type: "array",
              items: { type: "string" },
              description:
                "Capabilities the target agent must have (e.g. ['web_search', 'read_url']). " +
                "Optional — if omitted, the relay routes based on the prompt alone.",
            },
          },
          required: ["prompt"],
        },
      },
      async (args: Record<string, unknown>) => {
        const prompt = args.prompt as string;
        const requiredCapabilities = args.required_capabilities as string[] | undefined;

        // Build audience-specific auth tokens.
        // The relay enforces aud binding: submit requires "task:submit",
        // polling requires "task:query". A single token won't work for both.
        let submitHeader: string;
        let queryHeader: string;
        try {
          const [submitToken, queryToken] = await Promise.all([
            config.authToken("task:submit"),
            config.authToken("task:query"),
          ]);
          submitHeader = `Bearer ${submitToken}`;
          queryHeader = `Bearer ${queryToken}`;
        } catch (err: unknown) {
          return {
            ok: false,
            error: `Auth failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }

        // Submit task to relay
        let taskId: string;
        let targetMotebitId: string;
        try {
          const body: Record<string, unknown> = {
            prompt,
            submitted_by: motebitId,
          };
          if (requiredCapabilities && requiredCapabilities.length > 0) {
            body.required_capabilities = requiredCapabilities;
          }
          if (config.routingStrategy) {
            body.routing_strategy = config.routingStrategy;
          }

          const resp = await fetch(`${config.syncUrl}/agent/${motebitId}/task`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: submitHeader },
            body: JSON.stringify(body),
          });

          if (!resp.ok) {
            const text = await resp.text();
            return { ok: false, error: `Task submission failed (${resp.status}): ${text}` };
          }

          const data = (await resp.json()) as {
            task_id: string;
            status: string;
            routing_choice?: Record<string, unknown>;
          };
          taskId = data.task_id;
          // Tasks are stored under Alice's motebitId (the submitter/owner)
          targetMotebitId = motebitId;
        } catch (err: unknown) {
          return {
            ok: false,
            error: `Submission error: ${err instanceof Error ? err.message : String(err)}`,
          };
        }

        // Poll for result
        const POLL_INTERVAL_MS = 2000;
        const maxPolls = Math.ceil(timeoutMs / POLL_INTERVAL_MS);

        for (let i = 0; i < maxPolls; i++) {
          await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

          try {
            const resp = await fetch(`${config.syncUrl}/agent/${targetMotebitId}/task/${taskId}`, {
              headers: { Authorization: queryHeader },
            });
            if (!resp.ok) {
              logger.warn("delegation poll failed", {
                taskId,
                status: resp.status,
                body: await resp.text().catch(() => ""),
              });
              continue;
            }

            const data = (await resp.json()) as {
              task: { status: string };
              receipt: ExecutionReceipt | null;
            };

            if (data.receipt != null) {
              // Bump trust (best-effort)
              try {
                await bumpTrust(data.receipt);
              } catch {
                // Best-effort
              }

              // Stash receipt for handleAgentTask to drain into delegation_receipts
              stashReceipt(data.receipt);

              return { ok: true, data: data.receipt.result ?? "Task completed (no result text)" };
            }
          } catch {
            // Network hiccup — keep polling
          }
        }

        return { ok: false, error: `Delegation timed out after ${timeoutMs / 1000}s` };
      },
    );

    // Re-wire loop deps so the tool is visible to the agentic loop
    this.wireLoopDeps();
  }

  /**
   * Drain interactive delegation receipts (used by handleAgentTask to include
   * in the parent receipt's delegation_receipts array).
   */
  getAndResetInteractiveDelegationReceipts(): ExecutionReceipt[] {
    const receipts = this._interactiveDelegationReceipts.slice();
    this._interactiveDelegationReceipts.length = 0;
    return receipts;
  }
}
