/**
 * @motebit/spatial — AR/Spatial computing
 *
 * Spatial anchoring, body-relative positioning, and orbital dynamics
 * for the creature in physical space. The desktop app simulates the physics.
 * The spatial app instantiates it.
 *
 * DROPLET.md §6.5: "The user generates an attentional gravity field —
 * a potential well centered on the locus of interaction. The motebit has
 * mass and angular momentum in this well. The resulting motion is Keplerian."
 */

import type { RenderSpec } from "@motebit/sdk";
import { CANONICAL_SPEC, type RenderAdapter, type RenderFrame, type InteriorColor, type AudioReactivity } from "@motebit/render-engine";

// === Spatial Anchor ===

export interface SpatialAnchor {
  anchor_id: string;
  type: "body_relative" | "world" | "surface";
  position: [number, number, number]; // x, y, z
  orientation: [number, number, number, number]; // quaternion
  confidence: number;
}

// === Body-Relative Positioning ===

export type BodyReference = "head" | "shoulder_right" | "shoulder_left" | "chest" | "hand_right" | "hand_left";

export interface BodyRelativePosition {
  /** Offset from body center, normalized */
  offset: [number, number, number];
  /** Which body reference point */
  reference: BodyReference;
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

// === Orbital Dynamics ===
// Keplerian mechanics derived from DROPLET.md §6.5.
// The creature orbits the user's body. Attention modulates the well depth.
// The orbit is underdamped — the creature overshoots and oscillates before settling.

export interface OrbitalState {
  /** Current orbit angle (radians) */
  angle: number;
  /** Current orbit radius (meters) */
  radius: number;
  /** Angular velocity (rad/s) */
  angularVelocity: number;
  /** Radial velocity (m/s) */
  radialVelocity: number;
}

export interface OrbitalConfig {
  /** Default orbit radius when attention is neutral (~0.3m) */
  baseRadius: number;
  /** Minimum orbit radius (~0.15m) */
  minRadius: number;
  /** Maximum orbit radius (~0.8m) */
  maxRadius: number;
  /** Base angular velocity (rad/s) */
  angularSpeed: number;
  /** Damping ratio (< 1 for underdamped, = 1 for critical, > 1 for overdamped) */
  dampingRatio: number;
  /** Spring stiffness for radial oscillation */
  springStiffness: number;
  /** Vertical bob amplitude (meters) */
  bobAmplitude: number;
  /** Incommensurate bob frequencies — quasi-periodic, non-repeating */
  bobFrequencies: number[];
  /** How much attention shrinks the orbit (0-1). 0.6 means full attention → 40% of base radius */
  attentionShrink: number;
  /** Anchor transition speed (higher = faster lerp to new reference point) */
  anchorTransitionSpeed: number;
}

const DEFAULT_ORBITAL_CONFIG: OrbitalConfig = {
  baseRadius: 0.3,
  minRadius: 0.15,
  maxRadius: 0.8,
  angularSpeed: 0.3,
  dampingRatio: 0.7,       // underdamped — overshoots before settling
  springStiffness: 4.0,
  bobAmplitude: 0.015,
  bobFrequencies: [1.5, 2.37, 0.73],
  attentionShrink: 0.6,
  anchorTransitionSpeed: 2.0,
};

export class OrbitalDynamics {
  private state: OrbitalState;
  private config: OrbitalConfig;

  // Anchor lerp for smooth reference point transitions
  private currentAnchor: [number, number, number] = [0, 0, 0];
  private targetAnchor: [number, number, number] = [0, 0, 0];
  private anchorLerp = 1.0; // 1 = fully at target

  constructor(config?: Partial<OrbitalConfig>) {
    this.config = { ...DEFAULT_ORBITAL_CONFIG, ...config };
    this.state = {
      angle: 0,
      radius: this.config.baseRadius,
      angularVelocity: this.config.angularSpeed,
      radialVelocity: 0,
    };
  }

  /**
   * Advance the orbital simulation by dt seconds.
   *
   * @param dt - Time step in seconds
   * @param time - Absolute time in seconds (for bob coherence)
   * @param anchorPosition - The body reference point (e.g. shoulder) in world space
   * @param attentionLevel - 0 (idle) to 1 (full attention). Modulates well depth.
   * @returns World position [x, y, z] for the creature
   */
  tick(
    dt: number,
    time: number,
    anchorPosition: [number, number, number],
    attentionLevel: number,
  ): [number, number, number] {
    // Clamp dt to avoid physics explosion on frame drops
    const clampedDt = Math.min(dt, 0.1);

    // Update anchor with smooth transition
    this.updateAnchor(anchorPosition, clampedDt);

    // Equilibrium radius: higher attention = deeper potential well = tighter orbit
    // r_eq = baseRadius * (1 - attention * shrinkFactor)
    const attention = Math.max(0, Math.min(1, attentionLevel));
    const rEq = Math.max(
      this.config.minRadius,
      Math.min(
        this.config.maxRadius,
        this.config.baseRadius * (1 - attention * this.config.attentionShrink),
      ),
    );

    // === Radial dynamics — underdamped spring toward equilibrium ===
    // F = -k(r - r_eq) - c * v_r
    // c = 2 * dampingRatio * sqrt(k) — underdamped when dampingRatio < 1
    const displacement = this.state.radius - rEq;
    const springForce = -this.config.springStiffness * displacement;
    const dampingForce = -2 * this.config.dampingRatio
      * Math.sqrt(this.config.springStiffness)
      * this.state.radialVelocity;
    const radialAccel = springForce + dampingForce;

    this.state.radialVelocity += radialAccel * clampedDt;
    this.state.radius += this.state.radialVelocity * clampedDt;
    this.state.radius = Math.max(this.config.minRadius, Math.min(this.config.maxRadius, this.state.radius));

    // === Angular dynamics — Kepler ===
    // Conservation of angular momentum: ω ∝ 1/r²
    // When radius shrinks, angular velocity increases. The creature speeds up as it spirals in.
    const rRatio = this.config.baseRadius / Math.max(this.state.radius, 0.001);
    this.state.angularVelocity = this.config.angularSpeed * rRatio * rRatio;
    this.state.angle += this.state.angularVelocity * clampedDt;
    this.state.angle = this.state.angle % (Math.PI * 2);

    // Compute interpolated anchor (smooth reference transitions)
    const anchor = this.getInterpolatedAnchor();

    // Orbit in the horizontal plane around the anchor
    const orbitX = Math.cos(this.state.angle) * this.state.radius;
    const orbitZ = Math.sin(this.state.angle) * this.state.radius;

    // Vertical bob — organic noise from incommensurate frequencies (§6.3)
    let bobSum = 0;
    for (const f of this.config.bobFrequencies) bobSum += Math.sin(time * f);
    const bob = (bobSum / this.config.bobFrequencies.length) * this.config.bobAmplitude;

    return [
      anchor[0] + orbitX,
      anchor[1] + bob,
      anchor[2] + orbitZ,
    ];
  }

  private updateAnchor(newAnchor: [number, number, number], dt: number): void {
    // If the anchor moved significantly, start a smooth transition
    const dx = newAnchor[0] - this.targetAnchor[0];
    const dy = newAnchor[1] - this.targetAnchor[1];
    const dz = newAnchor[2] - this.targetAnchor[2];
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (dist > 0.01) {
      // Snapshot current interpolated position as the transition start
      this.currentAnchor = this.getInterpolatedAnchor();
      this.targetAnchor = [...newAnchor];
      this.anchorLerp = 0;
    }

    // Advance lerp toward target
    if (this.anchorLerp < 1) {
      this.anchorLerp = Math.min(1, this.anchorLerp + dt * this.config.anchorTransitionSpeed);
    }
  }

  private getInterpolatedAnchor(): [number, number, number] {
    const t = this.anchorLerp;
    // Smoothstep for organic transition — no abrupt jumps
    const s = t * t * (3 - 2 * t);
    return [
      this.currentAnchor[0] + (this.targetAnchor[0] - this.currentAnchor[0]) * s,
      this.currentAnchor[1] + (this.targetAnchor[1] - this.currentAnchor[1]) * s,
      this.currentAnchor[2] + (this.targetAnchor[2] - this.currentAnchor[2]) * s,
    ];
  }

  /** Get the current orbital state (for debugging / visualization). */
  getState(): Readonly<OrbitalState> {
    return { ...this.state };
  }

  /** Get the current config. */
  getConfig(): Readonly<OrbitalConfig> {
    return { ...this.config };
  }

  /** Reset the orbit to initial state. */
  reset(): void {
    this.state = {
      angle: 0,
      radius: this.config.baseRadius,
      angularVelocity: this.config.angularSpeed,
      radialVelocity: 0,
    };
    this.currentAnchor = [0, 0, 0];
    this.targetAnchor = [0, 0, 0];
    this.anchorLerp = 1;
  }
}

// === Body Tracking ===
// Derives body reference anchors from WebXR tracking data.
// Head comes from XRViewerPose. Shoulders are anthropometrically estimated.
// Hands come from XR hand tracking (when available).

/** Anthropometric constants for deriving body anchors from head pose. */
const SHOULDER_DROP_Y = -0.35;    // Shoulder is ~35cm below head center
const SHOULDER_OFFSET_X = 0.20;   // Shoulder is ~20cm lateral from head center
const SHOULDER_FORWARD_Z = -0.05; // Shoulder is slightly behind head

export interface BodyAnchors {
  head: [number, number, number];
  shoulder_right: [number, number, number];
  shoulder_left: [number, number, number];
  chest: [number, number, number];
  hand_right: [number, number, number] | null;
  hand_left: [number, number, number] | null;
}

/**
 * Estimate body anchor positions from head pose and optional hand positions.
 * Head is directly from XRViewerPose. Shoulders and chest are anthropometrically derived.
 */
export function estimateBodyAnchors(
  headPosition: [number, number, number],
  handRight?: [number, number, number] | null,
  handLeft?: [number, number, number] | null,
): BodyAnchors {
  const [hx, hy, hz] = headPosition;

  return {
    head: [hx, hy, hz],
    shoulder_right: [hx + SHOULDER_OFFSET_X, hy + SHOULDER_DROP_Y, hz + SHOULDER_FORWARD_Z],
    shoulder_left: [hx - SHOULDER_OFFSET_X, hy + SHOULDER_DROP_Y, hz + SHOULDER_FORWARD_Z],
    chest: [hx, hy + SHOULDER_DROP_Y + 0.05, hz + SHOULDER_FORWARD_Z],
    hand_right: handRight ?? null,
    hand_left: handLeft ?? null,
  };
}

/**
 * Select the appropriate body anchor for the current context.
 * Returns the position for the specified reference point, or shoulder_right as default.
 */
export function getAnchorForReference(
  anchors: BodyAnchors,
  reference: BodyReference,
): [number, number, number] | null {
  switch (reference) {
    case "head": return anchors.head;
    case "shoulder_right": return anchors.shoulder_right;
    case "shoulder_left": return anchors.shoulder_left;
    case "chest": return anchors.chest;
    case "hand_right": return anchors.hand_right;
    case "hand_left": return anchors.hand_left;
  }
}

// === WebXR Adapter Stub ===
// Lightweight adapter for testing. The real WebXR rendering uses
// WebXRThreeJSAdapter from @motebit/render-engine.

export class WebXRAdapter implements RenderAdapter {
  private spec: RenderSpec = CANONICAL_SPEC;
  private session: unknown = null;

  isActive(): boolean {
    return this.session != null;
  }

  init(target: unknown): Promise<void> {
    this.session = target;
    return Promise.resolve();
  }

  render(_frame: RenderFrame): void {}
  getSpec(): RenderSpec { return this.spec; }
  resize(_width: number, _height: number): void {}
  setBackground(_color: number | null): void {}
  setDarkEnvironment(): void {}
  setLightEnvironment(): void {}
  setInteriorColor(_color: InteriorColor): void {}
  setAudioReactivity(_energy: AudioReactivity | null): void {}

  dispose(): void {
    this.session = null;
  }
}
