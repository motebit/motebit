import type { BehaviorCues, RenderSpec, GeometrySpec, MaterialSpec, LightingSpec } from "@mote/sdk";

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

// === Three.js Adapter Stub ===
// Full implementation requires three.js dependency — this provides the structure.

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

  async init(_target: unknown): Promise<void> {
    // In production: create Scene, Camera, Renderer, Geometry, Material
    // _target would be an HTMLCanvasElement or similar
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

    // In production: update mesh position, material uniforms, etc.
    // - Position: offset by hover_distance along user-relative axis
    // - Drift: sinusoidal offset with drift_amplitude
    // - Glow: emissive intensity = glow_intensity * CANONICAL_MATERIAL.emissive_intensity
    // - Eye: pupil scale = eye_dilation
    // - Smile: curve deformation on face mesh
    // - Skirt: vertex displacement on skirt segments
  }

  getSpec(): RenderSpec {
    return this.spec;
  }

  resize(_width: number, _height: number): void {
    // In production: update camera aspect, renderer size
  }

  dispose(): void {
    this.initialized = false;
    // In production: dispose geometries, materials, textures, renderer
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
