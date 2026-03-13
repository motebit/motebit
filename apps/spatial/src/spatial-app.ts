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
 *
 * Physical travel model (event-driven, not polling-driven):
 * - When your motebit delegates, it LEAVES your body. A ghost remains.
 * - Another person's motebit ARRIVES in your space as a visitor.
 * - When done, your motebit RETURNS carrying the receipt.
 * - Trust is the gatekeeper — blocked agents are invisible, unknown agents
 *   are distant and faint, trusted agents appear close and bright.
 *
 * Relay integration (best-effort, gated behind showNetwork setting):
 * - Registers identity on bootstrap via POST /api/v1/agents/bootstrap
 * - Registers in agent discovery via POST /api/v1/agents/register
 * - Maintains heartbeat every 5 minutes
 * - Listens for spatial presence events via WS: delegation_departed,
 *   delegation_arrived, delegation_returning, delegation_visitor_departing
 */

import { MotebitRuntime } from "@motebit/runtime";
import { RelayDelegationAdapter } from "@motebit/runtime";
import { createBrowserStorage, IdbAgentTrustStore } from "@motebit/browser-persistence";
import type { StreamChunk, KeyringAdapter, StorageAdapters } from "@motebit/runtime";
import { WebXRThreeJSAdapter } from "@motebit/render-engine";
import { trustLevelToScore, AgentTrustLevel } from "@motebit/sdk";
import {
  CloudProvider,
  OllamaProvider,
  resolveConfig,
  DEFAULT_OLLAMA_URL,
  type MotebitPersonalityConfig,
} from "@motebit/ai-core";
import {
  bootstrapIdentity as sharedBootstrapIdentity,
  type BootstrapConfigStore,
  type BootstrapKeyStore,
} from "@motebit/core-identity";
import { createSignedToken } from "@motebit/crypto";
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

export interface SpatialNetworkSettings {
  relayUrl: string;
  showNetwork: boolean;
}

// === Presence State Machine ===

export type PresenceState =
  | "dormant" // App backgrounded / headset off
  | "ambient" // Headset on, idle
  | "attentive" // Gaze hit or VAD onset
  | "engaged" // Transcript sent to AI
  | "speaking" // TTS playing
  | "processing"; // AI turn in progress

interface PresenceMapping {
  social_distance: number;
  attention: number;
  processing: number;
}

const PRESENCE_MAP: Record<PresenceState, PresenceMapping> = {
  dormant: { social_distance: 1.0, attention: 0, processing: 0 },
  ambient: { social_distance: 0.6, attention: 0.1, processing: 0 },
  attentive: { social_distance: 0.3, attention: 0.7, processing: 0.1 },
  engaged: { social_distance: 0.1, attention: 0.9, processing: 0.5 },
  speaking: { social_distance: 0.1, attention: 0.8, processing: 0.3 },
  processing: { social_distance: 0.15, attention: 0.85, processing: 0.95 },
};

// === Visitor Record ===

/** A visitor currently in your space (trust-admitted). */
export interface VisitorRecord {
  motebitId: string;
  trustScore: number;
  /** Task the visitor arrived with, if known. */
  taskDescription?: string;
}

// === Delegation Presence ===

/**
 * Physical travel state of your own motebit:
 *   home → away (delegated, ghost visible) → home (returned with receipt)
 */
export type DelegationPresence = "home" | "away";

// === Constants ===

const DEFAULT_RELAY_URL = "https://motebit-sync.fly.dev";
const HEARTBEAT_INTERVAL_MS = 5 * 60_000; // 5 minutes

// === Spatial WS message shape ===

interface SpatialWsMessage {
  type: string;
  source_motebit_id?: string;
  target_motebit_id?: string;
  task_description?: string;
}

// === SpatialApp ===

export class SpatialApp {
  readonly adapter: WebXRThreeJSAdapter;
  readonly dynamics: OrbitalDynamics;
  readonly voicePipeline: SpatialVoicePipeline;
  readonly gestures: GestureRecognizer;
  readonly heartbeat: AmbientHeartbeat;

  private runtime: MotebitRuntime | null = null;
  private storage: StorageAdapters | null = null;
  private agentTrustStore: IdbAgentTrustStore | null = null;
  private keyring: KeyringAdapter;
  private keyStore = new EncryptedKeyStore();
  private latestCues: BehaviorCues = {
    hover_distance: 0.4,
    drift_amplitude: 0.02,
    glow_intensity: 0.3,
    eye_dilation: 0.3,
    smile_curvature: 0.5,
    speaking_activity: 0,
  };
  private attentionLevel = 0.2;
  private unsubscribeState: (() => void) | null = null;
  private _presenceState: PresenceState = "ambient";

  // Network settings
  private networkSettings: SpatialNetworkSettings = {
    relayUrl: DEFAULT_RELAY_URL,
    showNetwork: true,
  };

  // Relay state
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private relayAuthToken: string | null = null;
  private tokenFactory: (() => Promise<string>) | null = null;
  private _ws: WebSocket | null = null;

  // Physical travel state
  private _delegationPresence: DelegationPresence = "home";
  private _delegationTarget: string | null = null;
  /** Visitors currently in your space, keyed by their motebitId. */
  private _visitors = new Map<string, VisitorRecord>();

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
      this.runtime.pushStateUpdate({
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

  // === Delegation Presence ===

  get delegationPresence(): DelegationPresence {
    return this._delegationPresence;
  }

  get delegationTarget(): string | null {
    return this._delegationTarget;
  }

  get visitors(): ReadonlyMap<string, VisitorRecord> {
    return this._visitors;
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
      read() {
        const mid = localStorage.getItem("motebit:motebit_id");
        if (mid == null) return Promise.resolve(null);
        return Promise.resolve({
          motebit_id: mid,
          device_id: localStorage.getItem("motebit:device_id") ?? "",
          device_public_key: localStorage.getItem("motebit:device_public_key") ?? "",
        });
      },
      write(state): Promise<void> {
        localStorage.setItem("motebit:motebit_id", state.motebit_id);
        localStorage.setItem("motebit:device_id", state.device_id);
        localStorage.setItem("motebit:device_public_key", state.device_public_key);
        return Promise.resolve();
      },
    };

    const keyStore: BootstrapKeyStore = new EncryptedKeyStore();
    const storage = await createBrowserStorage();
    this.storage = storage;

    // Grab the IDB instance for agent trust lookups
    const agentTrustStore = (storage as unknown as { agentTrustStore?: IdbAgentTrustStore })
      .agentTrustStore;
    if (agentTrustStore) {
      this.agentTrustStore = agentTrustStore;
    }

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

    // Build a token factory for the relay (refreshes on each call — 5-min expiry)
    const privateKeyHex = await this.keyStore.loadPrivateKey();
    if (privateKeyHex != null && privateKeyHex !== "") {
      const privKeyBytes = new Uint8Array(privateKeyHex.length / 2);
      for (let i = 0; i < privateKeyHex.length; i += 2) {
        privKeyBytes[i / 2] = parseInt(privateKeyHex.slice(i, i + 2), 16);
      }
      const motebitId = this.motebitId;
      const deviceId = this.deviceId;
      this.tokenFactory = async (): Promise<string> => {
        return createSignedToken(
          { mid: motebitId, did: deviceId, iat: Date.now(), exp: Date.now() + 5 * 60 * 1000 },
          privKeyBytes,
        );
      };
    }

    return { isFirstLaunch: result.isFirstLaunch };
  }

  // === AI Integration ===

  /**
   * Create the AI provider and wire MotebitRuntime with persistent browser storage.
   * Returns false if the provider needs an API key that wasn't provided.
   */
  async initAI(config: SpatialAIConfig): Promise<boolean> {
    const resolved = config.personalityConfig ? resolveConfig(config.personalityConfig) : undefined;
    const temperature = resolved?.temperature;

    let provider;
    if (config.provider === "ollama") {
      const model = config.model != null && config.model !== "" ? config.model : "llama3.2";
      provider = new OllamaProvider({
        model,
        base_url: DEFAULT_OLLAMA_URL,
        max_tokens: 1024,
        temperature,
      });
    } else {
      if (config.apiKey == null || config.apiKey === "") return false;
      const model =
        config.model != null && config.model !== "" ? config.model : "claude-sonnet-4-20250514";
      provider = new CloudProvider({
        provider: "anthropic",
        api_key: config.apiKey,
        model,
        max_tokens: 1024,
        temperature,
      });
    }

    const storage = this.storage ?? (await createBrowserStorage());

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

  // === Network Settings ===

  /**
   * Update relay / agent network settings.
   * Call this after loading settings from localStorage.
   */
  setNetworkSettings(settings: Partial<SpatialNetworkSettings>): void {
    if (settings.relayUrl !== undefined) this.networkSettings.relayUrl = settings.relayUrl;
    if (settings.showNetwork !== undefined) this.networkSettings.showNetwork = settings.showNetwork;
  }

  get networkConfig(): SpatialNetworkSettings {
    return { ...this.networkSettings };
  }

  // === Relay Integration ===

  /**
   * Connect to the relay: bootstrap identity, register for discovery, start heartbeat,
   * wire RelayDelegationAdapter on the runtime, and open a WS for spatial presence events.
   *
   * Best-effort — any relay error is swallowed; the app works offline.
   * Must be called after bootstrap() and initAI().
   */
  async connectRelay(): Promise<void> {
    const { relayUrl, showNetwork } = this.networkSettings;
    if (relayUrl === "" || !showNetwork) return;

    // Mint an initial token
    let authToken: string | null = null;
    if (this.tokenFactory) {
      try {
        authToken = await this.tokenFactory();
        this.relayAuthToken = authToken;
      } catch {
        // No private key — relay auth will be anonymous
      }
    }

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

    // 1. Bootstrap identity on relay
    try {
      await fetch(`${relayUrl}/api/v1/agents/bootstrap`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          motebit_id: this.motebitId,
          device_id: this.deviceId,
          public_key: this.publicKey,
        }),
      });
    } catch {
      // Best-effort — relay may not support this endpoint
    }

    // 2. Register capabilities for discovery
    const toolNames =
      this.runtime
        ?.getToolRegistry()
        .list()
        .map((t) => t.name) ?? [];
    try {
      const regResp = await fetch(`${relayUrl}/api/v1/agents/register`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          motebit_id: this.motebitId,
          endpoint_url: relayUrl,
          capabilities: toolNames,
          metadata: { name: `spatial-${this.motebitId.slice(0, 8)}`, transport: "http" },
        }),
      });

      if (regResp.ok) {
        // Heartbeat every 5 minutes to keep the registry entry alive
        this.heartbeatTimer = setInterval(() => {
          void (async () => {
            try {
              const freshToken = this.tokenFactory ? await this.tokenFactory() : authToken;
              const hbHeaders: Record<string, string> = { "Content-Type": "application/json" };
              if (freshToken) hbHeaders["Authorization"] = `Bearer ${freshToken}`;
              await fetch(`${relayUrl}/api/v1/agents/heartbeat`, {
                method: "POST",
                headers: hbHeaders,
              });
            } catch {
              // Best-effort heartbeat
            }
          })();
        }, HEARTBEAT_INTERVAL_MS);
      }
    } catch {
      // Best-effort registration
    }

    // 3. Wire RelayDelegationAdapter on the runtime for outbound delegation.
    // WS events are the source of truth for departure/return animation — the adapter
    // handles the actual task submission via HTTP.
    if (this.runtime && this.tokenFactory) {
      const tokenFactory = this.tokenFactory;
      const motebitId = this.motebitId;
      const inner = new RelayDelegationAdapter({
        syncUrl: relayUrl,
        motebitId,
        authToken: tokenFactory,
        sendRaw: () => {},
        onCustomMessage: () => () => {},
        getExplorationDrive: () => this.runtime?.getPrecision().explorationDrive,
        onDelegationFailure: () => {},
      });
      this.runtime.setDelegationAdapter(inner);
    }

    // 4. Open WebSocket for spatial presence events.
    // All visualization is event-driven — this replaces the old discovery polling loop.
    this._openPresenceWs(relayUrl, authToken);
  }

  /**
   * Disconnect from the relay and clean up visitors.
   * Best-effort deregistration.
   */
  async disconnectRelay(): Promise<void> {
    // Stop timers
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Close WS
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }

    // Best-effort deregistration
    const { relayUrl } = this.networkSettings;
    if (relayUrl !== "") {
      try {
        const headers: Record<string, string> = {};
        if (this.relayAuthToken) headers["Authorization"] = `Bearer ${this.relayAuthToken}`;
        await fetch(`${relayUrl}/api/v1/agents/deregister`, { method: "DELETE", headers });
      } catch {
        // Best-effort
      }
    }

    // Depart all visitors cleanly
    for (const id of this._visitors.keys()) {
      this.adapter.departVisitor(id);
    }
    this._visitors.clear();
  }

  // === Spatial Presence WebSocket ===

  /**
   * Open a WebSocket connection to the relay for spatial presence events.
   * Handles: delegation_departed, delegation_arrived, delegation_returning,
   * delegation_visitor_departing.
   *
   * Best-effort — closed on relay disconnect, no automatic reconnect (the app
   * works fine without it; delegation still executes via HTTP).
   */
  private _openPresenceWs(relayUrl: string, authToken: string | null): void {
    if (typeof WebSocket === "undefined") return;

    // Convert http(s) to ws(s)
    const wsUrl = relayUrl.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");

    const url = authToken
      ? `${wsUrl}/api/v1/ws?token=${encodeURIComponent(authToken)}`
      : `${wsUrl}/api/v1/ws`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      return; // Best-effort
    }

    ws.onmessage = (event) => {
      let msg: SpatialWsMessage;
      try {
        msg = JSON.parse(event.data as string) as SpatialWsMessage;
      } catch {
        return;
      }
      void this._handlePresenceEvent(msg);
    };

    ws.onerror = () => {
      /* best-effort */
    };
    ws.onclose = () => {
      if (this._ws === ws) this._ws = null;
    };

    this._ws = ws;
  }

  /**
   * Handle incoming spatial presence events from the relay WS.
   * All visualization is event-driven — no polling.
   */
  async _handlePresenceEvent(msg: SpatialWsMessage): Promise<void> {
    switch (msg.type) {
      case "delegation_departed": {
        // YOUR motebit just left to do work somewhere else.
        // A ghost remains at the original position.
        this._delegationPresence = "away";
        this._delegationTarget = msg.target_motebit_id ?? null;
        this.adapter.departCreature({ direction: { x: 0, y: 0, z: -1 } });
        break;
      }

      case "delegation_arrived": {
        // Someone ELSE's motebit just arrived in YOUR space, carrying a task.
        // Trust is the admission gate — blocked agents are never rendered.
        if (!msg.source_motebit_id) break;
        const sourceId = msg.source_motebit_id;

        const trustScore = await this._lookupTrustScore(sourceId);

        // Blocked (0.0) → invisible. Your space is sacred.
        if (trustScore === 0.0) break;

        const record: VisitorRecord = {
          motebitId: sourceId,
          trustScore,
          taskDescription: msg.task_description,
        };
        this._visitors.set(sourceId, record);

        this.adapter.arriveVisitor(sourceId, {
          motebitId: sourceId,
          trustScore,
          // Direction derived from trust: trusted closer (front), unknown from the side
          direction: this._trustToArrivalDirection(trustScore),
        });
        break;
      }

      case "delegation_returning": {
        // YOUR motebit is coming back with results.
        this._delegationPresence = "home";
        this._delegationTarget = null;
        this.adapter.returnCreature({ fromDirection: { x: 0, y: 0, z: -1 } });
        break;
      }

      case "delegation_visitor_departing": {
        // A visitor in YOUR space is leaving (work complete).
        if (!msg.source_motebit_id) break;
        const visitorId = msg.source_motebit_id;
        this._visitors.delete(visitorId);
        this.adapter.departVisitor(visitorId);
        break;
      }

      default:
        break;
    }
  }

  /**
   * Map a trust score to an arrival direction unit vector.
   * Trusted (0.9+) → arrives from front (toward you — a welcome friend)
   * Verified (0.6–0.9) → slight angle
   * Unknown (0.1) → from the side, maximum distance
   */
  private _trustToArrivalDirection(trustScore: number): { x: number; y: number; z: number } {
    if (trustScore >= 0.9) return { x: 0, y: 0, z: -1 }; // front — welcome
    if (trustScore >= 0.6) return { x: -0.5, y: 0, z: -0.866 }; // 30° off-axis
    if (trustScore >= 0.3) return { x: -0.866, y: 0, z: -0.5 }; // 60° off-axis
    return { x: -1, y: 0, z: 0 }; // side — keep distance
  }

  async _lookupTrustScore(remoteMotebitId: string): Promise<number> {
    if (!this.agentTrustStore) return trustLevelToScore(AgentTrustLevel.Unknown);

    try {
      const record = await this.agentTrustStore.getAgentTrust(this.motebitId, remoteMotebitId);
      if (record == null) return trustLevelToScore(AgentTrustLevel.Unknown);
      return trustLevelToScore(record.trust_level);
    } catch {
      return trustLevelToScore(AgentTrustLevel.Unknown);
    }
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
  tickOrbital(dt: number, time: number, headPosition: [number, number, number]): void {
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

    // Clean up relay
    void this.disconnectRelay();

    this.adapter.dispose();
  }
}
