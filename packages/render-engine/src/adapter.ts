import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TrustMode, type BehaviorCues, type RenderSpec } from "@motebit/sdk";
import {
  CANONICAL_SPEC,
  CANONICAL_MATERIAL,
  smoothDelta,
  trustToDistance,
  idToHue,
} from "./spec.js";
import type {
  RenderAdapter,
  RenderFrame,
  InteriorColor,
  AudioReactivity,
  RemoteCreatureOpts,
  RemoteCreatureActivity,
  RemoteCreatureState,
  DelegationLineState,
} from "./spec.js";

// === Constants ===

const BODY_R = 0.14;
const EYE_R = 0.035;

// === Organic Noise ===
// Sum of incommensurate sinusoids → quasi-periodic, non-repeating.
// Reads as "suspended in a medium" rather than "programmed oscillation."

export function organicNoise(t: number, frequencies: number[]): number {
  let sum = 0;
  for (const f of frequencies) sum += Math.sin(t * f);
  return sum / frequencies.length;
}

// === Creature Builders ===

function createBody(): { mesh: THREE.Mesh; material: THREE.MeshPhysicalMaterial } {
  const geo = new THREE.SphereGeometry(BODY_R, 64, 48);

  // Material derived from DROPLET.md — glass is surface tension frozen in time
  // IOR 1.3: enough refraction to visibly lens the environment (color shift at edges,
  // distorted horizon) without grotesque magnification of interior geometry.
  // Transmission 0.94: still reads as glass, but the 6% opacity gives the body
  // visual presence — a water droplet, not empty air.
  const tint = CANONICAL_MATERIAL.tint;
  const mat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(1.0, 1.0, 1.0),
    transmission: 0.94,
    ior: 1.22,
    thickness: 0.18,
    roughness: 0.0,
    clearcoat: 0.4,
    clearcoatRoughness: 0.02,
    envMapIntensity: 1.2,
    emissive: new THREE.Color(0.8, 0.85, 1.0), // §6.4 — processing heat visible through glass (moonlight default)
    emissiveIntensity: 0.0, // Zero at rest — only glows during processing
    iridescence: 0.4, // Thin-film interference — bumped for spectral env
    iridescenceIOR: 1.3,
    iridescenceThicknessRange: [100, 400],
    side: THREE.FrontSide,
    attenuationColor: new THREE.Color(tint[0], tint[1], tint[2]),
    attenuationDistance: BODY_R * 0.7, // shorter distance = more visible tinting
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 2;

  return { mesh, material: mat };
}

function createEye(): THREE.Group {
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
  smallCatch.position.set(-EYE_R * 0.2, -EYE_R * 0.15, EYE_R * 0.95);
  smallCatch.renderOrder = 3;
  group.add(smallCatch);

  return group;
}

function createSmile(): THREE.Mesh {
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

interface EnvironmentPreset {
  zenith: [number, number, number];
  horizon: [number, number, number];
  ground: [number, number, number];
  sun: [number, number, number];
  fill: [number, number, number];
  groundPanel: [number, number, number];
  // Optional spectral sky blending — warm-cool gradient around the azimuth.
  // Values are color multipliers (1.0 = no change). Glass needs chromatic
  // variation to refract; uniform environments make transmission invisible.
  warmTint?: [number, number, number];
  coolTint?: [number, number, number];
}

const ENV_DEFAULT: EnvironmentPreset = {
  zenith: [0.15, 0.25, 0.55],
  horizon: [0.7, 0.5, 0.4],
  ground: [0.12, 0.12, 0.18],
  sun: [2.5, 2.2, 1.8],
  fill: [0.4, 0.5, 0.9],
  groundPanel: [0.3, 0.25, 0.2],
};

const ENV_DARK: EnvironmentPreset = {
  zenith: [0.02, 0.02, 0.04],
  horizon: [0.04, 0.03, 0.03],
  ground: [0.02, 0.02, 0.02],
  sun: [2.0, 1.8, 1.5],
  fill: [0.3, 0.4, 0.8],
  groundPanel: [0.08, 0.06, 0.05],
};

export const ENV_LIGHT: EnvironmentPreset = {
  // Spectral environment — chromatic variation for glass refraction.
  // A prism needs a spectrum. Uniform environments make glass invisible.
  // Key insight: ground-sky contrast defines the glass edge; chromatic spread
  // defines what iridescence and attenuation have to work with.
  zenith: [0.22, 0.32, 0.72], // saturated blue upper sky
  horizon: [0.92, 0.62, 0.35], // warm amber horizon — strong hue vs zenith
  ground: [0.15, 0.14, 0.18], // dark cool ground — contrast with bright horizon
  sun: [6.0, 3.2, 0.8], // deep amber-gold key — maximum chromatic identity
  fill: [0.3, 0.5, 2.2], // blue-violet fill — spectral opposite of sun
  groundPanel: [0.5, 0.32, 0.18], // warm ground bounce
  warmTint: [1.25, 0.94, 0.68], // warm side: strong red boost, blue cut
  coolTint: [0.68, 0.88, 1.3], // cool side: strong blue boost, red cut
};

function createEnvironmentMap(
  renderer: THREE.WebGLRenderer,
  preset: EnvironmentPreset = ENV_DEFAULT,
): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();

  const skyGeo = new THREE.SphereGeometry(5, 64, 32);
  const z = preset.zenith,
    h = preset.horizon,
    g = preset.ground;
  const hasSpectral = preset.warmTint && preset.coolTint;
  const w = preset.warmTint ?? [1, 1, 1],
    c = preset.coolTint ?? [1, 1, 1];
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: {},
    vertexShader: `
      varying vec3 vWorldPos;
      void main() {
        vWorldPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vWorldPos;
      void main() {
        vec3 dir = normalize(vWorldPos);
        float y = dir.y;
        vec3 zenith = vec3(${z[0]}, ${z[1]}, ${z[2]});
        vec3 horizon = vec3(${h[0]}, ${h[1]}, ${h[2]});
        vec3 ground = vec3(${g[0]}, ${g[1]}, ${g[2]});
        vec3 color;
        if (y > 0.0) {
          color = mix(horizon, zenith, pow(y, 0.6));
        } else {
          color = mix(horizon * 0.5, ground, pow(-y, 0.4));
        }
        ${
          hasSpectral
            ? `
        // Spectral: horizontal warm-cool gradient around the azimuth.
        // The sky becomes a soft prism — warm on one side, cool on the other.
        // Glass refracts this gradient, making transmission visible.
        float azimuth = atan(dir.z, dir.x) / 3.14159; // -1 to 1
        float warmFactor = azimuth * 0.5 + 0.5;        // 0 (cool) to 1 (warm)
        vec3 warm = vec3(${w[0]}, ${w[1]}, ${w[2]});
        vec3 cool = vec3(${c[0]}, ${c[1]}, ${c[2]});
        color *= mix(cool, warm, warmFactor);
        `
            : ""
        }
        gl_FragColor = vec4(color, 1.0);
      }
    `,
  });
  envScene.add(new THREE.Mesh(skyGeo, skyMat));

  // Circle panels avoid square reflection artifacts on polished surfaces
  const sunMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(...preset.sun),
    side: THREE.DoubleSide,
  });
  const sunPanel = new THREE.Mesh(new THREE.CircleGeometry(0.85, 32), sunMat);
  sunPanel.position.set(3, 3, 2);
  sunPanel.lookAt(0, 0, 0);
  envScene.add(sunPanel);

  const fillMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(...preset.fill),
    side: THREE.DoubleSide,
  });
  const fillPanel = new THREE.Mesh(new THREE.CircleGeometry(1.1, 32), fillMat);
  fillPanel.position.set(-2.5, 2, -1);
  fillPanel.lookAt(0, 0, 0);
  envScene.add(fillPanel);

  const groundMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(...preset.groundPanel),
    side: THREE.DoubleSide,
  });
  const groundPanel = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), groundMat);
  groundPanel.position.set(0, -3, 0);
  groundPanel.rotation.x = Math.PI / 2;
  envScene.add(groundPanel);

  const envMap = pmrem.fromScene(envScene, 0, 0.1, 100).texture;

  skyGeo.dispose();
  skyMat.dispose();
  sunMat.dispose();
  fillMat.dispose();
  groundMat.dispose();
  pmrem.dispose();

  return envMap;
}

// === Blink ===
// Natural blinking: fast close, slow open, random intervals, occasional doubles.
// No new geometry — the eye group squashes on Y. The glass magnification
// makes the blink dramatic from the front, subtle from the side.

interface BlinkState {
  nextBlinkAt: number; // render time (s) for next blink
  blinkStart: number; // render time when current blink started, -1 if idle
  doubleBlink: boolean; // will this be a double-blink
  secondBlinkPending: boolean;
}

const BLINK_CLOSE = 0.08; // seconds — snap shut
const BLINK_HOLD = 0.04; // held closed
const BLINK_OPEN = 0.13; // float back open
const BLINK_TOTAL = BLINK_CLOSE + BLINK_HOLD + BLINK_OPEN;
const BLINK_MIN = 2.5; // min seconds between blinks
const BLINK_MAX = 6.0; // max seconds between blinks
const DOUBLE_CHANCE = 0.15; // 15% chance of double-blink
const DOUBLE_GAP = 0.18; // seconds between double-blink pair

function createBlinkState(): BlinkState {
  return {
    nextBlinkAt: 1.0 + Math.random() * 3.0,
    blinkStart: -1,
    doubleBlink: false,
    secondBlinkPending: false,
  };
}

function computeBlinkFactor(
  state: BlinkState,
  time: number,
  glow: number,
  speaking: number,
): number {
  // Check if it's time to start a blink
  if (state.blinkStart < 0) {
    if (time >= state.nextBlinkAt) {
      state.blinkStart = time;
    } else {
      return 1.0;
    }
  }

  const elapsed = time - state.blinkStart;

  if (elapsed < BLINK_CLOSE) {
    // Closing — quadratic ease-out (fast snap shut)
    const t = elapsed / BLINK_CLOSE;
    return 1.0 - (1 - (1 - t) * (1 - t)) * 0.95;
  }

  if (elapsed < BLINK_CLOSE + BLINK_HOLD) {
    return 0.05; // held shut
  }

  if (elapsed < BLINK_TOTAL) {
    // Opening — quadratic ease-in (slow float open)
    const t = (elapsed - BLINK_CLOSE - BLINK_HOLD) / BLINK_OPEN;
    return 0.05 + t * t * 0.95;
  }

  // Blink complete
  state.blinkStart = -1;

  if (state.doubleBlink && !state.secondBlinkPending) {
    // Queue the second blink quickly
    state.secondBlinkPending = true;
    state.nextBlinkAt = time + DOUBLE_GAP;
    state.doubleBlink = false;
    return 1.0;
  }

  // Schedule next natural blink
  // Thinking suppresses blinks (concentration). Speaking increases rate.
  const thinkStretch = glow > 0.4 ? 1.5 : 1.0;
  const speakShrink = speaking > 0.01 ? 0.7 : 1.0;
  const interval =
    (BLINK_MIN + Math.random() * (BLINK_MAX - BLINK_MIN)) * thinkStretch * speakShrink;
  state.nextBlinkAt = time + interval;
  state.doubleBlink = Math.random() < DOUBLE_CHANCE;
  state.secondBlinkPending = false;
  return 1.0;
}

// === Multi-Creature Helpers ===
// Remote creatures are the same species as the local motebit — same glass, same physics.
// They are smaller (0.6x), calmer (slower breathing), and tinted by their motebit_id hue.

const REMOTE_SCALE = 0.6; // Visitors are smaller — they're guests, not the protagonist

/** Convert HSL hue (0–360) + fixed saturation/lightness to a THREE.Color. */
function hueToColor(hue: number, saturation = 0.55, lightness = 0.65): THREE.Color {
  const color = new THREE.Color();
  color.setHSL(hue / 360, saturation, lightness);
  return color;
}

/** Build a remote creature group (body + eyes). No smile — remote agents are ambient. */
function createRemoteCreature(hue: number): {
  group: THREE.Group;
  body: THREE.Mesh;
  eyes: THREE.Group;
  bodyMaterial: THREE.MeshPhysicalMaterial;
} {
  const group = new THREE.Group();

  // Body — same glass formula as the main creature, tinted by identity hue
  const glowColor = hueToColor(hue, 0.7, 0.6);
  const attenuationColor = hueToColor(hue, 0.4, 0.8);

  const bodyGeo = new THREE.SphereGeometry(BODY_R, 48, 32);
  const bodyMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(1.0, 1.0, 1.0),
    transmission: 0.94,
    ior: 1.22,
    thickness: 0.18,
    roughness: 0.0,
    clearcoat: 0.4,
    clearcoatRoughness: 0.02,
    envMapIntensity: 1.2,
    emissive: glowColor,
    emissiveIntensity: 0.0,
    iridescence: 0.4,
    iridescenceIOR: 1.3,
    iridescenceThicknessRange: [100, 400],
    side: THREE.FrontSide,
    attenuationColor,
    attenuationDistance: BODY_R * 0.7,
  });

  const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
  bodyMesh.renderOrder = 2;
  group.add(bodyMesh);

  // Eyes — simplified (no catchlights on remote agents, they're ambient presence)
  const eyes = new THREE.Group();
  const eyeGeo = new THREE.SphereGeometry(EYE_R * 0.85, 24, 24);
  const eyeMat = new THREE.MeshStandardMaterial({
    color: 0x080808,
    roughness: 0.05,
    metalness: 0.0,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });

  const leftEye = new THREE.Mesh(eyeGeo, eyeMat);
  leftEye.position.set(-0.055, 0.015, 0.08);
  leftEye.renderOrder = 1;
  eyes.add(leftEye);

  const rightEye = new THREE.Mesh(eyeGeo, eyeMat);
  rightEye.position.set(0.055, 0.015, 0.08);
  rightEye.renderOrder = 1;
  eyes.add(rightEye);

  group.add(eyes);

  group.scale.setScalar(REMOTE_SCALE);

  return { group, body: bodyMesh, eyes, bodyMaterial: bodyMat };
}

/** Build the delegation arc line (quadratic bezier, warm amber glow). Returns line ID. */
function createDelegationArc(
  scene: THREE.Scene,
  from: THREE.Vector3,
  to: THREE.Vector3,
): { line: THREE.Line; geometry: THREE.BufferGeometry; material: THREE.LineBasicMaterial } {
  // Organic arc — mid-point lifted on Y for catenary feel, not laser-straight
  const mid = new THREE.Vector3().lerpVectors(from, to, 0.5);
  mid.y += 0.12;

  const curve = new THREE.QuadraticBezierCurve3(from, mid, to);
  const points = curve.getPoints(40);

  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({
    color: new THREE.Color(1.0, 0.72, 0.3), // warm amber — matches ENV_LIGHT sun color
    transparent: true,
    opacity: 0.55,
    linewidth: 1, // Note: linewidth > 1 requires LineSegments2, ignored on most WebGL
    depthWrite: false,
  });

  const line = new THREE.Line(geometry, material);
  line.renderOrder = 1;
  scene.add(line);

  return { line, geometry, material };
}

/** Create the pulse indicator — a small warm sphere that travels along the arc. */
function createPulseMesh(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(0.008, 8, 8);
  const mat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(1.0, 0.85, 0.4),
    transparent: true,
    opacity: 0.0,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 4;
  return mesh;
}

/** Compute the world position of a remote creature given a flat index (for circle layout). */
function circlePosition(index: number, total: number, distance: number): THREE.Vector3 {
  const angle = (index / Math.max(total, 1)) * Math.PI * 2;
  return new THREE.Vector3(Math.cos(angle) * distance, 0, Math.sin(angle) * distance);
}

// === Remote Creature Animation ===

function animateRemoteCreature(state: RemoteCreatureState, t: number, dt: number): void {
  const body = state.body as THREE.Mesh;
  const eyes = state.eyes as THREE.Group;
  const mat = state.bodyMaterial as THREE.MeshPhysicalMaterial;
  const group = state.group as THREE.Group;

  // Breathing — slower/calmer than the main creature (1.4 Hz base vs 2.0 Hz)
  // Phase offset prevents all remote agents from breathing in unison
  const breatheRate = state.activity === "processing" ? 2.2 : 1.4;
  const breatheRaw = Math.sin((t + state.phase) * breatheRate);
  const breathe =
    breatheRaw > 0
      ? breatheRaw * 0.01
      : Math.sign(breatheRaw) * Math.pow(Math.abs(breatheRaw), 0.6) * 0.01;

  const REST_Y = 0.97;
  body.scale.set(1.0 + breathe, REST_Y - breathe, 1.0 + breathe);

  // Gentle bob — same physics, slower
  const bobY = organicNoise(t + state.phase, [1.1, 1.73, 0.61]) * 0.007;
  const basePos = group.userData.basePosition as THREE.Vector3 | undefined;
  if (basePos) {
    group.position.set(basePos.x, basePos.y + bobY, basePos.z);
  }

  // Activity-state emissive modulation
  switch (state.activity) {
    case "idle":
      mat.emissiveIntensity = smoothDelta(mat.emissiveIntensity, 0.0, dt, 3.0);
      break;

    case "processing":
      // Steady moderate glow — active interior
      mat.emissiveIntensity = smoothDelta(mat.emissiveIntensity, 0.35, dt, 4.0);
      break;

    case "delegating": {
      // Slow sine pulse — 0.8 Hz, range 0.15–0.5
      const pulse = 0.15 + 0.35 * (0.5 + 0.5 * Math.sin((t + state.phase) * 0.8 * Math.PI * 2));
      mat.emissiveIntensity = pulse;
      break;
    }

    case "completed": {
      // Brief bright flash then fade to idle
      const elapsed = t - state.completedAt;
      if (elapsed < 0.25) {
        // Flash up
        mat.emissiveIntensity = smoothDelta(mat.emissiveIntensity, 0.9, dt, 15.0);
      } else {
        // Fade out
        mat.emissiveIntensity = smoothDelta(mat.emissiveIntensity, 0.0, dt, 2.5);
      }
      break;
    }
  }

  // Eyes: calm half-open on remote agents — they're ambient presence, not engaging
  const eyeScale = state.activity === "processing" ? 0.9 : 0.75;
  const leftEye = eyes.children[0] as THREE.Mesh;
  const rightEye = eyes.children[1] as THREE.Mesh;
  leftEye.scale.setScalar(eyeScale);
  rightEye.scale.setScalar(eyeScale);
}

// === Delegation Line Animation ===

function animateDelegationLine(
  state: DelegationLineState,
  t: number,
  dt: number,
  fromPos: THREE.Vector3,
  toPos: THREE.Vector3,
): void {
  const mat = state.material as THREE.LineBasicMaterial;

  // Gentle opacity breath — the connection is alive
  const breathOpacity = 0.45 + 0.1 * Math.sin(t * 0.9);
  mat.opacity = breathOpacity;

  // Recompute arc geometry if either endpoint has moved
  const geo = state.geometry as THREE.BufferGeometry;
  const mid = new THREE.Vector3().lerpVectors(fromPos, toPos, 0.5);
  mid.y += 0.12;
  const curve = new THREE.QuadraticBezierCurve3(fromPos, mid, toPos);
  const points = curve.getPoints(40);
  geo.setFromPoints(points);

  // Pulse animation — a warm dot travelling from source to target
  const pulseMesh = state.pulseMesh as THREE.Mesh | null;
  if (pulseMesh && state.pulseProgress >= 0) {
    const pulseMat = pulseMesh.material as THREE.MeshBasicMaterial;
    // Progress 0→1 over 0.7 seconds
    state.pulseProgress = Math.min(1, state.pulseProgress + dt / 0.7);

    // Position along the curve
    const pt = curve.getPoint(state.pulseProgress);
    pulseMesh.position.copy(pt);

    // Opacity: ramp up then down (bell curve)
    const p = state.pulseProgress;
    const bell = Math.sin(p * Math.PI); // 0→1→0
    pulseMat.opacity = bell * 0.9;

    if (state.pulseProgress >= 1) {
      // Pulse complete — hide and reset
      pulseMat.opacity = 0;
      state.pulseProgress = -1;
    }
  }
}

// === Three.js Adapter ===

export class ThreeJSAdapter implements RenderAdapter {
  private spec: RenderSpec = CANONICAL_SPEC;
  private initialized = false;
  private currentCues: BehaviorCues = {
    hover_distance: 0.4,
    drift_amplitude: 0.02,
    glow_intensity: 0.3,
    eye_dilation: 0.3,
    smile_curvature: 0,
    speaking_activity: 0,
  };
  private audio: AudioReactivity | null = null;
  private trustMode: TrustMode = TrustMode.Full;
  private listeningActive = false;
  private interiorColor: InteriorColor | null = null;

  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;

  private controls: OrbitControls | null = null;

  private creature: THREE.Group | null = null;
  private bodyMesh: THREE.Mesh | null = null;
  private bodyMaterial: THREE.MeshPhysicalMaterial | null = null;
  private leftEye: THREE.Group | null = null;
  private rightEye: THREE.Group | null = null;
  private smileMesh: THREE.Mesh | null = null;
  private blinkState: BlinkState = createBlinkState();

  // Multi-creature state
  private remoteCreatures = new Map<string, RemoteCreatureState>();
  private delegationLines = new Map<string, DelegationLineState>();

  init(target: unknown): Promise<void> {
    if (typeof HTMLCanvasElement === "undefined" || !(target instanceof HTMLCanvasElement)) {
      this.initialized = true;
      return Promise.resolve();
    }

    const canvas = target;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);

    this.scene = new THREE.Scene();
    const envMap = createEnvironmentMap(this.renderer);
    this.scene.environment = envMap;
    this.scene.background = envMap;

    this.camera = new THREE.PerspectiveCamera(
      45,
      canvas.clientWidth / canvas.clientHeight,
      0.1,
      10,
    );
    this.camera.position.set(0, 0.02, 0.85);
    this.camera.lookAt(0, -0.015, 0);

    // === Creature ===
    this.creature = new THREE.Group();
    this.scene.add(this.creature);

    const body = createBody();
    this.bodyMesh = body.mesh;
    this.bodyMaterial = body.material;
    this.creature.add(this.bodyMesh);

    this.leftEye = createEye();
    this.leftEye.position.set(-0.055, 0.015, 0.08);
    this.creature.add(this.leftEye);

    this.rightEye = createEye();
    this.rightEye.position.set(0.055, 0.015, 0.08);
    this.creature.add(this.rightEye);

    this.smileMesh = createSmile();
    this.smileMesh.position.set(0, -0.025, 0.09);
    this.creature.add(this.smileMesh);

    // === Lighting ===
    this.scene.add(new THREE.AmbientLight(0x8090b0, 0.6));

    const key = new THREE.DirectionalLight(0xffeedd, 2.0);
    key.position.set(2, 3, 2);
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0xaabbee, 0.6);
    fill.position.set(-2, 1.5, -1);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight(0xddeeff, 0.5);
    rim.position.set(0, 0.5, -2.5);
    this.scene.add(rim);

    this.initialized = true;
    return Promise.resolve();
  }

  render(frame: RenderFrame): void {
    if (
      !this.initialized ||
      !this.creature ||
      !this.bodyMesh ||
      !this.bodyMaterial ||
      !this.renderer ||
      !this.scene ||
      !this.camera
    )
      return;

    const dt = frame.delta_time;
    const t = frame.time;

    this.currentCues = {
      hover_distance: smoothDelta(this.currentCues.hover_distance, frame.cues.hover_distance, dt),
      drift_amplitude: smoothDelta(
        this.currentCues.drift_amplitude,
        frame.cues.drift_amplitude,
        dt,
      ),
      glow_intensity: smoothDelta(this.currentCues.glow_intensity, frame.cues.glow_intensity, dt),
      eye_dilation: smoothDelta(this.currentCues.eye_dilation, frame.cues.eye_dilation, dt),
      smile_curvature: smoothDelta(
        this.currentCues.smile_curvature,
        frame.cues.smile_curvature,
        dt,
        8.0,
      ),
      speaking_activity: smoothDelta(
        this.currentCues.speaking_activity,
        frame.cues.speaking_activity,
        dt,
        12.0,
      ),
    };

    const cues = this.currentCues;
    const a = this.audio;

    // Audio reactivity — sound pressure modulates the creature's body language.
    // Additive: layers on top of behavior cues, not replacing them.
    const audioBreathScale = a ? 1 + a.rms * 2.5 : 1; // breathe bigger with sound energy
    const audioGlow = a ? a.low * 0.25 : 0; // bass → interior heat
    const audioDrift = a ? a.mid * 0.015 : 0; // melody → swaying
    const audioShimmer = a ? a.high * 0.35 : 0; // transients → glass iridescence

    // Buoyancy bob — micro-pressure gradients in the medium (§6.3)
    this.creature.position.y = organicNoise(t, [1.5, 2.37, 0.73]) * 0.01 * cues.hover_distance;

    // Brownian drift — the medium is not perfectly still (§6.3)
    const drift = cues.drift_amplitude + audioDrift;
    this.creature.position.x = organicNoise(t, [0.7, 1.13, 0.31]) * drift;
    this.creature.position.z = organicNoise(t, [0.5, 0.83, 0.23]) * drift * 0.25;

    // Breathing — asymmetric oblate/prolate oscillation via scale
    // Gravity deforms slowly, surface tension snaps back fast
    // Rate rises with glow (proxy for processing): calm ~2 Hz, thinking ~3.1 Hz
    const breatheRate = 2.0 + cues.glow_intensity * 1.5;
    const breatheRaw = Math.sin(t * breatheRate);
    const breathe =
      (breatheRaw > 0
        ? breatheRaw * 0.015
        : Math.sign(breatheRaw) * Math.pow(Math.abs(breatheRaw), 0.6) * 0.015) * audioBreathScale;

    // Gravity sag — slow cycle, weight pulls down, tension recovers
    const sagRaw = Math.sin(t * 0.32 * Math.PI * 2); // 0.32 Hz
    const sag =
      sagRaw > 0
        ? sagRaw * 0.032 // gravity pulls slowly
        : Math.sign(sagRaw) * Math.pow(Math.abs(sagRaw), 0.5) * 0.032; // tension snaps back
    this.creature.position.y += -sag * 0.01; // body dips under gravity

    // Bo > 0: gravity perturbs the sphere at rest (§2.2 — the signature of a body with weight)
    const REST_Y = 0.97;
    this.bodyMesh.scale.set(
      1.0 + breathe + sag * 0.15, // X: widens as Y compresses (volume conservation)
      REST_Y - breathe - sag * 0.3, // Y: oblate at rest, flattens further under sag
      1.0 + breathe + sag * 0.15, // Z: widens as Y compresses
    );

    // Trust mode visual modulation — glass clarity maps to trust level
    const trustThickness =
      this.trustMode === TrustMode.Full ? 0.18 : this.trustMode === TrustMode.Guarded ? 0.25 : 0.35;
    this.bodyMaterial.thickness = smoothDelta(this.bodyMaterial.thickness, trustThickness, dt, 2.0);

    // Attenuation color: user's soul color is the base; trust mode desaturates toward neutral
    const baseTint = this.interiorColor?.tint ?? [0.95, 0.95, 1.0];
    const trustDesaturation =
      this.trustMode === TrustMode.Full ? 0 : this.trustMode === TrustMode.Guarded ? 0.3 : 0.6;
    const tintTarget = new THREE.Color(
      baseTint[0] + (0.85 - baseTint[0]) * trustDesaturation,
      baseTint[1] + (0.85 - baseTint[1]) * trustDesaturation,
      baseTint[2] + (0.9 - baseTint[2]) * trustDesaturation,
    );
    this.bodyMaterial.attenuationColor.lerp(tintTarget, 1 - Math.exp(-2.0 * dt));

    // Interior luminosity — zero at rest, visible only during processing (§6.4)
    // computeRawCues produces glow ~0.4 at rest (0.3 base + confidence*0.2 with default confidence=0.5).
    // The 0.4 threshold ensures glass stays perfectly clear at rest. 0.6 multiplier makes thinking visible.
    // Minimal trust: suppress interior glow entirely
    const trustGlowScale = this.trustMode === TrustMode.Minimal ? 0 : 1;
    const baseGlowIntensity = this.interiorColor?.glowIntensity ?? 0;
    this.bodyMaterial.emissiveIntensity =
      Math.max(baseGlowIntensity, Math.max(0, cues.glow_intensity - 0.4) * 0.6 + audioGlow) *
      trustGlowScale;

    // Iridescence — high-frequency transients shimmer the glass surface
    // Active listening indicator: subtle ~1Hz oscillation (visual recording light)
    const listeningIridescence = this.listeningActive ? Math.sin(t * Math.PI * 2) * 0.08 : 0;
    this.bodyMaterial.iridescence = 0.4 + audioShimmer + listeningIridescence;

    // Eye-led expression — eyes are the dominant feature (Pixar principle)
    // Eyes carry emotion. The mouth confirms. The body whispers.
    if (this.leftEye && this.rightEye) {
      // Minimal trust: narrower eyes
      const trustEyeMax = this.trustMode === TrustMode.Minimal ? 0.2 : 0.4;
      const baseEyeScale = 0.8 + cues.eye_dilation * trustEyeMax;
      // Duchenne squint — genuine smile narrows the eyes
      const smileSquint = Math.max(0, cues.smile_curvature) * 0.8;
      const eyeScale = baseEyeScale - smileSquint;
      // Asymmetric curiosity: left eye opens wider (the "interested" eyebrow)
      const curiosityAsym = Math.max(0, cues.eye_dilation - 0.3) * 0.25;
      // Speaking micro-saccades — eyes search while talking, alive not dead
      const speakGaze =
        cues.speaking_activity > 0.01
          ? organicNoise(t, [1.1, 1.7, 2.3]) * cues.speaking_activity * 0.04
          : 0;
      // Speaking widening pulse — eyes open slightly when forming thoughts
      const speakWiden =
        cues.speaking_activity > 0.01
          ? (0.5 + 0.5 * organicNoise(t, [0.8, 1.3])) * cues.speaking_activity * 0.06
          : 0;
      // Blink — the breath of the face
      const blink = computeBlinkFactor(
        this.blinkState,
        t,
        cues.glow_intensity,
        cues.speaking_activity,
      );
      const leftScale = eyeScale + curiosityAsym + speakWiden;
      const rightScale = eyeScale + speakWiden;
      this.leftEye.scale.set(leftScale, leftScale * blink, leftScale);
      this.rightEye.scale.set(rightScale, rightScale * blink, rightScale);
      // Subtle forward lean of eyes during attention
      const eyeZ = 0.08 + Math.sin(t * 0.25) * 0.001;
      this.leftEye.position.z = eyeZ;
      this.rightEye.position.z = eyeZ;
      // Thinking lift — eyes drift upward when processing (looking for the answer)
      const thinkLift = Math.max(0, cues.glow_intensity - 0.4) * 0.06;
      // Speaking gaze wander — slight vertical drift while talking
      this.leftEye.position.y = 0.015 + thinkLift + speakGaze;
      this.rightEye.position.y = 0.015 + thinkLift + speakGaze * 0.7;
      // Horizontal micro-drift during speaking
      const speakHGaze =
        cues.speaking_activity > 0.01
          ? organicNoise(t, [0.9, 1.5]) * cues.speaking_activity * 0.003
          : 0;
      this.leftEye.position.x = -0.055 + speakHGaze;
      this.rightEye.position.x = 0.055 + speakHGaze;
    }

    // Smile — supports the eyes, doesn't steal the scene
    if (this.smileMesh) {
      const baseSmile = 0.6 + cues.smile_curvature * 3.0;
      // Soft speaking movement — a murmur, not a shout
      const speakOsc =
        cues.speaking_activity > 0.01
          ? organicNoise(t, [23.2, 27.0, 32.0]) * cues.speaking_activity * 0.12
          : 0;
      this.smileMesh.scale.y = baseSmile + speakOsc;
      this.smileMesh.scale.x = 1.0 + cues.speaking_activity * organicNoise(t, [18.2, 23.9]) * 0.05;
    }

    // Curiosity tilt — gentle head tilt when eye_dilation is high
    if (this.creature) {
      const tiltAmount = Math.max(0, cues.eye_dilation - 0.35) * 0.12;
      this.creature.rotation.z = organicNoise(t, [0.4, 0.67]) * tiltAmount;
    }

    // === Remote creatures — ambient animation, after the main creature ===
    // Skip headless entries (group is null). Transition completed → idle after 2s.
    for (const rc of this.remoteCreatures.values()) {
      if (!rc.group) continue;
      if (rc.activity === "completed" && rc.completedAt > 0 && t - rc.completedAt > 2.0) {
        rc.activity = "idle";
      }
      animateRemoteCreature(rc, t, dt);
    }

    // === Delegation lines — update arc geometry and pulse progress ===
    for (const dl of this.delegationLines.values()) {
      if (!dl.line) continue;
      const fromPos = this._resolveCreaturePosition(dl.fromId);
      const toPos = this._resolveCreaturePosition(dl.toId);
      animateDelegationLine(dl, t, dt, fromPos, toPos);
    }

    if (this.controls) this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  getSpec(): RenderSpec {
    return this.spec;
  }

  resize(width: number, height: number): void {
    if (this.camera) {
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    }
    if (this.renderer) {
      this.renderer.setSize(width, height, false);
    }
  }

  setBackground(color: number | null): void {
    if (this.scene) {
      this.scene.background = color === null ? null : new THREE.Color(color);
    }
  }

  setDarkEnvironment(): void {
    if (this.scene && this.renderer) {
      const darkEnv = createEnvironmentMap(this.renderer, ENV_DARK);
      this.scene.environment = darkEnv;
      this.scene.background = darkEnv;
    }
  }

  setLightEnvironment(): void {
    if (this.scene && this.renderer) {
      const lightEnv = createEnvironmentMap(this.renderer, ENV_LIGHT);
      this.scene.environment = lightEnv;
      this.scene.background = lightEnv;
    }
  }

  setInteriorColor(color: InteriorColor): void {
    this.interiorColor = color;
    if (this.bodyMaterial) {
      this.bodyMaterial.attenuationColor.setRGB(color.tint[0], color.tint[1], color.tint[2]);
      this.bodyMaterial.emissive.setRGB(color.glow[0], color.glow[1], color.glow[2]);
      this.bodyMaterial.emissiveIntensity = color.glowIntensity ?? 0.0;
      this.bodyMaterial.needsUpdate = true;
    }
  }

  setAudioReactivity(energy: AudioReactivity | null): void {
    this.audio = energy;
  }

  setTrustMode(mode: TrustMode): void {
    this.trustMode = mode;
  }

  setListeningIndicator(active: boolean): void {
    this.listeningActive = active;
  }

  enableOrbitControls(): void {
    if (!this.camera || !this.renderer) return;
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.target.set(0, -0.015, 0);
    this.controls.minDistance = 0.3;
    this.controls.maxDistance = 3.0;
    this.controls.update();
  }

  // === Multi-Creature API ===

  /**
   * Add a remote creature to the constellation.
   * Positions it based on trust score and derived hue from the ID.
   * No-op headless (no scene).
   */
  addRemoteCreature(id: string, opts: RemoteCreatureOpts): void {
    if (this.remoteCreatures.has(id)) return; // already tracked

    const hue = opts.hue ?? idToHue(id);
    const distance = trustToDistance(opts.trustScore);

    // Headless: track metadata without THREE objects
    if (!this.scene) {
      const state: RemoteCreatureState = {
        id,
        group: null,
        body: null,
        eyes: null,
        bodyMaterial: null,
        trustScore: opts.trustScore,
        activity: "idle",
        hue,
        phase: Math.random() * Math.PI * 2,
        completedAt: -1,
      };
      this.remoteCreatures.set(id, state);
      return;
    }

    const index = this.remoteCreatures.size;
    const total = index + 1;
    const pos = opts.position
      ? new THREE.Vector3(opts.position.x, opts.position.y, opts.position.z)
      : circlePosition(index, total, distance);

    const { group, body, eyes, bodyMaterial } = createRemoteCreature(hue);
    group.position.copy(pos);
    group.userData.basePosition = pos.clone();
    this.scene.add(group);

    const state: RemoteCreatureState = {
      id,
      group,
      body,
      eyes,
      bodyMaterial,
      trustScore: opts.trustScore,
      activity: "idle",
      hue,
      phase: Math.random() * Math.PI * 2,
      completedAt: -1,
    };

    this.remoteCreatures.set(id, state);
  }

  /**
   * Remove a remote creature from the constellation and dispose its Three.js objects.
   */
  removeRemoteCreature(id: string): void {
    const state = this.remoteCreatures.get(id);
    if (!state) return;

    if (this.scene && state.group) {
      const group = state.group as THREE.Group;
      this.scene.remove(group);
      group.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          if (obj.material instanceof THREE.Material) obj.material.dispose();
        }
      });
    }

    // Remove any delegation lines that reference this creature
    for (const [lineId, line] of this.delegationLines) {
      if (line.fromId === id || line.toId === id) {
        this.removeDelegationLine(lineId);
      }
    }

    this.remoteCreatures.delete(id);
  }

  /**
   * Update a remote creature's trust score (and derived position).
   * Updates state but does not teleport the creature — position smooths over time.
   */
  updateRemoteCreature(id: string, opts: Partial<RemoteCreatureOpts>): void {
    const state = this.remoteCreatures.get(id);
    if (!state) return;

    if (opts.trustScore !== undefined) {
      state.trustScore = opts.trustScore;
      const distance = trustToDistance(opts.trustScore);
      if (state.group && !opts.position) {
        // Reposition radially: preserve angle, update distance
        const group = state.group as THREE.Group;
        const current = group.position;
        const angle = Math.atan2(current.z, current.x);
        const newPos = new THREE.Vector3(
          Math.cos(angle) * distance,
          current.y,
          Math.sin(angle) * distance,
        );
        group.userData.basePosition = newPos.clone();
      }
    }

    if (opts.position) {
      if (state.group) {
        const group = state.group as THREE.Group;
        const pos = new THREE.Vector3(opts.position.x, opts.position.y, opts.position.z);
        group.userData.basePosition = pos.clone();
      }
    }

    if (opts.hue !== undefined) {
      state.hue = opts.hue;
    }
  }

  /**
   * Set the activity state of a remote creature.
   * Drives emissive animations on the next render tick.
   */
  setRemoteCreatureActivity(id: string, activity: RemoteCreatureActivity): void {
    const state = this.remoteCreatures.get(id);
    if (!state) return;
    if (activity === "completed") {
      state.completedAt = Date.now() / 1000; // approximate render time
    }
    state.activity = activity;
  }

  /**
   * Add a delegation arc between two agents.
   * `fromId` can be "self" (local creature) or a remote creature ID.
   * Returns the delegation line ID (for later removal).
   */
  addDelegationLine(fromId: string | "self", toId: string): string {
    const lineId = `dl-xr-${this.delegationLines.size}-${Date.now()}`;

    if (!this.scene) {
      // Headless: track state without THREE objects
      const state: DelegationLineState = {
        id: lineId,
        fromId,
        toId,
        line: null,
        geometry: null,
        material: null,
        pulseProgress: -1,
        pulseMesh: null,
      };
      this.delegationLines.set(lineId, state);
      return lineId;
    }

    // Resolve positions
    const fromPos = this._resolveCreaturePosition(fromId);
    const toPos = this._resolveCreaturePosition(toId);

    const { line, geometry, material } = createDelegationArc(this.scene, fromPos, toPos);
    const pulseMesh = createPulseMesh();
    this.scene.add(pulseMesh);

    const state: DelegationLineState = {
      id: lineId,
      fromId,
      toId,
      line,
      geometry,
      material,
      pulseProgress: -1,
      pulseMesh,
    };

    this.delegationLines.set(lineId, state);
    return lineId;
  }

  /**
   * Remove a delegation arc and dispose its Three.js objects.
   */
  removeDelegationLine(lineId: string): void {
    const state = this.delegationLines.get(lineId);
    if (!state) return;

    if (this.scene) {
      if (state.line) {
        const line = state.line as THREE.Line;
        this.scene.remove(line);
        const geo = state.geometry as THREE.BufferGeometry;
        const mat = state.material as THREE.LineBasicMaterial;
        geo.dispose();
        mat.dispose();
      }
      if (state.pulseMesh) {
        const pm = state.pulseMesh as THREE.Mesh;
        this.scene.remove(pm);
        pm.geometry.dispose();
        if (pm.material instanceof THREE.Material) pm.material.dispose();
      }
    }

    this.delegationLines.delete(lineId);
  }

  /**
   * Trigger a pulse on a delegation line (e.g., when a receipt is received).
   */
  pulseDelegationLine(lineId: string): void {
    const state = this.delegationLines.get(lineId);
    if (!state) return;
    state.pulseProgress = 0;
  }

  /** Access the remote creatures map (for testing). */
  getRemoteCreatures(): Map<string, RemoteCreatureState> {
    return this.remoteCreatures;
  }

  /** Access the delegation lines map (for testing). */
  getDelegationLines(): Map<string, DelegationLineState> {
    return this.delegationLines;
  }

  private _resolveCreaturePosition(id: string | "self"): THREE.Vector3 {
    if (id === "self") {
      return this.creature
        ? (this.creature as THREE.Group).position.clone()
        : new THREE.Vector3(0, 0, 0);
    }
    const state = this.remoteCreatures.get(id);
    if (state?.group) {
      return (state.group as THREE.Group).position.clone();
    }
    return new THREE.Vector3(0, 0, 0);
  }

  dispose(): void {
    // Dispose remote creatures and delegation lines first
    for (const id of Array.from(this.remoteCreatures.keys())) {
      this.removeRemoteCreature(id);
    }
    for (const id of Array.from(this.delegationLines.keys())) {
      this.removeDelegationLine(id);
    }

    if (this.creature) {
      this.creature.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          const mesh = obj as THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>;
          mesh.geometry.dispose();
          if (mesh.material instanceof THREE.Material) mesh.material.dispose();
        }
      });
    }
    this.creature = null;
    this.bodyMesh = null;
    this.bodyMaterial = null;
    this.leftEye = null;
    this.rightEye = null;
    this.smileMesh = null;

    if (this.scene?.environment) this.scene.environment.dispose();
    if (this.scene) {
      this.scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          const mesh = obj as THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>;
          mesh.geometry.dispose();
          if (mesh.material instanceof THREE.Material) mesh.material.dispose();
        }
      });
    }
    if (this.controls) {
      this.controls.dispose();
      this.controls = null;
    }
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer = null;
    }
    this.scene = null;
    this.camera = null;
    this.initialized = false;
  }
}

// === Spatial Adapter Stub ===

export class SpatialAdapter implements RenderAdapter {
  private spec: RenderSpec = CANONICAL_SPEC;
  init(_target: unknown): Promise<void> {
    return Promise.resolve();
  }
  render(_frame: RenderFrame): void {}
  getSpec(): RenderSpec {
    return this.spec;
  }
  resize(_width: number, _height: number): void {}
  setBackground(_color: number | null): void {}
  setDarkEnvironment(): void {}
  setLightEnvironment(): void {}
  setInteriorColor(_color: InteriorColor): void {}
  setAudioReactivity(_energy: AudioReactivity | null): void {}
  setTrustMode(_mode: TrustMode): void {}
  setListeningIndicator(_active: boolean): void {}
  dispose(): void {}
}

// === WebXR Three.js Adapter ===
// The glass creature in physical space. AR passthrough — no simulated sky.
// The real world IS Liquescentia. The camera feed provides the chromatic spectrum
// that the glass refracts. ENV_LIGHT is the fallback when XR light estimation
// is unavailable.
//
// Usage:
//   const adapter = new WebXRThreeJSAdapter();
//   await adapter.init(canvas);
//   const renderer = adapter.getRenderer()!;
//   renderer.setAnimationLoop((time) => {
//     adapter.render({ cues, delta_time: dt, time: time / 1000 });
//   });
//   await adapter.startSession(); // must be in a user gesture handler

export class WebXRThreeJSAdapter implements RenderAdapter {
  private spec: RenderSpec = CANONICAL_SPEC;
  private initialized = false;
  private currentCues: BehaviorCues = {
    hover_distance: 0.4,
    drift_amplitude: 0.02,
    glow_intensity: 0.3,
    eye_dilation: 0.3,
    smile_curvature: 0,
    speaking_activity: 0,
  };

  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;

  private creature: THREE.Group | null = null;
  private bodyMesh: THREE.Mesh | null = null;
  private bodyMaterial: THREE.MeshPhysicalMaterial | null = null;
  private leftEye: THREE.Group | null = null;
  private rightEye: THREE.Group | null = null;
  private smileMesh: THREE.Mesh | null = null;

  private basePosition = { x: 0, y: -0.2, z: -0.5 };
  private envMap: THREE.Texture | null = null;
  private audio: AudioReactivity | null = null;
  private trustMode: TrustMode = TrustMode.Full;
  private listeningActive = false;
  private interiorColor: InteriorColor | null = null;
  private blinkState: BlinkState = createBlinkState();

  // Remote creatures and delegation lines for agent network visualization
  private remoteCreatures = new Map<string, RemoteCreatureState>();
  private delegationLines = new Map<string, DelegationLineState>();

  /** Check if WebXR immersive-ar is available in this browser. */
  static async isSupported(): Promise<boolean> {
    if (typeof navigator === "undefined" || !navigator.xr) return false;
    try {
      return await navigator.xr.isSessionSupported("immersive-ar");
    } catch {
      return false;
    }
  }

  init(target: unknown): Promise<void> {
    if (typeof HTMLCanvasElement === "undefined" || !(target instanceof HTMLCanvasElement)) {
      this.initialized = true;
      return Promise.resolve();
    }

    const canvas = target;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.xr.enabled = true;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);

    this.scene = new THREE.Scene();
    // No background — AR passthrough. The real world IS Liquescentia.

    // Fallback environment map for glass refraction.
    // On platforms with XR light estimation, this could be replaced with camera-derived lighting.
    // Without it, ENV_LIGHT provides the spectral gradient the glass needs to be visible.
    this.envMap = createEnvironmentMap(this.renderer, ENV_LIGHT);
    this.scene.environment = this.envMap;

    // Camera managed by WebXR — position/orientation come from head tracking
    this.camera = new THREE.PerspectiveCamera(
      50,
      canvas.clientWidth / canvas.clientHeight,
      0.1,
      100,
    );

    // === Creature ===
    this.creature = new THREE.Group();
    this.scene.add(this.creature);

    const body = createBody();
    this.bodyMesh = body.mesh;
    this.bodyMaterial = body.material;
    this.creature.add(this.bodyMesh);

    this.leftEye = createEye();
    this.leftEye.position.set(-0.055, 0.015, 0.08);
    this.creature.add(this.leftEye);

    this.rightEye = createEye();
    this.rightEye.position.set(0.055, 0.015, 0.08);
    this.creature.add(this.rightEye);

    this.smileMesh = createSmile();
    this.smileMesh.position.set(0, -0.025, 0.09);
    this.creature.add(this.smileMesh);

    // === Lighting ===
    // Softer than desktop — the real environment provides ambient context.
    // These lights give the glass body enough definition to read in AR.
    this.scene.add(new THREE.AmbientLight(0x8090b0, 0.4));

    const key = new THREE.DirectionalLight(0xffeedd, 1.5);
    key.position.set(2, 3, 2);
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0xaabbee, 0.4);
    fill.position.set(-2, 1.5, -1);
    this.scene.add(fill);

    // Initial position: 0.5m in front of the user at shoulder height
    this.creature.position.set(this.basePosition.x, this.basePosition.y, this.basePosition.z);

    this.initialized = true;
    return Promise.resolve();
  }

  render(frame: RenderFrame): void {
    if (
      !this.initialized ||
      !this.creature ||
      !this.bodyMesh ||
      !this.bodyMaterial ||
      !this.renderer ||
      !this.scene ||
      !this.camera
    )
      return;

    const dt = frame.delta_time;
    const t = frame.time;

    this.currentCues = {
      hover_distance: smoothDelta(this.currentCues.hover_distance, frame.cues.hover_distance, dt),
      drift_amplitude: smoothDelta(
        this.currentCues.drift_amplitude,
        frame.cues.drift_amplitude,
        dt,
      ),
      glow_intensity: smoothDelta(this.currentCues.glow_intensity, frame.cues.glow_intensity, dt),
      eye_dilation: smoothDelta(this.currentCues.eye_dilation, frame.cues.eye_dilation, dt),
      smile_curvature: smoothDelta(
        this.currentCues.smile_curvature,
        frame.cues.smile_curvature,
        dt,
        8.0,
      ),
      speaking_activity: smoothDelta(
        this.currentCues.speaking_activity,
        frame.cues.speaking_activity,
        dt,
        12.0,
      ),
    };

    const cues = this.currentCues;
    const a = this.audio;

    // Audio reactivity — sound pressure modulates the creature's body language.
    // Additive: layers on top of behavior cues, not replacing them.
    const audioBreathScale = a ? 1 + a.rms * 2.5 : 1; // breathe bigger with sound energy
    const audioGlow = a ? a.low * 0.25 : 0; // bass → interior heat
    const audioDrift = a ? a.mid * 0.015 : 0; // melody → swaying
    const audioShimmer = a ? a.high * 0.35 : 0; // transients → glass iridescence

    // === Perturbations relative to base position ===
    // In AR, the creature has a world position (set by orbital dynamics or manual placement).
    // Bob, drift, and sag are small perturbations — the droplet suspended in a medium (§6.3).

    // Buoyancy bob — micro-pressure gradients in the medium
    const bobY = organicNoise(t, [1.5, 2.37, 0.73]) * 0.01 * cues.hover_distance;

    // Brownian drift — the medium is not perfectly still
    const drift = cues.drift_amplitude + audioDrift;
    const driftX = organicNoise(t, [0.7, 1.13, 0.31]) * drift;
    const driftZ = organicNoise(t, [0.5, 0.83, 0.23]) * drift * 0.25;

    // Gravity sag — slow cycle, weight pulls down, tension recovers
    const sagRaw = Math.sin(t * 0.32 * Math.PI * 2);
    const sag =
      sagRaw > 0 ? sagRaw * 0.032 : Math.sign(sagRaw) * Math.pow(Math.abs(sagRaw), 0.5) * 0.032;

    this.creature.position.set(
      this.basePosition.x + driftX,
      this.basePosition.y + bobY - sag * 0.01,
      this.basePosition.z + driftZ,
    );

    // Bo > 0: gravity perturbs the sphere at rest (§2.2)
    const REST_Y = 0.97;
    const breatheRate = 2.0 + cues.glow_intensity * 1.5;
    const breatheRaw = Math.sin(t * breatheRate);
    const breathe =
      (breatheRaw > 0
        ? breatheRaw * 0.015
        : Math.sign(breatheRaw) * Math.pow(Math.abs(breatheRaw), 0.6) * 0.015) * audioBreathScale;

    this.bodyMesh.scale.set(
      1.0 + breathe + sag * 0.15,
      REST_Y - breathe - sag * 0.3,
      1.0 + breathe + sag * 0.15,
    );

    // Trust mode visual modulation — glass clarity maps to trust level
    const trustThickness =
      this.trustMode === TrustMode.Full ? 0.18 : this.trustMode === TrustMode.Guarded ? 0.25 : 0.35;
    this.bodyMaterial.thickness = smoothDelta(this.bodyMaterial.thickness, trustThickness, dt, 2.0);

    // Attenuation color: user's soul color is the base; trust mode desaturates toward neutral
    const baseTint = this.interiorColor?.tint ?? [0.95, 0.95, 1.0];
    const trustDesaturation =
      this.trustMode === TrustMode.Full ? 0 : this.trustMode === TrustMode.Guarded ? 0.3 : 0.6;
    const tintTarget = new THREE.Color(
      baseTint[0] + (0.85 - baseTint[0]) * trustDesaturation,
      baseTint[1] + (0.85 - baseTint[1]) * trustDesaturation,
      baseTint[2] + (0.9 - baseTint[2]) * trustDesaturation,
    );
    this.bodyMaterial.attenuationColor.lerp(tintTarget, 1 - Math.exp(-2.0 * dt));

    // Interior luminosity — zero at rest, visible only during processing (§6.4)
    // Minimal trust: suppress interior glow entirely
    const trustGlowScale = this.trustMode === TrustMode.Minimal ? 0 : 1;
    const baseGlowIntensity = this.interiorColor?.glowIntensity ?? 0;
    this.bodyMaterial.emissiveIntensity =
      Math.max(baseGlowIntensity, Math.max(0, cues.glow_intensity - 0.4) * 0.6 + audioGlow) *
      trustGlowScale;

    // Iridescence — high-frequency transients shimmer the glass surface
    // Active listening indicator: subtle ~1Hz oscillation (visual recording light)
    const listeningIridescence = this.listeningActive ? Math.sin(t * Math.PI * 2) * 0.08 : 0;
    this.bodyMaterial.iridescence = 0.4 + audioShimmer + listeningIridescence;

    // Eye-led expression — eyes are the dominant feature (Pixar principle)
    // Eyes carry emotion. The mouth confirms. The body whispers.
    if (this.leftEye && this.rightEye) {
      // Minimal trust: narrower eyes
      const trustEyeMax = this.trustMode === TrustMode.Minimal ? 0.2 : 0.4;
      const baseEyeScale = 0.8 + cues.eye_dilation * trustEyeMax;
      // Duchenne squint — genuine smile narrows the eyes
      const smileSquint = Math.max(0, cues.smile_curvature) * 0.8;
      const eyeScale = baseEyeScale - smileSquint;
      // Asymmetric curiosity: left eye opens wider (the "interested" eyebrow)
      const curiosityAsym = Math.max(0, cues.eye_dilation - 0.3) * 0.25;
      // Speaking micro-saccades — eyes search while talking, alive not dead
      const speakGaze =
        cues.speaking_activity > 0.01
          ? organicNoise(t, [1.1, 1.7, 2.3]) * cues.speaking_activity * 0.04
          : 0;
      // Speaking widening pulse — eyes open slightly when forming thoughts
      const speakWiden =
        cues.speaking_activity > 0.01
          ? (0.5 + 0.5 * organicNoise(t, [0.8, 1.3])) * cues.speaking_activity * 0.06
          : 0;
      // Blink — the breath of the face
      const blink = computeBlinkFactor(
        this.blinkState,
        t,
        cues.glow_intensity,
        cues.speaking_activity,
      );
      const leftScale = eyeScale + curiosityAsym + speakWiden;
      const rightScale = eyeScale + speakWiden;
      this.leftEye.scale.set(leftScale, leftScale * blink, leftScale);
      this.rightEye.scale.set(rightScale, rightScale * blink, rightScale);
      // Subtle forward lean of eyes during attention
      const eyeZ = 0.08 + Math.sin(t * 0.25) * 0.001;
      this.leftEye.position.z = eyeZ;
      this.rightEye.position.z = eyeZ;
      // Thinking lift — eyes drift upward when processing (looking for the answer)
      const thinkLift = Math.max(0, cues.glow_intensity - 0.4) * 0.06;
      // Speaking gaze wander — slight vertical drift while talking
      this.leftEye.position.y = 0.015 + thinkLift + speakGaze;
      this.rightEye.position.y = 0.015 + thinkLift + speakGaze * 0.7;
      // Horizontal micro-drift during speaking
      const speakHGaze =
        cues.speaking_activity > 0.01
          ? organicNoise(t, [0.9, 1.5]) * cues.speaking_activity * 0.003
          : 0;
      this.leftEye.position.x = -0.055 + speakHGaze;
      this.rightEye.position.x = 0.055 + speakHGaze;
    }

    // Smile — supports the eyes, doesn't steal the scene
    if (this.smileMesh) {
      const baseSmile = 0.6 + cues.smile_curvature * 3.0;
      // Soft speaking movement — a murmur, not a shout
      const speakOsc =
        cues.speaking_activity > 0.01
          ? organicNoise(t, [23.2, 27.0, 32.0]) * cues.speaking_activity * 0.12
          : 0;
      this.smileMesh.scale.y = baseSmile + speakOsc;
      this.smileMesh.scale.x = 1.0 + cues.speaking_activity * organicNoise(t, [18.2, 23.9]) * 0.05;
    }

    // Curiosity tilt — gentle head tilt when eye_dilation is high
    if (this.creature) {
      const tiltAmount = Math.max(0, cues.eye_dilation - 0.35) * 0.12;
      this.creature.rotation.z = organicNoise(t, [0.4, 0.67]) * tiltAmount;
    }

    // Remote creatures — ambient animation
    for (const state of this.remoteCreatures.values()) {
      animateRemoteCreature(state, t, dt);
    }

    // Delegation lines — arc animation + pulse
    for (const state of this.delegationLines.values()) {
      const fromPos = this._resolveCreaturePosition(state.fromId);
      const toPos = this._resolveCreaturePosition(state.toId);
      animateDelegationLine(state, t, dt, fromPos, toPos);
    }

    this.renderer.render(this.scene, this.camera);
  }

  /** Set the creature's base position in world space (meters). */
  setCreatureWorldPosition(x: number, y: number, z: number): void {
    this.basePosition = { x, y, z };
    if (this.creature) {
      this.creature.position.set(x, y, z);
    }
  }

  /** Make the creature face toward a world-space point. */
  setCreatureLookAt(x: number, y: number, z: number): void {
    if (this.creature) {
      this.creature.lookAt(x, y, z);
    }
  }

  /** Access the renderer for setAnimationLoop(). */
  getRenderer(): THREE.WebGLRenderer | null {
    return this.renderer;
  }

  /** Whether a WebXR session is currently active. */
  isSessionActive(): boolean {
    return this.renderer?.xr.isPresenting ?? false;
  }

  /**
   * Request an immersive-ar WebXR session.
   * Must be called from a user gesture (click/tap) handler.
   */
  async startSession(options?: {
    requiredFeatures?: string[];
    optionalFeatures?: string[];
  }): Promise<boolean> {
    if (!this.renderer || typeof navigator === "undefined" || !navigator.xr) return false;

    try {
      const session = await navigator.xr.requestSession("immersive-ar", {
        requiredFeatures: options?.requiredFeatures ?? ["local-floor"],
        optionalFeatures: options?.optionalFeatures ?? ["hand-tracking", "light-estimation"],
      });
      await this.renderer.xr.setSession(session);
      return true;
    } catch {
      return false;
    }
  }

  /** End the current WebXR session. */
  async endSession(): Promise<void> {
    const session = this.renderer?.xr.getSession();
    if (session) {
      await session.end();
    }
  }

  getSpec(): RenderSpec {
    return this.spec;
  }

  resize(width: number, height: number): void {
    if (this.camera) {
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    }
    if (this.renderer) {
      this.renderer.setSize(width, height, false);
    }
  }

  setBackground(_color: number | null): void {
    // No-op in AR — passthrough is always active
  }

  setDarkEnvironment(): void {
    // In AR, the real world provides ambient light. The environment map is a fallback
    // for glass refraction. Switch to dark preset for dim environments.
    if (this.scene && this.renderer) {
      const darkEnv = createEnvironmentMap(this.renderer, ENV_DARK);
      if (this.envMap) this.envMap.dispose();
      this.envMap = darkEnv;
      this.scene.environment = darkEnv;
    }
  }

  setLightEnvironment(): void {
    if (this.scene && this.renderer) {
      const lightEnv = createEnvironmentMap(this.renderer, ENV_LIGHT);
      if (this.envMap) this.envMap.dispose();
      this.envMap = lightEnv;
      this.scene.environment = lightEnv;
    }
  }

  setInteriorColor(color: InteriorColor): void {
    this.interiorColor = color;
    if (this.bodyMaterial) {
      this.bodyMaterial.attenuationColor.setRGB(color.tint[0], color.tint[1], color.tint[2]);
      this.bodyMaterial.emissive.setRGB(color.glow[0], color.glow[1], color.glow[2]);
      this.bodyMaterial.emissiveIntensity = color.glowIntensity ?? 0.0;
      this.bodyMaterial.needsUpdate = true;
    }
  }

  setAudioReactivity(energy: AudioReactivity | null): void {
    this.audio = energy;
  }

  setTrustMode(mode: TrustMode): void {
    this.trustMode = mode;
  }

  setListeningIndicator(active: boolean): void {
    this.listeningActive = active;
  }

  // === Multi-Creature API (agent network visualization) ===

  addRemoteCreature(id: string, opts: RemoteCreatureOpts): void {
    if (this.remoteCreatures.has(id)) return;

    const hue = opts.hue ?? idToHue(id);
    const distance = trustToDistance(opts.trustScore);

    if (!this.scene) {
      this.remoteCreatures.set(id, {
        id,
        group: null,
        body: null,
        eyes: null,
        bodyMaterial: null,
        trustScore: opts.trustScore,
        activity: "idle",
        hue,
        phase: Math.random() * Math.PI * 2,
        completedAt: -1,
      });
      return;
    }

    const index = this.remoteCreatures.size;
    const total = index + 1;
    const pos = opts.position
      ? new THREE.Vector3(opts.position.x, opts.position.y, opts.position.z)
      : circlePosition(index, total, distance);

    const { group, body, eyes, bodyMaterial } = createRemoteCreature(hue);
    group.position.copy(pos);
    group.userData.basePosition = pos.clone();
    this.scene.add(group);

    this.remoteCreatures.set(id, {
      id,
      group,
      body,
      eyes,
      bodyMaterial,
      trustScore: opts.trustScore,
      activity: "idle",
      hue,
      phase: Math.random() * Math.PI * 2,
      completedAt: -1,
    });
  }

  removeRemoteCreature(id: string): void {
    const state = this.remoteCreatures.get(id);
    if (!state) return;

    if (this.scene && state.group) {
      const group = state.group as THREE.Group;
      this.scene.remove(group);
      group.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          if (obj.material instanceof THREE.Material) obj.material.dispose();
        }
      });
    }

    for (const [lineId, line] of this.delegationLines) {
      if (line.fromId === id || line.toId === id) {
        this.removeDelegationLine(lineId);
      }
    }

    this.remoteCreatures.delete(id);
  }

  updateRemoteCreature(id: string, opts: Partial<RemoteCreatureOpts>): void {
    const state = this.remoteCreatures.get(id);
    if (!state) return;

    if (opts.trustScore !== undefined) {
      state.trustScore = opts.trustScore;
      const distance = trustToDistance(opts.trustScore);
      if (state.group && !opts.position) {
        const group = state.group as THREE.Group;
        const current = group.position;
        const angle = Math.atan2(current.z, current.x);
        group.userData.basePosition = new THREE.Vector3(
          Math.cos(angle) * distance,
          current.y,
          Math.sin(angle) * distance,
        ).clone();
      }
    }

    if (opts.position && state.group) {
      const group = state.group as THREE.Group;
      group.userData.basePosition = new THREE.Vector3(
        opts.position.x,
        opts.position.y,
        opts.position.z,
      ).clone();
    }

    if (opts.hue !== undefined) state.hue = opts.hue;
  }

  setRemoteCreatureActivity(id: string, activity: RemoteCreatureActivity): void {
    const state = this.remoteCreatures.get(id);
    if (!state) return;
    if (activity === "completed") state.completedAt = Date.now() / 1000;
    state.activity = activity;
  }

  addDelegationLine(fromId: string | "self", toId: string): string {
    const lineId = `dl-xr-${this.delegationLines.size}-${Date.now()}`;

    if (!this.scene) {
      this.delegationLines.set(lineId, {
        id: lineId,
        fromId,
        toId,
        line: null,
        geometry: null,
        material: null,
        pulseProgress: -1,
        pulseMesh: null,
      });
      return lineId;
    }

    const fromPos = this._resolveCreaturePosition(fromId);
    const toPos = this._resolveCreaturePosition(toId);
    const { line, geometry, material } = createDelegationArc(this.scene, fromPos, toPos);
    const pulseMesh = createPulseMesh();
    this.scene.add(pulseMesh);

    this.delegationLines.set(lineId, {
      id: lineId,
      fromId,
      toId,
      line,
      geometry,
      material,
      pulseProgress: -1,
      pulseMesh,
    });
    return lineId;
  }

  removeDelegationLine(lineId: string): void {
    const state = this.delegationLines.get(lineId);
    if (!state) return;

    if (this.scene) {
      if (state.line) {
        this.scene.remove(state.line as THREE.Line);
        (state.geometry as THREE.BufferGeometry).dispose();
        (state.material as THREE.LineBasicMaterial).dispose();
      }
      if (state.pulseMesh) {
        const pm = state.pulseMesh as THREE.Mesh;
        this.scene.remove(pm);
        pm.geometry.dispose();
        if (pm.material instanceof THREE.Material) pm.material.dispose();
      }
    }

    this.delegationLines.delete(lineId);
  }

  pulseDelegationLine(lineId: string): void {
    const state = this.delegationLines.get(lineId);
    if (state) state.pulseProgress = 0;
  }

  getRemoteCreatures(): Map<string, RemoteCreatureState> {
    return this.remoteCreatures;
  }

  getDelegationLines(): Map<string, DelegationLineState> {
    return this.delegationLines;
  }

  private _resolveCreaturePosition(id: string | "self"): THREE.Vector3 {
    if (id === "self") {
      return this.creature
        ? (this.creature as THREE.Group).position.clone()
        : new THREE.Vector3(0, 0, 0);
    }
    const state = this.remoteCreatures.get(id);
    if (state?.group) {
      return (state.group as THREE.Group).position.clone();
    }
    return new THREE.Vector3(0, 0, 0);
  }

  dispose(): void {
    this.endSession().catch(() => {}); // Best-effort session cleanup

    // Dispose remote creatures
    for (const state of this.remoteCreatures.values()) {
      if (state.group) {
        const group = state.group as THREE.Group;
        group.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            obj.geometry.dispose();
            if (obj.material instanceof THREE.Material) obj.material.dispose();
          }
        });
      }
    }
    this.remoteCreatures.clear();

    // Dispose delegation lines
    for (const state of this.delegationLines.values()) {
      if (state.geometry) (state.geometry as THREE.BufferGeometry).dispose();
      if (state.material) (state.material as THREE.LineBasicMaterial).dispose();
      if (state.pulseMesh) {
        const pm = state.pulseMesh as THREE.Mesh;
        pm.geometry.dispose();
        if (pm.material instanceof THREE.Material) pm.material.dispose();
      }
    }
    this.delegationLines.clear();

    if (this.creature) {
      this.creature.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          const mesh = obj as THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>;
          mesh.geometry.dispose();
          if (mesh.material instanceof THREE.Material) mesh.material.dispose();
        }
      });
    }
    this.creature = null;
    this.bodyMesh = null;
    this.bodyMaterial = null;
    this.leftEye = null;
    this.rightEye = null;
    this.smileMesh = null;

    if (this.envMap) {
      this.envMap.dispose();
      this.envMap = null;
    }
    if (this.scene) {
      this.scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          const mesh = obj as THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>;
          mesh.geometry.dispose();
          if (mesh.material instanceof THREE.Material) mesh.material.dispose();
        }
      });
    }
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer = null;
    }
    this.scene = null;
    this.camera = null;
    this.initialized = false;
  }
}
