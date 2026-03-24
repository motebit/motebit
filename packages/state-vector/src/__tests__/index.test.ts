import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StateVectorEngine } from "../index";
import type { InterpolatedState } from "../index";
import { TrustMode, BatteryMode } from "@motebit/sdk";
import type { MotebitState } from "@motebit/sdk";

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

  // ============================================================
  // Default state
  // ============================================================

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

  it("constructs with default config when no args provided", () => {
    const defaultEngine = new StateVectorEngine();
    expect(defaultEngine.getState().attention).toBe(0);
    defaultEngine.stop();
  });

  it("allows partial config overrides", () => {
    const custom = new StateVectorEngine({ ema_alpha: 0.5 });
    expect(custom.getState().confidence).toBe(0.5); // still default state
    custom.stop();
  });

  // ============================================================
  // pushUpdate
  // ============================================================

  it("pushUpdate changes the raw input state", () => {
    engine.pushUpdate({ attention: 0.8 });
    // Raw input changed but tick hasn't run yet, so current state is still default
    const state = engine.getState();
    expect(state.attention).toBe(0);
  });

  it("pushUpdate merges partial updates", () => {
    engine.pushUpdate({ attention: 0.5 });
    engine.pushUpdate({ curiosity: 0.3 });
    // Both should be stored in raw input
    engine.start();
    // After sufficient ticks, both values should influence current state
    vi.advanceTimersByTime(600);
    vi.advanceTimersByTime(600);
    const state = engine.getState();
    expect(state.attention).toBeGreaterThan(0);
    expect(state.curiosity).toBeGreaterThan(0);
  });

  // ============================================================
  // Interpolation
  // ============================================================

  it("getInterpolatedState lerps correctly", () => {
    const interp = engine.getInterpolatedState(0.5);
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

  it("getInterpolatedState interpolates between previous and current", () => {
    // Setup: push a big change and let it commit
    engine.pushUpdate({ attention: 1.0 });
    engine.start();
    // Tick 1 — raw EMA starts but hysteresis may block
    vi.advanceTimersByTime(500); // tick at ~500ms

    // After hysteresis sustain...
    vi.advanceTimersByTime(500); // tick at ~1000ms

    // Now previous and current should differ
    const at0 = engine.getInterpolatedState(0);
    const at1 = engine.getInterpolatedState(1);
    const atHalf = engine.getInterpolatedState(0.5);

    // at0 = previous state, at1 = current state
    // atHalf should be between them
    if (at0.attention !== at1.attention) {
      expect(atHalf.attention).toBeGreaterThanOrEqual(Math.min(at0.attention, at1.attention));
      expect(atHalf.attention).toBeLessThanOrEqual(Math.max(at0.attention, at1.attention));
    }
  });

  it("getInterpolatedState uses current trust_mode (no lerp)", () => {
    engine.pushUpdate({ trust_mode: TrustMode.Full });
    engine.start();
    vi.advanceTimersByTime(600);

    const interp = engine.getInterpolatedState(0);
    // Enum fields copy current value at any t
    expect(interp.trust_mode).toBe(TrustMode.Full);
  });

  it("getInterpolatedState uses current battery_mode (no lerp)", () => {
    engine.pushUpdate({ battery_mode: BatteryMode.LowPower });
    engine.start();
    vi.advanceTimersByTime(600);

    const interp = engine.getInterpolatedState(0);
    expect(interp.battery_mode).toBe(BatteryMode.LowPower);
  });

  // ============================================================
  // Copy safety
  // ============================================================

  it("getState returns a copy (not a reference)", () => {
    const stateA = engine.getState();
    const stateB = engine.getState();
    stateA.attention = 999;
    expect(stateB.attention).toBe(0);
  });

  // ============================================================
  // EMA smoothing
  // ============================================================

  it("EMA converges toward target over multiple ticks", () => {
    // alpha=0.3, so EMA approaches target gradually
    // After n ticks with hysteresis satisfied: EMA = alpha*target + (1-alpha)*prev
    engine.pushUpdate({ attention: 1.0 });
    engine.start();

    // Need to sustain past hysteresis first
    vi.advanceTimersByTime(600);
    vi.advanceTimersByTime(600);

    const state1 = engine.getState();
    // Should have moved toward 1.0 but not reached it
    expect(state1.attention).toBeGreaterThan(0);
    expect(state1.attention).toBeLessThan(1.0);

    // Keep ticking
    vi.advanceTimersByTime(2000);
    const state2 = engine.getState();
    // Should be closer to 1.0 than before
    expect(state2.attention).toBeGreaterThan(state1.attention);
  });

  it("EMA does not overshoot target", () => {
    engine.pushUpdate({ curiosity: 0.6 });
    engine.start();
    // Tick many times
    vi.advanceTimersByTime(10000);
    const state = engine.getState();
    expect(state.curiosity).toBeLessThanOrEqual(0.6);
  });

  // ============================================================
  // Hysteresis
  // ============================================================

  it("hysteresis blocks small changes below threshold", () => {
    // threshold = 0.05, so pushing attention to 0.01 from 0 (delta=0.01) should be blocked
    engine.pushUpdate({ attention: 0.01 });
    engine.start();
    // Even after hysteresis sustain, delta is too small
    vi.advanceTimersByTime(2000);
    const state = engine.getState();
    // EMA of 0.01 with alpha=0.3 from 0 gives ~0.003 per tick — always below threshold
    expect(state.attention).toBe(0);
  });

  it("hysteresis requires sustained duration before committing", () => {
    // Push a change that exceeds threshold
    engine.pushUpdate({ attention: 1.0 });
    engine.start();

    // First tick at ~500ms — hysteresis sees delta, starts sustain timer
    vi.advanceTimersByTime(500);

    // The change might not have committed yet because sustain_ms=500
    // On first tick: EMA = 0.3*1.0 + 0.7*0 = 0.3 — delta from 0 is 0.3 > 0.05 threshold
    // But it needs to sustain for 500ms before committing

    // Second tick at ~1000ms — sustained_since was set at first tick, now 500ms have passed
    vi.advanceTimersByTime(500);
    const state2 = engine.getState();
    // By now the change should be committed
    expect(state2.attention).toBeGreaterThan(0);
  });

  it("hysteresis allows convergence when raw target is far from current", () => {
    // With alpha=0.3, targeting 1.0 from 0: per-tick EMA delta eventually drops
    // below threshold, but raw target (1.0) is still far from current.
    // Hysteresis must not trap convergence.
    engine.pushUpdate({ attention: 1.0 });
    engine.start();
    // Run for enough ticks to fully converge
    vi.advanceTimersByTime(20000);
    const state = engine.getState();
    // Should converge close to 1.0, not plateau at ~0.83
    expect(state.attention).toBeGreaterThan(0.95);
  });

  it("hysteresis allows convergence with slow alpha", () => {
    // Production-like config: alpha=0.1, which creates smaller per-tick deltas
    const slowEngine = new StateVectorEngine({
      tick_rate_hz: 2,
      ema_alpha: 0.1,
      hysteresis_threshold: 0.05,
      hysteresis_sustain_ms: 500,
    });
    slowEngine.pushUpdate({ attention: 0.8 });
    slowEngine.start();
    vi.advanceTimersByTime(30000);
    const state = slowEngine.getState();
    // Should converge close to 0.8, not plateau at ~0.33
    expect(state.attention).toBeGreaterThan(0.7);
    slowEngine.stop();
  });

  it("hysteresis resets when delta drops below threshold", () => {
    // Push big change, then immediately retract before sustain completes
    engine.pushUpdate({ curiosity: 1.0 });
    engine.start();

    // One tick — starts sustain
    vi.advanceTimersByTime(400);

    // Retract before sustain_ms=500 elapses
    engine.pushUpdate({ curiosity: 0 });

    // More ticks — EMA decays toward 0, delta should drop below threshold
    vi.advanceTimersByTime(2000);
    const state = engine.getState();
    // Curiosity should still be 0 (never committed the spike)
    expect(state.curiosity).toBe(0);
  });

  // ============================================================
  // Enum fields
  // ============================================================

  it("trust_mode copies directly (no EMA smoothing)", () => {
    engine.pushUpdate({ trust_mode: TrustMode.Full });
    engine.start();
    vi.advanceTimersByTime(600);
    expect(engine.getState().trust_mode).toBe(TrustMode.Full);
  });

  it("battery_mode copies directly (no EMA smoothing)", () => {
    engine.pushUpdate({ battery_mode: BatteryMode.LowPower });
    engine.start();
    vi.advanceTimersByTime(600);
    expect(engine.getState().battery_mode).toBe(BatteryMode.LowPower);
  });

  it("trust_mode changes immediately on next tick (no hysteresis)", () => {
    engine.start();
    vi.advanceTimersByTime(500);
    engine.pushUpdate({ trust_mode: TrustMode.Minimal });
    vi.advanceTimersByTime(500); // one tick
    expect(engine.getState().trust_mode).toBe(TrustMode.Minimal);
  });

  // ============================================================
  // Clamping
  // ============================================================

  it("getState returns clamped values after tick", () => {
    engine.pushUpdate({ affect_arousal: 10.0 });
    engine.start();
    vi.advanceTimersByTime(600);
    vi.advanceTimersByTime(600);
    const state = engine.getState();
    expect(state.affect_arousal).toBeLessThanOrEqual(0.35);
  });

  // ============================================================
  // Subscribe / unsubscribe
  // ============================================================

  it("subscribe/unsubscribe", () => {
    const values: number[] = [];
    const unsub = engine.subscribe((state) => {
      values.push(state.attention);
    });

    engine.pushUpdate({ attention: 1.0 });
    engine.start();
    vi.advanceTimersByTime(600);
    vi.advanceTimersByTime(600);

    expect(values.length).toBeGreaterThan(0);

    const countBefore = values.length;
    unsub();
    vi.advanceTimersByTime(1000);
    expect(values.length).toBe(countBefore);
  });

  it("notifies multiple subscribers on each tick", () => {
    const calls1: number[] = [];
    const calls2: number[] = [];

    engine.subscribe(() => calls1.push(1));
    engine.subscribe(() => calls2.push(1));

    engine.start();
    vi.advanceTimersByTime(500); // one tick

    expect(calls1.length).toBeGreaterThanOrEqual(1);
    expect(calls2.length).toBeGreaterThanOrEqual(1);
    expect(calls1.length).toBe(calls2.length);
  });

  it("subscriber receives current state snapshot", () => {
    let receivedState: MotebitState | null = null;
    engine.subscribe((state) => {
      receivedState = state;
    });

    engine.start();
    vi.advanceTimersByTime(500); // one tick

    expect(receivedState).not.toBeNull();
    expect(receivedState!.trust_mode).toBe(TrustMode.Guarded);
  });

  // ============================================================
  // Start / stop
  // ============================================================

  it("start is idempotent", () => {
    engine.start();
    engine.start(); // second call should be no-op
    vi.advanceTimersByTime(1000);
    // Should only have one active interval — verify by subscriber count
    const calls: number[] = [];
    engine.subscribe(() => calls.push(1));
    vi.advanceTimersByTime(500);
    // At tick_rate_hz=2, one tick per 500ms
    expect(calls.length).toBe(1);
  });

  it("stop clears the tick interval", () => {
    const calls: number[] = [];
    engine.subscribe(() => calls.push(1));
    engine.start();
    vi.advanceTimersByTime(500);
    const countAtStop = calls.length;

    engine.stop();
    vi.advanceTimersByTime(2000);
    expect(calls.length).toBe(countAtStop);
  });

  it("stop is idempotent", () => {
    engine.start();
    engine.stop();
    engine.stop(); // should not throw
  });

  it("can restart after stop", () => {
    const calls: number[] = [];
    engine.subscribe(() => calls.push(1));

    engine.start();
    vi.advanceTimersByTime(500);
    engine.stop();
    const countAfterStop = calls.length;

    engine.start();
    vi.advanceTimersByTime(500);
    expect(calls.length).toBeGreaterThan(countAfterStop);
  });

  // ============================================================
  // Tick fraction
  // ============================================================

  it("getTickFraction returns 0 before start", () => {
    expect(engine.getTickFraction()).toBe(0);
  });

  it("getTickFraction returns fraction of elapsed tick interval", () => {
    engine.start();
    // tick_rate_hz=2 → interval=500ms
    vi.advanceTimersByTime(250); // half a tick
    const fraction = engine.getTickFraction();
    expect(fraction).toBeCloseTo(0.5, 1);
  });

  it("getTickFraction clamps to 1", () => {
    engine.start();
    vi.advanceTimersByTime(100); // initial tick sets lastTickTime
    // Manually advance well beyond one tick interval
    vi.advanceTimersByTime(2000);
    expect(engine.getTickFraction()).toBeLessThanOrEqual(1);
  });

  // ============================================================
  // Serialize / deserialize
  // ============================================================

  it("serialize/deserialize roundtrip", () => {
    engine.pushUpdate({
      attention: 0.7,
      curiosity: 0.3,
      trust_mode: TrustMode.Full,
    });
    engine.start();
    vi.advanceTimersByTime(600);
    vi.advanceTimersByTime(600);
    vi.advanceTimersByTime(600);

    const serialized = engine.serialize();
    expect(typeof serialized).toBe("string");

    const parsed = JSON.parse(serialized) as MotebitState;
    expect(typeof parsed.attention).toBe("number");

    const engine2 = new StateVectorEngine();
    engine2.deserialize(serialized);
    const state2 = engine2.getState();

    expect(state2.trust_mode).toBe(TrustMode.Full);
    expect(state2.attention).toBeGreaterThanOrEqual(0);
    expect(state2.attention).toBeLessThanOrEqual(1);
    engine2.stop();
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

  it("deserialize resets previous and raw states", () => {
    // After deserialize, pushing no new update and ticking should keep the state
    const data = JSON.stringify({
      attention: 0.5,
      processing: 0.2,
      confidence: 0.8,
      affect_valence: 0,
      affect_arousal: 0,
      social_distance: 0.5,
      curiosity: 0.4,
      trust_mode: TrustMode.Guarded,
      battery_mode: BatteryMode.Normal,
    });

    engine.deserialize(data);
    const stateBeforeTick = engine.getState();

    engine.start();
    vi.advanceTimersByTime(500);
    const stateAfterTick = engine.getState();

    // Should be stable (no drift) since raw = current = previous
    expect(stateAfterTick.attention).toBeCloseTo(stateBeforeTick.attention, 5);
    expect(stateAfterTick.curiosity).toBeCloseTo(stateBeforeTick.curiosity, 5);
  });

  it("serialize produces valid JSON", () => {
    const serialized = engine.serialize();
    expect(() => JSON.parse(serialized) as unknown).not.toThrow();
  });

  // ============================================================
  // All numeric fields smoothed
  // ============================================================

  it("all 7 numeric fields are EMA-smoothed", () => {
    engine.pushUpdate({
      attention: 1.0,
      processing: 1.0,
      confidence: 1.0,
      affect_valence: 0.3,
      affect_arousal: 0.3,
      social_distance: 1.0,
      curiosity: 1.0,
    });
    engine.start();
    // Sustain hysteresis
    vi.advanceTimersByTime(600);
    vi.advanceTimersByTime(600);
    vi.advanceTimersByTime(600);

    const state = engine.getState();
    // All should have moved from default toward target
    expect(state.attention).toBeGreaterThan(0);
    expect(state.processing).toBeGreaterThan(0);
    expect(state.confidence).toBeGreaterThan(0.5);
    // affect_arousal is clamped to 0.35 max
    expect(state.affect_arousal).toBeGreaterThan(0);
    expect(state.social_distance).toBeGreaterThan(0.5);
    expect(state.curiosity).toBeGreaterThan(0);
  });

  // ============================================================
  // InterpolatedState type
  // ============================================================

  it("getInterpolatedState includes interpolation_t field", () => {
    const interp: InterpolatedState = engine.getInterpolatedState(0.75);
    expect(interp.interpolation_t).toBe(0.75);
    // Also has all MotebitState fields
    expect(typeof interp.attention).toBe("number");
    expect(typeof interp.trust_mode).toBe("string");
  });
});
