/**
 * Expo-GL adapter for MotebitRuntime rendering.
 *
 * Wraps Three.js running on expo-gl into the RenderAdapter interface.
 * Uses expo-three's Renderer to bridge expo-gl contexts to Three.js.
 *
 * Creature geometry, material, and animation come from the shared
 * creature module in @motebit/render-engine. This adapter only handles
 * platform-specific concerns: expo-gl renderer, touch camera orbit,
 * mobile lighting, and endFrameEXP flush.
 */

import { Renderer } from "expo-three";
import * as THREE from "three";
import {
  CANONICAL_SPEC,
  createCreature,
  createCreatureState,
  animateCreature,
  disposeCreature,
  createEnvironmentMap,
  ENV_LIGHT,
  ENV_DARK,
} from "@motebit/render-engine";
import type {
  RenderAdapter,
  RenderFrame,
  InteriorColor,
  AudioReactivity,
  CreatureRefs,
  CreatureState,
} from "@motebit/render-engine";
import type { RenderSpec } from "@motebit/sdk";
import { TrustMode } from "@motebit/sdk";

// Camera orbit defaults — theta=0, phi=PI/2, radius=3 gives position (0, 0, 3)
const CAM_DEFAULT_THETA = 0;
const CAM_DEFAULT_PHI = Math.PI / 2;
const CAM_DEFAULT_RADIUS = 3;
const CAM_PAN_SENSITIVITY = 0.005; // radians per pixel of gesture delta
const CAM_LERP_FACTOR = 0.08; // per-frame interpolation speed
const CAM_PHI_MIN = (10 / 180) * Math.PI; // ~10° — avoid gimbal flip at poles
const CAM_PHI_MAX = (170 / 180) * Math.PI;
const CAM_RADIUS_MIN = 0.5;
const CAM_RADIUS_MAX = 4.0;
const CAM_RESET_DURATION = 0.5; // seconds for double-tap reset animation
const CAM_MOMENTUM_FRICTION = 0.92; // per-frame velocity multiplier (1 = no friction)
const CAM_MOMENTUM_MIN = 0.0002; // radians/frame below which momentum stops

export class ExpoGLAdapter implements RenderAdapter {
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private creatureRefs: CreatureRefs | null = null;
  private creatureState: CreatureState = createCreatureState();
  private spec: RenderSpec = CANONICAL_SPEC;
  private width = 1;
  private height = 1;

  // --- Camera orbit state (spherical coordinates) ---
  private camTargetTheta = CAM_DEFAULT_THETA;
  private camTargetPhi = CAM_DEFAULT_PHI;
  private camTargetRadius = CAM_DEFAULT_RADIUS;
  private camCurrentTheta = CAM_DEFAULT_THETA;
  private camCurrentPhi = CAM_DEFAULT_PHI;
  private camCurrentRadius = CAM_DEFAULT_RADIUS;
  /** True once the user has interacted — avoids unnecessary math when idle. */
  private camDirty = false;
  /** When > 0 the camera is animating back to default (double-tap reset). */
  private camResetProgress = -1;
  private camResetStartTheta = CAM_DEFAULT_THETA;
  private camResetStartPhi = CAM_DEFAULT_PHI;
  private camResetStartRadius = CAM_DEFAULT_RADIUS;
  private camLastRenderTime = 0;

  // --- Momentum state (fling-to-coast) ---
  private camVelocityTheta = 0;
  private camVelocityPhi = 0;
  /** True while user finger is down — suppresses momentum application. */
  private camTouching = false;

  init(gl: unknown): Promise<void> {
    const glContext = gl as WebGLRenderingContext;

    this.renderer = new Renderer({ gl: glContext }) as unknown as THREE.WebGLRenderer;
    this.renderer.setSize(glContext.drawingBufferWidth, glContext.drawingBufferHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    this.width = glContext.drawingBufferWidth;
    this.height = glContext.drawingBufferHeight;

    this.scene = new THREE.Scene();

    // Spectral environment — chromatic sky gradient that makes glass visible
    try {
      const envMap = createEnvironmentMap(this.renderer, ENV_LIGHT);
      this.scene.environment = envMap;
      this.scene.background = envMap;
    } catch {
      // Fallback: flat dark background if PMREM fails (old ES2 devices)
      this.scene.background = new THREE.Color(0x0a0a0a);
    }

    this.camera = new THREE.PerspectiveCamera(45, this.width / this.height, 0.1, 100);
    this.camera.position.set(0, 0, 3);

    // Lighting — mobile uses simpler lighting than desktop
    const ambient = new THREE.AmbientLight(0xffffff, this.spec.lighting.ambient_intensity);
    this.scene.add(ambient);

    const directional = new THREE.DirectionalLight(0xffffff, 0.8);
    directional.position.set(2, 3, 4);
    this.scene.add(directional);

    // === Creature — from shared module ===
    this.creatureRefs = createCreature(this.scene);

    return Promise.resolve();
  }

  // === Touch gesture handlers (called from App.tsx) ===

  /** Signal that a touch gesture has begun — suppresses momentum. */
  handleTouchStart(): void {
    this.camTouching = true;
    this.camVelocityTheta = 0;
    this.camVelocityPhi = 0;
  }

  /** Signal that touch has ended — momentum begins coasting. */
  handleTouchEnd(): void {
    this.camTouching = false;
    if (
      Math.abs(this.camVelocityTheta) > CAM_MOMENTUM_MIN ||
      Math.abs(this.camVelocityPhi) > CAM_MOMENTUM_MIN
    ) {
      this.camDirty = true;
    }
  }

  /**
   * Orbit the camera around the origin based on pan gesture deltas.
   * dx/dy are pixel deltas from a PanResponder or gesture handler.
   */
  handlePan(dx: number, dy: number): void {
    this.camResetProgress = -1;
    const dTheta = -dx * CAM_PAN_SENSITIVITY;
    const dPhi = -dy * CAM_PAN_SENSITIVITY;
    this.camTargetTheta += dTheta;
    this.camTargetPhi = Math.max(CAM_PHI_MIN, Math.min(CAM_PHI_MAX, this.camTargetPhi + dPhi));
    this.camVelocityTheta = this.camVelocityTheta * 0.5 + dTheta * 0.5;
    this.camVelocityPhi = this.camVelocityPhi * 0.5 + dPhi * 0.5;
    this.camDirty = true;
  }

  /**
   * Zoom by adjusting camera distance from origin.
   * scale > 1 = zoom in (closer), scale < 1 = zoom out (farther).
   */
  handlePinch(scale: number): void {
    this.camResetProgress = -1;
    this.camTargetRadius = Math.max(
      CAM_RADIUS_MIN,
      Math.min(CAM_RADIUS_MAX, this.camTargetRadius / scale),
    );
    this.camDirty = true;
  }

  /**
   * Reset camera to default position with a smooth animation over ~0.5 s.
   */
  handleDoubleTap(): void {
    this.camResetProgress = 0;
    this.camResetStartTheta = this.camCurrentTheta;
    this.camResetStartPhi = this.camCurrentPhi;
    this.camResetStartRadius = this.camCurrentRadius;
    this.camDirty = true;
  }

  render(frame: RenderFrame): void {
    if (!this.renderer || !this.scene || !this.camera || !this.creatureRefs) return;

    const t = frame.time;

    // Animate the creature — shared logic from render-engine
    animateCreature(this.creatureRefs, this.creatureState, frame);

    // --- Camera orbit interpolation (mobile-specific touch control) ---
    if (this.camDirty) {
      const now = t;

      if (this.camResetProgress >= 0) {
        const dt =
          this.camLastRenderTime > 0 ? Math.min(now - this.camLastRenderTime, 0.1) : 1 / 60;
        this.camResetProgress = Math.min(1, this.camResetProgress + dt / CAM_RESET_DURATION);
        const p = this.camResetProgress;
        const ease = p * p * (3 - 2 * p);
        this.camCurrentTheta =
          this.camResetStartTheta + (CAM_DEFAULT_THETA - this.camResetStartTheta) * ease;
        this.camCurrentPhi =
          this.camResetStartPhi + (CAM_DEFAULT_PHI - this.camResetStartPhi) * ease;
        this.camCurrentRadius =
          this.camResetStartRadius + (CAM_DEFAULT_RADIUS - this.camResetStartRadius) * ease;

        if (this.camResetProgress >= 1) {
          this.camTargetTheta = CAM_DEFAULT_THETA;
          this.camTargetPhi = CAM_DEFAULT_PHI;
          this.camTargetRadius = CAM_DEFAULT_RADIUS;
          this.camCurrentTheta = CAM_DEFAULT_THETA;
          this.camCurrentPhi = CAM_DEFAULT_PHI;
          this.camCurrentRadius = CAM_DEFAULT_RADIUS;
          this.camResetProgress = -1;
          this.camDirty = false;
        }
      } else {
        if (
          !this.camTouching &&
          (Math.abs(this.camVelocityTheta) > CAM_MOMENTUM_MIN ||
            Math.abs(this.camVelocityPhi) > CAM_MOMENTUM_MIN)
        ) {
          this.camTargetTheta += this.camVelocityTheta;
          this.camTargetPhi = Math.max(
            CAM_PHI_MIN,
            Math.min(CAM_PHI_MAX, this.camTargetPhi + this.camVelocityPhi),
          );
          this.camVelocityTheta *= CAM_MOMENTUM_FRICTION;
          this.camVelocityPhi *= CAM_MOMENTUM_FRICTION;
          if (Math.abs(this.camVelocityTheta) <= CAM_MOMENTUM_MIN) this.camVelocityTheta = 0;
          if (Math.abs(this.camVelocityPhi) <= CAM_MOMENTUM_MIN) this.camVelocityPhi = 0;
        }

        this.camCurrentTheta += (this.camTargetTheta - this.camCurrentTheta) * CAM_LERP_FACTOR;
        this.camCurrentPhi += (this.camTargetPhi - this.camCurrentPhi) * CAM_LERP_FACTOR;
        this.camCurrentRadius += (this.camTargetRadius - this.camCurrentRadius) * CAM_LERP_FACTOR;

        const hasVelocity =
          Math.abs(this.camVelocityTheta) > CAM_MOMENTUM_MIN ||
          Math.abs(this.camVelocityPhi) > CAM_MOMENTUM_MIN;
        const dTheta = Math.abs(this.camTargetTheta - this.camCurrentTheta);
        const dPhi = Math.abs(this.camTargetPhi - this.camCurrentPhi);
        const dRadius = Math.abs(this.camTargetRadius - this.camCurrentRadius);
        if (!hasVelocity && dTheta < 0.0001 && dPhi < 0.0001 && dRadius < 0.0001) {
          this.camCurrentTheta = this.camTargetTheta;
          this.camCurrentPhi = this.camTargetPhi;
          this.camCurrentRadius = this.camTargetRadius;
          this.camDirty = false;
        }
      }

      const sinPhi = Math.sin(this.camCurrentPhi);
      this.camera.position.set(
        this.camCurrentRadius * sinPhi * Math.sin(this.camCurrentTheta),
        this.camCurrentRadius * Math.cos(this.camCurrentPhi),
        this.camCurrentRadius * sinPhi * Math.cos(this.camCurrentTheta),
      );
      this.camera.lookAt(0, 0, 0);

      this.camLastRenderTime = now;
    }

    this.renderer.render(this.scene, this.camera);

    // expo-gl requires endFrameEXP to flush
    const gl = (this.renderer as unknown as { getContext(): WebGLRenderingContext }).getContext?.();
    if (gl != null && "endFrameEXP" in gl) {
      (gl as unknown as { endFrameEXP(): void }).endFrameEXP();
    }
  }

  getSpec(): RenderSpec {
    return this.spec;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    if (this.renderer) {
      this.renderer.setSize(width, height);
    }
    if (this.camera) {
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
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

  setBackground(_color: number | null): void {
    // No-op on mobile — background is controlled by React Native view
  }

  setDarkEnvironment(): void {
    if (this.scene && this.renderer) {
      try {
        const envMap = createEnvironmentMap(this.renderer, ENV_DARK);
        this.scene.environment = envMap;
        this.scene.background = envMap;
      } catch {
        // Non-fatal
      }
    }
  }

  setLightEnvironment(): void {
    if (this.scene && this.renderer) {
      try {
        const envMap = createEnvironmentMap(this.renderer, ENV_LIGHT);
        this.scene.environment = envMap;
        this.scene.background = envMap;
      } catch {
        // Non-fatal
      }
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
    if (this.creatureRefs) {
      disposeCreature(this.creatureRefs);
      this.creatureRefs = null;
    }
    if (this.renderer) {
      this.renderer.dispose();
    }
    this.renderer = null;
    this.scene = null;
    this.camera = null;
  }
}
