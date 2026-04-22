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
 *   - A single CSS2DObject stage anchored to the plane center, hosting
 *     one caller-owned HTML element at a time (the workstation panel).
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
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
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

/** Breathing amplitude factor vs creature's amplitude. */
const BREATHE_AMPLITUDE_FACTOR = 0.3;

// ── Class ───────────────────────────────────────────────────────────

export class WorkstationPlane {
  private readonly group: THREE.Group;
  private readonly planeMesh: THREE.Mesh;
  private readonly planeMaterial: THREE.MeshPhysicalMaterial;
  private readonly stageAnchor: CSS2DObject;
  private readonly stageEl: HTMLDivElement;
  private readonly css2dRenderer: CSS2DRenderer;

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
      // Borosilicate glass IOR — same chemistry as the creature. The
      // plane and the creature read as one body, differentiated by
      // geometry (droplet vs sheet), not material.
      ior: CANONICAL_MATERIAL.ior,
      // Pulled back from "near-clear" so the plane reads as a frosted
      // display that the environment lenses through, not a ghost.
      // Roughness breaks perfect mirror into a soft frosted glow;
      // clearcoat restores the specular meniscus edge.
      roughness: 0.12,
      transmission: 0.55,
      thickness: 0.04,
      clearcoat: 0.6,
      clearcoatRoughness: 0.05,
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

    // CSS2D stage — one anchor at plane center, one stage element the
    // caller swaps content into via `setStageChild`. The workstation
    // panel mounts its DOM (header, browser pane, receipt list) as
    // the stage child and then drives it directly.
    this.stageEl = createStageElement();
    this.stageAnchor = new CSS2DObject(this.stageEl);
    this.stageAnchor.position.set(0, 0, 0.001);
    this.group.add(this.stageAnchor);

    // A dedicated CSS2DRenderer keeps z-ordering + pointer-events
    // independent from the ArtifactManager's own renderer.
    this.css2dRenderer = new CSS2DRenderer();
    this.css2dRenderer.setSize(container.clientWidth, container.clientHeight);
    this.css2dRenderer.domElement.style.position = "absolute";
    this.css2dRenderer.domElement.style.top = "0";
    this.css2dRenderer.domElement.style.left = "0";
    this.css2dRenderer.domElement.style.zIndex = "2";
    this.css2dRenderer.domElement.style.pointerEvents = "none";
    container.appendChild(this.css2dRenderer.domElement);
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
    if (this.stageEl.style) {
      this.stageEl.style.display = visible ? "block" : "none";
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
    this.css2dRenderer.render(scene, camera);
  }

  resize(width: number, height: number): void {
    this.css2dRenderer.setSize(width, height);
  }

  dispose(): void {
    this.css2dRenderer.domElement.remove();
    this.planeMesh.geometry.dispose();
    this.planeMaterial.dispose();
  }
}

// ── Internal ────────────────────────────────────────────────────────

function createStageElement(): HTMLDivElement {
  // SSR / headless guard — tests and server-render paths import this
  // module transitively; constructing a CSS2DObject without a valid
  // DOM element is an error.
  if (typeof document === "undefined") {
    return { style: {} } as unknown as HTMLDivElement;
  }
  const el = document.createElement("div");
  el.className = "workstation-plane-stage";
  // Size the stage to fit within the plane's visible projection at
  // the default camera. Slightly smaller than the full plane so the
  // meniscus edge stays visible on all sides.
  el.style.width = "580px";
  el.style.height = "360px";
  el.style.boxSizing = "border-box";
  el.style.display = "none";
  el.style.overflow = "hidden";
  el.style.pointerEvents = "none";
  return el;
}

function smoothToward(current: number, target: number, deltaTime: number, rate: number): number {
  const t = 1 - Math.exp(-rate * deltaTime);
  return current + (target - current) * t;
}
