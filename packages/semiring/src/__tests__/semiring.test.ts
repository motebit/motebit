import { describe, it, expect } from "vitest";
import {
  TrustSemiring,
  CostSemiring,
  LatencySemiring,
  BottleneckSemiring,
  ReliabilitySemiring,
  BooleanSemiring,
  RegulatoryRiskSemiring,
  productSemiring,
  recordSemiring,
  mappedSemiring,
} from "../semiring.js";
import type { Semiring } from "../semiring.js";

// Cover the barrel re-export (index.ts line 1+)
import * as barrel from "../index.js";

// ── Semiring Axiom Verification ─────────────────────────────────────
// If the axioms don't hold, every algorithm built on top is wrong.

function verifySemiringAxioms<T>(
  name: string,
  sr: Semiring<T>,
  values: T[],
  eq: (a: T, b: T) => boolean = (a, b) => a === b,
) {
  describe(`${name} — semiring axioms`, () => {
    it("⊕ is commutative: a ⊕ b = b ⊕ a", () => {
      for (const a of values) {
        for (const b of values) {
          expect(eq(sr.add(a, b), sr.add(b, a))).toBe(true);
        }
      }
    });

    it("⊕ is associative: (a ⊕ b) ⊕ c = a ⊕ (b ⊕ c)", () => {
      for (const a of values) {
        for (const b of values) {
          for (const c of values) {
            expect(eq(sr.add(sr.add(a, b), c), sr.add(a, sr.add(b, c)))).toBe(true);
          }
        }
      }
    });

    it("0 is additive identity: a ⊕ 0 = a", () => {
      for (const a of values) {
        expect(eq(sr.add(a, sr.zero), a)).toBe(true);
        expect(eq(sr.add(sr.zero, a), a)).toBe(true);
      }
    });

    it("⊗ is associative: (a ⊗ b) ⊗ c = a ⊗ (b ⊗ c)", () => {
      for (const a of values) {
        for (const b of values) {
          for (const c of values) {
            const lhs = sr.mul(sr.mul(a, b), c);
            const rhs = sr.mul(a, sr.mul(b, c));
            expect(eq(lhs, rhs)).toBe(true);
          }
        }
      }
    });

    it("1 is multiplicative identity: a ⊗ 1 = 1 ⊗ a = a", () => {
      for (const a of values) {
        expect(eq(sr.mul(a, sr.one), a)).toBe(true);
        expect(eq(sr.mul(sr.one, a), a)).toBe(true);
      }
    });

    it("0 annihilates: a ⊗ 0 = 0 ⊗ a = 0", () => {
      for (const a of values) {
        expect(eq(sr.mul(a, sr.zero), sr.zero)).toBe(true);
        expect(eq(sr.mul(sr.zero, a), sr.zero)).toBe(true);
      }
    });

    it("⊗ distributes over ⊕: a ⊗ (b ⊕ c) = (a ⊗ b) ⊕ (a ⊗ c)", () => {
      for (const a of values) {
        for (const b of values) {
          for (const c of values) {
            const lhs = sr.mul(a, sr.add(b, c));
            const rhs = sr.add(sr.mul(a, b), sr.mul(a, c));
            expect(eq(lhs, rhs)).toBe(true);
          }
        }
      }
    });

    it("right distributivity: (b ⊕ c) ⊗ a = (b ⊗ a) ⊕ (c ⊗ a)", () => {
      for (const a of values) {
        for (const b of values) {
          for (const c of values) {
            const lhs = sr.mul(sr.add(b, c), a);
            const rhs = sr.add(sr.mul(b, a), sr.mul(c, a));
            expect(eq(lhs, rhs)).toBe(true);
          }
        }
      }
    });
  });
}

// ── Number equality with floating point tolerance ───────────────────
const numEq = (a: number, b: number) => Math.abs(a - b) < 1e-10 || a === b;

// ── Run axiom checks on all concrete semirings ──────────────────────

const trustValues = [0, 0.1, 0.3, 0.6, 0.9, 1];
verifySemiringAxioms("TrustSemiring", TrustSemiring, trustValues, numEq);

const costValues = [0, 0.5, 1, 5, 10, Infinity];
verifySemiringAxioms("CostSemiring", CostSemiring, costValues, numEq);

const latencyValues = [0, 100, 500, 1000, Infinity];
verifySemiringAxioms("LatencySemiring", LatencySemiring, latencyValues, numEq);

// RegulatoryRisk: (min, +, ∞, 0) — same algebra as Cost/Latency (tropical)
const riskValues = [0, 0.5, 1, 5, 10, Infinity];
verifySemiringAxioms("RegulatoryRiskSemiring", RegulatoryRiskSemiring, riskValues, numEq);

// Bottleneck: (max, min, 0, ∞) — annihilation check needs special care
// a ⊗ 0 = min(a, 0) = 0 ✓  and  a ⊕ 0 = max(a, 0) = a ✓ (for a >= 0)
const bottleneckValues = [0, 0.5, 1, 10, Infinity];
verifySemiringAxioms("BottleneckSemiring", BottleneckSemiring, bottleneckValues, numEq);

verifySemiringAxioms("ReliabilitySemiring", ReliabilitySemiring, trustValues, numEq);

verifySemiringAxioms("BooleanSemiring", BooleanSemiring, [true, false]);

// ── Product Semiring ────────────────────────────────────────────────

describe("productSemiring", () => {
  const ps = productSemiring(TrustSemiring, CostSemiring);

  it("zero and one are correct", () => {
    expect(ps.zero).toEqual([0, Infinity]);
    expect(ps.one).toEqual([1, 0]);
  });

  it("add applies component-wise", () => {
    expect(ps.add([0.5, 10], [0.8, 5])).toEqual([0.8, 5]);
  });

  it("mul applies component-wise", () => {
    const result = ps.mul([0.9, 2], [0.8, 3]);
    expect(result[0]).toBeCloseTo(0.72); // 0.9 × 0.8
    expect(result[1]).toBeCloseTo(5); // 2 + 3
  });

  // Verify axioms on the product
  const productValues: readonly [number, number][] = [
    [0, Infinity],
    [1, 0],
    [0.5, 3],
    [0.9, 1],
    [0.3, 10],
  ];

  verifySemiringAxioms(
    "Product(Trust × Cost)",
    ps,
    [...productValues],
    (a, b) => numEq(a[0], b[0]) && numEq(a[1], b[1]),
  );
});

// ── Record Semiring ─────────────────────────────────────────────────

describe("recordSemiring", () => {
  const rs = recordSemiring({
    trust: TrustSemiring,
    cost: CostSemiring,
    latency: LatencySemiring,
  });

  it("computes zero and one correctly", () => {
    expect(rs.zero).toEqual({ trust: 0, cost: Infinity, latency: Infinity });
    expect(rs.one).toEqual({ trust: 1, cost: 0, latency: 0 });
  });

  it("add picks best per dimension", () => {
    const a = { trust: 0.5, cost: 10, latency: 200 };
    const b = { trust: 0.8, cost: 5, latency: 300 };
    const result = rs.add(a, b);
    expect(result.trust).toBe(0.8); // max
    expect(result.cost).toBe(5); // min
    expect(result.latency).toBe(200); // min
  });

  it("mul composes per dimension", () => {
    const a = { trust: 0.9, cost: 2, latency: 100 };
    const b = { trust: 0.8, cost: 3, latency: 200 };
    const result = rs.mul(a, b);
    expect(result.trust).toBeCloseTo(0.72); // ×
    expect(result.cost).toBe(5); // +
    expect(result.latency).toBe(300); // +
  });
});

// ── Mapped Semiring ─────────────────────────────────────────────────

describe("barrel re-export (index.ts)", () => {
  it("exports all public symbols", () => {
    expect(barrel.TrustSemiring).toBeDefined();
    expect(barrel.CostSemiring).toBeDefined();
    expect(barrel.WeightedDigraph).toBeDefined();
    expect(barrel.optimalPaths).toBeDefined();
    expect(barrel.ProvenanceSemiring).toBeDefined();
    expect(barrel.buildAgentGraph).toBeDefined();
    expect(barrel.addDelegationEdges).toBeDefined();
    expect(barrel.RouteWeightSemiring).toBeDefined();
  });
});

describe("mappedSemiring", () => {
  // Map cost semiring through milliseconds ↔ seconds conversion
  const SecondsCost = mappedSemiring(
    CostSemiring,
    (ms: number) => ms / 1000,
    (s: number) => s * 1000,
  );

  it("preserves semiring structure through isomorphism", () => {
    expect(SecondsCost.zero).toBe(Infinity);
    expect(SecondsCost.one).toBe(0);
    expect(SecondsCost.add(5, 3)).toBe(3); // min
    expect(SecondsCost.mul(2, 3)).toBe(5); // mapped: (2000+3000)/1000
  });
});
