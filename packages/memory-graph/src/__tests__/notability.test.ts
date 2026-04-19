import { describe, it, expect } from "vitest";
import {
  NotabilitySemiring,
  rankNotableMemories,
  formatNotabilitySummary,
  scoreNode,
} from "../notability.js";
import type { MemoryNode, MemoryEdge } from "@motebit/sdk";
import { SensitivityLevel, RelationType } from "@motebit/sdk";

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

function makeNode(overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    node_id: crypto.randomUUID() as MemoryNode["node_id"],
    motebit_id: "test-mote" as MemoryNode["motebit_id"],
    content: "test memory content",
    confidence: 0.8,
    sensitivity: SensitivityLevel.None,
    embedding: [0.1, 0.2, 0.3],
    created_at: NOW - 1000,
    last_accessed: NOW - 1000,
    half_life: 30 * DAY,
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

describe("NotabilitySemiring", () => {
  it("satisfies identity laws (zero is add-identity, one is mul-identity)", () => {
    const s = NotabilitySemiring;
    const x = { phantom: 0.4, conflict: 0.6, decay: 0.1 };
    expect(s.add(x, s.zero)).toEqual(x);
    expect(s.add(s.zero, x)).toEqual(x);
    expect(s.mul(x, s.one)).toEqual(x);
    expect(s.mul(s.one, x)).toEqual(x);
  });

  it("zero annihilates under mul", () => {
    const s = NotabilitySemiring;
    const x = { phantom: 0.7, conflict: 0.3, decay: 0.5 };
    expect(s.mul(x, s.zero)).toEqual(s.zero);
    expect(s.mul(s.zero, x)).toEqual(s.zero);
  });

  it("add is pointwise max (TrustSemiring composition)", () => {
    const s = NotabilitySemiring;
    const a = { phantom: 0.8, conflict: 0.2, decay: 0.5 };
    const b = { phantom: 0.4, conflict: 0.9, decay: 0.1 };
    expect(s.add(a, b)).toEqual({ phantom: 0.8, conflict: 0.9, decay: 0.5 });
  });

  it("mul is pointwise product (TrustSemiring composition)", () => {
    const s = NotabilitySemiring;
    const a = { phantom: 0.5, conflict: 0.4, decay: 0.5 };
    const b = { phantom: 0.2, conflict: 0.25, decay: 0.2 };
    const r = s.mul(a, b);
    expect(r.phantom).toBeCloseTo(0.1, 10);
    expect(r.conflict).toBeCloseTo(0.1, 10);
    expect(r.decay).toBeCloseTo(0.1, 10);
  });
});

describe("scoreNode", () => {
  it("returns zero for pinned nodes", () => {
    const node = makeNode({ pinned: true, confidence: 0.9 });
    const score = scoreNode(node, 0, false, 0.9, { nowMs: NOW });
    expect(score).toEqual(NotabilitySemiring.zero);
  });

  it("returns zero for tombstoned nodes", () => {
    const node = makeNode({ tombstoned: true, confidence: 0.9 });
    const score = scoreNode(node, 0, false, 0.9, { nowMs: NOW });
    expect(score).toEqual(NotabilitySemiring.zero);
  });

  it("flags isolated high-confidence nodes on the phantom axis", () => {
    const node = makeNode({ confidence: 0.9 });
    const score = scoreNode(node, 0, false, 0.9, { nowMs: NOW });
    expect(score.phantom).toBeGreaterThan(0);
    expect(score.conflict).toBe(0);
    expect(score.decay).toBe(0);
  });

  it("flags near-death nodes on the decay axis", () => {
    const node = makeNode({ confidence: 0.9 });
    const score = scoreNode(node, 3, false, 0.05, { nowMs: NOW });
    expect(score.decay).toBeGreaterThan(0);
    expect(score.phantom).toBe(0);
  });

  it("flags conflict-partnered nodes on the conflict axis", () => {
    const node = makeNode({ confidence: 0.9 });
    const score = scoreNode(node, 2, true, 0.6, { nowMs: NOW });
    expect(score.conflict).toBeGreaterThan(0);
  });
});

describe("rankNotableMemories", () => {
  it("returns an empty list when nothing is notable", () => {
    const a = makeNode({ confidence: 0.3 });
    const b = makeNode({ confidence: 0.3 });
    const c = makeNode({ confidence: 0.3 });
    const edges = [makeEdge(a.node_id, b.node_id), makeEdge(b.node_id, c.node_id)];
    expect(rankNotableMemories([a, b, c], edges, { nowMs: NOW })).toEqual([]);
  });

  it("ranks phantom certainties above connected nodes", () => {
    const isolated = makeNode({ content: "isolated belief", confidence: 0.95 });
    const connected1 = makeNode({ content: "connected 1" });
    const connected2 = makeNode({ content: "connected 2" });
    const edge = makeEdge(connected1.node_id, connected2.node_id);
    const ranked = rankNotableMemories([isolated, connected1, connected2], [edge], {
      nowMs: NOW,
    });
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0]!.node.node_id).toBe(isolated.node_id);
    expect(ranked[0]!.dominantReason).toBe("phantom");
  });

  it("surfaces conflicts with both partners connected", () => {
    const a = makeNode({ content: "sky is blue" });
    const b = makeNode({ content: "sky is green" });
    const conflictEdge = makeEdge(a.node_id, b.node_id, RelationType.ConflictsWith);
    const ranked = rankNotableMemories([a, b], [conflictEdge], { nowMs: NOW });
    expect(ranked).toHaveLength(2);
    expect(ranked.every((r) => r.dominantReason === "conflict")).toBe(true);
    expect(ranked[0]!.conflictPartner).toBeDefined();
  });

  it("respects the limit", () => {
    const nodes = Array.from({ length: 15 }, (_, i) =>
      makeNode({ content: `isolated ${i}`, confidence: 0.9 }),
    );
    const ranked = rankNotableMemories(nodes, [], { nowMs: NOW, limit: 5 });
    expect(ranked).toHaveLength(5);
  });

  it("excludes pinned and tombstoned nodes", () => {
    const pinned = makeNode({ content: "pinned isolated", confidence: 0.95, pinned: true });
    const dead = makeNode({
      content: "dead isolated",
      confidence: 0.95,
      tombstoned: true,
    });
    const notable = makeNode({ content: "live isolated", confidence: 0.95 });
    const ranked = rankNotableMemories([pinned, dead, notable], [], { nowMs: NOW });
    expect(ranked.every((r) => r.node.node_id === notable.node_id)).toBe(true);
  });

  it("weights dimensions when options override defaults (semiring swap invariance)", () => {
    const phantom = makeNode({ content: "phantom", confidence: 0.9 });
    const decaying = makeNode({
      content: "decaying",
      confidence: 1,
      created_at: NOW - 365 * DAY,
      half_life: DAY,
    });
    const rankedDefault = rankNotableMemories([phantom, decaying], [], { nowMs: NOW });
    const rankedPhantomHeavy = rankNotableMemories([phantom, decaying], [], {
      nowMs: NOW,
      phantomWeight: 2,
      decayWeight: 0.01,
    });
    expect(rankedDefault.some((r) => r.dominantReason === "decay")).toBe(true);
    expect(rankedPhantomHeavy[0]!.node.node_id).toBe(phantom.node_id);
    expect(rankedPhantomHeavy[0]!.dominantReason).toBe("phantom");
  });
});

describe("formatNotabilitySummary", () => {
  it("returns undefined for an empty list", () => {
    expect(formatNotabilitySummary([])).toBeUndefined();
  });

  it("formats each reason with its canonical tag", () => {
    const a = makeNode({ content: "isolated belief", confidence: 0.95 });
    const b1 = makeNode({ content: "sky is blue" });
    const b2 = makeNode({ content: "sky is green" });
    const conflict = makeEdge(b1.node_id, b2.node_id, RelationType.ConflictsWith);
    const ranked = rankNotableMemories([a, b1, b2], [conflict], { nowMs: NOW });
    const summary = formatNotabilitySummary(ranked);
    expect(summary).toBeDefined();
    expect(summary).toMatch(/Notable memories this period/);
    expect(summary).toMatch(/\[phantom|\[conflict|\[fading/);
  });
});
