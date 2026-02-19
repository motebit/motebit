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

// === Environment Presets ===
// Ported from packages/render-engine/src/adapter.ts — same values, same principle:
// glass needs chromatic variation to refract; uniform environments make glass invisible.

interface EnvironmentPreset {
  zenith: [number, number, number];
  horizon: [number, number, number];
  ground: [number, number, number];
  sun: [number, number, number];
  fill: [number, number, number];
  groundPanel: [number, number, number];
  warmTint?: [number, number, number];
  coolTint?: [number, number, number];
}

const ENV_LIGHT: EnvironmentPreset = {
  zenith:      [0.22, 0.32, 0.72],   // saturated blue upper sky
  horizon:     [0.92, 0.62, 0.35],   // warm amber horizon
  ground:      [0.15, 0.14, 0.18],   // dark cool ground
  sun:         [6.0,  3.2,  0.8],    // deep amber-gold key
  fill:        [0.3,  0.5,  2.2],    // blue-violet fill — spectral opposite of sun
  groundPanel: [0.50, 0.32, 0.18],   // warm ground bounce
  warmTint:    [1.25, 0.94, 0.68],   // warm side: red boost, blue cut
  coolTint:    [0.68, 0.88, 1.30],   // cool side: blue boost, red cut
};

const ENV_DARK: EnvironmentPreset = {
  zenith:      [0.02, 0.02, 0.04],
  horizon:     [0.04, 0.03, 0.03],
  ground:      [0.02, 0.02, 0.02],
  sun:         [2.0,  1.8,  1.5],
  fill:        [0.3,  0.4,  0.8],
  groundPanel: [0.08, 0.06, 0.05],
};

/**
 * Build a PMREM environment map from a sky gradient + emissive panels.
 * The GLSL shader creates a zenith→horizon→ground vertical gradient with
 * optional warm-cool azimuthal tinting. Sun, fill, and ground panels add
 * directional chromatic light sources.
 */
function createEnvironmentMap(
  renderer: THREE.WebGLRenderer,
  preset: EnvironmentPreset,
): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();

  const skyGeo = new THREE.SphereGeometry(5, 64, 32);
  const z = preset.zenith, h = preset.horizon, g = preset.ground;
  const hasSpectral = preset.warmTint && preset.coolTint;
  const w = preset.warmTint ?? [1, 1, 1], c = preset.coolTint ?? [1, 1, 1];

  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: {},
    vertexShader: `
      varying vec3 vWorldPos;
      void main() {
        vWorldPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vWorldPos;
      void main() {
        vec3 dir = normalize(vWorldPos);
        float y = dir.y;
        vec3 zenith  = vec3(${z[0]}, ${z[1]}, ${z[2]});
        vec3 horizon = vec3(${h[0]}, ${h[1]}, ${h[2]});
        vec3 ground  = vec3(${g[0]}, ${g[1]}, ${g[2]});
        vec3 color;
        if (y > 0.0) {
          color = mix(horizon, zenith, pow(y, 0.6));
        } else {
          color = mix(horizon * 0.5, ground, pow(-y, 0.4));
        }
        ${hasSpectral ? `
        float azimuth = atan(dir.z, dir.x) / 3.14159;
        float warmFactor = azimuth * 0.5 + 0.5;
        vec3 warm = vec3(${w[0]}, ${w[1]}, ${w[2]});
        vec3 cool = vec3(${c[0]}, ${c[1]}, ${c[2]});
        color *= mix(cool, warm, warmFactor);
        ` : ""}
        gl_FragColor = vec4(color, 1.0);
      }
    `,
  });
  envScene.add(new THREE.Mesh(skyGeo, skyMat));

  // Sun panel: amber-gold, positioned top-right-front
  const sunMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(...preset.sun),
    side: THREE.DoubleSide,
  });
  const sunPanel = new THREE.Mesh(new THREE.CircleGeometry(0.85, 32), sunMat);
  sunPanel.position.set(3, 3, 2);
  sunPanel.lookAt(0, 0, 0);
  envScene.add(sunPanel);

  // Fill panel: blue-violet, positioned upper-left-back
  const fillMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(...preset.fill),
    side: THREE.DoubleSide,
  });
  const fillPanel = new THREE.Mesh(new THREE.CircleGeometry(1.1, 32), fillMat);
  fillPanel.position.set(-2.5, 2, -1);
  fillPanel.lookAt(0, 0, 0);
  envScene.add(fillPanel);

  // Ground bounce panel: warm, horizontal, below
  const groundMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(...preset.groundPanel),
    side: THREE.DoubleSide,
  });
  const groundPanel = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), groundMat);
  groundPanel.position.set(0, -3, 0);
  groundPanel.rotation.x = Math.PI / 2;
  envScene.add(groundPanel);

  // Bake to PMREM cube texture
  const envMap = pmrem.fromScene(envScene, 0, 0.1, 100).texture;

  // Dispose intermediates
  skyGeo.dispose();
  skyMat.dispose();
  sunMat.dispose();
  fillMat.dispose();
  groundMat.dispose();
  pmrem.dispose();

  return envMap;
}

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

    this.camera = new THREE.PerspectiveCamera(
      45,
      this.width / this.height,
      0.1,
      100,
    );
    this.camera.position.set(0, 0, 3);

    // Lighting — ambient + directional supplement the environment map
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
