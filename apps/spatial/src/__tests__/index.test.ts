import { describe, it, expect } from "vitest";
import { computeWorldPosition, WebXRAdapter } from "../index";
import type { SpatialAnchor, BodyRelativePosition } from "../index";
import { CANONICAL_SPEC } from "@motebit/render-engine";

// ---------------------------------------------------------------------------
// Helper: create a default body anchor at a known position
// ---------------------------------------------------------------------------

function makeAnchor(position: [number, number, number]): SpatialAnchor {
  return {
    anchor_id: "test-anchor",
    type: "body_relative",
    position,
    orientation: [0, 0, 0, 1], // identity quaternion
    confidence: 1.0,
  };
}

function makeRelative(
  overrides: Partial<BodyRelativePosition> = {},
): BodyRelativePosition {
  return {
    offset: [0, 0, 0],
    reference: "head",
    orbit_radius: 0,
    orbit_angle: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeWorldPosition()
// ---------------------------------------------------------------------------

describe("computeWorldPosition", () => {
  it("returns the body anchor position when offset and orbit are zero", () => {
    const anchor = makeAnchor([1, 2, 3]);
    const relative = makeRelative({
      reference: "head",
      offset: [0, 0, 0],
      orbit_radius: 0,
      orbit_angle: 0,
    });

    const [x, y, z] = computeWorldPosition(anchor, relative);
    expect(x).toBeCloseTo(1, 10);
    expect(y).toBeCloseTo(2, 10);
    expect(z).toBeCloseTo(3, 10);
  });

  it("applies offset correctly", () => {
    const anchor = makeAnchor([0, 0, 0]);
    const relative = makeRelative({
      offset: [0.5, 1.0, -0.5],
      orbit_radius: 0,
      orbit_angle: 0,
    });

    const [x, y, z] = computeWorldPosition(anchor, relative);
    expect(x).toBeCloseTo(0.5, 10);
    expect(y).toBeCloseTo(1.0, 10);
    expect(z).toBeCloseTo(-0.5, 10);
  });

  it("computes orbit at angle 0 (orbit along x-axis)", () => {
    const anchor = makeAnchor([0, 0, 0]);
    const relative = makeRelative({
      offset: [0, 0, 0],
      orbit_radius: 1.0,
      orbit_angle: 0,
    });

    const [x, y, z] = computeWorldPosition(anchor, relative);
    // cos(0) * 1 = 1, sin(0) * 1 = 0
    expect(x).toBeCloseTo(1.0, 10);
    expect(y).toBeCloseTo(0, 10);
    expect(z).toBeCloseTo(0, 10);
  });

  it("computes orbit at angle PI/2 (orbit along z-axis)", () => {
    const anchor = makeAnchor([0, 0, 0]);
    const relative = makeRelative({
      offset: [0, 0, 0],
      orbit_radius: 1.0,
      orbit_angle: Math.PI / 2,
    });

    const [x, y, z] = computeWorldPosition(anchor, relative);
    // cos(PI/2) * 1 ≈ 0, sin(PI/2) * 1 = 1
    expect(x).toBeCloseTo(0, 5);
    expect(y).toBeCloseTo(0, 10);
    expect(z).toBeCloseTo(1.0, 5);
  });

  it("computes orbit at angle PI (orbit along negative x-axis)", () => {
    const anchor = makeAnchor([0, 0, 0]);
    const relative = makeRelative({
      orbit_radius: 2.0,
      orbit_angle: Math.PI,
    });

    const [x, y, z] = computeWorldPosition(anchor, relative);
    // cos(PI) * 2 = -2, sin(PI) * 2 ≈ 0
    expect(x).toBeCloseTo(-2.0, 5);
    expect(y).toBeCloseTo(0, 10);
    expect(z).toBeCloseTo(0, 5);
  });

  it("combines body position, offset, and orbit", () => {
    const anchor = makeAnchor([10, 20, 30]);
    const relative = makeRelative({
      reference: "shoulder_right",
      offset: [1, 2, 3],
      orbit_radius: 0.5,
      orbit_angle: 0, // cos(0)*0.5 = 0.5, sin(0)*0.5 = 0
    });

    const [x, y, z] = computeWorldPosition(anchor, relative);
    expect(x).toBeCloseTo(10 + 1 + 0.5, 10); // body.x + offset.x + orbitX
    expect(y).toBeCloseTo(20 + 2, 10);        // body.y + offset.y (no orbit Y)
    expect(z).toBeCloseTo(30 + 3 + 0, 10);    // body.z + offset.z + orbitZ
  });

  it("handles different orbit radii", () => {
    const anchor = makeAnchor([0, 0, 0]);
    const angle = Math.PI / 4; // 45 degrees

    const small = computeWorldPosition(anchor, makeRelative({ orbit_radius: 0.1, orbit_angle: angle }));
    const large = computeWorldPosition(anchor, makeRelative({ orbit_radius: 10.0, orbit_angle: angle }));

    // X component: cos(PI/4) * radius
    expect(small[0]).toBeCloseTo(Math.cos(angle) * 0.1, 10);
    expect(large[0]).toBeCloseTo(Math.cos(angle) * 10.0, 10);

    // Large radius should produce larger displacement
    expect(Math.abs(large[0])).toBeGreaterThan(Math.abs(small[0]));
    expect(Math.abs(large[2])).toBeGreaterThan(Math.abs(small[2]));
  });

  it("zero orbit radius produces no orbit displacement", () => {
    const anchor = makeAnchor([5, 5, 5]);
    const relative = makeRelative({
      offset: [0, 0, 0],
      orbit_radius: 0,
      orbit_angle: 1.234, // arbitrary angle, should not matter
    });

    const [x, y, z] = computeWorldPosition(anchor, relative);
    expect(x).toBeCloseTo(5, 10);
    expect(y).toBeCloseTo(5, 10);
    expect(z).toBeCloseTo(5, 10);
  });

  it("orbit does not affect Y coordinate", () => {
    const anchor = makeAnchor([0, 0, 0]);
    const angles = [0, Math.PI / 4, Math.PI / 2, Math.PI, 2 * Math.PI];

    for (const angle of angles) {
      const [, y] = computeWorldPosition(
        anchor,
        makeRelative({ orbit_radius: 5.0, orbit_angle: angle }),
      );
      expect(y).toBeCloseTo(0, 10);
    }
  });

  it("negative offset values work correctly", () => {
    const anchor = makeAnchor([0, 0, 0]);
    const relative = makeRelative({
      offset: [-1, -2, -3],
      orbit_radius: 0,
    });

    const [x, y, z] = computeWorldPosition(anchor, relative);
    expect(x).toBeCloseTo(-1, 10);
    expect(y).toBeCloseTo(-2, 10);
    expect(z).toBeCloseTo(-3, 10);
  });
});

// ---------------------------------------------------------------------------
// WebXRAdapter
// ---------------------------------------------------------------------------

describe("WebXRAdapter", () => {
  it("starts inactive", () => {
    const adapter = new WebXRAdapter();
    expect(adapter.isActive()).toBe(false);
  });

  it("becomes active after init", async () => {
    const adapter = new WebXRAdapter();
    await adapter.init({});
    expect(adapter.isActive()).toBe(true);
  });

  it("becomes inactive after dispose", async () => {
    const adapter = new WebXRAdapter();
    await adapter.init({});
    adapter.dispose();
    expect(adapter.isActive()).toBe(false);
  });

  it("returns the canonical spec", () => {
    const adapter = new WebXRAdapter();
    const spec = adapter.getSpec();
    expect(spec).toBe(CANONICAL_SPEC);
    expect(spec.geometry.form).toBe("droplet");
  });

  it("render and resize do not throw", async () => {
    const adapter = new WebXRAdapter();
    await adapter.init({});
    expect(() =>
      adapter.render({
        cues: {
          hover_distance: 0.4,
          drift_amplitude: 0.02,
          glow_intensity: 0.3,
          eye_dilation: 0.3,
          smile_curvature: 0,
          speaking_activity: 0,
        },
        delta_time: 0.016,
        time: 1.0,
      }),
    ).not.toThrow();
    expect(() => adapter.resize(1920, 1080)).not.toThrow();
  });
});
