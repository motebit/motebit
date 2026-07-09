/**
 * The golden-frame matrix (docs/doctrine/creature-canon.md §proof contract).
 *
 * 16 frames, pruned from the full 6×6×2 cross-product on the principle
 * that performance differences are legible from the front and angle
 * differences are legible at rest:
 *
 *  - 5 poses × resting/light — geometry, material, and environment sweep
 *  - 5 performances × front/light — the full performance sweep at the
 *    identity pose
 *  - thinking + speaking × three_quarter — the interior glow must read
 *    off-axis, not just head-on
 *  - hero × resting + thinking — the product shot
 *  - front × resting × dark — the dark-environment path (acceptance
 *    surface for the designed-night preset)
 *  - front × guarded with a Minimal-trust override — the structural
 *    suppression path (glow zeroed, eyes capped, boundary thickened)
 *
 * check-creature-canon enforces that every CanonicalCameraName and every
 * PerformanceName appears at least once — a new pose or performance
 * cannot land without golden coverage.
 */

import { TrustMode } from "@motebit/sdk";
import type { GoldenFrameSpec } from "@motebit/render-engine";

/** Stable snapshot name for a matrix entry. */
export function goldenFrameName(spec: GoldenFrameSpec): string {
  const trust = spec.trustMode ? `-${spec.trustMode}` : "";
  return `${spec.camera}-${spec.performance}-${spec.environment}${trust}`;
}

export const GOLDEN_MATRIX: readonly GoldenFrameSpec[] = [
  // Pose sweep at rest
  { camera: "front", performance: "resting", environment: "light" },
  { camera: "three_quarter", performance: "resting", environment: "light" },
  { camera: "oblique", performance: "resting", environment: "light" },
  { camera: "profile", performance: "resting", environment: "light" },
  { camera: "back", performance: "resting", environment: "light" },
  // Performance sweep at the identity pose
  { camera: "front", performance: "tending", environment: "light" },
  { camera: "front", performance: "listening", environment: "light" },
  { camera: "front", performance: "thinking", environment: "light" },
  { camera: "front", performance: "speaking", environment: "light" },
  { camera: "front", performance: "guarded", environment: "light" },
  // Interior glow off-axis
  { camera: "three_quarter", performance: "thinking", environment: "light" },
  { camera: "three_quarter", performance: "speaking", environment: "light" },
  // The product shot
  { camera: "hero", performance: "resting", environment: "light" },
  { camera: "hero", performance: "thinking", environment: "light" },
  // Dark-environment path — the designed night's acceptance surface
  // (creature-canon.md: face, material character, breathing must read)
  { camera: "front", performance: "resting", environment: "dark" },
  { camera: "front", performance: "thinking", environment: "dark" },
  // Minimal-trust structural suppression
  { camera: "front", performance: "guarded", environment: "light", trustMode: TrustMode.Minimal },
];
