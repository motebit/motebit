/**
 * Slab Manager — the "Motebit Computer" render primitive.
 *
 * See docs/doctrine/motebit-computer.md for the semantic contract and
 * the spec.ts SlabItem* types for the protocol boundary.
 *
 * What this module is:
 *
 *   - A `THREE.Group` containing a liquid-glass plane floating to the
 *     right of the creature, at a held-tablet tilt. The plane is a
 *     real 3D mesh with the same material family as the creature
 *     (borosilicate IOR, transmission, low roughness) — one body, one
 *     material.
 *
 *   - A manager for `SlabItem` HTML elements, mounted via `CSS2DObject`
 *     onto the plane surface. Mirrors the `ArtifactManager` pattern,
 *     but items sit ON the plane rather than orbiting the creature,
 *     and the slab itself is visible as a material presence — the
 *     plane is the substrate, items are what's on it.
 *
 *   - Per-phase animations: emergence (plane scales in from a droplet
 *     origin), active (steady refraction + sympathetic breathing),
 *     dissolving (item fades with a ripple, no artifact spawned),
 *     pinching → detached (Pass 3 will add the Rayleigh-Plateau bead
 *     physics; Pass 2 falls back to a swift scale-up-and-release while
 *     calling `onDetachArtifact` so the caller can graduate the item
 *     into its own artifact scene-object).
 *
 *   - Ambient state inferred from item presence:
 *       active    — ≥1 non-terminal item → plane fully visible
 *       idle      — no items, within the idle window → meniscus-only
 *       recessed  — no items, past the recession window → near-invisible
 *
 * What this module is NOT:
 *
 *   - No knowledge of the runtime's `SlabController`. Callers translate
 *     lifecycle events into manager calls. That keeps Layer 2 (render)
 *     and Layer 4 (runtime) cleanly separated — renderers can be
 *     swapped without touching the controller.
 *
 *   - No full Rayleigh-Plateau pinch physics in Pass 2. The detach
 *     transition runs a placeholder scale-up animation and invokes
 *     the caller's `onDetachArtifact` callback; the pinch vertex
 *     displacement lands in Pass 3 (slab-pinch.ts).
 */

import * as THREE from "three";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import type {
  ArtifactSpec,
  ArtifactHandle,
  SlabItemSpec,
  SlabItemHandle,
  SlabItemPhase,
} from "./spec.js";
import { CANONICAL_MATERIAL } from "./spec.js";

// ── Geometry + positioning constants ─────────────────────────────────

/**
 * Slab position relative to the creature. Held-tablet pose — offset
 * right, at the creature's eye level, tilted forward toward the
 * camera (~12°) and slightly toward the creature (~5° yaw). Values
 * chosen to read as "the motebit is holding up a glass slate and
 * showing you what's on it."
 */
const SLAB_OFFSET_X = 0.42; // right of creature (meters)
const SLAB_OFFSET_Y = 0.0; // creature eye level
const SLAB_OFFSET_Z = -0.05; // slightly behind
const SLAB_TILT_X = -0.21; // ~12° forward (radians)
const SLAB_TILT_Y = -0.09; // ~5° yaw toward creature (radians)

/** Golden-ratio-ish aspect. ~1.5 body radii wide. */
const SLAB_WIDTH = 0.42;
const SLAB_HEIGHT = 0.26;

/**
 * Sympathetic breathing amplitude factor. 0.3 of the creature's
 * breathing amplitude — felt as belonging to the same body, without
 * mimicking. Same 0.3 Hz frequency; inherited from `t` so the phases
 * stay perfectly synchronized (both read the same animation time).
 */
const SLAB_BREATHE_AMPLITUDE_FACTOR = 0.3;

/** Phase animation durations (seconds). Match motebit-computer.md §Lifecycle. */
const EMERGE_DURATION_S = 0.4;
const DISSOLVE_DURATION_S = 0.3;
const PINCH_DURATION_S = 0.8;

/**
 * Idle → recessed delay. Consistent with the controller's default
 * recessionDelayMs (10s), so renderer + controller visual states
 * align without explicit coordination.
 */
const RECESSION_DELAY_S = 10.0;

// ── Types ────────────────────────────────────────────────────────────

interface ManagedSlabItem {
  id: string;
  kind: SlabItemSpec["kind"];
  object: CSS2DObject;
  element: HTMLElement;
  phase: SlabItemPhase;
  /** Seconds elapsed within the current phase. */
  phaseTime: number;
  /** Grid slot index for layout. */
  slot: number;
  /** Subscribers to phase transitions. */
  phaseListeners: Set<(phase: SlabItemPhase) => void>;
  /**
   * When detaching, the artifact spec the caller wants the detached
   * item to become. Renderer calls the embedded `__detach` function
   * at the right moment in the pinch animation.
   */
  detachTo?: ArtifactSpec;
  /** Called when the pinch completes and artifact has been handed off. */
  detachResolve?: (handle: ArtifactHandle | undefined) => void;
  /** Handle the caller receives when detach is requested. */
  detachArtifactHandle?: ArtifactHandle | undefined;
  /** Resolves when `dissolveSlabItem` completes (end-to-end fade). */
  dissolveResolve?: () => void;
}

/**
 * Function the slab calls when an item has passed through its pinch
 * animation — the caller spawns the detached artifact into the wider
 * scene via the ArtifactManager (or equivalent). Injected by the host
 * adapter so `slab.ts` doesn't depend on `artifacts.ts`.
 */
export type DetachArtifactHandler = (spec: ArtifactSpec) => ArtifactHandle | undefined;

// ── Slab Manager ─────────────────────────────────────────────────────

export class SlabManager {
  private readonly group: THREE.Group;
  private readonly planeMesh: THREE.Mesh;
  private readonly planeMaterial: THREE.MeshPhysicalMaterial;
  private readonly itemsGroup: THREE.Group;
  private readonly css2dRenderer: CSS2DRenderer;
  private readonly items = new Map<string, ManagedSlabItem>();
  private readonly detachHandler: DetachArtifactHandler | null;
  /** Seconds since the last active item ended. Drives idle → recessed. */
  private emptyTime = 0;
  /** Cached ambient visibility of the plane — used to skip per-frame reruns. */
  private planeVisibility = 0;
  /**
   * Whether the slab has ever hosted an active item. Before first
   * activity the plane stays fully invisible — there's no emergence
   * from nothing to show. Once an item has opened, the idle state
   * becomes the meniscus-only baseline; recessed is the long-idle
   * decay back toward invisible.
   */
  private hasBeenActive = false;

  constructor(
    creatureGroup: THREE.Group,
    container: HTMLElement,
    opts?: { detachHandler?: DetachArtifactHandler },
  ) {
    // Group hosts the plane + its items, mounted as a child of the creature
    // so it inherits the creature's world transform (drift, sag, bob).
    this.group = new THREE.Group();
    this.group.name = "slab";
    this.group.position.set(SLAB_OFFSET_X, SLAB_OFFSET_Y, SLAB_OFFSET_Z);
    this.group.rotation.set(SLAB_TILT_X, SLAB_TILT_Y, 0);
    creatureGroup.add(this.group);

    // Plane geometry — flat rectangular sheet. The meniscus impression
    // comes from the liquid-glass material's edge Fresnel, not geometry.
    // Pass 3 may extrude the edges for a more pronounced surface-tension
    // curve if it reads flat against the creature.
    const planeGeo = new THREE.PlaneGeometry(SLAB_WIDTH, SLAB_HEIGHT, 1, 1);
    this.planeMaterial = new THREE.MeshPhysicalMaterial({
      // Same material family as the creature — same IOR, roughness,
      // transmission. The slab is body-adjacent, not a UI element.
      ior: CANONICAL_MATERIAL.ior,
      roughness: CANONICAL_MATERIAL.roughness,
      transmission: 0.94,
      thickness: 0.02,
      clearcoat: CANONICAL_MATERIAL.clearcoat,
      clearcoatRoughness: 0.05,
      color: new THREE.Color(
        CANONICAL_MATERIAL.tint[0],
        CANONICAL_MATERIAL.tint[1],
        CANONICAL_MATERIAL.tint[2],
      ),
      transparent: true,
      opacity: 0, // Starts invisible; reveals on first item.
      side: THREE.DoubleSide,
    });
    this.planeMesh = new THREE.Mesh(planeGeo, this.planeMaterial);
    this.planeMesh.visible = false; // skip GL work when truly recessed
    this.group.add(this.planeMesh);

    // Items group sits in the plane's local space so rotation is
    // shared — items tilt with the slab.
    this.itemsGroup = new THREE.Group();
    this.itemsGroup.name = "slab-items";
    this.group.add(this.itemsGroup);

    // Reuse a CSS2DRenderer pattern for mounting HTML items on the slab
    // surface. The artifact manager already creates one; we add our own
    // so the two can maintain independent z-ordering + pointer-events.
    this.css2dRenderer = new CSS2DRenderer();
    this.css2dRenderer.setSize(container.clientWidth, container.clientHeight);
    this.css2dRenderer.domElement.style.position = "absolute";
    this.css2dRenderer.domElement.style.top = "0";
    this.css2dRenderer.domElement.style.left = "0";
    this.css2dRenderer.domElement.style.zIndex = "2"; // above artifacts
    this.css2dRenderer.domElement.style.pointerEvents = "none";
    container.appendChild(this.css2dRenderer.domElement);

    this.detachHandler = opts?.detachHandler ?? null;
  }

  /** Expose the THREE group so the adapter can position/animate externally if needed. */
  getGroup(): THREE.Group {
    return this.group;
  }

  // ── Public API — mirrors the RenderAdapter slab methods ───────────

  addItem(spec: SlabItemSpec): SlabItemHandle {
    // Mount the caller's HTML into a CSS2DObject anchored to the
    // plane's center. Items stack vertically with simple slot indexing
    // — Pass 2 doesn't do reflow; first item, bottom of plane.
    spec.element.style.pointerEvents = "auto";
    spec.element.style.transform = "scale(0)";
    spec.element.style.transformOrigin = "center center";
    spec.element.style.opacity = "0";

    const cssObject = new CSS2DObject(spec.element);
    const slot = this.items.size;
    cssObject.position.set(...this.slotPosition(slot));
    this.itemsGroup.add(cssObject);

    const managed: ManagedSlabItem = {
      id: spec.id,
      kind: spec.kind,
      object: cssObject,
      element: spec.element,
      phase: "emerging",
      phaseTime: 0,
      slot,
      phaseListeners: new Set(),
    };
    this.items.set(spec.id, managed);

    const handle: SlabItemHandle = {
      id: spec.id,
      getPhase: () => managed.phase,
      onPhaseChange: (listener) => {
        managed.phaseListeners.add(listener);
        return () => managed.phaseListeners.delete(listener);
      },
    };

    return handle;
  }

  dissolveItem(id: string): Promise<void> {
    const item = this.items.get(id);
    if (!item) return Promise.resolve();
    if (item.phase === "dissolving" || item.phase === "gone") {
      return new Promise((r) => {
        item.dissolveResolve = r;
      });
    }
    this.setPhase(item, "dissolving");
    item.phaseTime = 0;
    return new Promise((r) => {
      item.dissolveResolve = r;
    });
  }

  detachItemAsArtifact(id: string, artifact: ArtifactSpec): Promise<ArtifactHandle | undefined> {
    const item = this.items.get(id);
    if (!item) return Promise.resolve(undefined);
    if (item.phase === "pinching" || item.phase === "detached" || item.phase === "gone") {
      return new Promise((r) => {
        item.detachResolve = r;
      });
    }
    item.detachTo = artifact;
    this.setPhase(item, "pinching");
    item.phaseTime = 0;
    return new Promise((r) => {
      item.detachResolve = r;
    });
  }

  clearItems(): void {
    for (const id of [...this.items.keys()]) {
      this.removeImmediate(id);
    }
  }

  /**
   * Per-frame update. Drives item phase animations + sympathetic
   * breathing + idle/recessed ambient.
   *
   * `t` is total animation time (seconds), matching the creature's
   * render frame. `deltaTime` is the frame delta (seconds).
   */
  update(t: number, deltaTime: number): void {
    // Item phase animations
    for (const item of this.items.values()) {
      item.phaseTime += deltaTime;
      this.animateItem(item);
    }

    // Ambient: count non-terminal items; fade the plane accordingly
    const active = [...this.items.values()].filter(
      (i) => i.phase !== "dissolving" && i.phase !== "detached" && i.phase !== "gone",
    ).length;

    if (active > 0) {
      this.emptyTime = 0;
      this.hasBeenActive = true;
      this.planeVisibility = Math.min(1, this.planeVisibility + deltaTime * 3);
    } else if (!this.hasBeenActive) {
      // Before first activity ever, the slab is fully invisible — no
      // droplet has emerged from nothing to show.
      this.planeVisibility = 0;
    } else {
      this.emptyTime += deltaTime;
      // Idle window: plane stays at meniscus (low opacity). Past the
      // recession delay, plane fades to near-invisible.
      const recessFactor = Math.max(0, Math.min(1, (this.emptyTime - RECESSION_DELAY_S) / 2));
      const idleVisibility = 0.15 * (1 - recessFactor);
      this.planeVisibility = smoothToward(this.planeVisibility, idleVisibility, deltaTime, 4);
    }

    // Sympathetic breathing — ~0.3 Hz, 30% creature amplitude. Uses the
    // same time base as the creature's breathing formula, so phases
    // lock naturally without inter-object signaling.
    const breatheRaw = Math.sin(t * 0.3 * Math.PI * 2);
    const breathe =
      (breatheRaw > 0 ? breatheRaw : Math.sign(breatheRaw) * Math.pow(Math.abs(breatheRaw), 0.6)) *
      SLAB_BREATHE_AMPLITUDE_FACTOR *
      0.012;

    this.planeMaterial.opacity = this.planeVisibility * 0.7; // ceiling keeps the slab readable
    this.planeMesh.visible = this.planeVisibility > 0.01;
    this.planeMesh.scale.set(1 + breathe, 1 + breathe, 1);
  }

  /** Called after WebGL render each frame — syncs CSS overlay. */
  render(scene: THREE.Scene, camera: THREE.Camera): void {
    this.css2dRenderer.render(scene, camera);
  }

  resize(width: number, height: number): void {
    this.css2dRenderer.setSize(width, height);
  }

  dispose(): void {
    this.clearItems();
    this.css2dRenderer.domElement.remove();
    this.planeMesh.geometry.dispose();
    this.planeMaterial.dispose();
  }

  // ── Internal ──────────────────────────────────────────────────────

  private setPhase(item: ManagedSlabItem, phase: SlabItemPhase): void {
    item.phase = phase;
    for (const listener of item.phaseListeners) {
      try {
        listener(phase);
      } catch {
        // Listener exceptions are isolated — renderer state must not
        // be affected by a caller's subscription error.
      }
    }
  }

  private animateItem(item: ManagedSlabItem): void {
    switch (item.phase) {
      case "emerging": {
        const t = item.phaseTime / EMERGE_DURATION_S;
        const progress = easeOutQuad(Math.min(1, t));
        item.element.style.transform = `scale(${progress})`;
        item.element.style.opacity = String(progress);
        if (t >= 1) {
          this.setPhase(item, "active");
          item.phaseTime = 0;
          item.element.style.transform = "scale(1)";
          item.element.style.opacity = "1";
        }
        break;
      }
      case "active":
        // Steady state — item stays at scale 1. Future phases handle
        // layout reflow + hover affordances.
        break;
      case "dissolving": {
        const t = item.phaseTime / DISSOLVE_DURATION_S;
        const progress = 1 - easeInQuad(Math.min(1, t));
        item.element.style.transform = `scale(${progress})`;
        item.element.style.opacity = String(progress);
        if (t >= 1) {
          this.setPhase(item, "gone");
          this.removeImmediate(item.id);
          item.dissolveResolve?.();
        }
        break;
      }
      case "pinching": {
        // Pass 2 placeholder — scale up slightly, then hand off the
        // artifact. Pass 3 replaces this with Rayleigh-Plateau vertex
        // displacement (dimple → bead → tendril snap).
        const t = item.phaseTime / PINCH_DURATION_S;
        const scale = 1 + easeInOutQuad(Math.min(1, t)) * 0.1;
        item.element.style.transform = `scale(${scale})`;
        item.element.style.opacity = String(1 - easeInQuad(Math.min(1, t)) * 0.5);

        // Midway through the pinch, spawn the detached artifact so
        // the visual transition feels continuous (slab item fades out
        // as artifact fades in). Handler may be absent in headless
        // tests — in that case we just log and proceed.
        if (item.detachTo && !item.detachArtifactHandle && t >= 0.5) {
          if (this.detachHandler) {
            item.detachArtifactHandle = this.detachHandler(item.detachTo);
          }
        }

        if (t >= 1) {
          this.setPhase(item, "detached");
          item.phaseTime = 0;
        }
        break;
      }
      case "detached": {
        // Brief tail after the artifact has been handed off, then clean up.
        if (item.phaseTime >= 0.05) {
          this.setPhase(item, "gone");
          this.removeImmediate(item.id);
          item.detachResolve?.(item.detachArtifactHandle);
        }
        break;
      }
      case "gone":
        // Should have been removed already, but defend against edge cases.
        this.removeImmediate(item.id);
        break;
    }
  }

  private removeImmediate(id: string): void {
    const item = this.items.get(id);
    if (!item) return;
    this.itemsGroup.remove(item.object);
    item.phaseListeners.clear();
    this.items.delete(id);
  }

  /**
   * Slot layout in plane-local space. Pass 2 uses a simple vertical
   * stack growing downward from the plane's top edge. Reflow on
   * removal is the Pass 3 concern along with the pinch.
   */
  private slotPosition(slot: number): [number, number, number] {
    // Plane spans ±SLAB_WIDTH/2 horizontally, ±SLAB_HEIGHT/2 vertically.
    // Items mounted near the top, stacked downward. Z = 0.001 so they
    // render fractionally in front of the plane (not z-fighting).
    const topY = SLAB_HEIGHT / 2 - 0.02;
    const spacing = 0.05;
    return [0, topY - slot * spacing, 0.001];
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function easeOutQuad(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

function easeInQuad(t: number): number {
  return t * t;
}

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function smoothToward(current: number, target: number, deltaTime: number, rate: number): number {
  const factor = 1 - Math.exp(-rate * deltaTime);
  return current + (target - current) * factor;
}
