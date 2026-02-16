import * as THREE from "three";
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
  emissive_intensity: 0.02,
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

export interface RenderAdapter {
  init(target: unknown): Promise<void>;
  render(frame: RenderFrame): void;
  getSpec(): RenderSpec;
  resize(width: number, height: number): void;
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
  // Rendering IOR 1.15: Three.js transmission approximates a solid glass lens;
  // at physical IOR 1.45 it over-magnifies interior geometry. 1.15 preserves the
  // visual read of "looking through glass" without grotesque distortion.
  const mat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(1.0, 1.0, 1.0),
    transmission: 0.98,
    ior: 1.15,
    thickness: 0.12,
    roughness: 0.0,
    clearcoat: 0.4,
    clearcoatRoughness: 0.02,
    envMapIntensity: 0.6,
    emissive: new THREE.Color(0.6, 0.7, 0.9), // §6.4 — processing heat visible through glass
    emissiveIntensity: 0.02,
    iridescence: 0.3,                         // Thin-film interference, not color — physics
    iridescenceIOR: 1.3,
    iridescenceThicknessRange: [100, 400],
    side: THREE.FrontSide,
    attenuationColor: new THREE.Color(0.9, 0.92, 1.0),
    attenuationDistance: 0.8,
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

function createEnvironmentMap(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();

  const skyGeo = new THREE.SphereGeometry(5, 64, 32);
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
        float y = normalize(vWorldPos).y;
        vec3 zenith = vec3(0.15, 0.25, 0.55);
        vec3 horizon = vec3(0.7, 0.5, 0.4);
        vec3 ground = vec3(0.12, 0.12, 0.18);
        vec3 color;
        if (y > 0.0) {
          color = mix(horizon, zenith, pow(y, 0.6));
        } else {
          color = mix(horizon * 0.5, ground, pow(-y, 0.4));
        }
        gl_FragColor = vec4(color, 1.0);
      }
    `,
  });
  envScene.add(new THREE.Mesh(skyGeo, skyMat));

  // Circle panels avoid square reflection artifacts on polished surfaces
  const sunMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.5, 2.2, 1.8), side: THREE.DoubleSide });
  const sunPanel = new THREE.Mesh(new THREE.CircleGeometry(0.85, 32), sunMat);
  sunPanel.position.set(3, 3, 2);
  sunPanel.lookAt(0, 0, 0);
  envScene.add(sunPanel);

  const fillMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.4, 0.5, 0.9), side: THREE.DoubleSide });
  const fillPanel = new THREE.Mesh(new THREE.CircleGeometry(1.1, 32), fillMat);
  fillPanel.position.set(-2.5, 2, -1);
  fillPanel.lookAt(0, 0, 0);
  envScene.add(fillPanel);

  const groundMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 0.25, 0.2), side: THREE.DoubleSide });
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

  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;

  private creature: THREE.Group | null = null;
  private bodyMesh: THREE.Mesh | null = null;
  private bodyMaterial: THREE.MeshPhysicalMaterial | null = null;
  private leftEye: THREE.Group | null = null;
  private rightEye: THREE.Group | null = null;
  private smileMesh: THREE.Mesh | null = null;

  async init(target: unknown): Promise<void> {
    if (typeof HTMLCanvasElement === "undefined" || !(target instanceof HTMLCanvasElement)) {
      this.initialized = true;
      return;
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

    // Buoyancy bob — micro-pressure gradients in the medium (§6.3)
    this.creature.position.y = organicNoise(t, [1.5, 2.37, 0.73]) * 0.01 * cues.hover_distance;

    // Brownian drift — the medium is not perfectly still (§6.3)
    this.creature.position.x = organicNoise(t, [0.7, 1.13, 0.31]) * cues.drift_amplitude;
    this.creature.position.z = organicNoise(t, [0.5, 0.83, 0.23]) * cues.drift_amplitude * 0.25;

    // Breathing — asymmetric oblate/prolate oscillation via scale
    // Gravity deforms slowly, surface tension snaps back fast
    const breatheRaw = Math.sin(t * 2.0);
    const breathe = breatheRaw > 0
      ? breatheRaw * 0.015
      : Math.sign(breatheRaw) * Math.pow(Math.abs(breatheRaw), 0.6) * 0.015;

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

    // Emissive glow
    this.bodyMaterial.emissiveIntensity = 0.02 + cues.glow_intensity * 0.12;

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

  dispose(): void {
    if (this.creature) {
      this.creature.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          if (obj.material instanceof THREE.Material) obj.material.dispose();
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
          obj.geometry.dispose();
          if (obj.material instanceof THREE.Material) obj.material.dispose();
        }
      });
    }
    if (this.renderer) { this.renderer.dispose(); this.renderer = null; }
    this.scene = null;
    this.camera = null;
    this.initialized = false;
  }
}

// === Spatial Adapter Stub ===

export class SpatialAdapter implements RenderAdapter {
  private spec: RenderSpec = CANONICAL_SPEC;
  async init(_target: unknown): Promise<void> {}
  render(_frame: RenderFrame): void {}
  getSpec(): RenderSpec { return this.spec; }
  resize(_width: number, _height: number): void {}
  dispose(): void {}
}
