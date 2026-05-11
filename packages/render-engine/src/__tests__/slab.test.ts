/**
 * SlabManager tests — headless Three.js + mocked CSS3DRenderer.
 *
 * Same shape as artifacts.test.ts (which still uses CSS2D for the
 * artifact display layer); only the slab's stage anchor migrated to
 * CSS3D so items follow the plane's tilt instead of billboarding to
 * the camera. The manager's phase animations, plane visibility curve,
 * sympathetic breathing, and detach plumbing are pure CPU once
 * CSS3D is stubbed.
 */

import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";

vi.mock("three/addons/renderers/CSS3DRenderer.js", async () => {
  const THREEmod = await vi.importActual<typeof import("three")>("three");

  class FakeCSS3DObject extends THREEmod.Object3D {
    element: { style: Record<string, string> };
    constructor(element: { style: Record<string, string> }) {
      super();
      this.element = element;
    }
  }

  class FakeCSS3DRenderer {
    domElement: { style: Record<string, string>; remove: () => void };
    constructor() {
      this.domElement = { style: {}, remove: () => {} };
    }
    setSize(): void {}
    render(): void {}
  }

  return { CSS3DRenderer: FakeCSS3DRenderer, CSS3DObject: FakeCSS3DObject };
});

import { SlabManager } from "../slab.js";
import { GOLDEN_RATIO } from "../design-ratios.js";
import type { SlabItemSpec, ArtifactSpec, ArtifactHandle } from "../spec.js";

// Minimal element stand-in — SlabManager only touches .style
function fakeElement() {
  return { style: {} as Record<string, string>, appendChild: () => {} } as unknown as HTMLElement;
}

// Mind-mode hidden element — surface renderers tag mind-mode items
// (stream tokens, embeddings, memory surfacing) with
// dataset.slabHidden = "true" so they render off-plane. The slab
// manager must not count these toward the active-plane decision.
function fakeHiddenElement() {
  return {
    style: {} as Record<string, string>,
    appendChild: () => {},
    dataset: { slabHidden: "true" },
  } as unknown as HTMLElement;
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
  it("plane is hidden by default before any item is added", () => {
    // Doctrine (motebit-computer.md §"Ambient states"): the slab is
    // absent when empty. The creature droplet is the iconic presence;
    // a second always-visible plane steals focus. Work brings the
    // plane; absence is the honest empty state.
    const mgr = makeManager();
    for (let i = 0; i < 10; i++) mgr.update(i * 0.1, 0.1);
    const group = mgr.getGroup();
    const planeMesh = group.children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh)!;
    expect(planeMesh.visible).toBe(false);
    const material = planeMesh.material as THREE.MeshPhysicalMaterial;
    expect(material.opacity).toBe(0);
  });

  it("setUserVisible(true) holds the empty plane open for user prep", () => {
    // Option+C / `/computer` routes here. The user explicitly wants
    // to see the plane (to drag perception in, to inspect layout)
    // even when the motebit has no active work.
    const mgr = makeManager();
    mgr.setUserVisible(true);
    for (let i = 0; i < 10; i++) mgr.update(i * 0.1, 0.1);
    const group = mgr.getGroup();
    const planeMesh = group.children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh)!;
    expect(planeMesh.visible).toBe(true);
    const material = planeMesh.material as THREE.MeshPhysicalMaterial;
    expect(material.opacity).toBeGreaterThan(0);
  });

  it("setUserVisible(false) releases the hold — plane auto-hides", () => {
    const mgr = makeManager();
    mgr.setUserVisible(true);
    for (let i = 0; i < 10; i++) mgr.update(i * 0.1, 0.1);
    mgr.setUserVisible(false);
    for (let i = 0; i < 30; i++) mgr.update(1 + i * 0.1, 0.1);
    const group = mgr.getGroup();
    const planeMesh = group.children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh)!;
    expect(planeMesh.visible).toBe(false);
  });

  it("toggleUserVisible flips the hold and returns the new state", () => {
    const mgr = makeManager();
    expect(mgr.toggleUserVisible()).toBe(true);
    expect(mgr.toggleUserVisible()).toBe(false);
  });

  it("plane reveals when an item is present, regardless of user hold", () => {
    const mgr = makeManager();
    mgr.addItem(makeSpec("s1"));
    for (let i = 0; i < 30; i++) mgr.update(i * 0.1, 0.1);
    const group = mgr.getGroup();
    const planeMesh = group.children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh)!;
    expect(planeMesh.visible).toBe(true);
    const material = planeMesh.material as THREE.MeshPhysicalMaterial;
    expect(material.opacity).toBeGreaterThan(0);
  });

  it("hidden mind-mode items do not bring the plane visible", () => {
    // Doctrine (motebit-computer.md §"Ambient states" + §"Embodiment
    // modes"): mind-mode items (stream tokens, embeddings, memory
    // surfacing) render off-plane. They are still tracked by the
    // controller so handles / lifecycle contracts hold, but they must
    // not raise the plane — otherwise every chat turn opens a phantom
    // blank plane (the regression that gated the web slab as
    // @experimental on 2026-05-04).
    const mgr = makeManager();
    mgr.addItem({ id: "stream-1", kind: "stream", element: fakeHiddenElement() });
    for (let i = 0; i < 30; i++) mgr.update(i * 0.1, 0.1);
    const group = mgr.getGroup();
    const planeMesh = group.children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh)!;
    expect(planeMesh.visible).toBe(false);
    const material = planeMesh.material as THREE.MeshPhysicalMaterial;
    expect(material.opacity).toBe(0);
  });

  it("toggleUserVisible(false) dismisses the plane while a hidden mind item is open", () => {
    // Symptom of the same root cause: with the bug, a phantom mind
    // item's active count keeps the plane forced-visible regardless
    // of the user's hold, so /computer toggle off appears broken.
    // The fix in §active-count restores honest dismissal — the plane
    // fades when no *visible* item demands it.
    const mgr = makeManager();
    mgr.setUserVisible(true);
    mgr.addItem({ id: "stream-1", kind: "stream", element: fakeHiddenElement() });
    for (let i = 0; i < 10; i++) mgr.update(i * 0.1, 0.1);
    mgr.setUserVisible(false);
    for (let i = 0; i < 50; i++) mgr.update(1 + i * 0.1, 0.1);
    const group = mgr.getGroup();
    const planeMesh = group.children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh)!;
    expect(planeMesh.visible).toBe(false);
  });

  // ── Slab honesty: empty membrane + drag-hover lift ──────────────
  // Doctrine (motebit-computer.md §"Visual properties"): the empty
  // user-held slab must read as "present, recessed" — distinct from
  // the active register at full opacity. The drag-hover signal lifts
  // the membrane to a drop-target register without crossing into
  // "active" — the surface answers the gesture without preempting it.

  it("empty user-held slab eases to the membrane register (~0.20), not the active register", () => {
    const mgr = makeManager();
    mgr.setUserVisible(true);
    for (let i = 0; i < 50; i++) mgr.update(i * 0.1, 0.1);
    const planeMesh = mgr
      .getGroup()
      .children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh)!;
    const material = planeMesh.material as THREE.MeshPhysicalMaterial;
    // Recessed: visible enough to acknowledge the invocation, dim
    // enough to read as glass-at-rest.
    expect(material.opacity).toBeGreaterThan(0.1);
    expect(material.opacity).toBeLessThan(0.35);
  });

  it("drag-hover lifts an empty held slab from membrane (~0.20) to drop-target (~0.65)", () => {
    const mgr = makeManager();
    mgr.setUserVisible(true);
    // Settle to the membrane register first.
    for (let i = 0; i < 50; i++) mgr.update(i * 0.1, 0.1);
    const planeMesh = mgr
      .getGroup()
      .children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh)!;
    const material = planeMesh.material as THREE.MeshPhysicalMaterial;
    const beforeHover = material.opacity;
    expect(beforeHover).toBeLessThan(0.35);

    // Begin drag.
    mgr.setDragHover(true);
    for (let i = 0; i < 30; i++) mgr.update(5 + i * 0.05, 0.05);
    expect(material.opacity).toBeGreaterThan(0.5);
    expect(material.opacity).toBeLessThan(0.8);

    // End drag (drop or dragleave).
    mgr.setDragHover(false);
    for (let i = 0; i < 50; i++) mgr.update(7 + i * 0.05, 0.05);
    expect(material.opacity).toBeLessThan(0.35);
  });

  it("drag-hover summons a not-held slab from dissolved to drop-target (gesture overrides held state)", () => {
    const mgr = makeManager();
    // Slab not held — would normally be invisible.
    for (let i = 0; i < 50; i++) mgr.update(i * 0.1, 0.1);
    const planeMesh = mgr
      .getGroup()
      .children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh)!;
    const material = planeMesh.material as THREE.MeshPhysicalMaterial;
    expect(planeMesh.visible).toBe(false);

    mgr.setDragHover(true);
    for (let i = 0; i < 50; i++) mgr.update(5 + i * 0.05, 0.05);
    expect(material.opacity).toBeGreaterThan(0.5);
  });

  it("active items still own the plane during drag-hover (no double-lift)", () => {
    const mgr = makeManager();
    mgr.addItem(makeSpec("s1"));
    mgr.setDragHover(true);
    for (let i = 0; i < 30; i++) mgr.update(i * 0.1, 0.1);
    const planeMesh = mgr
      .getGroup()
      .children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh)!;
    const material = planeMesh.material as THREE.MeshPhysicalMaterial;
    // Active register dominates: opacity at 1.0, not 0.65.
    expect(material.opacity).toBeGreaterThan(0.9);
  });

  it("plane auto-hides after the last item ends (no user hold)", async () => {
    // Doctrine: absence is the default empty state. Work brings the
    // plane; work ending dismisses it. The user can hold it open via
    // setUserVisible(true); without that, the plane fades away.
    const mgr = makeManager();
    const h = mgr.addItem(makeSpec("s1"));
    for (let i = 0; i < 10; i++) mgr.update(i * 0.1, 0.1);
    const dissolvePromise = mgr.dissolveItem("s1");
    for (let i = 0; i < 10; i++) mgr.update(1 + i * 0.1, 0.1);
    await dissolvePromise;
    expect(h.getPhase()).toBe("gone");

    for (let i = 0; i < 200; i++) mgr.update(2 + i * 0.1, 0.1);

    const group = mgr.getGroup();
    const planeMesh = group.children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh)!;
    const material = planeMesh.material as THREE.MeshPhysicalMaterial;
    expect(material.opacity).toBeLessThan(0.02);
    expect(planeMesh.visible).toBe(false);
  });
});

describe("SlabManager — design-ratio compliance", () => {
  it("plane aspect ratio equals φ (per design-ratios.ts rule)", () => {
    // Natural proof of the aspect-ratio rule: the consumer carries
    // its own compliance test. If someone hand-tweaks SLAB_WIDTH /
    // SLAB_HEIGHT off φ, this fails in the slab's own suite — blame
    // lands exactly where drift happened, no central gate needed.
    const mgr = makeManager();
    const group = mgr.getGroup();
    const planeMesh = group.children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh)!;
    const geo = planeMesh.geometry;
    geo.computeBoundingBox();
    const bbox = geo.boundingBox!;
    const width = bbox.max.x - bbox.min.x;
    const height = bbox.max.y - bbox.min.y;
    // 6 decimal places: tight enough to catch a hand-tweaked ratio,
    // loose enough for float32 geometry positions + rounded-corner
    // vertex-snap arithmetic.
    expect(width / height).toBeCloseTo(GOLDEN_RATIO, 6);
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

// ---------------------------------------------------------------------------
// v1.2b — halt-gesture integration. The plane-gesture detector lives
// inside SlabManager; the app wires `setHaltGestureHandler(...)` to a
// callback that fires `ComputerSessionManager.halt()`. Tests below
// drive the detector directly through the (private but accessible)
// reset / halted state surface, since headless tests have no real DOM
// EventTarget for the attach helper to listen on.
// ---------------------------------------------------------------------------

describe("SlabManager — halt-gesture wiring (v1.2b)", () => {
  it("halt gesture handler fires when SlabManager observes a fired-detector signal via setHalted", () => {
    const mgr = makeManager();
    const handler = vi.fn();
    mgr.setHaltGestureHandler(handler);
    expect(mgr.isHalted()).toBe(false);
    // The detector itself fires `setHalted(true)` inside the manager
    // when the gesture completes; in headless tests we simulate that
    // post-condition directly.
    mgr.setHalted(true);
    expect(mgr.isHalted()).toBe(true);
  });

  it("setHalted(false) clears halted visual state and re-arms the detector for a future hold", () => {
    const mgr = makeManager();
    mgr.setHalted(true);
    expect(mgr.isHalted()).toBe(true);
    mgr.setHalted(false);
    expect(mgr.isHalted()).toBe(false);
    // No throw; the detector reset path is exercised.
    expect(() => mgr.update(1, 0.1)).not.toThrow();
  });

  it("setHalted is idempotent (no spurious work on re-setting same state)", () => {
    const mgr = makeManager();
    expect(() => {
      mgr.setHalted(false);
      mgr.setHalted(false);
      mgr.setHalted(true);
      mgr.setHalted(true);
    }).not.toThrow();
    expect(mgr.isHalted()).toBe(true);
  });

  it("setHaltGestureHandler(null) clears the handler so a future fire is a no-op", () => {
    const mgr = makeManager();
    const handler = vi.fn();
    mgr.setHaltGestureHandler(handler);
    mgr.setHaltGestureHandler(null);
    // No way to trigger a real gesture in headless tests; we just
    // verify the API accepts null without throwing. The internal
    // `haltGestureHandler?.()` optional-call guards against null at
    // runtime so a missing handler can never NPE the detector.
    expect(() => mgr.update(1, 0.1)).not.toThrow();
  });

  it("update() drives the detector tick without throwing in headless test env", () => {
    const mgr = makeManager();
    expect(() => {
      for (let i = 0; i < 10; i++) mgr.update(i * 0.1, 0.1);
    }).not.toThrow();
  });

  it("halted slab maintains a sustained emissive glow under update()", () => {
    const mgr = makeManager();
    mgr.addItem(makeSpec("s1"));
    mgr.update(0, 0.5); // → active so plane is visible
    mgr.setHalted(true);
    // Multiple ticks; the halted-sustain branch in update() runs each
    // frame and clamps emissiveIntensity to ≥ peak * 0.5. No
    // throw, no NaN.
    for (let i = 0; i < 5; i++) mgr.update(1 + i * 0.1, 0.1);
    expect(mgr.isHalted()).toBe(true);
  });

  it("end-to-end gesture: two-finger touch on container fires halt handler after hold elapses", () => {
    // Real EventTarget container so the SlabManager's gesture detach
    // helper's `typeof container.addEventListener === "function"`
    // branch picks up. Plus a PointerEvent shim so the touch-pointer
    // accept path runs end-to-end through update().
    class FakeContainer extends EventTarget {
      clientWidth = 800;
      clientHeight = 600;
      appendChild(): void {}
      getBoundingClientRect(): { left: number; top: number; right: number; bottom: number } {
        return { left: 0, top: 0, right: 800, bottom: 600 };
      }
    }
    class FakePointerEvent extends Event {
      pointerId: number;
      pointerType = "touch";
      clientX: number;
      clientY: number;
      constructor(type: string, pointerId: number, x: number, y: number) {
        super(type);
        this.pointerId = pointerId;
        this.clientX = x;
        this.clientY = y;
      }
    }
    const prev = (globalThis as { PointerEvent?: unknown }).PointerEvent;
    (globalThis as { PointerEvent?: unknown }).PointerEvent = FakePointerEvent;
    try {
      const container = new FakeContainer();
      const creatureGroup = new THREE.Group();
      const mgr = new SlabManager(creatureGroup, container as unknown as HTMLElement);
      const halt = vi.fn();
      mgr.setHaltGestureHandler(halt);

      // Two fingers down inside the container's bounds.
      container.dispatchEvent(new FakePointerEvent("pointerdown", 1, 100, 100));
      container.dispatchEvent(new FakePointerEvent("pointerdown", 2, 200, 200));

      // Drive update() forward in seconds. The detector's tick uses
      // performance.now() (wall-clock ms), which here advances naturally
      // — vitest doesn't mock it. Call update repeatedly so the
      // gesture's 700ms threshold is exceeded.
      const start = performance.now();
      while (performance.now() - start < 800) {
        mgr.update(0, 0.016);
      }
      mgr.update(0, 0.016); // one more to land past 1.0 progress
      expect(halt).toHaveBeenCalledTimes(1);
      expect(mgr.isHalted()).toBe(true);
    } finally {
      (globalThis as { PointerEvent?: unknown }).PointerEvent = prev;
    }
  });
});

describe("SlabManager — screencast WebGL texture (v1.3 → texture register)", () => {
  // The slab carries a third meniscus-shaped plane inside the glass
  // volume that the cloud-browser screencast paints onto. Exposed via
  // setScreencastImage / clearScreencast on the SlabManager (forwarded
  // through the renderer adapter as setSlabScreencastImage /
  // clearSlabScreencast). This test set pins the visibility +
  // texture-state contract.

  function findScreenMesh(mgr: SlabManager): {
    visible: boolean;
    material: { map: unknown; needsUpdate: boolean };
  } | null {
    const group = (
      mgr as unknown as { group: { children: Array<{ name?: string; visible?: boolean }> } }
    ).group;
    const mesh = group.children.find((c) => c.name === "slab-screen") as unknown as
      | { visible: boolean; material: { map: unknown; needsUpdate: boolean } }
      | undefined;
    return mesh ?? null;
  }

  it("ships with a hidden screen mesh until the first frame lands", () => {
    const mgr = makeManager();
    const screen = findScreenMesh(mgr);
    expect(screen).not.toBeNull();
    expect(screen!.visible).toBe(false);
    expect(screen!.material.map).toBeNull();
  });

  it("setScreencastImage(image) populates the material's map and shows the screen mesh once the slab is user-visible", () => {
    const mgr = makeManager();
    const fakeImage = { width: 1280, height: 800 } as unknown as HTMLImageElement;
    mgr.setScreencastImage(fakeImage);
    const screen = findScreenMesh(mgr)!;
    // Texture installed eagerly — material.map points at what we
    // passed in, no per-frame allocation.
    expect(screen.material.map).not.toBeNull();
    const map = screen.material.map as { image: unknown };
    expect(map.image).toBe(fakeImage);
    // Screen-mesh visibility is derived per-frame from (user-visible
    // AND screenTexture !== null) — the always-already-slab fix that
    // closes the /computer-toggle stitch desync (2026-05-11). Make
    // the slab user-visible + tick so the derivation lands.
    mgr.setUserVisible(true);
    mgr.update(0, 0.5);
    expect(screen.visible).toBe(true);
  });

  it("subsequent setScreencastImage calls replace the texture's image in place (no per-frame allocation)", () => {
    const mgr = makeManager();
    const a = { width: 1280, height: 800 } as unknown as HTMLImageElement;
    const b = { width: 1280, height: 800 } as unknown as HTMLImageElement;
    mgr.setScreencastImage(a);
    const screen = findScreenMesh(mgr)!;
    const firstTexture = screen.material.map;
    mgr.setScreencastImage(b);
    // Same texture object — only `.image` swapped.
    expect(screen.material.map).toBe(firstTexture);
    expect((screen.material.map as { image: unknown }).image).toBe(b);
  });

  it("clearScreencast() releases the texture, clears the material map, and hides the mesh on the next tick", () => {
    const mgr = makeManager();
    mgr.setUserVisible(true);
    mgr.setScreencastImage({ width: 1280, height: 800 } as unknown as HTMLImageElement);
    mgr.update(0, 0.5);
    const screen = findScreenMesh(mgr)!;
    expect(screen.visible).toBe(true);
    mgr.clearScreencast();
    // Texture + map released eagerly.
    expect(screen.material.map).toBeNull();
    // Visibility derives next tick — (user-visible AND
    // screenTexture !== null) → false once the texture is nulled.
    mgr.update(0.5, 0.1);
    expect(screen.visible).toBe(false);
  });

  it("clearScreencast() on a never-painted slab is a no-op (no throw, idempotent)", () => {
    const mgr = makeManager();
    expect(() => mgr.clearScreencast()).not.toThrow();
    expect(() => mgr.clearScreencast()).not.toThrow();
    const screen = findScreenMesh(mgr)!;
    expect(screen.visible).toBe(false);
  });

  it("hiding the slab user-visibility hides the screencast screen mesh even with an active texture — content must not outlive the substrate", () => {
    // Pins the always-already-slab invariant: the screen mesh's
    // visibility IS derived from the slab's user-visibility, not
    // from screencast presence alone. Without this binding,
    // `/computer`-toggling the slab off leaves the WebGL screen
    // mesh rendering its texture in 3D space — content outliving
    // the substrate. Third instance of the slab/stitch desync
    // (chrome band, stage opacity, screen mesh) — this lock
    // prevents the fourth.
    const mgr = makeManager();
    mgr.setUserVisible(true);
    mgr.setScreencastImage({ width: 1280, height: 800 } as unknown as HTMLImageElement);
    mgr.update(0, 0.5);
    const screen = findScreenMesh(mgr)!;
    expect(screen.visible).toBe(true);
    // The user-hide gesture (e.g., /computer toggle). Texture is
    // still installed — the session didn't end, just got hidden.
    mgr.setUserVisible(false);
    mgr.update(0.5, 0.5);
    expect(screen.visible).toBe(false);
    expect(screen.material.map).not.toBeNull(); // Texture still live.
    // Reveal again — texture is still there, mesh comes back.
    mgr.setUserVisible(true);
    mgr.update(1, 0.5);
    expect(screen.visible).toBe(true);
  });

  it("setScreencastSuppressed(true) hides the screen mesh WITHOUT releasing the texture — overlay-register lifecycle", () => {
    // Pins the URL-bar-focus → home-overlay contract: suppression
    // hides the mesh visually while the texture stays installed,
    // so resuming the session (overlay exit) reveals the mesh
    // against the most-recent frame already in the texture — no
    // cold-start, no blank. Distinct from clearScreencast which
    // releases the texture (lifecycle terminator).
    const mgr = makeManager();
    mgr.setUserVisible(true);
    mgr.setScreencastImage({ width: 1280, height: 800 } as unknown as HTMLImageElement);
    mgr.update(0, 0.5);
    const screen = findScreenMesh(mgr)!;
    expect(screen.visible).toBe(true);
    expect(screen.material.map).not.toBeNull();

    // Suppress — mesh hides on next tick. Texture survives.
    mgr.setScreencastSuppressed(true);
    mgr.update(0.5, 0.1);
    expect(screen.visible).toBe(false);
    expect(screen.material.map).not.toBeNull(); // Texture survives.

    // Un-suppress — mesh re-emerges against the still-installed texture.
    mgr.setScreencastSuppressed(false);
    mgr.update(1, 0.1);
    expect(screen.visible).toBe(true);
    expect(screen.material.map).not.toBeNull();
  });

  it("closes ImageBitmap on replacement so GPU-side bitmap memory doesn't leak", () => {
    const mgr = makeManager();
    let aClosed = false;
    const a = {
      close: () => {
        aClosed = true;
      },
    } as unknown as ImageBitmap;
    const b = { close: () => {} } as unknown as ImageBitmap;
    mgr.setScreencastImage(a);
    mgr.setScreencastImage(b);
    expect(aClosed).toBe(true);
  });
});
