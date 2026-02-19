/**
 * Expo-GL adapter for MotebitRuntime rendering.
 *
 * Wraps Three.js running on expo-gl into the RenderAdapter interface.
 * Uses expo-three's Renderer to bridge expo-gl contexts to Three.js.
 *
 * Glass material, eyes, smile, breathing, and sag match the desktop
 * ThreeJSAdapter. Three.js gracefully degrades if the GPU doesn't
 * support transmission extensions.
 */

import { Renderer } from "expo-three";
import * as THREE from "three";
import { CANONICAL_SPEC } from "@motebit/render-engine";
import type { RenderAdapter, RenderFrame, InteriorColor, AudioReactivity } from "@motebit/render-engine";
import type { RenderSpec, BehaviorCues } from "@motebit/sdk";

const BODY_R = 0.14;
const EYE_R = 0.035;

function organicNoise(t: number, frequencies: number[]): number {
  let sum = 0;
  for (const f of frequencies) sum += Math.sin(t * f);
  return sum / frequencies.length;
}

function createEye(): THREE.Group {
  const group = new THREE.Group();

  const eyeGeo = new THREE.SphereGeometry(EYE_R, 32, 32);
  const eyeMat = new THREE.MeshStandardMaterial({
    color: 0x080808,
    roughness: 0.05,
    metalness: 0.0,
  });
  group.add(new THREE.Mesh(eyeGeo, eyeMat));

  const catchMat = new THREE.MeshBasicMaterial({ color: 0xffffff });

  const bigCatchGeo = new THREE.SphereGeometry(EYE_R * 0.22, 16, 16);
  const bigCatch = new THREE.Mesh(bigCatchGeo, catchMat);
  bigCatch.position.set(EYE_R * 0.25, EYE_R * 0.3, EYE_R * 0.82);
  group.add(bigCatch);

  const smallCatchGeo = new THREE.SphereGeometry(EYE_R * 0.12, 16, 16);
  const smallCatch = new THREE.Mesh(smallCatchGeo, catchMat);
  smallCatch.position.set(-EYE_R * 0.2, -EYE_R * 0.15, EYE_R * 0.85);
  group.add(smallCatch);

  return group;
}

function createSmile(): THREE.Mesh {
  const curve = new THREE.QuadraticBezierCurve3(
    new THREE.Vector3(-0.03, 0, 0),
    new THREE.Vector3(0, -0.012, 0.002),
    new THREE.Vector3(0.03, 0, 0),
  );
  const geo = new THREE.TubeGeometry(curve, 20, 0.002, 6, false);
  const mat = new THREE.MeshBasicMaterial({ color: 0x111111 });
  return new THREE.Mesh(geo, mat);
}

export class ExpoGLAdapter implements RenderAdapter {
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private creature: THREE.Group | null = null;
  private bodyMesh: THREE.Mesh | null = null;
  private bodyMaterial: THREE.MeshPhysicalMaterial | null = null;
  private leftEye: THREE.Group | null = null;
  private rightEye: THREE.Group | null = null;
  private smileMesh: THREE.Mesh | null = null;
  private audio: AudioReactivity | null = null;
  private spec: RenderSpec = CANONICAL_SPEC;
  private width = 1;
  private height = 1;

  async init(gl: unknown): Promise<void> {
    const glContext = gl as WebGLRenderingContext;

    this.renderer = new Renderer({ gl: glContext }) as unknown as THREE.WebGLRenderer;
    this.renderer.setSize(glContext.drawingBufferWidth, glContext.drawingBufferHeight);
    this.renderer.setClearColor(0x0a0a0a);

    this.width = glContext.drawingBufferWidth;
    this.height = glContext.drawingBufferHeight;

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(
      45,
      this.width / this.height,
      0.1,
      100,
    );
    this.camera.position.set(0, 0, 3);

    // Lighting
    const ambient = new THREE.AmbientLight(0xffffff, this.spec.lighting.ambient_intensity);
    this.scene.add(ambient);

    const directional = new THREE.DirectionalLight(0xffffff, 0.8);
    directional.position.set(2, 3, 4);
    this.scene.add(directional);

    // Creature group
    this.creature = new THREE.Group();
    this.scene.add(this.creature);

    // Body — canonical glass material
    const bodyGeo = new THREE.SphereGeometry(BODY_R, 64, 48);
    const tint = this.spec.material.tint;
    this.bodyMaterial = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(1.0, 1.0, 1.0),
      transmission: 0.94,
      ior: 1.22,
      thickness: 0.18,
      roughness: 0.0,
      clearcoat: 0.4,
      clearcoatRoughness: 0.02,
      envMapIntensity: 1.2,
      emissive: new THREE.Color(0.6, 0.7, 0.9),
      emissiveIntensity: 0.0,
      iridescence: 0.4,
      iridescenceIOR: 1.3,
      iridescenceThicknessRange: [100, 400],
      side: THREE.FrontSide,
      attenuationColor: new THREE.Color(tint[0], tint[1], tint[2]),
      attenuationDistance: BODY_R * 0.7,
    });

    this.bodyMesh = new THREE.Mesh(bodyGeo, this.bodyMaterial);
    this.creature.add(this.bodyMesh);

    // Eyes
    this.leftEye = createEye();
    this.leftEye.position.set(-0.055, 0.015, 0.08);
    this.creature.add(this.leftEye);

    this.rightEye = createEye();
    this.rightEye.position.set(0.055, 0.015, 0.08);
    this.creature.add(this.rightEye);

    // Smile
    this.smileMesh = createSmile();
    this.smileMesh.position.set(0, -0.025, 0.09);
    this.creature.add(this.smileMesh);
  }

  render(frame: RenderFrame): void {
    if (!this.renderer || !this.scene || !this.camera || !this.creature || !this.bodyMesh || !this.bodyMaterial) return;

    const cues: BehaviorCues = frame.cues;
    const t = frame.time;

    // Audio modulation — four dimensions match desktop ThreeJSAdapter
    const a = this.audio;
    const audioBreathScale = a ? 1 + a.rms * 2.5 : 1;       // RMS → breathing amplitude
    const audioGlow = a ? a.low * 0.25 : 0;                  // Bass → interior heat
    const audioDrift = a ? a.mid * 0.015 : 0;                // Midrange → swaying motion
    const audioShimmer = a ? a.high * 0.35 : 0;              // Transients → glass shimmer

    // Breathing — asymmetric oblate/prolate oscillation
    const breatheRaw = Math.sin(t * 2.0);
    const breathe = (breatheRaw > 0
      ? breatheRaw * 0.015
      : Math.sign(breatheRaw) * Math.pow(Math.abs(breatheRaw), 0.6) * 0.015) * audioBreathScale;

    // Gravity sag — slow cycle
    const sagRaw = Math.sin(t * 0.32 * Math.PI * 2);
    const sag = sagRaw > 0
      ? sagRaw * 0.032
      : Math.sign(sagRaw) * Math.pow(Math.abs(sagRaw), 0.5) * 0.032;

    const REST_Y = 0.97;
    this.bodyMesh.scale.set(
      1.0 + breathe + sag * 0.15,
      REST_Y - breathe - sag * 0.3,
      1.0 + breathe + sag * 0.15,
    );

    // Organic drift — midrange audio increases sway
    const drift = cues.drift_amplitude + audioDrift;
    this.creature.position.y = organicNoise(t, [1.5, 2.37, 0.73]) * 0.01 * cues.hover_distance - sag * 0.01;
    this.creature.position.x = organicNoise(t, [0.7, 1.13, 0.31]) * drift;
    this.creature.position.z = organicNoise(t, [0.5, 0.83, 0.23]) * drift * 0.25;

    // Interior glow — bass frequencies brighten interior
    this.bodyMaterial.emissiveIntensity = Math.max(0, (cues.glow_intensity - 0.3) * 0.2 + audioGlow);

    // Glass shimmer — transients increase iridescence
    this.bodyMaterial.iridescence = 0.4 + audioShimmer;

    // Eye dilation
    if (this.leftEye && this.rightEye) {
      const eyeScale = 0.8 + cues.eye_dilation * 0.4;
      this.leftEye.scale.setScalar(eyeScale);
      this.rightEye.scale.setScalar(eyeScale);
      const eyeZ = 0.08 + Math.sin(t * 0.25) * 0.001;
      this.leftEye.position.z = eyeZ;
      this.rightEye.position.z = eyeZ;
    }

    // Smile
    if (this.smileMesh) {
      this.smileMesh.scale.y = cues.smile_curvature;
    }

    this.renderer.render(this.scene, this.camera);

    // expo-gl requires endFrameEXP to flush
    const gl = (this.renderer as unknown as { getContext(): WebGLRenderingContext }).getContext?.();
    if (gl && "endFrameEXP" in gl) {
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
    if (this.bodyMaterial) {
      this.bodyMaterial.attenuationColor.setRGB(color.tint[0], color.tint[1], color.tint[2]);
      this.bodyMaterial.emissive.setRGB(color.glow[0], color.glow[1], color.glow[2]);
      this.bodyMaterial.emissiveIntensity = color.glowIntensity ?? 0.0;
      this.bodyMaterial.needsUpdate = true;
    }
  }

  setBackground(_color: number | null): void {
    // No-op on mobile — background is controlled by React Native view
  }

  setDarkEnvironment(): void {
    // No-op on mobile — single environment
  }

  setLightEnvironment(): void {
    // No-op on mobile — single environment
  }

  setAudioReactivity(energy: AudioReactivity | null): void {
    this.audio = energy;
  }

  dispose(): void {
    if (this.bodyMesh) {
      this.bodyMesh.geometry.dispose();
    }
    if (this.bodyMaterial) {
      this.bodyMaterial.dispose();
    }
    if (this.leftEye) {
      this.leftEye.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          if (child.material instanceof THREE.Material) child.material.dispose();
        }
      });
    }
    if (this.rightEye) {
      this.rightEye.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          if (child.material instanceof THREE.Material) child.material.dispose();
        }
      });
    }
    if (this.smileMesh) {
      this.smileMesh.geometry.dispose();
      if (this.smileMesh.material instanceof THREE.Material) this.smileMesh.material.dispose();
    }
    if (this.renderer) {
      this.renderer.dispose();
    }
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.creature = null;
    this.bodyMesh = null;
    this.bodyMaterial = null;
    this.leftEye = null;
    this.rightEye = null;
    this.smileMesh = null;
  }
}
