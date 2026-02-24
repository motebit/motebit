import { ThreeJSAdapter } from "@motebit/render-engine";
import { StateVectorEngine } from "@motebit/state-vector";
import { computeRawCues } from "@motebit/behavior-engine";
import type { MotebitState, BehaviorCues } from "@motebit/sdk";
import type { StreamingProvider } from "@motebit/ai-core/browser";
import { CursorPresence } from "./cursor-presence";
import { createProvider, WebLLMProvider } from "./providers";
import type { ProviderConfig, ConversationMessage } from "./storage";
import { saveConversation, loadConversation, clearConversation } from "./storage";

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

export class WebApp {
  private renderer = new ThreeJSAdapter();
  private stateEngine: StateVectorEngine;
  private cursorPresence = new CursorPresence();
  private provider: StreamingProvider | null = null;
  private conversationHistory: ConversationMessage[] = [];
  private _isProcessing = false;
  private cuesTickInterval: ReturnType<typeof setInterval> | null = null;
  private currentCues: BehaviorCues = {
    hover_distance: 0.4,
    drift_amplitude: 0.02,
    glow_intensity: 0.3,
    eye_dilation: 0.3,
    smile_curvature: 0,
    speaking_activity: 0,
  };

  constructor() {
    this.stateEngine = new StateVectorEngine({ tick_rate_hz: 2, ema_alpha: 0.3, hysteresis_threshold: 0.05, hysteresis_sustain_ms: 500 });
  }

  async init(canvas: HTMLCanvasElement): Promise<void> {
    await this.renderer.init(canvas);
    this.renderer.setLightEnvironment();
    this.renderer.enableOrbitControls();
  }

  start(): void {
    this.stateEngine.start();
    this.cursorPresence.start();

    // 30fps cues tick: merge cursor presence into state, compute cues
    this.cuesTickInterval = setInterval(() => {
      const cursorUpdates = this.cursorPresence.getUpdates();
      this.stateEngine.pushUpdate(cursorUpdates);
      const state = this.stateEngine.getState();
      this.currentCues = computeRawCues(state);
    }, 33);

    // Restore conversation from localStorage
    this.conversationHistory = loadConversation();
  }

  stop(): void {
    this.stateEngine.stop();
    this.cursorPresence.stop();
    if (this.cuesTickInterval) {
      clearInterval(this.cuesTickInterval);
      this.cuesTickInterval = null;
    }
    this.renderer.dispose();
  }

  resize(width: number, height: number): void {
    this.renderer.resize(width, height);
  }

  renderFrame(deltaTime: number, time: number): void {
    this.renderer.render({
      cues: this.currentCues,
      delta_time: deltaTime,
      time,
    });
  }

  // === Provider Management ===

  get isProviderConnected(): boolean {
    return this.provider != null;
  }

  get isProcessing(): boolean {
    return this._isProcessing;
  }

  get currentModel(): string | null {
    return this.provider?.model ?? null;
  }

  connectProvider(config: ProviderConfig): void {
    this.provider = createProvider(config) as StreamingProvider;
  }

  disconnectProvider(): void {
    this.provider = null;
  }

  // === Appearance ===

  setInteriorColor(presetName: string): void {
    const preset = COLOR_PRESETS[presetName];
    if (!preset) return;
    this.renderer.setInteriorColor(preset);
  }

  setInteriorColorDirect(color: InteriorColor): void {
    this.renderer.setInteriorColor(color);
  }

  setLightEnvironment(): void {
    this.renderer.setLightEnvironment();
  }

  setDarkEnvironment(): void {
    this.renderer.setDarkEnvironment();
  }

  // === Conversation ===

  getConversationHistory(): ConversationMessage[] {
    return [...this.conversationHistory];
  }

  resetConversation(): void {
    this.conversationHistory = [];
    clearConversation();
  }

  // === Streaming Chat ===

  async *sendMessageStreaming(text: string): AsyncGenerator<
    | { type: "text"; text: string }
    | { type: "done"; response: { text: string } }
  > {
    if (!this.provider) throw new Error("No provider connected");
    if (this._isProcessing) throw new Error("Already processing");

    this._isProcessing = true;

    // Add user message to history
    this.conversationHistory.push({ role: "user", content: text, timestamp: Date.now() });

    try {
      // Build a minimal context pack — web app has no event log or memory graph
      const recentHistory = this.conversationHistory.slice(-20).map(
        (m) => ({ role: m.role, content: m.content }) as { role: "user"; content: string } | { role: "assistant"; content: string },
      );

      const contextPack = {
        user_message: text,
        current_state: this.stateEngine.getState(),
        conversation_history: recentHistory,
        recent_events: [],
        relevant_memories: [],
        personality: { name: "Motebit", species: "Sapientia Unda", body_awareness: "" },
        tools: [],
      };

      // Inject processing state
      this.stateEngine.pushUpdate({ processing: 0.7, attention: 0.8 });

      let accumulated = "";
      for await (const chunk of this.provider.generateStream(contextPack)) {
        if (chunk.type === "text") {
          accumulated += chunk.text;
          yield { type: "text", text: chunk.text };
        } else if (chunk.type === "done") {
          // Use the full response text
          const responseText = chunk.response.text || accumulated;
          this.conversationHistory.push({ role: "assistant", content: responseText, timestamp: Date.now() });
          saveConversation(this.conversationHistory);

          // Apply response state updates
          if (chunk.response.state_updates) {
            this.stateEngine.pushUpdate(chunk.response.state_updates as Partial<MotebitState>);
          }

          yield { type: "done", response: { text: responseText } };
        }
      }

      // If we never got a "done" chunk, still save
      if (accumulated && !this.conversationHistory.some(m => m.role === "assistant" && m.content === accumulated)) {
        this.conversationHistory.push({ role: "assistant", content: accumulated, timestamp: Date.now() });
        saveConversation(this.conversationHistory);
      }
    } finally {
      this._isProcessing = false;
      this.stateEngine.pushUpdate({ processing: 0 });
    }
  }
}
