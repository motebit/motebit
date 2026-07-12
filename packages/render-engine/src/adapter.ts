import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TrustMode, type RenderSpec } from "@motebit/sdk";
import { CANONICAL_SPEC, CANONICAL_CAMERA } from "./spec.js";
import type {
  RenderAdapter,
  RenderFrame,
  InteriorColor,
  AudioReactivity,
  ArtifactSpec,
  ArtifactHandle,
  SlabBodyRegister,
  SlabItemSpec,
  SlabItemHandle,
  CanonicalCameraPose,
} from "./spec.js";
import { ArtifactManager } from "./artifacts.js";
import { SlabManager } from "./slab.js";
import { SpatialSlabManager } from "./slab-spatial.js";
import {
  createCreature,
  createCreatureState,
  createBlinkState,
  animateCreature,
  disposeCreature,
  createEnvironmentMap,
  createBackdropDome,
  ENV_LIGHT,
  ENV_DARK,
  ENV_DEFAULT,
  type EnvironmentPreset,
  type CreatureRefs,
  type CreatureState,
} from "./creature.js";

// Re-export creature module for backward compatibility
export {
  organicNoise,
  createBlinkState,
  computeBlinkFactor,
  createCreature,
  createCreatureState,
  animateCreature,
  disposeCreature,
  createEnvironmentMap,
  ENV_LIGHT,
  ENV_DARK,
  ENV_DEFAULT,
} from "./creature.js";
export type { BlinkState, EnvironmentPreset, CreatureRefs, CreatureState } from "./creature.js";

// === Null Adapter (headless / testing) ===

export class NullRenderAdapter implements RenderAdapter {
  private spec: RenderSpec = CANONICAL_SPEC;
  init(_target: unknown): Promise<void> {
    return Promise.resolve();
  }
  render(_frame: RenderFrame): void {}
  getSpec(): RenderSpec {
    return this.spec;
  }
  resize(_width: number, _height: number): void {}
  setBackground(_color: number | null): void {}
  setDarkEnvironment(): void {}
  setLightEnvironment(): void {}
  setInteriorColor(_color: InteriorColor): void {}
  setAudioReactivity(_energy: AudioReactivity | null): void {}
  setTrustMode(_mode: TrustMode): void {}
  setListeningIndicator(_active: boolean): void {}
  getCreatureGroup(): THREE.Group | null {
    return null;
  }
  dispose(): void {}
}

// === Desktop / Web Adapter ===
// The liquescent creature on screen. Spectral environment provides
// the chromatic gradient the body needs to refract.

export class ThreeJSAdapter implements RenderAdapter {
  private spec: RenderSpec = CANONICAL_SPEC;
  private initialized = false;
  private creatureRefs: CreatureRefs | null = null;
  private creatureState: CreatureState = createCreatureState();

  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;

  private controls: OrbitControls | null = null;
  private artifactManager: ArtifactManager | null = null;
  private slab: SlabManager | null = null;
  private backdropDome: THREE.Mesh | null = null;

  init(target: unknown): Promise<void> {
    if (typeof HTMLCanvasElement === "undefined" || !(target instanceof HTMLCanvasElement)) {
      this.initialized = true;
      return Promise.resolve();
    }

    const canvas = target;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    // NeutralToneMapping: three.js r167+ tone mapper designed for
    // content-bearing scenes (UI, web pages, anything sRGB-source).
    // The prior ACESFilmicToneMapping was film-grade HDR
    // compression — accurate for HDR scenes (sun, sky, fire) but
    // it slightly desaturates whites and shifts the color register
    // for sRGB content. The slab now refracts a live web page
    // through the front pane via transmission; the refracted color
    // goes through whatever tone mapper the renderer has set, so
    // ACES was tone-mapping Google's logo into a muted register.
    // Neutral preserves source colors faithfully with mild
    // highlight compression — creature still reads as glass with
    // its emissive bloom, page reads at face value. Exposure 1.0
    // is the canonical neutral baseline; 1.2 was over-brightening
    // before ACES compressed, which compounded the desaturation.
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);

    this.scene = new THREE.Scene();
    this.applyEnvironment(ENV_DEFAULT);

    // Camera numbers live in one place — the creature canon
    // (docs/doctrine/creature-canon.md; check-creature-canon).
    const pose = CANONICAL_CAMERA.front;
    this.camera = new THREE.PerspectiveCamera(
      pose.fov,
      canvas.clientWidth / canvas.clientHeight,
      0.1,
      10,
    );
    this.camera.position.set(...pose.position);
    this.camera.lookAt(...pose.lookAt);

    // === Creature ===
    this.creatureRefs = createCreature(this.scene);

    // === Spatial Canvas — artifact positioning in creature's world ===
    const container = canvas.parentElement ?? document.body;
    if (this.creatureRefs != null) {
      this.artifactManager = new ArtifactManager(this.creatureRefs.group, container);
      // Slab — the "Motebit Computer" (docs/doctrine/motebit-computer.md).
      // Hangs off the creature group; detachHandler routes pinched items
      // into the existing artifact scene so detach → resting artifact
      // is a single scene-graph hand-off, not two parallel systems.
      this.slab = new SlabManager(this.creatureRefs.group, container, {
        detachHandler: (spec) => this.addArtifact(spec),
      });
    }

    // === Lighting ===
    this.scene.add(new THREE.AmbientLight(0x8090b0, 0.6));

    const key = new THREE.DirectionalLight(0xffeedd, 2.0);
    key.position.set(2, 3, 2);
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0xaabbee, 0.6);
    fill.position.set(-2, 1.5, -1);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight(0xddeeff, 0.5);
    rim.position.set(0, 0.5, -2.5);
    this.scene.add(rim);

    this.initialized = true;
    return Promise.resolve();
  }

  render(frame: RenderFrame): void {
    if (!this.initialized || !this.creatureRefs || !this.renderer || !this.scene || !this.camera)
      return;

    animateCreature(this.creatureRefs, this.creatureState, frame);

    if (this.controls) this.controls.update();
    this.renderer.render(this.scene, this.camera);

    // Spatial canvas: update artifact animations and sync CSS overlay
    if (this.artifactManager) {
      this.artifactManager.update(frame.delta_time);
      this.artifactManager.render(this.scene, this.camera);
    }
    if (this.slab) {
      this.slab.update(frame.time, frame.delta_time);
      this.slab.render(this.scene, this.camera);
    }
  }

  getSpec(): RenderSpec {
    return this.spec;
  }

  resize(width: number, height: number): void {
    if (this.camera) {
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    }
    if (this.renderer) {
      this.renderer.setSize(width, height, false);
    }
    this.artifactManager?.resize(width, height);
    this.slab?.resize(width, height);
  }

  // === Spatial Canvas ===

  addArtifact(spec: ArtifactSpec): ArtifactHandle | undefined {
    return this.artifactManager?.add(spec);
  }

  removeArtifact(id: string): Promise<void> {
    if (!this.artifactManager) return Promise.resolve();
    return this.artifactManager.remove(id);
  }

  clearArtifacts(): void {
    this.artifactManager?.clear();
  }

  // === Slab ("Motebit Computer") — docs/doctrine/motebit-computer.md ===
  //
  // Delegates to the SlabManager constructed in init() and mounted on
  // the creature group. The bridge uses optional chaining, so a null
  // manager (headless / test init) degrades to safe no-ops.

  addSlabItem(spec: SlabItemSpec): SlabItemHandle | undefined {
    return this.slab?.addItem(spec);
  }

  /**
   * Mount the identity face on the slab's back — the surface-rendered mark
   * (sigil + id), crossfaded in as the camera orbits behind. Pass null to
   * clear. Only the flat SlabManager has a back; spatial / headless no-op.
   */
  setSlabBackPlate(element: HTMLElement | null): void {
    const slab = this.slab;
    if (slab instanceof SlabManager) slab.setBackPlate(element);
  }

  dissolveSlabItem(id: string): Promise<void> {
    return this.slab?.dissolveItem(id) ?? Promise.resolve();
  }

  detachSlabItemAsArtifact(
    id: string,
    artifact: ArtifactSpec,
  ): Promise<ArtifactHandle | undefined> {
    return this.slab?.detachItemAsArtifact(id, artifact) ?? Promise.resolve(undefined);
  }

  clearSlabItems(): void {
    this.slab?.clearItems();
  }

  setSlabVisible(visible: boolean): void {
    this.slab?.setUserVisible(visible);
  }

  toggleSlabVisible(): boolean {
    return this.slab?.toggleUserVisible() ?? false;
  }

  isSlabVisible(): boolean {
    return this.slab?.isUserVisible() ?? false;
  }

  /**
   * Forward the drag-hover signal from app drop handlers to the slab
   * core. Slab honesty work: the membrane lifts to a drop-target
   * register during an active drag.
   */
  setSlabDragHover(hovering: boolean): void {
    this.slab?.setDragHover(hovering);
  }

  /**
   * Wire the slab's two-finger-hold gesture to a halt handler — the
   * user-floor primitive (`ComputerSessionManager.halt()`). Doctrine:
   * motebit-computer.md §"The user's touch — supervised agency".
   */
  setSlabHaltGestureHandler(handler: (() => void) | null): void {
    this.slab?.setHaltGestureHandler(handler);
  }

  /**
   * Mirror the session manager's halted state onto the slab visual.
   */
  setSlabHalted(halted: boolean): void {
    this.slab?.setHalted(halted);
  }

  /**
   * Forward a decoded screencast frame onto the slab's screen mesh.
   * Non-item slab content, owned by the slab core. Pair with
   * `clearSlabScreencast` at session close.
   */
  setSlabScreencastImage(source: HTMLImageElement | ImageBitmap): void {
    this.slab?.setScreencastImage(source);
  }

  /**
   * Tear down the slab's screencast texture. Sibling of
   * `setSlabScreencastImage`; idempotent.
   */
  clearSlabScreencast(): void {
    this.slab?.clearScreencast();
  }

  /**
   * Set the slab's body register — the tri-state truth for what
   * occupies the body region (home affordances, live screencast, or
   * home overlaying a dim screencast during URL-bar focus). The
   * renderer derives screen-mesh visibility from this value. Doctrine:
   * `motebit-computer.md` §"Body register — the tri-state."
   */
  setSlabBodyRegister(register: SlabBodyRegister): void {
    this.slab?.setBodyRegister(register);
  }

  setBackground(color: number | null): void {
    if (this.scene) {
      this.scene.background = color === null ? null : new THREE.Color(color);
    }
  }

  setDarkEnvironment(): void {
    this.applyEnvironment(ENV_DARK);
  }

  setLightEnvironment(): void {
    this.applyEnvironment(ENV_LIGHT);
  }

  /**
   * One world, two projections of it: the ILLUMINATION map (with the
   * sun/fill/ground light panels) drives reflection and refraction on the
   * body; the visible sky is the backdrop DOME — the same gradient shader
   * as world geometry, no panels. Rendering the PMREM as scene.background
   * had two artifact classes (creature-canon.md artifact-zero): light
   * fixtures floating in the sky, and stair-stepped patches painted by
   * renders issued too close to PMREM generation.
   *
   * Environments are cached per preset: PMREM generation runs once per
   * preset per adapter lifetime. Repeated theme switches were previously
   * re-generating (and leaking) the maps every time — and any render
   * landing near a fresh PMREM generation can paint a corrupted
   * frame-edge patch (see the NOTE in createEnvironmentMap), so swaps
   * after the first are pure texture/mesh assignment.
   */
  private envCache = new Map<EnvironmentPreset, { envMap: THREE.Texture; dome: THREE.Mesh }>();

  private applyEnvironment(preset: EnvironmentPreset): void {
    if (!this.scene || !this.renderer) return;
    let entry = this.envCache.get(preset);
    if (!entry) {
      entry = {
        envMap: createEnvironmentMap(this.renderer, preset),
        dome: createBackdropDome(preset),
      };
      this.envCache.set(preset, entry);
    }
    this.scene.environment = entry.envMap;
    if (this.backdropDome && this.backdropDome !== entry.dome) {
      this.scene.remove(this.backdropDome);
    }
    this.backdropDome = entry.dome;
    this.scene.add(entry.dome);
    this.scene.background = null;
  }

  setInteriorColor(color: InteriorColor): void {
    this.creatureState.interiorColor = color;
    if (this.creatureRefs) {
      this.creatureRefs.bodyMaterial.attenuationColor.setRGB(
        color.tint[0],
        color.tint[1],
        color.tint[2],
      );
      this.creatureRefs.bodyMaterial.emissive.setRGB(color.glow[0], color.glow[1], color.glow[2]);
      this.creatureRefs.bodyMaterial.emissiveIntensity = color.glowIntensity ?? 0.0;
      this.creatureRefs.bodyMaterial.needsUpdate = true;
    }
    // Mirror the soul color onto the slab — one body, one soul.
    this.slab?.setInteriorColor(color);
  }

  setAudioReactivity(energy: AudioReactivity | null): void {
    this.creatureState.audio = energy;
  }

  setTrustMode(mode: TrustMode): void {
    this.creatureState.trustMode = mode;
  }

  setListeningIndicator(active: boolean): void {
    this.creatureState.listeningActive = active;
  }

  enableOrbitControls(): void {
    if (!this.camera || !this.renderer) return;
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    const target = CANONICAL_CAMERA.front.lookAt;
    this.controls.target.set(...target);
    this.controls.minDistance = 0.3;
    this.controls.maxDistance = 3.0;
    this.controls.update();
  }

  /**
   * Move the camera to a canonical pose (docs/doctrine/creature-canon.md).
   * Used by the golden-frame harness and by any surface that needs a
   * named framing (docs hero, capture tooling) without re-encoding
   * camera literals.
   */
  setCameraPose(pose: CanonicalCameraPose): void {
    if (!this.camera) return;
    this.camera.fov = pose.fov;
    this.camera.position.set(...pose.position);
    this.camera.lookAt(...pose.lookAt);
    this.camera.updateProjectionMatrix();
    if (this.controls) {
      this.controls.target.set(...pose.lookAt);
      this.controls.update();
    }
  }

  /**
   * Enable or disable autonomous blinking. Blink scheduling is the one
   * source of nondeterminism in the render path (random intervals);
   * the golden-frame harness disables it before the first render so a
   * pinned time renders a pinned frame. Re-enabling reseeds the
   * schedule.
   */
  setBlinkEnabled(enabled: boolean): void {
    if (enabled) {
      this.creatureState.blinkState = createBlinkState();
    } else {
      this.creatureState.blinkState.blinkStart = -1;
      this.creatureState.blinkState.nextBlinkAt = Infinity;
      this.creatureState.blinkState.doubleBlink = false;
      this.creatureState.blinkState.secondBlinkPending = false;
    }
  }

  /**
   * Desktop/web analogue of WebXRThreeJSAdapter.getCreatureGroup(). Same
   * contract: children mounted here inherit the creature's world position.
   * Ring 3 (3D creature) is available on desktop/web/spatial, so this
   * accessor exists in all three surfaces — spatial scene-object modules
   * (credential satellites, etc.) can be lifted onto desktop/web when
   * their surface needs them.
   */
  getCreatureGroup(): THREE.Group | null {
    return this.creatureRefs?.group ?? null;
  }

  dispose(): void {
    if (this.creatureRefs) {
      disposeCreature(this.creatureRefs);
      this.creatureRefs = null;
    }

    this.artifactManager?.dispose();
    this.artifactManager = null;
    this.slab?.dispose();
    this.slab = null;

    if (this.scene?.environment) this.scene.environment.dispose();
    if (this.scene) {
      this.scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          const mesh = obj as THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>;
          mesh.geometry.dispose();
          if (mesh.material instanceof THREE.Material) mesh.material.dispose();
        }
      });
    }
    if (this.controls) {
      this.controls.dispose();
      this.controls = null;
    }
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer = null;
    }
    this.scene = null;
    this.camera = null;
    this.initialized = false;
  }
}

// === Spatial Adapter Stub ===

export class SpatialAdapter implements RenderAdapter {
  private spec: RenderSpec = CANONICAL_SPEC;
  init(_target: unknown): Promise<void> {
    return Promise.resolve();
  }
  render(_frame: RenderFrame): void {}
  getSpec(): RenderSpec {
    return this.spec;
  }
  resize(_width: number, _height: number): void {}
  setBackground(_color: number | null): void {}
  setDarkEnvironment(): void {}
  setLightEnvironment(): void {}
  setInteriorColor(_color: InteriorColor): void {}
  setAudioReactivity(_energy: AudioReactivity | null): void {}
  setTrustMode(_mode: TrustMode): void {}
  setListeningIndicator(_active: boolean): void {}
  getCreatureGroup(): THREE.Group | null {
    return null;
  }
  dispose(): void {}
}

// === WebXR Three.js Adapter ===
// The liquescent creature in physical space. AR passthrough — no simulated sky.
//
// Doctrinal endgame: the real world IS Liquescentia. The camera feed
// provides the chromatic spectrum the liquescent body refracts; reality
// becomes the medium. See docs/doctrine/liquescentia-as-substrate.md
// §"The AR glasses coherence — the medium becomes literal."
//
// Current state, named honestly: the adapter does not yet consume
// XR light estimation (`XRSession.requestLightProbe()` /
// `WebXRManager.getEstimatedLight()`). It uses ENV_LIGHT
// unconditionally — synthetic chromatic gradient as both today's
// behavior and the eventual fallback. Promoting to real-world
// spectrum is endgame work blocked on a real-device test surface
// (Meta Orion / Apple Vision Pro AR mode / a Quest passthrough rig);
// implementing without test hardware would ship doctrine prose, not
// real behavior.

export class WebXRThreeJSAdapter implements RenderAdapter {
  private spec: RenderSpec = CANONICAL_SPEC;
  private initialized = false;
  private creatureRefs: CreatureRefs | null = null;
  private creatureState: CreatureState = createCreatureState();

  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;

  private envMap: THREE.Texture | null = null;

  /**
   * Held-tablet slab — Phase 1A primitive. Constructed in `init()`
   * when a real canvas is available; left null in headless mode so
   * the slab passthrough methods degrade to safe no-ops via optional
   * chaining (mirrors `ThreeJSAdapter.slab`). Phase 1B adds the
   * tablet mesh; this slot is the wiring anchor for that work.
   */
  private slab: SpatialSlabManager | null = null;

  /** Check if WebXR immersive-ar is available in this browser. */
  static async isSupported(): Promise<boolean> {
    if (typeof navigator === "undefined" || !navigator.xr) return false;
    try {
      return await navigator.xr.isSessionSupported("immersive-ar");
    } catch {
      return false;
    }
  }

  init(target: unknown): Promise<void> {
    if (typeof HTMLCanvasElement === "undefined" || !(target instanceof HTMLCanvasElement)) {
      this.initialized = true;
      return Promise.resolve();
    }

    const canvas = target;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.xr.enabled = true;
    // NeutralToneMapping: three.js r167+ tone mapper designed for
    // content-bearing scenes (UI, web pages, anything sRGB-source).
    // The prior ACESFilmicToneMapping was film-grade HDR
    // compression — accurate for HDR scenes (sun, sky, fire) but
    // it slightly desaturates whites and shifts the color register
    // for sRGB content. The slab now refracts a live web page
    // through the front pane via transmission; the refracted color
    // goes through whatever tone mapper the renderer has set, so
    // ACES was tone-mapping Google's logo into a muted register.
    // Neutral preserves source colors faithfully with mild
    // highlight compression — creature still reads as glass with
    // its emissive bloom, page reads at face value. Exposure 1.0
    // is the canonical neutral baseline; 1.2 was over-brightening
    // before ACES compressed, which compounded the desaturation.
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);

    this.scene = new THREE.Scene();
    // No background — AR passthrough. The real world IS Liquescentia
    // (doctrinal endgame; see file header). The synthetic envMap below
    // is what ships today; XR light estimation is the future direction.

    // Synthetic environment map for glass refraction. ENV_LIGHT today;
    // promote to `xr.getEstimatedLight()` when a real-device test
    // surface is available (see file header for the rationale).
    this.envMap = createEnvironmentMap(this.renderer, ENV_LIGHT);
    this.scene.environment = this.envMap;

    // Camera managed by WebXR — position/orientation come from head tracking
    this.camera = new THREE.PerspectiveCamera(
      50,
      canvas.clientWidth / canvas.clientHeight,
      0.1,
      100,
    );

    // === Creature ===
    this.creatureRefs = createCreature(this.scene);

    // Initial position: 0.5m in front of the user at shoulder height
    this.creatureState.basePosition = { x: 0, y: -0.2, z: -0.5 };

    // === Held-tablet slab — Phase 1A primitive ===
    // Anchored on the creature group; same Ring 1 state machine as
    // the desktop slab (both consume `SlabCore`). Phase 1A ships the
    // typed primitive + state machine + position; Phase 1B adds the
    // visible tablet mesh + emerge/dissolve animations. See
    // `docs/doctrine/spatial-as-endgame.md` and the
    // `spatial_slab_port_held_tablet` memory for the split rationale.
    if (this.creatureRefs != null) {
      this.slab = new SpatialSlabManager(this.creatureRefs.group);
    }

    // === Lighting ===
    // Softer than desktop — the real environment provides ambient context.
    this.scene.add(new THREE.AmbientLight(0x8090b0, 0.4));

    const key = new THREE.DirectionalLight(0xffeedd, 1.5);
    key.position.set(2, 3, 2);
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0xaabbee, 0.4);
    fill.position.set(-2, 1.5, -1);
    this.scene.add(fill);

    this.initialized = true;
    return Promise.resolve();
  }

  render(frame: RenderFrame): void {
    if (!this.initialized || !this.creatureRefs || !this.renderer || !this.scene || !this.camera)
      return;

    animateCreature(this.creatureRefs, this.creatureState, frame);

    this.renderer.render(this.scene, this.camera);

    // Drive the held-tablet slab forward. Phase 1A ticks the state
    // machine; Phase 1B adds the visual landing inside the manager.
    // No CSS2D overlay in spatial — the slab's `render()` is a no-op
    // hook today, kept symmetric with `ThreeJSAdapter` so Phase 1B
    // wiring (e.g., a CSS3D / WebXR-panel pass) is a one-line change.
    if (this.slab) {
      this.slab.update(frame.time, frame.delta_time);
      this.slab.render(this.scene, this.camera);
    }
  }

  /** Set the creature's base position in world space (meters). */
  setCreatureWorldPosition(x: number, y: number, z: number): void {
    this.creatureState.basePosition = { x, y, z };
  }

  /** Make the creature face toward a world-space point. */
  setCreatureLookAt(x: number, y: number, z: number): void {
    if (this.creatureRefs) {
      this.creatureRefs.group.lookAt(x, y, z);
    }
  }

  /** Access the renderer for setAnimationLoop(). */
  getRenderer(): THREE.WebGLRenderer | null {
    return this.renderer;
  }

  /**
   * Access the creature's THREE.Group so callers can mount spatial objects
   * that orbit or anchor to the creature (e.g., credential satellites,
   * federated-agent creatures, memory environment). Returns null before
   * init or after dispose.
   *
   * Children added to this group inherit the creature's world position
   * (set via setCreatureWorldPosition). Positioning satellites in group
   * space gives them a natural orbital anchor.
   */
  getCreatureGroup(): THREE.Group | null {
    return this.creatureRefs?.group ?? null;
  }

  /** Whether a WebXR session is currently active. */
  isSessionActive(): boolean {
    return this.renderer?.xr.isPresenting ?? false;
  }

  /**
   * Request an immersive-ar WebXR session.
   * Must be called from a user gesture (click/tap) handler.
   */
  async startSession(options?: {
    requiredFeatures?: string[];
    optionalFeatures?: string[];
  }): Promise<boolean> {
    if (!this.renderer || typeof navigator === "undefined" || !navigator.xr) return false;

    try {
      const session = await navigator.xr.requestSession("immersive-ar", {
        requiredFeatures: options?.requiredFeatures ?? ["local-floor"],
        optionalFeatures: options?.optionalFeatures ?? ["hand-tracking", "light-estimation"],
      });
      await this.renderer.xr.setSession(session);
      return true;
    } catch {
      return false;
    }
  }

  /** End the current WebXR session. */
  async endSession(): Promise<void> {
    const session = this.renderer?.xr.getSession();
    if (session) {
      await session.end();
    }
  }

  getSpec(): RenderSpec {
    return this.spec;
  }

  resize(width: number, height: number): void {
    if (this.camera) {
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    }
    if (this.renderer) {
      this.renderer.setSize(width, height, false);
    }
  }

  setBackground(_color: number | null): void {
    // No-op in AR — passthrough is always active
  }

  setDarkEnvironment(): void {
    if (this.scene && this.renderer) {
      const darkEnv = createEnvironmentMap(this.renderer, ENV_DARK);
      if (this.envMap) this.envMap.dispose();
      this.envMap = darkEnv;
      this.scene.environment = darkEnv;
    }
  }

  setLightEnvironment(): void {
    if (this.scene && this.renderer) {
      const lightEnv = createEnvironmentMap(this.renderer, ENV_LIGHT);
      if (this.envMap) this.envMap.dispose();
      this.envMap = lightEnv;
      this.scene.environment = lightEnv;
    }
  }

  setInteriorColor(color: InteriorColor): void {
    this.creatureState.interiorColor = color;
    if (this.creatureRefs) {
      this.creatureRefs.bodyMaterial.attenuationColor.setRGB(
        color.tint[0],
        color.tint[1],
        color.tint[2],
      );
      this.creatureRefs.bodyMaterial.emissive.setRGB(color.glow[0], color.glow[1], color.glow[2]);
      this.creatureRefs.bodyMaterial.emissiveIntensity = color.glowIntensity ?? 0.0;
      this.creatureRefs.bodyMaterial.needsUpdate = true;
    }
  }

  setAudioReactivity(energy: AudioReactivity | null): void {
    this.creatureState.audio = energy;
  }

  setTrustMode(mode: TrustMode): void {
    this.creatureState.trustMode = mode;
  }

  setListeningIndicator(active: boolean): void {
    this.creatureState.listeningActive = active;
  }

  // === Slab ("Motebit Computer") — held-tablet renderer ===
  //
  // Delegates to `SpatialSlabManager` constructed in init(). Same Ring
  // 1 state machine as the desktop slab; different body. The bridge
  // uses optional chaining, so a null manager (headless / pre-init /
  // post-dispose) degrades to safe no-ops — matching the desktop
  // ThreeJSAdapter contract.

  addSlabItem(spec: SlabItemSpec): SlabItemHandle | undefined {
    return this.slab?.addItem(spec);
  }

  dissolveSlabItem(id: string): Promise<void> {
    return this.slab?.dissolveItem(id) ?? Promise.resolve();
  }

  detachSlabItemAsArtifact(
    id: string,
    artifact: ArtifactSpec,
  ): Promise<ArtifactHandle | undefined> {
    return this.slab?.detachItemAsArtifact(id, artifact) ?? Promise.resolve(undefined);
  }

  clearSlabItems(): void {
    this.slab?.clearItems();
  }

  setSlabVisible(visible: boolean): void {
    this.slab?.setUserVisible(visible);
  }

  toggleSlabVisible(): boolean {
    return this.slab?.toggleUserVisible() ?? false;
  }

  isSlabVisible(): boolean {
    return this.slab?.isUserVisible() ?? false;
  }

  dispose(): void {
    this.endSession().catch(() => {});

    if (this.slab) {
      this.slab.dispose();
      this.slab = null;
    }

    if (this.creatureRefs) {
      disposeCreature(this.creatureRefs);
      this.creatureRefs = null;
    }

    if (this.envMap) {
      this.envMap.dispose();
      this.envMap = null;
    }
    if (this.scene) {
      this.scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          const mesh = obj as THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>;
          mesh.geometry.dispose();
          if (mesh.material instanceof THREE.Material) mesh.material.dispose();
        }
      });
    }
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer = null;
    }
    this.scene = null;
    this.camera = null;
    this.initialized = false;
  }
}
