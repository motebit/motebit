/**
 * Typed registry of the six side-rail panels per
 * `docs/doctrine/panel-temporal-registers.md`.
 *
 * Records surfaces only (panels are records per
 * `docs/doctrine/records-vs-acts.md`); the body is the act surface.
 *
 * `register` = temporal mode. `identity` is retrospective
 * (past → present, "who motebit has become"). `runtime` is
 * prospective (present → future, "what motebit can/will do").
 *
 * `primitive` = which of the five protocol primitives this surface
 * exposes. Governance is deliberately absent — it is the membrane,
 * not a record. Attempting to declare a panel with
 * `primitive: "governance"` is a type error, which is the structural
 * enforcement of the records-vs-acts boundary on the panel side.
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
