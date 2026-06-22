/**
 * Accrual orbit tests — the leverage moment in 3D: distinct hue per kind, the
 * bounded fade (an act fades), and the coordinator lifecycle (buffer-before-
 * attach, cap, time-eviction, fade-opacity, dispose).
 * Doctrine: docs/doctrine/felt-accumulation.md.
 */
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  AccrualSatelliteCoordinator,
  hueForAccrualKind,
  opacityForAge,
  type AccrualOrbKind,
} from "../accrual-satellites.js";

const KINDS: AccrualOrbKind[] = [
  "recalled_memory",
  "trust_edge",
  "consolidated_fact",
  "prior_approval_pattern",
  "standing_delegation",
];

const parent = (): THREE.Group => new THREE.Group();
const orbGroup = (p: THREE.Group): THREE.Object3D | undefined =>
  p.getObjectByName("accrual-satellites");

describe("hueForAccrualKind", () => {
  it("assigns a distinct hue to each kind, all inside [0, 360)", () => {
    const hues = KINDS.map(hueForAccrualKind);
    expect(new Set(hues).size).toBe(KINDS.length);
    for (const h of hues) {
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });
});

describe("opacityForAge — the bounded fade (records-vs-acts: an act fades)", () => {
  it("full before the fade window, linear through it, zero at/after lifetime", () => {
    expect(opacityForAge(0)).toBe(1);
    expect(opacityForAge(5000)).toBe(1); // before the fade window opens (6000ms)
    expect(opacityForAge(7500)).toBeCloseTo(0.5, 5); // mid-fade: (9000-7500)/3000
    expect(opacityForAge(9000)).toBe(0); // end of life
    expect(opacityForAge(99_999)).toBe(0);
  });
});

describe("AccrualSatelliteCoordinator", () => {
  it("buffers an orb before attach, then renders it on attach", () => {
    const c = new AccrualSatelliteCoordinator();
    c.addAccrual("recalled_memory", 0);
    expect(c.size()).toBe(1);
    const p = parent();
    c.attach(p);
    expect(orbGroup(p)?.children.length).toBe(1);
    c.dispose();
  });

  it("caps concurrent orbs, evicting the oldest (calm, never a climbing ring)", () => {
    const c = new AccrualSatelliteCoordinator();
    const p = parent();
    c.attach(p);
    for (let i = 0; i < 7; i++) c.addAccrual("recalled_memory", i); // all within lifetime
    expect(c.size()).toBe(5); // MAX_ORBS
    expect(orbGroup(p)?.children.length).toBe(5);
    c.dispose();
  });

  it("evicts an orb after its lifetime — the act is temporally bounded", () => {
    const c = new AccrualSatelliteCoordinator();
    const p = parent();
    c.attach(p);
    c.addAccrual("trust_edge", 0);
    c.tick(5000); // mid-life
    expect(c.size()).toBe(1);
    c.tick(9000); // end of life → evicted
    expect(c.size()).toBe(0);
    expect(orbGroup(p)?.children.length).toBe(0);
    c.dispose();
  });

  it("fades the orb's material opacity through the fade window", () => {
    const c = new AccrualSatelliteCoordinator();
    const p = parent();
    c.attach(p);
    c.addAccrual("recalled_memory", 0);
    c.tick(7500); // age 7500 → opacityForAge 0.5
    const mesh = orbGroup(p)!.children[0] as THREE.Mesh;
    const material = mesh.material as THREE.MeshPhysicalMaterial;
    expect(material.opacity).toBeCloseTo(0.9 * 0.5, 3); // BASE_OPACITY × fade
    c.dispose();
  });

  it("dispose detaches the orbit group and clears", () => {
    const c = new AccrualSatelliteCoordinator();
    const p = parent();
    c.attach(p);
    c.addAccrual("recalled_memory", 0);
    c.dispose();
    expect(orbGroup(p)).toBeUndefined();
    expect(c.size()).toBe(0);
  });
});
