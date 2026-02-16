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

// === Creature Part Builders ===

function createBody(): { mesh: THREE.Mesh; material: THREE.MeshPhysicalMaterial; basePositions: Float32Array } {
  const geo = new THREE.SphereGeometry(BODY_R, 64, 48);
  geo.scale(1.0, 0.97, 1.0); // barely perceptible squish — nearly perfect sphere

  const mat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(1.0, 1.0, 1.0),
    transmission: 0.98,
    ior: 1.15,
    thickness: 0.12,
    roughness: 0.0,
    clearcoat: 0.4,
    clearcoatRoughness: 0.02,
    envMapIntensity: 0.6,
    iridescence: 0.4,
    iridescenceIOR: 1.3,
    iridescenceThicknessRange: [100, 400],
    side: THREE.FrontSide,
    attenuationColor: new THREE.Color(0.9, 0.92, 1.0),
    attenuationDistance: 0.8,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 2;

  // Snapshot base positions for per-frame gravity sag animation
  const basePositions = new Float32Array(
    (geo.getAttribute("position") as THREE.BufferAttribute).array,
  );

  return { mesh, material: mat, basePositions };
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
  const bigCatchGeo = new THREE.SphereGeometry(EYE_R * 0.22, 16, 16);
  const bigCatch = new THREE.Mesh(bigCatchGeo, catchMat);
  bigCatch.position.set(EYE_R * 0.25, EYE_R * 0.3, EYE_R * 0.82);
  group.add(bigCatch);

  // Small catchlight — lower left
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

  // Sky dome — gradient from deep blue top to warm horizon
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

  // Bright sun — upper right (circle avoids square reflection artifacts on polished surfaces)
  const panelGeo = new THREE.CircleGeometry(0.85, 32);
  const sunMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.5, 2.2, 1.8), side: THREE.DoubleSide });
  const sunPanel = new THREE.Mesh(panelGeo, sunMat);
  sunPanel.position.set(3, 3, 2);
  sunPanel.lookAt(0, 0, 0);
  envScene.add(sunPanel);

  // Cool fill — upper left
  const fillMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.4, 0.5, 0.9), side: THREE.DoubleSide });
  const fillPanel = new THREE.Mesh(new THREE.CircleGeometry(1.1, 32), fillMat);
  fillPanel.position.set(-2.5, 2, -1);
  fillPanel.lookAt(0, 0, 0);
  envScene.add(fillPanel);

  // Ground bounce
  const groundMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 0.25, 0.2), side: THREE.DoubleSide });
  const groundPanel = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), groundMat);
  groundPanel.position.set(0, -3, 0);
  groundPanel.rotation.x = Math.PI / 2;
  envScene.add(groundPanel);

  const envMap = pmrem.fromScene(envScene, 0, 0.1, 100).texture;

  skyGeo.dispose();
  skyMat.dispose();
  panelGeo.dispose();
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
  private bodyBasePositions: Float32Array | null = null;

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
    this.renderer.toneMapping = THREE.LinearToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);

    // Scene — environment as both reflections and transmission background
    this.scene = new THREE.Scene();
    const envMap = createEnvironmentMap(this.renderer);
    this.scene.environment = envMap;
    this.scene.background = envMap;

    // Camera — framing the creature with room for hover + ground
    this.camera = new THREE.PerspectiveCamera(
      45,
      canvas.clientWidth / canvas.clientHeight,
      0.01,
      10,
    );
    this.camera.position.set(0, 0.02, 0.85);
    this.camera.lookAt(0, -0.015, 0);

    // === Build Creature ===
    this.creature = new THREE.Group();
    this.scene.add(this.creature);

    // Body — nearly perfect glass sphere
    const body = createBody();
    this.bodyMesh = body.mesh;
    this.bodyMaterial = body.material;
    this.bodyBasePositions = body.basePositions;
    this.creature.add(this.bodyMesh);

    // Eyes — inside the glass body
    this.leftEye = createEye();
    this.leftEye.position.set(-0.055, 0.015, 0.08);
    this.creature.add(this.leftEye);

    this.rightEye = createEye();
    this.rightEye.position.set(0.055, 0.015, 0.08);
    this.creature.add(this.rightEye);

    // Smile — inside the glass
    this.smileMesh = createSmile();
    this.smileMesh.position.set(0, -0.025, 0.09);
    this.creature.add(this.smileMesh);

    // === Lighting — natural ===
    const ambient = new THREE.AmbientLight(0x8090b0, 0.6);
    this.scene.add(ambient);

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
        const eyeZ = 0.08 + Math.sin(t * 0.25) * 0.001;
        this.leftEye.position.z = eyeZ;
        this.rightEye.position.z = eyeZ;
      }

      // === Smile curvature ===
      // scale.y: positive = smile, 0 = flat line, negative = frown
      if (this.smileMesh) {
        this.smileMesh.scale.y = cues.smile_curvature;
      }

      // === Body sag — gravity vs surface tension ===
      // The sphere itself deforms: bottom hemisphere stretches down (teardrop),
      // then surface tension pulls it back. One geometry, one truth.
      if (this.bodyBasePositions) {
        const positions = this.bodyMesh.geometry.getAttribute("position") as THREE.BufferAttribute;
        const base = this.bodyBasePositions;
        const halfR = BODY_R * 0.97; // Y-squished radius

        const sagSpeed = 0.8 + cues.skirt_deformation * 1.5;
        const sagMax = 0.018 + cues.skirt_deformation * 0.02;
        const sagPhase = Math.sin(t * sagSpeed);

        for (let i = 0; i < positions.count; i++) {
          const bx = base[i * 3]!;
          const by = base[i * 3 + 1]!;
          const bz = base[i * 3 + 2]!;

          // Latitude: +1 at top, -1 at bottom
          const normalizedY = by / halfR;

          // Only deform bottom hemisphere, quadratic acceleration toward pole
          const sagFactor = Math.pow(Math.max(0, -normalizedY), 2);

          // Y: bottom sags down (teardrop), or rises past neutral (pumpkin)
          const ySag = -sagPhase * sagFactor * sagMax;

          // Radial: bottom narrows during sag (teardrop), widens during recovery
          const radialScale = 1 - sagPhase * sagFactor * 0.05;

          positions.setX(i, bx * radialScale);
          positions.setY(i, by + ySag);
          positions.setZ(i, bz * radialScale);
        }

        positions.needsUpdate = true;
        this.bodyMesh.geometry.computeVertexNormals();
      }

      // === Rotation disabled for now ===
      // this.creature.rotation.y += 0.05 * dt;

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
    this.bodyBasePositions = null;

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
