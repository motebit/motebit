/**
 * Self-contained HTML for the creature WebView renderer.
 *
 * Runs in WKWebView (iOS) with full WebGL2 — same engine as Safari.
 * Loads Three.js from CDN, inlines the creature geometry/material/animation
 * from packages/render-engine/src/creature.ts. Communicates with React Native
 * via postMessage.
 *
 * Stage 1 (2026-04-19): the `@motebit/render-engine` browser bundle is
 * inlined via `MOTEBIT_RE_BUNDLE` (codegen'd from the package). It runs
 * inside the WebView and exposes `window.MotebitRE`, providing
 * `CredentialSatelliteRenderer` + friends so credential satellites mount
 * on mobile through the same package that ships them on web/desktop.
 *
 * Stage 2 (deferred): replace the inline `BODY_R`, `createBody`,
 * `animate`, etc. below with `window.MotebitRE.createCreature(scene)` +
 * `window.MotebitRE.animateCreature(refs, state, frame)` so the creature
 * code stops duplicating packages/render-engine/src/creature.ts. Needs
 * visual verification in the iOS simulator.
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
// scope. Exposes CredentialSatelliteRenderer, createCreature, etc. for
// scene primitives shared with web/desktop/spatial. Regenerated from the
// package by apps/mobile/scripts/build-creature-html.mjs.
${MOTEBIT_RE_BUNDLE}

// === Constants (from creature.ts) ===
const BODY_R = 0.14;
const EYE_R = 0.035;

// === Environment Presets ===
const ENV_LIGHT = {
  zenith: [0.22, 0.32, 0.72],
  horizon: [0.92, 0.62, 0.35],
  ground: [0.15, 0.14, 0.18],
  sun: [6.0, 3.2, 0.8],
  fill: [0.3, 0.5, 2.2],
  groundPanel: [0.5, 0.32, 0.18],
  warmTint: [1.25, 0.94, 0.68],
  coolTint: [0.68, 0.88, 1.3],
};

const ENV_DARK = {
  zenith: [0.02, 0.02, 0.04],
  horizon: [0.04, 0.03, 0.03],
  ground: [0.02, 0.02, 0.02],
  sun: [2.0, 1.8, 1.5],
  fill: [0.3, 0.4, 0.8],
  groundPanel: [0.08, 0.06, 0.05],
};

// === Environment Map (from creature.ts createEnvironmentMap) ===
function createEnvironmentMap(renderer, preset) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();

  const skyGeo = new THREE.SphereGeometry(5, 64, 32);
  const z = preset.zenith, h = preset.horizon, g = preset.ground;
  const hasSpectral = preset.warmTint && preset.coolTint;
  const w = preset.warmTint || [1,1,1], c = preset.coolTint || [1,1,1];
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: {},
    vertexShader: \`
      varying vec3 vWorldPos;
      void main() {
        vWorldPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    \`,
    fragmentShader: \`
      varying vec3 vWorldPos;
      void main() {
        vec3 dir = normalize(vWorldPos);
        float y = dir.y;
        vec3 zenith = vec3(\${z[0]}, \${z[1]}, \${z[2]});
        vec3 horizon = vec3(\${h[0]}, \${h[1]}, \${h[2]});
        vec3 ground = vec3(\${g[0]}, \${g[1]}, \${g[2]});
        vec3 color;
        if (y > 0.0) {
          color = mix(horizon, zenith, pow(y, 0.6));
        } else {
          color = mix(horizon * 0.5, ground, pow(-y, 0.4));
        }
        \${hasSpectral ? \`
        float azimuth = atan(dir.z, dir.x) / 3.14159;
        float warmFactor = azimuth * 0.5 + 0.5;
        vec3 warm = vec3(\${w[0]}, \${w[1]}, \${w[2]});
        vec3 cool = vec3(\${c[0]}, \${c[1]}, \${c[2]});
        color *= mix(cool, warm, warmFactor);
        \` : ''}
        gl_FragColor = vec4(color, 1.0);
      }
    \`,
  });
  envScene.add(new THREE.Mesh(skyGeo, skyMat));

  const sunMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(...preset.sun), side: THREE.DoubleSide });
  const sunPanel = new THREE.Mesh(new THREE.CircleGeometry(0.85, 32), sunMat);
  sunPanel.position.set(3, 3, 2);
  sunPanel.lookAt(0, 0, 0);
  envScene.add(sunPanel);

  const fillMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(...preset.fill), side: THREE.DoubleSide });
  const fillPanel = new THREE.Mesh(new THREE.CircleGeometry(1.1, 32), fillMat);
  fillPanel.position.set(-2.5, 2, -1);
  fillPanel.lookAt(0, 0, 0);
  envScene.add(fillPanel);

  const groundMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(...(preset.groundPanel || preset.ground)), side: THREE.DoubleSide });
  const groundPanel = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), groundMat);
  groundPanel.position.set(0, -3, 0);
  groundPanel.rotation.x = Math.PI / 2;
  envScene.add(groundPanel);

  const envMap = pmrem.fromScene(envScene, 0, 0.1, 100).texture;
  skyGeo.dispose(); skyMat.dispose(); sunMat.dispose(); fillMat.dispose(); groundMat.dispose();
  pmrem.dispose();
  return envMap;
}

// === Creature Geometry (from creature.ts) ===
function createBody() {
  const geo = new THREE.SphereGeometry(BODY_R, 64, 48);
  const tint = [0.95, 0.95, 1.0];
  const mat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(1.0, 1.0, 1.0),
    transmission: 0.94,
    ior: 1.22,
    thickness: 0.18,
    roughness: 0.0,
    clearcoat: 0.4,
    clearcoatRoughness: 0.02,
    envMapIntensity: 1.2,
    emissive: new THREE.Color(0.8, 0.85, 1.0),
    emissiveIntensity: 0.0,
    iridescence: 0.4,
    iridescenceIOR: 1.3,
    iridescenceThicknessRange: [100, 400],
    side: THREE.FrontSide,
    attenuationColor: new THREE.Color(tint[0], tint[1], tint[2]),
    attenuationDistance: BODY_R * 0.7,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 2;
  return { mesh, material: mat };
}

function createEye() {
  const group = new THREE.Group();
  const eyeGeo = new THREE.SphereGeometry(EYE_R, 32, 32);
  const eyeMat = new THREE.MeshStandardMaterial({
    color: 0x080808,
    roughness: 0.05,
    metalness: 0.0,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  const eyeMesh = new THREE.Mesh(eyeGeo, eyeMat);
  eyeMesh.renderOrder = 1;
  group.add(eyeMesh);

  const catchMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });

  const bigCatchGeo = new THREE.SphereGeometry(EYE_R * 0.18, 16, 16);
  const bigCatch = new THREE.Mesh(bigCatchGeo, catchMat);
  bigCatch.position.set(EYE_R * 0.25, EYE_R * 0.3, EYE_R * 0.95);
  bigCatch.renderOrder = 3;
  group.add(bigCatch);

  const smallCatchGeo = new THREE.SphereGeometry(EYE_R * 0.1, 16, 16);
  const smallCatch = new THREE.Mesh(smallCatchGeo, catchMat);
  smallCatch.position.set(-EYE_R * -0.2, -EYE_R * 0.15, EYE_R * 0.95);
  smallCatch.renderOrder = 3;
  group.add(smallCatch);

  return group;
}

function createSmile() {
  const curve = new THREE.QuadraticBezierCurve3(
    new THREE.Vector3(-0.03, 0, 0),
    new THREE.Vector3(0, -0.012, 0.002),
    new THREE.Vector3(0.03, 0, 0),
  );
  const geo = new THREE.TubeGeometry(curve, 20, 0.002, 6, false);
  const mat = new THREE.MeshBasicMaterial({
    color: 0x111111,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 1;
  return mesh;
}

// === Organic Noise ===
function organicNoise(t, frequencies) {
  let sum = 0;
  for (const f of frequencies) sum += Math.sin(t * f);
  return sum / frequencies.length;
}

// === Blink ===
const BLINK_CLOSE = 0.08, BLINK_HOLD = 0.04, BLINK_OPEN = 0.13;
const BLINK_TOTAL = BLINK_CLOSE + BLINK_HOLD + BLINK_OPEN;
const BLINK_MIN = 2.5, BLINK_MAX = 6.0, DOUBLE_CHANCE = 0.15, DOUBLE_GAP = 0.18;

function createBlinkState() {
  return { nextBlinkAt: 1.0 + Math.random() * 3.0, blinkStart: -1, doubleBlink: false, secondBlinkPending: false };
}

function computeBlinkFactor(state, time, glow, speaking) {
  if (state.blinkStart < 0) {
    if (time >= state.nextBlinkAt) state.blinkStart = time;
    else return 1.0;
  }
  const elapsed = time - state.blinkStart;
  if (elapsed < BLINK_CLOSE) { const t = elapsed / BLINK_CLOSE; return 1.0 - (1 - (1-t)*(1-t)) * 0.95; }
  if (elapsed < BLINK_CLOSE + BLINK_HOLD) return 0.05;
  if (elapsed < BLINK_TOTAL) { const t = (elapsed - BLINK_CLOSE - BLINK_HOLD) / BLINK_OPEN; return 0.05 + t*t*0.95; }
  state.blinkStart = -1;
  if (state.doubleBlink && !state.secondBlinkPending) {
    state.secondBlinkPending = true;
    state.nextBlinkAt = time + DOUBLE_GAP;
    state.doubleBlink = false;
    return 1.0;
  }
  const thinkStretch = glow > 0.4 ? 1.5 : 1.0;
  const speakShrink = speaking > 0.01 ? 0.7 : 1.0;
  state.nextBlinkAt = time + (BLINK_MIN + Math.random() * (BLINK_MAX - BLINK_MIN)) * thinkStretch * speakShrink;
  state.doubleBlink = Math.random() < DOUBLE_CHANCE;
  state.secondBlinkPending = false;
  return 1.0;
}

// === Smooth Delta ===
function smoothDelta(current, target, dt, factor = 5.0) {
  return current + (target - current) * (1 - Math.exp(-factor * dt));
}

// === Animate Creature (from creature.ts animateCreature) ===
function animateCreature(refs, state, frame) {
  const dt = frame.delta_time;
  const t = frame.time;

  state.smoothedCues = {
    hover_distance: smoothDelta(state.smoothedCues.hover_distance, frame.cues.hover_distance, dt),
    drift_amplitude: smoothDelta(state.smoothedCues.drift_amplitude, frame.cues.drift_amplitude, dt),
    glow_intensity: smoothDelta(state.smoothedCues.glow_intensity, frame.cues.glow_intensity, dt),
    eye_dilation: smoothDelta(state.smoothedCues.eye_dilation, frame.cues.eye_dilation, dt),
    smile_curvature: smoothDelta(state.smoothedCues.smile_curvature, frame.cues.smile_curvature, dt, 8.0),
    speaking_activity: smoothDelta(state.smoothedCues.speaking_activity, frame.cues.speaking_activity, dt, 12.0),
  };

  const cues = state.smoothedCues;
  const a = state.audio;
  const audioBreathScale = a ? 1 + a.rms * 2.5 : 1;
  const audioGlow = a ? a.low * 0.25 : 0;
  const audioDrift = a ? a.mid * 0.015 : 0;
  const audioShimmer = a ? a.high * 0.35 : 0;

  const bp = state.basePosition;
  const bobY = organicNoise(t, [1.5, 2.37, 0.73]) * 0.01;
  const drift = cues.drift_amplitude + audioDrift;
  const driftX = organicNoise(t, [0.7, 1.13, 0.31]) * drift;
  const driftZ = organicNoise(t, [0.5, 0.83, 0.23]) * drift * 0.25;

  const BREATHE_FREQ = 0.3;
  const breatheAmplitude = (0.012 + cues.glow_intensity * 0.008) * audioBreathScale;
  const breatheRaw = Math.sin(t * BREATHE_FREQ * Math.PI * 2);
  const breathe = breatheRaw > 0
    ? breatheRaw * breatheAmplitude
    : Math.sign(breatheRaw) * Math.pow(Math.abs(breatheRaw), 0.6) * breatheAmplitude;

  const sagRaw = Math.sin(t * 0.32 * Math.PI * 2);
  const sag = sagRaw > 0 ? sagRaw * 0.032 : Math.sign(sagRaw) * Math.pow(Math.abs(sagRaw), 0.5) * 0.032;

  refs.group.position.set(bp.x + driftX, bp.y + bobY - sag * 0.01, bp.z + driftZ);

  const REST_Y = 0.97;
  refs.bodyMesh.scale.set(1.0 + breathe + sag * 0.15, REST_Y - breathe - sag * 0.3, 1.0 + breathe + sag * 0.15);

  const trustThickness = state.trustMode === 'full' ? 0.18 : state.trustMode === 'guarded' ? 0.25 : 0.35;
  refs.bodyMaterial.thickness = smoothDelta(refs.bodyMaterial.thickness, trustThickness, dt, 2.0);

  const baseTint = state.interiorColor?.tint || [0.95, 0.95, 1.0];
  const trustDesaturation = state.trustMode === 'full' ? 0 : state.trustMode === 'guarded' ? 0.3 : 0.6;
  const tintTarget = new THREE.Color(
    baseTint[0] + (0.85 - baseTint[0]) * trustDesaturation,
    baseTint[1] + (0.85 - baseTint[1]) * trustDesaturation,
    baseTint[2] + (0.9 - baseTint[2]) * trustDesaturation,
  );
  refs.bodyMaterial.attenuationColor.lerp(tintTarget, 1 - Math.exp(-2.0 * dt));

  const trustGlowScale = state.trustMode === 'minimal' ? 0 : 1;
  const baseGlowIntensity = state.interiorColor?.glowIntensity || 0;
  refs.bodyMaterial.emissiveIntensity = Math.max(baseGlowIntensity, Math.max(0, cues.glow_intensity - 0.4) * 0.6 + audioGlow) * trustGlowScale;

  const listeningIridescence = state.listeningActive ? Math.sin(t * Math.PI * 2) * 0.08 : 0;
  refs.bodyMaterial.iridescence = 0.4 + audioShimmer + listeningIridescence;

  {
    const trustEyeMax = state.trustMode === 'minimal' ? 0.2 : 0.4;
    const baseEyeScale = 0.8 + cues.eye_dilation * trustEyeMax;
    const smileSquint = Math.max(0, cues.smile_curvature) * 0.3;
    const eyeScale = baseEyeScale - smileSquint;
    const blink = computeBlinkFactor(state.blinkState, t, cues.glow_intensity, cues.speaking_activity);
    refs.leftEye.scale.set(eyeScale, eyeScale * blink, eyeScale);
    refs.rightEye.scale.set(eyeScale, eyeScale * blink, eyeScale);
    const eyeZ = 0.08 + Math.sin(t * 0.25) * 0.001;
    refs.leftEye.position.z = eyeZ;
    refs.rightEye.position.z = eyeZ;
    const thinkLift = Math.max(0, cues.glow_intensity - 0.4) * 0.03;
    refs.leftEye.position.y = 0.015 + thinkLift;
    refs.rightEye.position.y = 0.015 + thinkLift;
    refs.leftEye.position.x = -0.055;
    refs.rightEye.position.x = 0.055;
  }

  {
    const baseSmile = 0.6 + cues.smile_curvature * 3.0;
    const speakOsc = cues.speaking_activity > 0.01
      ? organicNoise(t, [23.2, 27.0, 32.0]) * cues.speaking_activity * 0.12 : 0;
    refs.smileMesh.scale.y = baseSmile + speakOsc;
    refs.smileMesh.scale.x = 1.0 + cues.speaking_activity * organicNoise(t, [18.2, 23.9]) * 0.05;
  }

  {
    const tiltAmount = Math.max(0, cues.eye_dilation - 0.35) * 0.12;
    refs.group.rotation.z = organicNoise(t, [0.4, 0.67]) * tiltAmount;
  }
}

// === Scene Setup ===
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight, false);

const scene = new THREE.Scene();
let envMap = createEnvironmentMap(renderer, ENV_LIGHT);
scene.environment = envMap;
scene.background = envMap;

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 10);
camera.position.set(0, 0.02, 0.85);
camera.lookAt(0, -0.015, 0);

// Lighting
scene.add(new THREE.AmbientLight(0x8090b0, 0.6));
const key = new THREE.DirectionalLight(0xffeedd, 2.0);
key.position.set(2, 3, 2);
scene.add(key);
const fill = new THREE.DirectionalLight(0xaabbee, 0.6);
fill.position.set(-2, 1.5, -1);
scene.add(fill);
const rim = new THREE.DirectionalLight(0xddeeff, 0.5);
rim.position.set(0, 0.5, -2.5);
scene.add(rim);

// Orbit controls
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, -0.015, 0);
controls.minDistance = 0.3;
controls.maxDistance = 3.0;

// Creature
const group = new THREE.Group();
scene.add(group);
const body = createBody();
group.add(body.mesh);
const leftEye = createEye();
leftEye.position.set(-0.055, 0.015, 0.08);
group.add(leftEye);
const rightEye = createEye();
rightEye.position.set(0.055, 0.015, 0.08);
group.add(rightEye);
const smileMesh = createSmile();
smileMesh.position.set(0, -0.025, 0.09);
group.add(smileMesh);

const refs = { group, bodyMesh: body.mesh, bodyMaterial: body.material, leftEye, rightEye, smileMesh };

// Credential satellites — mounted lazily on first setSatelliteExpression
// message. The renderer parents under the creature's group so satellites
// inherit the creature's world transform (they orbit with it).
let credentialSatellites = null;
function ensureCredentialSatellites() {
  if (credentialSatellites) return credentialSatellites;
  if (!MotebitRE || !MotebitRE.CredentialSatelliteRenderer) return null;
  credentialSatellites = new MotebitRE.CredentialSatelliteRenderer(group);
  return credentialSatellites;
}

const state = {
  blinkState: createBlinkState(),
  smoothedCues: {
    hover_distance: 0.4, drift_amplitude: 0.02, glow_intensity: 0.3,
    eye_dilation: 0.3, smile_curvature: 0, speaking_activity: 0,
  },
  trustMode: 'full',
  listeningActive: false,
  interiorColor: null,
  audio: null,
  basePosition: { x: 0, y: 0, z: 0 },
};

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
      const preset = msg.mode === 'dark' ? ENV_DARK : ENV_LIGHT;
      if (envMap) envMap.dispose();
      envMap = createEnvironmentMap(renderer, preset);
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
      state.trustMode = msg.mode;
      break;
    case 'setListeningIndicator':
      state.listeningActive = msg.active;
      break;
    case 'setSatelliteExpression': {
      // Credentials-as-satellites rendered through the same
      // CredentialSatelliteRenderer web/desktop/spatial use. The
      // React-Native side sends a pure data expression; we apply it.
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
  // Use the WebView's own timing for smooth animation
  frame.delta_time = dt;
  frame.time = time;

  animateCreature(refs, state, frame);
  if (credentialSatellites) credentialSatellites.tick(timestamp);
  controls.update();
  renderer.render(scene, camera);
}
requestAnimationFrame(animate);

// Resize handler
window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

// Signal ready to React Native
window.ReactNativeWebView?.postMessage('ready');
</script>
</body>
</html>`;
