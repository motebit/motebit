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

// === Three.js Geometry & Material Helpers ===

function createDropletGeometry(spec: GeometrySpec): THREE.LatheGeometry {
  const points: THREE.Vector2[] = [];
  const segments = 32;

  for (let i = 0; i <= segments; i++) {
    const t = i / segments; // 0 = bottom, 1 = top
    const y = t * spec.height;

    // Droplet profile: wide at bottom, tapering to a point at top
    // Use a sin-based envelope that peaks near the bottom third
    let r: number;
    if (t < 0.3) {
      // Expanding from base
      r = spec.base_radius * Math.sin((t / 0.3) * (Math.PI / 2));
    } else if (t < 0.95) {
      // Tapering section
      const taper = (t - 0.3) / (0.95 - 0.3);
      r = spec.base_radius * (1 - taper * taper);
    } else {
      // Sharp tip
      const tip = (t - 0.95) / 0.05;
      r = spec.base_radius * 0.05 * (1 - tip);
    }

    // Apply sinusoidal lobe deformation
    const lobeAngle = t * Math.PI * 2;
    const lobeDeform = 1 + 0.05 * Math.sin(lobeAngle * spec.lobe_count);
    r *= lobeDeform;

    // Clamp to avoid zero radius at endpoints (except very tip)
    r = Math.max(r, 0.0001);

    points.push(new THREE.Vector2(r, y));
  }

  return new THREE.LatheGeometry(points, spec.skirt_segments);
}

function createDropletMaterial(spec: MaterialSpec): THREE.MeshPhysicalMaterial {
  const [r, g, b] = spec.base_color;
  return new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(r, g, b),
    roughness: spec.roughness,
    clearcoat: spec.clearcoat,
    ior: spec.ior,
    emissive: new THREE.Color(r, g, b),
    emissiveIntensity: spec.emissive_intensity,
    transmission: spec.subsurface * 0.5, // Slight transmission for subsurface approximation
    transparent: true,
  });
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
  private mesh: THREE.Mesh | null = null;
  private material: THREE.MeshPhysicalMaterial | null = null;
  private baseY: number = 0;

  async init(target: unknown): Promise<void> {
    // Guard: if target is not an HTMLCanvasElement, set initialized and return
    // This preserves test compatibility when passing null.
    // Check for typeof HTMLCanvasElement to avoid ReferenceError in Node/test environments.
    if (typeof HTMLCanvasElement === "undefined" || !(target instanceof HTMLCanvasElement)) {
      this.initialized = true;
      return;
    }

    const canvas = target;

    // Create WebGL renderer
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
    });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = this.spec.lighting.exposure;
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);

    // Create scene with dark background
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0a0f);

    // Create camera positioned to frame the droplet
    this.camera = new THREE.PerspectiveCamera(
      50,
      canvas.clientWidth / canvas.clientHeight,
      0.01,
      10,
    );
    this.camera.position.set(0, this.spec.geometry.height / 2, 0.5);
    this.camera.lookAt(0, this.spec.geometry.height / 2, 0);

    // Create droplet mesh
    const geometry = createDropletGeometry(this.spec.geometry);
    this.material = createDropletMaterial(this.spec.material);
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.baseY = 0;
    this.scene.add(this.mesh);

    // Add lighting
    const ambientLight = new THREE.AmbientLight(
      0xffffff,
      this.spec.lighting.ambient_intensity,
    );
    this.scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 1.0);
    directionalLight.position.set(1, 2, 3);
    this.scene.add(directionalLight);

    this.initialized = true;
  }

  render(frame: RenderFrame): void {
    if (!this.initialized) return;
    const dt = frame.delta_time;

    // Frame-independent smoothing for all cue values
    this.currentCues = {
      hover_distance: smoothDelta(this.currentCues.hover_distance, frame.cues.hover_distance, dt),
      drift_amplitude: smoothDelta(this.currentCues.drift_amplitude, frame.cues.drift_amplitude, dt),
      glow_intensity: smoothDelta(this.currentCues.glow_intensity, frame.cues.glow_intensity, dt),
      eye_dilation: smoothDelta(this.currentCues.eye_dilation, frame.cues.eye_dilation, dt),
      smile_curvature: smoothDelta(this.currentCues.smile_curvature, frame.cues.smile_curvature, dt),
      skirt_deformation: smoothDelta(this.currentCues.skirt_deformation, frame.cues.skirt_deformation, dt),
    };

    // Apply cues to Three.js objects
    if (this.mesh && this.material && this.renderer && this.scene && this.camera) {
      // hover_distance -> mesh vertical position
      this.mesh.position.y = this.baseY + this.currentCues.hover_distance * 0.1;

      // drift_amplitude -> sinusoidal horizontal drift
      const driftX = Math.sin(frame.time * 1.2) * this.currentCues.drift_amplitude;
      const driftZ = Math.cos(frame.time * 0.8) * this.currentCues.drift_amplitude * 0.5;
      this.mesh.position.x = driftX;
      this.mesh.position.z = driftZ;

      // glow_intensity -> emissive intensity
      this.material.emissiveIntensity = this.currentCues.glow_intensity * this.spec.material.emissive_intensity;

      // smile_curvature -> slight color warm/cool shift
      const [baseR, baseG, baseB] = this.spec.material.base_color;
      const warmth = this.currentCues.smile_curvature * 0.05;
      this.material.color.setRGB(
        baseR + warmth,
        baseG + warmth * 0.5,
        baseB - warmth * 0.3,
      );

      // skirt_deformation -> mesh scale Y
      this.mesh.scale.y = 1 + this.currentCues.skirt_deformation * 0.2;

      // Gentle continuous rotation
      this.mesh.rotation.y += 0.3 * dt;

      // Render the frame
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
    if (this.mesh) {
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
    if (this.material) {
      this.material.dispose();
      this.material = null;
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
