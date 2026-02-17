import type { MotebitState, BehaviorCues, ConversationMessage, ToolRegistry } from "@motebit/sdk";
import { EventType } from "@motebit/sdk";
import { EventStore, InMemoryEventStore } from "@motebit/event-log";
import type { EventStoreAdapter } from "@motebit/event-log";
import { MemoryGraph, InMemoryMemoryStorage } from "@motebit/memory-graph";
import type { MemoryStorageAdapter } from "@motebit/memory-graph";
import { StateVectorEngine } from "@motebit/state-vector";
import { BehaviorEngine } from "@motebit/behavior-engine";
import { IdentityManager, InMemoryIdentityStorage } from "@motebit/core-identity";
import type { IdentityStorage } from "@motebit/core-identity";
import { PrivacyLayer, InMemoryAuditLog } from "@motebit/privacy-layer";
import type { AuditLogAdapter } from "@motebit/privacy-layer";
import { SyncEngine } from "@motebit/sync-engine";
import type { RenderSpec } from "@motebit/sdk";
import { CANONICAL_SPEC } from "@motebit/render-engine";
import type { RenderAdapter, RenderFrame } from "@motebit/render-engine";
import {
  runTurn,
  runTurnStreaming,
  extractStateTags,
  extractActions,
  actionsToStateUpdates,
} from "@motebit/ai-core";
import type {
  StreamingProvider,
  MotebitLoopDependencies,
  TurnResult,
} from "@motebit/ai-core";
import { InMemoryToolRegistry } from "@motebit/tools";
import type { McpServerConfig } from "@motebit/mcp-client";
import { connectMcpServers, McpClientAdapter } from "@motebit/mcp-client";
import { PolicyGate, MemoryGovernor } from "@motebit/policy";
import type { PolicyConfig, MemoryGovernanceConfig } from "@motebit/policy";

// Re-export key types for consumers
export type { TurnResult, AgenticChunk } from "@motebit/ai-core";
export type { StreamingProvider } from "@motebit/ai-core";
export type { MotebitState, BehaviorCues, ToolRegistry, ConversationMessage } from "@motebit/sdk";
export type { EventStoreAdapter } from "@motebit/event-log";
export type { MemoryStorageAdapter } from "@motebit/memory-graph";
export type { IdentityStorage } from "@motebit/core-identity";
export type { AuditLogAdapter } from "@motebit/privacy-layer";
export type { RenderAdapter, RenderFrame } from "@motebit/render-engine";
export type { RenderSpec } from "@motebit/sdk";
export type { McpServerConfig } from "@motebit/mcp-client";
export { InMemoryToolRegistry } from "@motebit/tools";
export { PolicyGate } from "@motebit/policy";
export type { PolicyConfig, MemoryGovernanceConfig } from "@motebit/policy";

// === Platform Adapter Interfaces ===

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
}

// === Stream Chunk ===

export type StreamChunk =
  | { type: "text"; text: string }
  | { type: "tool_status"; name: string; status: "calling" | "done"; result?: unknown }
  | { type: "approval_request"; tool_call_id: string; name: string; args: Record<string, unknown> }
  | { type: "result"; result: TurnResult };

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
  readonly policy: PolicyGate;
  readonly memoryGovernor: MemoryGovernor;

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
  private toolRegistry: InMemoryToolRegistry;
  private mcpAdapters: McpClientAdapter[] = [];
  private mcpConfigs: McpServerConfig[];

  constructor(config: RuntimeConfig, adapters: PlatformAdapters) {
    this.motebitId = config.motebitId;
    this.maxHistory = config.maxConversationHistory ?? 40;
    this.compactionThreshold = config.compactionThreshold ?? 1000;
    this.mcpConfigs = config.mcpServers ?? [];
    this.renderer = adapters.renderer;
    this.provider = adapters.ai ?? null;
    this.stateSnapshot = adapters.storage.stateSnapshot;

    // Tool registry: merge platform-provided tools if any
    this.toolRegistry = new InMemoryToolRegistry();
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
    this.policy = new PolicyGate(config.policy);
    this.memoryGovernor = new MemoryGovernor(config.memoryGovernance);

    // Restore saved state
    if (this.stateSnapshot) {
      const saved = this.stateSnapshot.loadState(this.motebitId);
      if (saved) {
        this.state.deserialize(saved);
      }
    }

    this.wireLoopDeps();
  }

  // === Lifecycle ===

  async init(target?: unknown): Promise<void> {
    await this.renderer.init(target);

    // Connect to MCP servers and discover their tools
    if (this.mcpConfigs.length > 0) {
      this.mcpAdapters = await connectMcpServers(this.mcpConfigs, this.toolRegistry);
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
  getToolRegistry(): InMemoryToolRegistry {
    return this.toolRegistry;
  }

  get isOperatorMode(): boolean {
    return this.policy.operatorMode;
  }

  setOperatorMode(enabled: boolean): void {
    this.policy.setOperatorMode(enabled);
    this.wireLoopDeps();
  }

  async sendMessage(text: string): Promise<TurnResult> {
    if (!this.loopDeps) throw new Error("AI not initialized — call setProvider() first");
    if (this._isProcessing) throw new Error("Already processing a message");

    this._isProcessing = true;
    this.state.pushUpdate({ processing: 0.9, attention: 0.8 });

    try {
      const result = await runTurn(this.loopDeps, text, {
        conversationHistory: this.conversationHistory,
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
    this.state.pushUpdate({ processing: 0.9, attention: 0.8 });

    try {
      let result: TurnResult | null = null;
      let accumulated = "";
      const appliedActions = new Set<string>();

      for await (const chunk of runTurnStreaming(this.loopDeps, text, {
        conversationHistory: this.conversationHistory,
        previousCues: this.latestCues,
      })) {
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
            // Reaching out: processing spikes, glow intensifies
            this.state.pushUpdate({ processing: 0.95, attention: 0.9, curiosity: 0.7 });
          } else if (chunk.status === "done") {
            // Absorbing results: processing eases, confidence shifts
            this.state.pushUpdate({ processing: 0.6, confidence: 0.7 });
            void this.logToolUsed(chunk.name, chunk.result);
          }
        }

        // Approval request: the creature pauses, surface tension holds
        if (chunk.type === "approval_request") {
          this.state.pushUpdate({ processing: 0.5, attention: 0.95, affect_arousal: 0.2 });
        }

        yield chunk;
        if (chunk.type === "result") result = chunk.result;
      }

      if (result) {
        this.pushToHistory(text, result.response);
      }
    } finally {
      this.state.pushUpdate({ processing: 0.1, attention: 0.3 });
      this._isProcessing = false;
    }
  }

  resetConversation(): void {
    this.conversationHistory = [];
  }

  getConversationHistory(): ConversationMessage[] {
    return [...this.conversationHistory];
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

  private pushToHistory(userMessage: string, assistantResponse: string): void {
    this.conversationHistory.push(
      { role: "user", content: userMessage },
      { role: "assistant", content: assistantResponse },
    );
    if (this.conversationHistory.length > this.maxHistory) {
      this.conversationHistory = this.conversationHistory.slice(-this.maxHistory);
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
