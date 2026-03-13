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

/** (∨, ∧, false, true) — can agent A reach agent B? */
export const BooleanSemiring: Semiring<boolean> = {
  zero: false,
  one: true,
  add: (a, b) => a || b,
  mul: (a, b) => a && b,
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
  return {
    zero: [sa.zero, sb.zero] as const,
    one: [sa.one, sb.one] as const,
    add: (x, y) => [sa.add(x[0], y[0]), sb.add(x[1], y[1])] as const,
    mul: (x, y) => [sa.mul(x[0], y[0]), sb.mul(x[1], y[1])] as const,
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
  for (const k of keys) {
    zero[k] = fields[k]!.zero as R[typeof k];
    one[k] = fields[k]!.one as R[typeof k];
  }
  return {
    zero,
    one,
    add(a, b) {
      const r = {} as R;
      for (const k of keys) r[k] = fields[k]!.add(a[k], b[k]) as R[typeof k];
      return r;
    },
    mul(a, b) {
      const r = {} as R;
      for (const k of keys) r[k] = fields[k]!.mul(a[k], b[k]) as R[typeof k];
      return r;
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
  return {
    zero: to(base.zero),
    one: to(base.one),
    add: (a, b) => to(base.add(from(a), from(b))),
    mul: (a, b) => to(base.mul(from(a), from(b))),
  };
}
