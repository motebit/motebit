/**
 * Memory environment — the standing memory mass as the ambient medium of the
 * scene. The spatial register of the memory felt record
 * (`docs/doctrine/felt-interior.md` §5): "what the interior holds, at rest,"
 * expressed as the canonical Environment primitive — a faint mote haze
 * surrounding the creature, never a panel and never a number.
 *
 * The §5 honesty model survives the translation, structurally:
 *   - CONTENT-FREE — the projection reads only two integers (held + fading),
 *     never memory content. `EnvironmentExpression` is `{ density, tone }` — two
 *     scalars — so memory content cannot enter the scene by construction, the
 *     same way `FeltMemoryNode` is content-free on the flat surfaces.
 *   - SENSITIVITY-BLIND — held/fading are bare counts across every tier; a
 *     medical/secret memory adds to the mass exactly like any other, never to a
 *     named or distinguishable mote. The haze cannot leak what it is made of.
 *   - NO SCORE, NO TREND — density is a *saturating* function of the held mass
 *     (it plateaus toward 1, it does not climb without bound), so the haze is
 *     ambient texture, not a growing number to perform for (§"What not to build":
 *     a memory count is the most natural vanity metric — the saturation is the
 *     guard). The projection is stateless: same mass → same haze, no delta, no
 *     growth animation, no history.
 *   - DEPTH IS THE QUIET HOLD-AND-SHED — `tone` is the present hold/shed balance
 *     (a fresh graph reads warm, a heavily-fading one cool), a present-state
 *     bucket, never a trajectory.
 *
 * Versus the orbiting satellites: the memory haze is the OUTER ambient shell
 * (~0.45–1.1m), beyond the receipt ring (~0.26m) and the trust constellation
 * (~0.16–0.22m). The depth ordering reads as relationships closest, activity
 * mid, the memory *medium* as the field everything sits inside —
 * "the spectral medium" ([`liquescentia-as-substrate.md`]). Mounts on the
 * creature group like the satellites, so the field travels with the creature as
 * its own carried interior.
 *
 * The coordinator is a pure projection: `setMemory` takes the content-free
 * `{ held, fading }` summary; the host computes it from the local graph and
 * feeds it in (render-engine never touches memory semantics or decay).
 */

import * as THREE from "three";
import type { EnvironmentExpression, SpatialExpression } from "./expression.js";
import { registerSpatialDataModule } from "./expression.js";

export const MEMORY_ENVIRONMENT_MODULE = registerSpatialDataModule({
  kind: "environment",
  name: "memory",
});

/** The content-free memory-mass summary the projection reads. Bare counts only
 *  — no node ids, no content, no sensitivity. `held` is the live (non-tombstoned)
 *  node count; `fading` is the near-death count (decayed below the threshold,
 *  not pinned), the canonical shed signal from `auditMemoryGraph`. */
export interface MemoryMassSummary {
  readonly held: number;
  readonly fading: number;
}

/**
 * Held mass at which the haze reaches half its maximum density. The density
 * curve `held / (held + HALF_DENSITY_AT)` saturates toward 1, so the haze is
 * ambient texture that plateaus — deliberately NOT a linear count that could
 * read as a climbing score (§5 "What not to build").
 */
const HALF_DENSITY_AT = 60;

/** Above this fading fraction the graph is visibly shedding → cool. */
const SHED_COOL_FRACTION = 0.3;
/** Below this fading fraction the graph is freshly held → warm. */
const SHED_WARM_FRACTION = 0.1;

/**
 * Pure projection: the content-free memory-mass summary → EnvironmentExpression.
 * Density saturates (never unbounded); tone is the present hold/shed balance.
 * Stateless and deterministic — same summary always yields the same expression.
 */
export function memoryToEnvironment(summary: MemoryMassSummary): EnvironmentExpression {
  const held = Math.max(0, summary.held);
  const fading = Math.max(0, Math.min(summary.fading, held));
  const density = held === 0 ? 0 : held / (held + HALF_DENSITY_AT);

  let tone: EnvironmentExpression["tone"] = "neutral";
  if (held > 0) {
    const shed = fading / held;
    if (shed >= SHED_COOL_FRACTION) tone = "cool";
    else if (shed <= SHED_WARM_FRACTION) tone = "warm";
  }
  return { kind: "environment", density, tone };
}

/** Hue for the present tone. Faint, low-saturation haze — a calm tint, not a
 *  signal color. Kept inside [0, 360). */
export function hueForTone(tone: EnvironmentExpression["tone"]): number {
  switch (tone) {
    case "warm":
      return 38; // warm gold — freshly held, alive
    case "cool":
      return 220; // cool blue — quietly shedding
    case "neutral":
      return 180; // teal-neutral — at rest
  }
}

/** Total motes in the shell; density renders a prefix of them via draw range. */
const MAX_MOTES = 240;
const SHELL_INNER_M = 0.45;
const SHELL_OUTER_M = 1.1;
/** Full revolution of the slow ambient drift, in ms. */
const DRIFT_PERIOD_MS = 240_000;

/**
 * Renders the memory mass as a faint mote haze. One fixed point cloud in a
 * spherical shell; density controls how many motes are drawn (a prefix via
 * `setDrawRange`) and tone their hue. Cheap — no geometry churn on update, just
 * the draw range and material color. Mirrors the satellite renderers'
 * attach/set/tick/dispose lifecycle.
 *
 * Deterministic mote layout: positions are seeded by a small LCG (no
 * `Math.random`) so the haze is stable across frames and reloads.
 */
export class MemoryEnvironmentRenderer {
  private readonly group: THREE.Group;
  private readonly parent: THREE.Object3D;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.PointsMaterial;
  private readonly points: THREE.Points;

  constructor(parent: THREE.Object3D) {
    this.parent = parent;
    this.group = new THREE.Group();
    this.group.name = "memory-environment";

    const positions = new Float32Array(MAX_MOTES * 3);
    // Deterministic shell distribution via a tiny LCG — stable, no Math.random.
    let seed = 0x9e3779b9;
    const rand = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };
    for (let i = 0; i < MAX_MOTES; i++) {
      // Uniform direction on the sphere, radius in the shell band.
      const u = rand() * 2 - 1;
      const theta = rand() * Math.PI * 2;
      const r = SHELL_INNER_M + rand() * (SHELL_OUTER_M - SHELL_INNER_M);
      const s = Math.sqrt(1 - u * u);
      positions[i * 3] = Math.cos(theta) * s * r;
      positions[i * 3 + 1] = u * r;
      positions[i * 3 + 2] = Math.sin(theta) * s * r;
    }
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.geometry.setDrawRange(0, 0);

    this.material = new THREE.PointsMaterial({
      color: new THREE.Color().setHSL(hueForTone("neutral") / 360, 0.35, 0.6),
      size: 0.01,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.name = "memory-motes";
    this.group.add(this.points);
    this.parent.add(this.group);
  }

  setExpression(expr: SpatialExpression): void {
    if (expr.kind !== "environment") return;
    const visible = Math.round(Math.max(0, Math.min(1, expr.density)) * MAX_MOTES);
    this.geometry.setDrawRange(0, visible);
    this.material.color.setHSL(hueForTone(expr.tone) / 360, 0.35, 0.6);
  }

  /** Slow ambient drift — the field rotates gently so it reads as alive, never
   *  as a static decal. No per-mote work; rotates the whole group. */
  tick(nowMs: number): void {
    this.group.rotation.y = (nowMs / DRIFT_PERIOD_MS) * Math.PI * 2;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.parent.remove(this.group);
  }
}

/**
 * Owns the memory-mass → render flow.
 *
 * - `setMemory(summary)` projects the content-free mass summary and re-renders.
 *   Safe before `attach()` — the projection persists and flushes on attach.
 * - `attach(parent)` mounts the renderer under `parent` (the creature group).
 * - `tick(nowMs)` drifts the field; no-op when unattached.
 * - `dispose()` detaches and clears.
 *
 * Pure of `@motebit/runtime` and of memory-decay semantics — the host computes
 * the `{ held, fading }` summary and feeds it in, keeping this unit-testable
 * with plain integers.
 */
export class MemoryEnvironmentCoordinator {
  private expression: EnvironmentExpression = { kind: "environment", density: 0, tone: "neutral" };
  private renderer: MemoryEnvironmentRenderer | null = null;

  attach(parent: THREE.Object3D): void {
    if (this.renderer) return;
    this.renderer = new MemoryEnvironmentRenderer(parent);
    this.flush();
  }

  detach(): void {
    if (!this.renderer) return;
    this.renderer.dispose();
    this.renderer = null;
  }

  /** Replace the haze from the current memory mass. */
  setMemory(summary: MemoryMassSummary): void {
    this.expression = memoryToEnvironment(summary);
    this.flush();
  }

  tick(nowMs: number): void {
    this.renderer?.tick(nowMs);
  }

  /** Exposed for tests — the current projected expression. */
  current(): EnvironmentExpression {
    return this.expression;
  }

  dispose(): void {
    this.detach();
    this.expression = { kind: "environment", density: 0, tone: "neutral" };
  }

  private flush(): void {
    this.renderer?.setExpression(this.expression);
  }
}
