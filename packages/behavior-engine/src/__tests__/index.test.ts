import { describe, it, expect, beforeEach } from "vitest";
import { computeRawCues, BehaviorEngine } from "../index";
import { TrustMode, BatteryMode, SPECIES_CONSTRAINTS } from "@motebit/sdk";
import type { MotebitState } from "@motebit/sdk";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDefaultState(overrides: Partial<MotebitState> = {}): MotebitState {
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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeRawCues()
// ---------------------------------------------------------------------------

describe("computeRawCues", () => {
  it("produces valid cues from default state", () => {
    const cues = computeRawCues(makeDefaultState());
    expect(typeof cues.hover_distance).toBe("number");
    expect(typeof cues.drift_amplitude).toBe("number");
    expect(typeof cues.glow_intensity).toBe("number");
    expect(typeof cues.eye_dilation).toBe("number");
    expect(typeof cues.smile_curvature).toBe("number");

  });

  it("higher attention leads to closer hover distance", () => {
    const lowAttn = computeRawCues(makeDefaultState({ attention: 0 }));
    const highAttn = computeRawCues(makeDefaultState({ attention: 1 }));
    expect(highAttn.hover_distance).toBeLessThan(lowAttn.hover_distance);
  });

  it("positive valence produces positive smile curvature", () => {
    const cues = computeRawCues(makeDefaultState({ affect_valence: 1.0 }));
    expect(cues.smile_curvature).toBeGreaterThan(0);
  });

  it("negative valence produces negative smile curvature", () => {
    const cues = computeRawCues(makeDefaultState({ affect_valence: -1.0 }));
    expect(cues.smile_curvature).toBeLessThan(0);
  });

  it("critical battery mode reduces drift amplitude", () => {
    const normal = computeRawCues(
      makeDefaultState({ battery_mode: BatteryMode.Normal, curiosity: 0.5 }),
    );
    const critical = computeRawCues(
      makeDefaultState({ battery_mode: BatteryMode.Critical, curiosity: 0.5 }),
    );
    expect(critical.drift_amplitude).toBeLessThan(normal.drift_amplitude);
  });

  it("higher processing increases glow intensity", () => {
    const low = computeRawCues(makeDefaultState({ processing: 0 }));
    const high = computeRawCues(makeDefaultState({ processing: 1 }));
    expect(high.glow_intensity).toBeGreaterThan(low.glow_intensity);
  });
});

// ---------------------------------------------------------------------------
// BehaviorEngine
// ---------------------------------------------------------------------------

describe("BehaviorEngine", () => {
  let engine: BehaviorEngine;

  beforeEach(() => {
    engine = new BehaviorEngine();
  });

  it("compute() returns clamped output", () => {
    const state = makeDefaultState({ affect_arousal: 0.35 });
    const cues = engine.compute(state);
    expect(cues.glow_intensity).toBeGreaterThanOrEqual(0);
    expect(cues.glow_intensity).toBeLessThanOrEqual(1);
    expect(cues.glow_intensity).toBeGreaterThanOrEqual(0);
    expect(cues.glow_intensity).toBeLessThanOrEqual(1);
  });

  it("compute() enforces smile delta max", () => {
    // First call to establish baseline
    engine.compute(makeDefaultState({ affect_valence: 0 }));

    // Second call with a huge valence jump
    const cues = engine.compute(makeDefaultState({ affect_valence: 1.0 }));

    // The smile_curvature should be limited by SMILE_DELTA_MAX from previous (0)
    expect(Math.abs(cues.smile_curvature)).toBeLessThanOrEqual(
      SPECIES_CONSTRAINTS.SMILE_DELTA_MAX + 0.001,
    );
  });

  it("compute() enforces glow delta max", () => {
    // First call at low processing
    engine.compute(makeDefaultState({ processing: 0, confidence: 0 }));

    // Second call with huge processing jump
    const cues = engine.compute(
      makeDefaultState({ processing: 1.0, confidence: 1.0 }),
    );

    // The glow_intensity change should be limited
    const prevGlow = 0.3; // BASE_GLOW from first compute
    const delta = Math.abs(cues.glow_intensity - prevGlow);
    expect(delta).toBeLessThanOrEqual(
      SPECIES_CONSTRAINTS.GLOW_DELTA_MAX + 0.001,
    );
  });

  it("compute() enforces drift variation", () => {
    const cues = engine.compute(makeDefaultState({ curiosity: 1.0 }));
    const baseDrift = 0.02;
    const maxVariation = baseDrift * SPECIES_CONSTRAINTS.DRIFT_VARIATION_MAX;
    expect(cues.drift_amplitude).toBeGreaterThanOrEqual(
      baseDrift - maxVariation - 0.001,
    );
    expect(cues.drift_amplitude).toBeLessThanOrEqual(
      baseDrift + maxVariation + 0.001,
    );
  });

  it("reset() returns to default calm cues", () => {
    // Run a compute to change state
    engine.compute(
      makeDefaultState({
        attention: 1,
        processing: 1,
        affect_valence: 1,
      }),
    );

    engine.reset();
    const prev = engine.getPreviousCues();
    expect(prev.hover_distance).toBe(0.4); // SHOULDER_DISTANCE
    expect(prev.drift_amplitude).toBe(0.02); // BASE_DRIFT
    expect(prev.glow_intensity).toBe(0.3); // BASE_GLOW
    expect(prev.eye_dilation).toBe(0.3);
    expect(prev.smile_curvature).toBe(0);
    expect(prev.smile_curvature).toBe(0);
  });

  it("getPreviousCues() returns a copy", () => {
    const a = engine.getPreviousCues();
    const b = engine.getPreviousCues();
    a.hover_distance = 999;
    expect(b.hover_distance).toBe(0.4);
  });
});
