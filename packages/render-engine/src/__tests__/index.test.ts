import { describe, it, expect, beforeEach } from "vitest";
import {
  CANONICAL_SPEC,
  CANONICAL_GEOMETRY,
  CANONICAL_MATERIAL,
  CANONICAL_LIGHTING,
  EMBODIMENT_MODE_CONTRACTS,
  smoothDelta,
  ThreeJSAdapter,
  SpatialAdapter,
} from "../index";
import type { EmbodimentMode, SlabItemPhase } from "../index";

// ---------------------------------------------------------------------------
// CANONICAL_SPEC values
// ---------------------------------------------------------------------------

describe("CANONICAL_SPEC", () => {
  it("has correct geometry values", () => {
    expect(CANONICAL_GEOMETRY.form).toBe("droplet");
    expect(CANONICAL_GEOMETRY.base_radius).toBe(0.14);
    expect(CANONICAL_GEOMETRY.height).toBe(0.12);
  });

  it("has correct material values (DROPLET.md)", () => {
    expect(CANONICAL_MATERIAL.ior).toBe(1.22);
    expect(CANONICAL_MATERIAL.subsurface).toBe(0.05);
    expect(CANONICAL_MATERIAL.roughness).toBe(0.0);
    expect(CANONICAL_MATERIAL.clearcoat).toBe(0.4);
    expect(CANONICAL_MATERIAL.surface_noise_amplitude).toBe(0.002);
    expect(CANONICAL_MATERIAL.base_color).toEqual([1.0, 1.0, 1.0]);
    expect(CANONICAL_MATERIAL.emissive_intensity).toBe(0.0);
    expect(CANONICAL_MATERIAL.tint).toEqual([0.95, 0.95, 1.0]);
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
        speaking_activity: 0,
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
        speaking_activity: 0,
      },
      delta_time: 0.016,
      time: 1.0,
    });
  });

  it("getSpec returns CANONICAL_SPEC", () => {
    const spec = adapter.getSpec();
    expect(spec).toBe(CANONICAL_SPEC);
    expect(spec.geometry.form).toBe("droplet");
    expect(spec.material.ior).toBe(1.22);
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
        speaking_activity: 0,
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
    expect(spec.material.ior).toBe(1.22);
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
        speaking_activity: 0,
      },
      delta_time: 0.016,
      time: 1.0,
    });
    adapter.resize(1920, 1080);
    adapter.dispose();
  });
});

// ---------------------------------------------------------------------------
// EMBODIMENT_MODE_CONTRACTS — six declarations per mode, compile-time enforced
// ---------------------------------------------------------------------------
//
// The `satisfies Record<EmbodimentMode, EmbodimentModeContract>` clause on
// `EMBODIMENT_MODE_CONTRACTS` enforces total coverage and field shape at
// compile time — these runtime tests are defensive backups + regression
// pins for the architecturally-distinctive declarations a future refactor
// might silently flatten. Doctrine: docs/doctrine/motebit-computer.md
// §"Mode contract — six declarations per mode."

describe("EMBODIMENT_MODE_CONTRACTS — total coverage + invariants", () => {
  const ALL_MODES: readonly EmbodimentMode[] = [
    "mind",
    "tool_result",
    "virtual_browser",
    "shared_gaze",
    "desktop_drive",
    "peer_viewport",
  ];

  it("declares a contract for every EmbodimentMode (no silent gaps)", () => {
    for (const mode of ALL_MODES) {
      const contract = EMBODIMENT_MODE_CONTRACTS[mode];
      expect(contract, `missing contract for mode "${mode}"`).toBeDefined();
      expect(contract.driver).toBeDefined();
      expect(contract.observer).toBeDefined();
      expect(contract.source).toBeDefined();
      expect(contract.consent).toBeDefined();
      expect(contract.sensitivity).toBeDefined();
      expect(contract.lifecycleDefaults.length).toBeGreaterThan(0);
    }
  });

  it("shared_gaze inverts the agency direction (user drives, motebit observes)", () => {
    // Doctrine: motebit-computer.md §"Mode contract." This is the
    // architecturally distinctive direction-flip — same source can be
    // virtual_browser (motebit drives) or shared_gaze (user drives).
    // A future contract refactor that flattens this loses the whole
    // reason shared_gaze deserves its own mode.
    const c = EMBODIMENT_MODE_CONTRACTS.shared_gaze;
    expect(c.driver).toBe("user");
    expect(c.observer).toBe("motebit");
    expect(c.consent).toBe("per-source");
  });

  it("peer_viewport is signed-delegation, not live consent", () => {
    // Doctrine: motebit-computer.md §"Failure modes specific to modes,"
    // peer_viewport-rendered-as-live-perception. peer_viewport and
    // shared_gaze share an agency direction (motebit watches) but are
    // epistemically opposite — peer_viewport's proof is the receipt
    // signature; shared_gaze's "proof" is just that the user pointed
    // motebit at a source. Conflating them loses the cryptographic
    // distinction across federation hops.
    const c = EMBODIMENT_MODE_CONTRACTS.peer_viewport;
    expect(c.driver).toBe("peer");
    expect(c.observer).toBe("motebit");
    expect(c.consent).toBe("signed-delegation");
    expect(c.source).toBe("peer-receipt");
  });

  it("desktop_drive admits all sensitivity tiers (classifier gates within, not at boundary)", () => {
    // motebit-computer.md says secret/financial typing fires
    // require_approval via classifyComputerAction. The mode itself
    // doesn't tier-bound; the per-action classifier does. A
    // tier-bounding refactor here would silently disable
    // desktop_drive for entire workflows where the user wants full
    // control.
    const c = EMBODIMENT_MODE_CONTRACTS.desktop_drive;
    expect(c.driver).toBe("motebit");
    expect(c.consent).toBe("per-action");
    expect(c.sensitivity).toBe("all-tiers");
  });

  it("mind is interior-only and always permitted", () => {
    // mind is the only mode with no external gate — the interior is
    // sovereign-tier by definition. A refactor that adds external
    // consent to mind breaks the separation between interior cohesion
    // and surface tension (DROPLET.md / LIQUESCENTIA.md derivation).
    const c = EMBODIMENT_MODE_CONTRACTS.mind;
    expect(c.driver).toBe("self");
    expect(c.observer).toBe("self");
    expect(c.source).toBe("interior");
    expect(c.consent).toBe("always-permitted");
  });

  it("every lifecycleDefaults entry is a valid SlabItemPhase", () => {
    // Compile-time enforced via ReadonlyArray<SlabItemPhase> on the
    // contract; this runtime check is a defensive regression pin in
    // case a future contributor widens the type.
    const validPhases: readonly SlabItemPhase[] = [
      "emerging",
      "active",
      "resting",
      "pinching",
      "detached",
      "dissolving",
      "gone",
    ];
    for (const mode of ALL_MODES) {
      const phases = EMBODIMENT_MODE_CONTRACTS[mode].lifecycleDefaults;
      for (const phase of phases) {
        expect(validPhases, `mode "${mode}" has invalid lifecycle phase "${phase}"`).toContain(
          phase,
        );
      }
    }
  });
});
