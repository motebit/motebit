import { type MotebitState, type BehaviorCues, BatteryMode } from "@motebit/sdk";
import { clamp, enforceCueDelta, enforceDriftVariation } from "@motebit/policy-invariants";

// === Spatial Constants ===

const SPATIAL = {
  SHOULDER_DISTANCE: 0.4, // Equilibrium orbit distance
  FACE_DISTANCE: 0.15, // Near-face when high attention
  RETREAT_DISTANCE: 0.8, // Retreat when idle
  BASE_DRIFT: 0.02, // Base drift amplitude
  BASE_GLOW: 0.3, // Base glow intensity
} as const;

// === Pure Computation ===

/**
 * Compute raw behavior cues from state. Pure function — no side effects.
 * This produces unclamped cues; delta enforcement happens separately.
 */
export function computeRawCues(state: MotebitState): BehaviorCues {
  // Hover distance: high attention → closer, idle → retreat
  const attentionDistance = SPATIAL.FACE_DISTANCE + (1 - state.attention) * (SPATIAL.SHOULDER_DISTANCE - SPATIAL.FACE_DISTANCE);
  const idleBlend = 1 - Math.max(state.attention, state.processing, state.curiosity);
  const hover_distance = attentionDistance + idleBlend * (SPATIAL.RETREAT_DISTANCE - SPATIAL.SHOULDER_DISTANCE);

  // Drift amplitude: slight increase with curiosity, decrease in low power
  const batteryFactor = state.battery_mode === BatteryMode.Critical ? 0.3 : state.battery_mode === BatteryMode.LowPower ? 0.6 : 1.0;
  const drift_amplitude = SPATIAL.BASE_DRIFT * (1 + state.curiosity * 0.5) * batteryFactor;

  // Glow: processing and confidence
  const glow_intensity = SPATIAL.BASE_GLOW + state.processing * 0.3 + state.confidence * 0.2;

  // Eye dilation: attention and curiosity
  const eye_dilation = clamp(0.3 + state.attention * 0.4 + state.curiosity * 0.3, 0, 1);

  // Smile: affect maps to visible curvature
  const smile_curvature = clamp(state.affect_valence * 0.35, -0.15, 0.30);

  return {
    hover_distance,
    drift_amplitude,
    glow_intensity: clamp(glow_intensity, 0, 1),
    eye_dilation,
    smile_curvature,
    speaking_activity: 0,
  };
}

// === Behavior Engine ===

// === Impulse ===
// Short-lived additive signals from action tags — immediate visual pop that decays exponentially.

interface Impulse {
  field: keyof BehaviorCues;
  magnitude: number;
  halfLife: number; // seconds
  startTime: number; // Date.now()
}

/** Trust context for ambient behavior modulation. */
export interface TrustContext {
  /** Average trust level across known agents (0=unknown, 1=first_contact, 2=verified, 3=trusted). Blocked agents excluded. */
  avgTrustLevel: number;
  /** Number of agents at Trusted level. */
  trustedCount: number;
}

export class BehaviorEngine {
  private previousCues: BehaviorCues;
  private baselineDrift: number = SPATIAL.BASE_DRIFT;
  private _speaking = false;
  private _delegating = false;
  private _trustContext: TrustContext | null = null;
  private impulses: Impulse[] = [];

  constructor() {
    this.previousCues = {
      hover_distance: SPATIAL.SHOULDER_DISTANCE,
      drift_amplitude: SPATIAL.BASE_DRIFT,
      glow_intensity: SPATIAL.BASE_GLOW,
      eye_dilation: 0.3,
      smile_curvature: 0,
      speaking_activity: 0,
    };
  }

  /** Signal whether the agent is currently generating text. */
  setSpeaking(active: boolean): void {
    this._speaking = active;
  }

  /** Signal whether the agent is currently delegating to another motebit. */
  setDelegating(active: boolean): void {
    this._delegating = active;
  }

  /** Update ambient trust context — affects glow and social distance subtly. */
  setTrustContext(ctx: TrustContext | null): void {
    this._trustContext = ctx;
  }

  /** Inject a short-lived impulse for immediate visual pop (e.g. from action tags). */
  injectImpulse(field: keyof BehaviorCues, magnitude: number, halfLife: number): void {
    this.impulses.push({ field, magnitude, halfLife, startTime: Date.now() });
  }

  /**
   * Compute cues from state with all hard clamps enforced.
   * This is the main API — call once per tick.
   */
  compute(state: MotebitState): BehaviorCues {
    // 1. Compute raw cues
    const raw = computeRawCues(state);

    // 2. Enforce delta limits (smile, glow rate-of-change)
    const deltaClamped = enforceCueDelta(this.previousCues, raw);

    // 3. Enforce drift variation
    deltaClamped.drift_amplitude = enforceDriftVariation(
      this.baselineDrift,
      deltaClamped.drift_amplitude,
    );

    // 4. Apply impulses additively
    const now = Date.now();
    const cueRecord = deltaClamped as unknown as Record<string, number>;
    for (const imp of this.impulses) {
      const elapsed = (now - imp.startTime) / 1000;
      const decay = Math.pow(2, -elapsed / imp.halfLife);
      cueRecord[imp.field] = (cueRecord[imp.field] ?? 0) + imp.magnitude * decay;
    }
    // Clean up expired impulses (decay < 0.01)
    this.impulses = this.impulses.filter((imp) => {
      const elapsed = (now - imp.startTime) / 1000;
      return Math.pow(2, -elapsed / imp.halfLife) >= 0.01;
    });

    // 5. Delegation glow boost — subtle brightness increase when delegating to another motebit
    if (this._delegating) {
      deltaClamped.glow_intensity = clamp(deltaClamped.glow_intensity + 0.08, 0, 1);
    }

    // 6. Trust network ambient effect — more trusted agents → slightly warmer glow, slightly closer social distance
    if (this._trustContext != null && this._trustContext.trustedCount > 0) {
      // avgTrustLevel ranges 0-3; normalize to 0-1 for modulation
      const trustFactor = clamp(this._trustContext.avgTrustLevel / 3, 0, 1);
      deltaClamped.glow_intensity = clamp(deltaClamped.glow_intensity + trustFactor * 0.05, 0, 1);
      deltaClamped.hover_distance = Math.max(0, deltaClamped.hover_distance - trustFactor * 0.03);
    }

    // 7. Speaking activity
    deltaClamped.speaking_activity = this._speaking ? 1 : 0;

    // 8. Duchenne eye squint — positive smile narrows the eyes slightly
    if (deltaClamped.smile_curvature > 0) {
      deltaClamped.eye_dilation -= deltaClamped.smile_curvature * 0.12;
    }

    // 9. Store for next tick
    this.previousCues = { ...deltaClamped };

    return deltaClamped;
  }

  /**
   * Get the previous cues (useful for interpolation).
   */
  getPreviousCues(): BehaviorCues {
    return { ...this.previousCues };
  }

  /**
   * Reset to default calm state.
   */
  reset(): void {
    this.impulses = [];
    this._speaking = false;
    this._trustContext = null;
    this._delegating = false;
    this.previousCues = {
      hover_distance: SPATIAL.SHOULDER_DISTANCE,
      drift_amplitude: SPATIAL.BASE_DRIFT,
      glow_intensity: SPATIAL.BASE_GLOW,
      eye_dilation: 0.3,
      smile_curvature: 0,
      speaking_activity: 0,
    };
  }
}
