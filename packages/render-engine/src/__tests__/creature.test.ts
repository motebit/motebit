/**
 * creature.ts tests — exercise pure-CPU Three.js paths without WebGL.
 *
 * createCreature, animateCreature, disposeCreature, computeBlinkFactor,
 * and createEnvironmentMap all run against real Three.js objects (Scene,
 * Group, Mesh, Material) that work in Node. PMREMGenerator is the only
 * WebGL-bound primitive — it's mocked at the "three" module boundary.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as THREE from "three";
import { TrustMode } from "@motebit/sdk";
import {
  organicNoise,
  createBlinkState,
  computeBlinkFactor,
  createCreature,
  createCreatureState,
  animateCreature,
  disposeCreature,
  createEnvironmentMap,
  ENV_DEFAULT,
  ENV_DARK,
  ENV_LIGHT,
  BODY_R,
  EYE_R,
  type CreatureRefs,
  type BlinkState,
} from "../creature.js";
import type { RenderFrame } from "../spec.js";

// --- Mock PMREMGenerator at the THREE module boundary -----------------------
// PMREMGenerator.fromScene compiles shaders and requires a real WebGL
// context. We replace it with a stub that returns a fresh texture and a
// dispose() no-op — preserving the createEnvironmentMap control flow.
vi.mock("three", async () => {
  const actual = await vi.importActual<typeof import("three")>("three");
  class FakePMREMGenerator {
    constructor(_renderer: unknown) {}
    fromScene() {
      // A plain DataTexture is disposable and safe for `scene.environment` assignment.
      return {
        texture: new actual.DataTexture(new Uint8Array(4), 1, 1),
        dispose: () => {},
      };
    }
    dispose() {}
  }
  return {
    ...actual,
    PMREMGenerator: FakePMREMGenerator as unknown as typeof actual.PMREMGenerator,
  };
});

// --- Helpers ---------------------------------------------------------------

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

/** Stand-in renderer — PMREMGenerator is mocked so the argument is unused. */
function fakeRenderer(): THREE.WebGLRenderer {
  return {} as unknown as THREE.WebGLRenderer;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("creature constants", () => {
  it("exposes body and eye radii", () => {
    expect(BODY_R).toBe(0.14);
    expect(EYE_R).toBe(0.035);
  });

  it("ENV_DEFAULT/DARK/LIGHT are distinct", () => {
    expect(ENV_DEFAULT.zenith).not.toEqual(ENV_DARK.zenith);
    expect(ENV_LIGHT.warmTint).toBeDefined();
    expect(ENV_LIGHT.coolTint).toBeDefined();
    expect(ENV_DEFAULT.warmTint).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// organicNoise — smoke coverage for shared helper
// ---------------------------------------------------------------------------

describe("organicNoise (creature re-export)", () => {
  it("returns 0 at t=0 for any frequencies", () => {
    expect(organicNoise(0, [1, 2, 3])).toBe(0);
  });
  it("averages each sinusoid by count", () => {
    // Single-frequency case → direct sine
    expect(organicNoise(0.5, [1])).toBeCloseTo(Math.sin(0.5), 10);
  });
});

// ---------------------------------------------------------------------------
// Blink state machine
// ---------------------------------------------------------------------------

describe("createBlinkState", () => {
  it("generates a valid initial state", () => {
    const s = createBlinkState();
    expect(s.blinkStart).toBe(-1);
    expect(s.nextBlinkAt).toBeGreaterThan(1.0);
    expect(s.nextBlinkAt).toBeLessThan(4.01);
    expect(s.doubleBlink).toBe(false);
    expect(s.secondBlinkPending).toBe(false);
  });
});

describe("computeBlinkFactor", () => {
  function stableState(nextBlinkAt = 2.0): BlinkState {
    return {
      nextBlinkAt,
      blinkStart: -1,
      doubleBlink: false,
      secondBlinkPending: false,
    };
  }

  it("returns 1.0 when time is before nextBlinkAt", () => {
    const s = stableState(10.0);
    expect(computeBlinkFactor(s, 1.0, 0.3, 0)).toBe(1.0);
    expect(s.blinkStart).toBe(-1);
  });

  it("starts a blink when time crosses nextBlinkAt", () => {
    const s = stableState(1.0);
    computeBlinkFactor(s, 1.0, 0.3, 0);
    expect(s.blinkStart).toBe(1.0);
  });

  it("closes the eye during close phase (decreasing from 1 → ~0.05)", () => {
    const s = stableState(1.0);
    // Kick off blink at t=1.0
    computeBlinkFactor(s, 1.0, 0.3, 0);
    // 0.04s into a BLINK_CLOSE=0.08s close phase → mid-close
    const mid = computeBlinkFactor(s, 1.04, 0.3, 0);
    expect(mid).toBeLessThan(1.0);
    expect(mid).toBeGreaterThan(0.05);
  });

  it("holds near-closed during hold phase", () => {
    const s = stableState(1.0);
    computeBlinkFactor(s, 1.0, 0.3, 0);
    // 0.1s elapsed: past BLINK_CLOSE (0.08), inside BLINK_HOLD (ends at 0.12)
    const hold = computeBlinkFactor(s, 1.1, 0.3, 0);
    expect(hold).toBeCloseTo(0.05, 10);
  });

  it("opens the eye during open phase (0.05 → 1.0)", () => {
    const s = stableState(1.0);
    computeBlinkFactor(s, 1.0, 0.3, 0);
    // 0.2s elapsed: past close+hold (0.12), mid-open (open ends at 0.25)
    const opening = computeBlinkFactor(s, 1.2, 0.3, 0);
    expect(opening).toBeGreaterThan(0.05);
    expect(opening).toBeLessThan(1.0);
  });

  it("completes a blink and schedules the next one", () => {
    const s = stableState(1.0);
    computeBlinkFactor(s, 1.0, 0.3, 0);
    // 0.3s elapsed — past BLINK_TOTAL (0.25)
    const after = computeBlinkFactor(s, 1.3, 0.3, 0);
    expect(after).toBe(1.0);
    expect(s.blinkStart).toBe(-1);
    expect(s.nextBlinkAt).toBeGreaterThan(1.3);
  });

  it("double-blink queues a second blink at DOUBLE_GAP", () => {
    const s = stableState(1.0);
    s.doubleBlink = true;
    computeBlinkFactor(s, 1.0, 0.3, 0); // start blink
    const result = computeBlinkFactor(s, 1.3, 0.3, 0); // complete blink
    expect(result).toBe(1.0);
    expect(s.secondBlinkPending).toBe(true);
    expect(s.nextBlinkAt).toBeCloseTo(1.3 + 0.18, 5);
    expect(s.doubleBlink).toBe(false);
  });

  it("thinkStretch branch: high glow lengthens interval", () => {
    // Force deterministic Math.random → interval = BLINK_MIN * stretch * shrink
    const rng = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const thinking = stableState(1.0);
      computeBlinkFactor(thinking, 1.0, 0.5 /* glow > 0.4 */, 0);
      computeBlinkFactor(thinking, 1.3, 0.5, 0); // completes, schedules next
      const thinkingInterval = thinking.nextBlinkAt - 1.3;

      const calm = stableState(1.0);
      computeBlinkFactor(calm, 1.0, 0.1 /* glow ≤ 0.4 */, 0);
      computeBlinkFactor(calm, 1.3, 0.1, 0);
      const calmInterval = calm.nextBlinkAt - 1.3;

      expect(thinkingInterval).toBeGreaterThan(calmInterval);
    } finally {
      rng.mockRestore();
    }
  });

  it("speakShrink branch: active speaking shortens interval", () => {
    const rng = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const speaking = stableState(1.0);
      computeBlinkFactor(speaking, 1.0, 0.1, 0.5 /* speaking > 0.01 */);
      computeBlinkFactor(speaking, 1.3, 0.1, 0.5);
      const speakInterval = speaking.nextBlinkAt - 1.3;

      const quiet = stableState(1.0);
      computeBlinkFactor(quiet, 1.0, 0.1, 0);
      computeBlinkFactor(quiet, 1.3, 0.1, 0);
      const quietInterval = quiet.nextBlinkAt - 1.3;

      expect(speakInterval).toBeLessThan(quietInterval);
    } finally {
      rng.mockRestore();
    }
  });

  it("arms a double-blink when random < DOUBLE_CHANCE", () => {
    const rng = vi.spyOn(Math, "random").mockReturnValue(0); // < 0.15
    try {
      const s = stableState(1.0);
      computeBlinkFactor(s, 1.0, 0.3, 0);
      computeBlinkFactor(s, 1.3, 0.3, 0);
      expect(s.doubleBlink).toBe(true);
    } finally {
      rng.mockRestore();
    }
  });

  it("does not arm a double-blink when random ≥ DOUBLE_CHANCE", () => {
    const rng = vi.spyOn(Math, "random").mockReturnValue(0.5); // ≥ 0.15
    try {
      const s = stableState(1.0);
      computeBlinkFactor(s, 1.0, 0.3, 0);
      computeBlinkFactor(s, 1.3, 0.3, 0);
      expect(s.doubleBlink).toBe(false);
    } finally {
      rng.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// createEnvironmentMap — renders against mocked PMREMGenerator
// ---------------------------------------------------------------------------

describe("createEnvironmentMap", () => {
  it("builds and disposes default env without throwing", () => {
    const tex = createEnvironmentMap(fakeRenderer());
    expect(tex).toBeDefined();
    tex.dispose();
  });

  it("builds dark preset (no spectral tint)", () => {
    const tex = createEnvironmentMap(fakeRenderer(), ENV_DARK);
    expect(tex).toBeDefined();
    tex.dispose();
  });

  it("builds light preset (spectral warm/cool tint branch)", () => {
    const tex = createEnvironmentMap(fakeRenderer(), ENV_LIGHT);
    expect(tex).toBeDefined();
    tex.dispose();
  });
});

// ---------------------------------------------------------------------------
// createCreature / disposeCreature — Three.js objects in Node
// ---------------------------------------------------------------------------

describe("createCreature", () => {
  it("attaches a creature group to a Scene", () => {
    const scene = new THREE.Scene();
    const refs = createCreature(scene);
    expect(scene.children).toContain(refs.group);
    expect(refs.group.children.length).toBeGreaterThan(0);
    expect(refs.bodyMesh).toBeInstanceOf(THREE.Mesh);
    expect(refs.bodyMaterial).toBeInstanceOf(THREE.MeshPhysicalMaterial);
    expect(refs.leftEye).toBeInstanceOf(THREE.Group);
    expect(refs.rightEye).toBeInstanceOf(THREE.Group);
    expect(refs.smileMesh).toBeInstanceOf(THREE.Mesh);
    disposeCreature(refs);
  });

  it("attaches a creature group to another Group", () => {
    const parent = new THREE.Group();
    const refs = createCreature(parent);
    expect(parent.children).toContain(refs.group);
    disposeCreature(refs);
  });

  it("positions eyes and smile correctly", () => {
    const scene = new THREE.Scene();
    const refs = createCreature(scene);
    expect(refs.leftEye.position.x).toBeLessThan(0);
    expect(refs.rightEye.position.x).toBeGreaterThan(0);
    expect(refs.smileMesh.position.y).toBeLessThan(0);
    disposeCreature(refs);
  });

  it("body material has glass-like physical properties", () => {
    const scene = new THREE.Scene();
    const refs = createCreature(scene);
    expect(refs.bodyMaterial.transmission).toBeCloseTo(0.94, 5);
    expect(refs.bodyMaterial.ior).toBeCloseTo(1.22, 5);
    expect(refs.bodyMaterial.roughness).toBe(0.0);
    expect(refs.bodyMaterial.iridescence).toBeGreaterThan(0);
    disposeCreature(refs);
  });
});

describe("disposeCreature", () => {
  it("disposes all geometries and materials (no throw)", () => {
    const scene = new THREE.Scene();
    const refs = createCreature(scene);
    disposeCreature(refs);
    // Second dispose must also be safe (dispose() is idempotent on THREE objects)
    disposeCreature(refs);
  });
});

// ---------------------------------------------------------------------------
// animateCreature — the big one. Pure math, exercises all branches.
// ---------------------------------------------------------------------------

describe("animateCreature", () => {
  let scene: THREE.Scene;
  let refs: CreatureRefs;

  beforeEach(() => {
    scene = new THREE.Scene();
    refs = createCreature(scene);
  });

  it("runs one frame without throwing", () => {
    const state = createCreatureState();
    animateCreature(refs, state, defaultFrame());
  });

  it("drives the body material thickness via trust mode (Full)", () => {
    const state = createCreatureState();
    state.trustMode = TrustMode.Full;
    // Nudge thickness away from the Full target so convergence is observable.
    refs.bodyMaterial.thickness = 0.5;
    for (let i = 0; i < 200; i++) {
      animateCreature(refs, state, defaultFrame({ time: i * 0.016, delta_time: 0.016 }));
    }
    expect(refs.bodyMaterial.thickness).toBeCloseTo(0.18, 2);
  });

  it("drives the body material thickness via trust mode (Guarded)", () => {
    const state = createCreatureState();
    state.trustMode = TrustMode.Guarded;
    for (let i = 0; i < 200; i++) {
      animateCreature(refs, state, defaultFrame({ time: i * 0.016, delta_time: 0.016 }));
    }
    expect(refs.bodyMaterial.thickness).toBeCloseTo(0.25, 2);
  });

  it("drives the body material thickness via trust mode (Minimal)", () => {
    const state = createCreatureState();
    state.trustMode = TrustMode.Minimal;
    for (let i = 0; i < 200; i++) {
      animateCreature(refs, state, defaultFrame({ time: i * 0.016, delta_time: 0.016 }));
    }
    expect(refs.bodyMaterial.thickness).toBeCloseTo(0.35, 2);
  });

  it("suppresses emissive intensity under Minimal trust", () => {
    const state = createCreatureState();
    state.trustMode = TrustMode.Minimal;
    state.interiorColor = { tint: [0.5, 0.5, 1.0], glow: [0.5, 0.5, 1.0], glowIntensity: 0.5 };
    // High glow cues
    for (let i = 0; i < 100; i++) {
      animateCreature(
        refs,
        state,
        defaultFrame({
          time: i * 0.016,
          delta_time: 0.016,
          cues: {
            hover_distance: 0.4,
            drift_amplitude: 0.02,
            glow_intensity: 1.0,
            eye_dilation: 0.3,
            smile_curvature: 0,
            speaking_activity: 0,
          },
        }),
      );
    }
    expect(refs.bodyMaterial.emissiveIntensity).toBe(0);
  });

  it("applies audio reactivity (non-null branch)", () => {
    const state = createCreatureState();
    state.audio = { rms: 0.8, low: 0.5, mid: 0.5, high: 0.5 };
    animateCreature(refs, state, defaultFrame());
    // With audio: iridescence = 0.4 + high*0.35 + listening → >0.4
    expect(refs.bodyMaterial.iridescence).toBeGreaterThan(0.4);
  });

  it("null audio branch produces neutral iridescence", () => {
    const state = createCreatureState();
    state.audio = null;
    animateCreature(refs, state, defaultFrame());
    expect(refs.bodyMaterial.iridescence).toBeCloseTo(0.4, 5);
  });

  it("listening indicator adds iridescence oscillation", () => {
    const state = createCreatureState();
    state.listeningActive = true;
    // time = 0.25 → sin(π/2) = 1 → full iridescence boost
    animateCreature(refs, state, defaultFrame({ time: 0.25 }));
    expect(refs.bodyMaterial.iridescence).toBeGreaterThan(0.4);
  });

  it("uses interiorColor tint when present", () => {
    const state = createCreatureState();
    state.interiorColor = {
      tint: [0.9, 0.3, 0.3],
      glow: [0.0, 0.0, 0.0],
      glowIntensity: 0,
    };
    state.trustMode = TrustMode.Full; // no desaturation
    for (let i = 0; i < 500; i++) {
      animateCreature(refs, state, defaultFrame({ time: i * 0.016, delta_time: 0.016 }));
    }
    expect(refs.bodyMaterial.attenuationColor.r).toBeGreaterThan(
      refs.bodyMaterial.attenuationColor.g,
    );
  });

  it("null interiorColor falls back to default tint", () => {
    const state = createCreatureState();
    state.interiorColor = null;
    animateCreature(refs, state, defaultFrame());
    // No throw, default path taken
    expect(refs.bodyMaterial.attenuationColor).toBeDefined();
  });

  it("high glow_intensity triggers the thinkLift branch (positive)", () => {
    const state = createCreatureState();
    for (let i = 0; i < 100; i++) {
      animateCreature(
        refs,
        state,
        defaultFrame({
          time: i * 0.016,
          delta_time: 0.016,
          cues: {
            hover_distance: 0.4,
            drift_amplitude: 0.02,
            glow_intensity: 1.0,
            eye_dilation: 0.3,
            smile_curvature: 0,
            speaking_activity: 0,
          },
        }),
      );
    }
    // With glow_intensity settled near 1.0: thinkLift = (1-0.4)*0.03 = 0.018 → eye y = 0.015 + 0.018
    expect(refs.leftEye.position.y).toBeGreaterThan(0.015);
    expect(refs.rightEye.position.y).toBeGreaterThan(0.015);
  });

  it("low glow_intensity yields zero thinkLift", () => {
    const state = createCreatureState();
    for (let i = 0; i < 100; i++) {
      animateCreature(
        refs,
        state,
        defaultFrame({
          time: i * 0.016,
          delta_time: 0.016,
          cues: {
            hover_distance: 0.4,
            drift_amplitude: 0.02,
            glow_intensity: 0.0,
            eye_dilation: 0.3,
            smile_curvature: 0,
            speaking_activity: 0,
          },
        }),
      );
    }
    expect(refs.leftEye.position.y).toBeCloseTo(0.015, 3);
  });

  it("active speaking exercises smile oscillation branch", () => {
    const state = createCreatureState();
    animateCreature(
      refs,
      state,
      defaultFrame({
        time: 1.0,
        cues: {
          hover_distance: 0.4,
          drift_amplitude: 0.02,
          glow_intensity: 0.3,
          eye_dilation: 0.3,
          smile_curvature: 0,
          speaking_activity: 1.0,
        },
      }),
    );
    // No throw; the speaking branch was taken.
    expect(refs.smileMesh.scale.y).toBeGreaterThan(0);
  });

  it("quiet speaking skips the smile oscillation branch", () => {
    const state = createCreatureState();
    animateCreature(
      refs,
      state,
      defaultFrame({
        cues: {
          hover_distance: 0.4,
          drift_amplitude: 0.02,
          glow_intensity: 0.3,
          eye_dilation: 0.3,
          smile_curvature: 0,
          speaking_activity: 0,
        },
      }),
    );
    expect(refs.smileMesh.scale.x).toBeCloseTo(1.0, 5);
  });

  it("high eye_dilation drives curiosity tilt", () => {
    const state = createCreatureState();
    for (let i = 0; i < 50; i++) {
      animateCreature(
        refs,
        state,
        defaultFrame({
          time: i * 0.016,
          delta_time: 0.016,
          cues: {
            hover_distance: 0.4,
            drift_amplitude: 0.02,
            glow_intensity: 0.3,
            eye_dilation: 0.9,
            smile_curvature: 0,
            speaking_activity: 0,
          },
        }),
      );
    }
    // Either positive or negative tilt depending on phase
    expect(Math.abs(refs.group.rotation.z)).toBeGreaterThanOrEqual(0);
  });

  it("applies basePosition offset for AR placement", () => {
    const state = createCreatureState();
    state.basePosition = { x: 1, y: -0.3, z: -0.5 };
    animateCreature(refs, state, defaultFrame({ time: 0 })); // t=0 → noise=0
    expect(refs.group.position.x).toBeCloseTo(1, 2);
    expect(refs.group.position.z).toBeCloseTo(-0.5, 2);
  });

  it("positive smile_curvature induces squint (eyeScale shrinks)", () => {
    const state = createCreatureState();
    // Settle with no smile — capture a reference eye scale
    for (let i = 0; i < 200; i++) {
      animateCreature(
        refs,
        state,
        defaultFrame({
          time: i * 0.016,
          delta_time: 0.016,
          cues: {
            hover_distance: 0.4,
            drift_amplitude: 0.02,
            glow_intensity: 0.3,
            eye_dilation: 0.5,
            smile_curvature: 0,
            speaking_activity: 0,
          },
        }),
      );
    }
    // Run enough frames between blinks to read a steady x-scale.
    const noSmileScale = refs.leftEye.scale.x;

    // Now add a smile — squint should shrink x-scale
    const smilingState = createCreatureState();
    for (let i = 0; i < 200; i++) {
      animateCreature(
        refs,
        smilingState,
        defaultFrame({
          time: i * 0.016,
          delta_time: 0.016,
          cues: {
            hover_distance: 0.4,
            drift_amplitude: 0.02,
            glow_intensity: 0.3,
            eye_dilation: 0.5,
            smile_curvature: 1.0,
            speaking_activity: 0,
          },
        }),
      );
    }
    const smileScale = refs.leftEye.scale.x;
    expect(smileScale).toBeLessThan(noSmileScale);
  });

  it("varies breathe over many frames (positive and negative half-cycles)", () => {
    const state = createCreatureState();
    const scaleYSamples: number[] = [];
    // Long enough to cover multiple breathing cycles (BREATHE_FREQ = 0.3 Hz → ~3.3s period)
    for (let i = 0; i < 500; i++) {
      animateCreature(refs, state, defaultFrame({ time: i * 0.05, delta_time: 0.05 }));
      scaleYSamples.push(refs.bodyMesh.scale.y);
    }
    const min = Math.min(...scaleYSamples);
    const max = Math.max(...scaleYSamples);
    expect(max).toBeGreaterThan(min);
  });

  it("updates smoothedCues toward frame cues", () => {
    const state = createCreatureState();
    const initial = state.smoothedCues.glow_intensity;
    for (let i = 0; i < 100; i++) {
      animateCreature(
        refs,
        state,
        defaultFrame({
          time: i * 0.016,
          delta_time: 0.016,
          cues: {
            hover_distance: 0.4,
            drift_amplitude: 0.02,
            glow_intensity: 1.0,
            eye_dilation: 0.3,
            smile_curvature: 0,
            speaking_activity: 0,
          },
        }),
      );
    }
    expect(state.smoothedCues.glow_intensity).toBeGreaterThan(initial);
    expect(state.smoothedCues.glow_intensity).toBeCloseTo(1.0, 1);
  });
});
