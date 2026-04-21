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

  // ── Slab ("Motebit Computer") — see docs/doctrine/motebit-computer.md ──
  //
  // A liquid-glass plane floating to the right of the creature where
  // computation materializes. Sibling to constellation / artifact / chat
  // bubble. The slab itself is implicit (renderer-managed); callers add
  // slab ITEMS and the renderer handles the plane's emergence, idle
  // state, and recession. Items either dissolve (ephemeral work) or
  // detach as artifacts (durable output). Detachment is the pinch — a
  // typed lifecycle phase, not a private animation detail.

  /** Place a slab item on the working surface. */
  addSlabItem?(spec: SlabItemSpec): SlabItemHandle | undefined;
  /** Dissolve a slab item back into the surface (ephemeral end, no artifact). */
  dissolveSlabItem?(id: string): Promise<void>;
  /**
   * Detach a slab item as an artifact via the surface-tension pinch.
   * Returns the artifact handle the item becomes in the wider scene.
   * The slab runs the detachment physics (dimple → bead → snap); the
   * provided `artifact` describes what the detached bead should settle
   * into mid-flight.
   */
  detachSlabItemAsArtifact?(
    id: string,
    artifact: ArtifactSpec,
  ): Promise<ArtifactHandle | undefined>;
  /** Clear every slab item immediately (no dissolution animation). */
  clearSlabItems?(): void;
}

// === Slab ("Motebit Computer") — scene primitive types ===
//
// See docs/doctrine/motebit-computer.md. The slab is the canonical
// surface for acts-in-progress; records go in panels, durable outputs
// detach as artifacts. These types are the cross-surface contract.

/**
 * Kind of in-progress work a slab item represents. Unlike `ArtifactKind`
 * (which describes detached, durable outputs), SlabItemKind enumerates
 * the procedural categories of live work the slab renders.
 *
 *   - `stream` — live LLM token stream before it crystallizes.
 *   - `tool_call` — MCP or function call, {input → output} card.
 *   - `plan_step` — one step of a running plan.
 *   - `shell` — bash/command output streaming.
 *   - `fetch` — web fetch / search / read-url in flight.
 *   - `embedding` — inference / embedding call in flight.
 *   - `delegation` — outbound task to a peer motebit on the relay.
 *     A packet leaves the slab with the target's identity visible;
 *     returns as a bead carrying a signed ExecutionReceipt. Doctrine:
 *     motebit-computer.md §Hand — "Delegation outbound." The returned
 *     receipt is durable — the item pinches to a receipt artifact.
 */
export type SlabItemKind =
  | "stream"
  | "tool_call"
  | "plan_step"
  | "shell"
  | "fetch"
  | "embedding"
  | "delegation";

/**
 * Lifecycle phase for a slab item. The doctrine treats detachment as a
 * typed phase (not a private animation detail) so cross-surface
 * renderers can't silently diverge on the pinch physics.
 *
 *   - `emerging` — item is materializing onto the slab.
 *   - `active` — item is present and may be streaming updates.
 *   - `pinching` — item has produced a durable output; surface dimples
 *     and the bead is separating under surface tension. Artifact is
 *     about to spawn; slab is about to ripple back to flat.
 *   - `detached` — item has left the slab as an artifact in the wider
 *     scene. The slab's own ripple may still be settling.
 *   - `dissolving` — item is fading back into the slab surface with
 *     no artifact spawn (ephemeral end, interrupt, failure).
 *   - `gone` — item no longer on the slab; no further transitions.
 */
export type SlabItemPhase = "emerging" | "active" | "pinching" | "detached" | "dissolving" | "gone";

/**
 * Specification for a slab item. The host-element pattern mirrors
 * `ArtifactSpec` (surface-native HTMLElement held by the caller, slab
 * positions and animates it in 3D) — keeps the renderer Three.js-free
 * and lets each surface render content with its native text/streaming
 * primitives.
 */
export interface SlabItemSpec {
  /** Unique ID for lifecycle management. Stable across phase transitions. */
  id: string;
  /** Procedural category (informs default positioning + Fresnel treatment). */
  kind: SlabItemKind;
  /** The HTML element to mount onto the slab surface. Owned by the caller. */
  element: HTMLElement;
}

/** Handle returned after placing a slab item — controls its lifecycle. */
export interface SlabItemHandle {
  id: string;
  /** Current phase. Renderer drives transitions; callers read for coordination. */
  getPhase(): SlabItemPhase;
  /** Subscribe to phase transitions. Returns an unsubscribe thunk. */
  onPhaseChange(listener: (phase: SlabItemPhase) => void): () => void;
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
