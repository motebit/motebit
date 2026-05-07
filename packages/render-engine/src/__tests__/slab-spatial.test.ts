/**
 * SpatialSlabManager tests — headless. Mirrors the lifecycle/ambient
 * shape of slab.test.ts; assertions read via the manager's own
 * accessors (`getPlaneVisibility`, `getActiveWarmth`) rather than a
 * Three.js mesh, since Phase 1A doesn't ship one. Phase 1B will add
 * mesh-level assertions when the visual landing happens.
 *
 * The state machine ITSELF is covered exhaustively in slab.test.ts —
 * both managers consume the same `SlabCore`, so any divergence in
 * lifecycle would surface there. These tests verify:
 *
 *   - Phase 1A consumes the shared core (lifecycle threads through).
 *   - Held-tablet geometry constants match the spatial-as-endgame
 *     doctrine values + golden-ratio aspect.
 *   - Sympathetic breathing constants are inherited from the core
 *     (re-exported), proving the desktop and spatial slabs are
 *     locked to the same rhythm.
 *   - The group is mounted on the creature group, so the held tablet
 *     inherits the creature's world transform — body-anchored, not
 *     viewport-anchored (spatial-as-endgame.md §"Default companion
 *     shape").
 */

import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";

import {
  SpatialSlabManager,
  SPATIAL_SLAB_OFFSET_X,
  SPATIAL_SLAB_OFFSET_Y,
  SPATIAL_SLAB_OFFSET_Z,
  SPATIAL_SLAB_TILT_X,
  SPATIAL_SLAB_TILT_Y,
  SPATIAL_SLAB_WIDTH,
  SPATIAL_SLAB_HEIGHT,
  SLAB_BREATHE_FREQUENCY_HZ,
  SLAB_BREATHE_AMPLITUDE_FACTOR,
} from "../slab-spatial.js";
import { GOLDEN_RATIO } from "../design-ratios.js";
import {
  SLAB_BREATHE_FREQUENCY_HZ as CORE_BREATHE_FREQUENCY_HZ,
  SLAB_BREATHE_AMPLITUDE_FACTOR as CORE_BREATHE_AMPLITUDE_FACTOR,
} from "../slab-core.js";
import type { SlabItemSpec, ArtifactSpec, ArtifactHandle } from "../spec.js";

function fakeElement() {
  return { style: {} as Record<string, string>, appendChild: () => {} } as unknown as HTMLElement;
}

function fakeHiddenElement() {
  return {
    style: {} as Record<string, string>,
    appendChild: () => {},
    dataset: { slabHidden: "true" },
  } as unknown as HTMLElement;
}

function makeManager(opts?: { detachHandler?: (s: ArtifactSpec) => ArtifactHandle | undefined }) {
  const creatureGroup = new THREE.Group();
  return new SpatialSlabManager(creatureGroup, opts);
}

function makeSpec(id: string, kind: SlabItemSpec["kind"] = "stream"): SlabItemSpec {
  return { id, kind, element: fakeElement() };
}

// === Tests ===

describe("SpatialSlabManager — item lifecycle (consumes shared SlabCore)", () => {
  it("addItem starts in emerging phase", () => {
    const mgr = makeManager();
    const handle = mgr.addItem(makeSpec("s1"));
    expect(handle.getPhase()).toBe("emerging");
  });

  it("emerging → active after the emerge duration", () => {
    const mgr = makeManager();
    const handle = mgr.addItem(makeSpec("s1"));
    mgr.update(0, 0.5);
    expect(handle.getPhase()).toBe("active");
  });

  it("dissolveItem transitions active → dissolving → gone", async () => {
    const mgr = makeManager();
    const handle = mgr.addItem(makeSpec("s1"));
    mgr.update(0, 0.5);
    const done = mgr.dissolveItem("s1");
    expect(handle.getPhase()).toBe("dissolving");
    mgr.update(1, 0.35);
    await done;
    expect(handle.getPhase()).toBe("gone");
  });

  it("detachItemAsArtifact runs pinch, fires handler, returns artifact handle", async () => {
    const fakeArtifactHandle: ArtifactHandle = {
      id: "art-1",
      setAngle: () => {},
      dismiss: () => Promise.resolve(),
    };
    const detachHandler = vi.fn(() => fakeArtifactHandle);
    const mgr = makeManager({ detachHandler });
    const handle = mgr.addItem(makeSpec("s1", "tool_call"));
    mgr.update(0, 0.5);

    const artifactSpec: ArtifactSpec = {
      id: "art-1",
      kind: "code",
      element: fakeElement(),
    };
    const detachPromise = mgr.detachItemAsArtifact("s1", artifactSpec);
    expect(handle.getPhase()).toBe("pinching");

    mgr.update(1, 0.45);
    expect(detachHandler).toHaveBeenCalledWith(artifactSpec);
    mgr.update(2, 0.5);
    expect(handle.getPhase()).toBe("detached");
    mgr.update(3, 0.1);

    const result = await detachPromise;
    expect(result).toBe(fakeArtifactHandle);
    expect(handle.getPhase()).toBe("gone");
  });

  it("detachItemAsArtifact resolves to undefined without a handler (headless fallback)", async () => {
    const mgr = makeManager();
    const handle = mgr.addItem(makeSpec("s1", "tool_call"));
    mgr.update(0, 0.5);
    const artifactSpec: ArtifactSpec = { id: "a1", kind: "text", element: fakeElement() };
    const detachPromise = mgr.detachItemAsArtifact("s1", artifactSpec);
    mgr.update(1, 0.45);
    mgr.update(2, 0.5);
    mgr.update(3, 0.1);
    const result = await detachPromise;
    expect(result).toBeUndefined();
    expect(handle.getPhase()).toBe("gone");
  });

  it("clearItems removes every tracked item without throwing", () => {
    const mgr = makeManager();
    mgr.addItem(makeSpec("a"));
    mgr.addItem(makeSpec("b"));
    mgr.clearItems();
    mgr.update(0, 0.1);
    const again = mgr.addItem(makeSpec("a"));
    expect(again.getPhase()).toBe("emerging");
  });
});

describe("SpatialSlabManager — ambient surface presence", () => {
  it("planeVisibility is 0 by default before any item is added", () => {
    const mgr = makeManager();
    for (let i = 0; i < 10; i++) mgr.update(i * 0.1, 0.1);
    expect(mgr.getPlaneVisibility()).toBe(0);
    expect(mgr.getActiveWarmth()).toBe(0);
  });

  it("setUserVisible(true) holds the empty surface open for user prep", () => {
    // Option+C / `/computer` — the user explicitly wants to see the
    // surface even when the motebit has no active work. Same
    // contract as desktop; here read via the ambient accessor since
    // there is no mesh in Phase 1A.
    const mgr = makeManager();
    mgr.setUserVisible(true);
    for (let i = 0; i < 10; i++) mgr.update(i * 0.1, 0.1);
    expect(mgr.getPlaneVisibility()).toBeGreaterThan(0);
  });

  it("setUserVisible(false) releases the hold — surface auto-recedes", () => {
    const mgr = makeManager();
    mgr.setUserVisible(true);
    for (let i = 0; i < 10; i++) mgr.update(i * 0.1, 0.1);
    mgr.setUserVisible(false);
    for (let i = 0; i < 30; i++) mgr.update(1 + i * 0.1, 0.1);
    expect(mgr.getPlaneVisibility()).toBeLessThan(0.01);
  });

  it("toggleUserVisible flips the hold and returns the new state", () => {
    const mgr = makeManager();
    expect(mgr.toggleUserVisible()).toBe(true);
    expect(mgr.toggleUserVisible()).toBe(false);
  });

  it("an active item raises the surface regardless of user hold", () => {
    const mgr = makeManager();
    mgr.addItem(makeSpec("s1"));
    for (let i = 0; i < 30; i++) mgr.update(i * 0.1, 0.1);
    expect(mgr.getPlaneVisibility()).toBeGreaterThan(0.5);
    expect(mgr.getActiveWarmth()).toBeGreaterThan(0.5);
  });

  it("hidden mind-mode items do not raise the surface", () => {
    // Doctrine (motebit-computer.md §"Ambient states"): mind-mode
    // items render off-surface — they are tracked by the core for
    // lifecycle contracts but must not bring the held tablet up,
    // otherwise every chat turn pulls a phantom blank tablet into
    // the user's view. Same regression class as commit 89467720 on
    // desktop.
    const mgr = makeManager();
    mgr.addItem({ id: "stream-1", kind: "stream", element: fakeHiddenElement() });
    for (let i = 0; i < 30; i++) mgr.update(i * 0.1, 0.1);
    expect(mgr.getPlaneVisibility()).toBe(0);
  });

  it("toggleUserVisible(false) dismisses the surface while a hidden mind item is open", () => {
    // Sibling of the desktop test — the same root cause would
    // surface here if `slabHidden` weren't honored in the shared
    // ambient count. Not a Ring 1 leak today (the count lives in
    // SlabCore), but kept as a regression guard.
    const mgr = makeManager();
    mgr.setUserVisible(true);
    mgr.addItem({ id: "stream-1", kind: "stream", element: fakeHiddenElement() });
    for (let i = 0; i < 10; i++) mgr.update(i * 0.1, 0.1);
    mgr.setUserVisible(false);
    for (let i = 0; i < 50; i++) mgr.update(1 + i * 0.1, 0.1);
    expect(mgr.getPlaneVisibility()).toBeLessThan(0.01);
  });

  it("surface auto-recedes after the last item ends (no user hold)", async () => {
    const mgr = makeManager();
    const h = mgr.addItem(makeSpec("s1"));
    for (let i = 0; i < 10; i++) mgr.update(i * 0.1, 0.1);
    const dissolvePromise = mgr.dissolveItem("s1");
    for (let i = 0; i < 10; i++) mgr.update(1 + i * 0.1, 0.1);
    await dissolvePromise;
    expect(h.getPhase()).toBe("gone");

    for (let i = 0; i < 200; i++) mgr.update(2 + i * 0.1, 0.1);
    expect(mgr.getPlaneVisibility()).toBeLessThan(0.02);
  });
});

describe("SpatialSlabManager — held-tablet geometry", () => {
  it("group is mounted on the creature group at the held-tablet pose", () => {
    // Body-anchored, not viewport-anchored — the held tablet lives
    // on the creature's transform so it inherits drift, sag, gesture.
    const creatureGroup = new THREE.Group();
    const mgr = new SpatialSlabManager(creatureGroup);
    const slabGroup = mgr.getGroup();

    expect(slabGroup.parent).toBe(creatureGroup);
    expect(slabGroup.position.x).toBeCloseTo(SPATIAL_SLAB_OFFSET_X, 6);
    expect(slabGroup.position.y).toBeCloseTo(SPATIAL_SLAB_OFFSET_Y, 6);
    expect(slabGroup.position.z).toBeCloseTo(SPATIAL_SLAB_OFFSET_Z, 6);
    expect(slabGroup.rotation.x).toBeCloseTo(SPATIAL_SLAB_TILT_X, 6);
    expect(slabGroup.rotation.y).toBeCloseTo(SPATIAL_SLAB_TILT_Y, 6);
  });

  it("held-tablet aspect ratio equals φ (per design-ratios.ts rule)", () => {
    // Same body-adjacent display rule as the desktop slab; carry the
    // compliance test in the spatial primitive's own suite so a
    // hand-tweaked SPATIAL_SLAB_WIDTH or SPATIAL_SLAB_HEIGHT fails
    // here, blame lands locally, no central gate needed.
    expect(SPATIAL_SLAB_WIDTH / SPATIAL_SLAB_HEIGHT).toBeCloseTo(GOLDEN_RATIO, 6);
  });
});

describe("SpatialSlabManager — sympathetic breathing inheritance", () => {
  it("re-exports the breathing constants from the shared core", () => {
    // Doctrine: liquescentia-as-substrate.md §V.2. Both renderers
    // breathe at the same Rayleigh-derived frequency and the same
    // 30%-creature amplitude factor — one body, one rhythm. Re-
    // exporting from the spatial module is the typed proof.
    expect(SLAB_BREATHE_FREQUENCY_HZ).toBe(CORE_BREATHE_FREQUENCY_HZ);
    expect(SLAB_BREATHE_AMPLITUDE_FACTOR).toBe(CORE_BREATHE_AMPLITUDE_FACTOR);
  });
});

describe("SpatialSlabManager — phase change listeners", () => {
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

describe("SpatialSlabManager — dispose detaches from the scene graph", () => {
  it("dispose unmounts the group from the creature", () => {
    const creatureGroup = new THREE.Group();
    const mgr = new SpatialSlabManager(creatureGroup);
    const slabGroup = mgr.getGroup();
    expect(slabGroup.parent).toBe(creatureGroup);
    mgr.dispose();
    expect(slabGroup.parent).toBeNull();
  });
});
