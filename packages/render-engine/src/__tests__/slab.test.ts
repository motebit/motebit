/**
 * SlabManager tests — headless Three.js + mocked CSS2DRenderer.
 *
 * Mirrors artifacts.test.ts — same CSS2DRenderer fake, same minimal
 * HTMLElement stand-in. The manager's phase animations, plane
 * visibility curve, sympathetic breathing, and detach plumbing are
 * pure CPU once CSS2D is stubbed.
 */

import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";

vi.mock("three/addons/renderers/CSS2DRenderer.js", async () => {
  const THREEmod = await vi.importActual<typeof import("three")>("three");

  class FakeCSS2DObject extends THREEmod.Object3D {
    element: { style: Record<string, string> };
    constructor(element: { style: Record<string, string> }) {
      super();
      this.element = element;
    }
  }

  class FakeCSS2DRenderer {
    domElement: { style: Record<string, string>; remove: () => void };
    constructor() {
      this.domElement = { style: {}, remove: () => {} };
    }
    setSize(): void {}
    render(): void {}
  }

  return { CSS2DRenderer: FakeCSS2DRenderer, CSS2DObject: FakeCSS2DObject };
});

import { SlabManager } from "../slab.js";
import type { SlabItemSpec, ArtifactSpec, ArtifactHandle } from "../spec.js";

// Minimal element stand-in — SlabManager only touches .style
function fakeElement() {
  return { style: {} as Record<string, string>, appendChild: () => {} } as unknown as HTMLElement;
}

function fakeContainer(): HTMLElement {
  return {
    appendChild: () => {},
    clientWidth: 800,
    clientHeight: 600,
  } as unknown as HTMLElement;
}

function makeManager(opts?: { detachHandler?: (s: ArtifactSpec) => ArtifactHandle | undefined }) {
  const creatureGroup = new THREE.Group();
  const container = fakeContainer();
  return new SlabManager(creatureGroup, container, opts);
}

function makeSpec(id: string, kind: SlabItemSpec["kind"] = "stream"): SlabItemSpec {
  return { id, kind, element: fakeElement() };
}

// === Tests ===

describe("SlabManager — item lifecycle", () => {
  it("addItem starts an item in emerging phase", () => {
    const mgr = makeManager();
    const handle = mgr.addItem(makeSpec("s1"));
    expect(handle.getPhase()).toBe("emerging");
  });

  it("emerging → active after the emerge duration (0.4s default)", () => {
    const mgr = makeManager();
    const handle = mgr.addItem(makeSpec("s1"));
    mgr.update(0, 0.5); // past emerge duration
    expect(handle.getPhase()).toBe("active");
  });

  it("active items stay active under repeated updates", () => {
    const mgr = makeManager();
    const handle = mgr.addItem(makeSpec("s1"));
    mgr.update(0, 0.5);
    for (let i = 0; i < 10; i++) mgr.update(i * 0.1, 0.1);
    expect(handle.getPhase()).toBe("active");
  });

  it("dissolveItem transitions active → dissolving → gone", async () => {
    const mgr = makeManager();
    const handle = mgr.addItem(makeSpec("s1"));
    mgr.update(0, 0.5); // → active
    const done = mgr.dissolveItem("s1");
    expect(handle.getPhase()).toBe("dissolving");
    // Advance past dissolve duration (0.3s) BEFORE awaiting so the
    // in-animation resolve fires first.
    mgr.update(1, 0.35);
    await done;
    expect(handle.getPhase()).toBe("gone");
  });

  it("detachItemAsArtifact runs pinch, hands off via detachHandler, returns the artifact handle", async () => {
    const fakeArtifactHandle: ArtifactHandle = {
      id: "art-1",
      setAngle: () => {},
      dismiss: () => Promise.resolve(),
    };
    const detachHandler = vi.fn(() => fakeArtifactHandle);
    const mgr = makeManager({ detachHandler });
    const handle = mgr.addItem(makeSpec("s1", "tool_call"));
    mgr.update(0, 0.5); // → active

    const artifactSpec: ArtifactSpec = {
      id: "art-1",
      kind: "code",
      element: fakeElement(),
    };
    const detachPromise = mgr.detachItemAsArtifact("s1", artifactSpec);
    expect(handle.getPhase()).toBe("pinching");

    // Advance past the pinch-midpoint (0.8s / 2 = 0.4s) so the handler fires
    mgr.update(1, 0.45);
    expect(detachHandler).toHaveBeenCalledWith(artifactSpec);
    // Advance past the full pinch so phase becomes detached
    mgr.update(2, 0.5);
    expect(handle.getPhase()).toBe("detached");
    // One more update past the 0.05s detached tail to transition to gone
    mgr.update(3, 0.1);

    const result = await detachPromise;
    expect(result).toBe(fakeArtifactHandle);
    expect(handle.getPhase()).toBe("gone");
  });

  it("works without a detachHandler (headless fallback)", async () => {
    const mgr = makeManager(); // no detachHandler
    const handle = mgr.addItem(makeSpec("s1", "tool_call"));
    mgr.update(0, 0.5);
    const artifactSpec: ArtifactSpec = { id: "a1", kind: "text", element: fakeElement() };
    const detachPromise = mgr.detachItemAsArtifact("s1", artifactSpec);
    mgr.update(1, 0.45);
    mgr.update(2, 0.5); // → detached
    mgr.update(3, 0.1); // → gone
    const result = await detachPromise;
    // Headless: no handler to produce a handle, resolves to undefined
    expect(result).toBeUndefined();
    expect(handle.getPhase()).toBe("gone");
  });

  it("clearItems removes every mounted item immediately", () => {
    const mgr = makeManager();
    mgr.addItem(makeSpec("a"));
    mgr.addItem(makeSpec("b"));
    mgr.clearItems();
    // Updates on a cleared manager do not throw + do not revive items
    mgr.update(0, 0.1);
    // Readding a previously-cleared id succeeds (no leftover state)
    const again = mgr.addItem(makeSpec("a"));
    expect(again.getPhase()).toBe("emerging");
  });
});

describe("SlabManager — plane visibility + ambient", () => {
  it("plane is visible at its idle baseline before any item is added", () => {
    // Under the workstation frame the plane is an always-on display:
    // the user expects the screen to be present, with items appearing
    // on it. The earlier "hidden until first item" behavior was a
    // holdover from the emergence-as-droplet-pop doctrine, now
    // replaced by the supervised-agency workstation framing.
    const mgr = makeManager();
    // Run enough frames for the idle visibility to settle in.
    for (let i = 0; i < 10; i++) mgr.update(i * 0.1, 0.1);
    const group = mgr.getGroup();
    const planeMesh = group.children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh)!;
    expect(planeMesh.visible).toBe(true);
    const material = planeMesh.material as THREE.MeshPhysicalMaterial;
    expect(material.opacity).toBeGreaterThan(0);
  });

  it("setUserVisible(false) hides the plane regardless of ambient state", () => {
    const mgr = makeManager();
    for (let i = 0; i < 10; i++) mgr.update(i * 0.1, 0.1);
    mgr.setUserVisible(false);
    mgr.update(2, 0.1);
    const group = mgr.getGroup();
    const planeMesh = group.children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh)!;
    expect(planeMesh.visible).toBe(false);
    const material = planeMesh.material as THREE.MeshPhysicalMaterial;
    expect(material.opacity).toBe(0);
  });

  it("setUserVisible(true) restores the plane without waiting for new items", () => {
    const mgr = makeManager();
    mgr.setUserVisible(false);
    mgr.update(0, 0.1);
    mgr.setUserVisible(true);
    mgr.update(0.2, 0.1);
    const group = mgr.getGroup();
    const planeMesh = group.children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh)!;
    expect(planeMesh.visible).toBe(true);
  });

  it("plane reveals when an item is present", () => {
    const mgr = makeManager();
    mgr.addItem(makeSpec("s1"));
    // Several frames to ramp the plane's visibility curve up
    for (let i = 0; i < 30; i++) mgr.update(i * 0.1, 0.1);
    const group = mgr.getGroup();
    const planeMesh = group.children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh)!;
    expect(planeMesh.visible).toBe(true);
    const material = planeMesh.material as THREE.MeshPhysicalMaterial;
    expect(material.opacity).toBeGreaterThan(0);
  });

  it("plane holds its idle baseline after prolonged idleness — no auto-recession", async () => {
    // Under the always-on workstation frame, the display stays
    // visible indefinitely when no items are present. Only the user
    // toggle (setUserVisible) can hide it; auto-recession was
    // dropped when the slab stopped being an acts-only transient
    // surface and became a persistent workstation display.
    const mgr = makeManager();
    const h = mgr.addItem(makeSpec("s1"));
    for (let i = 0; i < 10; i++) mgr.update(i * 0.1, 0.1);
    const dissolvePromise = mgr.dissolveItem("s1");
    for (let i = 0; i < 10; i++) mgr.update(1 + i * 0.1, 0.1);
    await dissolvePromise;
    expect(h.getPhase()).toBe("gone");

    // Advance well past what used to be the recession window.
    for (let i = 0; i < 200; i++) mgr.update(2 + i * 0.1, 0.1);

    const group = mgr.getGroup();
    const planeMesh = group.children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh)!;
    const material = planeMesh.material as THREE.MeshPhysicalMaterial;
    // Holds the idle baseline (~0.85). Not 1.0 because smoothToward
    // eases but doesn't snap, and the idle target is 0.85.
    expect(material.opacity).toBeGreaterThan(0.7);
    expect(planeMesh.visible).toBe(true);
  });
});

describe("SlabManager — phase change listeners", () => {
  it("onPhaseChange fires on each transition", () => {
    const mgr = makeManager();
    const handle = mgr.addItem(makeSpec("s1"));
    const seen: string[] = [];
    const unsubscribe = handle.onPhaseChange((p) => seen.push(p));
    mgr.update(0, 0.5); // emerging → active
    void mgr.dissolveItem("s1"); // active → dissolving
    mgr.update(1, 0.35); // dissolving → gone
    expect(seen).toEqual(["active", "dissolving", "gone"]);
    unsubscribe();
  });

  it("listener exception does not break manager state", () => {
    const mgr = makeManager();
    const handle = mgr.addItem(makeSpec("s1"));
    handle.onPhaseChange(() => {
      throw new Error("listener bug");
    });
    expect(() => mgr.update(0, 0.5)).not.toThrow();
    expect(handle.getPhase()).toBe("active");
  });
});
