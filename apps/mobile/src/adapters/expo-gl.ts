/**
 * Expo-GL adapter for MotebitRuntime rendering.
 *
 * Wraps Three.js running on expo-gl into the RenderAdapter interface.
 * Uses expo-three's Renderer to bridge expo-gl contexts to Three.js.
 */

import { Renderer } from "expo-three";
import * as THREE from "three";
import { CANONICAL_SPEC } from "@motebit/render-engine";
import type { RenderAdapter, RenderFrame } from "@motebit/render-engine";
import type { RenderSpec, BehaviorCues } from "@motebit/sdk";

export class ExpoGLAdapter implements RenderAdapter {
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private mesh: THREE.Mesh | null = null;
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

    // Motebit mesh (droplet geometry approximated as a sphere)
    const geometry = new THREE.SphereGeometry(
      this.spec.geometry.base_radius,
      64,
      64,
    );

    const [r, g, b] = this.spec.material.base_color;
    const material = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(r, g, b),
      roughness: this.spec.material.roughness,
      clearcoat: this.spec.material.clearcoat,
      transparent: true,
      opacity: 0.92,
      ior: this.spec.material.ior,
    });

    this.mesh = new THREE.Mesh(geometry, material);
    this.scene.add(this.mesh);
  }

  render(frame: RenderFrame): void {
    if (!this.renderer || !this.scene || !this.camera || !this.mesh) return;

    const cues: BehaviorCues = frame.cues;
    const t = frame.time;

    // Hover
    this.mesh.position.y = Math.sin(t * 1.5) * cues.drift_amplitude + cues.hover_distance * 0.1;

    // Glow via emissive
    const material = this.mesh.material as THREE.MeshPhysicalMaterial;
    const [tr, tg, tb] = this.spec.material.tint;
    material.emissive.set(
      tr * cues.glow_intensity,
      tg * cues.glow_intensity,
      tb * cues.glow_intensity,
    );
    material.emissiveIntensity = cues.glow_intensity;

    // Scale by dilation
    const scale = 1 + cues.eye_dilation * 0.15;
    this.mesh.scale.setScalar(scale);

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

  dispose(): void {
    if (this.mesh) {
      this.mesh.geometry.dispose();
      const material = this.mesh.material;
      if (material instanceof THREE.Material) material.dispose();
    }
    if (this.renderer) {
      this.renderer.dispose();
    }
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.mesh = null;
  }
}
