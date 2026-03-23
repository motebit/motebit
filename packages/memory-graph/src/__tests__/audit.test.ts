import { describe, it, expect } from "vitest";
import { auditMemoryGraph } from "../index.js";
import type { MemoryNode, MemoryEdge } from "@motebit/sdk";
import { SensitivityLevel, RelationType } from "@motebit/sdk";

function makeNode(overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    node_id: crypto.randomUUID() as MemoryNode["node_id"],
    motebit_id: "test-mote" as MemoryNode["motebit_id"],
    content: "test memory content",
    confidence: 0.8,
    sensitivity: SensitivityLevel.None,
    embedding: [0.1, 0.2, 0.3],
    created_at: Date.now() - 1000,
    last_accessed: Date.now() - 1000,
    half_life: 30 * 86_400_000,
    tombstoned: false,
    pinned: false,
    ...overrides,
  };
}

function makeEdge(
  sourceId: string,
  targetId: string,
  relationType = RelationType.Related,
): MemoryEdge {
  return {
    edge_id: crypto.randomUUID(),
    source_id: sourceId as MemoryEdge["source_id"],
    target_id: targetId as MemoryEdge["target_id"],
    relation_type: relationType,
    weight: 1,
    confidence: 0.9,
  };
}

describe("auditMemoryGraph", () => {
  it("returns empty results for a well-connected graph", () => {
    const a = makeNode({ content: "node A" });
    const b = makeNode({ content: "node B" });
    const c = makeNode({ content: "node C" });
    const e1 = makeEdge(a.node_id, b.node_id);
    const e2 = makeEdge(a.node_id, c.node_id);
    const e3 = makeEdge(b.node_id, c.node_id);

    const result = auditMemoryGraph([a, b, c], [e1, e2, e3]);
    expect(result.nodesAudited).toBe(3);
    expect(result.phantomCertainties).toHaveLength(0);
    expect(result.conflicts).toHaveLength(0);
    expect(result.nearDeath).toHaveLength(0);
  });

  it("flags high-confidence nodes with zero edges as phantom certainties", () => {
    const isolated = makeNode({ content: "isolated belief", confidence: 0.9 });
    const connected = makeNode({ content: "connected" });
    const edge = makeEdge(connected.node_id, connected.node_id);

    const result = auditMemoryGraph([isolated, connected], [edge]);
    expect(result.phantomCertainties).toHaveLength(1);
    expect(result.phantomCertainties[0]!.node.node_id).toBe(isolated.node_id);
    expect(result.phantomCertainties[0]!.edgeCount).toBe(0);
    expect(result.phantomCertainties[0]!.reason).toContain("isolated");
  });

  it("does not flag pinned nodes as phantom certainties", () => {
    const pinned = makeNode({ content: "pinned", confidence: 0.9, pinned: true });
    const result = auditMemoryGraph([pinned], []);
    expect(result.phantomCertainties).toHaveLength(0);
  });

  it("does not flag tombstoned nodes", () => {
    const dead = makeNode({ content: "dead", confidence: 0.9, tombstoned: true });
    const result = auditMemoryGraph([dead], []);
    expect(result.nodesAudited).toBe(0);
    expect(result.phantomCertainties).toHaveLength(0);
  });

  it("flags ConflictsWith edges as conflicts", () => {
    const a = makeNode({ content: "the sky is blue" });
    const b = makeNode({ content: "the sky is green" });
    const conflict = makeEdge(a.node_id, b.node_id, RelationType.ConflictsWith);

    const result = auditMemoryGraph([a, b], [conflict]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.a.node_id).toBe(a.node_id);
    expect(result.conflicts[0]!.b.node_id).toBe(b.node_id);
  });

  it("flags nodes with very low decayed confidence as near-death", () => {
    const old = makeNode({
      content: "fading memory",
      confidence: 0.5,
      half_life: 1000, // 1 second half-life
      created_at: Date.now() - 60_000, // 60 seconds ago — many half-lives
    });

    const result = auditMemoryGraph([old], []);
    expect(result.nearDeath.length).toBeGreaterThan(0);
    expect(result.nearDeath[0]!.decayedConfidence).toBeLessThan(0.15);
  });

  it("sorts phantom certainties by confidence descending", () => {
    const high = makeNode({ content: "very confident", confidence: 0.95 });
    const mid = makeNode({ content: "moderately confident", confidence: 0.7 });

    const result = auditMemoryGraph([high, mid], []);
    expect(result.phantomCertainties).toHaveLength(2);
    expect(result.phantomCertainties[0]!.decayedConfidence).toBeGreaterThan(
      result.phantomCertainties[1]!.decayedConfidence,
    );
  });

  it("respects limit option", () => {
    const nodes = Array.from({ length: 20 }, (_, i) =>
      makeNode({ content: `node ${i}`, confidence: 0.8 }),
    );
    const result = auditMemoryGraph(nodes, [], { limit: 3 });
    expect(result.phantomCertainties.length).toBeLessThanOrEqual(3);
  });
});
