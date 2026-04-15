import type {
  BehaviorCues,
  RenderSpec,
  GeometrySpec,
  MaterialSpec,
  LightingSpec,
  TrustMode,
} from "@motebit/sdk";

// === Canonical Render Spec ===

export const CANONICAL_GEOMETRY: GeometrySpec = {
  form: "droplet",
  base_radius: 0.14,
  height: 0.12,
};

export const CANONICAL_MATERIAL: MaterialSpec = {
  ior: 1.22, // Rendering IOR — enough refraction to lens the environment
  subsurface: 0.05,
  roughness: 0.0, // Surface tension smooths to perfection at this scale
  clearcoat: 0.4,
  surface_noise_amplitude: 0.002,
  base_color: [1.0, 1.0, 1.0],
  emissive_intensity: 0.0, // Zero at rest — glows only during processing
  tint: [0.95, 0.95, 1.0], // Default: near-neutral cool white — moonlight
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

// === Spatial Canvas — Artifact Types ===

export type ArtifactKind = "text" | "code" | "plan" | "memory" | "receipt";

/** Lifecycle phase for entrance/exit animations. */
export type ArtifactPhase = "emerging" | "present" | "receding" | "gone";

/** Specification for placing an HTML artifact in 3D space. */
export interface ArtifactSpec {
  /** Unique ID for lifecycle management. */
  id: string;
  /** Determines default positioning slot. */
  kind: ArtifactKind;
  /** The HTML element to position in 3D space. Owned by the caller. */
  element: HTMLElement;
  /** Optional preferred angle in radians around the creature (0 = front-right). */
  preferredAngle?: number;
}

/** Handle returned after placing an artifact — controls its lifecycle. */
export interface ArtifactHandle {
  id: string;
  /** Update the artifact's angular position around the creature. */
  setAngle(radians: number): void;
  /** Signal the artifact to begin its exit animation and remove from scene. */
  dismiss(): Promise<void>;
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
  setTrustMode(mode: TrustMode): void;
  setListeningIndicator(active: boolean): void;
  dispose(): void;

  /**
   * The creature's scene-graph anchor, so callers can mount spatial objects
   * that inherit its world position (credential satellites, federated-agent
   * creatures, memory environment). Returns null before init, after dispose,
   * or when the adapter is headless. Declared as `unknown` to keep the
   * RenderAdapter interface Three.js-free; concrete adapters narrow to
   * `THREE.Group`. Callers cast at the boundary.
   */
  getCreatureGroup(): unknown;

  /** Place an HTML artifact in 3D space relative to the creature. */
  addArtifact?(spec: ArtifactSpec): ArtifactHandle | undefined;
  /** Remove an artifact by ID (triggers exit animation). */
  removeArtifact?(id: string): Promise<void>;
  /** Remove all artifacts immediately. */
  clearArtifacts?(): void;
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
