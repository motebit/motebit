import type {
  BehaviorCues,
  RenderSpec,
  GeometrySpec,
  MaterialSpec,
  LightingSpec,
  TrustMode,
} from "@motebit/sdk";

// === Canonical Render Spec ===
//
// These constants are the body's substance and the medium's optics in
// code form. Doctrine: docs/doctrine/liquescentia-as-substrate.md §V.3
// "Luminous density" — IOR + transmission + attenuation make the
// medium's filtered light visible through the glass. CANONICAL_MATERIAL
// is the canonical home for those constants; departing from them needs
// physical justification (a coupling argument from the same physics
// that produced them), not aesthetic preference.

export const CANONICAL_GEOMETRY: GeometrySpec = {
  form: "droplet",
  base_radius: 0.14,
  height: 0.12,
};

export const CANONICAL_MATERIAL: MaterialSpec = {
  ior: 1.22, // Rendering IOR — enough refraction to lens the environment (Liquescentia §V.3)
  subsurface: 0.05,
  roughness: 0.0, // Surface tension smooths to perfection at this scale (DROPLET §III)
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
  // state, and recession. Items either dissolve (ephemeral work), rest
  // (working material stays on the surface), or detach as artifacts
  // (durable output — the pinch). Detachment is the pinch — a typed
  // lifecycle phase, not a private animation detail.

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
  /**
   * Hold the empty slab open. Items always make the plane visible
   * regardless of this flag; `setSlabVisible` only governs the
   * empty-state behavior: `true` keeps the plane open when no items
   * are present (for prep / drag-in), `false` (default) lets it
   * auto-hide.
   *
   * Surfaces wire this to Option+C / `/computer`.
   */
  setSlabVisible?(visible: boolean): void;
  /**
   * Flip the user-held visibility. Returns the new state so callers
   * can show a toast / indicator without a separate getter.
   */
  toggleSlabVisible?(): boolean;
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
 *   - `memory` — a memory node rising into attention as the motebit
 *     thinks (proactive consolidation, same-turn recall). The Mind
 *     organ's visible breath: "memory surfaces on the slab as it
 *     becomes relevant." Ephemeral — dissolves when attention moves
 *     on. Doctrine: motebit-computer.md §Mind.
 */
export type SlabItemKind =
  | "stream"
  | "tool_call"
  | "plan_step"
  | "shell"
  | "fetch"
  | "embedding"
  | "delegation"
  | "memory";

/**
 * Embodiment mode — the coarse-grained perceptual category the slab
 * item belongs to. Orthogonal to `SlabItemKind` (which is the fine-
 * grained content shape). A single item has both: a `fetch` kind is
 * typically `tool_result` mode today and may become `virtual_browser`
 * mode when the renderer ships real embedded pages.
 *
 * The motebit perceives through many embodiments, not one. The
 * Motebit Computer is the single surface where whichever embodiment
 * is active is rendered live, governed by what the user has granted.
 * See docs/doctrine/motebit-computer.md §"Embodiment modes" for the
 * spectrum, the mode × end-state matrix, and the governance gates.
 *
 *   - `mind` — internal memory / reasoning surfacing. Always
 *     permitted; no external governance gate.
 *   - `tool_result` — cleaned output from a sandboxed tool call.
 *     Turn-scoped by invocation. The thinnest embodiment.
 *   - `virtual_browser` — an isolated browser viewport the motebit
 *     is navigating (Operator-shape). Session-scoped consent.
 *   - `shared_gaze` — a source both the motebit and the user look
 *     at (Zed-pattern). Per-source consent.
 *   - `desktop_drive` — the motebit acts on the user's real desktop
 *     (Claude Cowork-shape). Explicit, revocable grant.
 *   - `peer_viewport` — looking into a peer motebit's work via
 *     federation. Signed delegation + trust graph.
 */
export type EmbodimentMode =
  | "mind"
  | "tool_result"
  | "virtual_browser"
  | "shared_gaze"
  | "desktop_drive"
  | "peer_viewport";

/**
 * Sensible default mapping from `SlabItemKind` to `EmbodimentMode`.
 * Runtime can override per item when the embodiment doesn't match the
 * default (e.g., a `fetch` kind opened inside a consented virtual
 * browser upgrades from `tool_result` to `virtual_browser`).
 *
 * The defaults are published in the protocol so every consumer
 * (controller, bridge, renderer, tests) agrees on what an un-
 * annotated kind means.
 */
export function defaultEmbodimentMode(kind: SlabItemKind): EmbodimentMode {
  switch (kind) {
    case "stream":
    case "plan_step":
    case "embedding":
    case "memory":
      return "mind";
    case "tool_call":
    case "shell":
    case "fetch":
      return "tool_result";
    case "delegation":
      return "peer_viewport";
  }
}

/**
 * Lifecycle phase for a slab item. The doctrine treats detachment as a
 * typed phase (not a private animation detail) so cross-surface
 * renderers can't silently diverge on the pinch physics.
 *
 *   - `emerging` — item is materializing onto the slab.
 *   - `active` — item is present and may be streaming updates.
 *   - `resting` — active work has finished, the item remains on the
 *     slab as working material (open tab / reference). Stays until
 *     dismissed by the user, closed by the motebit, or evicted.
 *     The workstation's natural state; third end-branch alongside
 *     `pinching` and `dissolving`. Doctrine: motebit-computer.md
 *     §"Three end states — dissolve, rest, detach."
 *   - `pinching` — item has produced a durable output; surface dimples
 *     and the bead is separating under surface tension. Artifact is
 *     about to spawn; slab is about to ripple back to flat.
 *   - `detached` — item has left the slab as an artifact in the wider
 *     scene. The slab's own ripple may still be settling.
 *   - `dissolving` — item is fading back into the slab surface with
 *     no artifact spawn (ephemeral end, interrupt, failure, or
 *     user-dismissed rest item).
 *   - `gone` — item no longer on the slab; no further transitions.
 */
export type SlabItemPhase =
  | "emerging"
  | "active"
  | "resting"
  | "pinching"
  | "detached"
  | "dissolving"
  | "gone";

// === Embodiment Mode Contract ============================================
//
// The mode-contract invariant: every `EmbodimentMode` declares six
// invariants (driver / observer / source / consent / sensitivity /
// lifecycle defaults). Doctrine: `docs/doctrine/motebit-computer.md`
// §"Mode contract — six declarations per mode."
//
// `EMBODIMENT_MODE_CONTRACTS` below is the typed encoding of that
// doctrine — `satisfies Record<EmbodimentMode, EmbodimentModeContract>`
// enforces total coverage at compile time. Adding a new mode to
// `EmbodimentMode` without a contract entry, or removing a field from
// the contract, fails to typecheck. Same enforceability shape as the
// `SuiteId` / `GuestRail` / `SovereignRail` agility-as-role pattern:
// name the role, the field set is closed, instances slot in.

/** Who initiates the action this mode represents. */
export type EmbodimentDriver = "motebit" | "user" | "peer" | "self";

/** Who watches the mode's surface. */
export type EmbodimentObserver = "motebit" | "user" | "self";

/** The source surface category — what's being driven or observed. */
export type EmbodimentSourceCategory =
  | "interior" // mind — memory, reasoning, internal state
  | "sandboxed-tool" // tool_result — cleaned output from a tool call
  | "isolated-browser" // virtual_browser — viewport motebit drives
  | "user-source" // shared_gaze — browser tab / desktop / editor / file / video / call
  | "real-os" // desktop_drive — the user's actual OS
  | "peer-receipt"; // peer_viewport — signed delegation receipt from a federated peer

/**
 * When the consent (or proof) boundary fires for this mode. peer_viewport
 * has no live consent re-fire — the receipt's signature IS the proof.
 */
export type EmbodimentConsentBoundary =
  | "always-permitted" // mind (interior; no external gate)
  | "per-action" // tool_result, desktop_drive (PolicyGate per call / classifier per action)
  | "per-source" // shared_gaze (re-fires on source change)
  | "session-scoped" // virtual_browser (one consent for the session)
  | "signed-delegation"; // peer_viewport (the receipt is the proof)

/**
 * Sensitivity routing posture. Bounds which `SensitivityLevel` tiers
 * (none / personal / medical / financial / secret) the mode admits.
 */
export type EmbodimentSensitivityRouting =
  | "all-tiers" // mind (interior is sovereign-tier by definition); desktop_drive (classifier gates within)
  | "tier-bounded-by-tool" // tool_result (per-tool's declared tier)
  | "tier-bounded-by-source"; // virtual_browser, shared_gaze, peer_viewport (bounded by what's navigated to / observed / federated)

/**
 * Six declarations every embodiment mode must answer. Doctrine:
 * motebit-computer.md §"Mode contract." Naming each field as a typed
 * field — not free-form prose — turns the spectrum into an
 * enforceable contract: a future mode addition that doesn't answer
 * each field fails to compile.
 *
 * The four agency-and-governance fields (driver, observer, source,
 * consent) are the reviewer-suggested base; the two motebit-specific
 * fields (sensitivity, lifecycleDefaults) come from existing
 * invariants — `SovereignTierRequiredError` enforces sensitivity
 * routing across modes; the slab's mode × end-state matrix names
 * lifecycle defaults per mode.
 */
export interface EmbodimentModeContract {
  readonly driver: EmbodimentDriver;
  readonly observer: EmbodimentObserver;
  readonly source: EmbodimentSourceCategory;
  readonly consent: EmbodimentConsentBoundary;
  readonly sensitivity: EmbodimentSensitivityRouting;
  /**
   * Lifecycle phases this mode admits as defaults. Values constrained
   * to `SlabItemPhase` — every entry is a valid phase, enforced at
   * compile time. Doctrine: motebit-computer.md §"Mode × end state
   * matrix" names the typical phases per mode; this is the
   * compile-time encoding.
   */
  readonly lifecycleDefaults: ReadonlyArray<SlabItemPhase>;
}

/**
 * Total contract for every `EmbodimentMode`. The
 * `satisfies Record<EmbodimentMode, EmbodimentModeContract>` clause
 * enforces total coverage — a new mode without a contract entry, or
 * a contract entry without all six fields, fails to typecheck.
 *
 * This is the canonical authority for any consumer (slab controller,
 * tool-policy registry, future drift gates) reasoning about what a
 * mode permits. The doctrine prose in motebit-computer.md is the
 * human-readable rendering of this constant; if the two diverge,
 * this constant is correct and the prose drifts.
 */
export const EMBODIMENT_MODE_CONTRACTS = {
  mind: {
    driver: "self",
    observer: "self",
    source: "interior",
    consent: "always-permitted",
    sensitivity: "all-tiers",
    lifecycleDefaults: ["dissolving", "resting", "detached"],
  },
  tool_result: {
    driver: "motebit",
    observer: "user",
    source: "sandboxed-tool",
    consent: "per-action",
    sensitivity: "tier-bounded-by-tool",
    lifecycleDefaults: ["resting", "dissolving"],
  },
  virtual_browser: {
    driver: "motebit",
    observer: "user",
    source: "isolated-browser",
    consent: "session-scoped",
    sensitivity: "tier-bounded-by-source",
    lifecycleDefaults: ["resting", "detached"],
  },
  shared_gaze: {
    driver: "user",
    observer: "motebit",
    source: "user-source",
    consent: "per-source",
    sensitivity: "tier-bounded-by-source",
    lifecycleDefaults: ["resting", "detached", "dissolving"],
  },
  desktop_drive: {
    driver: "motebit",
    observer: "user",
    source: "real-os",
    consent: "per-action",
    sensitivity: "all-tiers",
    lifecycleDefaults: ["resting", "detached"],
  },
  peer_viewport: {
    driver: "peer",
    observer: "motebit",
    source: "peer-receipt",
    consent: "signed-delegation",
    sensitivity: "tier-bounded-by-source",
    lifecycleDefaults: ["resting", "detached"],
  },
} as const satisfies Record<EmbodimentMode, EmbodimentModeContract>;

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
