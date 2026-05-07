/**
 * Spatial Slab Manager — held-tablet renderer for the "Motebit Computer."
 *
 * Doctrine: `docs/doctrine/spatial-as-endgame.md` + `docs/doctrine/
 * motebit-computer.md` §"Held tablet." On AR glasses, the slab is not
 * a panel floating in space — it is a tablet the motebit holds up and
 * shows you, anchored to the creature's gesture, recedes when work
 * ends. Same lifecycle as the desktop slab; different body.
 *
 * State-machine half is `slab-core.ts` (Ring 1 — same on every
 * surface). This module is the spatial body (Ring 3). One state
 * machine, two renderers — desktop's Three.js plane lives in
 * `slab.ts`, spatial's held tablet lives here.
 *
 * Phase 1A (this commit): typed primitive + state machine + held-
 * tablet geometry constants + render adapter wiring. Headless-
 * testable end to end. No mesh, no animations, no per-item visual.
 *
 * Phase 1B (deferred — needs eyes on a running spatial scene):
 * MeshPhysicalMaterial held tablet, emerge/dissolve animations,
 * sympathetic breathing scale, soul-color coupling, per-kind item
 * rendering (start with `fetch` as the canonical
 * presentation-shaped kind). The constants exported below are the
 * canonical values Phase 1B applies to the mesh.
 *
 * Held-tablet pose (anchored to creature group):
 *   - Right-of-creature, slightly below eye level, slightly forward.
 *   - Tilted forward + yawed toward the camera, reading as "the
 *     motebit is showing you what's on the tablet."
 *   - Sized by `GOLDEN_RATIO` — same body-adjacent display proportion
 *     rule as the desktop slab (`design-ratios.ts`).
 */

import * as THREE from "three";
import type { ArtifactSpec, ArtifactHandle, SlabItemSpec, SlabItemHandle } from "./spec.js";
import { GOLDEN_RATIO } from "./design-ratios.js";
import {
  SlabCore,
  SLAB_BREATHE_FREQUENCY_HZ,
  SLAB_BREATHE_AMPLITUDE_FACTOR,
  type DetachArtifactHandler,
  type SlabCoreFrame,
} from "./slab-core.js";

// Re-export the breathing constants so spatial-side tests can verify
// inheritance from the shared core without reaching into render-engine
// internals. One body, one rhythm.
export { SLAB_BREATHE_FREQUENCY_HZ, SLAB_BREATHE_AMPLITUDE_FACTOR };

// ── Held-tablet geometry constants ───────────────────────────────────
//
// Position relative to the creature group, in meters. Held-tablet
// pose: the motebit holds the tablet at hand height, slightly below
// eye level, tilted toward the user. Phase 1B applies these to the
// mesh.

/** Right-of-creature offset (meters). */
export const SPATIAL_SLAB_OFFSET_X = 0.32;
/** Slightly below eye level (meters). */
export const SPATIAL_SLAB_OFFSET_Y = -0.18;
/** Slightly forward of the creature's body (meters). */
export const SPATIAL_SLAB_OFFSET_Z = 0.05;
/** Forward tilt — ~12° (radians). Reads as "tablet held up to show you." */
export const SPATIAL_SLAB_TILT_X = -0.21;
/** Yaw toward the user's gaze — ~8° (radians). */
export const SPATIAL_SLAB_TILT_Y = 0.14;

/**
 * Held-tablet width (meters). Comfortable held-tablet size at arm's
 * length on AR glasses; small enough that the creature still reads as
 * the iconic presence, large enough to host a single primary
 * embodiment (one fetched page, one tool call, one delegation
 * receipt).
 */
export const SPATIAL_SLAB_WIDTH = 0.42;
/** Held-tablet height — locked to φ via GOLDEN_RATIO. */
export const SPATIAL_SLAB_HEIGHT = SPATIAL_SLAB_WIDTH / GOLDEN_RATIO;

// ── Renderer-side per-item state ─────────────────────────────────────
//
// Phase 1A: tracks ids only. The element ref is held for Phase 1B —
// the mesh-creation pass will use it (e.g., texture-from-DOM, or as
// the source for a per-kind WebXR panel). For now it's just a
// placeholder slot so the bridge contract is stable across phases.

interface ManagedSpatialItem {
  element: HTMLElement;
}

// ── SpatialSlabManager ───────────────────────────────────────────────

export class SpatialSlabManager {
  private readonly group: THREE.Group;
  private readonly core: SlabCore;
  private readonly items = new Map<string, ManagedSpatialItem>();
  /** Last frame from `core.tick`. Tests verify ambient via these accessors. */
  private lastFrame: SlabCoreFrame = {
    items: [],
    planeVisibility: 0,
    activeWarmth: 0,
  };

  constructor(creatureGroup: THREE.Group, opts?: { detachHandler?: DetachArtifactHandler }) {
    this.core = new SlabCore({ detachHandler: opts?.detachHandler ?? null });

    // Held-tablet anchor group, mounted on the creature so it
    // inherits the creature's world transform — drift, sag, gesture.
    // Doctrine: spatial-as-endgame.md §"Default companion shape" —
    // body-anchored (not viewport-anchored), gestures-on-objects.
    this.group = new THREE.Group();
    this.group.name = "spatial-slab";
    this.group.position.set(SPATIAL_SLAB_OFFSET_X, SPATIAL_SLAB_OFFSET_Y, SPATIAL_SLAB_OFFSET_Z);
    this.group.rotation.set(SPATIAL_SLAB_TILT_X, SPATIAL_SLAB_TILT_Y, 0);
    creatureGroup.add(this.group);

    // Phase 1B will add:
    //   - MeshPhysicalMaterial held tablet (same material family as
    //     the creature — borosilicate IOR, transmission, low
    //     roughness, soul-color tint).
    //   - Per-kind item rendering (start with `fetch` —
    //     "the motebit is showing you a page").
    //   - Emerge / dissolve animations matching the creature's
    //     droplet physics (~400ms emerge, ~300ms dissolve — durations
    //     come from slab-core.ts).
    //   - Sympathetic breathing on the tablet scale, 30% creature
    //     amplitude at 0.3 Hz (constants imported from slab-core.ts).
    // Until Phase 1B lands, the group is empty — the tablet has no
    // body yet, only an anchored coordinate frame.
  }

  /** Expose the THREE group so the adapter / Phase 1B code can mount the tablet. */
  getGroup(): THREE.Group {
    return this.group;
  }

  /** Latest planeVisibility from the core (eased ambient, 0..1). */
  getPlaneVisibility(): number {
    return this.lastFrame.planeVisibility;
  }

  /** Latest activeWarmth from the core (eased soul-color coupling, 0..1). */
  getActiveWarmth(): number {
    return this.lastFrame.activeWarmth;
  }

  // ── Public API — mirrors SlabManager / RenderAdapter slab methods ─

  setUserVisible(visible: boolean): void {
    this.core.setUserVisible(visible);
  }

  toggleUserVisible(): boolean {
    return this.core.toggleUserVisible();
  }

  addItem(spec: SlabItemSpec): SlabItemHandle {
    // `slabHidden` carries the same meaning as on desktop: mind-mode
    // items (stream tokens, embeddings, memory surfacing) are tracked
    // by the core for lifecycle contracts but excluded from the
    // ambient count. They render off-tablet (in the creature's mind
    // animations / chat / panels), not as a held-tablet presentation.
    const slabHidden =
      (spec.element as { dataset?: Record<string, string> }).dataset?.slabHidden === "true";

    this.items.set(spec.id, { element: spec.element });
    return this.core.addItem({ id: spec.id, kind: spec.kind, slabHidden });
  }

  dissolveItem(id: string): Promise<void> {
    return this.core.dissolveItem(id);
  }

  detachItemAsArtifact(id: string, artifact: ArtifactSpec): Promise<ArtifactHandle | undefined> {
    return this.core.detachItemAsArtifact(id, artifact);
  }

  clearItems(): void {
    this.items.clear();
    this.core.clearItems();
  }

  /**
   * Per-frame update. Drives the core forward and (Phase 1B) applies
   * the snapshot to the held-tablet mesh. `t` is total animation time;
   * `deltaTime` is the frame delta.
   *
   * Phase 1A: ticks the core, prunes parallel items on `gone`,
   * stores the last frame for ambient accessors. No visual changes.
   */
  update(_t: number, deltaTime: number): void {
    const frame = this.core.tick(deltaTime);
    this.lastFrame = frame;

    for (const item of frame.items) {
      if (item.phase === "gone") {
        this.items.delete(item.id);
      }
    }

    // Phase 1B applies frame.planeVisibility + frame.activeWarmth +
    // sympathetic breathing to the tablet mesh here. Same shape as
    // SlabManager.update — different body. The breathing math reads
    // SLAB_BREATHE_FREQUENCY_HZ + SLAB_BREATHE_AMPLITUDE_FACTOR
    // (re-exported above) so both renderers stay locked to the same
    // rhythm.
  }

  /** Render hook called after the WebGL render. No CSS2D overlay in spatial. */
  render(_scene: THREE.Scene, _camera: THREE.Camera): void {
    // Phase 1B may add a CSS3D / WebXR-panel renderer here for HTML
    // surfaces (a fetched page, a terminal, a code editor). For now
    // there is nothing to draw on top of the WebGL pass.
  }

  /** No CSS2D renderer to size in Phase 1A. Phase 1B may want viewport-aware sizing. */
  resize(_width: number, _height: number): void {
    // Reserved for Phase 1B.
  }

  dispose(): void {
    this.clearItems();
    if (this.group.parent) {
      this.group.parent.remove(this.group);
    }
  }
}
