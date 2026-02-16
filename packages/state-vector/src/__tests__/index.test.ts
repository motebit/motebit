import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StateVectorEngine } from "../index";
import { TrustMode, BatteryMode } from "@motebit/sdk";

// ---------------------------------------------------------------------------
// StateVectorEngine
// ---------------------------------------------------------------------------

describe("StateVectorEngine", () => {
  let engine: StateVectorEngine;

  beforeEach(() => {
    vi.useFakeTimers();
    engine = new StateVectorEngine({
      tick_rate_hz: 2,
      ema_alpha: 0.3,
      hysteresis_threshold: 0.05,
      hysteresis_sustain_ms: 500,
    });
  });

  afterEach(() => {
    engine.stop();
    vi.useRealTimers();
  });

  it("starts with correct default state values", () => {
    const state = engine.getState();
    expect(state.attention).toBe(0);
    expect(state.processing).toBe(0);
    expect(state.confidence).toBe(0.5);
    expect(state.affect_valence).toBe(0);
    expect(state.affect_arousal).toBe(0);
    expect(state.social_distance).toBe(0.5);
    expect(state.curiosity).toBe(0);
    expect(state.trust_mode).toBe(TrustMode.Guarded);
    expect(state.battery_mode).toBe(BatteryMode.Normal);
  });

  it("pushUpdate changes the raw input state", () => {
    engine.pushUpdate({ attention: 0.8 });
    // Raw input changed but tick hasn't run yet, so current state is still default
    const state = engine.getState();
    expect(state.attention).toBe(0);
  });

  it("getInterpolatedState lerps correctly", () => {
    // Manually set up states by pushing update and ticking
    // After default, previous = current = default
    const interp = engine.getInterpolatedState(0.5);
    // Both previous and current are the same, so lerp returns same value
    expect(interp.attention).toBe(0);
    expect(interp.confidence).toBe(0.5);
    expect(interp.interpolation_t).toBe(0.5);
  });

  it("getInterpolatedState clamps t to [0, 1]", () => {
    const over = engine.getInterpolatedState(2.0);
    expect(over.interpolation_t).toBe(1);
    const under = engine.getInterpolatedState(-1.0);
    expect(under.interpolation_t).toBe(0);
  });

  it("getState returns a copy (not a reference)", () => {
    const stateA = engine.getState();
    const stateB = engine.getState();
    stateA.attention = 999;
    expect(stateB.attention).toBe(0);
  });

  it("getState returns clamped values after tick", () => {
    // Push a very large arousal value
    engine.pushUpdate({ affect_arousal: 10.0 });
    engine.start();

    // Advance time to trigger tick and sustain hysteresis
    vi.advanceTimersByTime(600);
    vi.advanceTimersByTime(600);

    const state = engine.getState();
    // affect_arousal should be clamped to MAX_AROUSAL (0.35)
    expect(state.affect_arousal).toBeLessThanOrEqual(0.35);
  });

  it("subscribe/unsubscribe", () => {
    const values: number[] = [];
    const unsub = engine.subscribe((state) => {
      values.push(state.attention);
    });

    engine.pushUpdate({ attention: 1.0 });
    engine.start();
    // Advance enough ticks to sustain hysteresis
    vi.advanceTimersByTime(600);
    vi.advanceTimersByTime(600);

    expect(values.length).toBeGreaterThan(0);

    const countBefore = values.length;
    unsub();
    vi.advanceTimersByTime(1000);
    // After unsubscribe, no more values should be pushed
    expect(values.length).toBe(countBefore);
  });

  it("serialize/deserialize roundtrip", () => {
    // Push some state and tick
    engine.pushUpdate({
      attention: 0.7,
      curiosity: 0.3,
      trust_mode: TrustMode.Full,
    });
    engine.start();
    // Advance enough to commit the state
    vi.advanceTimersByTime(600);
    vi.advanceTimersByTime(600);
    vi.advanceTimersByTime(600);

    const serialized = engine.serialize();
    expect(typeof serialized).toBe("string");

    const parsed = JSON.parse(serialized);
    expect(typeof parsed.attention).toBe("number");

    // Deserialize into a new engine
    const engine2 = new StateVectorEngine();
    engine2.deserialize(serialized);
    const state2 = engine2.getState();

    // Values should match (within clamping)
    expect(state2.trust_mode).toBe(TrustMode.Full);
    expect(state2.attention).toBeGreaterThanOrEqual(0);
    expect(state2.attention).toBeLessThanOrEqual(1);
  });

  it("deserialize clamps values", () => {
    const badData = JSON.stringify({
      attention: 5,
      processing: -3,
      confidence: 2,
      affect_valence: 10,
      affect_arousal: 10,
      social_distance: -5,
      curiosity: 100,
      trust_mode: TrustMode.Guarded,
      battery_mode: BatteryMode.Normal,
    });

    engine.deserialize(badData);
    const state = engine.getState();
    expect(state.attention).toBe(1);
    expect(state.processing).toBe(0);
    expect(state.confidence).toBe(1);
    expect(state.affect_valence).toBe(1);
    expect(state.affect_arousal).toBe(0.35);
    expect(state.social_distance).toBe(0);
    expect(state.curiosity).toBe(1);
  });
});
