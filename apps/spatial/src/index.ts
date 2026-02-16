/**
 * @motebit/spatial — AR/Spatial computing stub
 *
 * This package defines the spatial anchoring API and body-relative
 * positioning system. Actual AR runtime (Unity/Unreal/WebXR)
 * must conform to the canonical render spec from @motebit/render-engine.
 */

import type { RenderSpec } from "@motebit/sdk";
import { CANONICAL_SPEC, type RenderAdapter, type RenderFrame } from "@motebit/render-engine";

// === Spatial Anchor ===

export interface SpatialAnchor {
  anchor_id: string;
  type: "body_relative" | "world" | "surface";
  position: [number, number, number]; // x, y, z
  orientation: [number, number, number, number]; // quaternion
  confidence: number;
}

// === Body-Relative Positioning ===

export interface BodyRelativePosition {
  /** Offset from body center, normalized */
  offset: [number, number, number];
  /** Which body reference point */
  reference: "head" | "shoulder_right" | "shoulder_left" | "chest" | "hand_right" | "hand_left";
  /** Orbit radius */
  orbit_radius: number;
  /** Current angle in orbit (radians) */
  orbit_angle: number;
}

export function computeWorldPosition(
  bodyAnchor: SpatialAnchor,
  relative: BodyRelativePosition,
): [number, number, number] {
  const [bx, by, bz] = bodyAnchor.position;
  const [ox, oy, oz] = relative.offset;
  const orbitX = Math.cos(relative.orbit_angle) * relative.orbit_radius;
  const orbitZ = Math.sin(relative.orbit_angle) * relative.orbit_radius;
  return [bx + ox + orbitX, by + oy, bz + oz + orbitZ];
}

// === WebXR Adapter Stub ===

export class WebXRAdapter implements RenderAdapter {
  private spec: RenderSpec = CANONICAL_SPEC;
  private session: unknown = null;

  isActive(): boolean {
    return this.session != null;
  }

  async init(target: unknown): Promise<void> {
    // In production:
    // 1. Request WebXR session (immersive-ar)
    // 2. Set up reference space (local-floor)
    // 3. Initialize Three.js WebXR renderer
    // 4. Set up hit testing for spatial anchors
    this.session = target;
  }

  render(_frame: RenderFrame): void {
    // In production: render motebit at body-relative position in AR space
  }

  getSpec(): RenderSpec {
    return this.spec;
  }

  resize(_width: number, _height: number): void {
    // Handled by XR runtime
  }

  dispose(): void {
    this.session = null;
  }
}
