/**
 * Trust constellation — the first-person trust graph materialized in 3D space.
 *
 * The spatial register of the trust felt record (`docs/doctrine/felt-interior.md`
 * §6): the owner glancing at *their graph deepening*, the relational analogue of
 * the flat surfaces' `resolveFeltTrust`. Each Known peer becomes a calm orb
 * orbiting the creature; the constellation's *shape* — how many orbs ride the
 * inner bands versus the outer — is the felt depth, never a number.
 *
 * The §6 honesty model survives the translation intact, structurally:
 *   - PROVEN-ONLY — built from the local Known trust edges (`listTrustedAgents`,
 *     proven from receipts). A relay-claimed Discover row is never an edge and
 *     never enters; the input slice carries only what a Known edge has.
 *   - NO AGGREGATE — there is no global-reputation orb, bar, or score. Each peer
 *     is its own orb (a first-person edge); the scene refuses the aggregate the
 *     trust graph exists to refuse. The constellation is read, never summed.
 *   - BLOCKED EXCLUDED — a `blocked` edge is not trust *held* and is dropped
 *     entirely (parallel to a tombstoned memory excluded from the resting mass).
 *   - DEPTH, NOT TREND — tier is the present state, shown as an orbital band:
 *     deeper trust orbits *closer* to the creature (the graph drawing inward),
 *     never a delta or a growth animation.
 *
 * Versus the receipt satellites (`apps/spatial/src/receipt-satellites.ts`): an
 * INNER constellation (≤0.23m vs the receipt ring's 0.26m+) so a glance separates
 * *who I know* (relationships, inner) from *what I just did* (receipts, outer); a
 * slower orbit (36s vs 24s) — relationships are weightier than activity. The
 * renderer mirrors `CredentialSatelliteRenderer` in this package; a future refactor
 * MAY unify the satellite renderers behind a common base if it earns its keep.
 *
 * The coordinator is a pure projection: `setPeers` takes the structural edge
 * slice (so tests pass plain objects and the module takes no `@motebit/protocol`
 * dependency); the host polls `runtime.listTrustedAgents()` and feeds it in.
 */

import * as THREE from "three";
import type { SatelliteExpression, SatelliteItem, SpatialExpression } from "./expression.js";
import { registerSpatialDataModule } from "./expression.js";

export const TRUST_SATELLITES_MODULE = registerSpatialDataModule({
  kind: "satellite",
  name: "trust",
});

/** The earned tiers the constellation renders. `blocked`/`unknown` are handled
 *  by `tierOf` — blocked is excluded, unknown folds into the entry tier. */
export type TrustTier = "first_contact" | "verified" | "trusted";

const ORBIT_PERIOD_MS = 36_000;
const ORB_RADIUS_M = 0.013;
/** Within-tier radius alternation so two same-tier orbs never sit dead-on. */
const RING_JITTER_M = 0.008;
/** The scene shows the constellation's tail; the full graph lives in storage
 *  and on the flat-surface Known tab. Cap keeps a long-lived graph calm. */
const MAX_PEERS = 18;

/** Tier rank for capping / band order. Higher = deeper trust = inner orbit. */
const TIER_RANK: Record<TrustTier, number> = {
  first_contact: 1,
  verified: 2,
  trusted: 3,
};

/**
 * Hue per earned tier — a calm cool→warm gradient as trust deepens. Mirrors the
 * Known-tab trust-aura intent: nothing below `verified` has earned a warm glow.
 * Kept inside [0, 360).
 */
export function hueForTrustTier(tier: TrustTier): number {
  switch (tier) {
    case "first_contact":
      return 210; // cool blue — an early edge, met but not yet earned
    case "verified":
      return 160; // teal — a verified identity edge
    case "trusted":
      return 130; // green — the deepest earned tier
  }
}

/** Orbital band per tier — deeper trust orbits closer to the creature (the
 *  graph drawing inward). All bands sit inside the receipt ring (0.26m+). */
function radiusForTier(tier: TrustTier): number {
  switch (tier) {
    case "trusted":
      return 0.16; // innermost — closest
    case "verified":
      return 0.19;
    case "first_contact":
      return 0.22; // outermost of the inner constellation
  }
}

/**
 * Map a trust level to its rendered tier. `blocked` returns null (excluded —
 * not trust held); `unknown` and any forward-compat future level fold into the
 * entry tier (`first_contact`), so an upgraded runtime degrades calmly rather
 * than vanishing a peer.
 */
export function tierOf(level: string): TrustTier | null {
  switch (level) {
    case "blocked":
      return null;
    case "trusted":
      return "trusted";
    case "verified":
      return "verified";
    case "first_contact":
    case "unknown":
    default:
      return "first_contact";
  }
}

/** The minimal structural slice of a Known trust edge the projection reads.
 *  `AgentTrustRecord` satisfies it; tests pass plain objects. Deliberately
 *  carries no aggregate, quality score, petname, or content — shape only. */
export interface TrustEdgeInput {
  readonly remote_motebit_id: string;
  readonly trust_level: string;
  readonly last_seen_at: number;
}

/** Per-peer projection the renderer consumes (post-filter, post-cap). */
export interface TrustPeerSummary {
  readonly id: string;
  readonly tier: TrustTier;
}

/**
 * Pure transform: ordered peer summaries → SatelliteExpression. Peers are
 * grouped by tier so each band spreads its own orbs evenly around the circle
 * (no clumping), with a slight radius alternation so two same-tier orbs at the
 * same phase don't overlap. No aggregate is ever computed.
 */
export function peersToExpression(peers: readonly TrustPeerSummary[]): SatelliteExpression {
  const byTier: Record<TrustTier, TrustPeerSummary[]> = {
    trusted: [],
    verified: [],
    first_contact: [],
  };
  for (const p of peers) byTier[p.tier].push(p);

  const items: SatelliteItem[] = [];
  for (const tier of ["trusted", "verified", "first_contact"] as const) {
    const group = byTier[tier];
    const n = group.length;
    group.forEach((p, i) => {
      items.push({
        id: p.id,
        label: tier,
        hue: hueForTrustTier(tier),
        radius: radiusForTier(tier) + (i % 2) * RING_JITTER_M,
        orbitPeriodMs: ORBIT_PERIOD_MS,
        phase: n > 0 ? (i / n) * Math.PI * 2 : 0,
      });
    });
  }
  return { kind: "satellite", items };
}

/**
 * Project the raw Known trust edges into capped, sorted peer summaries —
 * blocked dropped, deepest+most-recent kept when the graph exceeds the cap.
 * Pure; exported for tests.
 */
export function projectTrustPeers(edges: readonly TrustEdgeInput[]): TrustPeerSummary[] {
  const kept: Array<TrustPeerSummary & { lastSeenAt: number }> = [];
  for (const e of edges) {
    const tier = tierOf(e.trust_level);
    if (tier === null) continue; // blocked — not trust held
    kept.push({ id: e.remote_motebit_id, tier, lastSeenAt: e.last_seen_at });
  }
  // Most-established first, then most-recently-seen — the meaningful tail.
  kept.sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier] || b.lastSeenAt - a.lastSeenAt);
  return kept.slice(0, MAX_PEERS).map(({ id, tier }) => ({ id, tier }));
}

interface SatelliteMesh {
  readonly id: string;
  readonly item: SatelliteItem;
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshPhysicalMaterial;
}

/**
 * Low-level renderer. Mirrors `ReceiptSatelliteRenderer`; callers typically use
 * `TrustConstellationCoordinator`. Group named `trust-satellites`, meshes
 * `trust:${id}`, so the constellation reads distinctly from receipts in the
 * scene graph.
 */
export class TrustSatelliteRenderer {
  private readonly group: THREE.Group;
  private readonly parent: THREE.Object3D;
  private meshes = new Map<string, SatelliteMesh>();

  constructor(parent: THREE.Object3D) {
    this.parent = parent;
    this.group = new THREE.Group();
    this.group.name = "trust-satellites";
    this.parent.add(this.group);
  }

  setExpression(expr: SpatialExpression): void {
    if (expr.kind !== "satellite") return;
    const next = new Map<string, SatelliteMesh>();
    for (const item of expr.items) {
      const existing = this.meshes.get(item.id);
      if (existing) {
        existing.material.color.setHSL(item.hue / 360, 0.5, 0.55);
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

  tick(nowMs: number): void {
    for (const sat of this.meshes.values()) {
      const angle = sat.item.phase + (nowMs / sat.item.orbitPeriodMs) * Math.PI * 2;
      sat.mesh.position.set(
        Math.cos(angle) * sat.item.radius,
        Math.sin(angle * 0.5) * sat.item.radius * 0.25,
        Math.sin(angle) * sat.item.radius,
      );
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
      color: new THREE.Color().setHSL(item.hue / 360, 0.5, 0.55),
      metalness: 0.05,
      roughness: 0.2,
      clearcoat: 0.4,
      transmission: 0.55,
      transparent: true,
      opacity: 0.9,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `trust:${item.id}`;
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
 * Owns the Known-edges → render flow.
 *
 * - `setPeers(edges)` projects the local Known trust edges (blocked excluded,
 *   capped) and re-renders. Safe to call before `attach()` — the projection
 *   persists, so peers loaded during boot land in the scene on first attach.
 * - `attach(parent)` creates a renderer under `parent` and flushes.
 * - `tick(nowMs)` animates orbits; no-op when unattached.
 * - `dispose()` detaches and clears.
 *
 * Pure of `@motebit/runtime` — the host fetches `listTrustedAgents()` and feeds
 * the records in, keeping this coordinator unit-testable with plain objects.
 */
export class TrustConstellationCoordinator {
  private peers: TrustPeerSummary[] = [];
  private renderer: TrustSatelliteRenderer | null = null;

  attach(parent: THREE.Object3D): void {
    if (this.renderer) return;
    this.renderer = new TrustSatelliteRenderer(parent);
    this.flush();
  }

  detach(): void {
    if (!this.renderer) return;
    this.renderer.dispose();
    this.renderer = null;
  }

  /** Replace the constellation from the current Known trust edges. */
  setPeers(edges: readonly TrustEdgeInput[]): void {
    this.peers = projectTrustPeers(edges);
    this.flush();
  }

  tick(nowMs: number): void {
    this.renderer?.tick(nowMs);
  }

  /** Exposed for tests — the rendered (post-filter, post-cap) peer count. */
  size(): number {
    return this.peers.length;
  }

  dispose(): void {
    this.detach();
    this.peers = [];
  }

  private flush(): void {
    if (!this.renderer) return;
    this.renderer.setExpression(peersToExpression(this.peers));
  }
}
