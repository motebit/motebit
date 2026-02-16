/**
 * @motebit/desktop — Tauri app (Rust + webview)
 *
 * Architecture:
 * - Three.js in webview for rendering
 * - SQLite via rusqlite in Rust backend, exposed through Tauri commands
 * - OS keyring for identity persistence (via tauri-plugin-keyring)
 * - System tray presence
 *
 * Tauri commands (Rust side):
 * - db_query(sql, params) -> rows
 * - db_execute(sql, params) -> affected
 * - keyring_get(key) -> value
 * - keyring_set(key, value)
 * - keyring_delete(key)
 * - read_config() -> JSON string
 * - write_config(json) -> void
 */

import type { MotebitState, BehaviorCues } from "@motebit/sdk";
import { StateVectorEngine } from "@motebit/state-vector";
import { BehaviorEngine } from "@motebit/behavior-engine";
import { ThreeJSAdapter } from "@motebit/render-engine";
import {
  CloudProvider,
  OllamaProvider,
  resolveConfig,
  runTurn,
  type MotebitPersonalityConfig,
  type MotebitLoopDependencies,
  type TurnResult,
} from "@motebit/ai-core";
import { EventStore, InMemoryEventStore } from "@motebit/event-log";
import { MemoryGraph, InMemoryMemoryStorage } from "@motebit/memory-graph";

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
}

// === Desktop App Bootstrap ===

export class DesktopApp {
  private stateEngine: StateVectorEngine;
  private behaviorEngine: BehaviorEngine;
  private renderer: ThreeJSAdapter;
  private running = false;
  private latestCues: BehaviorCues = {
    hover_distance: 0.4,
    drift_amplitude: 0.02,
    glow_intensity: 0.3,
    eye_dilation: 0.3,
    smile_curvature: 0,
  };

  // AI loop
  private loopDeps: MotebitLoopDependencies | null = null;
  private conversationHistory: { role: "user" | "assistant"; content: string }[] = [];
  private _isProcessing = false;

  constructor() {
    this.stateEngine = new StateVectorEngine({ tick_rate_hz: 2 });
    this.behaviorEngine = new BehaviorEngine();
    this.renderer = new ThreeJSAdapter();
  }

  async init(canvas: unknown): Promise<void> {
    await this.renderer.init(canvas);

    // Subscribe to state changes → compute cues (at 2Hz tick rate)
    this.stateEngine.subscribe((state: MotebitState) => {
      this.latestCues = this.behaviorEngine.compute(state);
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stateEngine.start();
  }

  stop(): void {
    this.stateEngine.stop();
    this.renderer.dispose();
    this.running = false;
  }

  resize(width: number, height: number): void {
    this.renderer.resize(width, height);
  }

  renderFrame(deltaTime: number, time: number): void {
    this.renderer.render({
      cues: this.latestCues,
      delta_time: deltaTime,
      time,
    });
  }

  // === AI Integration ===

  get isAIReady(): boolean {
    return this.loopDeps !== null;
  }

  get isProcessing(): boolean {
    return this._isProcessing;
  }

  get currentModel(): string | null {
    return this.loopDeps?.provider.model ?? null;
  }

  setModel(model: string): void {
    if (!this.loopDeps) throw new Error("AI not initialized — call initAI() first");
    this.loopDeps.provider.setModel(model);
  }

  initAI(config: DesktopAIConfig): boolean {
    const resolved = config.personalityConfig
      ? resolveConfig(config.personalityConfig)
      : undefined;
    const temperature = resolved?.temperature;

    const motebitId = "desktop-" + crypto.randomUUID().slice(0, 8);
    const eventStore = new EventStore(new InMemoryEventStore());
    const memoryGraph = new MemoryGraph(
      new InMemoryMemoryStorage(),
      eventStore,
      motebitId,
    );

    let provider;

    if (config.provider === "ollama") {
      const model = config.model || "llama3.2";
      const base_url = config.isTauri
        ? "http://localhost:11434"
        : "/api/ollama";
      provider = new OllamaProvider({
        model,
        base_url,
        max_tokens: 1024,
        temperature,
      });
    } else {
      if (!config.apiKey) return false;
      const model = config.model || "claude-sonnet-4-20250514";
      const base_url = config.isTauri
        ? "https://api.anthropic.com"
        : "/api/anthropic";
      provider = new CloudProvider({
        provider: "anthropic",
        api_key: config.apiKey,
        model,
        base_url,
        max_tokens: 1024,
        temperature,
      });
    }

    this.loopDeps = {
      motebitId,
      eventStore,
      memoryGraph,
      stateEngine: this.stateEngine,
      behaviorEngine: this.behaviorEngine,
      provider,
    };

    return true;
  }

  resetConversation(): void {
    this.conversationHistory = [];
  }

  async sendMessage(text: string): Promise<TurnResult> {
    if (!this.loopDeps) {
      throw new Error("AI not initialized — call initAI() first");
    }
    if (this._isProcessing) {
      throw new Error("Already processing a message");
    }

    this._isProcessing = true;

    // Creature glows while thinking
    this.stateEngine.pushUpdate({ processing: 0.9, attention: 0.8 });

    try {
      const result = await runTurn(this.loopDeps, text, {
        conversationHistory: this.conversationHistory,
        previousCues: this.latestCues,
      });

      // Maintain conversation history (cap at 40 entries = 20 turns)
      this.conversationHistory.push(
        { role: "user", content: text },
        { role: "assistant", content: result.response },
      );
      if (this.conversationHistory.length > 40) {
        this.conversationHistory = this.conversationHistory.slice(-40);
      }

      return result;
    } finally {
      // Reset processing — glow fades
      this.stateEngine.pushUpdate({ processing: 0.1, attention: 0.3 });
      this._isProcessing = false;
    }
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
