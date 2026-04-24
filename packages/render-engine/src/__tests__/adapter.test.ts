import { describe, it, expect, beforeEach } from "vitest";
import { TrustMode } from "@motebit/sdk";
import {
  smoothDelta,
  ThreeJSAdapter,
  SpatialAdapter,
  WebXRThreeJSAdapter,
  organicNoise,
  CANONICAL_SPEC,
} from "../index";
import type { RenderFrame, InteriorColor, AudioReactivity, RenderAdapter } from "../spec";

// === Helpers ===

function defaultFrame(overrides?: Partial<RenderFrame>): RenderFrame {
  return {
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
    ...overrides,
  };
}

// === organicNoise ===

describe("organicNoise", () => {
  it("output is bounded to [-1, 1]", () => {
    // Sample at many time points with various frequency sets
    const freqs = [
      [1.5, 2.37, 0.73],
      [0.7, 1.13, 0.31],
      [0.5, 0.83, 0.23],
      [10, 20, 30],
    ];
    for (const f of freqs) {
      for (let t = 0; t < 100; t += 0.1) {
        const v = organicNoise(t, f);
        expect(v).toBeGreaterThanOrEqual(-1);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it("returns 0 at t=0 for any frequencies", () => {
    // sin(0) = 0 for all frequencies
    expect(organicNoise(0, [1, 2, 3])).toBe(0);
    expect(organicNoise(0, [100, 200])).toBe(0);
  });

  it("different times produce different values", () => {
    const f = [1.5, 2.37, 0.73];
    const a = organicNoise(1.0, f);
    const b = organicNoise(1.5, f);
    const c = organicNoise(2.0, f);
    // Not all the same
    expect(a === b && b === c).toBe(false);
  });

  it("different frequency sets produce different patterns", () => {
    const t = 1.0;
    const a = organicNoise(t, [1.5, 2.37, 0.73]);
    const b = organicNoise(t, [0.7, 1.13, 0.31]);
    expect(a).not.toBe(b);
  });

  it("averages toward 0 over long periods (quasi-periodic)", () => {
    const f = [1.5, 2.37, 0.73];
    let sum = 0;
    const N = 10000;
    for (let i = 0; i < N; i++) {
      sum += organicNoise(i * 0.1, f);
    }
    const mean = sum / N;
    expect(Math.abs(mean)).toBeLessThan(0.05);
  });

  it("single frequency degenerates to sin", () => {
    const t = Math.PI / 4; // sin(2 * PI/4) = sin(PI/2) = 1
    expect(organicNoise(t, [2])).toBeCloseTo(Math.sin(t * 2), 10);
  });

  it("is deterministic (same input → same output)", () => {
    const f = [1.5, 2.37, 0.73];
    expect(organicNoise(3.14, f)).toBe(organicNoise(3.14, f));
  });
});

// === Physics Formulas (tested as standalone math) ===

describe("Breathing physics", () => {
  function computeBreath(t: number, audioBreathScale = 1): number {
    const raw = Math.sin(t * 2.0);
    return (
      (raw > 0 ? raw * 0.015 : Math.sign(raw) * Math.pow(Math.abs(raw), 0.6) * 0.015) *
      audioBreathScale
    );
  }

  it("positive half is linear", () => {
    // At t where sin(t*2) = 0.5
    const t = Math.asin(0.5) / 2;
    expect(computeBreath(t)).toBeCloseTo(0.5 * 0.015, 6);
  });

  it("negative half is power-compressed (slower return)", () => {
    // At t where sin(t*2) = -0.5
    const t = (Math.PI + Math.asin(0.5)) / 2;
    const result = computeBreath(t);
    // Power compression: |−0.5|^0.6 * 0.015 ≈ 0.6598 * 0.015 > 0.5 * 0.015
    expect(Math.abs(result)).toBeGreaterThan(0.5 * 0.015);
    expect(result).toBeLessThan(0); // negative half
  });

  it("asymmetry: negative half amplitude is larger than positive at same |sin|", () => {
    // For |sin| = 0.7: positive → 0.7 * 0.015, negative → 0.7^0.6 * 0.015
    const posAmplitude = 0.7 * 0.015;
    const negAmplitude = Math.pow(0.7, 0.6) * 0.015;
    expect(negAmplitude).toBeGreaterThan(posAmplitude);
  });

  it("audio RMS scales breathing amplitude", () => {
    const t = Math.PI / 4; // some arbitrary time
    const noAudio = computeBreath(t, 1);
    const withAudio = computeBreath(t, 1 + 0.8 * 2.5); // rms=0.8
    expect(Math.abs(withAudio)).toBeGreaterThan(Math.abs(noAudio));
    expect(Math.abs(withAudio) / Math.abs(noAudio)).toBeCloseTo(1 + 0.8 * 2.5, 5);
  });

  it("volume conservation: when breathe > 0, X grows and Y shrinks", () => {
    const breathe = 0.01; // positive breath phase
    const REST_Y = 0.97;
    const scaleX = 1.0 + breathe;
    const scaleY = REST_Y - breathe;
    const scaleZ = 1.0 + breathe;
    // Approximate volume: X * Y * Z
    const restVol = 1.0 * REST_Y * 1.0;
    const breathVol = scaleX * scaleY * scaleZ;
    // Volume should be approximately conserved (within a few percent)
    expect(Math.abs(breathVol - restVol) / restVol).toBeLessThan(0.05);
  });
});

describe("Gravity sag physics", () => {
  function computeSag(t: number): number {
    const raw = Math.sin(t * 0.32 * Math.PI * 2);
    return raw > 0 ? raw * 0.032 : Math.sign(raw) * Math.pow(Math.abs(raw), 0.5) * 0.032;
  }

  it("positive half (gravity pull) is linear", () => {
    // At peak of positive half, sin = 1.0
    const sagMax = computeSag(1 / (0.32 * 4)); // quarter period
    expect(sagMax).toBeCloseTo(0.032, 3);
  });

  it("negative half (tension recovery) is power-compressed", () => {
    // At trough of negative half, sin = -1.0, |−1|^0.5 = 1
    const sagMin = computeSag(3 / (0.32 * 4)); // three-quarter period
    expect(sagMin).toBeCloseTo(-0.032, 3);
  });

  it("recovery is faster than deformation (Bo > 0 signature)", () => {
    // For |sin| = 0.5: gravity → 0.5 * 0.032, tension → 0.5^0.5 * 0.032
    const gravityHalf = 0.5 * 0.032;
    const tensionHalf = Math.pow(0.5, 0.5) * 0.032;
    expect(tensionHalf).toBeGreaterThan(gravityHalf);
  });
});

describe("Glow threshold", () => {
  function computeGlow(intensity: number, audioGlow = 0): number {
    return Math.max(0, (intensity - 0.3) * 0.2 + audioGlow);
  }

  it("zero at rest (glow_intensity ≤ 0.3)", () => {
    expect(computeGlow(0)).toBe(0);
    expect(computeGlow(0.1)).toBe(0);
    expect(computeGlow(0.3)).toBe(0);
  });

  it("positive when glow_intensity > 0.3", () => {
    expect(computeGlow(0.31)).toBeGreaterThan(0);
    expect(computeGlow(0.5)).toBeGreaterThan(0);
    expect(computeGlow(1.0)).toBeGreaterThan(0);
  });

  it("linear ramp above threshold", () => {
    const at05 = computeGlow(0.5);
    const at07 = computeGlow(0.7);
    const at09 = computeGlow(0.9);
    // Equidistant points (0.2 apart) should produce equal deltas
    expect(at07 - at05).toBeCloseTo(at09 - at07, 5);
  });

  it("bass audio adds to glow", () => {
    const noAudio = computeGlow(0.5);
    const withBass = computeGlow(0.5, 0.8 * 0.25); // low=0.8
    expect(withBass).toBeGreaterThan(noAudio);
  });

  it("bass can make glow visible even below threshold", () => {
    // glow_intensity=0.2 is below threshold, but bass can push it above 0
    const result = computeGlow(0.2, 0.5 * 0.25);
    // (0.2 - 0.3) * 0.2 + 0.125 = -0.02 + 0.125 = 0.105
    expect(result).toBeGreaterThan(0);
  });
});

describe("Eye dilation range", () => {
  function computeEyeScale(dilation: number): number {
    return 0.8 + dilation * 0.4;
  }

  it("minimum at dilation=0 is 0.8", () => {
    expect(computeEyeScale(0)).toBe(0.8);
  });

  it("maximum at dilation=1 is 1.2", () => {
    expect(computeEyeScale(1)).toBeCloseTo(1.2);
  });

  it("neutral at dilation=0.5 is 1.0", () => {
    expect(computeEyeScale(0.5)).toBeCloseTo(1.0);
  });

  it("linear interpolation", () => {
    const a = computeEyeScale(0.2);
    const b = computeEyeScale(0.4);
    const c = computeEyeScale(0.6);
    expect(b - a).toBeCloseTo(c - b, 10);
  });
});

describe("Audio reactivity scaling", () => {
  it("null audio produces neutral values", () => {
    function breathScale(a: AudioReactivity | null): number {
      return a ? 1 + a.rms * 2.5 : 1;
    }
    function glowBoost(a: AudioReactivity | null): number {
      return a ? a.low * 0.25 : 0;
    }
    function driftBoost(a: AudioReactivity | null): number {
      return a ? a.mid * 0.015 : 0;
    }
    function shimmerBoost(a: AudioReactivity | null): number {
      return a ? a.high * 0.35 : 0;
    }
    expect(breathScale(null)).toBe(1);
    expect(glowBoost(null)).toBe(0);
    expect(driftBoost(null)).toBe(0);
    expect(shimmerBoost(null)).toBe(0);
  });

  it("full-energy audio produces expected scaling", () => {
    const a: AudioReactivity = { rms: 1, low: 1, mid: 1, high: 1 };
    expect(1 + a.rms * 2.5).toBe(3.5); // breath scale
    expect(a.low * 0.25).toBe(0.25); // glow boost
    expect(a.mid * 0.015).toBe(0.015); // drift boost
    expect(a.high * 0.35).toBe(0.35); // iridescence boost
  });

  it("each band is independent", () => {
    const bassOnly: AudioReactivity = { rms: 0, low: 0.8, mid: 0, high: 0 };
    expect(bassOnly.low * 0.25).toBe(0.2);
    expect(bassOnly.mid * 0.015).toBe(0);
    expect(bassOnly.high * 0.35).toBe(0);
  });
});

// === smoothDelta edge cases ===

describe("smoothDelta edge cases", () => {
  it("very large deltaTime approaches target in one step", () => {
    const result = smoothDelta(0, 1, 100, 5);
    expect(result).toBeCloseTo(1, 5);
  });

  it("works with negative target", () => {
    const result = smoothDelta(0, -1, 0.1, 5);
    expect(result).toBeLessThan(0);
    expect(result).toBeGreaterThan(-1);
  });

  it("same current and target returns same value", () => {
    expect(smoothDelta(0.5, 0.5, 0.016)).toBeCloseTo(0.5, 10);
  });

  it("is frame-rate independent", () => {
    // Two steps of dt=0.016 should approximately equal one step of dt=0.032
    const twoStep = smoothDelta(smoothDelta(0, 1, 0.016), 1, 0.016);
    const oneStep = smoothDelta(0, 1, 0.032);
    expect(twoStep).toBeCloseTo(oneStep, 2);
  });
});

// === ThreeJSAdapter ===

describe("ThreeJSAdapter (headless)", () => {
  let adapter: ThreeJSAdapter;

  beforeEach(() => {
    adapter = new ThreeJSAdapter();
  });

  it("setAudioReactivity stores and clears value", async () => {
    await adapter.init(null);
    const audio: AudioReactivity = { rms: 0.5, low: 0.3, mid: 0.4, high: 0.2 };
    adapter.setAudioReactivity(audio);
    expect(
      (adapter as unknown as { creatureState: { audio: AudioReactivity | null } }).creatureState
        .audio,
    ).toBe(audio);

    adapter.setAudioReactivity(null);
    expect(
      (adapter as unknown as { creatureState: { audio: AudioReactivity | null } }).creatureState
        .audio,
    ).toBeNull();
  });

  it("setBackground is safe without scene", () => {
    // No init — no scene
    expect(() => adapter.setBackground(0xff0000)).not.toThrow();
    expect(() => adapter.setBackground(null)).not.toThrow();
  });

  it("setDarkEnvironment is safe without renderer", () => {
    expect(() => adapter.setDarkEnvironment()).not.toThrow();
  });

  it("setLightEnvironment is safe without renderer", () => {
    expect(() => adapter.setLightEnvironment()).not.toThrow();
  });

  it("setInteriorColor is safe without body material", async () => {
    await adapter.init(null);
    const color: InteriorColor = {
      tint: [0.8, 0.6, 0.9],
      glow: [0.3, 0.2, 0.5],
      glowIntensity: 0.1,
    };
    expect(() => adapter.setInteriorColor(color)).not.toThrow();
  });

  it("enableOrbitControls is safe without camera/renderer", () => {
    expect(() => adapter.enableOrbitControls()).not.toThrow();
  });

  it("multiple dispose calls are safe", async () => {
    await adapter.init(null);
    adapter.dispose();
    adapter.dispose();
  });

  it("re-init after dispose works", async () => {
    await adapter.init(null);
    adapter.dispose();
    await adapter.init(null);
    adapter.render(defaultFrame());
  });

  it("render with extreme cue values does not crash", async () => {
    await adapter.init(null);
    adapter.render(
      defaultFrame({
        cues: {
          hover_distance: 10,
          drift_amplitude: 5,
          glow_intensity: 100,
          eye_dilation: 1,
          smile_curvature: 1,
          speaking_activity: 0,
        },
      }),
    );
  });

  it("render with zero delta_time does not crash", async () => {
    await adapter.init(null);
    adapter.render(defaultFrame({ delta_time: 0, time: 0 }));
  });

  it("getCreatureGroup returns null headless (no creature refs)", async () => {
    await adapter.init(null);
    expect(adapter.getCreatureGroup()).toBeNull();
  });

  it("render with very large time values does not crash", async () => {
    await adapter.init(null);
    adapter.render(defaultFrame({ time: 1e9 }));
  });

  it("resize after dispose is safe", () => {
    expect(() => adapter.resize(1920, 1080)).not.toThrow();
  });

  // Slab passthroughs — in headless mode (`init(null)`), the
  // SlabManager is never constructed, so each method must degrade
  // to a safe no-op / sentinel return. The bridge uses optional
  // chaining, so surfaces that hit a headless adapter (tests, WebGL-
  // unavailable Node environments) still compose cleanly.
  it("addSlabItem returns undefined in headless mode", async () => {
    await adapter.init(null);
    const el = { style: {} } as unknown as HTMLElement;
    const handle = adapter.addSlabItem({ id: "test", kind: "tool_call", element: el });
    expect(handle).toBeUndefined();
  });

  it("dissolveSlabItem resolves in headless mode", async () => {
    await adapter.init(null);
    await expect(adapter.dissolveSlabItem("test")).resolves.toBeUndefined();
  });

  it("detachSlabItemAsArtifact resolves undefined in headless mode", async () => {
    await adapter.init(null);
    const el = { style: {} } as unknown as HTMLElement;
    const result = await adapter.detachSlabItemAsArtifact("test", {
      id: "a",
      kind: "receipt",
      element: el,
    });
    expect(result).toBeUndefined();
  });

  it("clearSlabItems is safe in headless mode", async () => {
    await adapter.init(null);
    expect(() => adapter.clearSlabItems()).not.toThrow();
  });

  it("setSlabVisible is safe in headless mode", async () => {
    await adapter.init(null);
    expect(() => adapter.setSlabVisible(true)).not.toThrow();
    expect(() => adapter.setSlabVisible(false)).not.toThrow();
  });

  it("toggleSlabVisible returns false sentinel in headless mode", async () => {
    await adapter.init(null);
    expect(adapter.toggleSlabVisible()).toBe(false);
  });
});

// === SpatialAdapter (complete coverage) ===

describe("SpatialAdapter (complete)", () => {
  let adapter: SpatialAdapter;

  beforeEach(async () => {
    adapter = new SpatialAdapter();
    await adapter.init(null);
  });

  it("getSpec returns CANONICAL_SPEC", () => {
    expect(adapter.getSpec()).toBe(CANONICAL_SPEC);
  });

  it("setBackground does not throw", () => {
    expect(() => adapter.setBackground(0x000000)).not.toThrow();
    expect(() => adapter.setBackground(null)).not.toThrow();
  });

  it("setDarkEnvironment does not throw", () => {
    expect(() => adapter.setDarkEnvironment()).not.toThrow();
  });

  it("setLightEnvironment does not throw", () => {
    expect(() => adapter.setLightEnvironment()).not.toThrow();
  });

  it("setInteriorColor does not throw", () => {
    const color: InteriorColor = {
      tint: [0.8, 0.6, 0.9],
      glow: [0.3, 0.2, 0.5],
    };
    expect(() => adapter.setInteriorColor(color)).not.toThrow();
  });

  it("setAudioReactivity does not throw", () => {
    expect(() =>
      adapter.setAudioReactivity({ rms: 0.5, low: 0.3, mid: 0.4, high: 0.2 }),
    ).not.toThrow();
    expect(() => adapter.setAudioReactivity(null)).not.toThrow();
  });

  it("resize does not throw", () => {
    expect(() => adapter.resize(800, 600)).not.toThrow();
  });

  it("render with various frames does not throw", () => {
    expect(() => adapter.render(defaultFrame())).not.toThrow();
    expect(() => adapter.render(defaultFrame({ time: 100, delta_time: 0 }))).not.toThrow();
  });

  it("full lifecycle: init → render → dispose → re-init", async () => {
    adapter.render(defaultFrame());
    adapter.dispose();
    await adapter.init(null);
    adapter.render(defaultFrame());
    adapter.dispose();
  });

  it("getCreatureGroup returns null (spatial stub has no scene graph)", () => {
    // SpatialAdapter is a headless stub for test/CI; it has no creature
    // refs to expose. Contract matches NullRenderAdapter: always null.
    expect(adapter.getCreatureGroup()).toBeNull();
  });

  it("setTrustMode does not throw", () => {
    expect(() => adapter.setTrustMode(TrustMode.Full)).not.toThrow();
  });

  it("setListeningIndicator does not throw", () => {
    expect(() => adapter.setListeningIndicator(true)).not.toThrow();
    expect(() => adapter.setListeningIndicator(false)).not.toThrow();
  });
});

// === WebXRThreeJSAdapter ===

describe("WebXRThreeJSAdapter", () => {
  let adapter: WebXRThreeJSAdapter;

  beforeEach(() => {
    adapter = new WebXRThreeJSAdapter();
  });

  it("init(null) marks as initialized (headless)", async () => {
    await adapter.init(null);
    // Should be able to render without crash (but as no-op since no Three.js objects)
    adapter.render(defaultFrame());
  });

  it("render before init does not crash", () => {
    expect(() => adapter.render(defaultFrame())).not.toThrow();
  });

  it("getSpec returns CANONICAL_SPEC", () => {
    expect(adapter.getSpec()).toBe(CANONICAL_SPEC);
    expect(adapter.getSpec().geometry.form).toBe("droplet");
  });

  it("isSupported returns false without navigator.xr", async () => {
    const supported = await WebXRThreeJSAdapter.isSupported();
    expect(supported).toBe(false);
  });

  it("isSessionActive returns false initially", () => {
    expect(adapter.isSessionActive()).toBe(false);
  });

  it("getRenderer returns null before init", () => {
    expect(adapter.getRenderer()).toBeNull();
  });

  it("getRenderer returns null after headless init", async () => {
    await adapter.init(null);
    expect(adapter.getRenderer()).toBeNull();
  });

  it("getCreatureGroup returns null before init", () => {
    expect(adapter.getCreatureGroup()).toBeNull();
  });

  it("getCreatureGroup returns null after headless init (no canvas)", async () => {
    await adapter.init(null);
    expect(adapter.getCreatureGroup()).toBeNull();
  });

  it("startSession returns false without renderer/navigator", async () => {
    const result = await adapter.startSession();
    expect(result).toBe(false);
  });

  it("endSession is safe without renderer", async () => {
    await expect(adapter.endSession()).resolves.toBeUndefined();
  });

  it("setCreatureWorldPosition is safe headless", async () => {
    await adapter.init(null);
    expect(() => adapter.setCreatureWorldPosition(1, 2, 3)).not.toThrow();
  });

  it("setCreatureWorldPosition stores base position", () => {
    adapter.setCreatureWorldPosition(1, -0.5, -1);
    const bp = (
      adapter as unknown as {
        creatureState: { basePosition: { x: number; y: number; z: number } };
      }
    ).creatureState.basePosition;
    expect(bp).toEqual({ x: 1, y: -0.5, z: -1 });
  });

  it("setCreatureLookAt is safe headless", async () => {
    await adapter.init(null);
    expect(() => adapter.setCreatureLookAt(0, 0, 0)).not.toThrow();
  });

  it("setBackground is no-op (AR passthrough)", async () => {
    await adapter.init(null);
    expect(() => adapter.setBackground(0xff0000)).not.toThrow();
    expect(() => adapter.setBackground(null)).not.toThrow();
  });

  it("setDarkEnvironment is safe headless", async () => {
    await adapter.init(null);
    expect(() => adapter.setDarkEnvironment()).not.toThrow();
  });

  it("setLightEnvironment is safe headless", async () => {
    await adapter.init(null);
    expect(() => adapter.setLightEnvironment()).not.toThrow();
  });

  it("setInteriorColor is safe headless", async () => {
    await adapter.init(null);
    expect(() =>
      adapter.setInteriorColor({
        tint: [0.8, 0.6, 0.9],
        glow: [0.3, 0.2, 0.5],
        glowIntensity: 0.05,
      }),
    ).not.toThrow();
  });

  it("setAudioReactivity stores and clears value", async () => {
    await adapter.init(null);
    const audio: AudioReactivity = { rms: 0.5, low: 0.3, mid: 0.4, high: 0.2 };
    adapter.setAudioReactivity(audio);
    expect(
      (adapter as unknown as { creatureState: { audio: AudioReactivity | null } }).creatureState
        .audio,
    ).toBe(audio);

    adapter.setAudioReactivity(null);
    expect(
      (adapter as unknown as { creatureState: { audio: AudioReactivity | null } }).creatureState
        .audio,
    ).toBeNull();
  });

  it("resize is safe headless", async () => {
    await adapter.init(null);
    expect(() => adapter.resize(1920, 1080)).not.toThrow();
  });

  it("resize before init is safe", () => {
    expect(() => adapter.resize(800, 600)).not.toThrow();
  });

  it("dispose is safe headless", async () => {
    await adapter.init(null);
    adapter.dispose();
  });

  it("dispose before init is safe", () => {
    adapter.dispose();
  });

  it("multiple dispose calls are safe", async () => {
    await adapter.init(null);
    adapter.dispose();
    adapter.dispose();
  });

  it("re-init after dispose works", async () => {
    await adapter.init(null);
    adapter.dispose();
    await adapter.init(null);
    adapter.render(defaultFrame());
  });

  it("render with extreme cue values does not crash", async () => {
    await adapter.init(null);
    adapter.render(
      defaultFrame({
        cues: {
          hover_distance: 100,
          drift_amplitude: 50,
          glow_intensity: 10,
          eye_dilation: 1,
          smile_curvature: 1,
          speaking_activity: 0,
        },
      }),
    );
  });

  it("full lifecycle", async () => {
    await adapter.init(null);
    adapter.setCreatureWorldPosition(0, -0.3, -0.8);
    adapter.setCreatureLookAt(0, 0, 0);
    adapter.setAudioReactivity({ rms: 0.5, low: 0.3, mid: 0.2, high: 0.1 });
    adapter.render(defaultFrame());
    adapter.render(defaultFrame({ time: 2.0 }));
    adapter.render(defaultFrame({ time: 3.0 }));
    adapter.setAudioReactivity(null);
    adapter.resize(1920, 1080);
    adapter.dispose();
  });
});

// === RenderAdapter interface conformance ===

describe("RenderAdapter interface conformance", () => {
  const adapters: Array<[string, () => RenderAdapter]> = [
    ["ThreeJSAdapter", () => new ThreeJSAdapter()],
    ["SpatialAdapter", () => new SpatialAdapter()],
    ["WebXRThreeJSAdapter", () => new WebXRThreeJSAdapter()],
  ];

  for (const [name, create] of adapters) {
    describe(name, () => {
      it("implements all RenderAdapter methods", () => {
        const adapter = create();
        expect(typeof adapter.init).toBe("function");
        expect(typeof adapter.render).toBe("function");
        expect(typeof adapter.getSpec).toBe("function");
        expect(typeof adapter.resize).toBe("function");
        expect(typeof adapter.setBackground).toBe("function");
        expect(typeof adapter.setDarkEnvironment).toBe("function");
        expect(typeof adapter.setLightEnvironment).toBe("function");
        expect(typeof adapter.setInteriorColor).toBe("function");
        expect(typeof adapter.setAudioReactivity).toBe("function");
        expect(typeof adapter.setTrustMode).toBe("function");
        expect(typeof adapter.setListeningIndicator).toBe("function");
        expect(typeof adapter.getCreatureGroup).toBe("function");
        expect(typeof adapter.dispose).toBe("function");
      });

      it("getCreatureGroup returns null before init (universal contract)", () => {
        // All adapters must return null from getCreatureGroup when they
        // have no scene graph — pre-init, headless, or stub. This is the
        // RenderAdapter interface contract (see spec.ts); callers rely on
        // it to safely attempt optional scene-object mounting via
        // `const g = adapter.getCreatureGroup(); if (g) ...`
        const adapter = create();
        expect(adapter.getCreatureGroup()).toBeNull();
      });

      it("getSpec returns canonical droplet spec", () => {
        const adapter = create();
        const spec = adapter.getSpec();
        expect(spec.geometry.form).toBe("droplet");
        expect(spec.geometry.base_radius).toBe(0.14);
        expect(spec.material.ior).toBe(1.22);
      });
    });
  }
});
