import { describe, it, expect, beforeEach } from "vitest";
import {
  CANONICAL_SPEC,
  CANONICAL_GEOMETRY,
  CANONICAL_MATERIAL,
  CANONICAL_LIGHTING,
  smoothDelta,
  ThreeJSAdapter,
  SpatialAdapter,
} from "../index";

// ---------------------------------------------------------------------------
// CANONICAL_SPEC values
// ---------------------------------------------------------------------------

describe("CANONICAL_SPEC", () => {
  it("has correct geometry values", () => {
    expect(CANONICAL_GEOMETRY.form).toBe("droplet");
    expect(CANONICAL_GEOMETRY.base_radius).toBe(0.14);
    expect(CANONICAL_GEOMETRY.height).toBe(0.12);
  });

  it("has correct material values (MOTEBIT.md §V)", () => {
    expect(CANONICAL_MATERIAL.ior).toBe(1.15);
    expect(CANONICAL_MATERIAL.subsurface).toBe(0.05);
    expect(CANONICAL_MATERIAL.roughness).toBe(0.0);
    expect(CANONICAL_MATERIAL.clearcoat).toBe(0.4);
    expect(CANONICAL_MATERIAL.surface_noise_amplitude).toBe(0.002);
    expect(CANONICAL_MATERIAL.base_color).toEqual([1.0, 1.0, 1.0]);
    expect(CANONICAL_MATERIAL.emissive_intensity).toBe(0.0);
    expect(CANONICAL_MATERIAL.tint).toEqual([0.9, 0.92, 1.0]);
  });

  it("has correct lighting values", () => {
    expect(CANONICAL_LIGHTING.environment).toBe("hdri");
    expect(CANONICAL_LIGHTING.exposure).toBe(1.2);
    expect(CANONICAL_LIGHTING.ambient_intensity).toBe(0.4);
  });

  it("composes geometry, material, and lighting", () => {
    expect(CANONICAL_SPEC.geometry).toBe(CANONICAL_GEOMETRY);
    expect(CANONICAL_SPEC.material).toBe(CANONICAL_MATERIAL);
    expect(CANONICAL_SPEC.lighting).toBe(CANONICAL_LIGHTING);
  });
});

// ---------------------------------------------------------------------------
// smoothDelta()
// ---------------------------------------------------------------------------

describe("smoothDelta", () => {
  it("approaches target over time", () => {
    let current = 0;
    const target = 1.0;

    current = smoothDelta(current, target, 0.016); // ~1 frame at 60fps
    expect(current).toBeGreaterThan(0);
    expect(current).toBeLessThan(target);

    // After many steps, should be close to target
    for (let i = 0; i < 300; i++) {
      current = smoothDelta(current, target, 0.016);
    }
    expect(current).toBeCloseTo(target, 2);
  });

  it("returns current when deltaTime is 0", () => {
    const result = smoothDelta(0.5, 1.0, 0);
    expect(result).toBeCloseTo(0.5, 10);
  });

  it("moves toward target in both directions", () => {
    const increasing = smoothDelta(0, 1, 0.1);
    expect(increasing).toBeGreaterThan(0);

    const decreasing = smoothDelta(1, 0, 0.1);
    expect(decreasing).toBeLessThan(1);
  });

  it("higher smoothing factor converges faster", () => {
    const slow = smoothDelta(0, 1, 0.1, 1.0);
    const fast = smoothDelta(0, 1, 0.1, 10.0);
    expect(fast).toBeGreaterThan(slow);
  });
});

// ---------------------------------------------------------------------------
// ThreeJSAdapter lifecycle
// ---------------------------------------------------------------------------

describe("ThreeJSAdapter", () => {
  let adapter: ThreeJSAdapter;

  beforeEach(() => {
    adapter = new ThreeJSAdapter();
  });

  it("init sets initialized state", async () => {
    await adapter.init(null);
    // Should not throw on subsequent render
    adapter.render({
      cues: {
        hover_distance: 0.4,
        drift_amplitude: 0.02,
        glow_intensity: 0.3,
        eye_dilation: 0.3,
        smile_curvature: 0,

      },
      delta_time: 0.016,
      time: 1.0,
    });
  });

  it("render does nothing before init", () => {
    // Should not throw
    adapter.render({
      cues: {
        hover_distance: 0.4,
        drift_amplitude: 0.02,
        glow_intensity: 0.3,
        eye_dilation: 0.3,
        smile_curvature: 0,

      },
      delta_time: 0.016,
      time: 1.0,
    });
  });

  it("getSpec returns CANONICAL_SPEC", () => {
    const spec = adapter.getSpec();
    expect(spec).toBe(CANONICAL_SPEC);
    expect(spec.geometry.form).toBe("droplet");
    expect(spec.material.ior).toBe(1.15);
  });

  it("dispose cleans up", async () => {
    await adapter.init(null);
    adapter.dispose();
    // After dispose, render should effectively be a no-op
    adapter.render({
      cues: {
        hover_distance: 0.4,
        drift_amplitude: 0.02,
        glow_intensity: 0.3,
        eye_dilation: 0.3,
        smile_curvature: 0,

      },
      delta_time: 0.016,
      time: 1.0,
    });
  });

  it("resize does not throw", () => {
    expect(() => adapter.resize(800, 600)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// SpatialAdapter
// ---------------------------------------------------------------------------

describe("SpatialAdapter", () => {
  it("conforms to the canonical spec", () => {
    const adapter = new SpatialAdapter();
    const spec = adapter.getSpec();
    expect(spec.geometry.form).toBe("droplet");
    expect(spec.geometry.base_radius).toBe(0.14);
    expect(spec.material.ior).toBe(1.15);
    expect(spec.lighting.environment).toBe("hdri");
  });

  it("init, render, dispose lifecycle works", async () => {
    const adapter = new SpatialAdapter();
    await adapter.init(null);
    adapter.render({
      cues: {
        hover_distance: 0.4,
        drift_amplitude: 0.02,
        glow_intensity: 0.3,
        eye_dilation: 0.3,
        smile_curvature: 0,

      },
      delta_time: 0.016,
      time: 1.0,
    });
    adapter.resize(1920, 1080);
    adapter.dispose();
  });
});
