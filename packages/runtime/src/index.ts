import type { MotebitState, BehaviorCues } from "@motebit/sdk";
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

// Re-export key types for consumers
export type { TurnResult } from "@motebit/ai-core";
export type { StreamingProvider } from "@motebit/ai-core";
export type { MotebitState, BehaviorCues } from "@motebit/sdk";
export type { EventStoreAdapter } from "@motebit/event-log";
export type { MemoryStorageAdapter } from "@motebit/memory-graph";
export type { IdentityStorage } from "@motebit/core-identity";
export type { AuditLogAdapter } from "@motebit/privacy-layer";
export type { RenderAdapter, RenderFrame } from "@motebit/render-engine";
export type { RenderSpec } from "@motebit/sdk";

// === Platform Adapter Interfaces ===

export interface StateSnapshotAdapter {
  saveState(motebitId: string, stateJson: string): void;
  loadState(motebitId: string): string | null;
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
}

// === Stream Chunk ===

export type StreamChunk =
  | { type: "text"; text: string }
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

  private renderer: RenderAdapter;
  private provider: StreamingProvider | null;
  private loopDeps: MotebitLoopDependencies | null = null;
  private conversationHistory: { role: "user" | "assistant"; content: string }[] = [];
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
  private running = false;

  constructor(config: RuntimeConfig, adapters: PlatformAdapters) {
    this.motebitId = config.motebitId;
    this.maxHistory = config.maxConversationHistory ?? 40;
    this.renderer = adapters.renderer;
    this.provider = adapters.ai ?? null;
    this.stateSnapshot = adapters.storage.stateSnapshot;

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

    // Restore saved state
    if (this.stateSnapshot) {
      const saved = this.stateSnapshot.loadState(this.motebitId);
      if (saved) {
        this.state.deserialize(saved);
      }
    }

    // Wire AI loop deps if provider present
    if (this.provider) {
      this.loopDeps = {
        motebitId: this.motebitId,
        eventStore: this.events,
        memoryGraph: this.memory,
        stateEngine: this.state,
        behaviorEngine: this.behavior,
        provider: this.provider,
      };
    }
  }

  // === Lifecycle ===

  async init(target?: unknown): Promise<void> {
    await this.renderer.init(target);
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
    if (this.stateSnapshot) {
      this.stateSnapshot.saveState(this.motebitId, this.state.serialize());
    }
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
    this.loopDeps = {
      motebitId: this.motebitId,
      eventStore: this.events,
      memoryGraph: this.memory,
      stateEngine: this.state,
      behaviorEngine: this.behavior,
      provider,
    };
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

  getConversationHistory(): { role: "user" | "assistant"; content: string }[] {
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

  // === Internal ===

  private pushToHistory(userMessage: string, assistantResponse: string): void {
    this.conversationHistory.push(
      { role: "user", content: userMessage },
      { role: "assistant", content: assistantResponse },
    );
    if (this.conversationHistory.length > this.maxHistory) {
      this.conversationHistory = this.conversationHistory.slice(-this.maxHistory);
    }
  }
}
