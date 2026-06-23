import { describe, it, expect } from "vitest";
import { SensitivityLevel, type MemoryNode, type MemorySource } from "@motebit/sdk";
import { recalledMemoryBasis, CONSEQUENTIAL_RECALL_SIMILARITY } from "../index.js";

/**
 * Inc-2/2.1 producer tests — `recalledMemoryBasis` mints the `recalled_memory`
 * / `consolidated_fact` leverage moment in the accrual source,
 * produced-not-authored. Doctrine: docs/doctrine/felt-accumulation.md.
 */
function makeNode(
  id: string,
  embedding: number[],
  opts: { sensitivity?: SensitivityLevel; tombstoned?: boolean; source?: MemorySource } = {},
): MemoryNode {
  return {
    node_id: id as MemoryNode["node_id"],
    motebit_id: "motebit-test" as MemoryNode["motebit_id"],
    embedding,
    created_at: 0,
    last_accessed: 0,
    half_life: 1e12,
    tombstoned: opts.tombstoned ?? false,
    pinned: false,
    content: `content-${id}`,
    confidence: 0.9,
    sensitivity: opts.sensitivity ?? SensitivityLevel.None,
    source: opts.source,
  };
}

const QUERY = [1, 0, 0]; // L2-normalized; dot product IS cosine similarity

describe("recalledMemoryBasis — the consequential-recall producer", () => {
  it("returns undefined for no nodes (fail-closed: no recall → no attribution)", () => {
    expect(recalledMemoryBasis(QUERY, [])).toBeUndefined();
  });

  it("returns undefined for an empty query embedding", () => {
    expect(recalledMemoryBasis([], [makeNode("a", [1, 0, 0])])).toBeUndefined();
  });

  it("returns undefined when every match is below the consequential bar", () => {
    // sim([1,0,0],[0,1,0]) = 0; sim([1,0,0],[0.5,0.5,0.707..]) ≈ 0.5 < 0.7
    const nodes = [makeNode("a", [0, 1, 0]), makeNode("b", [0.5, 0.5, Math.SQRT1_2])];
    expect(recalledMemoryBasis(QUERY, nodes)).toBeUndefined();
  });

  it("mints a recalled_memory basis for a strongly-similar memory", () => {
    const basis = recalledMemoryBasis(QUERY, [
      makeNode("weak", [0, 1, 0]),
      makeNode("strong", [1, 0, 0], { sensitivity: SensitivityLevel.Personal }),
    ]);
    expect(basis).toEqual({
      kind: "recalled_memory",
      sourceRef: "strong",
      sensitivity: SensitivityLevel.Personal,
    });
  });

  it("emits consolidated_fact when the leveraged memory is consolidation-derived (I pieced this together)", () => {
    const basis = recalledMemoryBasis(QUERY, [
      makeNode("synth", [1, 0, 0], { source: "consolidation_derived" }),
    ]);
    expect(basis?.kind).toBe("consolidated_fact");
    expect(basis?.sourceRef).toBe("synth"); // still points to the leveraged node
  });

  it("emits recalled_memory for user-stated or source-less memories (you told me)", () => {
    expect(
      recalledMemoryBasis(QUERY, [makeNode("u", [1, 0, 0], { source: "user_stated" })])?.kind,
    ).toBe("recalled_memory");
    expect(recalledMemoryBasis(QUERY, [makeNode("n", [1, 0, 0])])?.kind).toBe("recalled_memory");
  });

  it("picks the MOST similar memory when several clear the bar", () => {
    // [0.8,0.6,0]·[1,0,0] = 0.8 (≥0.7); [1,0,0]·[1,0,0] = 1.0 — strongest wins
    const basis = recalledMemoryBasis(QUERY, [
      makeNode("good", [0.8, 0.6, 0]),
      makeNode("best", [1, 0, 0]),
    ]);
    expect(basis?.sourceRef).toBe("best");
  });

  it("skips tombstoned memories even when they would match", () => {
    // The only above-bar node is tombstoned → nothing surfaces.
    const basis = recalledMemoryBasis(QUERY, [
      makeNode("dead", [1, 0, 0], { tombstoned: true }),
      makeNode("alive-but-weak", [0, 0, 1]),
    ]);
    expect(basis).toBeUndefined();
  });

  it("skips embeddings SHORTER than the query (unscorable without NaN)", () => {
    const basis = recalledMemoryBasis(QUERY, [
      makeNode("short", [1, 0]), // shorter than the 3-d query — would NaN under raw dotProduct
      makeNode("weak", [0, 1, 0]),
    ]);
    expect(basis).toBeUndefined();
  });

  it("scores embeddings LONGER than the query over the query's dims (the zero-padded-storage reality)", () => {
    // A 128-d hash zero-padded to 384-d: the query is shorter, the first dims
    // carry the signal, the padded tail is zeros. dotProduct over the query's
    // length is the true cosine — exactly how retrieval scores it.
    const basis = recalledMemoryBasis(QUERY, [makeNode("padded", [1, 0, 0, 0, 0])]);
    expect(basis?.sourceRef).toBe("padded");
  });

  it("carries the leveraged memory's own sensitivity (the render ceiling)", () => {
    const basis = recalledMemoryBasis(QUERY, [
      makeNode("m", [1, 0, 0], { sensitivity: SensitivityLevel.Medical }),
    ]);
    expect(basis?.sensitivity).toBe(SensitivityLevel.Medical);
  });

  it("honors a per-call minSimilarity override", () => {
    const half = [Math.SQRT1_2, Math.SQRT1_2, 0]; // sim 0.707 with QUERY
    expect(
      recalledMemoryBasis(QUERY, [makeNode("a", half)], { minSimilarity: 0.9 }),
    ).toBeUndefined();
    expect(
      recalledMemoryBasis(QUERY, [makeNode("a", half)], { minSimilarity: 0.5 })?.sourceRef,
    ).toBe("a");
  });

  it("the default bar is the conservative 0.7", () => {
    expect(CONSEQUENTIAL_RECALL_SIMILARITY).toBe(0.7);
  });
});
