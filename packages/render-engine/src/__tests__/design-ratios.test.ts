import { describe, it, expect } from "vitest";
import { GOLDEN_RATIO } from "../design-ratios";

describe("design-ratios", () => {
  it("GOLDEN_RATIO equals (1 + √5) / 2 = φ", () => {
    // Pin the canonical constant. If this ever diverges from the
    // mathematical identity (satisfied by the quadratic
    // x² = x + 1), the design language is lying to readers.
    expect(GOLDEN_RATIO).toBe((1 + Math.sqrt(5)) / 2);
  });

  it("satisfies φ² = φ + 1 to floating-point precision", () => {
    // The defining algebraic property of φ. A sanity check that
    // no well-meaning refactor replaces the constant with a
    // rounded decimal (1.618) that silently breaks identities
    // downstream (modular scales, recursive proportions).
    expect(GOLDEN_RATIO * GOLDEN_RATIO).toBeCloseTo(GOLDEN_RATIO + 1, 12);
  });

  it("conjugate 1/φ equals φ - 1", () => {
    // The conjugate (~0.618) is the other classic property —
    // consumers building modular scales (type sizes, nested
    // hierarchy steps) use it to step down.
    expect(1 / GOLDEN_RATIO).toBeCloseTo(GOLDEN_RATIO - 1, 12);
  });
});
