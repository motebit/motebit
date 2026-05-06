/**
 * SpatialExpression — the discriminated type every structured-data module
 * with a scene representation declares itself as.
 *
 * Five canonical shapes — satellite, creature, environment, attractor,
 * presentation — pinned by `docs/doctrine/spatial-as-endgame.md`:
 *
 *   - satellite:    orbits the creature (credentials, tools, active tasks)
 *   - creature:     another motebit as a sibling creature in the scene
 *                   (federated agents, collaborators)
 *   - environment:  ambient scene state (memory density, trust climate)
 *   - attractor:    a spatial focus the creature moves toward (goals,
 *                   pending approvals, calls for attention)
 *   - presentation: surfaces the motebit shows you (pages, terminals,
 *                   tools, the slab) — anchored to the motebit's gesture,
 *                   receding when work ends. The bridge primitive between
 *                   the motebit and the spatial OS (Apple visionOS, Meta
 *                   Horizon OS, future glasses OS).
 *
 * These types live in @motebit/render-engine so any surface with a 3D
 * scene — web, spatial, a future mobile-AR / glasses — can consume them.
 * The doctrine enforcement ("no disconnected window-manager panels;
 * surfaces emerge from the motebit's gesture") lives in
 * apps/spatial/__tests__/spatial-expression.neg.test.ts; the types
 * themselves are neutral.
 */

export interface SatelliteItem {
  /** Stable id (e.g., credential_id, tool name, task_id). */
  readonly id: string;
  /** Short display label. Truncated by the renderer if necessary. */
  readonly label: string;
  /** Hue in [0, 360) for interior color. Satellites of the same kind share a palette. */
  readonly hue: number;
  /** Orbital radius in meters from the creature's center. */
  readonly radius: number;
  /**
   * Orbital period in milliseconds. Combined with `phase`, determines
   * where on the orbit the satellite sits at any time.
   */
  readonly orbitPeriodMs: number;
  /** Initial phase in radians, so satellites don't all overlap at t=0. */
  readonly phase: number;
}

export interface SatelliteExpression {
  readonly kind: "satellite";
  readonly items: readonly SatelliteItem[];
}

export interface CreatureExpression {
  readonly kind: "creature";
  readonly motebitId: string;
  /** World-space position (meters) relative to the local creature. */
  readonly offset: { readonly x: number; readonly y: number; readonly z: number };
  readonly hue?: number;
}

export interface EnvironmentExpression {
  readonly kind: "environment";
  /** [0, 1] — 0 is empty, 1 is dense. Controls ambient particle density. */
  readonly density: number;
  readonly tone: "warm" | "cool" | "neutral";
}

export interface AttractorExpression {
  readonly kind: "attractor";
  /** World-space anchor (meters) the creature is pulled toward. */
  readonly anchor: { readonly x: number; readonly y: number; readonly z: number };
  /** [0, 1] — strength of the pull. */
  readonly strength: number;
}

/**
 * One thing the motebit is currently presenting — a page being read, a
 * terminal that's running, a tool result being shown, a slab item lifted
 * for the user. Mirrors `SlabItem` (see `./spec.ts`) at the type level:
 * the slab is the canonical presentation surface, so a presentation in
 * spatial reuses the slab's closed vocabulary of kinds and lifecycle
 * phases. Future kinds added to the slab join presentation
 * automatically.
 *
 * Doctrine: motebit-anchored. The renderer positions the surface
 * relative to the creature's gesture (a held-tablet, a brought-into-
 * view artifact); free-floating positions disconnected from the
 * creature are the failure mode the original "no panels" rule was
 * tracking and remain forbidden by `spatial-expression.neg.test.ts`.
 */
export interface PresentationItem {
  /** Stable id (matches `SlabItem.id` when bridged from the runtime's slab controller). */
  readonly id: string;
  /** Short label for accessibility / Ring-1 chat fallback. */
  readonly label: string;
  /**
   * What kind of content is being presented. Closed vocabulary,
   * inherited from `SlabItemKind` so the slab and presentation can
   * share lifecycle types — the slab is the proto presentation
   * surface and the held-tablet on glasses is its spatial form.
   */
  readonly contentKind: import("./spec.js").SlabItemKind;
  /**
   * Lifecycle phase, inherited from `SlabItemPhase`. The renderer
   * chooses the spatial gesture for each phase: emerging plane vs
   * held-tablet reach-into-view; pinching vs orbiting bead.
   */
  readonly phase: import("./spec.js").SlabItemPhase;
}

export interface PresentationExpression {
  readonly kind: "presentation";
  /**
   * Items currently being presented by the motebit. A scene-level
   * snapshot; the renderer diffs against its prior state to choose
   * emerge / update / dismiss animations.
   */
  readonly items: readonly PresentationItem[];
}

/**
 * The canonical union. Every structured-data module with a scene
 * representation MUST produce one of these shapes. apps/spatial enforces
 * "no disconnected window-manager panels" at compile time via
 * `spatial-expression.neg.test.ts` — widening this union to include
 * `"panel"`, `"list"`, `"card"`, or any other non-member fails that
 * negative proof. `presentation` is admitted because it is anchored to
 * the motebit's gesture (the calm-AR rule, see
 * `docs/doctrine/spatial-as-endgame.md`).
 */
export type SpatialExpression =
  | SatelliteExpression
  | CreatureExpression
  | EnvironmentExpression
  | AttractorExpression
  | PresentationExpression;

export type SpatialKind = SpatialExpression["kind"];

/**
 * Metadata every structured-data module exports so the build can enumerate
 * which data classes have adopted a spatial expression, and which haven't.
 * The generic parameter `K` binds the module to a single kind at compile
 * time — widening to `"panel"` or any other non-member is a type error.
 */
export interface SpatialDataModule<K extends SpatialKind = SpatialKind> {
  readonly kind: K;
  /** Short name for debugging and registry listing (e.g. "credentials"). */
  readonly name: string;
}

/**
 * Keyed-by-name registry. Idempotent on repeat registration of the same
 * name — re-importing a module in tests or after HMR does not duplicate
 * entries. A second call with the same name and a different kind throws:
 * that is a programming error, not a hot-reload case.
 */
const modules = new Map<string, SpatialDataModule>();

/**
 * Register a structured-data module's spatial expression kind. The
 * function is constrained to `SpatialKind`; calls with any other string
 * fail to compile. Registration is idempotent by `name` so hot reload
 * and multiple test imports don't accumulate entries.
 */
export function registerSpatialDataModule<K extends SpatialKind>(
  module: SpatialDataModule<K>,
): SpatialDataModule<K> {
  const existing = modules.get(module.name);
  if (existing && existing.kind !== module.kind) {
    throw new Error(
      `Spatial module "${module.name}" already registered as kind="${existing.kind}"; refused to re-register as kind="${module.kind}"`,
    );
  }
  modules.set(module.name, module);
  return module;
}

export function listSpatialDataModules(): readonly SpatialDataModule[] {
  return [...modules.values()];
}
