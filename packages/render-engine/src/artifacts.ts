/**
 * Artifact Manager — positions HTML elements in 3D space around the creature.
 *
 * Uses Three.js CSS2DRenderer to overlay HTML on the WebGL canvas.
 * Artifacts are children of the creature's group — they inherit drift, bob,
 * and sag automatically. Entrance/exit animations follow DROPLET.md physics:
 * scale from zero (surface tension snap), no bounce, no particles.
 */

import * as THREE from "three";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import type { ArtifactSpec, ArtifactHandle, ArtifactPhase, ArtifactKind } from "./spec.js";
import { smoothDelta } from "./spec.js";

// === Constants ===

/** Orbit radius from creature center (meters). ~2.5x body radius. */
const ORBIT_RADIUS = 0.45;
/** Y offset below creature center (artifacts sit lower, like a desk surface). */
const ORBIT_Y = -0.12;
/** Arc facing the camera: artifacts spread left-to-right in screen space.
 *  PI/2 = pure right, -PI/2 = pure left (camera looks from +Z). */
const ARC_MIN = -Math.PI / 2;
const ARC_MAX = Math.PI / 2;
/** Maximum simultaneous artifacts. FIFO eviction. */
const MAX_ARTIFACTS = 6;
/** Entrance duration in seconds. */
const EMERGE_DURATION = 0.6;
/** Exit duration in seconds. */
const RECEDE_DURATION = 0.4;

// === Managed Artifact State ===

interface ManagedArtifact {
  id: string;
  kind: ArtifactKind;
  object: CSS2DObject;
  element: HTMLElement;
  phase: ArtifactPhase;
  /** Progress 0→1 within current phase. */
  phaseTime: number;
  /** Current angular position (radians). */
  angle: number;
  /** Target angular position after reflow. */
  targetAngle: number;
  /** Resolve function for dismiss() promise. */
  onDismissed?: () => void;
}

// === Animation Curves (DROPLET.md compliant) ===

/** Asymmetric ease: fast expansion (surface tension snap), slow settle. */
function emergeEase(t: number): number {
  // Same power curve as breathing recovery
  return Math.pow(Math.min(t, 1), 0.6);
}

/** Reverse: slow contraction, fast collapse. */
function recedeEase(t: number): number {
  return 1 - Math.pow(Math.min(t, 1), 0.4);
}

// === Artifact Manager ===

export class ArtifactManager {
  private artifacts = new Map<string, ManagedArtifact>();
  /** Insertion order for FIFO eviction. */
  private insertionOrder: string[] = [];
  private css2dRenderer: CSS2DRenderer;
  private artifactGroup: THREE.Group;

  constructor(creatureGroup: THREE.Group, container: HTMLElement) {
    // Create a dedicated group for artifacts, child of creature
    this.artifactGroup = new THREE.Group();
    this.artifactGroup.name = "artifacts";
    creatureGroup.add(this.artifactGroup);

    // CSS2DRenderer overlays HTML on the WebGL canvas
    this.css2dRenderer = new CSS2DRenderer();
    this.css2dRenderer.setSize(container.clientWidth, container.clientHeight);
    this.css2dRenderer.domElement.style.position = "absolute";
    this.css2dRenderer.domElement.style.top = "0";
    this.css2dRenderer.domElement.style.left = "0";
    this.css2dRenderer.domElement.style.zIndex = "1";
    this.css2dRenderer.domElement.style.pointerEvents = "none";
    container.appendChild(this.css2dRenderer.domElement);
  }

  add(spec: ArtifactSpec): ArtifactHandle {
    // Evict oldest if at capacity
    while (this.insertionOrder.length >= MAX_ARTIFACTS) {
      const oldestId = this.insertionOrder[0]!;
      this.removeImmediate(oldestId);
    }

    // Create CSS2DObject wrapping the caller's HTML element
    spec.element.style.pointerEvents = "auto";
    spec.element.style.transform = "scale(0)";
    spec.element.style.transformOrigin = "center center";
    spec.element.style.transition = "none"; // We drive animation manually

    const cssObject = new CSS2DObject(spec.element);
    const angle = spec.preferredAngle ?? this.nextSlotAngle();

    // Position in creature-local space
    cssObject.position.set(Math.sin(angle) * ORBIT_RADIUS, ORBIT_Y, Math.cos(angle) * ORBIT_RADIUS);

    this.artifactGroup.add(cssObject);

    const managed: ManagedArtifact = {
      id: spec.id,
      kind: spec.kind,
      object: cssObject,
      element: spec.element,
      phase: "emerging",
      phaseTime: 0,
      angle,
      targetAngle: angle,
    };

    this.artifacts.set(spec.id, managed);
    this.insertionOrder.push(spec.id);
    this.reflowSlots();

    const handle: ArtifactHandle = {
      id: spec.id,
      setAngle: (radians: number) => {
        managed.targetAngle = radians;
      },
      dismiss: () => this.remove(spec.id),
    };

    return handle;
  }

  remove(id: string): Promise<void> {
    const artifact = this.artifacts.get(id);
    if (!artifact) return Promise.resolve();

    if (artifact.phase === "receding" || artifact.phase === "gone") {
      return new Promise<void>((resolve) => {
        artifact.onDismissed = resolve;
      });
    }

    artifact.phase = "receding";
    artifact.phaseTime = 0;

    return new Promise<void>((resolve) => {
      artifact.onDismissed = resolve;
    });
  }

  clear(): void {
    for (const id of [...this.insertionOrder]) {
      this.removeImmediate(id);
    }
  }

  /** Called every frame to advance animations and reflow positions. */
  update(deltaTime: number): void {
    for (const artifact of this.artifacts.values()) {
      artifact.phaseTime += deltaTime;

      switch (artifact.phase) {
        case "emerging": {
          const t = artifact.phaseTime / EMERGE_DURATION;
          const scale = emergeEase(t);
          artifact.element.style.transform = `scale(${scale})`;
          if (t >= 1) {
            artifact.phase = "present";
            artifact.element.style.transform = "scale(1)";
          }
          break;
        }
        case "receding": {
          const t = artifact.phaseTime / RECEDE_DURATION;
          const scale = recedeEase(t);
          artifact.element.style.transform = `scale(${scale})`;
          if (t >= 1) {
            artifact.phase = "gone";
            artifact.element.style.transform = "scale(0)";
            this.removeImmediate(artifact.id);
            artifact.onDismissed?.();
          }
          break;
        }
        case "present":
          // Smooth angle reflow
          artifact.angle = smoothDelta(artifact.angle, artifact.targetAngle, deltaTime, 4.0);
          artifact.object.position.set(
            Math.sin(artifact.angle) * ORBIT_RADIUS,
            ORBIT_Y,
            Math.cos(artifact.angle) * ORBIT_RADIUS,
          );
          break;
      }
    }
  }

  /** Called every frame after WebGL render to sync CSS overlay positions. */
  render(scene: THREE.Scene, camera: THREE.Camera): void {
    this.css2dRenderer.render(scene, camera);
  }

  resize(width: number, height: number): void {
    this.css2dRenderer.setSize(width, height);
  }

  dispose(): void {
    this.clear();
    this.css2dRenderer.domElement.remove();
  }

  // === Internal ===

  private removeImmediate(id: string): void {
    const artifact = this.artifacts.get(id);
    if (!artifact) return;

    this.artifactGroup.remove(artifact.object);
    this.artifacts.delete(id);
    this.insertionOrder = this.insertionOrder.filter((i) => i !== id);
    this.reflowSlots();
  }

  /** Distribute artifacts evenly across the front arc. */
  private reflowSlots(): void {
    const ids = this.insertionOrder.filter((id) => {
      const a = this.artifacts.get(id);
      return a != null && a.phase !== "receding" && a.phase !== "gone";
    });

    const n = ids.length;
    if (n === 0) return;

    if (n === 1) {
      const artifact = this.artifacts.get(ids[0]!)!;
      artifact.targetAngle = Math.PI / 2; // Pure right side — max separation from creature
      return;
    }

    const step = (ARC_MAX - ARC_MIN) / (n - 1);
    for (let i = 0; i < n; i++) {
      const artifact = this.artifacts.get(ids[i]!)!;
      artifact.targetAngle = ARC_MIN + step * i;
    }
  }

  /** Pick the angle for a new artifact before reflow. */
  private nextSlotAngle(): number {
    const n = this.insertionOrder.length;
    if (n === 0) return 0;
    // Place at end of current arc, will be reflowed
    return ARC_MAX;
  }
}
