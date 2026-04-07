/**
 * Canonical risk level labels for tool governance.
 *
 * The five risk levels are the same across every surface and every
 * storage system — they're the axes the `PolicyGate` scores tools
 * against, and they're what the user picks a preset threshold for.
 * The label strings ("R0 Read", "R1 Draft", …) were drifting across
 * four different files with four different presentation shapes
 * (Record<number, string>, { label, cls }, { label, color, bg }).
 * This module is the authoritative source for the semantic labels.
 *
 * Surfaces still own their own presentation — the CSS class in
 * desktop's chat badge, the color swatches in the mobile approval
 * card — but the label string comes from here.
 *
 * The order is the same as `PolicyGate`'s risk scoring: 0 is
 * read-only, 4 is "touches money." A tool classified above its
 * surface's `requireApprovalAbove` gets a modal; above `denyAbove`
 * gets rejected.
 */

export const RISK_LABELS: Record<number, string> = {
  0: "R0 Read",
  1: "R1 Draft",
  2: "R2 Write",
  3: "R3 Execute",
  4: "R4 Money",
};
