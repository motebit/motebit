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
const SLAB_OFFSET_X = 0.3; // right of creature (meters)
const SLAB_OFFSET_Y = 0.0; // creature eye level
const SLAB_OFFSET_Z = -0.02; // just behind creature's front face
const SLAB_TILT_X = -0.22; // ~12.5° forward (radians)
const SLAB_TILT_Y = -0.09; // ~5° yaw toward creature (radians) — doctrine

/** Golden-ratio-ish aspect. ~1.3 body radii wide; fits the viewport. */
const SLAB_WIDTH = 0.36;
const SLAB_HEIGHT = 0.22;

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
    // Segmented plane so the pinch physics (Pass 3) has vertices to
    // displace. 16×16 gives a visible Gaussian bump without overhead
    // that matters on any device that runs Three.js. The unpinched
    // geometry is co-planar — vertex Z stays at 0 except during
    // active pinch displacement.
    const planeGeo = new THREE.PlaneGeometry(SLAB_WIDTH, SLAB_HEIGHT, 16, 16);
    // Preserve the flat Z=0 positions so the pinch code can reset to
    // rest without a geometry rebuild each frame.
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
      ior: CANONICAL_MATERIAL.ior,
      roughness: 0.06,
      transmission: 0.82,
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
    // Reflow — `slotPosition` compresses spacing as the stack grows,
    // so the newly-added item changes the layout for the existing
    // items too. Cheap (items.size is small) and keeps the stack
    // readable as research accumulates.
    this.reflowStack();

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

    let warmthTarget = 0;
    if (active > 0) {
      this.emptyTime = 0;
      this.hasBeenActive = true;
      this.planeVisibility = Math.min(1, this.planeVisibility + deltaTime * 3);
      warmthTarget = 1;
    } else if (!this.hasBeenActive) {
      // Before first activity ever, the slab is fully invisible — no
      // droplet has emerged from nothing to show.
      this.planeVisibility = 0;
    } else {
      this.emptyTime += deltaTime;
      // Idle window: plane stays at meniscus (refraction + a trace of
      // body so the glass is *present*, honestly empty). Past the
      // recession delay, fades to near-invisible but the plane mesh
      // stays mounted — identity preserved.
      const recessFactor = Math.max(0, Math.min(1, (this.emptyTime - RECESSION_DELAY_S) / 2));
      const idleVisibility = 0.32 * (1 - recessFactor);
      this.planeVisibility = smoothToward(this.planeVisibility, idleVisibility, deltaTime, 4);
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
    this.itemsGroup.remove(item.object);
    item.phaseListeners.clear();
    this.items.delete(id);
    // Reflow — the stack's spacing recomputes based on total count,
    // so a removal relaxes the spacing for the remaining items.
    // Cheap and keeps the layout honest as items dismiss.
    this.reflowStack();
  }

  /**
   * Recompute every mounted item's slot position based on the current
   * total count. Called after addItem / removeImmediate so the stack's
   * compression stays consistent as items arrive and leave. Slot
   * indices assign by insertion order (Map iteration is insertion-
   * ordered in JS); pinned items (future) will anchor to the top and
   * exempt themselves from FIFO pressure.
   */
  private reflowStack(): void {
    let slot = 0;
    for (const item of this.items.values()) {
      const [x, y, z] = this.slotPosition(slot);
      item.object.position.set(x, y, z);
      item.slot = slot;
      slot += 1;
    }
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
      const pos = item.object.position;
      pinches.push({ x: pos.x, y: pos.y, amplitude: amp });
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
   * Slot layout in plane-local space. Items stack vertically from the
   * plane's top edge downward. Under the workstation frame
   * (motebit-computer.md §"Three end states"), items rest on the slab
   * until dismissed — so the layout must accommodate accumulation.
   *
   * Strategy: tighten the stack as more items land, so a research
   * session with 6–10 resting items stays legible without overflow.
   * The CSS2D overlay already handles in-card scroll for long content;
   * this function just picks where the card's anchor sits in 3D space.
   *
   * Pinned items (future) will exempt themselves from FIFO pressure;
   * for now every item stacks in arrival order.
   */
  private slotPosition(slot: number): [number, number, number] {
    const topY = SLAB_HEIGHT / 2 - 0.02;
    const total = Math.max(1, this.items.size);
    // Spacing compresses as the stack grows — 0.05 for a light stack,
    // easing down to 0.034 once ~8 items are held. Keeps the whole
    // stack visible on the 0.22m-tall plane without hard clipping.
    const spacing = total <= 4 ? 0.05 : Math.max(0.034, 0.05 - (total - 4) * 0.003);
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
