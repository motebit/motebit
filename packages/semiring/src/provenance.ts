/**
 * Provenance semiring — answers "WHY did the system produce this result?"
 *
 * When an agent network routes a task through delegation chains,
 * provenance tracks which edges (delegations) contributed to the output.
 *
 * This is the algebraic answer to "explain this decision" — not a
 * separate logging system bolted on, but a first-class semiring query
 * over the same graph.
 *
 * The provenance semiring models derivation as sets of paths:
 *   ⊕ (parallel) = union of derivation sets (either route works)
 *   ⊗ (sequential) = cross-product of paths (both edges used)
 *   0 = empty set (no derivation)
 *   1 = {[]} (trivial derivation — identity)
 *
 * Each "path" is a sequence of edge labels (motebit IDs, tool names,
 * or whatever you label edges with).
 */

import type { Semiring } from "./semiring.js";

/**
 * A provenance value: a set of derivation paths.
 * Each path is an ordered sequence of edge labels explaining
 * how the result was derived through the graph.
 *
 * Represented as arrays for JSON-serializability and equality checks.
 */
export type Provenance = readonly (readonly string[])[];

/**
 * Provenance semiring over string-labeled edge paths.
 *
 * ⊕: union — "this result can be derived via routes A OR routes B"
 * ⊗: cross-product concatenation — "edge X followed by edge Y"
 *
 * Warning: provenance can grow exponentially in graphs with many
 * parallel paths. Use `boundedProvenanceSemiring` for production
 * graphs where you need to cap the explanation size.
 */
export const ProvenanceSemiring: Semiring<Provenance> = {
  zero: [],
  one: [[]],
  add: (a, b) => [...a, ...b],
  mul: (a, b) => {
    if (a.length === 0 || b.length === 0) return [];
    return a.flatMap((pa) => b.map((pb) => [...pa, ...pb]));
  },
};

/**
 * Bounded provenance semiring — caps the number of tracked derivation
 * paths to prevent exponential blowup in dense graphs.
 *
 * In production agent networks with 100+ nodes, unbounded provenance
 * is impractical. This variant keeps the top `maxPaths` shortest
 * derivations, which are usually the most useful for explanation.
 */
export function boundedProvenanceSemiring(maxPaths: number): Semiring<Provenance> {
  function trim(paths: Provenance): Provenance {
    if (paths.length <= maxPaths) return paths;
    // Keep shortest paths (fewest hops = simplest explanation)
    return [...paths].sort((a, b) => a.length - b.length).slice(0, maxPaths);
  }

  return {
    zero: [],
    one: [[]],
    add: (a, b) => trim([...a, ...b]),
    mul: (a, b) => {
      if (a.length === 0 || b.length === 0) return [];
      return trim(a.flatMap((pa) => b.map((pb) => [...pa, ...pb])));
    },
  };
}

/**
 * Annotated provenance: combine a value semiring with provenance tracking.
 *
 * This is a product semiring where the first component is the "answer"
 * (trust, cost, etc.) and the second is the provenance (why).
 *
 *   const AnnotatedTrust = annotatedSemiring(TrustSemiring);
 *   // Semiring<{ value: number; why: Provenance }>
 *
 * Now every query returns both the optimal value AND the derivation.
 */
export interface Annotated<T> {
  readonly value: T;
  readonly why: Provenance;
}

export function annotatedSemiring<T>(base: Semiring<T>, maxPaths = 100): Semiring<Annotated<T>> {
  const prov = boundedProvenanceSemiring(maxPaths);
  const bEq = base.eq;
  const baseEq = (a: T, b: T): boolean => (bEq ? bEq(a, b) : a === b);
  return {
    zero: { value: base.zero, why: prov.zero },
    one: { value: base.one, why: prov.one },
    add(a, b) {
      // For the value: use base ⊕. For provenance: union.
      // Note: we keep provenance from BOTH sides even if one "wins"
      // the value comparison, because provenance answers "what paths
      // exist" not "which path was best".
      return {
        value: base.add(a.value, b.value),
        why: prov.add(a.why, b.why),
      };
    },
    mul(a, b) {
      return {
        value: base.mul(a.value, b.value),
        why: prov.mul(a.why, b.why),
      };
    },
    eq(a, b) {
      return baseEq(a.value, b.value) && a.why.length === b.why.length;
    },
  };
}
