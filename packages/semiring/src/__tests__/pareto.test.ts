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
