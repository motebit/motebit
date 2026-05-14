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
// A panel renders as `f(panel × presentationMode)` on flat surfaces.
// Information shape is constant; embodiment is the variable. Same
// closed-union pattern as `SuiteId` (cryptosuite agility),
// `EmbodimentMode` (slab), and `GoalBudgetAxis` (bounded commitment).
//
// **Scope: flat surfaces only.** Panels exist on web / desktop /
// mobile — surfaces with viewport chrome that admits rectangular
// records-areas attached to edges. They do NOT exist on spatial.
// `docs/doctrine/spatial-as-endgame.md` enumerates the five spatial
// primitives (creature / satellite / environment / attractor /
// presentation) and explicitly forbids window-manager panels:
// "Surfaces emerge from the motebit's gesture and recede when work
// ends." A "spatial panel" would fail all three of that doctrine's
// tests (user-summoned, free-floating, persistent chrome). In
// spatial, the same controller state renders as a Presentation
// primitive — the 5th spatial primitive, anchored to the creature.
// The categorical translation happens in the renderer, not via a
// new presentation-mode entry.
//
// `modal` and `spatial` are both structurally absent. Modals because
// they're a category error per the doctrine (rotate interior register
// instead). Spatial because panels-in-spatial is a categorical
// boundary violation per `spatial-as-endgame.md`.

export type PanelPresentationMode = "rail" | "immersive";

/** Surfaces that compose panels. Spatial intentionally excluded —
 *  the spatial app composes scene primitives per
 *  `spatial-as-endgame.md`, not panels. */
export type PanelSurface = "web" | "desktop" | "mobile";

/**
 * Per-surface availability matrix. A "–" cell in the doctrine memo
 * maps to absence from the per-surface tuple here. The type system
 * rejects attempts to render a panel in an unavailable mode at the
 * call site (e.g. `rail` on mobile). The table is not aspirational —
 * it's typed, frozen, and enforced.
 *
 * Spatial is absent from this table by design: see the registry
 * comment above + `panel-presentation-modes.md` §"Spatial: panels
 * become Presentations" for the categorical translation.
 */
export const PANEL_PRESENTATION_AVAILABILITY = {
  web: ["rail", "immersive"],
  desktop: ["rail", "immersive"],
  mobile: ["immersive"],
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
