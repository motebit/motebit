import type { MotebitState, BehaviorCues, ConversationMessage, ToolRegistry } from "@motebit/sdk";
import { EventType, SensitivityLevel } from "@motebit/sdk";
import { EventStore, InMemoryEventStore } from "@motebit/event-log";
import type { EventStoreAdapter } from "@motebit/event-log";
import { MemoryGraph, InMemoryMemoryStorage, embedText } from "@motebit/memory-graph";
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
}

// === Stream Chunk ===

export type StreamChunk =
  | { type: "text"; text: string }
  | { type: "tool_status"; name: string; status: "calling" | "done"; result?: unknown }
  | { type: "approval_request"; tool_call_id: string; name: string; args: Record<string, unknown>; risk_level?: number }
  | { type: "injection_warning"; tool_name: string; patterns: string[] }
  | { type: "result"; result: TurnResult };

// === Operator Mode Result ===

export interface OperatorModeResult {
  success: boolean;
  needsSetup?: boolean;
  error?: string;
}

const OPERATOR_PIN_KEY = "operator_pin_hash";

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
  } | null = null;

  constructor(config: RuntimeConfig, adapters: PlatformAdapters) {
    this.motebitId = config.motebitId;
    this.maxHistory = config.maxConversationHistory ?? 40;
    this.compactionThreshold = config.compactionThreshold ?? 1000;
    this.mcpConfigs = config.mcpServers ?? [];
    this.summarizeAfterMessages = config.summarizeAfterMessages ?? 20;
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
      if (saved) {
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
              role: msg.role as "user" | "assistant",
              content: msg.content,
            });
          }
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
  async *executePlan(goalId: string, goalPrompt: string): AsyncGenerator<PlanChunk> {
    if (!this.loopDeps) throw new Error("AI not initialized — call setProvider() first");

    const availableTools = this.toolRegistry.size > 0
      ? this.toolRegistry.list().map((t) => t.name)
      : undefined;

    const plan = await this.planEngine.createPlan(
      goalId,
      this.motebitId,
      { goalPrompt, availableTools },
      this.loopDeps,
    );

    yield* this.planEngine.executePlan(plan.plan_id, this.loopDeps);
  }

  /**
   * Resume an existing plan that was paused (e.g. waiting for approval).
   * Streams PlanChunk events starting from where the plan left off.
   */
  async *resumePlan(planId: string): AsyncGenerator<PlanChunk> {
    if (!this.loopDeps) throw new Error("AI not initialized — call setProvider() first");
    yield* this.planEngine.resumePlan(planId, this.loopDeps);
  }

  get isOperatorMode(): boolean {
    return this.policy.operatorMode;
  }

  /**
   * Enable/disable operator mode with PIN authentication.
   * Disabling never requires a PIN (safe direction).
   * If no keyring is available, falls through (dev mode).
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
    if (!storedHash) {
      return { success: false, needsSetup: true };
    }

    // PIN is required
    if (!pin) {
      return { success: false, error: "PIN required" };
    }

    const inputHash = await hashPin(pin);
    if (inputHash !== storedHash) {
      return { success: false, error: "Incorrect PIN" };
    }

    this.policy.setOperatorMode(true);
    this.wireLoopDeps();
    return { success: true };
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

  async sendMessage(text: string): Promise<TurnResult> {
    if (!this.loopDeps) throw new Error("AI not initialized — call setProvider() first");
    if (this._isProcessing) throw new Error("Already processing a message");

    this._isProcessing = true;
    this.state.pushUpdate({ processing: 0.9, attention: 0.8 });

    try {
      const trimmed = this.trimHistory();
      const result = await runTurn(this.loopDeps, text, {
        conversationHistory: trimmed,
        previousCues: this.latestCues,
      });
      this.pushToHistory(text, result.response);
      return result;
    } finally {
      this.state.pushUpdate({ processing: 0.1, attention: 0.3 });
      this._isProcessing = false;
    }
  }

  async *sendMessageStreaming(text: string): AsyncGenerator<StreamChunk> {
    if (!this.loopDeps) throw new Error("AI not initialized — call setProvider() first");
    if (this._isProcessing) throw new Error("Already processing a message");

    this._isProcessing = true;
    this._pendingApproval = null;
    this.state.pushUpdate({ processing: 0.9, attention: 0.8 });

    try {
      const trimmed = this.trimHistory();
      const stream = runTurnStreaming(this.loopDeps, text, {
        conversationHistory: trimmed,
        previousCues: this.latestCues,
      });
      yield* this.processStream(stream, text);
    } finally {
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

    const pending = this._pendingApproval;
    this._pendingApproval = null;
    this._isProcessing = true;
    this.state.pushUpdate({ processing: 0.9, attention: 0.8 });

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
      });
      yield* this.processStream(stream, pending.userMessage);
    } finally {
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

  /** Shared stream processing — extracts state tags, actions, handles tool/approval/injection chunks. */
  private async *processStream(
    stream: AsyncGenerator<AgenticChunk>,
    userMessage: string,
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

      // Approval request: capture pending state before yielding
      if (chunk.type === "approval_request") {
        this._pendingApproval = {
          toolCallId: chunk.tool_call_id,
          toolName: chunk.name,
          args: chunk.args,
          userMessage,
        };
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
  async reflect(): Promise<ReflectionResult> {
    if (!this.provider) throw new Error("No AI provider configured");

    const summary = this.conversationId && this.conversationStore
      ? this.conversationStore.getActiveConversation(this.motebitId)?.summary ?? null
      : null;

    const recentMemories = await this.memory.exportAll();
    const memories = recentMemories.nodes
      .slice(0, 10)
      .map((n) => ({ content: n.content }));

    const result = await aiReflect(
      summary,
      this.conversationHistory,
      [], // Goals are managed at the CLI/daemon level, not here
      memories,
      this.provider,
    );

    // Store insights as memories
    await this.storeReflectionInsights(result);

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
      } catch {
        // Memory formation is best-effort during reflection
      }
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
          role: msg.role as "user" | "assistant",
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
    const summary = this.conversationId && this.conversationStore
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
    if (this.conversationStore) {
      if (!this.conversationId) {
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
      this.conversationStore &&
      this.conversationId &&
      shouldSummarize(this.conversationHistory.length, this.summarizeAfterMessages)
    ) {
      void this.runSummarization();
    }
  }

  private async runSummarization(): Promise<void> {
    if (!this.provider || !this.conversationStore || !this.conversationId) return;
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
