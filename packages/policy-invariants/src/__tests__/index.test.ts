import { describe, it, expect } from "vitest";
import {
  clamp,
  clampState,
  enforceCueDelta,
  enforceDriftVariation,
  validateState,
  assertSpeciesIntegrity,
  SPECIES_CONSTRAINTS,
} from "../index";
import { TrustMode, BatteryMode } from "@mote/sdk";
import type { MoteState, BehaviorCues } from "@mote/sdk";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDefaultState(overrides: Partial<MoteState> = {}): MoteState {
  return {
    attention: 0.5,
    processing: 0.5,
    confidence: 0.5,
    affect_valence: 0,
    affect_arousal: 0.1,
    social_distance: 0.5,
    curiosity: 0.5,
    trust_mode: TrustMode.Guarded,
    battery_mode: BatteryMode.Normal,
    ...overrides,
  };
}

function makeDefaultCues(overrides: Partial<BehaviorCues> = {}): BehaviorCues {
  return {
    hover_distance: 0.4,
    drift_amplitude: 0.02,
    glow_intensity: 0.3,
    eye_dilation: 0.3,
    smile_curvature: 0,
    skirt_deformation: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// clamp()
// ---------------------------------------------------------------------------

describe("clamp", () => {
  it("returns the value when within range", () => {
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });

  it("clamps to min when value is below range", () => {
    expect(clamp(-0.5, 0, 1)).toBe(0);
  });

  it("clamps to max when value is above range", () => {
    expect(clamp(1.5, 0, 1)).toBe(1);
  });

  it("returns min when value equals min", () => {
    expect(clamp(0, 0, 1)).toBe(0);
  });

  it("returns max when value equals max", () => {
    expect(clamp(1, 0, 1)).toBe(1);
  });

  it("works with negative ranges", () => {
    expect(clamp(0, -1, 1)).toBe(0);
    expect(clamp(-2, -1, 1)).toBe(-1);
    expect(clamp(2, -1, 1)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// clampState()
// ---------------------------------------------------------------------------

describe("clampState", () => {
  it("returns state unchanged when all values are in range", () => {
    const state = makeDefaultState();
    const clamped = clampState(state);
    expect(clamped.attention).toBe(0.5);
    expect(clamped.processing).toBe(0.5);
    expect(clamped.confidence).toBe(0.5);
    expect(clamped.affect_valence).toBe(0);
    expect(clamped.affect_arousal).toBe(0.1);
    expect(clamped.social_distance).toBe(0.5);
    expect(clamped.curiosity).toBe(0.5);
  });

  it("clamps attention to [0, 1]", () => {
    const over = clampState(makeDefaultState({ attention: 2.0 }));
    expect(over.attention).toBe(1);
    const under = clampState(makeDefaultState({ attention: -1 }));
    expect(under.attention).toBe(0);
  });

  it("clamps affect_arousal to [0, MAX_AROUSAL]", () => {
    const over = clampState(makeDefaultState({ affect_arousal: 1.0 }));
    expect(over.affect_arousal).toBe(SPECIES_CONSTRAINTS.MAX_AROUSAL);
  });

  it("clamps affect_valence to [-1, 1]", () => {
    const over = clampState(makeDefaultState({ affect_valence: 2.0 }));
    expect(over.affect_valence).toBe(1);
    const under = clampState(makeDefaultState({ affect_valence: -2.0 }));
    expect(under.affect_valence).toBe(-1);
  });

  it("preserves trust_mode and battery_mode", () => {
    const state = makeDefaultState({
      trust_mode: TrustMode.Full,
      battery_mode: BatteryMode.Critical,
    });
    const clamped = clampState(state);
    expect(clamped.trust_mode).toBe(TrustMode.Full);
    expect(clamped.battery_mode).toBe(BatteryMode.Critical);
  });
});

// ---------------------------------------------------------------------------
// enforceCueDelta()
// ---------------------------------------------------------------------------

describe("enforceCueDelta", () => {
  it("limits smile_curvature delta to SMILE_DELTA_MAX", () => {
    const prev = makeDefaultCues({ smile_curvature: 0 });
    const next = makeDefaultCues({ smile_curvature: 0.5 }); // large jump
    const result = enforceCueDelta(prev, next);
    expect(result.smile_curvature).toBeCloseTo(
      SPECIES_CONSTRAINTS.SMILE_DELTA_MAX,
      10,
    );
  });

  it("limits negative smile delta", () => {
    const prev = makeDefaultCues({ smile_curvature: 0 });
    const next = makeDefaultCues({ smile_curvature: -0.5 });
    const result = enforceCueDelta(prev, next);
    expect(result.smile_curvature).toBeCloseTo(
      -SPECIES_CONSTRAINTS.SMILE_DELTA_MAX,
      10,
    );
  });

  it("limits glow_intensity delta to GLOW_DELTA_MAX", () => {
    const prev = makeDefaultCues({ glow_intensity: 0.3 });
    const next = makeDefaultCues({ glow_intensity: 0.9 }); // large jump
    const result = enforceCueDelta(prev, next);
    expect(result.glow_intensity).toBeCloseTo(
      0.3 + SPECIES_CONSTRAINTS.GLOW_DELTA_MAX,
      10,
    );
  });

  it("allows small deltas within limits", () => {
    const prev = makeDefaultCues({ smile_curvature: 0, glow_intensity: 0.3 });
    const next = makeDefaultCues({
      smile_curvature: 0.01,
      glow_intensity: 0.35,
    });
    const result = enforceCueDelta(prev, next);
    expect(result.smile_curvature).toBeCloseTo(0.01, 10);
    expect(result.glow_intensity).toBeCloseTo(0.35, 10);
  });

  it("passes through hover_distance, drift_amplitude, eye_dilation, skirt_deformation unchanged", () => {
    const prev = makeDefaultCues();
    const next = makeDefaultCues({
      hover_distance: 0.9,
      drift_amplitude: 0.1,
      eye_dilation: 0.8,
      skirt_deformation: 0.15,
    });
    const result = enforceCueDelta(prev, next);
    expect(result.hover_distance).toBe(0.9);
    expect(result.drift_amplitude).toBe(0.1);
    expect(result.eye_dilation).toBe(0.8);
    expect(result.skirt_deformation).toBe(0.15);
  });
});

// ---------------------------------------------------------------------------
// enforceDriftVariation()
// ---------------------------------------------------------------------------

describe("enforceDriftVariation", () => {
  it("returns value when within variation range", () => {
    const baseline = 0.5;
    const current = 0.52; // within 10% of 0.5
    const result = enforceDriftVariation(baseline, current);
    expect(result).toBeCloseTo(0.52, 10);
  });

  it("clamps value when above max variation", () => {
    const baseline = 0.5;
    const current = 0.8; // way above 10% variation (0.05)
    const result = enforceDriftVariation(baseline, current);
    expect(result).toBeCloseTo(
      baseline + baseline * SPECIES_CONSTRAINTS.DRIFT_VARIATION_MAX,
      10,
    );
  });

  it("clamps value when below min variation", () => {
    const baseline = 0.5;
    const current = 0.1; // way below
    const result = enforceDriftVariation(baseline, current);
    expect(result).toBeCloseTo(
      baseline - baseline * SPECIES_CONSTRAINTS.DRIFT_VARIATION_MAX,
      10,
    );
  });
});

// ---------------------------------------------------------------------------
// validateState()
// ---------------------------------------------------------------------------

describe("validateState", () => {
  it("returns empty array for valid state", () => {
    const state = makeDefaultState();
    expect(validateState(state)).toEqual([]);
  });

  it("reports affect_arousal exceeding MAX_AROUSAL", () => {
    const state = makeDefaultState({ affect_arousal: 0.5 });
    const violations = validateState(state);
    expect(violations.length).toBeGreaterThanOrEqual(1);
    expect(violations.some((v) => v.includes("affect_arousal"))).toBe(true);
  });

  it("reports attention out of range", () => {
    const state = makeDefaultState({ attention: -0.1 });
    const violations = validateState(state);
    expect(violations.some((v) => v.includes("attention"))).toBe(true);
  });

  it("reports multiple violations at once", () => {
    const state = makeDefaultState({
      attention: 2.0,
      processing: -1.0,
      affect_arousal: 1.0,
    });
    const violations = validateState(state);
    expect(violations.length).toBe(3);
  });

  it("reports affect_valence out of range", () => {
    const violations = validateState(makeDefaultState({ affect_valence: 1.5 }));
    expect(violations.some((v) => v.includes("affect_valence"))).toBe(true);
  });

  it("reports social_distance out of range", () => {
    const violations = validateState(
      makeDefaultState({ social_distance: -0.1 }),
    );
    expect(violations.some((v) => v.includes("social_distance"))).toBe(true);
  });

  it("reports curiosity out of range", () => {
    const violations = validateState(makeDefaultState({ curiosity: 1.5 }));
    expect(violations.some((v) => v.includes("curiosity"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// assertSpeciesIntegrity()
// ---------------------------------------------------------------------------

describe("assertSpeciesIntegrity", () => {
  it("does not throw for intact constraints", () => {
    expect(() => assertSpeciesIntegrity()).not.toThrow();
  });
});
