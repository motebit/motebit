import { describe, it, expect } from "vitest";
import { WeightedDigraph } from "../graph.js";
import { TrustSemiring, CostSemiring, BooleanSemiring, productSemiring } from "../semiring.js";
import { optimalPaths, optimalPath, transitiveClosure, optimalPathTrace } from "../traversal.js";

describe("optimalPaths — TrustSemiring (max, ×)", () => {
  it("finds most trusted chain through linear path", () => {
    const g = new WeightedDigraph(TrustSemiring);
    g.setEdge("A", "B", 0.9);
    g.setEdge("B", "C", 0.8);
    g.setEdge("C", "D", 0.7);

    const paths = optimalPaths(g, "A");
    expect(paths.get("A")).toBe(1); // self = identity
    expect(paths.get("B")).toBeCloseTo(0.9); // direct
    expect(paths.get("C")).toBeCloseTo(0.72); // 0.9 × 0.8
    expect(paths.get("D")).toBeCloseTo(0.504); // 0.9 × 0.8 × 0.7
  });

  it("picks best parallel path", () => {
    const g = new WeightedDigraph(TrustSemiring);
    // Direct: 0.5
    g.setEdge("A", "C", 0.5);
    // Via B: 0.9 × 0.8 = 0.72
    g.setEdge("A", "B", 0.9);
    g.setEdge("B", "C", 0.8);

    const paths = optimalPaths(g, "A");
    expect(paths.get("C")).toBeCloseTo(0.72); // via B wins
  });

  it("zero trust blocks the chain", () => {
    const g = new WeightedDigraph(TrustSemiring);
    g.setEdge("A", "B", 0.9);
    g.setEdge("B", "C", 0.0); // blocked
    g.setEdge("C", "D", 0.8);

    const paths = optimalPaths(g, "A");
    expect(paths.get("C")).toBe(0); // annihilated
    expect(paths.get("D")).toBe(0); // can't reach through zero
  });
});

describe("optimalPaths — CostSemiring (min, +)", () => {
  it("finds cheapest path", () => {
    const g = new WeightedDigraph(CostSemiring);
    // Direct: $10
    g.setEdge("A", "C", 10);
    // Via B: $3 + $4 = $7
    g.setEdge("A", "B", 3);
    g.setEdge("B", "C", 4);

    const paths = optimalPaths(g, "A");
    expect(paths.get("C")).toBe(7); // via B is cheaper
  });

  it("unreachable nodes stay at infinity", () => {
    const g = new WeightedDigraph(CostSemiring);
    g.setEdge("A", "B", 5);
    g.addNode("C"); // isolated

    const paths = optimalPaths(g, "A");
    expect(paths.get("C")).toBe(Infinity);
  });
});

describe("optimalPaths — BooleanSemiring (∨, ∧)", () => {
  it("determines reachability", () => {
    const g = new WeightedDigraph(BooleanSemiring);
    g.setEdge("A", "B", true);
    g.setEdge("B", "C", true);
    g.addNode("D"); // isolated

    const paths = optimalPaths(g, "A");
    expect(paths.get("B")).toBe(true);
    expect(paths.get("C")).toBe(true);
    expect(paths.get("D")).toBe(false);
  });
});

describe("optimalPaths — Product(Trust × Cost)", () => {
  it("computes multi-objective optimal simultaneously", () => {
    const ps = productSemiring(TrustSemiring, CostSemiring);
    const g = new WeightedDigraph(ps);

    // Edge A→B: trust 0.9, cost $3
    g.setEdge("A", "B", [0.9, 3] as const);
    // Edge B→C: trust 0.8, cost $4
    g.setEdge("B", "C", [0.8, 4] as const);

    const paths = optimalPaths(g, "A");
    const toC = paths.get("C")!;
    expect(toC[0]).toBeCloseTo(0.72); // trust: 0.9 × 0.8
    expect(toC[1]).toBe(7); // cost: 3 + 4
  });
});

describe("optimalPath — convenience", () => {
  it("returns single value between two nodes", () => {
    const g = new WeightedDigraph(TrustSemiring);
    g.setEdge("A", "B", 0.9);
    g.setEdge("B", "C", 0.8);

    expect(optimalPath(g, "A", "C")).toBeCloseTo(0.72);
  });

  it("returns zero for unreachable target", () => {
    const g = new WeightedDigraph(TrustSemiring);
    g.setEdge("A", "B", 0.9);
    g.addNode("C");

    expect(optimalPath(g, "A", "C")).toBe(0);
  });
});

describe("optimalPathTrace", () => {
  it("returns path and value", () => {
    const g = new WeightedDigraph(TrustSemiring);
    g.setEdge("A", "B", 0.9);
    g.setEdge("B", "C", 0.8);
    g.setEdge("A", "C", 0.5); // direct but worse

    const result = optimalPathTrace(g, "A", "C");
    expect(result).not.toBeNull();
    expect(result!.value).toBeCloseTo(0.72);
    expect(result!.path).toEqual(["A", "B", "C"]);
  });

  it("returns null for unreachable", () => {
    const g = new WeightedDigraph(TrustSemiring);
    g.setEdge("A", "B", 0.9);
    g.addNode("C");

    expect(optimalPathTrace(g, "A", "C")).toBeNull();
  });
});

describe("transitiveClosure — TrustSemiring", () => {
  it("computes all-pairs trust", () => {
    const g = new WeightedDigraph(TrustSemiring);
    g.setEdge("A", "B", 0.9);
    g.setEdge("B", "C", 0.8);
    g.setEdge("A", "C", 0.5);

    const closure = transitiveClosure(g);

    // A→A: identity = 1
    expect(closure.get("A")!.get("A")).toBe(1);
    // A→B: direct 0.9
    expect(closure.get("A")!.get("B")).toBeCloseTo(0.9);
    // A→C: max(direct 0.5, via B 0.72) = 0.72
    expect(closure.get("A")!.get("C")).toBeCloseTo(0.72);
    // B→A: no path = 0
    expect(closure.get("B")!.get("A")).toBe(0);
    // B→C: direct 0.8
    expect(closure.get("B")!.get("C")).toBeCloseTo(0.8);
  });

  it("handles cycles gracefully", () => {
    const g = new WeightedDigraph(TrustSemiring);
    g.setEdge("A", "B", 0.9);
    g.setEdge("B", "A", 0.8);

    const closure = transitiveClosure(g);
    // A→A through cycle: max(1, 0.9 × 0.8 × ... ) = 1 (identity wins)
    expect(closure.get("A")!.get("A")).toBe(1);
    expect(closure.get("A")!.get("B")).toBeCloseTo(0.9);
  });
});

describe("transitiveClosure — CostSemiring", () => {
  it("computes all-pairs cheapest routes", () => {
    const g = new WeightedDigraph(CostSemiring);
    g.setEdge("A", "B", 3);
    g.setEdge("B", "C", 4);
    g.setEdge("A", "C", 10);

    const closure = transitiveClosure(g);
    // A→C: min(direct 10, via B 7) = 7
    expect(closure.get("A")!.get("C")).toBe(7);
  });
});

describe("early termination", () => {
  it("converges quickly on already-optimal graphs", () => {
    const g = new WeightedDigraph(TrustSemiring);
    // Tree structure: no relaxation beyond first pass
    g.setEdge("root", "a", 0.9);
    g.setEdge("root", "b", 0.8);
    g.setEdge("a", "c", 0.7);
    g.setEdge("b", "d", 0.6);

    const paths = optimalPaths(g, "root");
    expect(paths.get("c")).toBeCloseTo(0.63); // 0.9 × 0.7
    expect(paths.get("d")).toBeCloseTo(0.48); // 0.8 × 0.6
  });
});
