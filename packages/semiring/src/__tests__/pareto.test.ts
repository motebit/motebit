/**
 * The Pareto frontier semiring: every element is a route that exists, carrying
 * exactly the metrics its own edges compose to. The record semiring's
 * component-wise mixture is what this replaces for ranking.
 */
import { describe, it, expect } from "vitest";
import { WeightedDigraph } from "../graph.js";
import { TrustSemiring, CostSemiring } from "../semiring.js";
import { recordSemiring } from "@motebit/protocol";
import {
  paretoPathSemiring,
  frontierPaths,
  chooseFromFrontier,
  dominatesOrEquals,
  DEFAULT_MAX_FRONTIER_PATHS,
} from "../pareto.js";
import type { Frontier, PathWeight } from "../pareto.js";
import { ROUTE_WEIGHT_DIMENSIONS, RouteWeightSemiring } from "../agent-network.js";
import type { RouteWeight } from "../agent-network.js";

interface TC {
  trust: number;
  cost: number;
}
const dims = { trust: TrustSemiring, cost: CostSemiring };
const pw = (trust: number, cost: number, ...path: string[]): PathWeight<TC> => ({
  weight: { trust, cost },
  path,
});
const key = (f: Frontier<TC>) =>
  f.map((p) => `${p.path.join(">")}:${p.weight.trust}/${p.weight.cost}`);

describe("dominatesOrEquals", () => {
  it("is judged per dimension by that dimension's own ⊕ (max for trust, min for cost)", () => {
    expect(dominatesOrEquals(dims, { trust: 0.9, cost: 1 }, { trust: 0.5, cost: 2 })).toBe(true);
    expect(dominatesOrEquals(dims, { trust: 0.9, cost: 3 }, { trust: 0.5, cost: 2 })).toBe(false);
    expect(dominatesOrEquals(dims, { trust: 0.5, cost: 2 }, { trust: 0.5, cost: 2 })).toBe(true);
  });
});

describe("paretoPathSemiring", () => {
  const sr = paretoPathSemiring(dims);

  it("⊕ keeps every non-dominated pair and drops every dominated one", () => {
    const a: Frontier<TC> = [pw(0.9, 10, "x")];
    const b: Frontier<TC> = [pw(0.5, 1, "y"), pw(0.4, 5, "z")];
    // x (trusted, expensive) and y (cheap, less trusted) trade off; z is dominated by y.
    expect(key(sr.add(a, b))).toEqual(["x:0.9/10", "y:0.5/1"]);
  });

  it("⊕ is idempotent and commutative; equal weights keep the fewest-hop path", () => {
    const a: Frontier<TC> = [pw(0.9, 10, "x")];
    const b: Frontier<TC> = [pw(0.5, 1, "y")];
    expect(sr.eq!(sr.add(a, a), a)).toBe(true);
    expect(sr.eq!(sr.add(a, b), sr.add(b, a))).toBe(true);
    const twoHop: Frontier<TC> = [pw(0.9, 10, "p", "x")];
    expect(key(sr.add(twoHop, a))).toEqual(["x:0.9/10"]);
  });

  it("⊗ composes weight AND path pairwise, then prunes", () => {
    const a: Frontier<TC> = [pw(0.9, 1, "a"), pw(0.5, 0.5, "b")];
    const b: Frontier<TC> = [pw(0.8, 2, "c")];
    const out = sr.mul(a, b);
    expect(out).toEqual([
      { weight: { trust: 0.9 * 0.8, cost: 3 }, path: ["a", "c"] },
      { weight: { trust: 0.5 * 0.8, cost: 2.5 }, path: ["b", "c"] },
    ]);
  });

  it("0 annihilates, 1 is the identity, and ⊗ distributes over ⊕", () => {
    const a: Frontier<TC> = [pw(0.9, 1, "a")];
    const b: Frontier<TC> = [pw(0.7, 2, "b")];
    const c: Frontier<TC> = [pw(0.6, 1, "c")];
    expect(sr.mul(a, sr.zero)).toEqual([]);
    expect(sr.mul(sr.zero, a)).toEqual([]);
    expect(sr.eq!(sr.mul(a, sr.one), a)).toBe(true);
    expect(sr.eq!(sr.mul(sr.one, a), a)).toBe(true);
    const lhs = sr.mul(a, sr.add(b, c));
    const rhs = sr.add(sr.mul(a, b), sr.mul(a, c));
    expect(sr.eq!(lhs, rhs)).toBe(true);
  });

  it("bounds the frontier by fewest hops when it exceeds maxPaths", () => {
    const bounded = paretoPathSemiring(dims, { maxPaths: 2 });
    // Four mutually non-dominated pairs.
    const f: Frontier<TC> = [
      pw(0.9, 4, "a", "b", "c"),
      pw(0.8, 3, "d", "e"),
      pw(0.7, 2, "f"),
      pw(0.6, 1, "g", "h"),
    ];
    expect(key(bounded.add(f, []))).toEqual(["f:0.7/2", "d>e:0.8/3"]);
    expect(DEFAULT_MAX_FRONTIER_PATHS).toBe(32);
  });
});

describe("frontierPaths", () => {
  function diamond(): WeightedDigraph<TC> {
    const g = new WeightedDigraph<TC>(recordSemiring(dims));
    for (const n of ["s", "t", "w"]) g.addNode(n);
    g.setEdge("s", "w", { trust: 0.2, cost: 1 }); // cheap, less trusted
    g.setEdge("s", "t", { trust: 0.9, cost: 5 });
    g.setEdge("t", "w", { trust: 0.9, cost: 5 }); // trusted, expensive
    return g;
  }

  it("returns, per node, the set of real routes — never the component-wise mixture", () => {
    const g = diamond();
    const mixture = recordSemiring(dims);
    // What the record semiring reports for w: best trust of one path beside best cost of the other.
    const mixed = mixture.add({ trust: 0.2, cost: 1 }, { trust: 0.81, cost: 10 });
    expect(mixed).toEqual({ trust: 0.81, cost: 1 }); // a route that does not exist

    const w = frontierPaths(g, dims, "s").get("w")!;
    expect(w).toEqual([
      { weight: { trust: 0.2, cost: 1 }, path: ["w"] },
      { weight: { trust: 0.9 * 0.9, cost: 10 }, path: ["t", "w"] },
    ]);
    for (const p of w) expect(p.weight).not.toEqual(mixed);
  });

  it("drops a route another route dominates in every dimension", () => {
    const g = diamond();
    g.setEdge("s", "t", { trust: 0.9, cost: 0 });
    g.setEdge("t", "w", { trust: 0.9, cost: 0 }); // via t is now cheaper AND more trusted
    const w = frontierPaths(g, dims, "s").get("w")!;
    expect(w).toEqual([{ weight: { trust: 0.81, cost: 0 }, path: ["t", "w"] }]);
  });

  it("unreachable nodes have the empty frontier; the source has the empty route", () => {
    const g = diamond();
    g.addNode("island");
    const f = frontierPaths(g, dims, "s");
    expect(f.get("island")).toEqual([]);
    expect(f.get("s")).toEqual([{ weight: { trust: 1, cost: 0 }, path: [] }]);
  });

  it("works over the full RouteWeight record the market uses", () => {
    const g = new WeightedDigraph<RouteWeight>(RouteWeightSemiring);
    for (const n of ["s", "a", "b"]) g.addNode(n);
    const e1: RouteWeight = {
      trust: 0.9,
      cost: 1,
      latency: 50,
      reliability: 0.9,
      regulatory_risk: 0,
    };
    const e2: RouteWeight = {
      trust: 0.8,
      cost: 2,
      latency: 70,
      reliability: 0.8,
      regulatory_risk: 1,
    };
    g.setEdge("s", "a", e1);
    g.setEdge("a", "b", e2);
    const b = frontierPaths(g, ROUTE_WEIGHT_DIMENSIONS, "s").get("b")!;
    expect(b).toEqual([
      {
        weight: {
          trust: e1.trust * e2.trust,
          cost: e1.cost + e2.cost,
          latency: e1.latency + e2.latency,
          reliability: e1.reliability * e2.reliability,
          regulatory_risk: e1.regulatory_risk + e2.regulatory_risk,
        },
        path: ["a", "b"],
      },
    ]);
  });
});

describe("frontierPaths against brute-force enumeration", () => {
  // Seeded LCG so the graphs are reproducible.
  function rng(seed: number): () => number {
    let x = seed >>> 0;
    return () => {
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
      return x / 2 ** 32;
    };
  }
  type Edge = { from: string; to: string; w: TC };
  function randomGraph(seed: number, n: number, density: number): Edge[] {
    const r = rng(seed);
    const nodes = Array.from({ length: n }, (_, i) => `n${i}`);
    const edges: Edge[] = [];
    for (const a of nodes)
      for (const b of nodes) {
        if (a === b || r() > density) continue;
        edges.push({
          from: a,
          to: b,
          w: { trust: Math.round(r() * 9 + 1) / 10, cost: Math.round(r() * 9 + 1) },
        });
      }
    return edges;
  }
  /** All simple paths from `src`, composed under the record semiring, then Pareto-filtered with the same tie rule. */
  function bruteForce(edges: Edge[], src: string): Map<string, Frontier<TC>> {
    const out = new Map<string, PathWeight<TC>[]>();
    const rec = recordSemiring(dims);
    const walk = (at: string, seen: Set<string>, w: TC, path: string[]) => {
      for (const e of edges) {
        if (e.from !== at || seen.has(e.to)) continue;
        const nw = rec.mul(w, e.w);
        const np = [...path, e.to];
        (out.get(e.to) ?? out.set(e.to, []).get(e.to)!).push({ weight: nw, path: np });
        walk(e.to, new Set([...seen, e.to]), nw, np);
      }
    };
    walk(src, new Set([src]), rec.one, []);
    const pareto = new Map<string, Frontier<TC>>();
    for (const [node, items] of out) {
      const kept = items.filter(
        (x) =>
          !items.some(
            (y) =>
              y !== x &&
              dominatesOrEquals(dims, y.weight, x.weight) &&
              (!dominatesOrEquals(dims, x.weight, y.weight) ||
                y.path.length < x.path.length ||
                (y.path.length === x.path.length && y.path.join(" ") < x.path.join(" "))),
          ),
      );
      pareto.set(node, kept);
    }
    return pareto;
  }
  const canon = (f: Frontier<TC> | undefined) =>
    [...(f ?? [])].map((p) => `${p.path.join(">")}:${p.weight.trust}/${p.weight.cost}`).sort();

  it("unbounded, equals the exact Pareto set of simple paths, for every node, on 40 random graphs", () => {
    const sr = recordSemiring(dims);
    for (let seed = 1; seed <= 40; seed++) {
      const edges = randomGraph(seed, 6, 0.45);
      const g = new WeightedDigraph<TC>(sr);
      for (let i = 0; i < 6; i++) g.addNode(`n${i}`);
      for (const e of edges) g.setEdge(e.from, e.to, e.w);
      const got = frontierPaths(g, dims, "n0", { maxPaths: Number.POSITIVE_INFINITY });
      const want = bruteForce(edges, "n0");
      for (let i = 1; i < 6; i++) {
        expect(canon(got.get(`n${i}`)), `seed ${seed} node n${i}`).toEqual(
          canon(want.get(`n${i}`)),
        );
      }
    }
  });

  it("is invariant under edge insertion order", () => {
    const sr = recordSemiring(dims);
    for (let seed = 41; seed <= 60; seed++) {
      const edges = randomGraph(seed, 6, 0.5);
      const build = (order: Edge[]) => {
        const g = new WeightedDigraph<TC>(sr);
        for (let i = 0; i < 6; i++) g.addNode(`n${i}`);
        for (const e of order) g.setEdge(e.from, e.to, e.w);
        return frontierPaths(g, dims, "n0");
      };
      const a = build(edges);
      const b = build([...edges].reverse());
      const r = rng(seed);
      const c = build([...edges].sort(() => r() - 0.5));
      for (let i = 1; i < 6; i++) {
        expect(canon(b.get(`n${i}`))).toEqual(canon(a.get(`n${i}`)));
        expect(canon(c.get(`n${i}`))).toEqual(canon(a.get(`n${i}`)));
      }
    }
  });

  it("the bound is an approximation: it can drop the pair a policy would pick (documented contract 3)", () => {
    const g = new WeightedDigraph<TC>(recordSemiring(dims));
    for (const n of ["s", "a", "b", "w"]) g.addNode(n);
    g.setEdge("s", "w", { trust: 0.3, cost: 1 }); // 1 hop
    g.setEdge("s", "a", { trust: 0.7, cost: 2 });
    g.setEdge("a", "w", { trust: 0.7, cost: 2 }); // 2 hops, trust 0.49 — the best trust
    g.setEdge("s", "b", { trust: 0.6, cost: 1.5 });
    g.setEdge("b", "w", { trust: 0.6, cost: 1.5 }); // 2 hops, trust 0.36
    const exact = frontierPaths(g, dims, "s").get("w")!;
    expect(exact.length).toBe(3);
    const bounded = frontierPaths(g, dims, "s", { maxPaths: 1 }).get("w")!;
    expect(bounded.map((p) => p.path)).toEqual([["w"]]); // fewest hops survive
    const best = chooseFromFrontier(exact, (w) => w.trust)!.chosen;
    expect(best.path).toEqual(["a", "w"]);
    expect(bounded.some((p) => p.path.join() === best.path.join())).toBe(false);
  });
});

describe("chooseFromFrontier", () => {
  const f: Frontier<TC> = [pw(0.2, 1, "w"), pw(0.81, 10, "t", "w")];

  it("a policy chooses AMONG real routes; the chosen route's metrics are its own", () => {
    const trustFirst = chooseFromFrontier(f, (w) => w.trust)!;
    expect(trustFirst.chosen).toEqual(pw(0.81, 10, "t", "w"));
    expect(trustFirst.ordered.map((p) => p.path)).toEqual([["t", "w"], ["w"]]);
    const costFirst = chooseFromFrontier(f, (w) => -w.cost)!;
    expect(costFirst.chosen).toEqual(pw(0.2, 1, "w"));
    expect(costFirst.score).toBe(-1);
  });

  it("ties break toward fewer hops, then lexicographic path; NaN never wins; empty → null", () => {
    const tie = chooseFromFrontier(f, () => 0)!;
    expect(tie.chosen.path).toEqual(["w"]);
    const nanForShort = chooseFromFrontier(f, (_w, path) => (path.length === 1 ? NaN : 1))!;
    expect(nanForShort.chosen.path).toEqual(["t", "w"]);
    expect(chooseFromFrontier([], () => 1)).toBeNull();
  });
});
