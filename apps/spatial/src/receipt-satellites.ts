/**
 * Receipt satellites — the signed delegation chain materialized in 3D space.
 *
 * Same doctrine as credential-satellites: structured data lives in the scene,
 * not a panel. A completed task's receipt emerges as a glass orb in an outer
 * ring around the creature, colored by the local verification state:
 *
 *   amber  → verifying
 *   green  → chain verified, task succeeded
 *   orange → chain verified, task reported failure
 *   red    → chain verification failed
 *
 * The citation IS the orb. No footnote. No URL. Local Ed25519 over JCS
 * canonical JSON runs in-browser via `@motebit/encryption.verifyReceiptChain`.
 *
 * Shape choices versus credentials:
 *   - Outer ring (0.26m base vs 0.18m) so receipts and credentials occupy
 *     distinct orbital bands. A glance separates identity (credentials) from
 *     activity (receipts).
 *   - Slower orbit (24s vs 18s) — receipts feel weightier than credentials.
 *   - Slightly larger orb (0.015m vs 0.012m) and a touch more clearcoat —
 *     the record-versus-badge distinction.
 *
 * The coordinator owns the state machine (capture → verify → render). The
 * renderer is the visual only. Both are exported so callers can compose
 * either granularity.
 */

import * as THREE from "three";
import type { ExecutionReceipt } from "@motebit/sdk";
import { verifyReceiptChain } from "@motebit/encryption";
import type { SatelliteExpression, SatelliteItem, SpatialExpression } from "./spatial-expression";
import { registerSpatialDataModule } from "./spatial-expression";

export const RECEIPT_SATELLITES_MODULE = registerSpatialDataModule({
  kind: "satellite",
  name: "receipts",
});

export type ReceiptVerifyState = "pending" | "verified" | "task-failed" | "failed";

const BASE_RADIUS_M = 0.26;
const RADIUS_STEP_M = 0.03;
const ORBIT_PERIOD_MS = 24_000;
const ORB_RADIUS_M = 0.015;
const MAX_RECEIPTS = 12;

/**
 * Deterministic hue per verification state. Matches the palette used by
 * the web surface's receipt artifact pending/verified/failed/is-failed
 * states so a user carrying mental models between surfaces sees the same
 * semiotic signal.
 */
export function hueForVerifyState(state: ReceiptVerifyState): number {
  switch (state) {
    case "pending":
      return 45; // amber
    case "verified":
      return 140; // green-teal
    case "task-failed":
      return 25; // orange — chain is fine, task reported failed
    case "failed":
      return 0; // red — chain verification failed
  }
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "").trim();
  if (clean.length % 2 !== 0) throw new Error("invalid hex");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Collect every `public_key` embedded in a receipt tree keyed by
 * `motebit_id`. The relay-optional doctrine: a receipt carries its own
 * verification key, so chain verification needs no registry lookup.
 */
export function collectKnownKeys(receipt: ExecutionReceipt): Map<string, Uint8Array> {
  const keys = new Map<string, Uint8Array>();
  const visit = (r: ExecutionReceipt): void => {
    if (typeof r.public_key === "string" && r.public_key.length > 0) {
      try {
        keys.set(r.motebit_id, hexToBytes(r.public_key));
      } catch {
        // Malformed key — let verify fail-closed on this branch.
      }
    }
    for (const child of r.delegation_receipts ?? []) visit(child);
  };
  visit(receipt);
  return keys;
}

/** Per-receipt projection the renderer consumes. Keeps the transform pure. */
export interface ReceiptSummary {
  readonly id: string;
  readonly state: ReceiptVerifyState;
  readonly insertedAt: number;
}

/**
 * Pure transform: ordered receipt summaries → SatelliteExpression. Phase is
 * spread around the full circle so arrivals don't clump; radius cycles
 * through three sub-rings so satellites don't collide at the same altitude.
 */
export function receiptsToExpression(receipts: readonly ReceiptSummary[]): SatelliteExpression {
  const n = receipts.length;
  const items: SatelliteItem[] = receipts.map((r, i) => ({
    id: r.id,
    label: "receipt",
    hue: hueForVerifyState(r.state),
    radius: BASE_RADIUS_M + (i % 3) * RADIUS_STEP_M,
    orbitPeriodMs: ORBIT_PERIOD_MS,
    phase: n > 0 ? (i / n) * Math.PI * 2 : 0,
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
 * Low-level renderer. Callers typically use ReceiptSatelliteCoordinator;
 * this class is exported for direct use and to mirror the credential
 * satellite shape (so future refactors can unify the two behind a common
 * SatelliteRenderer base if it becomes worth it).
 */
export class ReceiptSatelliteRenderer {
  private readonly group: THREE.Group;
  private readonly parent: THREE.Object3D;
  private meshes = new Map<string, SatelliteMesh>();

  constructor(parent: THREE.Object3D) {
    this.parent = parent;
    this.group = new THREE.Group();
    this.group.name = "receipt-satellites";
    this.parent.add(this.group);
  }

  setExpression(expr: SpatialExpression): void {
    if (expr.kind !== "satellite") return;
    const next = new Map<string, SatelliteMesh>();
    for (const item of expr.items) {
      const existing = this.meshes.get(item.id);
      if (existing) {
        existing.material.color.setHSL(item.hue / 360, 0.6, 0.55);
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
      color: new THREE.Color().setHSL(item.hue / 360, 0.6, 0.55),
      metalness: 0.1,
      roughness: 0.15,
      clearcoat: 0.6,
      transmission: 0.45,
      transparent: true,
      opacity: 0.92,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `receipt:${item.id}`;
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
 * Owns the receipt → verify → render state machine.
 *
 * - `addReceipt(r)` upserts the receipt, kicks off local chain verification,
 *   and re-renders. Safe to call before `attach()` — the buffer persists.
 * - `attach(parent)` creates a renderer under `parent` and flushes the
 *   current buffer, so receipts captured during boot land in the scene as
 *   soon as the creature group exists.
 * - `tick(nowMs)` animates orbits; no-op when unattached.
 * - `dispose()` detaches and clears.
 *
 * Capped at `MAX_RECEIPTS` with oldest-first eviction so a long session
 * doesn't accumulate an opaque swarm. The accumulated-trust record lives
 * in storage; the scene shows the recent tail.
 */
export class ReceiptSatelliteCoordinator {
  private receipts = new Map<string, { receipt: ExecutionReceipt; insertedAt: number }>();
  private states = new Map<string, ReceiptVerifyState>();
  private renderer: ReceiptSatelliteRenderer | null = null;
  private monotonic = 0;

  attach(parent: THREE.Object3D): void {
    if (this.renderer) return;
    this.renderer = new ReceiptSatelliteRenderer(parent);
    this.flush();
  }

  detach(): void {
    if (!this.renderer) return;
    this.renderer.dispose();
    this.renderer = null;
  }

  addReceipt(receipt: ExecutionReceipt): void {
    const id = receipt.task_id;
    // Upsert: updating an existing receipt re-verifies but keeps insertion
    // order (so a re-emit doesn't push older receipts off the edge).
    const existing = this.receipts.get(id);
    const insertedAt = existing?.insertedAt ?? ++this.monotonic;
    this.receipts.set(id, { receipt, insertedAt });
    this.states.set(id, "pending");
    this.trim();
    this.flush();
    void this.verify(receipt);
  }

  tick(nowMs: number): void {
    this.renderer?.tick(nowMs);
  }

  /** Exposed for tests. */
  getState(taskId: string): ReceiptVerifyState | undefined {
    return this.states.get(taskId);
  }

  /** Exposed for tests. */
  size(): number {
    return this.receipts.size;
  }

  dispose(): void {
    this.detach();
    this.receipts.clear();
    this.states.clear();
  }

  private trim(): void {
    if (this.receipts.size <= MAX_RECEIPTS) return;
    // Evict oldest by insertedAt.
    const entries = [...this.receipts.entries()].sort((a, b) => a[1].insertedAt - b[1].insertedAt);
    const drop = entries.slice(0, this.receipts.size - MAX_RECEIPTS);
    for (const [id] of drop) {
      this.receipts.delete(id);
      this.states.delete(id);
    }
  }

  private async verify(receipt: ExecutionReceipt): Promise<void> {
    const keys = collectKnownKeys(receipt);
    try {
      const tree = await verifyReceiptChain(receipt, keys);
      if (!this.receipts.has(receipt.task_id)) return; // evicted during verify
      if (!tree.verified) {
        this.states.set(receipt.task_id, "failed");
      } else if (receipt.status === "failed") {
        this.states.set(receipt.task_id, "task-failed");
      } else {
        this.states.set(receipt.task_id, "verified");
      }
    } catch {
      if (!this.receipts.has(receipt.task_id)) return;
      this.states.set(receipt.task_id, "failed");
    }
    this.flush();
  }

  private flush(): void {
    if (!this.renderer) return;
    const ordered = [...this.receipts.entries()].sort((a, b) => a[1].insertedAt - b[1].insertedAt);
    const summaries: ReceiptSummary[] = ordered.map(([id, entry]) => ({
      id,
      state: this.states.get(id) ?? "pending",
      insertedAt: entry.insertedAt,
    }));
    this.renderer.setExpression(receiptsToExpression(summaries));
  }
}
