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
  InteriorColor,
  SlabItemSpec,
  SlabItemHandle,
  SlabItemPhase,
} from "./spec.js";
import { CANONICAL_MATERIAL } from "./spec.js";
import { GOLDEN_RATIO } from "./design-ratios.js";

// ── Geometry + positioning constants ─────────────────────────────────

/**
 * Slab position relative to the creature. Held-tablet pose — offset
 * right, at the creature's eye level, tilted forward toward the
 * camera (~12°) and turned toward the creature (~9° yaw). Values
 * chosen to read as "the motebit is holding up a glass slate and
 * showing you what's on it."
 *
 * X/width tuned so the right edge stays on-screen on a 16:9 canvas
 * at the default camera (pos z=0.85, fov 45°, half-screen-width at
 * slab depth ≈ 0.35m). At the previous offset/width (0.42/0.42)
 * the plane's right edge sat past the viewport; cards mounted on
 * the outer slots clipped out of view on narrower windows.
 */
const SLAB_OFFSET_X = 0.38; // right of creature (meters)
const SLAB_OFFSET_Y = 0.0; // creature eye level
const SLAB_OFFSET_Z = -0.02; // just behind creature's front face
const SLAB_TILT_X = -0.22; // ~12.5° forward (radians)
const SLAB_TILT_Y = -0.09; // ~5° yaw toward creature (radians) — doctrine

/**
 * Plane dimensions — sized to host window-pane cards (~520×334 CSS px
 * at the default camera) without visible empty margins around the
 * container. Aspect locked to the golden ratio (φ ≈ 1.618) per
 * `docs/doctrine/design-ratios.md` — the slab is the first droplet-
 * family surface under that rule.
 */
const SLAB_WIDTH = 0.54;
const SLAB_HEIGHT = SLAB_WIDTH / GOLDEN_RATIO;

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

// ── Types ────────────────────────────────────────────────────────────

interface ManagedSlabItem {
  id: string;
  kind: SlabItemSpec["kind"];
  /** The mounted DOM element — a flex-column child of the shared items container. */
  element: HTMLElement;
  phase: SlabItemPhase;
  /** Seconds elapsed within the current phase. */
  phaseTime: number;
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
  /**
   * One CSS2DObject anchored at the plane's center, holding a single
   * "stage" div — the plane renders ONE primary embodiment at a time
   * (doctrine: motebit-computer.md §"Embodiment modes"). No flex
   * stacking, no cards-on-glass. The stage's child is whatever the
   * motebit is currently working on (a browser page, a terminal, an
   * IDE); when work finishes it either dissolves off the plane or
   * pinches off into the scene as an artifact — it never rests as a
   * rectangle *on* the plane. Cards only exist outside the plane's
   * bounds, as graduated scene objects.
   */
  private readonly stageAnchor: CSS2DObject;
  private readonly stageEl: HTMLDivElement;
  private readonly css2dRenderer: CSS2DRenderer;
  private readonly items = new Map<string, ManagedSlabItem>();
  private readonly detachHandler: DetachArtifactHandler | null;
  /** Cached ambient visibility of the plane — eased each frame. */
  private planeVisibility = 0;
  /**
   * Current soul color. Doctrine mandates the slab's active tint
   * derives from the creature's interior color — "cyan creature → cyan
   * slab warmth." The plane's attenuation + emissive lerp toward this
   * when ambient is active, and back toward neutral when idle. Set via
   * `setInteriorColor`; host adapters route the creature's interior
   * color through here at the same time they set the creature's.
   */
  private soulTint: [number, number, number] = [0.95, 0.97, 1.0];
  private soulGlow: [number, number, number] = [0.55, 0.78, 1.0];
  /** Current emissive coupling 0..1. Eased toward the target each frame. */
  private activeWarmth = 0;
  /**
   * User-held visibility override. Doctrine (motebit-computer.md
   * §"Ambient states"): the slab is absent by default when empty —
   * the creature droplet is the iconic presence, not a second plane
   * sitting next to it. When the motebit gets work, the plane
   * emerges; when work ends, the plane auto-hides again.
   *
   * The user can explicitly pull the plane open via Option+C or
   * `/computer`; that flips this flag to `true` and the plane stays
   * visible until toggled off, even when empty. Default `false`:
   * auto-ambient (follow item activity).
   */
  private userHeldVisible = false;

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

    // Plane geometry — a 17×17 grid (same as PlaneGeometry 16×16) with
    // the outer ring snapped onto a rounded-rectangle boundary. This
    // gives the slab a true meniscus-curve outline per doctrine (no
    // sharp corners) while preserving the dense interior grid that
    // pinch physics and sympathetic breathing deform. Using geometry
    // rather than an `alphaMap` because MeshPhysicalMaterial's
    // `transmission` render pass ignores alphaMap — the material reads
    // as a hard rectangle regardless. Rounding the actual mesh fixes
    // both the sharp-corner failure mode and any transmission conflict
    // in one move.
    const planeGeo = createMeniscusPlaneGeometry(SLAB_WIDTH, SLAB_HEIGHT, 16, 16);
    // Preserve the rest positions so the pinch code can reset to
    // unpinched without a geometry rebuild each frame.
    const posAttr = planeGeo.attributes.position;
    if (posAttr != null) {
      const restPositions = posAttr.array.slice();
      (planeGeo.userData as { restPositions?: ArrayLike<number> }).restPositions = restPositions;
    }
    this.planeMaterial = new THREE.MeshPhysicalMaterial({
      // Same material family as the creature — same IOR, same clearcoat
      // chemistry. The slab is body-adjacent, not a UI element.
      //
      // Transmission is pulled back from 0.94 so the plane reads as a
      // held sheet rather than a ghost. A trace of surface roughness
      // (0.06) breaks perfect mirror reflection into a frosted glow
      // that catches the environment; clearcoat on top keeps the
      // meniscus specular sharp. Thickness 0.04 deepens the refraction
      // through the glass without distorting items mounted on its
      // near face.
      // Less transmission than before so the plane reads as a frosted
      // display rather than near-clear glass that disappears into the
      // environment. Roughness bumped slightly for a more obvious
      // frosted surface treatment — still glass, but a screen you can
      // see when it's on. Clearcoat keeps the meniscus spec sharp.
      ior: CANONICAL_MATERIAL.ior,
      roughness: 0.12,
      transmission: 0.55,
      thickness: 0.04,
      clearcoat: 0.6,
      clearcoatRoughness: 0.05,
      // `color` is the base color behind transmission — the slab's
      // body. A touch of warm-white keeps it from reading as a TV.
      color: new THREE.Color(0.98, 0.985, 1.0),
      // Attenuation through the glass — what tints the refracted
      // background when the soul color couples in. Lerps between
      // neutral-cool (idle) and soul tint (active) each frame.
      attenuationColor: new THREE.Color(0.92, 0.95, 1.0),
      attenuationDistance: 0.6,
      // Sheen gives the frosted edge a soft frosted halo — reads as
      // a meniscus against a bright sky environment. Kept subtle;
      // too much sheen makes the plane look like fabric.
      sheen: 0.35,
      sheenRoughness: 0.9,
      sheenColor: new THREE.Color(0.75, 0.85, 1.0),
      // Emissive carries the soul-color warmth when active. Starts
      // black; update() breathes it in and out with the ambient.
      emissive: new THREE.Color(0, 0, 0),
      emissiveIntensity: 0,
      transparent: true,
      opacity: 0, // Starts invisible; reveals on first item.
      side: THREE.DoubleSide,
    });
    this.planeMesh = new THREE.Mesh(planeGeo, this.planeMaterial);
    this.planeMesh.visible = false; // skip GL work when truly recessed
    this.group.add(this.planeMesh);

    // Items container — one CSS2DObject rooted at the plane's center,
    // wrapping a flex-column div whose children are slab items. CSS
    // handles the flow; items never overlap, a scroll bar appears if
    // the stack grows past the visible area.
    //
    // When `document` is unavailable (headless tests), build a minimal
    // stand-in with the same API shape. The stand-in satisfies the
    // test's item-tracking assertions without needing a real DOM; a
    // real surface will always have `document`.
    this.stageEl = createContainerElement();
    this.stageAnchor = new CSS2DObject(this.stageEl);
    this.stageAnchor.position.set(0, 0, 0.001);
    this.group.add(this.stageAnchor);

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

  /**
   * Couple the slab's active tint to the creature's soul color. The
   * plane lerps toward this when items are on the slab and back
   * toward neutral-cool when idle — "cyan creature → cyan slab
   * warmth," per motebit-computer.md §"Visual properties."
   *
   * Host adapters call this from their own `setInteriorColor` at
   * the same moment they update the creature's interior. One body,
   * one respiratory rhythm, one color.
   */
  setInteriorColor(color: InteriorColor): void {
    this.soulTint = [color.tint[0], color.tint[1], color.tint[2]];
    this.soulGlow = [color.glow[0], color.glow[1], color.glow[2]];
  }

  /**
   * Hold the empty slab visible. Items always make the plane
   * visible regardless; this flag only matters when there are no
   * items and the user wants the plane open (to drag perception in,
   * to see where slab items will land, etc.).
   *
   * Wired to `setSlabVisible` on the adapter. Surfaces bind this to
   * Option+C / `/computer`.
   */
  setUserVisible(visible: boolean): void {
    this.userHeldVisible = visible;
    // Pre-warm the opacity so the user sees the plane materialize
    // immediately on open; the update() tick then eases to the
    // right target.
    if (visible && this.planeVisibility < 0.5) {
      this.planeVisibility = 0.85;
    }
  }

  /**
   * Flip the user-held visibility. Returns the new state so callers
   * can echo it (toast, UI indicator, etc.) without a separate
   * getter round-trip.
   */
  toggleUserVisible(): boolean {
    this.setUserVisible(!this.userHeldVisible);
    return this.userHeldVisible;
  }

  // ── Public API — mirrors the RenderAdapter slab methods ───────────

  addItem(spec: SlabItemSpec): SlabItemHandle {
    // Single-stage model (motebit-computer.md §"Embodiment modes"):
    // the plane renders ONE primary embodiment at a time. The stage
    // element hosts whichever item is currently the motebit's active
    // work; adding a new item REPLACES whatever was there. This
    // mirrors a real computer's screen — one app in focus, others
    // minimized / elsewhere.
    //
    // Items that belong in the creature/chat rather than the plane
    // (mind-mode: stream tokens, embeddings, plan steps, memory
    // surfacing) render as hidden placeholders — the bridge still
    // tracks them for state, but they don't occupy the screen.
    spec.element.style.pointerEvents = "auto";
    spec.element.style.transform = "scale(0)";
    spec.element.style.transformOrigin = "center center";
    spec.element.style.opacity = "0";

    // If the caller flagged this element as slab-hidden (mind-mode
    // items), mount it off-DOM so it has no visible presence. Phase
    // animations still run against it so the handle's lifecycle
    // contract holds; it's just never rendered to the plane.
    // `.dataset` may be absent in headless tests — read defensively.
    const slabHidden =
      (spec.element as { dataset?: Record<string, string> }).dataset?.slabHidden === "true";
    if (!slabHidden) {
      // Replace the current stage content with this new element.
      // Previous primary exits via its own phase physics (its
      // dissolve/pinch animation completes even though it's no
      // longer visible, resolving any pending promises cleanly).
      if (typeof this.stageEl.replaceChildren === "function") {
        this.stageEl.replaceChildren(spec.element);
      } else {
        this.stageEl.appendChild(spec.element);
      }
    }

    const managed: ManagedSlabItem = {
      id: spec.id,
      kind: spec.kind,
      element: spec.element,
      phase: "emerging",
      phaseTime: 0,
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

    // Plane surface displacement from any pinching items. Rebuilt each
    // frame from the rest positions so vertices cleanly return to
    // flat when no item is pinching. See `applyPinchDisplacement`.
    this.applyPinchDisplacement();

    // Ambient: count non-terminal items; fade the plane accordingly
    const active = [...this.items.values()].filter(
      (i) => i.phase !== "dissolving" && i.phase !== "detached" && i.phase !== "gone",
    ).length;

    // Doctrine (motebit-computer.md §"Ambient states"): the slab is
    // absent when empty. The creature droplet is the iconic presence;
    // a second plane sitting next to it steals focus. Work brings
    // the plane; work ending dismisses it. The user can hold the
    // plane open via Option+C / `/computer` for prep (drag-in,
    // inspecting layout) — `userHeldVisible` is the sticky override.
    let warmthTarget = 0;
    if (active > 0) {
      this.planeVisibility = Math.min(1, this.planeVisibility + deltaTime * 3);
      warmthTarget = 1;
    } else if (this.userHeldVisible) {
      this.planeVisibility = smoothToward(this.planeVisibility, 0.85, deltaTime, 4);
    } else {
      this.planeVisibility = smoothToward(this.planeVisibility, 0, deltaTime, 4);
    }

    // Ease the active warmth toward its target — soul color only shows
    // on the slab when the slab is doing something. Idle = no identity.
    this.activeWarmth = smoothToward(this.activeWarmth, warmthTarget, deltaTime, 2.5);

    // Sympathetic breathing — ~0.3 Hz, 30% creature amplitude. Uses the
    // same time base as the creature's breathing formula, so phases
    // lock naturally without inter-object signaling.
    const breatheRaw = Math.sin(t * 0.3 * Math.PI * 2);
    const breathe =
      (breatheRaw > 0 ? breatheRaw : Math.sign(breatheRaw) * Math.pow(Math.abs(breatheRaw), 0.6)) *
      SLAB_BREATHE_AMPLITUDE_FACTOR *
      0.012;

    // Apply soul coupling to attenuation + emissive. Neutral-cool at
    // warmth=0, full soul tint at warmth=1. Emissive intensity is
    // gentle (peak ~0.12) so the plane never outshines the creature.
    const w = this.activeWarmth;
    const attR = 0.92 * (1 - w) + this.soulTint[0] * w;
    const attG = 0.95 * (1 - w) + this.soulTint[1] * w;
    const attB = 1.0 * (1 - w) + this.soulTint[2] * w;
    this.planeMaterial.attenuationColor.setRGB(attR, attG, attB);
    this.planeMaterial.emissive.setRGB(this.soulGlow[0], this.soulGlow[1], this.soulGlow[2]);
    this.planeMaterial.emissiveIntensity = w * 0.12 * (0.85 + 0.15 * breatheRaw);

    this.planeMaterial.opacity = this.planeVisibility;
    this.planeMesh.visible = this.planeVisibility > 0.01;
    this.planeMesh.scale.set(1 + breathe, 1 + breathe, 1);
    // Sync the CSS2D stage so its DOM node doesn't keep capturing
    // pointer events when the plane is effectively gone.
    if (this.stageEl.style) {
      this.stageEl.style.display = this.planeMesh.visible ? "block" : "none";
    }
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
      case "resting":
        // The item has settled into working-material state. Visual
        // cue: add a class the per-surface renderer can style, and
        // apply a soft global "held, not active" filter so resting
        // items read as calm even before the renderer reacts. The
        // DOM stays in place; scale / opacity untouched so the user's
        // reading isn't interrupted. Doctrine: motebit-computer.md
        // §"Settling into rest."
        if (!item.element.classList.contains("slab-item-resting")) {
          item.element.classList.add("slab-item-resting");
          item.element.classList.remove("slab-item-active");
          // Subtle desaturation — reads as "held" without hiding
          // content. 0.92 is barely perceptible in isolation but
          // clearly differentiates a resting stack from an active
          // item.
          item.element.style.filter = "saturate(0.92)";
        }
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
        // Rayleigh-Plateau-inspired three-phase pinch. The element's
        // motion mirrors the physics of a droplet beading off a
        // parent surface:
        //
        //   Phase 1: tension (t ∈ [0, 0.35])
        //     Element grows slightly in place. Doctrine dimple is
        //     building on the plane beneath it (handled by
        //     `applyPinchDisplacement`). Position stays at the
        //     anchor; only scale ramps.
        //
        //   Phase 2: bead separation (t ∈ [0.35, 0.55])
        //     Element accelerates outward along the detach vector
        //     (positive Y in plane-local = upward toward the
        //     detaching bead), with slight squash-stretch to read
        //     as surface-tension release. The tendril "snaps" at
        //     the phase boundary — this is where the artifact is
        //     handed off so caller's detach artifact appears as
        //     the bead separates.
        //
        //   Phase 3: dissipation (t ∈ [0.55, 1.0])
        //     Element continues traveling outward while fading to
        //     zero opacity and returning to scale=1 (the bead has
        //     reached its destination; the slab-mounted copy
        //     dissipates). The plane's dimple collapses back to
        //     flat during this phase.
        const t = Math.min(1, item.phaseTime / PINCH_DURATION_S);

        if (t < 0.35) {
          // Tension — bead building
          const local = t / 0.35;
          const scale = 1 + easeInOutQuad(local) * 0.15;
          item.element.style.transform = `scale(${scale.toFixed(3)})`;
          item.element.style.opacity = "1";
        } else if (t < 0.55) {
          // Separation — squash-stretch + launch
          const local = (t - 0.35) / 0.2;
          const scaleY = 1.15 + local * 0.15; // elongate along launch axis
          const scaleX = 1.15 - local * 0.25; // narrow perpendicular (squash)
          const liftPx = easeInOutQuad(local) * 14; // translate upward (plane-local +Y)
          item.element.style.transform = `translateY(${(-liftPx).toFixed(1)}px) scale(${scaleX.toFixed(3)}, ${scaleY.toFixed(3)})`;
          item.element.style.opacity = (1 - local * 0.25).toFixed(3);

          // Detach handoff fires at the tendril snap (phase 2 end),
          // exactly when the bead has finished separating from the
          // plane. The artifact appears as the slab item dissipates.
          if (item.detachTo && !item.detachArtifactHandle && local >= 0.85) {
            if (this.detachHandler) {
              item.detachArtifactHandle = this.detachHandler(item.detachTo);
            }
          }
        } else {
          // Dissipation — bead gone, the slab-mounted copy fades
          const local = (t - 0.55) / 0.45;
          const scale = 1.15 - local * 0.3; // collapse scale toward 0.85
          const liftPx = 14 + local * 10;
          item.element.style.transform = `translateY(${(-liftPx).toFixed(1)}px) scale(${scale.toFixed(3)})`;
          item.element.style.opacity = (0.75 * (1 - easeInQuad(local))).toFixed(3);

          // Defensive: if the handoff didn't fire in phase 2 (edge
          // case — phaseTime jumped past the window in a slow frame),
          // fire it here so the caller isn't left without the
          // artifact.
          if (item.detachTo && !item.detachArtifactHandle && this.detachHandler) {
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
    // Remove the element from the stage if it was the primary. Items
    // that were mind-mode (slab-hidden) never mounted; no DOM cleanup
    // needed for those.
    if (item.element.parentNode === this.stageEl) {
      this.stageEl.removeChild(item.element);
    }
    item.phaseListeners.clear();
    this.items.delete(id);
  }

  /**
   * Rayleigh-Plateau-inspired plane surface displacement during the
   * pinching phase.
   *
   * For each pinching item, we raise a Gaussian bump in the plane's
   * vertex Z around the item's anchor point. The bump amplitude
   * follows a curve matching the element's own three-phase
   * trajectory: tension (bump grows), separation (bump peaks + releases
   * in a small snap), dissipation (bump collapses back to flat).
   *
   * Every frame we rebuild from the rest positions, apply all active
   * pinches' displacements additively, then mark the position
   * attribute dirty. That keeps the plane clean when no pinch is
   * active (no cumulative drift) and handles multiple parallel
   * pinches correctly (rare but possible under heavy tool-call
   * parallelism).
   */
  private applyPinchDisplacement(): void {
    const geometry = this.planeMesh.geometry as THREE.PlaneGeometry;
    const positionAttr = geometry.attributes.position;
    if (positionAttr == null) return;
    const rest = (geometry.userData as { restPositions?: ArrayLike<number> }).restPositions;
    if (rest == null) return;

    const positions = positionAttr.array as Float32Array;

    // Collect pinching items with amplitudes. Empty → fast path.
    //
    // With the single-container layout, items no longer have a
    // per-item 3D anchor — their position lives in CSS flow. We
    // approximate each pinching item's center in plane-local
    // coordinates by measuring its DOM rect relative to the
    // container's rect (see `pinchCenterForElement`). The Gaussian
    // bump is still local to the item's visible location.
    const pinches: Array<{ x: number; y: number; amplitude: number }> = [];
    for (const item of this.items.values()) {
      if (item.phase !== "pinching") continue;
      const t = Math.min(1, item.phaseTime / PINCH_DURATION_S);
      // Amplitude curve: grow during tension, peak at separation,
      // collapse during dissipation. Peak matches the element's
      // liftoff moment (t ≈ 0.45) so the dimple is deepest when the
      // bead is actually separating.
      let amp: number;
      if (t < 0.35) amp = easeInOutQuad(t / 0.35) * 0.008;
      else if (t < 0.55) amp = 0.008 + easeInOutQuad((t - 0.35) / 0.2) * 0.006;
      else amp = 0.014 * (1 - easeInQuad((t - 0.55) / 0.45));
      const [px, py] = this.pinchCenterForElement(item.element);
      pinches.push({ x: px, y: py, amplitude: amp });
    }

    // Fast path: no active pinches — copy rest positions and bail.
    if (pinches.length === 0) {
      // Only reset if the plane has been displaced at some point —
      // check one Z value as a cheap dirty-bit stand-in.
      if (positions[2] !== rest[2]) {
        positions.set(rest);
        positionAttr.needsUpdate = true;
      }
      return;
    }

    // Gaussian bump: z(p) = Σᵢ ampᵢ · exp(-|p - centerᵢ|² / 2σ²)
    // σ chosen ~ half an item-slot width so a single item's dimple
    // stays locally contained and doesn't flood the whole plane.
    const SIGMA = 0.06;
    const TWO_SIGMA_SQ = 2 * SIGMA * SIGMA;

    for (let i = 0; i < positions.length; i += 3) {
      const x = rest[i]!;
      const y = rest[i + 1]!;
      let z = rest[i + 2]!; // should be 0 on a flat plane
      for (const p of pinches) {
        const dx = x - p.x;
        const dy = y - p.y;
        const r2 = dx * dx + dy * dy;
        z += p.amplitude * Math.exp(-r2 / TWO_SIGMA_SQ);
      }
      positions[i + 2] = z;
    }
    positionAttr.needsUpdate = true;
  }

  /**
   * Approximate an item element's center in plane-local coordinates,
   * used only by the pinch displacement to place the Gaussian dimple
   * under the item that's graduating. With the single-container
   * layout, items have no 3D anchor — we read DOM rects instead and
   * map them onto the plane's local X/Y via the container's bbox.
   *
   * Returns (0, 0) if rects aren't available (headless / not yet
   * attached). The pinch is subtle at that amplitude; a fallback
   * center-of-plane dimple is fine in those cases.
   */
  private pinchCenterForElement(el: HTMLElement): [number, number] {
    if (typeof el.getBoundingClientRect !== "function") return [0, 0];
    const containerEl = this.stageEl;
    if (typeof containerEl.getBoundingClientRect !== "function") return [0, 0];
    const elRect = el.getBoundingClientRect();
    const contRect = containerEl.getBoundingClientRect();
    if (contRect.width === 0 || contRect.height === 0) return [0, 0];
    const cx = elRect.left + elRect.width / 2 - (contRect.left + contRect.width / 2);
    const cy = elRect.top + elRect.height / 2 - (contRect.top + contRect.height / 2);
    // CSS2DRenderer maps 1 plane-meter to roughly (contRect.width /
    // containerWidthInPixels) screen-ratio, but we just need an
    // approximation: treat the container's on-screen rect as a
    // bounded mapping to the plane's local span. Plane-local Y is
    // inverted (screen y-down vs plane y-up).
    const pxPerMeter = contRect.width / SLAB_WIDTH;
    const planeX = cx / pxPerMeter;
    const planeY = -cy / pxPerMeter;
    return [planeX, planeY];
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Build a meniscus-shaped plane: a rectangular grid of vertices with
 * the outer ring snapped onto a rounded-rectangle boundary. Produces
 * the same vertex count + face topology as `THREE.PlaneGeometry` of
 * the same segmentation, so pinch physics, sympathetic breathing,
 * and rest-position deformation all index into the dense interior
 * grid unchanged — only the silhouette softens.
 *
 * Doctrine: motebit-computer.md §"Visual properties (binding)" —
 * `Edges: meniscus (rounded surface-tension curve), no frame, no
 * border, no corner radius. Droplet family.` A sharp-cornered
 * rectangle violates this; the creature is a beaded sphere under
 * surface tension, and the slab is supposed to read as the same
 * material family flattened.
 *
 * Why geometry and not an `alphaMap`: MeshPhysicalMaterial's
 * `transmission` render pass ignores alphaMap (known Three.js
 * behavior through at least r170), so a masked plane reads as a
 * hard rectangle despite the alpha. Rounding the mesh itself fixes
 * the silhouette and sidesteps the conflict in one move.
 *
 * The corner-snap maps each vertex that lands inside a corner-square
 * of side `r` onto the arc of radius `r` centered on the inscribed
 * rectangle's corner. Interior vertices are untouched; only the
 * outer band warps. Result: a dense flat grid inside, a softly
 * curved outline outside.
 */
function createMeniscusPlaneGeometry(
  width: number,
  height: number,
  segX: number,
  segY: number,
): THREE.PlaneGeometry {
  const geo = new THREE.PlaneGeometry(width, height, segX, segY);
  const pos = geo.attributes.position;
  if (pos == null) return geo;

  // Corner radius: ~28% of the shorter side. Generous enough to read
  // as a droplet rather than "a rectangle with softened corners,"
  // while leaving a flat interior large enough to host items.
  const r = Math.min(width, height) * 0.28;
  const halfW = width / 2;
  const halfH = height / 2;
  // Inscribed rectangle's corner coordinates — the centers of the
  // four corner arcs.
  const cx = halfW - r;
  const cy = halfH - r;

  const arr = pos.array as Float32Array;
  for (let i = 0; i < arr.length; i += 3) {
    const x = arr[i]!;
    const y = arr[i + 1]!;
    const absX = Math.abs(x);
    const absY = Math.abs(y);
    // Only touch vertices inside a corner region.
    if (absX <= cx || absY <= cy) continue;
    // Vector from the corner-arc center out to this vertex.
    const ax = Math.sign(x) * cx;
    const ay = Math.sign(y) * cy;
    const dx = x - ax;
    const dy = y - ay;
    const d = Math.hypot(dx, dy);
    if (d === 0) continue;
    // Snap the vertex onto the arc (vertices already inside the arc
    // stay where they are — only those beyond `r` from the corner
    // center move inward).
    if (d > r) {
      const scale = r / d;
      arr[i] = ax + dx * scale;
      arr[i + 1] = ay + dy * scale;
    }
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/**
 * Build the items-container element. In a browser this is a real
 * `<div>` styled as a flex column. In headless tests there is no
 * `document`, so return a minimal stand-in with `style`, `className`,
 * `appendChild` / `removeChild`, and a `getBoundingClientRect` that
 * returns a zero-size rect — enough to satisfy the `pinchCenterForElement`
 * fallback without crashing. A real surface always has `document`;
 * the stand-in is purely for unit-test plumbing.
 */
function createContainerElement(): HTMLDivElement {
  if (typeof document === "undefined") {
    const children: HTMLElement[] = [];
    const stub = {
      className: "slab-stage",
      style: new Proxy(
        {},
        {
          get: () => "",
          set: () => true,
        },
      ) as unknown as CSSStyleDeclaration,
      appendChild: (child: HTMLElement) => {
        children.push(child);
        (child as unknown as { parentNode: unknown }).parentNode = stub;
        return child;
      },
      removeChild: (child: HTMLElement) => {
        const i = children.indexOf(child);
        if (i >= 0) children.splice(i, 1);
        (child as unknown as { parentNode: unknown }).parentNode = null;
        return child;
      },
      replaceChildren: (...newChildren: HTMLElement[]) => {
        for (const c of children) {
          (c as unknown as { parentNode: unknown }).parentNode = null;
        }
        children.length = 0;
        for (const c of newChildren) {
          children.push(c);
          (c as unknown as { parentNode: unknown }).parentNode = stub;
        }
      },
      getBoundingClientRect: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
      }),
    };
    return stub as unknown as HTMLDivElement;
  }
  const el = document.createElement("div");
  el.className = "slab-stage";
  // Single-stage — one primary embodiment at a time fills the plane.
  // Sized to fit within the 0.54 × 0.34m plane's on-screen projection
  // at the default camera (~670×410 CSS px on a 900px canvas); kept
  // slightly smaller so content has visible breathing room around
  // the plane's meniscus. Dimensions chosen conservatively so the
  // stage doesn't overflow on narrower viewports.
  el.style.width = "480px";
  el.style.height = "300px";
  el.style.boxSizing = "border-box";
  el.style.display = "block";
  el.style.overflow = "hidden";
  // Stage accepts pointer events so its primary child can be
  // interacted with (iframe navigation, text selection, etc.).
  el.style.pointerEvents = "auto";
  return el;
}

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
