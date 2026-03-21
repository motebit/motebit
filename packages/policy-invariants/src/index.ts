import type { MotebitState, BehaviorCues } from "@motebit/sdk";
import { SPECIES_CONSTRAINTS } from "@motebit/sdk";

// Re-export constraints for convenience
export { SPECIES_CONSTRAINTS };

/**
 * Clamp a value to [min, max].
 * Non-finite values (NaN, Infinity, -Infinity) fall back to `fallback`
 * (defaults to `min`) to prevent poisoning the render pipeline.
 */
export function clamp(value: number, min: number, max: number, fallback?: number): number {
  if (!Number.isFinite(value)) return fallback ?? min;
  return Math.min(Math.max(value, min), max);
}

/**
 * Clamp all MotebitState fields to their valid ranges.
 * affect_arousal is hard-clamped to [0, MAX_AROUSAL].
 */
export function clampState(state: MotebitState): MotebitState {
  return {
    ...state,
    attention: clamp(state.attention, 0, 1),
    processing: clamp(state.processing, 0, 1),
    confidence: clamp(state.confidence, 0, 1),
    affect_valence: clamp(state.affect_valence, -1, 1, 0),
    affect_arousal: clamp(state.affect_arousal, 0, SPECIES_CONSTRAINTS.MAX_AROUSAL),
    social_distance: clamp(state.social_distance, 0, 1),
    curiosity: clamp(state.curiosity, 0, 1),
    trust_mode: state.trust_mode,
    battery_mode: state.battery_mode,
  };
}

/**
 * Enforce delta limits on behavior cues between ticks.
 * Returns the clamped new cues.
 */
export function enforceCueDelta(prev: BehaviorCues, next: BehaviorCues): BehaviorCues {
  const clampDelta = (prevVal: number, nextVal: number, maxDelta: number): number => {
    const delta = nextVal - prevVal;
    const clamped = clamp(delta, -maxDelta, maxDelta);
    return prevVal + clamped;
  };

  return {
    hover_distance: next.hover_distance,
    drift_amplitude: next.drift_amplitude,
    glow_intensity: clampDelta(
      prev.glow_intensity,
      next.glow_intensity,
      SPECIES_CONSTRAINTS.GLOW_DELTA_MAX,
    ),
    eye_dilation: next.eye_dilation,
    smile_curvature: clampDelta(
      prev.smile_curvature,
      next.smile_curvature,
      SPECIES_CONSTRAINTS.SMILE_DELTA_MAX,
    ),
    speaking_activity: next.speaking_activity,
  };
}

/**
 * Enforce drift variation limit: drift_amplitude cannot vary more than
 * DRIFT_VARIATION_MAX from a baseline.
 */
export function enforceDriftVariation(baseline: number, current: number): number {
  const maxVariation = baseline * SPECIES_CONSTRAINTS.DRIFT_VARIATION_MAX;
  return clamp(current, baseline - maxVariation, baseline + maxVariation);
}

/**
 * Validate that a MotebitState is within all species constraints.
 * Returns an array of violation descriptions (empty = valid).
 */
export function validateState(state: MotebitState): string[] {
  const violations: string[] = [];
  if (state.affect_arousal > SPECIES_CONSTRAINTS.MAX_AROUSAL) {
    violations.push(
      `affect_arousal ${state.affect_arousal} exceeds MAX_AROUSAL ${SPECIES_CONSTRAINTS.MAX_AROUSAL}`,
    );
  }
  if (state.attention < 0 || state.attention > 1) {
    violations.push(`attention ${state.attention} out of range [0, 1]`);
  }
  if (state.processing < 0 || state.processing > 1) {
    violations.push(`processing ${state.processing} out of range [0, 1]`);
  }
  if (state.confidence < 0 || state.confidence > 1) {
    violations.push(`confidence ${state.confidence} out of range [0, 1]`);
  }
  if (state.affect_valence < -1 || state.affect_valence > 1) {
    violations.push(`affect_valence ${state.affect_valence} out of range [-1, 1]`);
  }
  if (state.social_distance < 0 || state.social_distance > 1) {
    violations.push(`social_distance ${state.social_distance} out of range [0, 1]`);
  }
  if (state.curiosity < 0 || state.curiosity > 1) {
    violations.push(`curiosity ${state.curiosity} out of range [0, 1]`);
  }
  return violations;
}

/**
 * Assert that species constraints are frozen and match expected values.
 * Call at startup for defense-in-depth.
 */
export function assertSpeciesIntegrity(): void {
  if (!Object.isFrozen(SPECIES_CONSTRAINTS)) {
    throw new Error("SPECIES_CONSTRAINTS must be frozen");
  }
  if (SPECIES_CONSTRAINTS.MAX_AROUSAL !== 0.35) {
    throw new Error("MAX_AROUSAL has been tampered with");
  }
  if (SPECIES_CONSTRAINTS.SMILE_DELTA_MAX !== 0.08) {
    throw new Error("SMILE_DELTA_MAX has been tampered with");
  }
  if (SPECIES_CONSTRAINTS.GLOW_DELTA_MAX !== 0.15) {
    throw new Error("GLOW_DELTA_MAX has been tampered with");
  }
  if (SPECIES_CONSTRAINTS.DRIFT_VARIATION_MAX !== 0.1) {
    throw new Error("DRIFT_VARIATION_MAX has been tampered with");
  }
}

// Freeze at module load
Object.freeze(SPECIES_CONSTRAINTS);
