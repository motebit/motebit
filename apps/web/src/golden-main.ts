/**
 * Golden-frame harness entry (docs/doctrine/creature-canon.md §proof contract).
 *
 * Drives the REAL ThreeJSAdapter — the same init path (tone mapping, light
 * rig, environment creation, canonical camera) every user sees — one frame
 * at a time. Playwright loads /golden.html, calls
 * `window.renderGoldenFrame(spec)` per matrix entry, and screenshots the
 * canvas against committed reference frames.
 *
 * Determinism inventory:
 *  - blink is the ONLY Math.random in the frame path → disabled before the
 *    first render (setBlinkEnabled(false));
 *  - every other motion term (breathe, sag, drift, iridescence, speak
 *    oscillation) is a pure function of the pinned performance `time`;
 *  - the environment is pinned explicitly per spec (the adapter's init
 *    default is ENV_DEFAULT, which no app surface actually shows);
 *  - the two-call settle protocol snaps every exponential smoother
 *    (cue EMAs, thickness, attenuation lerp) without reaching into
 *    creature internals: dt=100 drives 1−exp(−k·100) to 1, then dt=0
 *    renders the frozen state.
 */

import {
  ThreeJSAdapter,
  CANONICAL_CAMERA,
  CANONICAL_PERFORMANCES,
  type GoldenFrameSpec,
} from "@motebit/render-engine";

declare global {
  interface Window {
    /**
     * Renders one canonical frame and returns it as a PNG data URL read
     * straight from the WebGL framebuffer (canvas.toDataURL in the same
     * task as the render — the buffer is valid pre-present). Bypasses the
     * compositor and the CDP screenshot path entirely: OS/driver
     * compositing artifacts cannot reach the captured bytes.
     */
    renderGoldenFrame: (spec: GoldenFrameSpec) => Promise<string>;
    goldenReady: boolean;
  }
}

const canvas = document.getElementById("golden-canvas");
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error("golden harness: #golden-canvas missing");
}

const adapter = new ThreeJSAdapter();

window.renderGoldenFrame = async (spec: GoldenFrameSpec): Promise<string> => {
  const perf = CANONICAL_PERFORMANCES[spec.performance];

  // Blink off BEFORE any render — createCreatureState seeds a random
  // blink at 1.0–4.0s and the pinned performance times sit inside that
  // window.
  adapter.setBlinkEnabled(false);

  if (spec.environment === "dark") {
    adapter.setDarkEnvironment();
  } else {
    adapter.setLightEnvironment();
  }

  adapter.setTrustMode(spec.trustMode ?? perf.trustMode);
  adapter.setListeningIndicator(perf.listening);
  adapter.setAudioReactivity(null);
  if (perf.interiorColor) adapter.setInteriorColor(perf.interiorColor);
  adapter.setCameraPose(CANONICAL_CAMERA[spec.camera]);

  // Two-call settle: snap the smoothers, then render the frozen frame.
  adapter.render({ cues: perf.cues, time: perf.time, delta_time: 100 });

  // One PRESENTED frame between environment generation and the captured
  // render: renders issued before the first present after PMREM generation
  // paint a corrupted frame-edge patch (see the NOTE in
  // createEnvironmentMap). The settle frame above absorbs it. Double-rAF:
  // a single rAF fires BEFORE the pending paint — only the second tick is
  // guaranteed to run after a real present.
  await new Promise<void>((resolveFrame) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolveFrame());
    });
  });

  adapter.render({ cues: perf.cues, time: perf.time, delta_time: 0 });

  // Read the framebuffer NOW — same task as the render, before the
  // browser presents/clears the drawing buffer (no preserveDrawingBuffer
  // needed). This is the captured golden frame.
  return canvas.toDataURL("image/png");
};

// Debug handle for harness diagnostics (scene inspection from Playwright).
// Not part of the golden contract; tests must use renderGoldenFrame only.
(window as unknown as Record<string, unknown>).__goldenAdapter = adapter;

void adapter.init(canvas).then(async () => {
  // Pre-warm both environments and flush several presented frames BEFORE
  // any capture: PMREM generation corrupts renders issued near it (see the
  // NOTE in createEnvironmentMap), and the adapter caches environments per
  // preset — so every renderGoldenFrame env swap after this point is pure
  // texture assignment, nowhere near a PMREM run.
  const idleCues = {
    hover_distance: 0.4,
    drift_amplitude: 0.02,
    glow_intensity: 0.3,
    eye_dilation: 0.3,
    smile_curvature: 0,
    speaking_activity: 0,
  };
  adapter.setBlinkEnabled(false);
  for (const env of ["dark", "light"] as const) {
    if (env === "dark") adapter.setDarkEnvironment();
    else adapter.setLightEnvironment();
    for (let i = 0; i < 3; i++) {
      adapter.render({ cues: idleCues, time: 1.25, delta_time: 0 });
      await new Promise<void>((r) => {
        requestAnimationFrame(() => r());
      });
    }
  }
  window.goldenReady = true;
});
