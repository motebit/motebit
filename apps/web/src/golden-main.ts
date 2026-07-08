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
    renderGoldenFrame: (spec: GoldenFrameSpec) => Promise<void>;
    goldenReady: boolean;
  }
}

const canvas = document.getElementById("golden-canvas");
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error("golden harness: #golden-canvas missing");
}

const adapter = new ThreeJSAdapter();

window.renderGoldenFrame = async (spec: GoldenFrameSpec): Promise<void> => {
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
  adapter.render({ cues: perf.cues, time: perf.time, delta_time: 0 });

  // Let the compositor present the frame before Playwright screenshots.
  await new Promise<void>((resolveFrame) => {
    requestAnimationFrame(() => resolveFrame());
  });
};

void adapter.init(canvas).then(() => {
  window.goldenReady = true;
});
