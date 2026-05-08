/**
 * Slab Manager — desktop / web renderer for the "Motebit Computer."
 *
 * State machine lives in `slab-core.ts` (Ring 1 — same on every surface
 * that renders a slab). This module owns the desktop / web rendering
 * primitive: a liquid-glass plane floating to the right of the
 * creature, items mounted via `CSS3DObject`, sympathetic breathing,
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
 *     CSS3DObject anchor for HTML items mounted on its surface. Same
 *     material family as the creature (borosilicate IOR, transmission,
 *     low roughness) — body-adjacent, not a UI element. CSS3D is
 *     load-bearing here: the plane sits at SLAB_TILT_X (~12° forward)
 *     and SLAB_TILT_Y (~5° yaw toward creature), and CSS3DObject
 *     respects that 3D transform — items tilt with the plane the way
 *     the creature's eyes tilt with the head. The earlier CSS2D
 *     implementation billboarded items to the camera, which made the
 *     chrome float off as a flat sticker disconnected from the
 *     plane's pose (visible in the 2026-05-07 angled-view triage).
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
import { CSS3DObject, CSS3DRenderer } from "three/addons/renderers/CSS3DRenderer.js";
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

/**
 * Corner radius for the meniscus silhouette. The plane geometry's
 * outer ring snaps onto a rounded-rectangle of this radius (see
 * `createMeniscusPlaneGeometry`); the side-wall geometry samples
 * the same rounded-rect outline so the perimeter of the front pane,
 * the back pane, and the side wall all trace the same curve.
 *
 * 28% of the shorter side reads as a droplet rather than a softened
 * rectangle. Doctrine: motebit-computer.md §"Visual properties" —
 * `Edges: meniscus, no frame, no border, no corner radius. Droplet
 * family.`
 */
const SLAB_CORNER_RADIUS = Math.min(SLAB_WIDTH, SLAB_HEIGHT) * 0.28;

/**
 * Volumetric thickness of the slab. The body is a 3D droplet — eyes,
 * mouth, and soul-glow are *embedded inside* its glass, not painted
 * on. A flat-plane slab read as a "razor-thin paper sticker next to
 * the body" (2026-05-07 angled-view triage); doctrine
 * (motebit-computer.md §"Visual properties") names the slab as
 * body-adjacent, same material family as the creature, so it must
 * share the body's volumetric register.
 *
 * 0.04m matches the `MeshPhysicalMaterial.thickness` shader hint
 * already declared on `planeMaterial` — keeping geometry and
 * refraction-thickness aligned avoids the discrepancy where the
 * shader believed the glass was 4cm thick while the geometry
 * presented as 0mm.
 *
 * The slab is built as a front pane + back pane separated by this
 * thickness; the open volume between them is where embodiment
 * content lives (see `STAGE_Z_OFFSET_FROM_BACK`). Step 3 of the
 * volume arc renders content as a back-pane texture so it refracts
 * through the front; step 2 (this) gets the geometry depth in place
 * first so the perceptual register changes.
 */
const SLAB_THICKNESS = 0.04;

/**
 * CSS3DObject pixel→world scale. The stage div is sized in CSS pixels
 * (480×300 from createContainerElement); CSS3D treats those pixels as
 * world units unless scaled. Map the stage edge-to-edge with the
 * plane's projected extent so content fills the perceptual organ —
 * `SLAB_WIDTH / stage_pixel_width = 0.54 / 480 ≈ 0.001125`. Single
 * scalar holds for both axes because the stage's 480×300 (1.6:1) and
 * the plane's 0.54×0.334 (φ ≈ 1.618:1) aspect ratios are within 1%.
 *
 * `STAGE_PIXEL_WIDTH` mirrors the value in `createContainerElement`
 * below; if that footprint changes (e.g., for a denser embodiment),
 * update both. The duplication is intentional — the constant lives
 * here so the per-pixel scale derivation reads at the construction
 * site, and `createContainerElement` stays a pure DOM factory the
 * test fakes can substitute without importing this module's geometry.
 */
const STAGE_PIXEL_WIDTH = 480;
const STAGE_PIXEL_TO_WORLD = SLAB_WIDTH / STAGE_PIXEL_WIDTH;

/**
 * Stage z-position relative to the back pane. Content sits 1mm in
 * front of the back glass — close enough to read as "embedded
 * against the rear surface" rather than floating in the middle of
 * the volume, and far enough that pinch deformation on the front
 * pane (which arcs forward toward the camera) doesn't intersect
 * the stage's CSS3D plane. The full stage z in slab-local space is
 * `(-SLAB_THICKNESS / 2) + STAGE_Z_OFFSET_FROM_BACK`.
 */
const STAGE_Z_OFFSET_FROM_BACK = 0.001;

// ── Renderer-side per-item state ─────────────────────────────────────

interface ManagedElement {
  element: HTMLElement;
  /** Tracked once per item — `slab-item-resting` class application. */
  restingApplied: boolean;
}

// ── Slab Manager ─────────────────────────────────────────────────────

export class SlabManager {
  private readonly group: THREE.Group;
  /**
   * Front (camera-facing) pane. Pinch displacement targets this one.
   * `group.children` ordering puts this first so consumers (tests,
   * adapters) that read `group.children.find(c => c instanceof Mesh)`
   * still resolve to the visible-from-the-front pane.
   */
  private readonly planeMesh: THREE.Mesh;
  /**
   * Back pane. Mirrors the front geometry, sealed against camera-
   * side. Stays rigid during pinches — only the front face arcs
   * toward the viewer when an item detaches as an artifact.
   */
  private readonly backPaneMesh: THREE.Mesh;
  /**
   * Side-wall mesh wrapping front pane perimeter to back pane
   * perimeter. Closes the volume so the slab reads as a single
   * solid glass slate from any angle. Without it, off-axis views
   * showed two parallel membranes with hollow space between
   * (the 2026-05-07 19:03 angled-view triage).
   */
  private readonly sideWallMesh: THREE.Mesh;
  private readonly planeMaterial: THREE.MeshPhysicalMaterial;
  /**
   * One CSS3DObject anchored at the plane's center, holding a single
   * "stage" div — the plane renders ONE primary embodiment at a time
   * (doctrine: motebit-computer.md §"Embodiment modes"). Cards-on-
   * glass don't exist; the stage's child is whatever the motebit is
   * currently working on (browser page, terminal, IDE). CSS3D
   * (vs. CSS2D) means the stage element follows the plane's tilt
   * and rotation in 3D space rather than billboarding flat against
   * the camera — the slab's pose is the content's pose.
   */
  private readonly stageAnchor: CSS3DObject;
  private readonly stageEl: HTMLDivElement;
  private readonly css3dRenderer: CSS3DRenderer;
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
    // Front + back panes form the slab volume. Front holds the
    // pinch-displacement geometry (its restPositions live in
    // userData); back is a clone of the same geometry so its position
    // buffer is independent — pinch displacement writes to front
    // vertex positions only, and the clone keeps the back rigid.
    // Both panes share planeMaterial so opacity / soul-color easing
    // applies uniformly with one assignment. Both attach directly
    // to `group` so existing consumers that walk `group.children`
    // for the slab mesh still resolve (front is added first; the
    // first Mesh in children is the front pane).
    this.planeMesh = new THREE.Mesh(planeGeo, this.planeMaterial);
    this.planeMesh.position.z = SLAB_THICKNESS / 2;
    this.planeMesh.visible = false; // skip GL work when truly recessed
    this.group.add(this.planeMesh);

    const backPaneGeo = planeGeo.clone();
    this.backPaneMesh = new THREE.Mesh(backPaneGeo, this.planeMaterial);
    this.backPaneMesh.position.z = -SLAB_THICKNESS / 2;
    // Back pane faces "outward" relative to the volume — flip it so
    // its normals point away from the camera, letting the sheen and
    // clearcoat read on the side a viewer never directly sees but
    // whose silhouette is what gives the slab its depth from any
    // angle off-axis.
    this.backPaneMesh.rotation.y = Math.PI;
    this.backPaneMesh.visible = false;
    this.group.add(this.backPaneMesh);

    // Side wall — closes the volume. Without this the dual-pane
    // construction reads as two parallel membranes with hollow space
    // (visible from off-axis angles); the wall makes the silhouette
    // continuous so the slab reads as one solid glass tile, the way
    // the creature reads as one droplet rather than a sphere with
    // open seams.
    const sideWallGeo = createSideWallGeometry(
      SLAB_WIDTH,
      SLAB_HEIGHT,
      SLAB_THICKNESS,
      SLAB_CORNER_RADIUS,
    );
    this.sideWallMesh = new THREE.Mesh(sideWallGeo, this.planeMaterial);
    this.sideWallMesh.visible = false;
    this.group.add(this.sideWallMesh);

    // Items container — one CSS3DObject rooted near the back pane.
    // `CSS3DObject`'s constructor force-sets `pointer-events: auto` and
    // `position: absolute` on the wrapped element; the stage's
    // pointer-events: none (so empty stage passes camera-control
    // gestures through) is re-applied AFTER the wrap.
    this.stageEl = createContainerElement();
    this.stageAnchor = new CSS3DObject(this.stageEl);
    this.stageEl.style.pointerEvents = "none";
    // Embed the stage inside the slab's glass volume — 1mm in front
    // of the back pane (slab-local z = -SLAB_THICKNESS/2 + offset).
    // Reads as "content rests against the back of the slab and is
    // viewed *through* the front glass," parallel to how the
    // creature's eyes sit inside the droplet and are viewed through
    // the front of the sphere. Step 3 of the volume arc makes that
    // viewing literally refractive (canvas-textured back pane); for
    // step 2 the registry depth alone is the visible win — content
    // recedes into the volume instead of floating on top of paper.
    this.stageAnchor.position.set(0, 0, -SLAB_THICKNESS / 2 + STAGE_Z_OFFSET_FROM_BACK);
    // Pixel→world scale so the 480×300 CSS-pixel stage maps to the
    // plane's 0.54×0.334m extent edge-to-edge. Without this, CSS3D
    // would render 480 world units across — the stage would be a
    // building, not a panel.
    this.stageAnchor.scale.set(STAGE_PIXEL_TO_WORLD, STAGE_PIXEL_TO_WORLD, 1);
    this.group.add(this.stageAnchor);

    this.css3dRenderer = new CSS3DRenderer();
    this.css3dRenderer.setSize(container.clientWidth, container.clientHeight);
    this.css3dRenderer.domElement.style.position = "absolute";
    this.css3dRenderer.domElement.style.top = "0";
    this.css3dRenderer.domElement.style.left = "0";
    this.css3dRenderer.domElement.style.zIndex = "2";
    // The renderer's container holds CSS3D-transformed children whose
    // pointer-events are managed per-item; the container itself never
    // captures input.
    this.css3dRenderer.domElement.style.pointerEvents = "none";
    container.appendChild(this.css3dRenderer.domElement);
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
    const visible = frame.planeVisibility > 0.01;
    this.planeMesh.visible = visible;
    this.backPaneMesh.visible = visible;
    this.sideWallMesh.visible = visible;
    // Sympathetic breathing applies to all three meshes (front, back,
    // sides) uniformly — the slab inflates as one volume. Per-mesh
    // (rather than via a wrapper group) so the CSS3D stage — also a
    // child of `group` — stays at its native scale; if the stage
    // breathed, text glyphs would jitter along the breathe axis at
    // 0.3Hz, fighting readability for visual rhythm.
    const breatheScale = 1 + breathe;
    this.planeMesh.scale.set(breatheScale, breatheScale, 1);
    this.backPaneMesh.scale.set(breatheScale, breatheScale, 1);
    this.sideWallMesh.scale.set(breatheScale, breatheScale, 1);
    if (this.stageEl.style) {
      this.stageEl.style.display = visible ? "block" : "none";
    }
  }

  /** Called after WebGL render each frame — syncs CSS overlay. */
  render(scene: THREE.Scene, camera: THREE.Camera): void {
    this.css3dRenderer.render(scene, camera);
  }

  resize(width: number, height: number): void {
    this.css3dRenderer.setSize(width, height);
  }

  dispose(): void {
    this.clearItems();
    this.css3dRenderer.domElement.remove();
    this.planeMesh.geometry.dispose();
    this.backPaneMesh.geometry.dispose();
    this.sideWallMesh.geometry.dispose();
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

  // Corner radius — sourced from the module-level SLAB_CORNER_RADIUS
  // constant so the front pane, back pane, and side wall all trace
  // the same rounded-rectangle outline. Pre-derivation: 28% of the
  // shorter side reads as a droplet rather than "a rectangle with
  // softened corners," while leaving a flat interior large enough
  // to host items.
  const r = SLAB_CORNER_RADIUS;
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
 * Build the slab's side-wall geometry — a triangle strip wrapping
 * the perimeter of the rounded-rectangle outline, connecting the
 * front pane (at z = +thickness/2) to the back pane (at z =
 * -thickness/2).
 *
 * Without this, the dual-pane construction reads as two parallel
 * membranes with hollow space (visible from off-axis angles); the
 * wall closes the silhouette so the slab reads as one solid glass
 * tile from any viewpoint — same way the creature reads as one
 * droplet rather than a sphere with open seams.
 *
 * The perimeter samples the same rounded-rect outline that the
 * front + back panes' meniscus snap converges on. Per-side sample
 * count is generous enough (32) that the wall looks smooth as a
 * curve, not faceted; doubled at the corner arcs because that's
 * where curvature is steepest. Outward-facing normals computed per
 * edge so MeshPhysicalMaterial's sheen + clearcoat read on the
 * silhouette correctly.
 */
function createSideWallGeometry(
  width: number,
  height: number,
  thickness: number,
  cornerRadius: number,
): THREE.BufferGeometry {
  const r = cornerRadius;
  const halfW = width / 2;
  const halfH = height / 2;
  const cx = halfW - r;
  const cy = halfH - r;
  const SAMPLES_STRAIGHT = 1; // straight edges don't need subdivision
  const SAMPLES_CORNER = 32; // smooth arc

  const perimeter: { x: number; y: number }[] = [];

  // Bottom edge: (-cx, -halfH) → (cx, -halfH)
  for (let i = 0; i <= SAMPLES_STRAIGHT; i++) {
    const t = i / SAMPLES_STRAIGHT;
    perimeter.push({ x: -cx + t * 2 * cx, y: -halfH });
  }
  // Bottom-right arc: angle -π/2 → 0 around (cx, -cy)
  for (let i = 1; i <= SAMPLES_CORNER; i++) {
    const a = -Math.PI / 2 + (i / SAMPLES_CORNER) * (Math.PI / 2);
    perimeter.push({ x: cx + r * Math.cos(a), y: -cy + r * Math.sin(a) });
  }
  // Right edge: (halfW, -cy) → (halfW, cy)
  for (let i = 1; i <= SAMPLES_STRAIGHT; i++) {
    const t = i / SAMPLES_STRAIGHT;
    perimeter.push({ x: halfW, y: -cy + t * 2 * cy });
  }
  // Top-right arc: angle 0 → π/2 around (cx, cy)
  for (let i = 1; i <= SAMPLES_CORNER; i++) {
    const a = (i / SAMPLES_CORNER) * (Math.PI / 2);
    perimeter.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  // Top edge: (cx, halfH) → (-cx, halfH)
  for (let i = 1; i <= SAMPLES_STRAIGHT; i++) {
    const t = i / SAMPLES_STRAIGHT;
    perimeter.push({ x: cx - t * 2 * cx, y: halfH });
  }
  // Top-left arc: angle π/2 → π around (-cx, cy)
  for (let i = 1; i <= SAMPLES_CORNER; i++) {
    const a = Math.PI / 2 + (i / SAMPLES_CORNER) * (Math.PI / 2);
    perimeter.push({ x: -cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  // Left edge: (-halfW, cy) → (-halfW, -cy)
  for (let i = 1; i <= SAMPLES_STRAIGHT; i++) {
    const t = i / SAMPLES_STRAIGHT;
    perimeter.push({ x: -halfW, y: cy - t * 2 * cy });
  }
  // Bottom-left arc: angle π → 3π/2 around (-cx, -cy). Stop one
  // sample short so we don't duplicate the perimeter[0] start point.
  for (let i = 1; i < SAMPLES_CORNER; i++) {
    const a = Math.PI + (i / SAMPLES_CORNER) * (Math.PI / 2);
    perimeter.push({ x: -cx + r * Math.cos(a), y: -cy + r * Math.sin(a) });
  }

  const N = perimeter.length;
  const halfT = thickness / 2;
  const positions = new Float32Array(N * 6 * 3); // 6 vertices per quad (2 triangles)
  const normals = new Float32Array(N * 6 * 3);
  let p = 0;
  let n = 0;

  for (let i = 0; i < N; i++) {
    const a = perimeter[i]!;
    const b = perimeter[(i + 1) % N]!;

    // Outward normal in the XY plane: rotate edge tangent (b-a) by -90°.
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len = Math.hypot(ex, ey) || 1;
    const nx = ey / len;
    const ny = -ex / len;

    // Triangle 1: front_a → back_a → front_b (CCW from outside).
    positions[p++] = a.x;
    positions[p++] = a.y;
    positions[p++] = halfT;
    positions[p++] = a.x;
    positions[p++] = a.y;
    positions[p++] = -halfT;
    positions[p++] = b.x;
    positions[p++] = b.y;
    positions[p++] = halfT;
    // Triangle 2: front_b → back_a → back_b.
    positions[p++] = b.x;
    positions[p++] = b.y;
    positions[p++] = halfT;
    positions[p++] = a.x;
    positions[p++] = a.y;
    positions[p++] = -halfT;
    positions[p++] = b.x;
    positions[p++] = b.y;
    positions[p++] = -halfT;

    for (let v = 0; v < 6; v++) {
      normals[n++] = nx;
      normals[n++] = ny;
      normals[n++] = 0;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
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
