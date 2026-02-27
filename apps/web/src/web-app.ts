import { MotebitRuntime } from "@motebit/runtime";
import type { StreamChunk, StorageAdapters } from "@motebit/runtime";
import type { ConversationMessage, BehaviorCues, EventType } from "@motebit/sdk";
import { ThreeJSAdapter } from "@motebit/render-engine";
import type { AudioReactivity } from "@motebit/render-engine";
import type { StreamingProvider } from "@motebit/ai-core/browser";
import { createBrowserStorage, IdbConversationStore } from "@motebit/browser-persistence";
import {
  webSearchDefinition,
  createWebSearchHandler,
  readUrlDefinition,
  createReadUrlHandler,
  recallMemoriesDefinition,
  createRecallMemoriesHandler,
  listEventsDefinition,
  createListEventsHandler,
  DuckDuckGoSearchProvider,
} from "@motebit/tools/web-safe";
import { CursorPresence } from "./cursor-presence";
import { createProvider, WebLLMProvider } from "./providers";
import type { ProviderConfig } from "./storage";
import { needsMigration, loadLegacyConversations, markMigrationDone } from "./storage";
import { LocalStorageKeyringAdapter } from "./browser-keyring";

// Re-export for color-picker module
export type InteriorColor = { tint: [number, number, number]; glow: [number, number, number] };

export const COLOR_PRESETS: Record<string, InteriorColor> = {
  moonlight:    { tint: [0.95, 0.95, 1.0], glow: [0.8, 0.85, 1.0] },
  amber:        { tint: [1.0, 0.85, 0.6], glow: [0.9, 0.7, 0.3] },
  rose:         { tint: [1.0, 0.82, 0.88], glow: [0.9, 0.5, 0.6] },
  violet:       { tint: [0.88, 0.8, 1.0], glow: [0.6, 0.4, 0.9] },
  cyan:         { tint: [0.8, 0.95, 1.0], glow: [0.3, 0.8, 0.9] },
  ember:        { tint: [1.0, 0.75, 0.65], glow: [0.9, 0.35, 0.2] },
  sage:         { tint: [0.82, 0.95, 0.85], glow: [0.4, 0.75, 0.5] },
};

// Re-export provider utilities
export { createProvider, WebLLMProvider };

// Simple hash-based text embedding for memory retrieval (no ONNX model needed)
const HASH_DIM = 64;
function hashEmbed(text: string): number[] {
  const vec = new Array<number>(HASH_DIM).fill(0);
  const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 0);
  for (const w of words) {
    let h = 0;
    for (let i = 0; i < w.length; i++) h = ((h << 5) - h + w.charCodeAt(i)) | 0;
    const idx = ((h % HASH_DIM) + HASH_DIM) % HASH_DIM;
    vec[idx] = (vec[idx] ?? 0) + 1;
  }
  let norm = 0;
  for (let i = 0; i < HASH_DIM; i++) norm += vec[i]! * vec[i]!;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < HASH_DIM; i++) vec[i] = vec[i]! / norm;
  return vec;
}

// Motebit ID stored in localStorage for persistence across sessions
const MOTEBIT_ID_KEY = "motebit-web-id";

function getOrCreateMotebitId(): string {
  let id = localStorage.getItem(MOTEBIT_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(MOTEBIT_ID_KEY, id);
  }
  return id;
}

export class WebApp {
  private renderer = new ThreeJSAdapter();
  private cursorPresence = new CursorPresence();
  private runtime: MotebitRuntime | null = null;
  private _motebitId = "";
  private _isProcessing = false;
  private _interiorColor: InteriorColor | null = null;
  private cuesTickInterval: ReturnType<typeof setInterval> | null = null;
  private idleCues: BehaviorCues = {
    hover_distance: 0.4,
    drift_amplitude: 0.02,
    glow_intensity: 0.3,
    eye_dilation: 0.3,
    smile_curvature: 0,
    speaking_activity: 0,
  };

  async init(canvas: HTMLCanvasElement): Promise<void> {
    await this.renderer.init(canvas);
    this.renderer.setLightEnvironment();
    this.renderer.enableOrbitControls();
  }

  async bootstrap(): Promise<void> {
    this._motebitId = getOrCreateMotebitId();

    // Open IndexedDB storage
    const storage = await createBrowserStorage();

    // Migrate legacy localStorage conversations to IDB
    if (needsMigration()) {
      await this.migrateLegacyConversations(storage);
    }

    // Preload conversation cache for sync access
    const convStore = storage.conversationStore as IdbConversationStore;
    await convStore.preload(this._motebitId);

    // Create runtime — no AI provider yet, will be set via connectProvider()
    const keyring = new LocalStorageKeyringAdapter();
    this.runtime = new MotebitRuntime(
      { motebitId: this._motebitId, tickRateHz: 2 },
      { storage, renderer: this.renderer, ai: undefined, keyring },
    );

    // Register web-safe tools
    this.registerWebTools();

    // Start ticking
    this.runtime.start();
    this.cursorPresence.start();

    // 30fps cursor tick: merge cursor presence into runtime state
    this.cuesTickInterval = setInterval(() => {
      const cursorUpdates = this.cursorPresence.getUpdates();
      if (this.runtime) {
        this.runtime.pushStateUpdate(cursorUpdates);
      }
    }, 33);
  }

  private async migrateLegacyConversations(storage: StorageAdapters): Promise<void> {
    const convStore = storage.conversationStore;
    if (!convStore) {
      markMigrationDone();
      return;
    }

    const legacy = loadLegacyConversations();
    for (const conv of legacy) {
      const convId = convStore.createConversation(this._motebitId);
      for (const msg of conv.messages) {
        if (msg.role === "user" || msg.role === "assistant") {
          convStore.appendMessage(convId, this._motebitId, {
            role: msg.role,
            content: msg.content,
          });
        }
      }
      if (conv.title) {
        convStore.updateTitle(convId, conv.title);
      }
    }

    markMigrationDone();
  }

  private registerWebTools(): void {
    if (!this.runtime) return;
    const registry = this.runtime.getToolRegistry();

    registry.register(
      webSearchDefinition,
      createWebSearchHandler(new DuckDuckGoSearchProvider()),
    );
    registry.register(readUrlDefinition, createReadUrlHandler());
    registry.register(
      recallMemoriesDefinition,
      createRecallMemoriesHandler(async (query, limit) => {
        if (!this.runtime) return [];
        const embedding = hashEmbed(query);
        const nodes = await this.runtime.memory.retrieve(embedding, { limit });
        return nodes.map(n => ({ content: n.content, confidence: n.confidence }));
      }),
    );
    registry.register(
      listEventsDefinition,
      createListEventsHandler(async (limit, eventType) => {
        if (!this.runtime) return [];
        const events = await this.runtime.events.query({
          motebit_id: this.runtime.motebitId,
          limit,
          event_types: eventType ? [eventType as EventType] : undefined,
        });
        return events.map(e => ({
          event_type: e.event_type,
          timestamp: e.timestamp,
          payload: e.payload,
        }));
      }),
    );
  }

  stop(): void {
    this.cursorPresence.stop();
    if (this.cuesTickInterval) {
      clearInterval(this.cuesTickInterval);
      this.cuesTickInterval = null;
    }
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
      // Pre-bootstrap: render with idle cues
      this.renderer.render({
        cues: this.idleCues,
        delta_time: deltaTime,
        time,
      });
    }
  }

  // === Provider Management ===

  get isProviderConnected(): boolean {
    return this.runtime?.isAIReady ?? false;
  }

  get isProcessing(): boolean {
    return this._isProcessing;
  }

  get currentModel(): string | null {
    return this.runtime?.currentModel ?? null;
  }

  connectProvider(config: ProviderConfig): void {
    const provider = createProvider(config) as StreamingProvider;
    if (this.runtime) {
      this.runtime.setProvider(provider);
    }
  }

  setProviderDirect(provider: StreamingProvider): void {
    if (this.runtime) {
      this.runtime.setProvider(provider);
    }
  }

  disconnectProvider(): void {
    // No direct "unset provider" on runtime — reconnect with a different one
  }

  // === Appearance ===

  setInteriorColor(presetName: string): void {
    const preset = COLOR_PRESETS[presetName];
    if (!preset) return;
    this._interiorColor = preset;
    this.renderer.setInteriorColor(preset);
  }

  setInteriorColorDirect(color: InteriorColor): void {
    this._interiorColor = color;
    this.renderer.setInteriorColor(color);
  }

  getInteriorColor(): InteriorColor | null {
    return this._interiorColor;
  }

  setAudioReactivity(energy: AudioReactivity | null): void {
    this.renderer.setAudioReactivity(energy);
  }

  setLightEnvironment(): void {
    this.renderer.setLightEnvironment();
  }

  setDarkEnvironment(): void {
    this.renderer.setDarkEnvironment();
  }

  // === Conversation ===

  get activeConversationId(): string | null {
    return this.runtime?.getConversationId() ?? null;
  }

  getConversationHistory(): ConversationMessage[] {
    return this.runtime?.getConversationHistory() ?? [];
  }

  resetConversation(): void {
    this.runtime?.resetConversation();
  }

  loadConversationById(id: string): ConversationMessage[] {
    if (!this.runtime) return [];
    this.runtime.loadConversation(id);
    return this.runtime.getConversationHistory();
  }

  listConversations(): Array<{
    conversationId: string;
    startedAt: number;
    lastActiveAt: number;
    title: string | null;
    messageCount: number;
  }> {
    return this.runtime?.listConversations() ?? [];
  }

  // === Streaming Chat ===

  async *sendMessageStreaming(text: string): AsyncGenerator<StreamChunk> {
    if (!this.runtime) throw new Error("Runtime not initialized");
    if (!this.runtime.isAIReady) throw new Error("No provider connected");
    if (this._isProcessing) throw new Error("Already processing");

    this._isProcessing = true;
    try {
      yield* this.runtime.sendMessageStreaming(text);
    } finally {
      this._isProcessing = false;
    }
  }

  // === Approval Flow ===

  get hasPendingApproval(): boolean {
    return this.runtime?.hasPendingApproval ?? false;
  }

  get pendingApprovalInfo(): { toolName: string; args: Record<string, unknown> } | null {
    return this.runtime?.pendingApprovalInfo ?? null;
  }

  async *resumeAfterApproval(approved: boolean): AsyncGenerator<StreamChunk> {
    if (!this.runtime) return;
    yield* this.runtime.resumeAfterApproval(approved);
  }

  // === Sovereign Features ===

  async autoTitle(): Promise<string | null> {
    return this.runtime?.autoTitle() ?? null;
  }

  async summarize(): Promise<string | null> {
    return this.runtime?.summarizeCurrentConversation() ?? null;
  }

  async housekeeping(): Promise<void> {
    await this.runtime?.housekeeping();
  }

  getRuntime(): MotebitRuntime | null {
    return this.runtime;
  }

  get motebitId(): string {
    return this._motebitId;
  }
}
