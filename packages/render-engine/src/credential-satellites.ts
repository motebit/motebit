/**
 * Credential satellites — the first scene-object class, shared across every
 * surface that renders a creature in a 3D scene.
 *
 * Credentials are the cleanest first target because they are small, stable,
 * and structurally list-shaped. The 2D list in each surface's settings /
 * sovereign panel still exists for configuration; this module renders the
 * canonical expression: each credential is a small glass orb orbiting the
 * creature.
 *
 * Split:
 *   - `credentialsToExpression` is a pure data transform — no THREE.
 *   - `CredentialSatelliteRenderer` mounts sphere meshes under a parent
 *     THREE.Group (typically the creature's group via
 *     `RenderAdapter.getCreatureGroup()`). Positions are recomputed each
 *     frame via the orbital parameters on each SatelliteItem.
 *
 * The module was extracted from apps/spatial to this package so web
 * (and any future surface with a 3D scene) consumes one implementation
 * instead of duplicating the geometry, palette, and orbit math.
 */

import * as THREE from "three";
import type { SatelliteExpression, SatelliteItem, SpatialExpression } from "./expression.js";
import { registerSpatialDataModule } from "./expression.js";

export const CREDENTIAL_SATELLITES_MODULE = registerSpatialDataModule({
  kind: "satellite",
  name: "credentials",
});

/** Minimal shape of a relay-issued credential. */
export interface CredentialSummary {
  readonly credential_id?: string;
  readonly credential_type: string;
  readonly issued_at: number;
  readonly credential?: {
    readonly issuanceDate?: string;
    readonly issuer?: string | { id?: string };
  };
}

const BASE_RADIUS_M = 0.18;
const RADIUS_STEP_M = 0.04;
const BASE_ORBIT_PERIOD_MS = 18_000;

/**
 * Pure transform from credential list to a SatelliteExpression.
 *
 * Assignment rules:
 *   - Hue is derived from credential_type so all credentials of the same
 *     kind share a palette (reputation, trust, gradient).
 *   - Radius grows modestly with index so satellites don't all share a
 *     single ring — the eye can separate them.
 *   - Orbit period is fixed across all satellites (18s), with phase
 *     spread around the full circle so they don't clump.
 */
export function credentialsToExpression(
  credentials: readonly CredentialSummary[],
): SatelliteExpression {
  const n = credentials.length;
  const items: SatelliteItem[] = credentials.map((cred, i) => {
    const id = cred.credential_id ?? `${cred.credential_type}:${cred.issued_at}:${i}`;
    const label = cred.credential_type.replace(/Credential$/, "").replace(/^Agent/, "");
    return {
      id,
      label: label || "credential",
      hue: hueForType(cred.credential_type),
      radius: BASE_RADIUS_M + (i % 3) * RADIUS_STEP_M,
      orbitPeriodMs: BASE_ORBIT_PERIOD_MS,
      phase: n > 0 ? (i / n) * Math.PI * 2 : 0,
    };
  });
  return { kind: "satellite", items };
}

/**
 * Deterministic hue per credential type. Keeps the palette stable across
 * reloads and between devices — the same credential is the same color
 * everywhere. Falls back to a hash for unknown types so new types land in
 * a reasonable spot on the wheel without code changes.
 */
export function hueForType(credentialType: string): number {
  switch (credentialType) {
    case "AgentReputationCredential":
      return 200; // cyan-blue
    case "AgentTrustCredential":
      return 155; // teal-green
    case "AgentGradientCredential":
      return 45; // warm amber
    default:
      return hashHue(credentialType);
  }
}

function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return ((h % 360) + 360) % 360;
}

interface SatelliteMesh {
  readonly id: string;
  readonly item: SatelliteItem;
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshPhysicalMaterial;
}

/**
 * Mounts satellite meshes under a parent THREE.Group (typically the
 * creature's group, via `RenderAdapter.getCreatureGroup()`). Call
 * `setExpression()` whenever the credential set changes; call `tick()`
 * every frame with the current timestamp in ms to animate the orbits;
 * call `dispose()` on teardown.
 */
export class CredentialSatelliteRenderer {
  private readonly group: THREE.Group;
  private readonly parent: THREE.Object3D;
  private meshes = new Map<string, SatelliteMesh>();

  constructor(parent: THREE.Object3D) {
    this.parent = parent;
    this.group = new THREE.Group();
    this.group.name = "credential-satellites";
    this.parent.add(this.group);
  }

  /** Replace the satellite set. Reuses meshes by id to minimize churn. */
  setExpression(expr: SpatialExpression): void {
    if (expr.kind !== "satellite") return;
    const next = new Map<string, SatelliteMesh>();
    for (const item of expr.items) {
      const existing = this.meshes.get(item.id);
      if (existing) {
        existing.material.color.setHSL(item.hue / 360, 0.55, 0.55);
        next.set(item.id, { ...existing, item });
      } else {
        next.set(item.id, this.createSatellite(item));
      }
    }
    // Dispose anything that didn't survive.
    for (const [id, sat] of this.meshes) {
      if (!next.has(id)) this.removeSatellite(sat);
    }
    this.meshes = next;
  }

  /** Update orbital positions for the current animation time. */
  tick(nowMs: number): void {
    for (const sat of this.meshes.values()) {
      const angle = sat.item.phase + (nowMs / sat.item.orbitPeriodMs) * Math.PI * 2;
      sat.mesh.position.set(
        Math.cos(angle) * sat.item.radius,
        Math.sin(angle * 0.5) * sat.item.radius * 0.3,
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
    const geometry = new THREE.SphereGeometry(0.012, 12, 12);
    const material = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color().setHSL(item.hue / 360, 0.55, 0.55),
      metalness: 0.0,
      roughness: 0.2,
      transmission: 0.6,
      transparent: true,
      opacity: 0.9,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `credential:${item.id}`;
    this.group.add(mesh);
    return { id: item.id, item, mesh, material };
  }

  private removeSatellite(sat: SatelliteMesh): void {
    this.group.remove(sat.mesh);
    sat.mesh.geometry.dispose();
    sat.material.dispose();
  }
}

// ── Cross-surface mount helper ────────────────────────────────────────
//
// The mount/tick/subscribe/dispose dance is identical across web, desktop,
// and any future surface with a 3D creature. Promoting it into the package
// lets every surface consume one function instead of copy-pasting the
// lifecycle. Structural typing on the source argument means render-engine
// does not have to import from runtime — MotebitRuntime satisfies the
// interface naturally (verified at the call site via tsc).

/**
 * Minimal shape render-engine needs to render credential satellites.
 * `MotebitRuntime` satisfies this interface — surfaces pass the runtime
 * directly. Kept structural (not a class) so render-engine stays layer-2
 * and does not take on `@motebit/runtime` as a dependency.
 */
export interface CredentialSource {
  getIssuedCredentials(): ReadonlyArray<{
    readonly type: readonly string[];
    readonly validFrom?: string;
    readonly issuer: string | { readonly id?: string };
  }>;
  /** Subscribe to credential-set changes. Returns unsubscribe. */
  onCredentialsChanged(fn: () => void): () => void;
}

export interface CredentialSatelliteController {
  /** Call every animation frame with the current timestamp in ms. */
  tick(nowMs: number): void;
  /** Dispose the renderer and unsubscribe from credential changes. */
  dispose(): void;
}

/**
 * Mount the credential satellite renderer under a parent group and wire
 * it to credential-source changes. Returns a controller whose `tick` is
 * called each frame and `dispose` releases every mesh + unsubscribes.
 *
 * Returns null when `parent` is null — callers pass `adapter.getCreatureGroup()`
 * directly and get a safe no-op when the adapter has no scene graph
 * (headless tests, mobile WebView boundary, pre-init).
 */
export function mountCredentialSatellites(
  parent: THREE.Object3D | null,
  source: CredentialSource,
): CredentialSatelliteController | null {
  if (!parent) return null;

  const renderer = new CredentialSatelliteRenderer(parent);
  const refresh = (): void => {
    const summaries: CredentialSummary[] = source.getIssuedCredentials().map((vc) => ({
      credential_type: vc.type.find((t) => t !== "VerifiableCredential") ?? "Credential",
      issued_at: typeof vc.validFrom === "string" ? new Date(vc.validFrom).getTime() : Date.now(),
      credential: {
        issuanceDate: typeof vc.validFrom === "string" ? vc.validFrom : undefined,
        issuer: typeof vc.issuer === "string" ? vc.issuer : vc.issuer,
      },
    }));
    renderer.setExpression(credentialsToExpression(summaries));
  };

  refresh();
  const unsubscribe = source.onCredentialsChanged(refresh);

  return {
    tick: (nowMs) => renderer.tick(nowMs),
    dispose: () => {
      unsubscribe();
      renderer.dispose();
    },
  };
}
