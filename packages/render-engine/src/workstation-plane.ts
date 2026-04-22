/**
 * Workstation Plane — a liquid-glass substrate floating to the right
 * of the creature, held-tablet pose, where the agent-workstation
 * surface mounts its content (receipt log, browser pane, and any
 * future affordances).
 *
 * One body, one material: same borosilicate-IOR + clearcoat family
 * as the creature, sympathetic breathing locked to the same 0.3 Hz
 * time base. The plane is a real 3D mesh, not a panel or an overlay —
 * the distinction is load-bearing; every other agent UI collapses
 * into a conventional browser tab, and the motebit's spatial
 * embodiment is the differentiator.
 *
 * What this module IS:
 *   - A `THREE.Group` containing a plane mesh with liquid-glass
 *     material, mounted as a child of the creature's scene group so
 *     it inherits the creature's world transform (drift, sag, bob).
 *   - A single CSS3DObject stage that inherits the plane's full 3D
 *     transform, hosting one caller-owned HTML element at a time
 *     (the workstation panel). Content sits ON the plane and tilts
 *     with it — CSS2D wouldn't apply the plane's rotation to the DOM,
 *     so when the camera orbited the content would visibly detach
 *     from the glass. CSS3D binds the DOM to the plane's matrix so
 *     they move as one object.
 *   - Sympathetic breathing (~0.3 Hz, 30% creature amplitude), soul-
 *     color tint coupling on the plane's attenuation + emissive.
 *   - A user-visibility toggle for the launcher button / hotkey path.
 *
 * What this module is NOT:
 *   - No per-item management. The workstation controller owns that
 *     state; the plane only knows how to host one stage element.
 *   - No doctrine about "acts vs records" or embodiment modes. The
 *     module is a rendering primitive; naming it for its job
 *     (workstation plane) instead of a metaphor keeps the product
 *     story accountable to shipping code, not to imported framing.
 */

import * as THREE from "three";
import { CSS3DObject, CSS3DRenderer } from "three/addons/renderers/CSS3DRenderer.js";
import { CANONICAL_MATERIAL } from "./spec.js";
import type { InteriorColor } from "./spec.js";

// ── Geometry + positioning constants ────────────────────────────────

/**
 * Offset relative to the creature. Right-hand side, eye level, tilted
 * ~12° forward and ~5° yawed toward the creature — "the motebit is
 * holding up a glass slate and showing you what's on it."
 *
 * The X offset + plane width are tuned so the right edge stays
 * on-screen on a 16:9 canvas at the default camera. Narrower
 * viewports collapse the CSS2D stage naturally via the scene
 * projection — no manual breakpoints needed.
 */
const PLANE_OFFSET_X = 0.38;
const PLANE_OFFSET_Y = 0.0;
const PLANE_OFFSET_Z = -0.02;
const PLANE_TILT_X = -0.22;
const PLANE_TILT_Y = -0.09;

/** Plane dimensions in world units (meters). ~16:10 aspect. */
const PLANE_WIDTH = 0.54;
const PLANE_HEIGHT = 0.34;

/**
 * Pixel dimensions of the DOM stage. Scaled by `PLANE_WIDTH /
 * STAGE_PIXEL_WIDTH` to fit the plane. Higher pixel budget = crisper
 * text at distance; the scale factor keeps the on-plane size constant
 * regardless of pixel count. 1000×625 preserves 16:10 aspect and
 * gives readable 12–14px text at the default camera distance.
 */
const STAGE_PIXEL_WIDTH = 1000;
const STAGE_PIXEL_HEIGHT = 625;

/** Breathing amplitude factor vs creature's amplitude. */
const BREATHE_AMPLITUDE_FACTOR = 0.3;

// ── Class ───────────────────────────────────────────────────────────

export class WorkstationPlane {
  private readonly group: THREE.Group;
  private readonly planeMesh: THREE.Mesh;
  private readonly planeMaterial: THREE.MeshPhysicalMaterial;
  private readonly stageAnchor: CSS3DObject;
  private readonly stageEl: HTMLDivElement;
  private readonly css3dRenderer: CSS3DRenderer;

  /** Current visibility target: 0 = hidden, 1 = fully visible. */
  private visibilityTarget = 0.85;
  /** Smoothly eased visibility (plane opacity). */
  private planeVisibility = 0;
  /** User-driven visibility override from the launcher/hotkey. */
  private userVisible = false;

  private soulTint: [number, number, number] = [0.95, 0.97, 1.0];
  private soulGlow: [number, number, number] = [0.55, 0.78, 1.0];
  private activeWarmth = 0;

  constructor(creatureGroup: THREE.Group, container: HTMLElement) {
    this.group = new THREE.Group();
    this.group.name = "workstation-plane";
    this.group.position.set(PLANE_OFFSET_X, PLANE_OFFSET_Y, PLANE_OFFSET_Z);
    this.group.rotation.set(PLANE_TILT_X, PLANE_TILT_Y, 0);
    creatureGroup.add(this.group);

    // Segmented plane — enough vertices for a future ripple/pinch
    // pass without rebuilding geometry, but not so many that per-
    // frame work suffers on low-end devices.
    const planeGeo = new THREE.PlaneGeometry(PLANE_WIDTH, PLANE_HEIGHT, 16, 16);

    this.planeMaterial = new THREE.MeshPhysicalMaterial({
      // Borosilicate glass IOR — same chemistry as the creature.
      // The content sits inside the glass the way the creature's
      // eyes sit inside its droplet body: transparent enough to see
      // through cleanly, thick enough to refract and tint, clearcoat
      // at the edges for the meniscus specular.
      ior: CANONICAL_MATERIAL.ior,
      // Low roughness so the surface reads as smooth glass, not
      // frosted — frosting hides the content inside. Most of the
      // visible "glass-ness" comes from transmission + clearcoat +
      // attenuation tint, not surface roughness.
      roughness: 0.04,
      transmission: 0.88,
      thickness: 0.05,
      clearcoat: 0.85,
      clearcoatRoughness: 0.04,
      color: new THREE.Color(0.98, 0.985, 1.0),
      // Attenuation color lerps toward the soul color on warmth — the
      // plane takes the creature's interior tint when active, falls
      // back to neutral-cool when idle.
      attenuationColor: new THREE.Color(0.92, 0.95, 1.0),
      attenuationDistance: 0.6,
      // Sheen paints a soft halo on the edges — reads as a meniscus
      // against a bright sky environment without looking like fabric.
      sheen: 0.35,
      sheenRoughness: 0.9,
      sheenColor: new THREE.Color(0.75, 0.85, 1.0),
      emissive: new THREE.Color(0, 0, 0),
      emissiveIntensity: 0,
      transparent: true,
      opacity: 0, // Starts invisible; revealed by user toggle.
      side: THREE.DoubleSide,
    });

    this.planeMesh = new THREE.Mesh(planeGeo, this.planeMaterial);
    this.planeMesh.visible = false;
    this.group.add(this.planeMesh);

    // CSS3D stage — the DOM child inherits the plane's full 3D
    // transform (position + rotation + scale). So the content sits
    // ON the plane surface and tilts with it; no more "plane rotates
    // but flat HTML stays upright" divergence that CSS2D caused.
    //
    // Pixel-to-world mapping: DOM sized in pixels (1000×625, fitting
    // the plane's 16:10 aspect), scaled by PIXEL_SCALE so the DOM
    // covers the 0.54m × 0.34m plane at that pixel budget. Scale
    // factor = PLANE_WIDTH / pixelWidth; a smaller factor yields
    // higher logical resolution (crisper text at distance) at the
    // cost of needing larger pixel dimensions in the DOM.
    this.stageEl = createStageElement();
    this.stageAnchor = new CSS3DObject(this.stageEl);
    // Content sits on the plane's front surface at a tiny forward
    // offset — enough to avoid z-fighting with the glass mesh,
    // close enough that they read as one surface. The glass's
    // clearcoat specular and edge sheen render via WebGL in front;
    // the content renders via CSS3D at the same world position,
    // tilting with the plane because CSS3D inherits the parent
    // group's 3D transform. The net read: content inside the glass
    // body, tilting as the body tilts.
    this.stageAnchor.position.set(0, 0, 0.002);
    const pixelScale = PLANE_WIDTH / STAGE_PIXEL_WIDTH;
    this.stageAnchor.scale.set(pixelScale, pixelScale, pixelScale);
    // Hidden until the launcher reveals us. CSS3DRenderer reads this
    // each frame and sets the element's style.display accordingly.
    this.stageAnchor.visible = false;
    this.group.add(this.stageAnchor);

    // A dedicated CSS3DRenderer keeps z-ordering + pointer-events
    // independent from the ArtifactManager's own (CSS2D) renderer.
    this.css3dRenderer = new CSS3DRenderer();
    this.css3dRenderer.setSize(container.clientWidth, container.clientHeight);
    this.css3dRenderer.domElement.style.position = "absolute";
    this.css3dRenderer.domElement.style.top = "0";
    this.css3dRenderer.domElement.style.left = "0";
    this.css3dRenderer.domElement.style.zIndex = "2";
    // CSS3D renderer's root layer doesn't take pointer events;
    // children (the stage element) opt in via their own CSS.
    this.css3dRenderer.domElement.style.pointerEvents = "none";
    container.appendChild(this.css3dRenderer.domElement);
  }

  /** Expose the THREE group for callers that want to position externally. */
  getGroup(): THREE.Group {
    return this.group;
  }

  /**
   * Mount a caller-owned element as the plane's stage content. The
   * workstation panel DOM mounts here; subsequent swaps replace the
   * previous child. Passing `null` clears the stage.
   */
  setStageChild(el: HTMLElement | null): void {
    if (typeof this.stageEl.replaceChildren === "function") {
      this.stageEl.replaceChildren(...(el ? [el] : []));
    } else {
      while (this.stageEl.firstChild) {
        this.stageEl.removeChild(this.stageEl.firstChild);
      }
      if (el) this.stageEl.appendChild(el);
    }
  }

  /**
   * Couple the plane's tint to the creature's interior color. Host
   * adapters call this from their own `setInteriorColor` at the same
   * moment they update the creature so the plane breathes the same
   * palette as its parent body.
   */
  setInteriorColor(color: InteriorColor): void {
    this.soulTint = [color.tint[0], color.tint[1], color.tint[2]];
    this.soulGlow = [color.glow[0], color.glow[1], color.glow[2]];
  }

  /**
   * User-driven visibility from the launcher button / Option+W hotkey.
   * When `true`, the plane is visible at its idle baseline with a
   * smooth fade-in; when `false`, it fades out and its DOM stops
   * capturing pointer events.
   */
  setUserVisible(visible: boolean): void {
    this.userVisible = visible;
    // CSS3DRenderer writes `element.style.display` on every frame
    // based on the CSS3DObject's `.visible` property — so toggling
    // DOM style.display here would get clobbered instantly. Flip the
    // Three.js-side visibility instead; the renderer propagates
    // display:none down to the DOM on the next tick.
    this.stageAnchor.visible = visible;
    if (this.stageEl.style) {
      // Pointer events are ours to manage — CSS3DRenderer doesn't
      // touch them. Releasing on hide prevents the hidden panel's
      // DOM from swallowing clicks meant for the creature.
      this.stageEl.style.pointerEvents = visible ? "auto" : "none";
    }
    if (visible && this.planeVisibility < 0.5) {
      // Pre-warm the plane so the fade-in begins from near-visible
      // rather than the full recessed baseline — snappier feel.
      this.planeVisibility = 0.85;
    }
  }

  /**
   * Per-frame update — driven by the same render loop that ticks the
   * creature. `t` is total animation time in seconds; `deltaTime` is
   * frame delta in seconds.
   */
  update(t: number, deltaTime: number): void {
    if (!this.userVisible) {
      this.planeVisibility = smoothToward(this.planeVisibility, 0, deltaTime, 5);
      this.planeMaterial.opacity = this.planeVisibility;
      this.planeMesh.visible = this.planeVisibility > 0.01;
      this.activeWarmth = smoothToward(this.activeWarmth, 0, deltaTime, 2.5);
      return;
    }

    // User-visible. Warmth target is 1 — the plane always shows soul
    // tint when open. Future work can modulate warmth on activity
    // (spike on a tool call, ease back during idle) once the
    // workstation controller exposes a "busy" signal.
    const warmthTarget = 1;
    this.planeVisibility = smoothToward(this.planeVisibility, this.visibilityTarget, deltaTime, 4);
    this.activeWarmth = smoothToward(this.activeWarmth, warmthTarget, deltaTime, 2.5);

    // Sympathetic breathing — ~0.3 Hz, locked to the creature's time
    // base so phases stay synchronized without inter-object signaling.
    const breatheRaw = Math.sin(t * 0.3 * Math.PI * 2);
    const breathe =
      (breatheRaw > 0 ? breatheRaw : Math.sign(breatheRaw) * Math.pow(Math.abs(breatheRaw), 0.6)) *
      BREATHE_AMPLITUDE_FACTOR *
      0.012;

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

  /** Called after the WebGL render each frame — syncs the CSS overlay. */
  render(scene: THREE.Scene, camera: THREE.Camera): void {
    this.css3dRenderer.render(scene, camera);
  }

  resize(width: number, height: number): void {
    this.css3dRenderer.setSize(width, height);
  }

  dispose(): void {
    this.css3dRenderer.domElement.remove();
    this.planeMesh.geometry.dispose();
    this.planeMaterial.dispose();
  }
}

// ── Internal ────────────────────────────────────────────────────────

function createStageElement(): HTMLDivElement {
  // SSR / headless guard — tests and server-render paths import this
  // module transitively; constructing a CSS3DObject without a valid
  // DOM element is an error.
  if (typeof document === "undefined") {
    return { style: {} } as unknown as HTMLDivElement;
  }
  const el = document.createElement("div");
  el.className = "workstation-plane-stage";
  // Size matches the pixel budget the scale factor maps to PLANE_WIDTH.
  // The element fills the plane edge-to-edge in 3D space; clipping
  // content to rounded corners gives the glass a menisicus-edge feel
  // without needing separate geometry.
  //
  // Display is NOT set here — CSS3DRenderer writes it every frame from
  // the parent CSS3DObject's `.visible` property. Setting it inline
  // would be clobbered immediately.
  el.style.width = `${STAGE_PIXEL_WIDTH}px`;
  el.style.height = `${STAGE_PIXEL_HEIGHT}px`;
  el.style.boxSizing = "border-box";
  el.style.overflow = "hidden";
  el.style.borderRadius = "18px";
  el.style.pointerEvents = "none";
  return el;
}

function smoothToward(current: number, target: number, deltaTime: number, rate: number): number {
  const t = 1 - Math.exp(-rate * deltaTime);
  return current + (target - current) * t;
}
