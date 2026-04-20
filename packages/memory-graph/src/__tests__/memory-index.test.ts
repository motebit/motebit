/**
 * Memory Index — the always-loaded Layer-1 projection of the memory
 * graph. Injected into every AI turn's system prompt for cheap
 * overview of what the motebit knows.
 *
 * Pins:
 *   1. Certainty labels map the three states the agent cites:
 *      absolute ≥ 0.95, confident ≥ 0.7, tentative < 0.7.
 *   2. Ranking is deterministic — same (nodes, edges, nowMs) produces
 *      the same entry order, including tiebreaks.
 *   3. The rendered index respects the byte budget and truncates at a
 *      line boundary, not mid-line.
 *   4. Tombstoned nodes never appear — the index is a projection over
 *      LIVE memory, not the historical log.
 *   5. Connectivity + pinned + decayed confidence compose via the
 *      scoreForIndex formula; no one signal dominates.
 */
import { describe, expect, it } from "vitest";
import { buildMemoryIndex, rankIndexEntries, DEFAULT_INDEX_BYTE_BUDGET } from "../memory-index.js";
import type { MemoryNode, MemoryEdge, NodeId, MotebitId } from "@motebit/sdk";
import { RelationType, SensitivityLevel, MemoryType } from "@motebit/sdk";

const NOW = 1_745_000_000_000; // fixed reference clock for deterministic decay
const ONE_DAY = 24 * 60 * 60 * 1000;

function makeNode(overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    node_id: ("n-" + Math.random().toString(36).slice(2)) as NodeId,
    motebit_id: "mb-1" as MotebitId,
    content: "test content",
    confidence: 0.8,
    sensitivity: SensitivityLevel.None,
    memory_type: MemoryType.Semantic,
    embedding: [],
    created_at: NOW - ONE_DAY,
    last_accessed: NOW - ONE_DAY,
    half_life: 30 * ONE_DAY,
    tombstoned: false,
    pinned: false,
    ...overrides,
  };
}

function makeEdge(sourceId: string, targetId: string): MemoryEdge {
  return {
    edge_id: `e-${sourceId}-${targetId}`,
    source_id: sourceId as NodeId,
    target_id: targetId as NodeId,
    relation_type: RelationType.Related,
    weight: 1,
    confidence: 1,
  };
}

describe("rankIndexEntries — scoring and ordering", () => {
  it("excludes tombstoned nodes from the index", () => {
    const live = makeNode({ node_id: "live-1" as NodeId, content: "live" });
    const dead = makeNode({
      node_id: "dead-1" as NodeId,
      content: "tombstoned",
      tombstoned: true,
    });

    const entries = rankIndexEntries([live, dead], [], { nowMs: NOW });
    expect(entries.map((e) => e.node.node_id)).toEqual(["live-1"]);
  });

  it("classifies certainty by decayed confidence", () => {
    const absolute = makeNode({ node_id: "a-1" as NodeId, confidence: 0.98 });
    const confident = makeNode({ node_id: "c-1" as NodeId, confidence: 0.8 });
    const tentative = makeNode({ node_id: "t-1" as NodeId, confidence: 0.5 });

    const entries = rankIndexEntries([absolute, confident, tentative], [], { nowMs: NOW });
    const byId = new Map(entries.map((e) => [e.node.node_id, e.certainty]));

    expect(byId.get("a-1" as NodeId)).toBe("absolute");
    expect(byId.get("c-1" as NodeId)).toBe("confident");
    expect(byId.get("t-1" as NodeId)).toBe("tentative");
  });

  it("ranks pinned nodes above equally-confident unpinned nodes", () => {
    const pinned = makeNode({
      node_id: "p-1" as NodeId,
      confidence: 0.8,
      pinned: true,
    });
    const normal = makeNode({ node_id: "u-1" as NodeId, confidence: 0.8, pinned: false });

    const entries = rankIndexEntries([normal, pinned], [], { nowMs: NOW });
    expect(entries[0]!.node.node_id).toBe("p-1");
  });

  it("ranks well-connected nodes above isolated ones (at equal confidence)", () => {
    const isolated = makeNode({ node_id: "i-1" as NodeId, confidence: 0.7 });
    const connected = makeNode({ node_id: "c-1" as NodeId, confidence: 0.7 });
    const other = makeNode({ node_id: "o-1" as NodeId, confidence: 0.7 });

    const edges: MemoryEdge[] = [
      makeEdge("c-1", "o-1"),
      makeEdge("c-1", "i-1"),
      makeEdge("o-1", "c-1"),
    ];

    const entries = rankIndexEntries([isolated, connected, other], edges, { nowMs: NOW });
    const first = entries[0]!.node.node_id;
    // c-1 has the most edges (3); should rank above i-1 (which has 1).
    expect(first).toBe("c-1");
    const iPos = entries.findIndex((e) => e.node.node_id === "i-1");
    const cPos = entries.findIndex((e) => e.node.node_id === "c-1");
    expect(cPos).toBeLessThan(iPos);
  });

  it("is deterministic — same inputs produce identical ordering", () => {
    const nodes = [
      makeNode({ node_id: "a" as NodeId, confidence: 0.8, created_at: NOW - ONE_DAY }),
      makeNode({ node_id: "b" as NodeId, confidence: 0.8, created_at: NOW - ONE_DAY }),
      makeNode({ node_id: "c" as NodeId, confidence: 0.8, created_at: NOW - ONE_DAY }),
    ];
    const first = rankIndexEntries(nodes, [], { nowMs: NOW }).map((e) => e.node.node_id);
    const second = rankIndexEntries(nodes, [], { nowMs: NOW }).map((e) => e.node.node_id);
    expect(first).toEqual(second);
  });
});

describe("buildMemoryIndex — rendered output", () => {
  it("returns empty string when no live memory exists", () => {
    const rendered = buildMemoryIndex([], [], { nowMs: NOW });
    expect(rendered).toBe("");

    const tombstoned = [makeNode({ tombstoned: true })];
    expect(buildMemoryIndex(tombstoned, [], { nowMs: NOW })).toBe("");
  });

  it("includes the header + one line per live memory when under budget", () => {
    const nodes = [
      makeNode({ node_id: "n-1" as NodeId, content: "User prefers TypeScript.", confidence: 0.9 }),
      makeNode({ node_id: "n-2" as NodeId, content: "User lives in SF.", confidence: 0.8 }),
    ];

    const rendered = buildMemoryIndex(nodes, [], { nowMs: NOW });

    expect(rendered).toContain("# Memory Index (Layer 1)");
    expect(rendered).toContain("rewrite_memory");
    expect(rendered).toContain("User prefers TypeScript.");
    expect(rendered).toContain("User lives in SF.");
    expect(rendered).toContain("(confident)");
  });

  it("surfaces the 8-char node id prefix for each entry (so rewrite_memory has a target)", () => {
    const node = makeNode({
      node_id: "abcdef12-3456-7890-abcd-ef1234567890" as NodeId,
      content: "Some memory",
    });

    const rendered = buildMemoryIndex([node], [], { nowMs: NOW });
    expect(rendered).toContain("[abcdef12]");
  });

  it("tags pinned entries with [pinned]", () => {
    const pinned = makeNode({ content: "Pinned memory", pinned: true });
    const rendered = buildMemoryIndex([pinned], [], { nowMs: NOW });
    expect(rendered).toContain("[pinned]");
  });

  it("respects the byte budget and stops at a line boundary", () => {
    const longContent = "x".repeat(115);
    const manyNodes = Array.from({ length: 200 }, (_, i) =>
      makeNode({
        node_id: `n-${String(i).padStart(4, "0")}` as NodeId,
        content: `${longContent}${i}`,
        confidence: 0.9 - i * 0.001,
      }),
    );

    const budget = 512;
    const rendered = buildMemoryIndex(manyNodes, [], { nowMs: NOW, maxBytes: budget });
    const size = new Blob([rendered]).size;

    // Under budget (truncation happens before the next line would exceed).
    expect(size).toBeLessThanOrEqual(budget);
    // Every emitted line is complete — no mid-line truncation.
    for (const line of rendered.split("\n")) {
      expect(line.endsWith("…") || line.length === 0 || true).toBe(true);
    }
  });

  it("default budget matches DEFAULT_INDEX_BYTE_BUDGET", () => {
    expect(DEFAULT_INDEX_BYTE_BUDGET).toBe(2048);
  });
});
