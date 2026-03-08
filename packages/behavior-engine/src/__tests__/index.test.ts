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

  it("successive computes converge toward target cues", () => {
    const highState = makeDefaultState({ processing: 1, confidence: 1, attention: 1 });
    const prev = engine.getPreviousCues();

    // Run multiple ticks — glow should converge upward
    for (let i = 0; i < 20; i++) {
      engine.compute(highState);
    }
    const after = engine.getPreviousCues();
    expect(after.glow_intensity).toBeGreaterThan(prev.glow_intensity);
  });

  it("compute with all-zero state produces calm baseline", () => {
    const cues = engine.compute(makeDefaultState({
      attention: 0,
      processing: 0,
      confidence: 0,
      affect_valence: 0,
      curiosity: 0,
    }));
    // Should be near baseline values
    expect(cues.smile_curvature).toBe(0);
    expect(cues.eye_dilation).toBeCloseTo(0.3, 1);
    expect(cues.drift_amplitude).toBeCloseTo(0.02, 2);
  });

  it("compute with all-max state still produces valid cues", () => {
    const cues = engine.compute(makeDefaultState({
      attention: 1,
      processing: 1,
      confidence: 1,
      affect_valence: 1,
      affect_arousal: 0.35,
      curiosity: 1,
    }));
    // All values should be finite
    expect(Number.isFinite(cues.hover_distance)).toBe(true);
    expect(Number.isFinite(cues.drift_amplitude)).toBe(true);
    expect(Number.isFinite(cues.glow_intensity)).toBe(true);
    expect(Number.isFinite(cues.eye_dilation)).toBe(true);
    expect(Number.isFinite(cues.smile_curvature)).toBe(true);
    // Glow should be clamped to [0, 1]
    expect(cues.glow_intensity).toBeLessThanOrEqual(1);
    expect(cues.glow_intensity).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// computeRawCues — boundary conditions
// ---------------------------------------------------------------------------

describe("computeRawCues boundary conditions", () => {
  it("eye_dilation is clamped to [0, 1]", () => {
    const cues = computeRawCues(makeDefaultState({ attention: 1, curiosity: 1 }));
    expect(cues.eye_dilation).toBeLessThanOrEqual(1);
    expect(cues.eye_dilation).toBeGreaterThanOrEqual(0);
  });

  it("smile_curvature is clamped to [-0.15, 0.30]", () => {
    const positive = computeRawCues(makeDefaultState({ affect_valence: 1 }));
    expect(positive.smile_curvature).toBeLessThanOrEqual(0.30);

    const negative = computeRawCues(makeDefaultState({ affect_valence: -1 }));
    expect(negative.smile_curvature).toBeGreaterThanOrEqual(-0.15);
  });

  it("glow_intensity is clamped to [0, 1]", () => {
    const maxGlow = computeRawCues(makeDefaultState({ processing: 1, confidence: 1 }));
    expect(maxGlow.glow_intensity).toBeLessThanOrEqual(1);
    expect(maxGlow.glow_intensity).toBeGreaterThanOrEqual(0);

    const minGlow = computeRawCues(makeDefaultState({ processing: 0, confidence: 0 }));
    expect(minGlow.glow_intensity).toBeLessThanOrEqual(1);
    expect(minGlow.glow_intensity).toBeGreaterThanOrEqual(0);
  });

  it("low-power battery mode reduces drift more than normal", () => {
    const normal = computeRawCues(makeDefaultState({ battery_mode: BatteryMode.Normal, curiosity: 0.5 }));
    const lowPower = computeRawCues(makeDefaultState({ battery_mode: BatteryMode.LowPower, curiosity: 0.5 }));
    const critical = computeRawCues(makeDefaultState({ battery_mode: BatteryMode.Critical, curiosity: 0.5 }));

    expect(lowPower.drift_amplitude).toBeLessThan(normal.drift_amplitude);
    expect(critical.drift_amplitude).toBeLessThan(lowPower.drift_amplitude);
  });

  it("curiosity increases drift amplitude", () => {
    const noCuriosity = computeRawCues(makeDefaultState({ curiosity: 0 }));
    const fullCuriosity = computeRawCues(makeDefaultState({ curiosity: 1 }));
    expect(fullCuriosity.drift_amplitude).toBeGreaterThan(noCuriosity.drift_amplitude);
  });

  it("higher confidence increases glow", () => {
    const lowConf = computeRawCues(makeDefaultState({ confidence: 0 }));
    const highConf = computeRawCues(makeDefaultState({ confidence: 1 }));
    expect(highConf.glow_intensity).toBeGreaterThan(lowConf.glow_intensity);
  });

  it("zero valence produces zero smile curvature", () => {
    const cues = computeRawCues(makeDefaultState({ affect_valence: 0 }));
    expect(cues.smile_curvature).toBe(0);
  });

  it("hover distance reaches minimum at full attention", () => {
    const full = computeRawCues(makeDefaultState({ attention: 1, processing: 1, curiosity: 1 }));
    // With maximum attention/processing/curiosity, idleBlend = 0, so hover = attentionDistance
    // attentionDistance at attention=1 is FACE_DISTANCE (0.15)
    expect(full.hover_distance).toBeCloseTo(0.15, 1);
  });

  it("hover distance reaches maximum when fully idle", () => {
    const idle = computeRawCues(makeDefaultState({ attention: 0, processing: 0, curiosity: 0 }));
    // idleBlend = 1, attentionDistance = SHOULDER_DISTANCE (0.4)
    // hover = 0.4 + 1 * (0.8 - 0.4) = 0.8 (RETREAT_DISTANCE)
    expect(idle.hover_distance).toBeCloseTo(0.8, 1);
  });

  it("attention + curiosity increase eye dilation", () => {
    const low = computeRawCues(makeDefaultState({ attention: 0, curiosity: 0 }));
    const high = computeRawCues(makeDefaultState({ attention: 1, curiosity: 1 }));
    expect(high.eye_dilation).toBeGreaterThan(low.eye_dilation);
  });
});

// ---------------------------------------------------------------------------
// BehaviorEngine — speaking & impulses
// ---------------------------------------------------------------------------

describe("BehaviorEngine speaking and impulses", () => {
  it("setSpeaking sets speaking_activity to 1 when active", () => {
    const engine = new BehaviorEngine();
    engine.setSpeaking(true);
    const cues = engine.compute(makeDefaultState());
    expect(cues.speaking_activity).toBe(1);
  });

  it("setSpeaking sets speaking_activity to 0 when inactive", () => {
    const engine = new BehaviorEngine();
    engine.setSpeaking(true);
    engine.compute(makeDefaultState());
    engine.setSpeaking(false);
    const cues = engine.compute(makeDefaultState());
    expect(cues.speaking_activity).toBe(0);
  });

  it("injectImpulse adds to cue field", () => {
    const engine = new BehaviorEngine();
    engine.injectImpulse("smile_curvature", 0.1, 2);
    const cues = engine.compute(makeDefaultState());
    expect(cues.smile_curvature).toBeGreaterThan(0);
  });

  it("impulses decay over time", () => {
    const engine = new BehaviorEngine();
    engine.injectImpulse("smile_curvature", 0.5, 0.001); // very short half-life
    // Wait for decay
    const start = Date.now();
    while (Date.now() - start < 20) { /* spin */ }
    const cues = engine.compute(makeDefaultState());
    // With such a short half-life, the impulse should be cleaned up
    expect(cues.smile_curvature).toBeLessThan(0.5);
  });

  it("reset clears impulses and speaking state", () => {
    const engine = new BehaviorEngine();
    engine.setSpeaking(true);
    engine.injectImpulse("smile_curvature", 0.5, 10);
    engine.reset();
    const cues = engine.compute(makeDefaultState());
    expect(cues.speaking_activity).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// BehaviorEngine — delegation glow boost
// ---------------------------------------------------------------------------

describe("BehaviorEngine delegation glow", () => {
  it("setDelegating boosts glow_intensity by 0.08", () => {
    const engine = new BehaviorEngine();
    const baseline = engine.compute(makeDefaultState());
    const baseGlow = baseline.glow_intensity;

    engine.setDelegating(true);
    const delegating = engine.compute(makeDefaultState());
    expect(delegating.glow_intensity).toBeCloseTo(baseGlow + 0.08, 2);
  });

  it("setDelegating(false) removes the glow boost", () => {
    const engine = new BehaviorEngine();

    engine.setDelegating(true);
    engine.compute(makeDefaultState());

    engine.setDelegating(false);
    const cues = engine.compute(makeDefaultState());

    // Without delegation, glow should be at baseline level
    const baselineEngine = new BehaviorEngine();
    // Advance baseline engine to the same tick count for delta clamping parity
    baselineEngine.compute(makeDefaultState());
    const baseline = baselineEngine.compute(makeDefaultState());
    expect(cues.glow_intensity).toBeCloseTo(baseline.glow_intensity, 2);
  });

  it("delegation glow is clamped to 1.0", () => {
    const engine = new BehaviorEngine();
    // High processing + confidence already produces high glow
    const state = makeDefaultState({ processing: 1, confidence: 1 });
    engine.setDelegating(true);
    const cues = engine.compute(state);
    expect(cues.glow_intensity).toBeLessThanOrEqual(1.0);
  });

  it("reset clears delegation state", () => {
    const engine = new BehaviorEngine();
    engine.setDelegating(true);
    engine.reset();
    // After reset, compute should produce baseline glow (no delegation boost)
    const cues = engine.compute(makeDefaultState());
    const baselineEngine = new BehaviorEngine();
    const baseline = baselineEngine.compute(makeDefaultState());
    expect(cues.glow_intensity).toBeCloseTo(baseline.glow_intensity, 2);
  });
});
