/**
 * SpatialExpression — the discriminated type every structured-data module
 * in spatial MUST declare itself as.
 *
 * Doctrine (CLAUDE.md, "Spatial rejects the panel metaphor"):
 * spatial data is expressed as scene objects, not rectangular panels.
 * The doctrine used to be prose; this module makes it a compile-time
 * boundary. A structured-data module that claims to be a "panel" produces
 * a tsc error, not a lint warning.
 *
 * The pattern mirrors the GuestRail / SovereignRail custody split
 * (services/api/src/__tests__/custody-boundary.test.ts): express the
 * invariant as a type, back it with a @ts-expect-error negative proof,
 * and the build refuses to silence the constraint.
 *
 * The four shapes — satellite, creature, environment, attractor — come
 * directly from the vision documents (`vision_spatial_canvas.md`,
 * `vision_interactive_artifacts.md`, `vision_endgame_interface.md`):
 *
 *   - satellite:   orbits the creature (credentials, tools, active tasks)
 *   - creature:    another motebit as a sibling creature in the scene
 *                  (federated agents, collaborators)
 *   - environment: ambient scene state (memory density, trust climate)
 *   - attractor:   a spatial focus the creature moves toward (goals,
 *                  pending approvals, calls for attention)
 *
 * If a new structural concept arises that doesn't fit these four, the
 * answer is to widen the union deliberately — not to fall back to a
 * rectangular panel.
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
 * The canonical union. Every structured-data module in spatial MUST
 * produce one of these shapes. Adding "panel" or "list" here is the
 * spatial anti-pattern and will cause the negative-proof test
 * (`src/__tests__/spatial-expression.neg.test.ts`) to fail compilation.
 */
export type SpatialExpression =
  | SatelliteExpression
  | CreatureExpression
  | EnvironmentExpression
  | AttractorExpression;

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

const modules: SpatialDataModule[] = [];

/**
 * Register a structured-data module's spatial expression kind. The function
 * is constrained to `SpatialKind`; calls with any other string fail to
 * compile. The registry is append-only (modules live for the process
 * lifetime) because adding a satellite class should never require tearing
 * down the scene.
 */
export function registerSpatialDataModule<K extends SpatialKind>(
  module: SpatialDataModule<K>,
): SpatialDataModule<K> {
  modules.push(module);
  return module;
}

export function listSpatialDataModules(): readonly SpatialDataModule[] {
  return modules;
}
