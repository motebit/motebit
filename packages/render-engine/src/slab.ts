/**
 * Slab Manager — desktop / web renderer for the "Motebit Computer."
 *
 * State machine lives in `slab-core.ts` (Ring 1 — same on every surface
 * that renders a slab). This module owns the desktop / web rendering
 * primitive: a liquid-glass plane floating to the right of the
 * creature, items mounted via `CSS2DObject`, sympathetic breathing,
 * Rayleigh-Plateau pinch displacement on the plane mesh.
 *
 * One state machine, two renderers (desktop here, spatial in
 * `slab-spatial.ts`). The Ring 1 / Ring 3 split is structural:
 *
 *   - `SlabCore` tracks ids, phases, lifecycle timings, ambient counts.
 *     Rendering-free.
 *   - `SlabManager` and `SpatialSlabManager` each consume the core and
 *     apply surface-native visuals.
 *
 * What this module is:
 *
 *   - A `THREE.Group` containing the liquid-glass plane mesh + a
 *     CSS2DObject anchor for HTML items mounted on its surface. Same
 *     material family as the creature (borosilicate IOR, transmission,
 *     low roughness) — body-adjacent, not a UI element.
 *
 *   - Per-frame DOM animation (emerge / dissolve / pinch) driven from
 *     the core's snapshot — phase + phaseTime in, element transforms
 *     out.
 *
 *   - Plane vertex displacement during pinches (Rayleigh-Plateau bump).
 *
 *   - Soul-color coupling on the plane material, eased on top of the
 *     core's `activeWarmth`.
 */

import * as THREE from "three";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import type {
  ArtifactSpec,
  ArtifactHandle,
  InteriorColor,
  SlabItemSpec,
  SlabItemHandle,
} from "./spec.js";
import { CANONICAL_MATERIAL } from "./spec.js";
import { GOLDEN_RATIO } from "./design-ratios.js";
import {
  SlabCore,
  SLAB_EMERGE_DURATION_S,
  SLAB_DISSOLVE_DURATION_S,
  SLAB_PINCH_DURATION_S,
  SLAB_PINCH_PHASE2_START,
  SLAB_PINCH_PHASE2_END,
  SLAB_BREATHE_FREQUENCY_HZ,
  SLAB_BREATHE_AMPLITUDE_FACTOR,
  type DetachArtifactHandler,
  type SlabCoreItemSnapshot,
} from "./slab-core.js";

export type { DetachArtifactHandler } from "./slab-core.js";

// ── Geometry + positioning constants (desktop renderer only) ─────────

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
 * container. Aspect locked to the golden ratio (φ ≈ 1.618) via the
 * shared `GOLDEN_RATIO` constant; see `design-ratios.ts` for the rule
 * and scope (body-adjacent display surfaces in the droplet/material
 * family).
 */
const SLAB_WIDTH = 0.54;
const SLAB_HEIGHT = SLAB_WIDTH / GOLDEN_RATIO;

// ── Renderer-side per-item state ─────────────────────────────────────

interface ManagedElement {
  element: HTMLElement;
  /** Tracked once per item — `slab-item-resting` class application. */
  restingApplied: boolean;
}

// ── Slab Manager ─────────────────────────────────────────────────────

export class SlabManager {
  private readonly group: THREE.Group;
  private readonly planeMesh: THREE.Mesh;
  private readonly planeMaterial: THREE.MeshPhysicalMaterial;
  /**
   * One CSS2DObject anchored at the plane's center, holding a single
   * "stage" div — the plane renders ONE primary embodiment at a time
   * (doctrine: motebit-computer.md §"Embodiment modes"). Cards-on-
   * glass don't exist; the stage's child is whatever the motebit is
   * currently working on (browser page, terminal, IDE).
   */
  private readonly stageAnchor: CSS2DObject;
  private readonly stageEl: HTMLDivElement;
  private readonly css2dRenderer: CSS2DRenderer;
  /** Per-id renderer state — DOM element + per-render flags. */
  private readonly elements = new Map<string, ManagedElement>();
  private readonly core: SlabCore;
  /**
   * Current soul color. Doctrine mandates the slab's active tint
   * derives from the creature's interior color — "cyan creature → cyan
   * slab warmth." The plane's attenuation + emissive lerp toward this
   * when ambient is active, and back toward neutral when idle.
   */
  private soulTint: [number, number, number] = [0.95, 0.97, 1.0];
  private soulGlow: [number, number, number] = [0.55, 0.78, 1.0];

  constructor(
    creatureGroup: THREE.Group,
    container: HTMLElement,
    opts?: { detachHandler?: DetachArtifactHandler },
  ) {
    this.core = new SlabCore({ detachHandler: opts?.detachHandler ?? null });

    // Group hosts the plane + its items, mounted as a child of the
    // creature so it inherits the creature's world transform.
    this.group = new THREE.Group();
    this.group.name = "slab";
    this.group.position.set(SLAB_OFFSET_X, SLAB_OFFSET_Y, SLAB_OFFSET_Z);
    this.group.rotation.set(SLAB_TILT_X, SLAB_TILT_Y, 0);
    creatureGroup.add(this.group);

    // Plane geometry — meniscus-curved outline, dense interior grid
    // (see createMeniscusPlaneGeometry).
    const planeGeo = createMeniscusPlaneGeometry(SLAB_WIDTH, SLAB_HEIGHT, 16, 16);
    const posAttr = planeGeo.attributes.position;
    if (posAttr != null) {
      const restPositions = posAttr.array.slice();
      (planeGeo.userData as { restPositions?: ArrayLike<number> }).restPositions = restPositions;
    }
    this.planeMaterial = new THREE.MeshPhysicalMaterial({
      // Same material family as the creature — same IOR, same
      // clearcoat chemistry. The slab is body-adjacent.
      ior: CANONICAL_MATERIAL.ior,
      roughness: 0.12,
      transmission: 0.55,
      thickness: 0.04,
      clearcoat: 0.6,
      clearcoatRoughness: 0.05,
      color: new THREE.Color(0.98, 0.985, 1.0),
      attenuationColor: new THREE.Color(0.92, 0.95, 1.0),
      attenuationDistance: 0.6,
      sheen: 0.35,
      sheenRoughness: 0.9,
      sheenColor: new THREE.Color(0.75, 0.85, 1.0),
      emissive: new THREE.Color(0, 0, 0),
      emissiveIntensity: 0,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
    });
    this.planeMesh = new THREE.Mesh(planeGeo, this.planeMaterial);
    this.planeMesh.visible = false; // skip GL work when truly recessed
    this.group.add(this.planeMesh);

    // Items container — one CSS2DObject rooted at the plane's center.
    this.stageEl = createContainerElement();
    this.stageAnchor = new CSS2DObject(this.stageEl);
    this.stageAnchor.position.set(0, 0, 0.001);
    this.group.add(this.stageAnchor);

    this.css2dRenderer = new CSS2DRenderer();
    this.css2dRenderer.setSize(container.clientWidth, container.clientHeight);
    this.css2dRenderer.domElement.style.position = "absolute";
    this.css2dRenderer.domElement.style.top = "0";
    this.css2dRenderer.domElement.style.left = "0";
    this.css2dRenderer.domElement.style.zIndex = "2";
    this.css2dRenderer.domElement.style.pointerEvents = "none";
    container.appendChild(this.css2dRenderer.domElement);
  }

  /** Expose the THREE group so the adapter can position/animate externally. */
  getGroup(): THREE.Group {
    return this.group;
  }

  /**
   * Couple the slab's active tint to the creature's soul color. The
   * plane lerps toward this when items are on the slab and back
   * toward neutral-cool when idle — "cyan creature → cyan slab
   * warmth," per motebit-computer.md §"Visual properties."
   */
  setInteriorColor(color: InteriorColor): void {
    this.soulTint = [color.tint[0], color.tint[1], color.tint[2]];
    this.soulGlow = [color.glow[0], color.glow[1], color.glow[2]];
  }

  /**
   * Hold the empty slab visible. Items always make the plane visible
   * regardless; this flag governs only the empty-state behavior.
   */
  setUserVisible(visible: boolean): void {
    this.core.setUserVisible(visible);
  }

  toggleUserVisible(): boolean {
    return this.core.toggleUserVisible();
  }

  // ── Public API — mirrors the RenderAdapter slab methods ───────────

  addItem(spec: SlabItemSpec): SlabItemHandle {
    // Single-stage model (motebit-computer.md §"Embodiment modes"):
    // the plane renders ONE primary embodiment at a time. Mind-mode
    // items (slabHidden) are tracked by the core for lifecycle
    // contracts but never mounted on the visible stage.
    spec.element.style.pointerEvents = "auto";
    spec.element.style.transform = "scale(0)";
    spec.element.style.transformOrigin = "center center";
    spec.element.style.opacity = "0";

    // `.dataset` may be absent in headless tests — read defensively.
    const slabHidden =
      (spec.element as { dataset?: Record<string, string> }).dataset?.slabHidden === "true";
    if (!slabHidden) {
      // Replace the current stage content with this new element. Any
      // previous primary's exit physics continues against its own
      // element (its dissolve / pinch animation completes even though
      // it's no longer in the stage), resolving pending promises.
      if (typeof this.stageEl.replaceChildren === "function") {
        this.stageEl.replaceChildren(spec.element);
      } else {
        this.stageEl.appendChild(spec.element);
      }
    }

    this.elements.set(spec.id, { element: spec.element, restingApplied: false });
    return this.core.addItem({ id: spec.id, kind: spec.kind, slabHidden });
  }

  dissolveItem(id: string): Promise<void> {
    return this.core.dissolveItem(id);
  }

  detachItemAsArtifact(id: string, artifact: ArtifactSpec): Promise<ArtifactHandle | undefined> {
    return this.core.detachItemAsArtifact(id, artifact);
  }

  clearItems(): void {
    for (const { element } of this.elements.values()) {
      if (element.parentNode === this.stageEl) {
        this.stageEl.removeChild(element);
      }
    }
    this.elements.clear();
    this.core.clearItems();
  }

  /**
   * Per-frame update. Drives the core forward, applies per-item DOM
   * animations from the core's snapshot, displaces the plane vertices
   * for active pinches, eases plane visibility + soul-color coupling.
   *
   * `t` is total animation time (seconds), matching the creature's
   * render frame. `deltaTime` is the frame delta (seconds).
   */
  update(t: number, deltaTime: number): void {
    const frame = this.core.tick(deltaTime);

    // Per-item DOM animation. Items that just transitioned to `gone`
    // arrive once with phase=gone — clean up the parallel element
    // record; the dissolve/pinch animation already brought opacity
    // to ~0, so removal is silent.
    for (const item of frame.items) {
      const managed = this.elements.get(item.id);
      if (!managed) continue;
      this.animateElement(managed, item);
      if (item.phase === "gone") {
        if (managed.element.parentNode === this.stageEl) {
          this.stageEl.removeChild(managed.element);
        }
        this.elements.delete(item.id);
      }
    }

    // Plane vertex displacement from active pinches. Rebuilt every
    // frame from rest positions so vertices return to flat cleanly
    // when no pinch is active; multiple parallel pinches sum.
    this.applyPinchDisplacement(frame.items);

    // Sympathetic breathing — same time base as the creature so phases
    // lock without inter-object signaling.
    const breatheRaw = Math.sin(t * SLAB_BREATHE_FREQUENCY_HZ * Math.PI * 2);
    const breathe =
      (breatheRaw > 0 ? breatheRaw : Math.sign(breatheRaw) * Math.pow(Math.abs(breatheRaw), 0.6)) *
      SLAB_BREATHE_AMPLITUDE_FACTOR *
      0.012;

    // Soul-color coupling — neutral-cool at warmth=0, full soul tint
    // at warmth=1. Emissive intensity gentle so the plane never
    // outshines the creature.
    const w = frame.activeWarmth;
    const attR = 0.92 * (1 - w) + this.soulTint[0] * w;
    const attG = 0.95 * (1 - w) + this.soulTint[1] * w;
    const attB = 1.0 * (1 - w) + this.soulTint[2] * w;
    this.planeMaterial.attenuationColor.setRGB(attR, attG, attB);
    this.planeMaterial.emissive.setRGB(this.soulGlow[0], this.soulGlow[1], this.soulGlow[2]);
    this.planeMaterial.emissiveIntensity = w * 0.12 * (0.85 + 0.15 * breatheRaw);

    this.planeMaterial.opacity = frame.planeVisibility;
    this.planeMesh.visible = frame.planeVisibility > 0.01;
    this.planeMesh.scale.set(1 + breathe, 1 + breathe, 1);
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

  // ── Internal: per-item DOM animation ──────────────────────────────

  private animateElement(managed: ManagedElement, item: SlabCoreItemSnapshot): void {
    const el = managed.element;
    switch (item.phase) {
      case "emerging": {
        const tt = item.phaseTime / SLAB_EMERGE_DURATION_S;
        const progress = easeOutQuad(Math.min(1, tt));
        el.style.transform = `scale(${progress})`;
        el.style.opacity = String(progress);
        break;
      }
      case "active":
        // Steady state — ensure the final emerging frame's transform
        // is locked to scale 1 (covers the case where the emerging →
        // active transition fires inside the core mid-frame).
        el.style.transform = "scale(1)";
        el.style.opacity = "1";
        break;
      case "resting":
        // Working-material state. Class hook for surface styling +
        // subtle desaturation reading as "held, not active" without
        // hiding content. Doctrine: motebit-computer.md §"Settling
        // into rest."
        if (!managed.restingApplied) {
          managed.restingApplied = true;
          el.classList.add("slab-item-resting");
          el.classList.remove("slab-item-active");
          el.style.filter = "saturate(0.92)";
        }
        break;
      case "dissolving": {
        const tt = item.phaseTime / SLAB_DISSOLVE_DURATION_S;
        const progress = 1 - easeInQuad(Math.min(1, tt));
        el.style.transform = `scale(${progress})`;
        el.style.opacity = String(progress);
        break;
      }
      case "pinching": {
        // Rayleigh-Plateau-inspired three-phase pinch — same physics
        // story as the prior implementation, now reading phase +
        // phaseTime from the core snapshot.
        const tt = Math.min(1, item.phaseTime / SLAB_PINCH_DURATION_S);
        if (tt < SLAB_PINCH_PHASE2_START) {
          // Tension — bead building
          const local = tt / SLAB_PINCH_PHASE2_START;
          const scale = 1 + easeInOutQuad(local) * 0.15;
          el.style.transform = `scale(${scale.toFixed(3)})`;
          el.style.opacity = "1";
        } else if (tt < SLAB_PINCH_PHASE2_END) {
          // Separation — squash-stretch + launch
          const local =
            (tt - SLAB_PINCH_PHASE2_START) / (SLAB_PINCH_PHASE2_END - SLAB_PINCH_PHASE2_START);
          const scaleY = 1.15 + local * 0.15;
          const scaleX = 1.15 - local * 0.25;
          const liftPx = easeInOutQuad(local) * 14;
          el.style.transform = `translateY(${(-liftPx).toFixed(1)}px) scale(${scaleX.toFixed(3)}, ${scaleY.toFixed(3)})`;
          el.style.opacity = (1 - local * 0.25).toFixed(3);
        } else {
          // Dissipation — bead gone, slab-mounted copy fades
          const local = (tt - SLAB_PINCH_PHASE2_END) / (1 - SLAB_PINCH_PHASE2_END);
          const scale = 1.15 - local * 0.3;
          const liftPx = 14 + local * 10;
          el.style.transform = `translateY(${(-liftPx).toFixed(1)}px) scale(${scale.toFixed(3)})`;
          el.style.opacity = (0.75 * (1 - easeInQuad(local))).toFixed(3);
        }
        break;
      }
      case "detached":
        // Brief tail — element stays where the dissipation phase left
        // it. Cleanup happens at `gone`.
        break;
      case "gone":
        // No DOM mutation here — caller in `update()` removes the
        // element from the stage and drops the parallel record.
        break;
    }
  }

  // ── Internal: plane vertex displacement ───────────────────────────

  /**
   * Rayleigh-Plateau-inspired plane surface displacement during
   * pinching. For each pinching item, raises a Gaussian bump in the
   * plane's vertex Z around the item's anchor point. Amplitude curve
   * matches the element's three-phase trajectory: tension grows,
   * separation peaks, dissipation collapses back to flat.
   */
  private applyPinchDisplacement(items: readonly SlabCoreItemSnapshot[]): void {
    const geometry = this.planeMesh.geometry as THREE.PlaneGeometry;
    const positionAttr = geometry.attributes.position;
    if (positionAttr == null) return;
    const rest = (geometry.userData as { restPositions?: ArrayLike<number> }).restPositions;
    if (rest == null) return;

    const positions = positionAttr.array as Float32Array;

    const pinches: Array<{ x: number; y: number; amplitude: number }> = [];
    for (const item of items) {
      if (item.phase !== "pinching") continue;
      const managed = this.elements.get(item.id);
      if (!managed) continue;
      const tt = Math.min(1, item.phaseTime / SLAB_PINCH_DURATION_S);
      let amp: number;
      if (tt < SLAB_PINCH_PHASE2_START) {
        amp = easeInOutQuad(tt / SLAB_PINCH_PHASE2_START) * 0.008;
      } else if (tt < SLAB_PINCH_PHASE2_END) {
        const local =
          (tt - SLAB_PINCH_PHASE2_START) / (SLAB_PINCH_PHASE2_END - SLAB_PINCH_PHASE2_START);
        amp = 0.008 + easeInOutQuad(local) * 0.006;
      } else {
        const local = (tt - SLAB_PINCH_PHASE2_END) / (1 - SLAB_PINCH_PHASE2_END);
        amp = 0.014 * (1 - easeInQuad(local));
      }
      const [px, py] = this.pinchCenterForElement(managed.element);
      pinches.push({ x: px, y: py, amplitude: amp });
    }

    if (pinches.length === 0) {
      if (positions[2] !== rest[2]) {
        positions.set(rest);
        positionAttr.needsUpdate = true;
      }
      return;
    }

    // Gaussian bump: z(p) = Σᵢ ampᵢ · exp(-|p - centerᵢ|² / 2σ²)
    // σ ~ half an item-slot width keeps a single dimple locally
    // contained.
    const SIGMA = 0.06;
    const TWO_SIGMA_SQ = 2 * SIGMA * SIGMA;
    for (let i = 0; i < positions.length; i += 3) {
      const x = rest[i]!;
      const y = rest[i + 1]!;
      let z = rest[i + 2]!;
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
   * under the item that's graduating.
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
 * border, no corner radius. Droplet family.` The creature is a beaded
 * sphere under surface tension; the slab reads as the same material
 * family flattened.
 *
 * Why geometry and not an `alphaMap`: MeshPhysicalMaterial's
 * `transmission` render pass ignores alphaMap (known Three.js
 * behavior through at least r170), so a masked plane reads as a
 * hard rectangle despite the alpha. Rounding the mesh itself fixes
 * the silhouette and sidesteps the conflict in one move.
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
  const cx = halfW - r;
  const cy = halfH - r;

  const arr = pos.array as Float32Array;
  for (let i = 0; i < arr.length; i += 3) {
    const x = arr[i]!;
    const y = arr[i + 1]!;
    const absX = Math.abs(x);
    const absY = Math.abs(y);
    if (absX <= cx || absY <= cy) continue;
    const ax = Math.sign(x) * cx;
    const ay = Math.sign(y) * cy;
    const dx = x - ax;
    const dy = y - ay;
    const d = Math.hypot(dx, dy);
    if (d === 0) continue;
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
 * `<div>`; in headless tests there is no `document`, so return a
 * minimal stand-in with `style`, `className`, `appendChild`,
 * `removeChild`, `replaceChildren`, and a zero-rect
 * `getBoundingClientRect` — enough to satisfy `pinchCenterForElement`
 * without crashing.
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
  // Single-stage — one primary embodiment fills the plane. Sized to
  // fit within the 0.54 × 0.34m plane's on-screen projection at the
  // default camera (~670×410 CSS px on a 900px canvas); kept slightly
  // smaller so content has visible breathing room.
  el.style.width = "480px";
  el.style.height = "300px";
  el.style.boxSizing = "border-box";
  el.style.display = "block";
  el.style.overflow = "hidden";
  // `pointer-events: none` on the stage so its dead space — when the
  // plane is visible but empty, or in transparent margins around a
  // mounted item — passes pointer events through to the canvas's
  // OrbitControls underneath. Mounted items receive `pointer-events:
  // auto` in addItem, so their bounding boxes still capture events;
  // only unoccupied stage area becomes click-through. Without this,
  // any pointer in the slab's region was stolen from the creature's
  // rotate/zoom controls — the bug fixed by commit 89467720.
  el.style.pointerEvents = "none";
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
