import type { MotebitState } from "@motebit/sdk";
import { TrustMode, BatteryMode } from "@motebit/sdk";
import { clampState } from "@motebit/policy-invariants";

// === Types ===

export interface StateVectorConfig {
  tick_rate_hz: number; // 1-2 Hz for state computation
  ema_alpha: number; // Smoothing factor [0, 1]
  hysteresis_threshold: number; // Minimum delta to trigger transition
  hysteresis_sustain_ms: number; // How long threshold must be sustained
}

export interface StateSubscriber {
  (state: MotebitState): void;
}

export interface InterpolatedState extends MotebitState {
  interpolation_t: number; // [0, 1] between prev and next tick
}

// === Default Config ===

const DEFAULT_CONFIG: StateVectorConfig = {
  tick_rate_hz: 2,
  ema_alpha: 0.1, // Slow settle — state changes take ~3s to fully express
  hysteresis_threshold: 0.05,
  hysteresis_sustain_ms: 500,
};

// === Default State ===

function defaultState(): MotebitState {
  return {
    attention: 0,
    processing: 0,
    confidence: 0.5,
    affect_valence: 0,
    affect_arousal: 0,
    social_distance: 0.5,
    curiosity: 0,
    trust_mode: TrustMode.Guarded,
    battery_mode: BatteryMode.Normal,
  };
}

// === Hysteresis Tracker ===

interface HysteresisEntry {
  field: string;
  target_value: number;
  sustained_since: number | null;
}

// === State Vector Engine ===

export class StateVectorEngine {
  private config: StateVectorConfig;
  private currentState: MotebitState;
  private previousState: MotebitState;
  private rawInputState: MotebitState;
  private subscribers: Set<StateSubscriber> = new Set();
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private lastTickTime: number = 0;
  private hysteresis: Map<string, HysteresisEntry> = new Map();

  constructor(config: Partial<StateVectorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.currentState = defaultState();
    this.previousState = defaultState();
    this.rawInputState = defaultState();
  }

  /**
   * Start the tick loop at the configured rate.
   */
  start(): void {
    if (this.tickInterval !== null) return;
    const intervalMs = 1000 / this.config.tick_rate_hz;
    this.lastTickTime = Date.now();
    this.tickInterval = setInterval(() => this.tick(), intervalMs);
  }

  /**
   * Stop the tick loop.
   */
  stop(): void {
    if (this.tickInterval !== null) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }

  /**
   * Push raw state updates from external sources (AI, sensors, etc).
   */
  pushUpdate(partial: Partial<MotebitState>): void {
    this.rawInputState = { ...this.rawInputState, ...partial };
  }

  /**
   * Subscribe to state changes.
   */
  subscribe(subscriber: StateSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  /**
   * Get the current computed state.
   */
  getState(): MotebitState {
    return { ...this.currentState };
  }

  /**
   * Get interpolated state for 60 FPS rendering.
   * t is the fraction of time elapsed since last tick [0, 1].
   */
  getInterpolatedState(t: number): InterpolatedState {
    const clamped_t = Math.min(Math.max(t, 0), 1);
    const lerp = (a: number, b: number): number => a + (b - a) * clamped_t;

    return {
      attention: lerp(this.previousState.attention, this.currentState.attention),
      processing: lerp(this.previousState.processing, this.currentState.processing),
      confidence: lerp(this.previousState.confidence, this.currentState.confidence),
      affect_valence: lerp(this.previousState.affect_valence, this.currentState.affect_valence),
      affect_arousal: lerp(this.previousState.affect_arousal, this.currentState.affect_arousal),
      social_distance: lerp(this.previousState.social_distance, this.currentState.social_distance),
      curiosity: lerp(this.previousState.curiosity, this.currentState.curiosity),
      trust_mode: this.currentState.trust_mode,
      battery_mode: this.currentState.battery_mode,
      interpolation_t: clamped_t,
    };
  }

  /**
   * Get time fraction since last tick for interpolation.
   */
  getTickFraction(): number {
    if (this.lastTickTime === 0) return 0;
    const elapsed = Date.now() - this.lastTickTime;
    const tickInterval = 1000 / this.config.tick_rate_hz;
    return Math.min(elapsed / tickInterval, 1);
  }

  /**
   * Core tick: apply EMA smoothing, hysteresis, and clamp.
   */
  private tick(): void {
    const now = Date.now();
    this.previousState = { ...this.currentState };

    // EMA smoothing for numeric fields
    const alpha = this.config.ema_alpha;
    const numericFields = [
      "attention",
      "processing",
      "confidence",
      "affect_valence",
      "affect_arousal",
      "social_distance",
      "curiosity",
    ] as const;

    const smoothed = { ...this.currentState };
    for (const field of numericFields) {
      const raw = this.rawInputState[field];
      const prev = this.currentState[field];
      const ema = alpha * raw + (1 - alpha) * prev;

      // Hysteresis: only commit if sustained above threshold
      if (this.applyHysteresis(field, ema, prev, now)) {
        smoothed[field] = ema;
      }
    }

    // Copy enum fields directly
    smoothed.trust_mode = this.rawInputState.trust_mode;
    smoothed.battery_mode = this.rawInputState.battery_mode;

    // Clamp all values (defense in depth via policy-invariants)
    this.currentState = clampState(smoothed);
    this.lastTickTime = now;

    // Notify subscribers
    for (const sub of this.subscribers) {
      sub(this.currentState);
    }
  }

  private applyHysteresis(
    field: string,
    newValue: number,
    currentValue: number,
    now: number,
  ): boolean {
    const delta = Math.abs(newValue - currentValue);
    if (delta < this.config.hysteresis_threshold) {
      this.hysteresis.delete(field);
      return false;
    }

    const entry = this.hysteresis.get(field);
    if (entry === undefined) {
      this.hysteresis.set(field, {
        field,
        target_value: newValue,
        sustained_since: now,
      });
      return false;
    }

    if (entry.sustained_since !== null) {
      const sustained = now - entry.sustained_since;
      if (sustained >= this.config.hysteresis_sustain_ms) {
        this.hysteresis.delete(field);
        return true;
      }
    }

    return false;
  }

  /**
   * Serialize state for sync.
   */
  serialize(): string {
    return JSON.stringify(this.currentState);
  }

  /**
   * Restore state from serialized form.
   */
  deserialize(data: string): void {
    const parsed = JSON.parse(data) as MotebitState;
    this.currentState = clampState(parsed);
    this.previousState = { ...this.currentState };
    this.rawInputState = { ...this.currentState };
  }
}
