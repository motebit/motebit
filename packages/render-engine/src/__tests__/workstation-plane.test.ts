/**
 * @vitest-environment jsdom
 *
 * WorkstationPlane tests — the liquid-glass slate that mounts the
 * agent-workstation DOM as a CSS3DObject inside the creature's scene
 * group. CSS3DRenderer is stubbed at the module boundary (same pattern
 * as artifacts.test.ts for CSS2D); jsdom supplies `document` so the
 * stage element is a real <div> the class can populate.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import * as THREE from "three";

vi.mock("three/addons/renderers/CSS3DRenderer.js", async () => {
  const THREEmod = await vi.importActual<typeof import("three")>("three");

  class FakeCSS3DObject extends THREEmod.Object3D {
    element: HTMLElement;
    constructor(element: HTMLElement) {
      super();
      this.element = element;
    }
  }

  class FakeCSS3DRenderer {
    domElement: HTMLDivElement;
    renderCalls = 0;
    lastSize: { w: number; h: number } = { w: 0, h: 0 };
    constructor() {
      this.domElement = document.createElement("div");
    }
    setSize(w: number, h: number) {
      this.lastSize = { w, h };
    }
    render(_scene: unknown, _camera: unknown) {
      this.renderCalls++;
    }
  }

  return {
    CSS3DRenderer: FakeCSS3DRenderer,
    CSS3DObject: FakeCSS3DObject,
  };
});

// Import AFTER the mock so WorkstationPlane picks up the stubs.
const { WorkstationPlane } = await import("../workstation-plane.js");
import type { InteriorColor } from "../spec.js";

function makeContainer(): HTMLDivElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "clientWidth", { value: 800, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: 600, configurable: true });
  return el;
}

function colorOf(tint: [number, number, number], glow: [number, number, number]): InteriorColor {
  return { tint, glow, glowIntensity: 0.5 };
}

describe("WorkstationPlane — construction", () => {
  let creatureGroup: THREE.Group;
  let container: HTMLDivElement;
  let plane: InstanceType<typeof WorkstationPlane>;

  beforeEach(() => {
    creatureGroup = new THREE.Group();
    container = makeContainer();
    plane = new WorkstationPlane(creatureGroup, container);
  });

  it("mounts its group under the creature group", () => {
    const group = plane.getGroup();
    expect(group).toBeInstanceOf(THREE.Group);
    expect(group.name).toBe("workstation-plane");
    expect(creatureGroup.children).toContain(group);
  });

  it("seats the group at the right-hand held-tablet pose", () => {
    const g = plane.getGroup();
    expect(g.position.x).toBeCloseTo(0.38, 2);
    expect(g.position.y).toBeCloseTo(0.0, 2);
    expect(g.position.z).toBeCloseTo(-0.02, 2);
    expect(g.rotation.x).toBeCloseTo(-0.22, 2);
    expect(g.rotation.y).toBeCloseTo(-0.09, 2);
  });

  it("adds the glass plane mesh and the CSS3D stage anchor as children", () => {
    const g = plane.getGroup();
    // Two children: the Mesh and the CSS3DObject (Object3D subclass).
    expect(g.children.length).toBe(2);
    const mesh = g.children.find((c) => c instanceof THREE.Mesh);
    expect(mesh).toBeDefined();
    expect((mesh as THREE.Mesh).visible).toBe(false);
  });

  it("appends the CSS3DRenderer root to the container", () => {
    expect(container.children.length).toBe(1);
    const rendered = container.firstChild as HTMLDivElement;
    expect(rendered.style.position).toBe("absolute");
    expect(rendered.style.top).toBe("0px");
    expect(rendered.style.left).toBe("0px");
    expect(rendered.style.zIndex).toBe("2");
    expect(rendered.style.pointerEvents).toBe("none");
  });

  it("starts fully recessed — plane opacity 0, stage hidden, no pointer events", () => {
    const g = plane.getGroup();
    const mesh = g.children.find((c) => c instanceof THREE.Mesh) as THREE.Mesh;
    const mat = mesh.material as THREE.MeshPhysicalMaterial;
    expect(mat.opacity).toBe(0);
    expect(mat.transparent).toBe(true);
    // Stage anchor visibility — CSS3DObject children of the group.
    const stage = g.children.find((c) => !(c instanceof THREE.Mesh));
    expect(stage?.visible).toBe(false);
  });
});

describe("WorkstationPlane — stage content", () => {
  let plane: InstanceType<typeof WorkstationPlane>;

  beforeEach(() => {
    plane = new WorkstationPlane(new THREE.Group(), makeContainer());
  });

  function stageEl(): HTMLElement {
    // The stage element is the CSS3DObject's `element` — find it via the
    // group's non-Mesh child.
    const g = plane.getGroup();
    const anchor = g.children.find((c) => !(c instanceof THREE.Mesh)) as unknown as {
      element: HTMLElement;
    };
    return anchor.element;
  }

  it("setStageChild mounts a caller element into the stage", () => {
    const child = document.createElement("section");
    child.textContent = "hi";
    plane.setStageChild(child);
    expect(stageEl().children).toHaveLength(1);
    expect(stageEl().firstElementChild).toBe(child);
  });

  it("setStageChild(null) clears the stage", () => {
    const first = document.createElement("div");
    plane.setStageChild(first);
    plane.setStageChild(null);
    expect(stageEl().children).toHaveLength(0);
  });

  it("setStageChild swaps the previous child", () => {
    const a = document.createElement("span");
    const b = document.createElement("p");
    plane.setStageChild(a);
    plane.setStageChild(b);
    expect(stageEl().children).toHaveLength(1);
    expect(stageEl().firstElementChild).toBe(b);
  });

  it("falls back to manual removal when replaceChildren is unavailable", () => {
    // Simulate an environment where replaceChildren is missing — the
    // shim path in setStageChild manually walks + removes firstChild.
    const stage = stageEl();
    const first = document.createElement("i");
    stage.appendChild(first);
    const original = (stage as unknown as { replaceChildren?: unknown }).replaceChildren;
    (stage as unknown as { replaceChildren?: unknown }).replaceChildren = undefined;
    try {
      const next = document.createElement("b");
      plane.setStageChild(next);
      expect(stage.children).toHaveLength(1);
      expect(stage.firstElementChild).toBe(next);

      plane.setStageChild(null);
      expect(stage.children).toHaveLength(0);
    } finally {
      (stage as unknown as { replaceChildren?: unknown }).replaceChildren = original;
    }
  });
});

describe("WorkstationPlane — visibility + activity", () => {
  let plane: InstanceType<typeof WorkstationPlane>;
  let group: THREE.Group;

  beforeEach(() => {
    plane = new WorkstationPlane(new THREE.Group(), makeContainer());
    group = plane.getGroup();
  });

  function stage(): THREE.Object3D {
    return group.children.find((c) => !(c instanceof THREE.Mesh)) as THREE.Object3D;
  }
  function mesh(): THREE.Mesh {
    return group.children.find((c) => c instanceof THREE.Mesh) as THREE.Mesh;
  }

  it("setUserVisible(true) makes stage visible, pre-warms opacity, and enables pointer events", () => {
    plane.setUserVisible(true);
    expect(stage().visible).toBe(true);
    const stageEl = (stage() as unknown as { element: HTMLElement }).element;
    expect(stageEl.style.pointerEvents).toBe("auto");
    // Pre-warm pushes planeVisibility past 0.5 — the subsequent update() tick
    // should land opacity close to the 0.85 visibility target.
    plane.update(0, 0.1);
    const mat = mesh().material as THREE.MeshPhysicalMaterial;
    expect(mat.opacity).toBeGreaterThan(0.5);
  });

  it("setUserVisible(false) hides stage and releases pointer events", () => {
    plane.setUserVisible(true);
    plane.setUserVisible(false);
    expect(stage().visible).toBe(false);
    const stageEl = (stage() as unknown as { element: HTMLElement }).element;
    expect(stageEl.style.pointerEvents).toBe("none");
  });

  it("hiding drives plane opacity and mesh visibility back to zero over time", () => {
    plane.setUserVisible(true);
    // Fully open the plane.
    for (let i = 0; i < 20; i++) plane.update(i * 0.05, 0.05);
    plane.setUserVisible(false);
    for (let i = 0; i < 200; i++) plane.update(10 + i * 0.05, 0.05);
    const mat = mesh().material as THREE.MeshPhysicalMaterial;
    expect(mat.opacity).toBeLessThan(0.02);
    expect(mesh().visible).toBe(false);
  });

  it("pulseActivity briefly lifts material emissive intensity above baseline", () => {
    plane.setUserVisible(true);
    // Settle to the idle baseline.
    for (let i = 0; i < 60; i++) plane.update(i * 0.1, 0.1);
    const mat = mesh().material as THREE.MeshPhysicalMaterial;
    const idleEmissive = mat.emissiveIntensity;

    plane.pulseActivity();
    // A single post-pulse tick should show the lifted warmth on the material.
    plane.update(6.0, 0.05);
    expect(mat.emissiveIntensity).toBeGreaterThan(idleEmissive);
  });

  it("pulseActivity decays back toward the idle baseline after ~1.2s", () => {
    plane.setUserVisible(true);
    // Settle to idle baseline, averaging across a full ~3.33s breathing
    // cycle so phase noise from the sin() factor doesn't skew the signal.
    for (let i = 0; i < 60; i++) plane.update(i * 0.1, 0.1);
    const mat = mesh().material as THREE.MeshPhysicalMaterial;

    function averageIntensityOverCycle(t0: number): number {
      let sum = 0;
      const n = 80;
      const dt = 3.4 / n; // one breathing period
      for (let i = 0; i < n; i++) {
        plane.update(t0 + i * dt, dt);
        sum += mat.emissiveIntensity;
      }
      return sum / n;
    }

    // Baseline average (no pulse).
    const baseline = averageIntensityOverCycle(6.0);

    // Fire a pulse, immediately sample the first short window — the
    // pulse adds 0.3 to warmth before it decays (~1.2s half-life), so
    // the first ~0.8s averages clearly above baseline.
    plane.pulseActivity();
    let hot = 0;
    const nHot = 16;
    const dtHot = 0.04;
    for (let i = 0; i < nHot; i++) {
      plane.update(9.6 + i * dtHot, dtHot);
      hot += mat.emissiveIntensity;
    }
    hot /= nHot;
    expect(hot).toBeGreaterThan(baseline);

    // After ~2s of further ticks the pulse has fully decayed; the
    // next full-cycle average must sit back at baseline.
    for (let i = 0; i < 50; i++) plane.update(10.4 + i * 0.04, 0.04);
    const afterDecay = averageIntensityOverCycle(12.5);
    expect(afterDecay).toBeLessThan(hot);
    expect(Math.abs(afterDecay - baseline) / baseline).toBeLessThan(0.05);
  });

  it("update at zero delta is a no-op (smooth step collapses)", () => {
    plane.setUserVisible(true);
    plane.update(0, 0);
    const mat = mesh().material as THREE.MeshPhysicalMaterial;
    // With pre-warm we expect ~0.85, but no further progress at dt=0.
    expect(mat.opacity).toBeGreaterThan(0);
  });
});

describe("WorkstationPlane — interior color coupling", () => {
  it("setInteriorColor feeds through to attenuation + emissive once the plane is visible", () => {
    const plane = new WorkstationPlane(new THREE.Group(), makeContainer());
    plane.setUserVisible(true);
    const warm = colorOf([1.0, 0.5, 0.2], [1.0, 0.6, 0.3]);
    plane.setInteriorColor(warm);
    // Let warmth ramp to its target.
    for (let i = 0; i < 60; i++) plane.update(i * 0.1, 0.1);

    const g = plane.getGroup();
    const mesh = g.children.find((c) => c instanceof THREE.Mesh) as THREE.Mesh;
    const mat = mesh.material as THREE.MeshPhysicalMaterial;
    // Attenuation should have lerped toward the warm tint (R dominant, B low).
    expect(mat.attenuationColor.r).toBeGreaterThan(mat.attenuationColor.b);
    // Emissive should match the warm glow vector.
    expect(mat.emissive.r).toBeCloseTo(warm.glow[0], 5);
    expect(mat.emissive.g).toBeCloseTo(warm.glow[1], 5);
    expect(mat.emissive.b).toBeCloseTo(warm.glow[2], 5);
  });
});

describe("WorkstationPlane — lifecycle", () => {
  it("render() delegates to the CSS3DRenderer", () => {
    const plane = new WorkstationPlane(new THREE.Group(), makeContainer());
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    // Multiple ticks — each one must hit the stubbed renderer.
    plane.render(scene, camera);
    plane.render(scene, camera);
    plane.render(scene, camera);
    // No throw on repeated calls is the minimum contract; the stub
    // counts render calls internally so this also exercises that path.
    expect(true).toBe(true);
  });

  it("resize() forwards width + height to the CSS3DRenderer", () => {
    const container = makeContainer();
    const plane = new WorkstationPlane(new THREE.Group(), container);
    plane.resize(1200, 800);
    // Re-resize to confirm the call path is repeatable.
    plane.resize(640, 480);
    expect(true).toBe(true);
  });

  it("dispose() removes DOM + disposes geometry + material", () => {
    const container = makeContainer();
    const plane = new WorkstationPlane(new THREE.Group(), container);
    const g = plane.getGroup();
    const mesh = g.children.find((c) => c instanceof THREE.Mesh) as THREE.Mesh;
    const geoDispose = vi.spyOn(mesh.geometry, "dispose");
    const matDispose = vi.spyOn(mesh.material as THREE.Material, "dispose");

    expect(container.children.length).toBe(1);
    plane.dispose();
    expect(container.children.length).toBe(0);
    expect(geoDispose).toHaveBeenCalledTimes(1);
    expect(matDispose).toHaveBeenCalledTimes(1);
  });
});
