/**
 * Property-based tests for semiring laws using fast-check.
 *
 * These verify the algebraic invariants that every algorithm in the
 * semiring package depends on — associativity, commutativity, identity,
 * annihilation, distributivity — over thousands of random inputs rather
 * than a handful of hand-picked examples.
 */

import { describe, it } from "vitest";
import fc from "fast-check";
import type { Semiring } from "../semiring.js";
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
} from "../semiring.js";

// ── Approximate equality for floating-point ────────────────────────

const EPS = 1e-10;

function approxEq(a: number, b: number): boolean {
  if (a === b) return true; // handles Infinity === Infinity
  if (!isFinite(a) || !isFinite(b)) return false;
  return Math.abs(a - b) < EPS;
}

// ── Generic law checker ────────────────────────────────────────────

function semiringLaws<T>(
  name: string,
  sr: Semiring<T>,
  arb: fc.Arbitrary<T>,
  eq: (a: T, b: T) => boolean,
  opts?: { idempotentAdd?: boolean },
) {
  describe(`${name} — property-based semiring laws`, () => {
    it("associativity of add: a + (b + c) = (a + b) + c", () => {
      fc.assert(
        fc.property(arb, arb, arb, (a, b, c) => {
          return eq(sr.add(a, sr.add(b, c)), sr.add(sr.add(a, b), c));
        }),
      );
    });

    it("associativity of mul: a * (b * c) = (a * b) * c", () => {
      fc.assert(
        fc.property(arb, arb, arb, (a, b, c) => {
          return eq(sr.mul(a, sr.mul(b, c)), sr.mul(sr.mul(a, b), c));
        }),
      );
    });

    it("commutativity of add: a + b = b + a", () => {
      fc.assert(
        fc.property(arb, arb, (a, b) => {
          return eq(sr.add(a, b), sr.add(b, a));
        }),
      );
    });

    it("additive identity: a + 0 = a = 0 + a", () => {
      fc.assert(
        fc.property(arb, (a) => {
          return eq(sr.add(a, sr.zero), a) && eq(sr.add(sr.zero, a), a);
        }),
      );
    });

    it("multiplicative identity: a * 1 = a = 1 * a", () => {
      fc.assert(
        fc.property(arb, (a) => {
          return eq(sr.mul(a, sr.one), a) && eq(sr.mul(sr.one, a), a);
        }),
      );
    });

    it("annihilation: a * 0 = 0 = 0 * a", () => {
      fc.assert(
        fc.property(arb, (a) => {
          return eq(sr.mul(a, sr.zero), sr.zero) && eq(sr.mul(sr.zero, a), sr.zero);
        }),
      );
    });

    it("left distributivity: a * (b + c) = (a * b) + (a * c)", () => {
      fc.assert(
        fc.property(arb, arb, arb, (a, b, c) => {
          const lhs = sr.mul(a, sr.add(b, c));
          const rhs = sr.add(sr.mul(a, b), sr.mul(a, c));
          return eq(lhs, rhs);
        }),
      );
    });

    it("right distributivity: (a + b) * c = (a * c) + (b * c)", () => {
      fc.assert(
        fc.property(arb, arb, arb, (a, b, c) => {
          const lhs = sr.mul(sr.add(a, b), c);
          const rhs = sr.add(sr.mul(a, c), sr.mul(b, c));
          return eq(lhs, rhs);
        }),
      );
    });

    if (opts?.idempotentAdd) {
      it("idempotency of add: a + a = a", () => {
        fc.assert(
          fc.property(arb, (a) => {
            return eq(sr.add(a, a), a);
          }),
        );
      });
    }

    it("closure: add result is in valid domain", () => {
      fc.assert(
        fc.property(arb, arb, (a, b) => {
          const r = sr.add(a, b);
          // Result should be the same type and not NaN
          return typeof r === typeof a && !(typeof r === "number" && isNaN(r as number));
        }),
      );
    });

    it("closure: mul result is in valid domain", () => {
      fc.assert(
        fc.property(arb, arb, (a, b) => {
          const r = sr.mul(a, b);
          return typeof r === typeof a && !(typeof r === "number" && isNaN(r as number));
        }),
      );
    });
  });
}

// ── Arbitraries ────────────────────────────────────────────────────

// Trust/Reliability: values in [0, 1]
const unitArb = fc.double({ min: 0, max: 1, noNaN: true });

// Cost/Latency/RegulatoryRisk: non-negative including Infinity
// Use oneof to ensure Infinity appears in the test distribution
const nonNegArb = fc.oneof(
  fc.double({ min: 0, max: 1e6, noNaN: true }),
  fc.constant(Infinity),
  fc.constant(0),
);

// Bottleneck: non-negative including 0 and Infinity
const bottleneckArb = fc.oneof(
  fc.double({ min: 0, max: 1e6, noNaN: true }),
  fc.constant(Infinity),
  fc.constant(0),
);

const boolArb = fc.boolean();

// ── Run law checks on all concrete semirings ───────────────────────

// Trust: (max, *, 0, 1) — add is idempotent (max(a,a) = a)
semiringLaws("TrustSemiring", TrustSemiring, unitArb, approxEq, {
  idempotentAdd: true,
});

// Cost: (min, +, Inf, 0) — tropical semiring, add is idempotent (min(a,a) = a)
semiringLaws("CostSemiring", CostSemiring, nonNegArb, approxEq, {
  idempotentAdd: true,
});

// Latency: same algebra as Cost
semiringLaws("LatencySemiring", LatencySemiring, nonNegArb, approxEq, {
  idempotentAdd: true,
});

// RegulatoryRisk: same algebra as Cost
semiringLaws("RegulatoryRiskSemiring", RegulatoryRiskSemiring, nonNegArb, approxEq, {
  idempotentAdd: true,
});

// Bottleneck: (max, min, 0, Inf) — add is idempotent (max(a,a) = a)
semiringLaws("BottleneckSemiring", BottleneckSemiring, bottleneckArb, approxEq, {
  idempotentAdd: true,
});

// Reliability: (max, *, 0, 1) — same algebra as Trust
semiringLaws("ReliabilitySemiring", ReliabilitySemiring, unitArb, approxEq, {
  idempotentAdd: true,
});

// Boolean: (||, &&, false, true)
semiringLaws("BooleanSemiring", BooleanSemiring, boolArb, (a, b) => a === b, {
  idempotentAdd: true,
});

// ── Product semiring ───────────────────────────────────────────────

describe("Product(Trust x Cost) — property-based", () => {
  const ps = productSemiring(TrustSemiring, CostSemiring);

  const productArb = fc.tuple(unitArb, nonNegArb) as fc.Arbitrary<readonly [number, number]>;

  const productEq = (a: readonly [number, number], b: readonly [number, number]) =>
    approxEq(a[0], b[0]) && approxEq(a[1], b[1]);

  semiringLaws("Product(Trust x Cost)", ps, productArb, productEq, {
    idempotentAdd: true,
  });
});

// ── Record semiring ────────────────────────────────────────────────

describe("Record{trust, cost, latency} — property-based", () => {
  const rs = recordSemiring({
    trust: TrustSemiring,
    cost: CostSemiring,
    latency: LatencySemiring,
  });

  const recordArb = fc.record({
    trust: unitArb,
    cost: nonNegArb,
    latency: nonNegArb,
  });

  const recordEq = (
    a: { trust: number; cost: number; latency: number },
    b: { trust: number; cost: number; latency: number },
  ) => approxEq(a.trust, b.trust) && approxEq(a.cost, b.cost) && approxEq(a.latency, b.latency);

  semiringLaws("Record{trust, cost, latency}", rs, recordArb, recordEq, {
    idempotentAdd: true,
  });
});

// ── Monotonicity ───────────────────────────────────────────────────
// For semirings where add = max or add = min, verify monotonicity.

describe("monotonicity", () => {
  it("TrustSemiring: if a <= b then a + c <= b + c", () => {
    fc.assert(
      fc.property(unitArb, unitArb, unitArb, (a, b, c) => {
        if (a > b) return true; // only test when a <= b
        return TrustSemiring.add(a, c) <= TrustSemiring.add(b, c) + EPS;
      }),
    );
  });

  it("CostSemiring: if a <= b then a + c <= b + c (min is monotone)", () => {
    fc.assert(
      fc.property(nonNegArb, nonNegArb, nonNegArb, (a, b, c) => {
        if (a > b) return true;
        return CostSemiring.add(a, c) <= CostSemiring.add(b, c) + EPS;
      }),
    );
  });

  it("ReliabilitySemiring: if a <= b then a + c <= b + c", () => {
    fc.assert(
      fc.property(unitArb, unitArb, unitArb, (a, b, c) => {
        if (a > b) return true;
        return ReliabilitySemiring.add(a, c) <= ReliabilitySemiring.add(b, c) + EPS;
      }),
    );
  });

  it("BottleneckSemiring: if a <= b then a + c <= b + c", () => {
    fc.assert(
      fc.property(bottleneckArb, bottleneckArb, bottleneckArb, (a, b, c) => {
        if (a > b) return true;
        return BottleneckSemiring.add(a, c) <= BottleneckSemiring.add(b, c) + EPS;
      }),
    );
  });
});
