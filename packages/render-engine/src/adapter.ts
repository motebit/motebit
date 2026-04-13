import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TrustMode, type RenderSpec } from "@motebit/sdk";
import { CANONICAL_SPEC } from "./spec.js";
import type {
  RenderAdapter,
  RenderFrame,
  InteriorColor,
  AudioReactivity,
  ArtifactSpec,
  ArtifactHandle,
} from "./spec.js";
import { ArtifactManager } from "./artifacts.js";
import {
  createCreature,
  createCreatureState,
  animateCreature,
  disposeCreature,
  createEnvironmentMap,
  ENV_LIGHT,
  ENV_DARK,
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
  dispose(): void {}
}

// === Desktop / Web Adapter ===
// The glass creature on screen. Spectral environment provides
// the chromatic gradient the glass needs to refract.

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

  init(target: unknown): Promise<void> {
    if (typeof HTMLCanvasElement === "undefined" || !(target instanceof HTMLCanvasElement)) {
      this.initialized = true;
      return Promise.resolve();
    }

    const canvas = target;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);

    this.scene = new THREE.Scene();
    const envMap = createEnvironmentMap(this.renderer);
    this.scene.environment = envMap;
    this.scene.background = envMap;

    this.camera = new THREE.PerspectiveCamera(
      45,
      canvas.clientWidth / canvas.clientHeight,
      0.1,
      10,
    );
    this.camera.position.set(0, 0.02, 0.85);
    this.camera.lookAt(0, -0.015, 0);

    // === Creature ===
    this.creatureRefs = createCreature(this.scene);

    // === Spatial Canvas — artifact positioning in creature's world ===
    const container = canvas.parentElement ?? document.body;
    if (this.creatureRefs) {
      this.artifactManager = new ArtifactManager(this.creatureRefs.group, container);
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

  setBackground(color: number | null): void {
    if (this.scene) {
      this.scene.background = color === null ? null : new THREE.Color(color);
    }
  }

  setDarkEnvironment(): void {
    if (this.scene && this.renderer) {
      const darkEnv = createEnvironmentMap(this.renderer, ENV_DARK);
      this.scene.environment = darkEnv;
      this.scene.background = darkEnv;
    }
  }

  setLightEnvironment(): void {
    if (this.scene && this.renderer) {
      const lightEnv = createEnvironmentMap(this.renderer, ENV_LIGHT);
      this.scene.environment = lightEnv;
      this.scene.background = lightEnv;
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

  enableOrbitControls(): void {
    if (!this.camera || !this.renderer) return;
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.target.set(0, -0.015, 0);
    this.controls.minDistance = 0.3;
    this.controls.maxDistance = 3.0;
    this.controls.update();
  }

  dispose(): void {
    if (this.creatureRefs) {
      disposeCreature(this.creatureRefs);
      this.creatureRefs = null;
    }

    this.artifactManager?.dispose();
    this.artifactManager = null;

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
  dispose(): void {}
}

// === WebXR Three.js Adapter ===
// The glass creature in physical space. AR passthrough — no simulated sky.
// The real world IS Liquescentia. The camera feed provides the chromatic spectrum
// that the glass refracts. ENV_LIGHT is the fallback when XR light estimation
// is unavailable.

export class WebXRThreeJSAdapter implements RenderAdapter {
  private spec: RenderSpec = CANONICAL_SPEC;
  private initialized = false;
  private creatureRefs: CreatureRefs | null = null;
  private creatureState: CreatureState = createCreatureState();

  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;

  private envMap: THREE.Texture | null = null;

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
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);

    this.scene = new THREE.Scene();
    // No background — AR passthrough. The real world IS Liquescentia.

    // Fallback environment map for glass refraction.
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

  dispose(): void {
    this.endSession().catch(() => {});

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
