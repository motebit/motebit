import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { BehaviorCues, RenderSpec, GeometrySpec, MaterialSpec, LightingSpec } from "@motebit/sdk";

// === Canonical Render Spec ===

export const CANONICAL_GEOMETRY: GeometrySpec = {
  form: "droplet",
  base_radius: 0.14,
  height: 0.12,
};

export const CANONICAL_MATERIAL: MaterialSpec = {
  ior: 1.15,                              // Rendering IOR — see §V for physical vs rendered
  subsurface: 0.05,
  roughness: 0.0,                         // Surface tension smooths to perfection at this scale
  clearcoat: 0.4,
  surface_noise_amplitude: 0.002,
  base_color: [1.0, 1.0, 1.0],
  emissive_intensity: 0.0,                // Zero at rest — glows only during processing
  tint: [0.9, 0.92, 1.0],                // Default: faint cool blue — borosilicate
};

export const CANONICAL_LIGHTING: LightingSpec = {
  environment: "hdri",
  exposure: 1.2,
  ambient_intensity: 0.4,
};

export const CANONICAL_SPEC: RenderSpec = {
  geometry: CANONICAL_GEOMETRY,
  material: CANONICAL_MATERIAL,
  lighting: CANONICAL_LIGHTING,
};

// === Render Adapter Interface ===

export interface RenderFrame {
  cues: BehaviorCues;
  delta_time: number;
  time: number;
}

export interface InteriorColor {
  tint: [number, number, number];
  glow: [number, number, number];
  glowIntensity?: number;
}

/** Normalized audio energy from mic or system audio. All values 0–1. */
export interface AudioReactivity {
  rms: number;
  low: number;
  mid: number;
  high: number;
}

export interface RenderAdapter {
  init(target: unknown): Promise<void>;
  render(frame: RenderFrame): void;
  getSpec(): RenderSpec;
  resize(width: number, height: number): void;
  setBackground(color: number | null): void;
  setDarkEnvironment(): void;
  setLightEnvironment(): void;
  setInteriorColor(color: InteriorColor): void;
  setAudioReactivity(energy: AudioReactivity | null): void;
  dispose(): void;
}

// === Frame-Independent Delta Smoothing ===

export function smoothDelta(
  current: number,
  target: number,
  deltaTime: number,
  smoothingFactor: number = 5.0,
): number {
  const t = 1 - Math.exp(-smoothingFactor * deltaTime);
  return current + (target - current) * t;
}

// === Constants ===

const BODY_R = 0.14;
const EYE_R = 0.035;

// === Organic Noise ===
// Sum of incommensurate sinusoids → quasi-periodic, non-repeating.
// Reads as "suspended in a medium" rather than "programmed oscillation."

function organicNoise(t: number, frequencies: number[]): number {
  let sum = 0;
  for (const f of frequencies) sum += Math.sin(t * f);
  return sum / frequencies.length;
}

// === Creature Builders ===

function createBody(): { mesh: THREE.Mesh; material: THREE.MeshPhysicalMaterial } {
  const geo = new THREE.SphereGeometry(BODY_R, 64, 48);

  // Material derived from MOTEBIT.md §V — glass is surface tension frozen in time
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
    emissive: new THREE.Color(0.6, 0.7, 0.9), // §6.4 — processing heat visible through glass
    emissiveIntensity: 0.0,                    // Zero at rest — only glows during processing
    iridescence: 0.4,                         // Thin-film interference — bumped for spectral env
    iridescenceIOR: 1.3,
    iridescenceThicknessRange: [100, 400],
    side: THREE.FrontSide,
    attenuationColor: new THREE.Color(tint[0], tint[1], tint[2]),
    attenuationDistance: BODY_R * 0.7,         // shorter distance = more visible tinting
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
  });
  group.add(new THREE.Mesh(eyeGeo, eyeMat));

  const catchMat = new THREE.MeshBasicMaterial({ color: 0xffffff });

  const bigCatchGeo = new THREE.SphereGeometry(EYE_R * 0.22, 16, 16);
  const bigCatch = new THREE.Mesh(bigCatchGeo, catchMat);
  bigCatch.position.set(EYE_R * 0.25, EYE_R * 0.3, EYE_R * 0.82);
  group.add(bigCatch);

  const smallCatchGeo = new THREE.SphereGeometry(EYE_R * 0.12, 16, 16);
  const smallCatch = new THREE.Mesh(smallCatchGeo, catchMat);
  smallCatch.position.set(-EYE_R * 0.2, -EYE_R * 0.15, EYE_R * 0.85);
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
  const mat = new THREE.MeshBasicMaterial({ color: 0x111111 });
  return new THREE.Mesh(geo, mat);
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
  zenith:      [0.22, 0.32, 0.72],   // saturated blue upper sky
  horizon:     [0.92, 0.62, 0.35],   // warm amber horizon — strong hue vs zenith
  ground:      [0.15, 0.14, 0.18],   // dark cool ground — contrast with bright horizon
  sun:         [6.0, 3.2, 0.8],      // deep amber-gold key — maximum chromatic identity
  fill:        [0.3, 0.5, 2.2],      // blue-violet fill — spectral opposite of sun
  groundPanel: [0.50, 0.32, 0.18],   // warm ground bounce
  warmTint:    [1.25, 0.94, 0.68],   // warm side: strong red boost, blue cut
  coolTint:    [0.68, 0.88, 1.30],   // cool side: strong blue boost, red cut
};

function createEnvironmentMap(renderer: THREE.WebGLRenderer, preset: EnvironmentPreset = ENV_DEFAULT): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();

  const skyGeo = new THREE.SphereGeometry(5, 64, 32);
  const z = preset.zenith, h = preset.horizon, g = preset.ground;
  const hasSpectral = preset.warmTint && preset.coolTint;
  const w = preset.warmTint ?? [1, 1, 1], c = preset.coolTint ?? [1, 1, 1];
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
        ${hasSpectral ? `
        // Spectral: horizontal warm-cool gradient around the azimuth.
        // The sky becomes a soft prism — warm on one side, cool on the other.
        // Glass refracts this gradient, making transmission visible.
        float azimuth = atan(dir.z, dir.x) / 3.14159; // -1 to 1
        float warmFactor = azimuth * 0.5 + 0.5;        // 0 (cool) to 1 (warm)
        vec3 warm = vec3(${w[0]}, ${w[1]}, ${w[2]});
        vec3 cool = vec3(${c[0]}, ${c[1]}, ${c[2]});
        color *= mix(cool, warm, warmFactor);
        ` : ''}
        gl_FragColor = vec4(color, 1.0);
      }
    `,
  });
  envScene.add(new THREE.Mesh(skyGeo, skyMat));

  // Circle panels avoid square reflection artifacts on polished surfaces
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

  const groundMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(...preset.groundPanel), side: THREE.DoubleSide });
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
  };
  private audio: AudioReactivity | null = null;

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

    this.camera = new THREE.PerspectiveCamera(45, canvas.clientWidth / canvas.clientHeight, 0.01, 10);
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
    if (!this.initialized || !this.creature || !this.bodyMesh || !this.bodyMaterial || !this.renderer || !this.scene || !this.camera) return;

    const dt = frame.delta_time;
    const t = frame.time;

    this.currentCues = {
      hover_distance: smoothDelta(this.currentCues.hover_distance, frame.cues.hover_distance, dt),
      drift_amplitude: smoothDelta(this.currentCues.drift_amplitude, frame.cues.drift_amplitude, dt),
      glow_intensity: smoothDelta(this.currentCues.glow_intensity, frame.cues.glow_intensity, dt),
      eye_dilation: smoothDelta(this.currentCues.eye_dilation, frame.cues.eye_dilation, dt),
      smile_curvature: smoothDelta(this.currentCues.smile_curvature, frame.cues.smile_curvature, dt),
    };

    const cues = this.currentCues;
    const a = this.audio;

    // Audio reactivity — sound pressure modulates the creature's body language.
    // Additive: layers on top of behavior cues, not replacing them.
    const audioBreathScale = a ? 1 + a.rms * 2.5 : 1;             // breathe bigger with sound energy
    const audioGlow = a ? a.low * 0.25 : 0;                       // bass → interior heat
    const audioDrift = a ? a.mid * 0.015 : 0;                     // melody → swaying
    const audioShimmer = a ? a.high * 0.35 : 0;                   // transients → glass iridescence

    // Buoyancy bob — micro-pressure gradients in the medium (§6.3)
    this.creature.position.y = organicNoise(t, [1.5, 2.37, 0.73]) * 0.01 * cues.hover_distance;

    // Brownian drift — the medium is not perfectly still (§6.3)
    const drift = cues.drift_amplitude + audioDrift;
    this.creature.position.x = organicNoise(t, [0.7, 1.13, 0.31]) * drift;
    this.creature.position.z = organicNoise(t, [0.5, 0.83, 0.23]) * drift * 0.25;

    // Breathing — asymmetric oblate/prolate oscillation via scale
    // Gravity deforms slowly, surface tension snaps back fast
    const breatheRaw = Math.sin(t * 2.0);
    const breathe = (breatheRaw > 0
      ? breatheRaw * 0.015
      : Math.sign(breatheRaw) * Math.pow(Math.abs(breatheRaw), 0.6) * 0.015) * audioBreathScale;

    // Gravity sag — slow cycle, weight pulls down, tension recovers
    const sagRaw = Math.sin(t * 0.32 * Math.PI * 2); // 0.32 Hz
    const sag = sagRaw > 0
      ? sagRaw * 0.032                                                    // gravity pulls slowly
      : Math.sign(sagRaw) * Math.pow(Math.abs(sagRaw), 0.5) * 0.032;     // tension snaps back
    this.creature.position.y += -sag * 0.01;  // body dips under gravity

    // Bo > 0: gravity perturbs the sphere at rest (§2.2 — the signature of a body with weight)
    const REST_Y = 0.97;
    this.bodyMesh.scale.set(
      1.0 + breathe + sag * 0.15,       // X: widens as Y compresses (volume conservation)
      REST_Y - breathe - sag * 0.3,     // Y: oblate at rest, flattens further under sag
      1.0 + breathe + sag * 0.15,       // Z: widens as Y compresses
    );

    // Interior luminosity — zero at rest, visible only during processing (§6.4)
    this.bodyMaterial.emissiveIntensity = Math.max(0, (cues.glow_intensity - 0.3) * 0.2 + audioGlow);

    // Iridescence — high-frequency transients shimmer the glass surface
    this.bodyMaterial.iridescence = 0.4 + audioShimmer;

    // Eye dilation
    if (this.leftEye && this.rightEye) {
      const eyeScale = 0.8 + cues.eye_dilation * 0.4;
      this.leftEye.scale.setScalar(eyeScale);
      this.rightEye.scale.setScalar(eyeScale);
      const eyeZ = 0.08 + Math.sin(t * 0.25) * 0.001;
      this.leftEye.position.z = eyeZ;
      this.rightEye.position.z = eyeZ;
    }

    // Smile
    if (this.smileMesh) {
      this.smileMesh.scale.y = cues.smile_curvature;
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

  dispose(): void {
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
    if (this.controls) { this.controls.dispose(); this.controls = null; }
    if (this.renderer) { this.renderer.dispose(); this.renderer = null; }
    this.scene = null;
    this.camera = null;
    this.initialized = false;
  }
}

// === Spatial Adapter Stub ===

export class SpatialAdapter implements RenderAdapter {
  private spec: RenderSpec = CANONICAL_SPEC;
  init(_target: unknown): Promise<void> { return Promise.resolve(); }
  render(_frame: RenderFrame): void {}
  getSpec(): RenderSpec { return this.spec; }
  resize(_width: number, _height: number): void {}
  setBackground(_color: number | null): void {}
  setDarkEnvironment(): void {}
  setLightEnvironment(): void {}
  setInteriorColor(_color: InteriorColor): void {}
  setAudioReactivity(_energy: AudioReactivity | null): void {}
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

  /** Check if WebXR immersive-ar is available in this browser. */
  static async isSupported(): Promise<boolean> {
    if (typeof navigator === "undefined" || !navigator.xr) return false;
    try {
      return await navigator.xr.isSessionSupported("immersive-ar");
    } catch {
      return false;
    }
  }

  async init(target: unknown): Promise<void> {
    if (typeof HTMLCanvasElement === "undefined" || !(target instanceof HTMLCanvasElement)) {
      this.initialized = true;
      return;
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
    this.camera = new THREE.PerspectiveCamera(50, canvas.clientWidth / canvas.clientHeight, 0.01, 100);

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
  }

  render(frame: RenderFrame): void {
    if (!this.initialized || !this.creature || !this.bodyMesh || !this.bodyMaterial || !this.renderer || !this.scene || !this.camera) return;

    const dt = frame.delta_time;
    const t = frame.time;

    this.currentCues = {
      hover_distance: smoothDelta(this.currentCues.hover_distance, frame.cues.hover_distance, dt),
      drift_amplitude: smoothDelta(this.currentCues.drift_amplitude, frame.cues.drift_amplitude, dt),
      glow_intensity: smoothDelta(this.currentCues.glow_intensity, frame.cues.glow_intensity, dt),
      eye_dilation: smoothDelta(this.currentCues.eye_dilation, frame.cues.eye_dilation, dt),
      smile_curvature: smoothDelta(this.currentCues.smile_curvature, frame.cues.smile_curvature, dt),
    };

    const cues = this.currentCues;

    // === Perturbations relative to base position ===
    // In AR, the creature has a world position (set by orbital dynamics or manual placement).
    // Bob, drift, and sag are small perturbations — the droplet suspended in a medium (§6.3).

    // Buoyancy bob — micro-pressure gradients in the medium
    const bobY = organicNoise(t, [1.5, 2.37, 0.73]) * 0.01 * cues.hover_distance;

    // Brownian drift — the medium is not perfectly still
    const driftX = organicNoise(t, [0.7, 1.13, 0.31]) * cues.drift_amplitude;
    const driftZ = organicNoise(t, [0.5, 0.83, 0.23]) * cues.drift_amplitude * 0.25;

    // Gravity sag — slow cycle, weight pulls down, tension recovers
    const sagRaw = Math.sin(t * 0.32 * Math.PI * 2);
    const sag = sagRaw > 0
      ? sagRaw * 0.032
      : Math.sign(sagRaw) * Math.pow(Math.abs(sagRaw), 0.5) * 0.032;

    this.creature.position.set(
      this.basePosition.x + driftX,
      this.basePosition.y + bobY - sag * 0.01,
      this.basePosition.z + driftZ,
    );

    // Bo > 0: gravity perturbs the sphere at rest (§2.2)
    const REST_Y = 0.97;
    const breatheRaw = Math.sin(t * 2.0);
    const breathe = breatheRaw > 0
      ? breatheRaw * 0.015
      : Math.sign(breatheRaw) * Math.pow(Math.abs(breatheRaw), 0.6) * 0.015;

    this.bodyMesh.scale.set(
      1.0 + breathe + sag * 0.15,
      REST_Y - breathe - sag * 0.3,
      1.0 + breathe + sag * 0.15,
    );

    // Interior luminosity — zero at rest, visible only during processing (§6.4)
    this.bodyMaterial.emissiveIntensity = Math.max(0, (cues.glow_intensity - 0.3) * 0.2);

    // Eye dilation
    if (this.leftEye && this.rightEye) {
      const eyeScale = 0.8 + cues.eye_dilation * 0.4;
      this.leftEye.scale.setScalar(eyeScale);
      this.rightEye.scale.setScalar(eyeScale);
      const eyeZ = 0.08 + Math.sin(t * 0.25) * 0.001;
      this.leftEye.position.z = eyeZ;
      this.rightEye.position.z = eyeZ;
    }

    // Smile
    if (this.smileMesh) {
      this.smileMesh.scale.y = cues.smile_curvature;
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
    if (this.bodyMaterial) {
      this.bodyMaterial.attenuationColor.setRGB(color.tint[0], color.tint[1], color.tint[2]);
      this.bodyMaterial.emissive.setRGB(color.glow[0], color.glow[1], color.glow[2]);
      this.bodyMaterial.emissiveIntensity = color.glowIntensity ?? 0.0;
      this.bodyMaterial.needsUpdate = true;
    }
  }

  setAudioReactivity(_energy: AudioReactivity | null): void {
    // TODO: apply audio modulation to WebXR creature
  }

  dispose(): void {
    this.endSession().catch(() => {}); // Best-effort session cleanup

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

    if (this.envMap) { this.envMap.dispose(); this.envMap = null; }
    if (this.scene) {
      this.scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          const mesh = obj as THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>;
          mesh.geometry.dispose();
          if (mesh.material instanceof THREE.Material) mesh.material.dispose();
        }
      });
    }
    if (this.renderer) { this.renderer.dispose(); this.renderer = null; }
    this.scene = null;
    this.camera = null;
    this.initialized = false;
  }
}
