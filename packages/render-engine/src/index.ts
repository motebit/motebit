import * as THREE from "three";
import type { BehaviorCues, RenderSpec, GeometrySpec, MaterialSpec, LightingSpec } from "@motebit/sdk";

// === Canonical Render Spec ===
// This is the source of truth. All adapters must conform.

export const CANONICAL_GEOMETRY: GeometrySpec = {
  form: "droplet",
  lobe_count: 5,
  skirt_segments: 32,
  base_radius: 0.08,
  height: 0.12,
};

export const CANONICAL_MATERIAL: MaterialSpec = {
  ior: 1.35,
  subsurface: 0.05,
  roughness: 0.15,
  clearcoat: 0.8,
  surface_noise_amplitude: 0.002,
  base_color: [0.92, 0.95, 0.98],
  emissive_intensity: 0.1,
};

export const CANONICAL_LIGHTING: LightingSpec = {
  environment: "hdri",
  exposure: 1.0,
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
  delta_time: number; // seconds since last frame
  time: number; // total elapsed seconds
}

export interface RenderAdapter {
  /** Initialize the renderer with a target element/context */
  init(target: unknown): Promise<void>;
  /** Update the render with new behavior cues */
  render(frame: RenderFrame): void;
  /** Get the canonical spec this adapter conforms to */
  getSpec(): RenderSpec;
  /** Resize the renderer */
  resize(width: number, height: number): void;
  /** Clean up resources */
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
const N_DRIPS = 12;

// === Creature Part Builders ===

function createBody(): { mesh: THREE.Mesh; material: THREE.MeshPhysicalMaterial } {
  const geo = new THREE.SphereGeometry(BODY_R, 64, 48);
  geo.scale(1.0, 0.97, 1.0); // barely perceptible squish — nearly perfect sphere

  const mat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(0.92, 0.94, 0.99),
    transmission: 0.96,
    ior: 1.45,
    thickness: 0.4,
    roughness: 0.02,
    clearcoat: 1.0,
    clearcoatRoughness: 0.01,
    envMapIntensity: 1.5,
    emissive: new THREE.Color(0.6, 0.7, 0.9),
    emissiveIntensity: 0.03,
    transparent: true,
    side: THREE.FrontSide,
    attenuationColor: new THREE.Color(0.85, 0.88, 1.0),
    attenuationDistance: 0.5,
  });

  return { mesh: new THREE.Mesh(geo, mat), material: mat };
}

function createEye(): THREE.Group {
  const group = new THREE.Group();

  // Deep black polished obsidian eye — no metalness
  const eyeGeo = new THREE.SphereGeometry(EYE_R, 32, 32);
  const eyeMat = new THREE.MeshStandardMaterial({
    color: 0x080808,
    roughness: 0.05,
    metalness: 0.0,
  });
  group.add(new THREE.Mesh(eyeGeo, eyeMat));

  const catchMat = new THREE.MeshBasicMaterial({ color: 0xffffff });

  // Large catchlight — upper right
  const bigCatchGeo = new THREE.SphereGeometry(EYE_R * 0.22, 12, 12);
  const bigCatch = new THREE.Mesh(bigCatchGeo, catchMat);
  bigCatch.position.set(EYE_R * 0.28, EYE_R * 0.35, EYE_R * 0.7);
  group.add(bigCatch);

  // Small catchlight — lower left
  const smallCatchGeo = new THREE.SphereGeometry(EYE_R * 0.11, 8, 8);
  const smallCatch = new THREE.Mesh(smallCatchGeo, catchMat);
  smallCatch.position.set(-EYE_R * 0.22, -EYE_R * 0.15, EYE_R * 0.75);
  group.add(smallCatch);

  return group;
}

function createSmile(): THREE.Mesh {
  const curve = new THREE.QuadraticBezierCurve3(
    new THREE.Vector3(-0.028, 0, 0),
    new THREE.Vector3(0, -0.01, 0.002),
    new THREE.Vector3(0.028, 0, 0),
  );
  // Whisper-thin tube — just a surface mark
  const geo = new THREE.TubeGeometry(curve, 16, 0.0015, 4, false);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x1a1a1a,
    roughness: 0.3,
  });
  return new THREE.Mesh(geo, mat);
}

interface SkirtResult {
  group: THREE.Group;
  material: THREE.MeshPhysicalMaterial;
  drips: THREE.Mesh[];
  dripBasePositions: THREE.Vector3[];
}

function createSkirt(): SkirtResult {
  const group = new THREE.Group();
  const drips: THREE.Mesh[] = [];
  const dripBasePositions: THREE.Vector3[] = [];

  // Where the drip ring sits on the sphere
  // ~55 degrees below equator: y ≈ -0.085, ring radius ≈ 0.107
  const ringY = -BODY_R * 0.97 * 0.6; // about -0.082
  const ringR = Math.sqrt(BODY_R * BODY_R - (ringY / 0.97) * (ringY / 0.97)) * 0.95;

  // Glass material for skirt/drips — slightly denser than body
  const mat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(0.9, 0.93, 0.98),
    transmission: 0.88,
    ior: 1.4,
    thickness: 0.12,
    roughness: 0.04,
    clearcoat: 1.0,
    clearcoatRoughness: 0.02,
    transparent: true,
    attenuationColor: new THREE.Color(0.85, 0.88, 1.0),
    attenuationDistance: 0.25,
  });

  // Membrane ring — thin torus connecting the drips
  const membraneGeo = new THREE.TorusGeometry(ringR, 0.006, 8, N_DRIPS * 4);
  const membrane = new THREE.Mesh(membraneGeo, mat);
  membrane.position.y = ringY;
  membrane.rotation.x = Math.PI / 2; // lay flat
  membrane.scale.y = 0.4; // flatten into a thin band
  group.add(membrane);

  // Individual drip blobs — 12 rounded drops hanging from the membrane
  for (let i = 0; i < N_DRIPS; i++) {
    const angle = (i / N_DRIPS) * Math.PI * 2;

    // Deterministic organic variation (no Math.random)
    const sizeVar = 0.88 + 0.24 * Math.abs(Math.sin(i * 2.17));
    const lengthVar = 1.0 + 0.35 * Math.abs(Math.cos(i * 1.73));
    const dripR = 0.011 * sizeVar;

    const dripGeo = new THREE.SphereGeometry(dripR, 12, 10);
    dripGeo.scale(1.0, 1.35 * lengthVar, 1.0); // elongated teardrop

    const drip = new THREE.Mesh(dripGeo, mat);
    const x = Math.cos(angle) * ringR;
    const z = Math.sin(angle) * ringR;
    const y = ringY - 0.018 * lengthVar;

    const basePos = new THREE.Vector3(x, y, z);
    drip.position.copy(basePos);
    dripBasePositions.push(basePos.clone());
    drips.push(drip);
    group.add(drip);
  }

  return { group, material: mat, drips, dripBasePositions };
}

function createGround(): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(2, 2);
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0.9, 0.89, 0.92),
    roughness: 0.15,
    metalness: 0.05,
  });
  const plane = new THREE.Mesh(geo, mat);
  plane.rotation.x = -Math.PI / 2;
  plane.position.y = -0.25;
  return plane;
}

function createEnvironmentMap(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();

  // Bright studio enclosure — like product photography lightbox
  const bgGeo = new THREE.SphereGeometry(5, 32, 32);
  const bgMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(0.96, 0.94, 0.97), // very bright lavender-white
    side: THREE.BackSide,
  });
  envScene.add(new THREE.Mesh(bgGeo, bgMat));

  // Bright panels for strong glass reflections
  const panelGeo = new THREE.PlaneGeometry(3, 3);

  // Key panel — upper right (dominant highlight)
  const keyMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  const keyPanel = new THREE.Mesh(panelGeo, keyMat);
  keyPanel.position.set(2, 2.5, 1.5);
  keyPanel.lookAt(0, 0, 0);
  envScene.add(keyPanel);

  // Fill panel — upper left (warm)
  const fillMat = new THREE.MeshBasicMaterial({ color: 0xfff0e8, side: THREE.DoubleSide });
  const fillPanel = new THREE.Mesh(panelGeo, fillMat);
  fillPanel.position.set(-2, 2, -1);
  fillPanel.lookAt(0, 0, 0);
  envScene.add(fillPanel);

  // Bottom panel — soft reflection from below
  const bottomMat = new THREE.MeshBasicMaterial({ color: 0xeee8f2, side: THREE.DoubleSide });
  const bottomPanel = new THREE.Mesh(panelGeo, bottomMat);
  bottomPanel.position.set(0, -2, 0);
  bottomPanel.rotation.x = Math.PI / 2;
  envScene.add(bottomPanel);

  // Back panel — rim light
  const rimMat = new THREE.MeshBasicMaterial({ color: 0xf8f4ff, side: THREE.DoubleSide });
  const rimPanel = new THREE.Mesh(panelGeo, rimMat);
  rimPanel.position.set(0, 1, -3);
  rimPanel.lookAt(0, 0, 0);
  envScene.add(rimPanel);

  const envMap = pmrem.fromScene(envScene, 0, 0.1, 100).texture;

  // Cleanup
  bgGeo.dispose();
  bgMat.dispose();
  panelGeo.dispose();
  keyMat.dispose();
  fillMat.dispose();
  bottomMat.dispose();
  rimMat.dispose();
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
    skirt_deformation: 0,
  };

  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;

  // Creature parts
  private creature: THREE.Group | null = null;
  private bodyMesh: THREE.Mesh | null = null;
  private bodyMaterial: THREE.MeshPhysicalMaterial | null = null;
  private leftEye: THREE.Group | null = null;
  private rightEye: THREE.Group | null = null;
  private smileMesh: THREE.Mesh | null = null;
  private skirtGroup: THREE.Group | null = null;
  private drips: THREE.Mesh[] = [];
  private dripBasePositions: THREE.Vector3[] = [];

  async init(target: unknown): Promise<void> {
    // Guard: if target is not an HTMLCanvasElement, set initialized and return.
    // This preserves test compatibility when passing null.
    if (typeof HTMLCanvasElement === "undefined" || !(target instanceof HTMLCanvasElement)) {
      this.initialized = true;
      return;
    }

    const canvas = target;

    // Renderer
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
    });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);

    // Scene — soft near-white background
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xf5f0f8);

    // Environment map — bright studio for glass reflections
    const envMap = createEnvironmentMap(this.renderer);
    this.scene.environment = envMap;

    // Camera — framing the creature with room for hover + ground
    this.camera = new THREE.PerspectiveCamera(
      45,
      canvas.clientWidth / canvas.clientHeight,
      0.01,
      10,
    );
    this.camera.position.set(0, 0.02, 0.55);
    this.camera.lookAt(0, -0.02, 0);

    // === Build Creature ===
    this.creature = new THREE.Group();
    this.scene.add(this.creature);

    // Body — nearly perfect glass sphere
    const body = createBody();
    this.bodyMesh = body.mesh;
    this.bodyMaterial = body.material;
    this.creature.add(this.bodyMesh);

    // Eyes — big, dark, expressive
    this.leftEye = createEye();
    this.leftEye.position.set(-0.05, 0.015, 0.115);
    this.creature.add(this.leftEye);

    this.rightEye = createEye();
    this.rightEye.position.set(0.05, 0.015, 0.115);
    this.creature.add(this.rightEye);

    // Smile — whisper-thin arc
    this.smileMesh = createSmile();
    this.smileMesh.position.set(0, -0.03, 0.128);
    this.creature.add(this.smileMesh);

    // Skirt + drips — the melting bottom edge
    const skirt = createSkirt();
    this.skirtGroup = skirt.group;
    this.drips = skirt.drips;
    this.dripBasePositions = skirt.dripBasePositions;
    this.creature.add(this.skirtGroup);

    // === Ground plane — reflective surface below ===
    const ground = createGround();
    this.scene.add(ground);

    // === Lighting — bright, soft, studio-like ===
    const ambient = new THREE.AmbientLight(0xffffff, 0.8);
    this.scene.add(ambient);

    // Warm key light from upper-right
    const key = new THREE.DirectionalLight(0xfff8f0, 1.5);
    key.position.set(1.5, 2.5, 2);
    this.scene.add(key);

    // Cool fill from left
    const fill = new THREE.DirectionalLight(0xe8eeff, 0.5);
    fill.position.set(-2, 1, -1);
    this.scene.add(fill);

    // Subtle rim/back light
    const rim = new THREE.DirectionalLight(0xf4f0ff, 0.4);
    rim.position.set(0, 1, -2);
    this.scene.add(rim);

    // Bottom point light for ground glow
    const bottom = new THREE.PointLight(0xf0e8ff, 0.3, 2);
    bottom.position.set(0, -0.4, 0.2);
    this.scene.add(bottom);

    this.initialized = true;
  }

  render(frame: RenderFrame): void {
    if (!this.initialized) return;
    const dt = frame.delta_time;

    // Frame-independent smoothing
    this.currentCues = {
      hover_distance: smoothDelta(this.currentCues.hover_distance, frame.cues.hover_distance, dt),
      drift_amplitude: smoothDelta(this.currentCues.drift_amplitude, frame.cues.drift_amplitude, dt),
      glow_intensity: smoothDelta(this.currentCues.glow_intensity, frame.cues.glow_intensity, dt),
      eye_dilation: smoothDelta(this.currentCues.eye_dilation, frame.cues.eye_dilation, dt),
      smile_curvature: smoothDelta(this.currentCues.smile_curvature, frame.cues.smile_curvature, dt),
      skirt_deformation: smoothDelta(this.currentCues.skirt_deformation, frame.cues.skirt_deformation, dt),
    };

    if (this.creature && this.bodyMesh && this.bodyMaterial && this.renderer && this.scene && this.camera) {
      const t = frame.time;
      const cues = this.currentCues;

      // === Hover bob ===
      const hover = Math.sin(t * 1.5) * 0.01 * cues.hover_distance;
      this.creature.position.y = hover;

      // === Gentle drift ===
      const driftX = Math.sin(t * 0.7) * cues.drift_amplitude;
      const driftZ = Math.cos(t * 0.5) * cues.drift_amplitude * 0.25;
      this.creature.position.x = driftX;
      this.creature.position.z = driftZ;

      // === Body breathing — subtle scale pulse ===
      const breathe = 1 + Math.sin(t * 2.0) * 0.012;
      this.bodyMesh.scale.set(breathe, 0.97 * (2 - breathe), breathe);

      // === Glow ===
      this.bodyMaterial.emissiveIntensity = 0.02 + cues.glow_intensity * 0.12;

      // === Eye dilation ===
      if (this.leftEye && this.rightEye) {
        const eyeScale = 0.8 + cues.eye_dilation * 0.4;
        this.leftEye.scale.setScalar(eyeScale);
        this.rightEye.scale.setScalar(eyeScale);

        // Subtle eye drift — slightly alive
        const eyeZ = 0.115 + Math.sin(t * 0.25) * 0.0015;
        this.leftEye.position.z = eyeZ;
        this.rightEye.position.z = eyeZ;
      }

      // === Smile curvature ===
      // scale.y: positive = smile, 0 = flat line, negative = frown
      if (this.smileMesh) {
        this.smileMesh.scale.y = cues.smile_curvature;
      }

      // === Drip sway ===
      for (let i = 0; i < this.drips.length; i++) {
        const drip = this.drips[i]!;
        const basePos = this.dripBasePositions[i]!;
        const phase = (i * Math.PI * 2) / this.drips.length;
        const swayAmount = 0.006 * (1 + cues.skirt_deformation * 2.5);
        const sway = Math.sin(t * 1.0 + phase) * swayAmount;
        drip.position.x = basePos.x + sway;
        drip.rotation.z = sway * 3;
        drip.scale.y = 1 + cues.hover_distance * 0.1;
      }

      // === Very slow creature rotation ===
      this.creature.rotation.y += 0.05 * dt;

      // Render
      this.renderer.render(this.scene, this.camera);
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

  dispose(): void {
    if (this.creature) {
      this.creature.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          if (obj.material instanceof THREE.Material) {
            obj.material.dispose();
          }
        }
      });
      this.creature = null;
    }
    this.bodyMesh = null;
    this.bodyMaterial = null;
    this.leftEye = null;
    this.rightEye = null;
    this.smileMesh = null;
    this.skirtGroup = null;
    this.drips = [];
    this.dripBasePositions = [];

    if (this.scene?.environment) {
      this.scene.environment.dispose();
    }

    // Dispose ground plane
    if (this.scene) {
      this.scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh && obj !== this.bodyMesh) {
          obj.geometry.dispose();
          if (obj.material instanceof THREE.Material) {
            obj.material.dispose();
          }
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

// === Spatial Adapter Stub ===

export class SpatialAdapter implements RenderAdapter {
  private spec: RenderSpec = CANONICAL_SPEC;

  async init(_target: unknown): Promise<void> {
    // Unity/Unreal bridge — conforms to CANONICAL_SPEC
  }

  render(_frame: RenderFrame): void {
    // Send cues to native spatial runtime via bridge
  }

  getSpec(): RenderSpec {
    return this.spec;
  }

  resize(_width: number, _height: number): void {
    // Handled by spatial runtime
  }

  dispose(): void {
    // Cleanup bridge
  }
}
