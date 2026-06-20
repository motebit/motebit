/**
 * Memory environment rendering — the §5 felt record in the spatial register.
 * Covers the honesty model behaviorally (content-free counts, saturating
 * density = no unbounded score, present-state tone = no trend), the pure
 * projection, the renderer lifecycle, and the coordinator state machine
 * (buffer-before-attach).
 */
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  MemoryEnvironmentCoordinator,
  MemoryEnvironmentRenderer,
  memoryToEnvironment,
  hueForTone,
} from "../memory-environment";

function parent(): THREE.Group {
  const g = new THREE.Group();
  g.name = "creature-group";
  return g;
}

describe("memoryToEnvironment", () => {
  it("an empty graph is empty haze, neutral tone", () => {
    const e = memoryToEnvironment({ held: 0, fading: 0 });
    expect(e.kind).toBe("environment");
    expect(e.density).toBe(0);
    expect(e.tone).toBe("neutral");
  });

  it("density saturates toward 1 and never exceeds it (not an unbounded score)", () => {
    const small = memoryToEnvironment({ held: 10, fading: 0 }).density;
    const mid = memoryToEnvironment({ held: 60, fading: 0 }).density;
    const huge = memoryToEnvironment({ held: 100_000, fading: 0 }).density;
    expect(small).toBeGreaterThan(0);
    expect(small).toBeLessThan(mid);
    expect(mid).toBeCloseTo(0.5, 2); // half-density at the HALF_DENSITY_AT mass
    expect(huge).toBeGreaterThan(mid);
    expect(huge).toBeLessThan(1);
    expect(huge).toBeLessThanOrEqual(1);
  });

  it("is monotonic in held mass but always bounded (plateaus, never climbs past 1)", () => {
    let prev = 0;
    for (const held of [1, 10, 50, 200, 1000, 50_000]) {
      const d = memoryToEnvironment({ held, fading: 0 }).density;
      expect(d).toBeGreaterThanOrEqual(prev);
      expect(d).toBeLessThan(1);
      prev = d;
    }
  });

  it("tone is the present hold/shed balance — warm fresh, cool shedding, else neutral", () => {
    // little fading → warm
    expect(memoryToEnvironment({ held: 100, fading: 2 }).tone).toBe("warm");
    // heavy fading → cool
    expect(memoryToEnvironment({ held: 100, fading: 50 }).tone).toBe("cool");
    // middling → neutral
    expect(memoryToEnvironment({ held: 100, fading: 20 }).tone).toBe("neutral");
  });

  it("is stateless: same summary always yields the same expression (no trend)", () => {
    const a = memoryToEnvironment({ held: 42, fading: 7 });
    const b = memoryToEnvironment({ held: 42, fading: 7 });
    expect(a).toEqual(b);
  });

  it("clamps defensively: negative or over-count inputs never break bounds", () => {
    const neg = memoryToEnvironment({ held: -5, fading: -3 });
    expect(neg.density).toBe(0);
    expect(neg.tone).toBe("neutral");
    // fading exceeding held is capped to held (shed fraction ≤ 1) → cool, valid.
    const over = memoryToEnvironment({ held: 10, fading: 999 });
    expect(over.tone).toBe("cool");
    expect(over.density).toBeGreaterThan(0);
    expect(over.density).toBeLessThan(1);
  });

  it("carries only density + tone — no raw count, score, or trend leaks", () => {
    const e = memoryToEnvironment({ held: 500, fading: 30 });
    expect(Object.keys(e).sort()).toEqual(["density", "kind", "tone"]);
  });
});

describe("hueForTone", () => {
  it("assigns a distinct hue per tone, all inside [0, 360)", () => {
    const hues = [hueForTone("warm"), hueForTone("cool"), hueForTone("neutral")];
    expect(new Set(hues).size).toBe(3);
    for (const h of hues) {
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });
});

describe("MemoryEnvironmentRenderer", () => {
  it("mounts and disposes a distinctly-named child group with a points field", () => {
    const p = parent();
    const r = new MemoryEnvironmentRenderer(p);
    const group = p.children.find((c) => c.name === "memory-environment") as THREE.Group;
    expect(group).toBeDefined();
    expect(group.children.find((c) => c.name === "memory-motes")).toBeDefined();
    r.dispose();
    expect(p.children.find((c) => c.name === "memory-environment")).toBeUndefined();
  });

  it("density drives the draw range (more held ⇒ more motes drawn)", () => {
    const p = parent();
    const r = new MemoryEnvironmentRenderer(p);
    const motes = (p.children.find((c) => c.name === "memory-environment") as THREE.Group)
      .children[0] as THREE.Points;

    r.setExpression(memoryToEnvironment({ held: 0, fading: 0 }));
    expect(motes.geometry.drawRange.count).toBe(0);

    r.setExpression(memoryToEnvironment({ held: 10, fading: 0 }));
    const few = motes.geometry.drawRange.count;
    r.setExpression(memoryToEnvironment({ held: 5000, fading: 0 }));
    const many = motes.geometry.drawRange.count;
    expect(many).toBeGreaterThan(few);
    expect(few).toBeGreaterThan(0);
    r.dispose();
  });

  it("tone drives the mote hue", () => {
    const p = parent();
    const r = new MemoryEnvironmentRenderer(p);
    const motes = (p.children.find((c) => c.name === "memory-environment") as THREE.Group)
      .children[0] as THREE.Points;
    const mat = motes.material as THREE.PointsMaterial;

    r.setExpression({ kind: "environment", density: 0.5, tone: "warm" });
    const warm = mat.color.getHSL({ h: 0, s: 0, l: 0 }).h;
    r.setExpression({ kind: "environment", density: 0.5, tone: "cool" });
    const cool = mat.color.getHSL({ h: 0, s: 0, l: 0 }).h;
    expect(warm).not.toBeCloseTo(cool, 2);
    r.dispose();
  });

  it("tick() drifts the field (rotates the group)", () => {
    const p = parent();
    const r = new MemoryEnvironmentRenderer(p);
    const group = p.children.find((c) => c.name === "memory-environment") as THREE.Group;
    const before = group.rotation.y;
    r.tick(120_000);
    expect(group.rotation.y).not.toBe(before);
    r.dispose();
  });

  it("ignores non-environment expressions", () => {
    const p = parent();
    const r = new MemoryEnvironmentRenderer(p);
    const motes = (p.children.find((c) => c.name === "memory-environment") as THREE.Group)
      .children[0] as THREE.Points;
    r.setExpression({ kind: "satellite", items: [] });
    expect(motes.geometry.drawRange.count).toBe(0);
    r.dispose();
  });
});

describe("MemoryEnvironmentCoordinator", () => {
  it("buffers the mass set before attach and flushes on attach", () => {
    const c = new MemoryEnvironmentCoordinator();
    c.setMemory({ held: 80, fading: 5 });
    expect(c.current().density).toBeGreaterThan(0);
    const p = parent();
    c.attach(p);
    const motes = (p.children.find((ch) => ch.name === "memory-environment") as THREE.Group)
      .children[0] as THREE.Points;
    expect(motes.geometry.drawRange.count).toBeGreaterThan(0);
    c.dispose();
  });

  it("setMemory updates the projected expression", () => {
    const c = new MemoryEnvironmentCoordinator();
    c.setMemory({ held: 100, fading: 60 });
    expect(c.current().tone).toBe("cool");
    c.dispose();
  });

  it("attach is idempotent", () => {
    const c = new MemoryEnvironmentCoordinator();
    const p = parent();
    c.attach(p);
    c.attach(p);
    expect(p.children.filter((ch) => ch.name === "memory-environment").length).toBe(1);
    c.dispose();
  });

  it("dispose detaches the renderer and resets the expression", () => {
    const c = new MemoryEnvironmentCoordinator();
    const p = parent();
    c.attach(p);
    c.setMemory({ held: 100, fading: 0 });
    c.dispose();
    expect(c.current().density).toBe(0);
    expect(p.children.find((ch) => ch.name === "memory-environment")).toBeUndefined();
  });
});
