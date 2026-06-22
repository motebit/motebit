/**
 * Accrual orbit — the leverage moment materialized in 3D space.
 *
 * The spatial register of felt-accumulation (`docs/doctrine/felt-accumulation.md`):
 * when a turn DREW UPON accrued state (a recalled memory, a trust edge), a calm
 * orb emerges in the mid-ring, briefly orbits the creature drawing on the memory
 * haze it sits within, then FADES and is evicted. This is the generalization of
 * records-vs-acts' "a credential briefly orbits during the delegation that uses
 * it, then fades" (`CredentialSatelliteRenderer`) from credentials to all accrued
 * state — the leverage moment is an ACT, never a record, so it is temporally
 * bounded and fades (records-vs-acts.md: "If the visual stays after the act ends,
 * it's drifted into record territory. Add a fade.").
 *
 * Versus the trust constellation (persistent, inner ≤0.22m) and the receipt ring
 * (outer ≥0.26m): the accrual orbit rides the MID ring (~0.205m), so a glance
 * separates *what I just drew upon* (transient, mid) from *who I know* (persistent,
 * inner) and *what I just did* (receipts, outer). The mid ring sits inside the
 * memory haze shell (0.45m+), so the orb visibly draws from the haze.
 *
 * Honesty survives the translation: NO AGGREGATE — each leverage moment is its
 * own transient orb, never a count, a climbing ring, or a score (the §What-not-to-
 * build refusal in space); the orbit is read, never summed. Locked by
 * `check-accrual-basis-canonical` at the type — this renderer carries no count.
 *
 * Pure of `@motebit/protocol`: `AccrualOrbKind` is a local string union (same
 * shape as `AccrualKind`) so the module takes no protocol dependency and tests
 * pass plain strings — exactly like trust-satellites' `TrustTier`. The clock is
 * injected (no `Date.now()`), so the fade is deterministic in tests.
 */

import * as THREE from "three";
import type { SatelliteExpression, SatelliteItem, SpatialExpression } from "./expression.js";
import { registerSpatialDataModule } from "./expression.js";

export const ACCRUAL_SATELLITES_MODULE = registerSpatialDataModule({
  kind: "satellite",
  name: "accrual",
});

/** The accrual kinds the orbit renders — mirror of `@motebit/protocol`'s
 *  `AccrualKind`, kept local so this module takes no protocol dependency. */
export type AccrualOrbKind =
  | "recalled_memory"
  | "trust_edge"
  | "consolidated_fact"
  | "prior_approval_pattern"
  | "standing_delegation";

/** Hue per accrual kind — a distinct calm palette so a glance reads which
 *  faculty was drawn upon. Kept in [0, 360). */
export function hueForAccrualKind(kind: AccrualOrbKind): number {
  switch (kind) {
    case "recalled_memory":
      return 200; // blue — memory
    case "consolidated_fact":
      return 60; // gold — synthesis
    case "trust_edge":
      return 130; // green — relationship (matches the trust constellation)
    case "prior_approval_pattern":
      return 30; // amber — a learned choice
    case "standing_delegation":
      return 280; // violet — a signed grant
    default:
      return 200;
  }
}

const ORBIT_PERIOD_MS = 12_000; // faster than trust (36s) — activity, not relationship
const ORB_RADIUS_M = 0.012;
const RING_RADIUS_M = 0.205; // mid ring: inside receipts (0.26m+), outside trust (≤0.22m)
const RING_JITTER_M = 0.012; // so two concurrent orbs never sit dead-on
const BASE_OPACITY = 0.9;
const LIFETIME_MS = 9_000; // the act's bounded life
const FADE_MS = 3_000; // the last 3s fade to nothing (an act fades, never hard-cuts)
const MAX_ORBS = 5; // calm — a few concurrent leverage moments, oldest evicted
const GOLDEN_ANGLE = 2.399963; // spread successive orbs around the ring

/** A live leverage orb — the act, with its birth time for the bounded fade. */
interface AccrualOrb {
  readonly id: string;
  readonly kind: AccrualOrbKind;
  readonly bornMs: number;
  readonly phase: number;
}

/**
 * Opacity for an orb of the given age — full until the fade window opens, then
 * linear to 0 at end of life. Exported for tests. Pure.
 */
export function opacityForAge(ageMs: number): number {
  if (ageMs <= LIFETIME_MS - FADE_MS) return 1;
  if (ageMs >= LIFETIME_MS) return 0;
  return (LIFETIME_MS - ageMs) / FADE_MS;
}

/** Pure transform: live orbs → SatelliteExpression. No aggregate is computed. */
export function orbsToExpression(orbs: readonly AccrualOrb[]): SatelliteExpression {
  const items: SatelliteItem[] = orbs.map((o, i) => ({
    id: o.id,
    label: o.kind,
    hue: hueForAccrualKind(o.kind),
    radius: RING_RADIUS_M + (i % 2) * RING_JITTER_M,
    orbitPeriodMs: ORBIT_PERIOD_MS,
    phase: o.phase,
  }));
  return { kind: "satellite", items };
}

interface SatelliteMesh {
  readonly id: string;
  readonly item: SatelliteItem;
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshPhysicalMaterial;
}

/**
 * Low-level renderer. Mirrors `TrustSatelliteRenderer`; callers typically use
 * `AccrualSatelliteCoordinator`. Group `accrual-satellites`, meshes `accrual:${id}`,
 * so the orbit reads distinctly from trust + receipts in the scene graph. `tick`
 * takes a per-orb opacity map (the coordinator owns the fade clock).
 */
export class AccrualSatelliteRenderer {
  private readonly group: THREE.Group;
  private readonly parent: THREE.Object3D;
  private meshes = new Map<string, SatelliteMesh>();

  constructor(parent: THREE.Object3D) {
    this.parent = parent;
    this.group = new THREE.Group();
    this.group.name = "accrual-satellites";
    this.parent.add(this.group);
  }

  setExpression(expr: SpatialExpression): void {
    if (expr.kind !== "satellite") return;
    const next = new Map<string, SatelliteMesh>();
    for (const item of expr.items) {
      const existing = this.meshes.get(item.id);
      if (existing) {
        existing.material.color.setHSL(item.hue / 360, 0.55, 0.6);
        next.set(item.id, { ...existing, item });
      } else {
        next.set(item.id, this.createSatellite(item));
      }
    }
    for (const [id, sat] of this.meshes) {
      if (!next.has(id)) this.removeSatellite(sat);
    }
    this.meshes = next;
  }

  tick(nowMs: number, opacityById: ReadonlyMap<string, number>): void {
    for (const sat of this.meshes.values()) {
      const angle = sat.item.phase + (nowMs / sat.item.orbitPeriodMs) * Math.PI * 2;
      sat.mesh.position.set(
        Math.cos(angle) * sat.item.radius,
        Math.sin(angle * 0.5) * sat.item.radius * 0.25,
        Math.sin(angle) * sat.item.radius,
      );
      const fade = opacityById.get(sat.id) ?? BASE_OPACITY;
      sat.material.opacity = BASE_OPACITY * fade;
      sat.mesh.visible = fade > 0.01;
    }
  }

  dispose(): void {
    for (const sat of this.meshes.values()) this.removeSatellite(sat);
    this.meshes.clear();
    this.parent.remove(this.group);
  }

  private createSatellite(item: SatelliteItem): SatelliteMesh {
    const geometry = new THREE.SphereGeometry(ORB_RADIUS_M, 14, 14);
    const material = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color().setHSL(item.hue / 360, 0.55, 0.6),
      metalness: 0.05,
      roughness: 0.2,
      clearcoat: 0.4,
      transmission: 0.55,
      transparent: true,
      opacity: BASE_OPACITY,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `accrual:${item.id}`;
    this.group.add(mesh);
    return { id: item.id, item, mesh, material };
  }

  private removeSatellite(sat: SatelliteMesh): void {
    this.group.remove(sat.mesh);
    sat.mesh.geometry.dispose();
    sat.material.dispose();
  }
}

/**
 * Owns the leverage-moment → orbit flow.
 *
 * - `addAccrual(kind, nowMs)` emerges a transient orb (golden-angle spread, born
 *   at `nowMs`), evicting the oldest past the cap. Safe before `attach()`.
 * - `attach(parent)` creates a renderer under `parent` and flushes.
 * - `tick(nowMs)` evicts expired orbs (age ≥ lifetime) and animates the rest with
 *   their fade. The injected `nowMs` keeps the fade deterministic in tests.
 * - `dispose()` detaches and clears.
 *
 * Pure of `@motebit/runtime` and `@motebit/protocol` — the host subscribes to the
 * produced `AccrualBasis` stream and feeds `basis.kind` in.
 */
export class AccrualSatelliteCoordinator {
  private orbs: AccrualOrb[] = [];
  private renderer: AccrualSatelliteRenderer | null = null;
  private counter = 0;

  attach(parent: THREE.Object3D): void {
    if (this.renderer) return;
    this.renderer = new AccrualSatelliteRenderer(parent);
    this.flush();
  }

  detach(): void {
    if (!this.renderer) return;
    this.renderer.dispose();
    this.renderer = null;
  }

  /** Emerge a leverage orb for a produced basis kind, born at `nowMs`. */
  addAccrual(kind: AccrualOrbKind, nowMs: number): void {
    const id = `a${this.counter}`;
    const phase = (this.counter * GOLDEN_ANGLE) % (Math.PI * 2);
    this.counter += 1;
    this.orbs.push({ id, kind, bornMs: nowMs, phase });
    if (this.orbs.length > MAX_ORBS) this.orbs.shift(); // evict the oldest
    this.flush();
  }

  tick(nowMs: number): void {
    const before = this.orbs.length;
    this.orbs = this.orbs.filter((o) => nowMs - o.bornMs < LIFETIME_MS);
    if (this.orbs.length !== before) this.flush();
    if (!this.renderer) return;
    const opacityById = new Map<string, number>(
      this.orbs.map((o) => [o.id, opacityForAge(nowMs - o.bornMs)]),
    );
    this.renderer.tick(nowMs, opacityById);
  }

  /** Exposed for tests — the live (un-evicted) orb count. */
  size(): number {
    return this.orbs.length;
  }

  dispose(): void {
    this.detach();
    this.orbs = [];
  }

  private flush(): void {
    if (!this.renderer) return;
    this.renderer.setExpression(orbsToExpression(this.orbs));
  }
}
