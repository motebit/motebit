/**
 * Property-based laws for the sensitivity-ladder algebra.
 *
 * The ladder (`SensitivityLevel = none < personal < medical < financial
 * < secret`) is interop law: every motebit implementation must agree on
 * which tier dominates which, or the cross-implementation gate isn't
 * interoperable. The algebra in `sensitivity.ts` exposes three pure
 * functions over the closed enum:
 *
 *   - `rankSensitivity(level)`           — ordinal rank 0..4
 *   - `maxSensitivity(a, b)`             — join-semilattice composition
 *   - `sensitivityPermits(upper, cand)`  — read-side filter
 *
 * Hand-written tests in `sensitivity.test.ts` cover the explicit
 * ordering of the five tiers and the canonical join cases. The property
 * tests below assert the universal mathematical laws across arbitrary
 * tier inputs — the laws that make the ladder safe to compose at
 * write-time (`maxSensitivity` in `ConversationManager.pushExchange`)
 * and at read-time (`sensitivityPermits` in `trimmed()`). If any law
 * fails, the join-write-path silently corrupts or the read-side filter
 * leaks across tiers — exactly the failure modes hand-picked examples
 * structurally miss.
 *
 * Sibling pattern to `packages/protocol/src/__tests__/semiring-laws.test.ts`
 * (associativity / identity / distributivity for the routing semiring)
 * — same shape, applied to the second algebraic surface motebit's
 * protocol exposes. Per `docs/doctrine/evals-as-attestations.md` §
 * "What ships now", these are testing-only artifacts under existing
 * package surfaces.
 *
 * Pinned seed 0x5eed matches semiring-laws / virtual-accounts /
 * skills / crypto-* shape for CI reproducibility.
 */

import { describe, it, beforeAll } from "vitest";
import fc from "fast-check";
import {
  ALL_SENSITIVITY_LEVELS,
  maxSensitivity,
  rankSensitivity,
  sensitivityPermits,
} from "../sensitivity.js";
import { SensitivityLevel } from "../index.js";

const FC_SEED = 0x5eed;

beforeAll(() => {
  fc.configureGlobal({ seed: FC_SEED, numRuns: 200 });
});

const sensitivityArb: fc.Arbitrary<SensitivityLevel> = fc.constantFrom(...ALL_SENSITIVITY_LEVELS);

// ── Property 1 — rankSensitivity is a total order ───────────────────

describe("rankSensitivity: total order over the closed enum", () => {
  it("rank is injective — distinct levels have distinct ranks", () => {
    fc.assert(
      fc.property(sensitivityArb, sensitivityArb, (a, b) => {
        if (a === b) return rankSensitivity(a) === rankSensitivity(b);
        return rankSensitivity(a) !== rankSensitivity(b);
      }),
    );
  });

  it("rank values are exactly {0, 1, 2, 3, 4} across ALL_SENSITIVITY_LEVELS", () => {
    const ranks = new Set(ALL_SENSITIVITY_LEVELS.map(rankSensitivity));
    if (ranks.size !== 5) throw new Error(`expected 5 distinct ranks, got ${ranks.size}`);
    for (const expected of [0, 1, 2, 3, 4]) {
      if (!ranks.has(expected)) throw new Error(`rank ${expected} missing from ladder`);
    }
  });
});

// ── Property 2 — maxSensitivity is a commutative join-semilattice ───

describe("maxSensitivity: join-semilattice laws", () => {
  it("commutativity: max(a, b) === max(b, a)", () => {
    fc.assert(
      fc.property(sensitivityArb, sensitivityArb, (a, b) => {
        return maxSensitivity(a, b) === maxSensitivity(b, a);
      }),
    );
  });

  it("associativity: max(max(a, b), c) === max(a, max(b, c))", () => {
    fc.assert(
      fc.property(sensitivityArb, sensitivityArb, sensitivityArb, (a, b, c) => {
        return maxSensitivity(maxSensitivity(a, b), c) === maxSensitivity(a, maxSensitivity(b, c));
      }),
    );
  });

  it("idempotence: max(a, a) === a", () => {
    fc.assert(
      fc.property(sensitivityArb, (a) => {
        return maxSensitivity(a, a) === a;
      }),
    );
  });

  it("identity element is None: max(None, a) === a for all a", () => {
    fc.assert(
      fc.property(sensitivityArb, (a) => {
        return maxSensitivity(SensitivityLevel.None, a) === a;
      }),
    );
  });

  it("max returns one of its inputs (no spurious tier introduction)", () => {
    fc.assert(
      fc.property(sensitivityArb, sensitivityArb, (a, b) => {
        const m = maxSensitivity(a, b);
        return m === a || m === b;
      }),
    );
  });

  it("max(a, b) has rank >= rank(a) AND rank >= rank(b)", () => {
    fc.assert(
      fc.property(sensitivityArb, sensitivityArb, (a, b) => {
        const m = maxSensitivity(a, b);
        return rankSensitivity(m) >= rankSensitivity(a) && rankSensitivity(m) >= rankSensitivity(b);
      }),
    );
  });
});

// ── Property 3 — sensitivityPermits agrees with rank ordering ───────

describe("sensitivityPermits: read-side filter consistent with rank", () => {
  it("reflexivity: a permits a", () => {
    fc.assert(
      fc.property(sensitivityArb, (a) => {
        return sensitivityPermits(a, a) === true;
      }),
    );
  });

  it("permits is equivalent to rank-leq: permits(upper, cand) iff rank(cand) <= rank(upper)", () => {
    fc.assert(
      fc.property(sensitivityArb, sensitivityArb, (upper, candidate) => {
        const expected = rankSensitivity(candidate) <= rankSensitivity(upper);
        return sensitivityPermits(upper, candidate) === expected;
      }),
    );
  });

  it("anti-symmetry: permits(a, b) && permits(b, a) iff a === b", () => {
    fc.assert(
      fc.property(sensitivityArb, sensitivityArb, (a, b) => {
        const both = sensitivityPermits(a, b) && sensitivityPermits(b, a);
        return both === (a === b);
      }),
    );
  });

  it("transitivity: permits(a, b) && permits(b, c) → permits(a, c)", () => {
    fc.assert(
      fc.property(sensitivityArb, sensitivityArb, sensitivityArb, (a, b, c) => {
        const ab = sensitivityPermits(a, b);
        const bc = sensitivityPermits(b, c);
        if (!ab || !bc) return true; // antecedent false → vacuously true
        return sensitivityPermits(a, c) === true;
      }),
    );
  });

  it("None permits only None: permits(None, x) iff x === None", () => {
    fc.assert(
      fc.property(sensitivityArb, (x) => {
        return sensitivityPermits(SensitivityLevel.None, x) === (x === SensitivityLevel.None);
      }),
    );
  });

  it("Secret permits everything: permits(Secret, x) is always true", () => {
    fc.assert(
      fc.property(sensitivityArb, (x) => {
        return sensitivityPermits(SensitivityLevel.Secret, x) === true;
      }),
    );
  });
});

// ── Property 4 — Cross-function consistency ─────────────────────────

describe("cross-function: max + permits + rank are mutually consistent", () => {
  it("max(a, b) permits both a and b", () => {
    fc.assert(
      fc.property(sensitivityArb, sensitivityArb, (a, b) => {
        const m = maxSensitivity(a, b);
        return sensitivityPermits(m, a) && sensitivityPermits(m, b);
      }),
    );
  });

  it("max is the least upper bound: any x that permits a AND b also permits max(a, b)", () => {
    fc.assert(
      fc.property(sensitivityArb, sensitivityArb, sensitivityArb, (a, b, x) => {
        const xPermitsA = sensitivityPermits(x, a);
        const xPermitsB = sensitivityPermits(x, b);
        if (!xPermitsA || !xPermitsB) return true; // vacuous
        return sensitivityPermits(x, maxSensitivity(a, b));
      }),
    );
  });
});
