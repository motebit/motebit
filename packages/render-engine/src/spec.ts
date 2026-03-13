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
  // Presence model
  departCreature(opts?: DepartureOpts): void;
  returnCreature(opts?: { fromDirection?: { x: number; y: number; z: number } }): void;
  arriveVisitor(id: string, opts: VisitorOpts): void;
  departVisitor(id: string): void;
  getMainPresence(): CreaturePresence;
  getVisitors(): Map<string, VisitorState>;
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

// === Presence Model Types ===

/**
 * The presence state of a creature in the scene.
 *
 * Your creature:
 *   home → departing → away → returning → home
 *
 * Visitor creatures:
 *   arriving → present → leaving (then removed)
 */
export type CreaturePresence =
  | "home" // your creature, orbiting your body normally
  | "departing" // your creature detaching, drifting away (delegation sent)
  | "away" // your creature is gone, only a ghost remains
  | "returning" // your creature coming back (receipt received)
  | "arriving" // a visitor materializing in your space
  | "present" // a visitor fully present, carrying a task
  | "leaving"; // a visitor departing after completing work

/** Options for a visitor creature arriving in your space. */
export interface VisitorOpts {
  motebitId: string;
  /** Direction the visitor arrives from — a unit vector in world space. */
  direction?: { x: number; y: number; z: number };
  /** 0–1 trust score — used to derive identity tint intensity. */
  trustScore: number;
}

/** Options for departing your own creature. */
export interface DepartureOpts {
  /** Direction to drift toward — a unit vector in world space. */
  direction?: { x: number; y: number; z: number };
}

/** Internal state tracked per visitor creature. */
export interface VisitorState {
  id: string;
  group: unknown; // THREE.Group — typed as unknown to avoid THREE dep in spec
  body: unknown; // THREE.Mesh
  eyes: unknown; // THREE.Group
  bodyMaterial: unknown; // THREE.MeshPhysicalMaterial
  trustScore: number;
  presence: CreaturePresence;
  hue: number;
  /** Per-creature phase offset so breathing is not in lockstep. */
  phase: number;
  /** Timestamp when this presence state started — drives transition progress. */
  transitionStart: number;
  /** Direction the visitor came from (for arrival / leaving animations). */
  direction: { x: number; y: number; z: number };
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
