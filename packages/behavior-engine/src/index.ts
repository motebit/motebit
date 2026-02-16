import type { MoteState, BehaviorCues } from "@mote/sdk";
import { clamp, enforceCueDelta, enforceDriftVariation } from "@mote/policy-invariants";

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
export function computeRawCues(state: MoteState): BehaviorCues {
  // Hover distance: high attention → closer, idle → retreat
  const attentionDistance = SPATIAL.FACE_DISTANCE + (1 - state.attention) * (SPATIAL.SHOULDER_DISTANCE - SPATIAL.FACE_DISTANCE);
  const idleBlend = 1 - Math.max(state.attention, state.processing, state.curiosity);
  const hover_distance = attentionDistance + idleBlend * (SPATIAL.RETREAT_DISTANCE - SPATIAL.SHOULDER_DISTANCE);

  // Drift amplitude: slight increase with curiosity, decrease in low power
  const batteryFactor = state.battery_mode === "critical" ? 0.3 : state.battery_mode === "low_power" ? 0.6 : 1.0;
  const drift_amplitude = SPATIAL.BASE_DRIFT * (1 + state.curiosity * 0.5) * batteryFactor;

  // Glow: processing and confidence
  const glow_intensity = SPATIAL.BASE_GLOW + state.processing * 0.3 + state.confidence * 0.2;

  // Eye dilation: attention and curiosity
  const eye_dilation = clamp(0.3 + state.attention * 0.4 + state.curiosity * 0.3, 0, 1);

  // Smile: positive valence only, very subtle
  const smile_curvature = clamp(state.affect_valence * 0.15, -0.1, 0.15);

  // Skirt deformation: arousal (already clamped to 0.35 max in state)
  const skirt_deformation = state.affect_arousal * 0.5;

  return {
    hover_distance,
    drift_amplitude,
    glow_intensity: clamp(glow_intensity, 0, 1),
    eye_dilation,
    smile_curvature,
    skirt_deformation: clamp(skirt_deformation, 0, 0.2),
  };
}

// === Behavior Engine ===

export class BehaviorEngine {
  private previousCues: BehaviorCues;
  private baselineDrift: number = SPATIAL.BASE_DRIFT;

  constructor() {
    this.previousCues = {
      hover_distance: SPATIAL.SHOULDER_DISTANCE,
      drift_amplitude: SPATIAL.BASE_DRIFT,
      glow_intensity: SPATIAL.BASE_GLOW,
      eye_dilation: 0.3,
      smile_curvature: 0,
      skirt_deformation: 0,
    };
  }

  /**
   * Compute cues from state with all hard clamps enforced.
   * This is the main API — call once per tick.
   */
  compute(state: MoteState): BehaviorCues {
    // 1. Compute raw cues
    const raw = computeRawCues(state);

    // 2. Enforce delta limits (smile, glow rate-of-change)
    const deltaClamped = enforceCueDelta(this.previousCues, raw);

    // 3. Enforce drift variation
    deltaClamped.drift_amplitude = enforceDriftVariation(
      this.baselineDrift,
      deltaClamped.drift_amplitude,
    );

    // 4. Store for next tick
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
    this.previousCues = {
      hover_distance: SPATIAL.SHOULDER_DISTANCE,
      drift_amplitude: SPATIAL.BASE_DRIFT,
      glow_intensity: SPATIAL.BASE_GLOW,
      eye_dilation: 0.3,
      smile_curvature: 0,
      skirt_deformation: 0,
    };
  }
}
