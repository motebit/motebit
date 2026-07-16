import { describe, it, expect } from "vitest";
import { mulberry32, hashSeed, sampleBeta, thompsonDraw } from "../thompson.js";

describe("mulberry32 — seeded PRNG", () => {
  it("is deterministic: same seed → same sequence", () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    const seqA = [a(), a(), a(), a(), a()];
    const seqB = [b(), b(), b(), b(), b()];
    expect(seqA).toEqual(seqB);
  });

  it("returns values in [0,1) with mean ≈ 0.5", () => {
    const rng = mulberry32(7);
    let sum = 0;
    const N = 20000;
    for (let i = 0; i < N; i++) {
      const u = rng();
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
      sum += u;
    }
    expect(sum / N).toBeCloseTo(0.5, 1);
  });

  it("different seeds diverge", () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });
});

describe("hashSeed", () => {
  it("is deterministic and distinguishes inputs", () => {
    expect(hashSeed("jti-1|alice")).toBe(hashSeed("jti-1|alice"));
    expect(hashSeed("jti-1|alice")).not.toBe(hashSeed("jti-1|bob"));
  });
});

describe("sampleBeta — ratio-of-gammas", () => {
  it("stays within [0,1]", () => {
    const rng = mulberry32(99);
    for (let i = 0; i < 5000; i++) {
      const x = sampleBeta(1 + (i % 5), 1 + (i % 3), rng);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1);
    }
  });

  it("has mean ≈ α/(α+β)", () => {
    const cases: Array<[number, number]> = [
      [1, 1],
      [3, 1],
      [1, 3],
      [21, 1],
      [10, 10],
    ];
    for (const [a, b] of cases) {
      const rng = mulberry32(2024);
      let sum = 0;
      const N = 15000;
      for (let i = 0; i < N; i++) sum += sampleBeta(a, b, rng);
      expect(sum / N).toBeCloseTo(a / (a + b), 1);
    }
  });

  it("Beta(1,1) is wide (uniform) while Beta(21,1) concentrates near 1", () => {
    const rng = mulberry32(5);
    const wide: number[] = [];
    const tight: number[] = [];
    for (let i = 0; i < 8000; i++) {
      wide.push(sampleBeta(1, 1, rng));
      tight.push(sampleBeta(21, 1, rng));
    }
    const variance = (xs: number[]) => {
      const m = xs.reduce((s, x) => s + x, 0) / xs.length;
      return xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length;
    };
    // Uniform variance ≈ 1/12 ≈ 0.083; Beta(21,1) variance is tiny (~0.002).
    expect(variance(wide)).toBeGreaterThan(variance(tight) * 10);
    expect(tight.reduce((s, x) => s + x, 0) / tight.length).toBeGreaterThan(0.9);
  });
});

describe("thompsonDraw — the auditable one-shot draw", () => {
  it("reproduces exactly from its seed (offline-verifiable)", () => {
    const first = thompsonDraw(3, 2, "jti-abc|alice-worker");
    const again = thompsonDraw(3, 2, "jti-abc|alice-worker");
    expect(first).toBe(again);
  });

  it("varies across seeds (exploration across turns)", () => {
    const draws = new Set<number>();
    for (let i = 0; i < 50; i++) draws.add(thompsonDraw(1, 1, `jti-${i}|w`));
    // Distinct turn nonces → distinct draws (exploration is not frozen).
    expect(draws.size).toBeGreaterThan(40);
  });

  it("guards the u→0 corner — a degenerate PRNG still yields a finite draw", () => {
    // If the stream ever yields exactly 0, -ln is guarded to stay finite; two
    // equal gammas ⇒ 0.5, never NaN/Infinity.
    expect(sampleBeta(1, 1, () => 0)).toBe(0.5);
  });
});
