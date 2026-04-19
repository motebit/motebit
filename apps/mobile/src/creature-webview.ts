/**
 * Self-contained HTML for the creature WebView renderer.
 *
 * Runs in WKWebView (iOS) with full WebGL2 — same engine as Safari. The
 * creature geometry, material, environment, animation, blink state,
 * and credential satellites all come from `@motebit/render-engine`'s
 * browser bundle (inlined as `MOTEBIT_RE_BUNDLE`, exposed as
 * `window.MotebitRE`). Mobile now renders the exact same motebit code
 * as web/desktop/spatial — one source of truth, no surface-local copy.
 *
 * Stage 2 complete (2026-04-19): the previous ~370 lines of inline
 * creature code have been replaced with `MotebitRE.createCreature` +
 * `MotebitRE.animateCreature` calls. Side effect of the swap: fixed
 * the long-standing eye catch-light bug where the secondary catch-light
 * was on the wrong side (inline had `-EYE_R * -0.2` — two negatives
 * cancel — while every other surface uses `-EYE_R * 0.2`).
 *
 * What still lives here (not the creature's concern):
 *   - THREE scene setup — renderer, scene, camera, lights, OrbitControls
 *   - postMessage protocol — render / resize / setEnvironment /
 *     setInteriorColor / setAudioReactivity / setTrustMode /
 *     setListeningIndicator / setSatelliteExpression
 *   - rAF loop — the tick is WebView-local timing
 */

import { MOTEBIT_RE_BUNDLE } from "./creature-webview-bundle.generated";

export const CREATURE_HTML = /* html */ `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<style>
* { margin: 0; padding: 0; }
html, body { width: 100%; height: 100%; overflow: hidden; background: transparent; }
canvas { display: block; width: 100%; height: 100%; touch-action: none; }
</style>
</head>
<body>
<canvas id="c"></canvas>
<script type="importmap">
{
  "imports": {
    "three": "https://esm.sh/three@0.170.0",
    "three/addons/": "https://esm.sh/three@0.170.0/examples/jsm/"
  }
}
</script>
<script type="module">
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
// Stash THREE on window so the MotebitRE bundle (inlined below) can
// resolve its \`import "three"\` references — see
// packages/render-engine/scripts/build-browser.mjs three-as-global plugin.
window.THREE = THREE;

// === Inlined @motebit/render-engine browser bundle ===
// The bundle declares \`var MotebitRE = (() => { ... })()\` at module
// scope. Exposes createCreature, animateCreature, CredentialSatelliteRenderer,
// ENV_LIGHT, ENV_DARK, createEnvironmentMap, createCreatureState.
// Regenerated from the package by apps/mobile/scripts/build-creature-html.mjs.
${MOTEBIT_RE_BUNDLE}

// === Scene Setup ===
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight, false);

const scene = new THREE.Scene();
let envMap = MotebitRE.createEnvironmentMap(renderer, MotebitRE.ENV_LIGHT);
scene.environment = envMap;
scene.background = envMap;

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 10);
camera.position.set(0, 0.02, 0.85);
camera.lookAt(0, -0.015, 0);

// Lighting — complements the environment map. Not in the creature package
// because each surface tunes its own lighting balance.
scene.add(new THREE.AmbientLight(0x8090b0, 0.6));
const keyLight = new THREE.DirectionalLight(0xffeedd, 2.0);
keyLight.position.set(2, 3, 2);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0xaabbee, 0.6);
fillLight.position.set(-2, 1.5, -1);
scene.add(fillLight);
const rimLight = new THREE.DirectionalLight(0xddeeff, 0.5);
rimLight.position.set(0, 0.5, -2.5);
scene.add(rimLight);

// Orbit controls — pinch to zoom, drag to rotate. Damping keeps it smooth
// on finger input without overshoot.
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, -0.015, 0);
controls.minDistance = 0.3;
controls.maxDistance = 3.0;

// === Creature (from @motebit/render-engine) ===
// Single source of truth: the creature's geometry, material, blink
// state, and animation all live in the package. This file just mounts
// it and ticks each frame.
const refs = MotebitRE.createCreature(scene);
const state = MotebitRE.createCreatureState();

// === Credential Satellites ===
// Mounted lazily on first setSatelliteExpression message. Parents under
// the creature's group so satellites inherit its world transform.
let credentialSatellites = null;
function ensureCredentialSatellites() {
  if (credentialSatellites) return credentialSatellites;
  if (!MotebitRE || !MotebitRE.CredentialSatelliteRenderer) return null;
  credentialSatellites = new MotebitRE.CredentialSatelliteRenderer(refs.group);
  return credentialSatellites;
}

// === Message Handler (from React Native) ===
let latestFrame = null;

window.__onMessage = function(msg) {
  switch (msg.type) {
    case 'render':
      latestFrame = msg;
      break;
    case 'resize':
      renderer.setSize(msg.width, msg.height, false);
      camera.aspect = msg.width / msg.height;
      camera.updateProjectionMatrix();
      break;
    case 'setEnvironment': {
      const preset = msg.mode === 'dark' ? MotebitRE.ENV_DARK : MotebitRE.ENV_LIGHT;
      if (envMap) envMap.dispose();
      envMap = MotebitRE.createEnvironmentMap(renderer, preset);
      scene.environment = envMap;
      scene.background = envMap;
      break;
    }
    case 'setInteriorColor':
      state.interiorColor = msg.color;
      if (msg.color) {
        refs.bodyMaterial.attenuationColor.setRGB(msg.color.tint[0], msg.color.tint[1], msg.color.tint[2]);
        refs.bodyMaterial.emissive.setRGB(msg.color.glow[0], msg.color.glow[1], msg.color.glow[2]);
        refs.bodyMaterial.emissiveIntensity = msg.color.glowIntensity || 0;
        refs.bodyMaterial.needsUpdate = true;
      }
      break;
    case 'setAudioReactivity':
      state.audio = msg.energy;
      break;
    case 'setTrustMode':
      // TrustMode is a string enum ('full' | 'guarded' | 'minimal'), so
      // msg.mode assigns directly; animateCreature compares against the
      // enum values which are those same strings.
      state.trustMode = msg.mode;
      break;
    case 'setListeningIndicator':
      state.listeningActive = msg.active;
      break;
    case 'setSatelliteExpression': {
      // Credentials-as-satellites rendered through the same
      // CredentialSatelliteRenderer web/desktop/spatial use. React
      // Native sends a pure data expression; we apply it.
      const sat = ensureCredentialSatellites();
      if (sat && msg.expression) {
        sat.setExpression(msg.expression);
      }
      break;
    }
  }
};

// === Animation Loop ===
let lastTime = 0;
function animate(timestamp) {
  requestAnimationFrame(animate);
  const time = timestamp / 1000;
  const dt = lastTime === 0 ? 1/60 : time - lastTime;
  lastTime = time;

  const frame = latestFrame || {
    cues: { hover_distance: 0.4, drift_amplitude: 0.02, glow_intensity: 0.3,
            eye_dilation: 0.3, smile_curvature: 0, speaking_activity: 0 },
    delta_time: dt,
    time: time,
  };
  // Use the WebView's own timing for smooth animation — the React-Native
  // render messages' delta_time is tied to RN's tick, which lags when
  // JS-side work queues up. WebView's rAF produces consistent 60 FPS.
  frame.delta_time = dt;
  frame.time = time;

  MotebitRE.animateCreature(refs, state, frame);
  if (credentialSatellites) credentialSatellites.tick(timestamp);
  controls.update();
  renderer.render(scene, camera);
}
requestAnimationFrame(animate);

// Resize handler — rotation, split-view, keyboard up/down.
window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

// Signal ready to React Native so queued messages can flush.
window.ReactNativeWebView?.postMessage('ready');
</script>
</body>
</html>`;
