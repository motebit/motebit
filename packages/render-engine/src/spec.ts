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
}

// === Multi-Creature Constants & Pure Functions ===

/** Maximum distance (meters) for a remote creature at trust 0. */
export const REMOTE_MAX_DISTANCE = 2.0;

/** Minimum distance (meters) for a remote creature at trust 1. */
export const REMOTE_MIN_DISTANCE = 0.4;

/**
 * Map a trust score (0–1) to a radial distance (meters).
 * Higher trust → closer (MIN_DISTANCE). Lower trust → farther (MAX_DISTANCE).
 * Result is clamped to [REMOTE_MIN_DISTANCE, REMOTE_MAX_DISTANCE].
 */
export function trustToDistance(trustScore: number): number {
  const clamped = Math.max(0, Math.min(1, trustScore));
  const distance = REMOTE_MAX_DISTANCE - clamped * (REMOTE_MAX_DISTANCE - REMOTE_MIN_DISTANCE);
  // Clamp result to guard against floating-point drift at the boundaries
  return Math.max(REMOTE_MIN_DISTANCE, Math.min(REMOTE_MAX_DISTANCE, distance));
}

/**
 * Map a string ID to a hue (0–360) deterministically.
 * Uses a djb2 variant hash so the same ID always produces the same hue
 * and different IDs tend to produce spread-out hues.
 */
export function idToHue(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  return ((hash % 360) + 360) % 360;
}

// === Multi-Creature Types ===

/** Options for creating or updating a remote creature. */
export interface RemoteCreatureOpts {
  /** 0–1 trust score — higher trust places the creature closer (MIN_DISTANCE). */
  trustScore: number;
  /** World-space position. If omitted, auto-placed by trustToDistance() on the XZ plane. */
  position?: { x: number; y: number; z: number };
  /** Hue 0–360. If omitted, derived from `id` via idToHue(). */
  hue?: number;
}

/** Activity state — drives emissive animations. */
export type RemoteCreatureActivity = "idle" | "processing" | "delegating" | "completed";

/** Internal state tracked per remote creature. */
export interface RemoteCreatureState {
  id: string;
  group: unknown; // THREE.Group — typed as unknown to avoid THREE dep in spec
  body: unknown; // THREE.Mesh
  eyes: unknown; // THREE.Group
  bodyMaterial: unknown; // THREE.MeshPhysicalMaterial
  trustScore: number;
  activity: RemoteCreatureActivity;
  hue: number;
  /** Per-creature phase offset so breathing is not in lockstep. */
  phase: number;
  /** Timestamp when 'completed' state started — drives the flash-then-fade. */
  completedAt: number;
}

/** Internal state tracked per delegation line. */
export interface DelegationLineState {
  id: string;
  fromId: string | "self";
  toId: string;
  line: unknown; // THREE.Line
  geometry: unknown; // THREE.BufferGeometry
  material: unknown; // THREE.LineBasicMaterial
  /** Active pulse: 0–1 progress along the line, -1 = no pulse. */
  pulseProgress: number;
  /** Pulse indicator point mesh. */
  pulseMesh: unknown; // THREE.Mesh | null
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
