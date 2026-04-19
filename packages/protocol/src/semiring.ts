/**
 * Semiring — the algebraic foundation for agent network computation.
 *
 * A semiring (S, ⊕, ⊗, 0, 1) satisfies:
 *   (S, ⊕, 0) — commutative monoid (aggregation of parallel alternatives)
 *   (S, ⊗, 1) — monoid (sequential composition)
 *   ⊗ distributes over ⊕: a ⊗ (b ⊕ c) = (a ⊗ b) ⊕ (a ⊗ c)
 *   0 annihilates: a ⊗ 0 = 0 ⊗ a = 0
 *
 * Different semirings model different routing concerns over the same graph:
 *   Trust:       (max, ×, 0, 1)  → most trusted delegation chain
 *   Cost:        (min, +, ∞, 0)  → cheapest agent pipeline
 *   Latency:     (min, +, ∞, 0)  → fastest sequential path
 *   Bottleneck:  (max, min, 0, 1) → widest bottleneck path (capacity)
 *   Reliability: (max, ×, 0, 1)  → most reliable chain
 *   Boolean:     (∨, ∧, ⊥, ⊤)   → reachability
 *
 * One graph. One algorithm. Swap the semiring. Different answer.
 */

export interface Semiring<T> {
  /** Additive identity. The "worst" or "impossible" value. */
  readonly zero: T;
  /** Multiplicative identity. Passthrough / no-op edge. */
  readonly one: T;
  /** ⊕: aggregate parallel alternatives (commutative, associative). */
  add(a: T, b: T): T;
  /** ⊗: compose sequential edges (associative). */
  mul(a: T, b: T): T;
  /**
   * Value equality. Used by graph traversal for convergence detection.
   * Defaults to `===` when absent — correct for primitive semirings (number, boolean).
   * Required for compound semirings (record, product, annotated) where `add()`
   * returns a new object even when the value is semantically unchanged.
   *
   * Declared as a property (not method) so extracting it doesn't trigger
   * unbound-method lint — semiring objects are plain data, never class instances.
   */
  readonly eq?: ((a: T, b: T) => boolean) | undefined;
}

// ── Concrete Semirings ──────────────────────────────────────────────

/** (max, ×, 0, 1) — most trusted delegation chain through the network. */
export const TrustSemiring: Semiring<number> = {
  zero: 0,
  one: 1,
  add: (a, b) => Math.max(a, b),
  mul: (a, b) => a * b,
};

/**
 * (min, +, ∞, 0) — cheapest path through the agent network.
 * Tropical semiring. Same algebra as Dijkstra / Bellman-Ford.
 */
export const CostSemiring: Semiring<number> = {
  zero: Infinity,
  one: 0,
  add: (a, b) => Math.min(a, b),
  mul: (a, b) => a + b,
};

/** (min, +, ∞, 0) — fastest sequential path (sum of edge latencies). */
export const LatencySemiring: Semiring<number> = {
  zero: Infinity,
  one: 0,
  add: (a, b) => Math.min(a, b),
  mul: (a, b) => a + b,
};

/** (max, min, 0, ∞) — widest bottleneck path (capacity-limited routing). */
export const BottleneckSemiring: Semiring<number> = {
  zero: 0,
  one: Infinity,
  add: (a, b) => Math.max(a, b),
  mul: (a, b) => Math.min(a, b),
};

/** (max, ×, 0, 1) — most reliable chain (probability product). */
export const ReliabilitySemiring: Semiring<number> = {
  zero: 0,
  one: 1,
  add: (a, b) => Math.max(a, b),
  mul: (a, b) => a * b,
};

/**
 * (min, +, ∞, 0) — lowest regulatory risk path.
 * Risk accumulates along delegation chains (additive composition),
 * parallel alternatives pick the lowest-risk route (min choice).
 *
 * Edge weights represent risk scores: 0 = no risk, ∞ = impossible.
 * Jurisdictional data handling, compliance requirements, audit depth —
 * all accumulate when one agent delegates to another.
 */
export const RegulatoryRiskSemiring: Semiring<number> = {
  zero: Infinity,
  one: 0,
  add: (a, b) => Math.min(a, b),
  mul: (a, b) => a + b,
};

/** (∨, ∧, false, true) — can agent A reach agent B? */
export const BooleanSemiring: Semiring<boolean> = {
  zero: false,
  one: true,
  add: (a, b) => a || b,
  mul: (a, b) => a && b,
};

/**
 * (max, +, -∞, 0) — numerically stable max-product via log-space.
 *
 * Multiplying many small probabilities or confidences (each < 1) in
 * linear space underflows fast: twenty 0.1-confidence edges collapse
 * to 10⁻²⁰, which starts losing precision before then and hits
 * denormals by 50. In log space the product becomes a sum; max stays
 * max. Isomorphic to `ReliabilitySemiring` via x ↦ log(x), but callers
 * skip the intermediate floats and stay stable over deep chains.
 *
 * Used by memory-graph's `recallConfidentChain` lens — most-confident
 * reasoning chain through the memory graph. Also valid as the Viterbi
 * recurrence semiring on DAG-structured trellises (when HMM-shape
 * inference joins the codebase as a separate primitive).
 */
export const MaxProductLogSemiring: Semiring<number> = {
  zero: -Infinity,
  one: 0,
  add: (a, b) => Math.max(a, b),
  mul: (a, b) => a + b,
};

// ── Semiring Combinators ────────────────────────────────────────────

/**
 * Product semiring: optimize multiple concerns simultaneously.
 *
 * (A × B, ⊕_A × ⊕_B, ⊗_A × ⊗_B, (0_A, 0_B), (1_A, 1_B))
 *
 * One graph traversal computes trust × cost × latency in a single pass.
 */
export function productSemiring<A, B>(sa: Semiring<A>, sb: Semiring<B>): Semiring<readonly [A, B]> {
  const saEq = sa.eq;
  const sbEq = sb.eq;
  const eqA = (a: A, b: A): boolean => (saEq ? saEq(a, b) : a === b);
  const eqB = (a: B, b: B): boolean => (sbEq ? sbEq(a, b) : a === b);
  return {
    zero: [sa.zero, sb.zero] as const,
    one: [sa.one, sb.one] as const,
    add: (x, y) => [sa.add(x[0], y[0]), sb.add(x[1], y[1])] as const,
    mul: (x, y) => [sa.mul(x[0], y[0]), sb.mul(x[1], y[1])] as const,
    eq: (x, y) => eqA(x[0], y[0]) && eqB(x[1], y[1]),
  };
}

/**
 * Lift a scalar semiring into a named-fields record semiring.
 * Useful when you want labeled dimensions instead of nested tuples.
 *
 *   const Multi = recordSemiring({ trust: TrustSemiring, cost: CostSemiring });
 *   // Semiring<{ trust: number; cost: number }>
 */
export function recordSemiring<R extends Record<string, unknown>>(fields: {
  [K in keyof R]: Semiring<R[K]>;
}): Semiring<R> {
  const keys = Object.keys(fields) as (keyof R)[];
  const zero = {} as R;
  const one = {} as R;
  const eqs = {} as { [K in keyof R]: (a: R[K], b: R[K]) => boolean };
  for (const k of keys) {
    const f = fields[k];
    zero[k] = f.zero;
    one[k] = f.one;
    const fEq = f.eq;
    eqs[k] = fEq
      ? (a: R[typeof k], b: R[typeof k]) => fEq(a, b)
      : (a: R[typeof k], b: R[typeof k]) => a === b;
  }
  return {
    zero,
    one,
    add(a, b) {
      const r = {} as R;
      for (const k of keys) {
        const f = fields[k];
        r[k] = f.add(a[k], b[k]);
      }
      return r;
    },
    mul(a, b) {
      const r = {} as R;
      for (const k of keys) {
        const f = fields[k];
        r[k] = f.mul(a[k], b[k]);
      }
      return r;
    },
    eq(a, b) {
      for (const k of keys) {
        if (!eqs[k](a[k], b[k])) return false;
      }
      return true;
    },
  };
}

/**
 * Map a semiring through an isomorphism.
 * Useful for wrapping/unwrapping branded types or unit conversions.
 */
export function mappedSemiring<T, U>(
  base: Semiring<T>,
  to: (t: T) => U,
  from: (u: U) => T,
): Semiring<U> {
  const bEq = base.eq;
  const baseEq = (a: T, b: T): boolean => (bEq ? bEq(a, b) : a === b);
  return {
    zero: to(base.zero),
    one: to(base.one),
    add: (a, b) => to(base.add(from(a), from(b))),
    mul: (a, b) => to(base.mul(from(a), from(b))),
    eq: (a, b) => baseEq(from(a), from(b)),
  };
}
