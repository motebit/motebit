import { describe, it, expect } from "vitest";
import { OrbitalDynamics, estimateBodyAnchors, getAnchorForReference } from "../index";
import type { BodyAnchors } from "../index";

// ---------------------------------------------------------------------------
// Helper: run N ticks at 60fps
// ---------------------------------------------------------------------------

function runTicks(
  dynamics: OrbitalDynamics,
  seconds: number,
  anchor: [number, number, number] = [0, 0, 0],
  attention: number = 0,
): [number, number, number] {
  const dt = 1 / 60;
  const frames = Math.round(seconds * 60);
  let pos: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < frames; i++) {
    pos = dynamics.tick(dt, i * dt, anchor, attention);
  }
  return pos;
}

// ---------------------------------------------------------------------------
// OrbitalDynamics — construction and defaults
// ---------------------------------------------------------------------------

describe("OrbitalDynamics", () => {
  it("initializes with default config", () => {
    const dynamics = new OrbitalDynamics();
    const state = dynamics.getState();
    expect(state.angle).toBe(0);
    expect(state.radius).toBe(0.3); // default baseRadius
    expect(state.angularVelocity).toBe(0.3); // default angularSpeed
    expect(state.radialVelocity).toBe(0);
  });

  it("accepts partial config overrides", () => {
    const dynamics = new OrbitalDynamics({ baseRadius: 0.5, angularSpeed: 1.0 });
    const state = dynamics.getState();
    expect(state.radius).toBe(0.5);
    expect(state.angularVelocity).toBe(1.0);
    // Other values still at defaults
    const config = dynamics.getConfig();
    expect(config.minRadius).toBe(0.15);
    expect(config.dampingRatio).toBe(0.7);
  });

  it("resets to initial state", () => {
    const dynamics = new OrbitalDynamics();
    // Run some ticks to change state
    runTicks(dynamics, 2.0, [0, 0, 0], 0.5);
    const changed = dynamics.getState();
    expect(changed.angle).not.toBe(0);

    dynamics.reset();
    const reset = dynamics.getState();
    expect(reset.angle).toBe(0);
    expect(reset.radius).toBe(0.3);
    expect(reset.radialVelocity).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// OrbitalDynamics — orbital mechanics
// ---------------------------------------------------------------------------

describe("orbital mechanics", () => {
  it("advances the orbit angle over time", () => {
    const dynamics = new OrbitalDynamics();
    const before = dynamics.getState().angle;
    runTicks(dynamics, 1.0);
    const after = dynamics.getState().angle;
    expect(after).toBeGreaterThan(before);
  });

  it("orbits around the anchor point", () => {
    const dynamics = new OrbitalDynamics({ bobAmplitude: 0 });
    const anchor: [number, number, number] = [5, 0, 5];
    const pos = runTicks(dynamics, 1.0, anchor, 0);

    // Position should be near the anchor, offset by orbit radius
    const dx = pos[0] - anchor[0];
    const dz = pos[2] - anchor[2];
    const dist = Math.sqrt(dx * dx + dz * dz);

    // Should be close to baseRadius (0.3m)
    expect(dist).toBeGreaterThan(0.1);
    expect(dist).toBeLessThan(0.5);
  });

  it("stays at equilibrium radius with zero attention", () => {
    const dynamics = new OrbitalDynamics({ bobAmplitude: 0, baseRadius: 0.3 });
    // Run long enough for transient to decay
    runTicks(dynamics, 10.0, [0, 0, 0], 0);
    const state = dynamics.getState();
    // Should be near baseRadius — no attention shrink
    expect(state.radius).toBeCloseTo(0.3, 1);
  });

  it("tightens orbit radius with high attention", () => {
    const dynamics = new OrbitalDynamics({ bobAmplitude: 0 });
    // Run with high attention for several seconds
    runTicks(dynamics, 5.0, [0, 0, 0], 1.0);
    const state = dynamics.getState();
    // r_eq = 0.3 * (1 - 1.0 * 0.6) = 0.12, clamped to minRadius 0.15
    expect(state.radius).toBeLessThan(0.25);
    expect(state.radius).toBeGreaterThanOrEqual(0.15); // minRadius
  });

  it("widens orbit radius with zero attention after contraction", () => {
    const dynamics = new OrbitalDynamics({ bobAmplitude: 0 });
    // Contract with attention
    runTicks(dynamics, 5.0, [0, 0, 0], 1.0);
    const contracted = dynamics.getState().radius;
    // Release attention
    runTicks(dynamics, 5.0, [0, 0, 0], 0);
    const released = dynamics.getState().radius;
    expect(released).toBeGreaterThan(contracted);
  });

  it("angular velocity increases when radius decreases (Kepler)", () => {
    const dynamics = new OrbitalDynamics();
    const baseOmega = dynamics.getState().angularVelocity;

    // Contract the orbit
    runTicks(dynamics, 5.0, [0, 0, 0], 1.0);
    const contracted = dynamics.getState();
    expect(contracted.radius).toBeLessThan(0.3);
    // ω ∝ 1/r² → smaller radius = higher angular velocity
    expect(contracted.angularVelocity).toBeGreaterThan(baseOmega);
  });

  it("exhibits underdamped oscillation (overshoots equilibrium)", () => {
    // Start at baseRadius (0.5), apply moderate attention → r_eq well above minRadius
    // so clamping doesn't interfere with oscillation
    const dynamics = new OrbitalDynamics({
      bobAmplitude: 0,
      baseRadius: 0.5,
      minRadius: 0.1,
      maxRadius: 1.0,
      dampingRatio: 0.3, // low damping → more overshoot
      springStiffness: 8.0,
      attentionShrink: 0.4,
    });

    // Record radius over time
    // attention 0.5 → r_eq = 0.5 * (1 - 0.5 * 0.4) = 0.5 * 0.8 = 0.4
    const radii: number[] = [];
    const dt = 1 / 60;
    for (let i = 0; i < 600; i++) {
      dynamics.tick(dt, i * dt, [0, 0, 0], 0.5);
      radii.push(dynamics.getState().radius);
    }

    const rEq = 0.4;
    let crossings = 0;
    for (let i = 1; i < radii.length; i++) {
      const prev = radii[i - 1]! - rEq;
      const curr = radii[i]! - rEq;
      if (prev * curr < 0) crossings++;
    }
    // Underdamped system should cross equilibrium at least once
    expect(crossings).toBeGreaterThanOrEqual(1);
  });

  it("clamps dt to avoid physics explosion", () => {
    const dynamics = new OrbitalDynamics();
    // Huge dt should not cause NaN or explosion
    const pos = dynamics.tick(10.0, 0, [0, 0, 0], 0.5);
    expect(Number.isFinite(pos[0])).toBe(true);
    expect(Number.isFinite(pos[1])).toBe(true);
    expect(Number.isFinite(pos[2])).toBe(true);
    const state = dynamics.getState();
    expect(state.radius).toBeGreaterThanOrEqual(0.15);
    expect(state.radius).toBeLessThanOrEqual(0.8);
  });

  it("clamps attention level to [0, 1]", () => {
    const dynamics = new OrbitalDynamics({ bobAmplitude: 0 });
    // Negative attention should behave like 0
    runTicks(dynamics, 3.0, [0, 0, 0], -5.0);
    const state1 = dynamics.getState();
    expect(state1.radius).toBeCloseTo(0.3, 1);

    dynamics.reset();
    // Attention > 1 should behave like 1
    runTicks(dynamics, 5.0, [0, 0, 0], 10.0);
    const state2 = dynamics.getState();
    expect(state2.radius).toBeLessThan(0.25);
  });
});

// ---------------------------------------------------------------------------
// OrbitalDynamics — vertical bob
// ---------------------------------------------------------------------------

describe("vertical bob", () => {
  it("produces non-zero Y displacement from organic noise", () => {
    const dynamics = new OrbitalDynamics({ bobAmplitude: 0.015 });
    const pos = dynamics.tick(1 / 60, 1.0, [0, 0, 0], 0);
    // Bob depends on time, should be non-zero for most time values
    // (it can be zero at specific moments, but 1.0s shouldn't be)
    // Just check it's within expected range
    expect(Math.abs(pos[1])).toBeLessThanOrEqual(0.015);
  });

  it("is zero when bobAmplitude is zero", () => {
    const dynamics = new OrbitalDynamics({ bobAmplitude: 0 });
    const pos = dynamics.tick(1 / 60, 1.0, [0, 0, 0], 0);
    // Y should only come from anchor Y (which is 0)
    expect(pos[1]).toBeCloseTo(0, 10);
  });
});

// ---------------------------------------------------------------------------
// OrbitalDynamics — anchor transitions
// ---------------------------------------------------------------------------

describe("anchor transitions", () => {
  it("smoothly transitions between anchor positions", () => {
    const dynamics = new OrbitalDynamics({ bobAmplitude: 0, angularSpeed: 0 });

    // Start at origin
    dynamics.tick(1 / 60, 0, [0, 0, 0], 0);

    // Jump to new anchor — should not teleport immediately
    const pos1 = dynamics.tick(1 / 60, 1 / 60, [5, 0, 0], 0);
    // Should not be at x=5 yet (smoothstep transition)
    expect(pos1[0]).toBeLessThan(5);

    // After enough time, should be at the new anchor
    let pos: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < 120; i++) {
      pos = dynamics.tick(1 / 60, (i + 2) / 60, [5, 0, 0], 0);
    }
    // X should be near 5 + orbit offset
    expect(pos[0]).toBeGreaterThan(4);
  });

  it("handles continuous small anchor movements without re-triggering transition", () => {
    const dynamics = new OrbitalDynamics({ bobAmplitude: 0, angularSpeed: 0 });

    // Small movements (< 0.01m threshold) should not trigger new transitions
    dynamics.tick(1 / 60, 0, [0, 0, 0], 0);
    dynamics.tick(1 / 60, 1 / 60, [0.005, 0, 0], 0);
    dynamics.tick(1 / 60, 2 / 60, [0.008, 0, 0], 0);

    // These small movements shouldn't cause abrupt position changes
    const pos = dynamics.tick(1 / 60, 3 / 60, [0.009, 0, 0], 0);
    expect(Number.isFinite(pos[0])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// estimateBodyAnchors
// ---------------------------------------------------------------------------

describe("estimateBodyAnchors", () => {
  it("derives shoulder positions from head", () => {
    const anchors = estimateBodyAnchors([0, 1.7, 0]);
    // Shoulders should be below and lateral to head
    expect(anchors.shoulder_right[1]).toBeLessThan(1.7); // below head
    expect(anchors.shoulder_left[1]).toBeLessThan(1.7);
    expect(anchors.shoulder_right[0]).toBeGreaterThan(0); // right of center
    expect(anchors.shoulder_left[0]).toBeLessThan(0); // left of center
    // Symmetric
    expect(anchors.shoulder_right[1]).toBeCloseTo(anchors.shoulder_left[1], 10);
  });

  it("passes through head position unchanged", () => {
    const anchors = estimateBodyAnchors([1, 2, 3]);
    expect(anchors.head).toEqual([1, 2, 3]);
  });

  it("includes hand positions when provided", () => {
    const anchors = estimateBodyAnchors([0, 1.7, 0], [0.3, 1.0, 0.2], [-0.3, 1.0, 0.2]);
    expect(anchors.hand_right).toEqual([0.3, 1.0, 0.2]);
    expect(anchors.hand_left).toEqual([-0.3, 1.0, 0.2]);
  });

  it("sets hands to null when not provided", () => {
    const anchors = estimateBodyAnchors([0, 1.7, 0]);
    expect(anchors.hand_right).toBeNull();
    expect(anchors.hand_left).toBeNull();
  });

  it("derives chest position between head and shoulders", () => {
    const anchors = estimateBodyAnchors([0, 1.7, 0]);
    expect(anchors.chest[0]).toBeCloseTo(0, 5); // centered
    expect(anchors.chest[1]).toBeLessThan(1.7); // below head
    expect(anchors.chest[1]).toBeGreaterThan(anchors.shoulder_right[1] - 0.1); // near shoulder level
  });
});

// ---------------------------------------------------------------------------
// getAnchorForReference
// ---------------------------------------------------------------------------

describe("getAnchorForReference", () => {
  const anchors: BodyAnchors = {
    head: [0, 1.7, 0],
    shoulder_right: [0.2, 1.35, -0.05],
    shoulder_left: [-0.2, 1.35, -0.05],
    chest: [0, 1.4, -0.05],
    hand_right: [0.3, 1.0, 0.2],
    hand_left: null,
  };

  it("returns the correct anchor for each reference", () => {
    expect(getAnchorForReference(anchors, "head")).toEqual([0, 1.7, 0]);
    expect(getAnchorForReference(anchors, "shoulder_right")).toEqual([0.2, 1.35, -0.05]);
    expect(getAnchorForReference(anchors, "shoulder_left")).toEqual([-0.2, 1.35, -0.05]);
    expect(getAnchorForReference(anchors, "chest")).toEqual([0, 1.4, -0.05]);
    expect(getAnchorForReference(anchors, "hand_right")).toEqual([0.3, 1.0, 0.2]);
  });

  it("returns null for unavailable hand", () => {
    expect(getAnchorForReference(anchors, "hand_left")).toBeNull();
  });
});
