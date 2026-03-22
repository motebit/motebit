/**
 * The Motebit creature — single source of truth.
 *
 * One motebit. Change it here, it updates everywhere:
 * desktop, web, mobile, spatial.
 *
 * Geometry, glass material, environment, and the full animation loop
 * live in this file. Platform adapters call createCreature() once
 * and animateCreature() every frame. Everything else is platform concern.
 */

import * as THREE from "three";
import { TrustMode, type BehaviorCues } from "@motebit/sdk";
import { CANONICAL_MATERIAL, smoothDelta } from "./spec.js";
import type { RenderFrame, InteriorColor, AudioReactivity } from "./spec.js";

// === Constants ===

export const BODY_R = 0.14;
export const EYE_R = 0.035;

// === Organic Noise ===
// Sum of incommensurate sinusoids → quasi-periodic, non-repeating.
// Reads as "suspended in a medium" rather than "programmed oscillation."

export function organicNoise(t: number, frequencies: number[]): number {
  let sum = 0;
  for (const f of frequencies) sum += Math.sin(t * f);
  return sum / frequencies.length;
}

// === Blink ===
// Natural blinking: fast close, slow open, random intervals, occasional doubles.
// No new geometry — the eye group squashes on Y. The glass magnification
// makes the blink dramatic from the front, subtle from the side.

export interface BlinkState {
  nextBlinkAt: number;
  blinkStart: number;
  doubleBlink: boolean;
  secondBlinkPending: boolean;
}

const BLINK_CLOSE = 0.08;
const BLINK_HOLD = 0.04;
const BLINK_OPEN = 0.13;
const BLINK_TOTAL = BLINK_CLOSE + BLINK_HOLD + BLINK_OPEN;
const BLINK_MIN = 2.5;
const BLINK_MAX = 6.0;
const DOUBLE_CHANCE = 0.15;
const DOUBLE_GAP = 0.18;

export function createBlinkState(): BlinkState {
  return {
    nextBlinkAt: 1.0 + Math.random() * 3.0,
    blinkStart: -1,
    doubleBlink: false,
    secondBlinkPending: false,
  };
}

export function computeBlinkFactor(
  state: BlinkState,
  time: number,
  glow: number,
  speaking: number,
): number {
  if (state.blinkStart < 0) {
    if (time >= state.nextBlinkAt) {
      state.blinkStart = time;
    } else {
      return 1.0;
    }
  }

  const elapsed = time - state.blinkStart;

  if (elapsed < BLINK_CLOSE) {
    const t = elapsed / BLINK_CLOSE;
    return 1.0 - (1 - (1 - t) * (1 - t)) * 0.95;
  }

  if (elapsed < BLINK_CLOSE + BLINK_HOLD) {
    return 0.05;
  }

  if (elapsed < BLINK_TOTAL) {
    const t = (elapsed - BLINK_CLOSE - BLINK_HOLD) / BLINK_OPEN;
    return 0.05 + t * t * 0.95;
  }

  state.blinkStart = -1;

  if (state.doubleBlink && !state.secondBlinkPending) {
    state.secondBlinkPending = true;
    state.nextBlinkAt = time + DOUBLE_GAP;
    state.doubleBlink = false;
    return 1.0;
  }

  const thinkStretch = glow > 0.4 ? 1.5 : 1.0;
  const speakShrink = speaking > 0.01 ? 0.7 : 1.0;
  const interval =
    (BLINK_MIN + Math.random() * (BLINK_MAX - BLINK_MIN)) * thinkStretch * speakShrink;
  state.nextBlinkAt = time + interval;
  state.doubleBlink = Math.random() < DOUBLE_CHANCE;
  state.secondBlinkPending = false;
  return 1.0;
}

// === Environment ===

export interface EnvironmentPreset {
  zenith: [number, number, number];
  horizon: [number, number, number];
  ground: [number, number, number];
  sun: [number, number, number];
  fill: [number, number, number];
  groundPanel: [number, number, number];
  warmTint?: [number, number, number];
  coolTint?: [number, number, number];
}

export const ENV_DEFAULT: EnvironmentPreset = {
  zenith: [0.15, 0.25, 0.55],
  horizon: [0.7, 0.5, 0.4],
  ground: [0.12, 0.12, 0.18],
  sun: [2.5, 2.2, 1.8],
  fill: [0.4, 0.5, 0.9],
  groundPanel: [0.3, 0.25, 0.2],
};

export const ENV_DARK: EnvironmentPreset = {
  zenith: [0.02, 0.02, 0.04],
  horizon: [0.04, 0.03, 0.03],
  ground: [0.02, 0.02, 0.02],
  sun: [2.0, 1.8, 1.5],
  fill: [0.3, 0.4, 0.8],
  groundPanel: [0.08, 0.06, 0.05],
};

export const ENV_LIGHT: EnvironmentPreset = {
  zenith: [0.22, 0.32, 0.72],
  horizon: [0.92, 0.62, 0.35],
  ground: [0.15, 0.14, 0.18],
  sun: [6.0, 3.2, 0.8],
  fill: [0.3, 0.5, 2.2],
  groundPanel: [0.5, 0.32, 0.18],
  warmTint: [1.25, 0.94, 0.68],
  coolTint: [0.68, 0.88, 1.3],
};

export function createEnvironmentMap(
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
        float azimuth = atan(dir.z, dir.x) / 3.14159;
        float warmFactor = azimuth * 0.5 + 0.5;
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

// === Creature Geometry ===

export interface CreatureRefs {
  group: THREE.Group;
  bodyMesh: THREE.Mesh;
  bodyMaterial: THREE.MeshPhysicalMaterial;
  leftEye: THREE.Group;
  rightEye: THREE.Group;
  smileMesh: THREE.Mesh;
}

function createBody(): { mesh: THREE.Mesh; material: THREE.MeshPhysicalMaterial } {
  const geo = new THREE.SphereGeometry(BODY_R, 64, 48);
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

/**
 * Build the complete creature and attach it to a parent group.
 * Returns refs the adapter stores for animateCreature().
 */
export function createCreature(parent: THREE.Group | THREE.Scene): CreatureRefs {
  const group = new THREE.Group();
  parent.add(group);

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

  return {
    group,
    bodyMesh: body.mesh,
    bodyMaterial: body.material,
    leftEye,
    rightEye,
    smileMesh,
  };
}

// === Animation ===

export interface CreatureState {
  blinkState: BlinkState;
  smoothedCues: BehaviorCues;
  trustMode: TrustMode;
  listeningActive: boolean;
  interiorColor: InteriorColor | null;
  audio: AudioReactivity | null;
  /** Base world position — drift/bob/sag are offsets from this. Default: origin. */
  basePosition: { x: number; y: number; z: number };
}

export function createCreatureState(): CreatureState {
  return {
    blinkState: createBlinkState(),
    smoothedCues: {
      hover_distance: 0.4,
      drift_amplitude: 0.02,
      glow_intensity: 0.3,
      eye_dilation: 0.3,
      smile_curvature: 0,
      speaking_activity: 0,
    },
    trustMode: TrustMode.Full,
    listeningActive: false,
    interiorColor: null,
    audio: null,
    basePosition: { x: 0, y: 0, z: 0 },
  };
}

/**
 * Animate the creature for one frame.
 *
 * Pure render logic — no I/O, no platform concerns.
 * Every visual surface calls this with the same inputs
 * and gets the same motebit.
 */
export function animateCreature(
  refs: CreatureRefs,
  state: CreatureState,
  frame: RenderFrame,
): void {
  const dt = frame.delta_time;
  const t = frame.time;

  // Smooth cues — per-frame EMA for 60 FPS rendering
  state.smoothedCues = {
    hover_distance: smoothDelta(state.smoothedCues.hover_distance, frame.cues.hover_distance, dt),
    drift_amplitude: smoothDelta(
      state.smoothedCues.drift_amplitude,
      frame.cues.drift_amplitude,
      dt,
    ),
    glow_intensity: smoothDelta(state.smoothedCues.glow_intensity, frame.cues.glow_intensity, dt),
    eye_dilation: smoothDelta(state.smoothedCues.eye_dilation, frame.cues.eye_dilation, dt),
    smile_curvature: smoothDelta(
      state.smoothedCues.smile_curvature,
      frame.cues.smile_curvature,
      dt,
      8.0,
    ),
    speaking_activity: smoothDelta(
      state.smoothedCues.speaking_activity,
      frame.cues.speaking_activity,
      dt,
      12.0,
    ),
  };

  const cues = state.smoothedCues;
  const a = state.audio;

  // Audio reactivity — sound pressure modulates the creature's body language.
  const audioBreathScale = a ? 1 + a.rms * 2.5 : 1;
  const audioGlow = a ? a.low * 0.25 : 0;
  const audioDrift = a ? a.mid * 0.015 : 0;
  const audioShimmer = a ? a.high * 0.35 : 0;

  // Buoyancy bob — micro-pressure gradients in the medium
  const bp = state.basePosition;
  const bobY = organicNoise(t, [1.5, 2.37, 0.73]) * 0.01;

  // Brownian drift
  const drift = cues.drift_amplitude + audioDrift;
  const driftX = organicNoise(t, [0.7, 1.13, 0.31]) * drift;
  const driftZ = organicNoise(t, [0.5, 0.83, 0.23]) * drift * 0.25;

  // Breathing — Rayleigh eigenmode of a liquid sphere at the motebit's mass and radius.
  // ω² = n(n-1)(n+2)σ/ρR³ → ~0.3 Hz for borosilicate glass at body scale.
  // The eigenfrequency is physical, not a design choice. Processing state modulates
  // amplitude, not frequency — a hotter droplet oscillates more, not faster.
  const BREATHE_FREQ = 0.3;
  const breatheAmplitude = (0.012 + cues.glow_intensity * 0.008) * audioBreathScale;
  const breatheRaw = Math.sin(t * BREATHE_FREQ * Math.PI * 2);
  const breathe =
    breatheRaw > 0
      ? breatheRaw * breatheAmplitude
      : Math.sign(breatheRaw) * Math.pow(Math.abs(breatheRaw), 0.6) * breatheAmplitude;

  // Gravity sag — slow cycle, weight pulls down, tension recovers
  const sagRaw = Math.sin(t * 0.32 * Math.PI * 2);
  const sag =
    sagRaw > 0 ? sagRaw * 0.032 : Math.sign(sagRaw) * Math.pow(Math.abs(sagRaw), 0.5) * 0.032;

  // Position = base + perturbations (bob, drift, sag)
  refs.group.position.set(bp.x + driftX, bp.y + bobY - sag * 0.01, bp.z + driftZ);

  // Bo > 0: gravity perturbs the sphere at rest
  const REST_Y = 0.97;
  refs.bodyMesh.scale.set(
    1.0 + breathe + sag * 0.15,
    REST_Y - breathe - sag * 0.3,
    1.0 + breathe + sag * 0.15,
  );

  // Trust mode visual modulation — glass clarity maps to trust level
  const trustThickness =
    state.trustMode === TrustMode.Full ? 0.18 : state.trustMode === TrustMode.Guarded ? 0.25 : 0.35;
  refs.bodyMaterial.thickness = smoothDelta(refs.bodyMaterial.thickness, trustThickness, dt, 2.0);

  // Attenuation color: soul color base; trust mode desaturates toward neutral
  const baseTint = state.interiorColor?.tint ?? [0.95, 0.95, 1.0];
  const trustDesaturation =
    state.trustMode === TrustMode.Full ? 0 : state.trustMode === TrustMode.Guarded ? 0.3 : 0.6;
  const tintTarget = new THREE.Color(
    baseTint[0] + (0.85 - baseTint[0]) * trustDesaturation,
    baseTint[1] + (0.85 - baseTint[1]) * trustDesaturation,
    baseTint[2] + (0.9 - baseTint[2]) * trustDesaturation,
  );
  refs.bodyMaterial.attenuationColor.lerp(tintTarget, 1 - Math.exp(-2.0 * dt));

  // Interior luminosity — zero at rest, visible only during processing
  // Minimal trust: suppress interior glow entirely
  const trustGlowScale = state.trustMode === TrustMode.Minimal ? 0 : 1;
  const baseGlowIntensity = state.interiorColor?.glowIntensity ?? 0;
  refs.bodyMaterial.emissiveIntensity =
    Math.max(baseGlowIntensity, Math.max(0, cues.glow_intensity - 0.4) * 0.6 + audioGlow) *
    trustGlowScale;

  // Iridescence — transients shimmer the glass surface
  // Active listening: subtle ~1Hz oscillation (visual recording light)
  const listeningIridescence = state.listeningActive ? Math.sin(t * Math.PI * 2) * 0.08 : 0;
  refs.bodyMaterial.iridescence = 0.4 + audioShimmer + listeningIridescence;

  // Eyes — interior structures visible through glass. Calm, steady, present.
  // No jittering, no darting. A droplet's interior doesn't fidget.
  {
    const trustEyeMax = state.trustMode === TrustMode.Minimal ? 0.2 : 0.4;
    const baseEyeScale = 0.8 + cues.eye_dilation * trustEyeMax;
    const smileSquint = Math.max(0, cues.smile_curvature) * 0.3;
    const eyeScale = baseEyeScale - smileSquint;
    const blink = computeBlinkFactor(
      state.blinkState,
      t,
      cues.glow_intensity,
      cues.speaking_activity,
    );
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

  // Smile — supports the eyes, doesn't steal the scene
  {
    const baseSmile = 0.6 + cues.smile_curvature * 3.0;
    const speakOsc =
      cues.speaking_activity > 0.01
        ? organicNoise(t, [23.2, 27.0, 32.0]) * cues.speaking_activity * 0.12
        : 0;
    refs.smileMesh.scale.y = baseSmile + speakOsc;
    refs.smileMesh.scale.x = 1.0 + cues.speaking_activity * organicNoise(t, [18.2, 23.9]) * 0.05;
  }

  // Curiosity tilt — gentle head tilt when eye_dilation is high
  {
    const tiltAmount = Math.max(0, cues.eye_dilation - 0.35) * 0.12;
    refs.group.rotation.z = organicNoise(t, [0.4, 0.67]) * tiltAmount;
  }
}

/**
 * Dispose all creature geometry and materials.
 */
export function disposeCreature(refs: CreatureRefs): void {
  refs.bodyMesh.geometry.dispose();
  refs.bodyMaterial.dispose();

  const disposeMeshes = (group: THREE.Group) => {
    group.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Three.js Mesh.geometry types
        child.geometry.dispose();
        if (child.material instanceof THREE.Material) child.material.dispose();
      }
    });
  };

  disposeMeshes(refs.leftEye);
  disposeMeshes(refs.rightEye);
  refs.smileMesh.geometry.dispose();
  if (refs.smileMesh.material instanceof THREE.Material) refs.smileMesh.material.dispose();
}
