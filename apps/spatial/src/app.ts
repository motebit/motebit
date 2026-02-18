/**
 * Spatial app entry point — the glass creature in physical space.
 *
 * Initializes WebXR, places the creature in AR, and runs the orbital dynamics.
 * The same body, same physics, same breathing — rendered at the user's shoulder.
 */

import { WebXRThreeJSAdapter } from "@motebit/render-engine";
import { OrbitalDynamics, estimateBodyAnchors, getAnchorForReference } from "./index";
import type { BehaviorCues } from "@motebit/sdk";

// === DOM elements ===

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const overlay = document.getElementById("overlay") as HTMLElement;
const enterButton = document.getElementById("enter-ar") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLElement;

// === State ===

const adapter = new WebXRThreeJSAdapter();
const dynamics = new OrbitalDynamics();

// Default cues — idle state. In Phase 5 these come from the state vector / behavior engine.
const idleCues: BehaviorCues = {
  hover_distance: 0.4,
  drift_amplitude: 0.02,
  glow_intensity: 0.3,
  eye_dilation: 0.3,
  smile_curvature: 0.5,
};

let lastTime = 0;
let attentionLevel = 0.2; // slightly attentive by default

// === Initialization ===

async function init(): Promise<void> {
  // Check WebXR support
  const supported = await WebXRThreeJSAdapter.isSupported();

  if (!supported) {
    statusEl.textContent = "WebXR AR not available on this device";
    enterButton.disabled = true;

    // Still init the adapter for a flat preview
    await adapter.init(canvas);
    adapter.setCreatureWorldPosition(0, 0, -0.5);

    startFlatPreview();
    return;
  }

  statusEl.textContent = "Ready";

  await adapter.init(canvas);

  enterButton.addEventListener("click", startAR);
}

// === Flat preview (non-XR fallback) ===
// Shows the creature on a flat canvas when WebXR isn't available.

function startFlatPreview(): void {
  let prevTime = performance.now();

  function loop(now: number): void {
    const dt = (now - prevTime) / 1000;
    prevTime = now;
    const time = now / 1000;

    adapter.render({ cues: idleCues, delta_time: dt, time });
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // Handle resize
  window.addEventListener("resize", () => {
    adapter.resize(window.innerWidth, window.innerHeight);
  });
  adapter.resize(window.innerWidth, window.innerHeight);
}

// === AR Session ===

async function startAR(): Promise<void> {
  statusEl.textContent = "Starting AR session...";
  enterButton.disabled = true;

  const success = await adapter.startSession({
    requiredFeatures: ["local-floor"],
    optionalFeatures: ["hand-tracking", "light-estimation"],
  });

  if (!success) {
    statusEl.textContent = "Failed to start AR session";
    enterButton.disabled = false;
    return;
  }

  overlay.classList.add("hidden");

  const renderer = adapter.getRenderer()!;
  lastTime = performance.now();

  // The WebXR animation loop — Three.js calls this each frame during the XR session
  renderer.setAnimationLoop((time: number) => {
    const now = time || performance.now();
    const dt = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;
    const t = now / 1000;

    // Get head position from XR camera
    const camera = renderer.xr.getCamera();
    const headPos: [number, number, number] = [
      camera.position.x,
      camera.position.y,
      camera.position.z,
    ];

    // Estimate body anchors from head
    const anchors = estimateBodyAnchors(headPos);
    const shoulderAnchor = getAnchorForReference(anchors, "shoulder_right");

    if (shoulderAnchor) {
      // Run orbital dynamics
      const creaturePos = dynamics.tick(dt, t, shoulderAnchor, attentionLevel);
      adapter.setCreatureWorldPosition(creaturePos[0], creaturePos[1], creaturePos[2]);

      // Face the creature toward the user's head
      adapter.setCreatureLookAt(headPos[0], headPos[1], headPos[2]);
    }

    // Render the creature with current behavior cues
    adapter.render({ cues: idleCues, delta_time: dt, time: t });
  });

  // Listen for session end
  const session = renderer.xr.getSession();
  if (session) {
    session.addEventListener("end", () => {
      renderer.setAnimationLoop(null);
      overlay.classList.remove("hidden");
      enterButton.disabled = false;
      statusEl.textContent = "Session ended";
      dynamics.reset();
    });
  }
}

// === Handle input ===
// Touch/pinch increases attention (closer orbit, brighter glow)

document.addEventListener("pointerdown", () => {
  attentionLevel = Math.min(1, attentionLevel + 0.3);
});

document.addEventListener("pointerup", () => {
  // Slowly decay attention
  const decay = setInterval(() => {
    attentionLevel = Math.max(0.2, attentionLevel - 0.05);
    if (attentionLevel <= 0.2) clearInterval(decay);
  }, 100);
});

// === Start ===

init().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  statusEl.textContent = `Error: ${msg}`;
});
