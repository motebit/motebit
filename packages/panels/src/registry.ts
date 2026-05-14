/**
 * Typed registry of the six side-rail panels per
 * `docs/doctrine/panel-temporal-registers.md`, plus the closed
 * `PanelPresentationMode` registry per
 * `docs/doctrine/panel-presentation-modes.md`.
 *
 * Records surfaces only (panels are records per
 * `docs/doctrine/records-vs-acts.md`); the body is the act surface.
 *
 * Three axes a panel composes:
 *
 *   - `register`        — temporal mode (identity vs runtime).
 *   - `primitive`       — which of the five protocol primitives.
 *   - `presentationMode` — how the panel embodies on the surface
 *                          (rail / immersive / spatial).
 *
 * Governance is deliberately absent from `PanelPrimitive` — it is
 * the membrane, not a record. Modals are deliberately absent from
 * `PanelPresentationMode` — they are a category error per
 * `panel-presentation-modes.md`. Both omissions are the structural
 * enforcement of doctrine on the panel side.
 */

export type PanelRegister = "identity" | "runtime";

export type PanelPrimitive = "identity" | "memory" | "capability" | "execution" | "delegation";

export interface SideRailPanel {
  readonly id: string;
  readonly register: PanelRegister;
  readonly primitive: PanelPrimitive;
}

export const SIDE_RAIL_PANELS: readonly SideRailPanel[] = [
  // Identity register — retrospective (past → present).
  { id: "sovereign", register: "identity", primitive: "identity" },
  { id: "memory", register: "identity", primitive: "memory" },
  { id: "conversations", register: "identity", primitive: "memory" },
  // Runtime register — prospective (present → future).
  { id: "capabilities", register: "runtime", primitive: "capability" },
  { id: "goals", register: "runtime", primitive: "execution" },
  { id: "agents", register: "runtime", primitive: "delegation" },
] as const;

// ── Panel presentation modes ───────────────────────────────────────
//
// Closed registry per `docs/doctrine/panel-presentation-modes.md`.
// A panel renders as `f(panel × presentationMode)`. Information shape
// is constant; embodiment is the variable. Same closed-union pattern
// as `SuiteId` (cryptosuite agility), `EmbodimentMode` (slab), and
// `GoalBudgetAxis` (bounded commitment).
//
// `modal` is structurally absent — modals are a category error per the
// doctrine. If a creation flow needs a different shape, rotate the
// panel's interior register, don't pop a second panel-shaped surface.

export type PanelPresentationMode = "rail" | "immersive" | "spatial";

/** Surfaces that compose panels. */
export type PanelSurface = "web" | "desktop" | "mobile" | "spatial";

/**
 * Per-surface availability matrix. A "–" cell in the doctrine memo
 * maps to absence from the per-surface tuple here. The type system
 * rejects attempts to render a panel in an unavailable mode at the
 * call site (e.g. `rail` on mobile, `spatial` on web today). The
 * table is not aspirational — it's typed, frozen, and enforced.
 *
 * `spatial` lands as an available mode on the spatial app (and as
 * `immersive` for the "pull-close" register on the same surface).
 * Web / desktop / mobile get `spatial` when the panel renderer
 * composes into a 3D scene; that's a per-surface adapter ship, not a
 * doctrine extension.
 */
export const PANEL_PRESENTATION_AVAILABILITY = {
  web: ["rail", "immersive"],
  desktop: ["rail", "immersive"],
  mobile: ["immersive"],
  spatial: ["immersive", "spatial"],
} as const satisfies Record<PanelSurface, readonly PanelPresentationMode[]>;

/**
 * Type-level set membership: `IsPresentationAvailable<S, M>` resolves
 * to `true` iff `M` appears in `PANEL_PRESENTATION_AVAILABILITY[S]`.
 * Call sites can narrow against this to gate rendering at compile
 * time.
 */
export type IsPresentationAvailable<
  S extends PanelSurface,
  M extends PanelPresentationMode,
> = M extends (typeof PANEL_PRESENTATION_AVAILABILITY)[S][number] ? true : false;
