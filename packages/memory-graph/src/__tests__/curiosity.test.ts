import { describe, it, expect } from "vitest";
import { findCuriosityTargets } from "../index";
import type { MemoryNode } from "@motebit/sdk";
import { SensitivityLevel, MemoryType } from "@motebit/sdk";

const DAY = 24 * 60 * 60 * 1000;
const HALF_LIFE = 30 * DAY;

function makeNode(overrides: Partial<MemoryNode> = {}): MemoryNode {
  const now = Date.now();
  return {
    node_id: crypto.randomUUID(),
    motebit_id: "test",
    content: "test memory",
    embedding: [],
    confidence: 0.8,
    sensitivity: SensitivityLevel.None,
    created_at: now - 20 * DAY,
    last_accessed: now - 20 * DAY,
    half_life: HALF_LIFE,
    tombstoned: false,
    pinned: false,
    memory_type: MemoryType.Semantic,
    valid_from: now - 20 * DAY,
    ...overrides,
  };
}

describe("findCuriosityTargets", () => {
  it("returns empty for empty input", () => {
    expect(findCuriosityTargets([])).toEqual([]);
  });

  it("returns empty when all nodes are pinned", () => {
    const nodes = [makeNode({ pinned: true }), makeNode({ pinned: true })];
    expect(findCuriosityTargets(nodes)).toEqual([]);
  });

  it("returns empty when all nodes are tombstoned", () => {
    const nodes = [makeNode({ tombstoned: true }), makeNode({ tombstoned: true })];
    expect(findCuriosityTargets(nodes)).toEqual([]);
  });

  it("returns empty for fresh healthy nodes", () => {
    const now = Date.now();
    const nodes = [
      makeNode({ created_at: now, last_accessed: now, confidence: 0.9 }),
      makeNode({ created_at: now, last_accessed: now, confidence: 0.8 }),
    ];
    expect(findCuriosityTargets(nodes)).toEqual([]);
  });

  it("finds decaying high-value memories", () => {
    const now = Date.now();
    const node = makeNode({
      content: "important fading fact",
      confidence: 0.8,
      created_at: now - 25 * DAY,
      last_accessed: now - 25 * DAY,
      half_life: HALF_LIFE,
    });
    const results = findCuriosityTargets([node]);
    expect(results).toHaveLength(1);
    expect(results[0]!.node.content).toBe("important fading fact");
    expect(results[0]!.confidenceLoss).toBeGreaterThan(0.15);
    expect(results[0]!.curiosityScore).toBeGreaterThan(0);
  });

  it("ranks by curiosityScore descending", () => {
    const now = Date.now();
    // Node A: older, more decayed
    const nodeA = makeNode({
      content: "very old fact",
      confidence: 0.9,
      created_at: now - 40 * DAY,
      last_accessed: now - 40 * DAY,
      half_life: HALF_LIFE,
    });
    // Node B: newer, less decayed
    const nodeB = makeNode({
      content: "moderately old fact",
      confidence: 0.8,
      created_at: now - 25 * DAY,
      last_accessed: now - 25 * DAY,
      half_life: HALF_LIFE,
    });
    const results = findCuriosityTargets([nodeB, nodeA]);
    expect(results.length).toBeGreaterThanOrEqual(1);
    // nodeA should rank higher (older, higher confidence, more decay)
    expect(results[0]!.node.content).toBe("very old fact");
  });

  it("respects limit option", () => {
    const now = Date.now();
    const nodes = Array.from({ length: 10 }, (_, i) =>
      makeNode({
        content: `fact ${i}`,
        confidence: 0.8,
        created_at: now - (20 + i) * DAY,
        last_accessed: now - (20 + i) * DAY,
      }),
    );
    const results = findCuriosityTargets(nodes, { limit: 3 });
    expect(results).toHaveLength(3);
  });

  it("respects minOriginalConfidence filter", () => {
    const now = Date.now();
    const lowConf = makeNode({
      content: "low confidence",
      confidence: 0.3,
      created_at: now - 25 * DAY,
      last_accessed: now - 25 * DAY,
    });
    const results = findCuriosityTargets([lowConf], { minOriginalConfidence: 0.5 });
    expect(results).toEqual([]);
  });

  it("respects maxDecayedConfidence filter", () => {
    const now = Date.now();
    // Node that's barely decayed — should be excluded by maxDecayedConfidence
    const fresh = makeNode({
      confidence: 0.9,
      created_at: now - 5 * DAY,
      last_accessed: now - 5 * DAY,
      half_life: HALF_LIFE, // 30d half-life, only 5d old → decayed ≈ 0.8
    });
    const results = findCuriosityTargets([fresh], { maxDecayedConfidence: 0.7 });
    expect(results).toEqual([]);
  });

  it("excludes nodes with decayedConfidence below 0.1 (too far gone)", () => {
    const now = Date.now();
    const ancient = makeNode({
      confidence: 0.8,
      created_at: now - 200 * DAY,
      last_accessed: now - 200 * DAY,
      half_life: HALF_LIFE, // decayed ≈ 0.8 * 0.5^(200/30) ≈ 0.007
    });
    const results = findCuriosityTargets([ancient]);
    expect(results).toEqual([]);
  });

  it("staleness² amplifies memories past one half-life", () => {
    const now = Date.now();
    // Both same confidence and loss, but different staleness
    const halfLife = 10 * DAY;
    const nodeA = makeNode({
      content: "2 half-lives old",
      confidence: 0.7,
      created_at: now - 20 * DAY,
      last_accessed: now - 20 * DAY,
      half_life: halfLife,
    });
    const nodeB = makeNode({
      content: "1 half-life old",
      confidence: 0.7,
      created_at: now - 10 * DAY,
      last_accessed: now - 10 * DAY,
      half_life: halfLife,
    });

    const results = findCuriosityTargets([nodeB, nodeA]);
    // Both should qualify, but nodeA (staleness=2) should score higher than nodeB (staleness=1)
    // because 2²=4 > 1²=1
    if (results.length >= 2) {
      expect(results[0]!.node.content).toBe("2 half-lives old");
    }
  });
});
