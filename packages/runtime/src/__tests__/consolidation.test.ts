import { describe, it, expect } from "vitest";
import { clusterBySimilarity } from "@motebit/memory-graph";
import { SensitivityLevel, MemoryType } from "@motebit/sdk";
import type { MemoryNode } from "@motebit/sdk";

function makeNode(
  id: string,
  embedding: number[],
  overrides: Partial<MemoryNode> = {},
): MemoryNode {
  return {
    node_id: id,
    motebit_id: "test",
    content: `memory ${id}`,
    embedding,
    confidence: 0.7,
    sensitivity: SensitivityLevel.None,
    created_at: Date.now() - 2 * 24 * 60 * 60 * 1000, // 2 days ago
    last_accessed: Date.now() - 2 * 24 * 60 * 60 * 1000,
    half_life: 3 * 24 * 60 * 60 * 1000, // 3 days
    tombstoned: false,
    pinned: false,
    memory_type: MemoryType.Episodic,
    ...overrides,
  };
}

describe("clusterBySimilarity (episodic consolidation)", () => {
  it("clusters similar episodic memories correctly", () => {
    const nodes = [
      makeNode("a", [1, 0, 0]),
      makeNode("b", [0.98, 0.02, 0]),
      makeNode("c", [0, 0, 1]),
      makeNode("d", [0, 0.01, 0.99]),
    ];

    const clusters = clusterBySimilarity(nodes, 0.9);

    // a+b should cluster, c+d should cluster
    expect(clusters.length).toBe(2);
    const clusterIds = clusters.map(c => c.map(n => n.node_id).sort());
    expect(clusterIds).toContainEqual(["a", "b"]);
    expect(clusterIds).toContainEqual(["c", "d"]);
  });

  it("returns singletons for dissimilar vectors", () => {
    const nodes = [
      makeNode("a", [1, 0, 0]),
      makeNode("b", [0, 1, 0]),
      makeNode("c", [0, 0, 1]),
    ];

    const clusters = clusterBySimilarity(nodes, 0.9);
    expect(clusters.length).toBe(3);
    expect(clusters.every(c => c.length === 1)).toBe(true);
  });

  it("pinned memories would be excluded before clustering (filtering is caller responsibility)", () => {
    // This test verifies that the clustering function itself doesn't
    // filter — the caller (consolidateEpisodicMemories) handles filtering
    const nodes = [
      makeNode("a", [1, 0, 0], { pinned: true }),
      makeNode("b", [0.98, 0.02, 0]),
    ];

    // Clustering doesn't know about pinned — it just clusters
    const clusters = clusterBySimilarity(nodes, 0.9);
    expect(clusters.length).toBe(1);
    expect(clusters[0]!.length).toBe(2);
  });
});
