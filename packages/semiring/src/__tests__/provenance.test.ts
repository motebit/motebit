import { describe, it, expect } from "vitest";
import { ProvenanceSemiring, boundedProvenanceSemiring, annotatedSemiring } from "../provenance.js";
import { TrustSemiring } from "../semiring.js";
import { WeightedDigraph } from "../graph.js";
import { optimalPaths } from "../traversal.js";
import type { Annotated } from "../provenance.js";

describe("ProvenanceSemiring", () => {
  const sr = ProvenanceSemiring;

  it("zero is empty (no derivation)", () => {
    expect(sr.zero).toEqual([]);
  });

  it("one is trivial derivation", () => {
    expect(sr.one).toEqual([[]]);
  });

  it("add unions derivation sets", () => {
    const a = [["x", "y"]];
    const b = [["z"]];
    expect(sr.add(a, b)).toEqual([["x", "y"], ["z"]]);
  });

  it("mul concatenates paths (cross product)", () => {
    const a = [["x"]];
    const b = [["y"]];
    expect(sr.mul(a, b)).toEqual([["x", "y"]]);
  });

  it("mul with multiple paths produces cross product", () => {
    const a = [["x"], ["y"]];
    const b = [["1"], ["2"]];
    const result = sr.mul(a, b);
    expect(result).toEqual([
      ["x", "1"],
      ["x", "2"],
      ["y", "1"],
      ["y", "2"],
    ]);
  });

  it("zero annihilates", () => {
    expect(sr.mul([["x"]], [])).toEqual([]);
    expect(sr.mul([], [["y"]])).toEqual([]);
  });

  it("one is multiplicative identity", () => {
    const a = [["x", "y"]];
    expect(sr.mul(a, sr.one)).toEqual([["x", "y"]]);
    expect(sr.mul(sr.one, a)).toEqual([["x", "y"]]);
  });
});

describe("boundedProvenanceSemiring", () => {
  it("caps paths at maxPaths", () => {
    const sr = boundedProvenanceSemiring(2);
    const a = [["x"]];
    const b = [["y"]];
    const c = [["z"]];
    const result = sr.add(sr.add(a, b), c);
    expect(result.length).toBeLessThanOrEqual(2);
  });

  it("keeps shortest paths", () => {
    const sr = boundedProvenanceSemiring(1);
    const short = [["a"]];
    const long = [["a", "b", "c"]];
    const result = sr.add(short, long);
    expect(result).toEqual([["a"]]);
  });

  it("trims mul results when cross product exceeds maxPaths", () => {
    const sr = boundedProvenanceSemiring(2);
    // 3 × 2 = 6 paths, trimmed to 2
    const a = [["x"], ["y"], ["z"]];
    const b = [["1"], ["2"]];
    const result = sr.mul(a, b);
    expect(result.length).toBeLessThanOrEqual(2);
    // Shortest paths have length 2 (each is a 1-element + 1-element concat)
    for (const path of result) {
      expect(path.length).toBe(2);
    }
  });

  it("mul returns empty when either operand is empty", () => {
    const sr = boundedProvenanceSemiring(5);
    expect(sr.mul([], [["a"]])).toEqual([]);
    expect(sr.mul([["a"]], [])).toEqual([]);
  });
});

describe("annotatedSemiring — trust with provenance", () => {
  it("tracks WHY a trust path was computed", () => {
    const sr = annotatedSemiring(TrustSemiring);
    const g = new WeightedDigraph(sr);

    // Label edges with agent IDs for provenance
    const edgeAB: Annotated<number> = { value: 0.9, why: [["agent-B"]] };
    const edgeBC: Annotated<number> = { value: 0.8, why: [["agent-C"]] };
    const edgeAC: Annotated<number> = { value: 0.5, why: [["agent-C-direct"]] };

    g.setEdge("A", "B", edgeAB);
    g.setEdge("B", "C", edgeBC);
    g.setEdge("A", "C", edgeAC);

    const paths = optimalPaths(g, "A");
    const toC = paths.get("C")!;

    // Value: max(0.5, 0.9×0.8) = 0.72
    expect(toC.value).toBeCloseTo(0.72);

    // Provenance: both paths are recorded (even though via-B has better value)
    // Direct path: ["agent-C-direct"]
    // Via B: ["agent-B", "agent-C"]
    expect(toC.why.length).toBeGreaterThanOrEqual(1);

    // The via-B path should be present
    const hasTwoHopPath = toC.why.some(
      (p) => p.length === 2 && p[0] === "agent-B" && p[1] === "agent-C",
    );
    expect(hasTwoHopPath).toBe(true);
  });

  it("provenance for unreachable nodes is empty", () => {
    const sr = annotatedSemiring(TrustSemiring);
    const g = new WeightedDigraph(sr);
    g.setEdge("A", "B", { value: 0.9, why: [["B"]] });
    g.addNode("C");

    const paths = optimalPaths(g, "A");
    expect(paths.get("C")!.value).toBe(0);
    expect(paths.get("C")!.why).toEqual([]);
  });
});
