/**
 * SpatialApp — Platform shell for the spatial (AR/VR) surface.
 *
 * The equivalent of DesktopApp. Holds the MotebitRuntime, WebXR adapter,
 * orbital dynamics, voice pipeline, gesture recognition, and ambient heartbeat.
 * Wires them together so the creature in AR has intelligence, memory, identity,
 * and ambient voice interaction.
 *
 * Storage is IndexedDB-backed via @motebit/browser-persistence — identity,
 * memories, events, and audit log persist across page reloads. Identity
 * bootstrap via shared bootstrapIdentity() protocol. Private key encrypted
 * via EncryptedKeyStore (WebCrypto + IndexedDB).
 *
 * Presence state machine drives the creature's body language through the
 * existing pipeline: StateVector → BehaviorEngine → RenderEngine.
 */

import { MotebitRuntime } from "@motebit/runtime";
import { createBrowserStorage } from "@motebit/browser-persistence";
import type { StreamChunk, KeyringAdapter, StorageAdapters } from "@motebit/runtime";
import { WebXRThreeJSAdapter } from "@motebit/render-engine";
import {
  CloudProvider,
  OllamaProvider,
  resolveConfig,
  type MotebitPersonalityConfig,
} from "@motebit/ai-core";
import {
  bootstrapIdentity as sharedBootstrapIdentity,
  type BootstrapConfigStore,
  type BootstrapKeyStore,
} from "@motebit/core-identity";
import type { MotebitState, BehaviorCues } from "@motebit/sdk";
import { OrbitalDynamics, estimateBodyAnchors, getAnchorForReference } from "./index";
import { SpatialVoicePipeline, type VoicePipelineConfig } from "./voice-pipeline";
import { GestureRecognizer } from "./gestures";
import { AmbientHeartbeat } from "./heartbeat";
import { LocalStorageKeyringAdapter } from "./browser-keyring";
import { EncryptedKeyStore } from "./encrypted-keystore";

// === Configuration ===

export interface SpatialAIConfig {
  provider: "anthropic" | "ollama";
  model?: string;
  apiKey?: string;
  personalityConfig?: MotebitPersonalityConfig;
}

// === Presence State Machine ===

export type PresenceState =
  | "dormant"       // App backgrounded / headset off
  | "ambient"       // Headset on, idle
  | "attentive"     // Gaze hit or VAD onset
  | "engaged"       // Transcript sent to AI
  | "speaking"      // TTS playing
  | "processing";   // AI turn in progress

interface PresenceMapping {
  social_distance: number;
  attention: number;
  processing: number;
}

const PRESENCE_MAP: Record<PresenceState, PresenceMapping> = {
  dormant:    { social_distance: 1.0, attention: 0,    processing: 0 },
  ambient:    { social_distance: 0.6, attention: 0.1,  processing: 0 },
  attentive:  { social_distance: 0.3, attention: 0.7,  processing: 0.1 },
  engaged:    { social_distance: 0.1, attention: 0.9,  processing: 0.5 },
  speaking:   { social_distance: 0.1, attention: 0.8,  processing: 0.3 },
  processing: { social_distance: 0.15, attention: 0.85, processing: 0.95 },
};

// === SpatialApp ===

export class SpatialApp {
  readonly adapter: WebXRThreeJSAdapter;
  readonly dynamics: OrbitalDynamics;
  readonly voicePipeline: SpatialVoicePipeline;
  readonly gestures: GestureRecognizer;
  readonly heartbeat: AmbientHeartbeat;

  private runtime: MotebitRuntime | null = null;
  private storage: StorageAdapters | null = null;
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
  private _presenceState: PresenceState = "ambient";

  motebitId = "spatial-local";
  deviceId = "spatial-local";
  publicKey = "";

  constructor() {
    this.adapter = new WebXRThreeJSAdapter();
    this.dynamics = new OrbitalDynamics();
    this.voicePipeline = new SpatialVoicePipeline();
    this.gestures = new GestureRecognizer();
    this.heartbeat = new AmbientHeartbeat();
    this.keyring = new LocalStorageKeyringAdapter();

    // Wire voice pipeline callbacks
    this.voicePipeline.setCallbacks({
      onTranscript: (text: string) => {
        this.setPresenceState("engaged");
        this.voicePipeline.markProcessing();
        void this.sendAndSpeak(text);
      },
      onStateChange: (state) => {
        if (state === "listening") this.setPresenceState("attentive");
        else if (state === "speaking") this.setPresenceState("speaking");
        else if (state === "processing") this.setPresenceState("processing");
        else if (state === "ambient") this.setPresenceState("ambient");
      },
      onAudioReactivity: (energy) => {
        this.adapter.setAudioReactivity(energy);
      },
    });

    // Wire gesture callbacks
    this.gestures.setCallbacks({
      onGesture: (event) => {
        switch (event.type) {
          case "pinch":
            this.bumpAttention(0.3);
            break;
          case "beckon":
            this.bumpAttention(0.5);
            break;
          case "dismiss":
            this.decayAttention();
            break;
          case "pause":
            this.setPresenceState("dormant");
            break;
        }
      },
    });

    // Wire heartbeat callbacks
    this.heartbeat.setCallbacks({
      onProactiveUtterance: (text: string) => {
        void this.voicePipeline.speak(text);
      },
      getPresenceState: () => this._presenceState,
    });
  }

  // === Presence State Machine ===

  get presenceState(): PresenceState {
    return this._presenceState;
  }

  setPresenceState(state: PresenceState): void {
    if (this._presenceState === state) return;
    this._presenceState = state;

    // Push presence-derived values into the runtime state vector
    const mapping = PRESENCE_MAP[state];
    if (this.runtime) {
      // The runtime's state engine will EMA-smooth these values
      const stateVec = this.runtime as unknown as {
        state: { pushUpdate: (partial: Partial<MotebitState>) => void };
      };
      stateVec.state.pushUpdate({
        social_distance: mapping.social_distance,
        attention: mapping.attention,
        processing: mapping.processing,
      });
    }
    this.attentionLevel = mapping.attention;

    // Update listening indicator on the render adapter
    this.adapter.setListeningIndicator(
      state === "attentive" || state === "engaged" || state === "processing",
    );
  }

  // === Lifecycle ===

  /** Initialize the WebXR adapter with the canvas. */
  async init(canvas: HTMLCanvasElement): Promise<void> {
    await this.adapter.init(canvas);
  }

  /**
   * Bootstrap identity — delegates to shared bootstrapIdentity() protocol.
   * Creates identity in IndexedDB, registers device, logs event.
   * Private key stored via EncryptedKeyStore (WebCrypto + IndexedDB).
   */
  async bootstrap(): Promise<{ isFirstLaunch: boolean }> {
    const configStore: BootstrapConfigStore = {
      async read() {
        const mid = localStorage.getItem("motebit:motebit_id");
        if (!mid) return null;
        return {
          motebit_id: mid,
          device_id: localStorage.getItem("motebit:device_id") || "",
          device_public_key: localStorage.getItem("motebit:device_public_key") || "",
        };
      },
      async write(state) {
        localStorage.setItem("motebit:motebit_id", state.motebit_id);
        localStorage.setItem("motebit:device_id", state.device_id);
        localStorage.setItem("motebit:device_public_key", state.device_public_key);
      },
    };

    const keyStore: BootstrapKeyStore = new EncryptedKeyStore();
    const storage = await createBrowserStorage();
    this.storage = storage;

    const result = await sharedBootstrapIdentity({
      surfaceName: "Spatial",
      identityStorage: storage.identityStorage,
      eventStoreAdapter: storage.eventStore,
      configStore,
      keyStore,
    });

    this.motebitId = result.motebitId;
    this.deviceId = result.deviceId;
    this.publicKey = result.publicKeyHex;

    return { isFirstLaunch: result.isFirstLaunch };
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

    const storage = this.storage ?? await createBrowserStorage();

    this.runtime = new MotebitRuntime(
      { motebitId: this.motebitId, tickRateHz: 2 },
      { storage, renderer: this.adapter, ai: provider, keyring: this.keyring },
    );

    // Subscribe to state changes — feed attention level for orbital dynamics
    this.unsubscribeState = this.runtime.subscribe((state: MotebitState) => {
      this.attentionLevel = state.attention;
      // Feed trust mode to render adapter
      this.adapter.setTrustMode(state.trust_mode);
    });

    // Wire heartbeat to runtime
    this.heartbeat.setRuntime(this.runtime);
    this.heartbeat.start();

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

    this.setPresenceState("processing");

    let accumulated = "";
    for await (const chunk of this.runtime.sendMessageStreaming(text)) {
      if (chunk.type === "text") {
        accumulated += chunk.text;
      }
      if (chunk.type === "result") {
        accumulated = accumulated || chunk.result.response;
      }
    }

    // Speak the response (strips tags internally)
    await this.voicePipeline.speak(accumulated);
    return accumulated;
  }

  // === Voice ===

  /** Start the voice pipeline. Returns false if unsupported. */
  async startVoice(config?: VoicePipelineConfig): Promise<boolean> {
    if (!SpatialVoicePipeline.isSupported()) return false;
    if (config) this.voicePipeline.updateConfig(config);
    return this.voicePipeline.start();
  }

  /** Stop the voice pipeline. */
  stopVoice(): void {
    this.voicePipeline.stop();
  }

  // === Rendering ===

  /**
   * Render a frame. If runtime is initialized, uses behavior cues from
   * the behavior engine. Otherwise, renders with idle cues.
   */
  renderFrame(dt: number, time: number): void {
    if (this.runtime) {
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

  /** Get the current orbital state for gaze calculations. */
  getOrbitalState() {
    return this.dynamics.getState();
  }

  // === Attention (touch / gesture / gaze) ===

  /** Increase attention (touch/pinch/gaze). */
  bumpAttention(amount = 0.3): void {
    this.attentionLevel = Math.min(1, this.attentionLevel + amount);
    if (this.attentionLevel > 0.5 && this._presenceState === "ambient") {
      this.setPresenceState("attentive");
    }
  }

  /** Start decaying attention back to idle. */
  decayAttention(): void {
    const decay = setInterval(() => {
      this.attentionLevel = Math.max(0.2, this.attentionLevel - 0.05);
      if (this.attentionLevel <= 0.2) {
        clearInterval(decay);
        if (this._presenceState === "attentive") {
          this.setPresenceState("ambient");
        }
      }
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
    this.voicePipeline.stop();
    this.heartbeat.stop();
    this.gestures.reset();
    this.unsubscribeState?.();
    this.runtime?.stop();
    this.adapter.dispose();
  }
}
