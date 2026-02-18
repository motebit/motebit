/**
 * SpatialApp — Platform shell for the spatial (AR/VR) surface.
 *
 * The equivalent of DesktopApp. Holds the MotebitRuntime, WebXR adapter,
 * orbital dynamics, and voice interface. Wires them together so the creature
 * in AR has intelligence, memory, identity, and voice.
 *
 * Storage is IndexedDB-backed via @motebit/browser-persistence — identity,
 * memories, events, and audit log persist across page reloads. No MCP (stdio
 * is Node-only). Identity keypair stored in localStorage via LocalStorageKeyringAdapter.
 */

import { MotebitRuntime } from "@motebit/runtime";
import { createBrowserStorage } from "@motebit/browser-persistence";
import type { StreamChunk, KeyringAdapter } from "@motebit/runtime";
import { WebXRThreeJSAdapter } from "@motebit/render-engine";
import {
  CloudProvider,
  OllamaProvider,
  resolveConfig,
  type MotebitPersonalityConfig,
} from "@motebit/ai-core";
import { generateKeypair } from "@motebit/crypto";
import type { MotebitState, BehaviorCues } from "@motebit/sdk";
import { OrbitalDynamics, estimateBodyAnchors, getAnchorForReference } from "./index";
import { VoiceInterface } from "./voice";
import { LocalStorageKeyringAdapter } from "./browser-keyring";

// === Configuration ===

export interface SpatialAIConfig {
  provider: "anthropic" | "ollama";
  model?: string;
  apiKey?: string;
  personalityConfig?: MotebitPersonalityConfig;
}

// === SpatialApp ===

export class SpatialApp {
  readonly adapter: WebXRThreeJSAdapter;
  readonly dynamics: OrbitalDynamics;
  readonly voice: VoiceInterface;

  private runtime: MotebitRuntime | null = null;
  private keyring: KeyringAdapter;
  private latestCues: BehaviorCues = {
    hover_distance: 0.4,
    drift_amplitude: 0.02,
    glow_intensity: 0.3,
    eye_dilation: 0.3,
    smile_curvature: 0.5,
  };
  private attentionLevel = 0.2;
  private unsubscribeState: (() => void) | null = null;

  motebitId = "spatial-local";
  deviceId = "spatial-local";
  publicKey = "";

  constructor() {
    this.adapter = new WebXRThreeJSAdapter();
    this.dynamics = new OrbitalDynamics();
    this.voice = new VoiceInterface();
    this.keyring = new LocalStorageKeyringAdapter();
  }

  // === Lifecycle ===

  /** Initialize the WebXR adapter with the canvas. */
  async init(canvas: HTMLCanvasElement): Promise<void> {
    await this.adapter.init(canvas);
  }

  /**
   * Bootstrap identity — generate Ed25519 keypair on first launch,
   * or load existing identity from localStorage.
   */
  async bootstrap(): Promise<{ isFirstLaunch: boolean }> {
    const existingId = localStorage.getItem("motebit:motebit_id");

    if (existingId) {
      this.motebitId = existingId;
      this.deviceId = localStorage.getItem("motebit:device_id") || "spatial-local";
      this.publicKey = localStorage.getItem("motebit:device_public_key") || "";
      return { isFirstLaunch: false };
    }

    // First launch — create identity and device keypair
    const keypair = await generateKeypair();

    const pubKeyHex = Array.from(keypair.publicKey)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const privKeyHex = Array.from(keypair.privateKey)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const motebitId = crypto.randomUUID();
    const deviceId = crypto.randomUUID();

    // Persist to localStorage
    localStorage.setItem("motebit:motebit_id", motebitId);
    localStorage.setItem("motebit:device_id", deviceId);
    localStorage.setItem("motebit:device_public_key", pubKeyHex);
    await this.keyring.set("device_private_key", privKeyHex);

    this.motebitId = motebitId;
    this.deviceId = deviceId;
    this.publicKey = pubKeyHex;

    return { isFirstLaunch: true };
  }

  // === AI Integration ===

  /**
   * Create the AI provider and wire MotebitRuntime with persistent browser storage.
   * Returns false if the provider needs an API key that wasn't provided.
   */
  async initAI(config: SpatialAIConfig): Promise<boolean> {
    const resolved = config.personalityConfig
      ? resolveConfig(config.personalityConfig)
      : undefined;
    const temperature = resolved?.temperature;

    let provider;
    if (config.provider === "ollama") {
      const model = config.model || "llama3.2";
      provider = new OllamaProvider({
        model,
        base_url: "http://localhost:11434",
        max_tokens: 1024,
        temperature,
      });
    } else {
      if (!config.apiKey) return false;
      const model = config.model || "claude-sonnet-4-20250514";
      provider = new CloudProvider({
        provider: "anthropic",
        api_key: config.apiKey,
        model,
        max_tokens: 1024,
        temperature,
      });
    }

    const storage = await createBrowserStorage();

    this.runtime = new MotebitRuntime(
      { motebitId: this.motebitId, tickRateHz: 2 },
      { storage, renderer: this.adapter, ai: provider, keyring: this.keyring },
    );

    // Subscribe to state changes — feed cues + orbital attention
    this.unsubscribeState = this.runtime.subscribe((state: MotebitState) => {
      this.attentionLevel = state.attention;
    });

    return true;
  }

  get isAIReady(): boolean {
    return this.runtime?.isAIReady ?? false;
  }

  get isProcessing(): boolean {
    return this.runtime?.isProcessing ?? false;
  }

  // === Messaging ===

  /**
   * Send a message through the runtime. Returns an async generator of stream chunks.
   * The voice module speaks the final response.
   */
  async *sendMessage(text: string): AsyncGenerator<StreamChunk> {
    if (!this.runtime) return;
    yield* this.runtime.sendMessageStreaming(text);
  }

  /**
   * Send a message and speak the response. Convenience method for voice flow.
   * Returns the accumulated display text.
   */
  async sendAndSpeak(text: string): Promise<string> {
    if (!this.runtime) return "";

    let accumulated = "";
    for await (const chunk of this.runtime.sendMessageStreaming(text)) {
      if (chunk.type === "text") {
        accumulated += chunk.text;
      }
      if (chunk.type === "result") {
        // TurnResult.response is the raw text; use accumulated display text
        accumulated = accumulated || chunk.result.response;
      }
    }

    // Speak the response (strips tags internally)
    await this.voice.speak(accumulated);
    return accumulated;
  }

  // === Voice ===

  /** Start ambient voice recognition. Returns false if unsupported. */
  startVoice(): boolean {
    if (!VoiceInterface.isSupported()) return false;

    // Wire voice transcript → runtime
    this.voice.onTranscript = (transcript: string) => {
      // Fire-and-forget — the streaming response drives state + speech
      void this.sendAndSpeak(transcript);
    };

    // State modulation based on voice activity
    this.voice.onListeningChange = (listening: boolean) => {
      if (listening && this.runtime) {
        this.runtime.getState(); // touch state to confirm runtime is alive
      }
    };

    this.voice.onSpeakingChange = (_speaking: boolean) => {
      // Body language is driven by runtime state tags, not explicit mutation here.
      // The AI's response includes state tags that the runtime processes.
    };

    return this.voice.start();
  }

  /** Stop voice recognition. */
  stopVoice(): void {
    this.voice.stop();
  }

  // === Rendering ===

  /**
   * Render a frame. If runtime is initialized, uses behavior cues from
   * the behavior engine. Otherwise, renders with idle cues.
   */
  renderFrame(dt: number, time: number): void {
    if (this.runtime) {
      // Runtime.renderFrame() uses its internal latestCues from behavior engine
      this.runtime.renderFrame(dt, time);
    } else {
      this.adapter.render({
        cues: this.latestCues,
        delta_time: dt,
        time,
      });
    }
  }

  /**
   * Tick orbital dynamics and position the creature.
   * Call this each frame in the XR animation loop.
   */
  tickOrbital(
    dt: number,
    time: number,
    headPosition: [number, number, number],
  ): void {
    const anchors = estimateBodyAnchors(headPosition);
    const shoulderAnchor = getAnchorForReference(anchors, "shoulder_right");

    if (shoulderAnchor) {
      const creaturePos = this.dynamics.tick(dt, time, shoulderAnchor, this.attentionLevel);
      this.adapter.setCreatureWorldPosition(creaturePos[0], creaturePos[1], creaturePos[2]);
      this.adapter.setCreatureLookAt(headPosition[0], headPosition[1], headPosition[2]);
    }
  }

  // === Attention (touch / gesture) ===

  /** Increase attention (touch/pinch). */
  bumpAttention(amount = 0.3): void {
    this.attentionLevel = Math.min(1, this.attentionLevel + amount);
  }

  /** Start decaying attention back to idle. */
  decayAttention(): void {
    const decay = setInterval(() => {
      this.attentionLevel = Math.max(0.2, this.attentionLevel - 0.05);
      if (this.attentionLevel <= 0.2) clearInterval(decay);
    }, 100);
  }

  // === Operator Mode ===

  get isOperatorMode(): boolean {
    return this.runtime?.isOperatorMode ?? false;
  }

  async setOperatorMode(enabled: boolean, pin?: string) {
    if (!this.runtime) return { success: false, error: "AI not initialized" };
    return this.runtime.setOperatorMode(enabled, pin);
  }

  async setupOperatorPin(pin: string): Promise<void> {
    if (!this.runtime) throw new Error("AI not initialized");
    return this.runtime.setupOperatorPin(pin);
  }

  // === Cleanup ===

  dispose(): void {
    this.voice.dispose();
    this.unsubscribeState?.();
    this.runtime?.stop();
    this.adapter.dispose();
  }
}
