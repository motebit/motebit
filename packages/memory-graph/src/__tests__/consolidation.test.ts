import { describe, it, expect, beforeEach } from "vitest";
import {
  ConsolidationAction,
  buildConsolidationPrompt,
  parseConsolidationResponse,
  clusterBySimilarity,
} from "../consolidation";
import { MemoryGraph, InMemoryMemoryStorage } from "../index";
import type { ConsolidationProvider } from "../consolidation";
import { EventStore, InMemoryEventStore } from "@motebit/event-log";
import { SensitivityLevel, RelationType } from "@motebit/sdk";

// ---------------------------------------------------------------------------
// buildConsolidationPrompt()
// ---------------------------------------------------------------------------

describe("buildConsolidationPrompt", () => {
  it("produces a prompt with memory IDs and content", () => {
    const prompt = buildConsolidationPrompt("I now work at Tesla", [
      { node_id: "m1", content: "User works at Acme", confidence: 0.9 },
      { node_id: "m2", content: "User likes Python", confidence: 0.8 },
    ]);

    expect(prompt).toContain("I now work at Tesla");
    expect(prompt).toContain("[id=m1]");
    expect(prompt).toContain("[id=m2]");
    expect(prompt).toContain("User works at Acme");
    expect(prompt).toContain("User likes Python");
    expect(prompt).toContain('"add"');
    expect(prompt).toContain('"update"');
    expect(prompt).toContain('"reinforce"');
    expect(prompt).toContain('"noop"');
  });
});

// ---------------------------------------------------------------------------
// parseConsolidationResponse()
// ---------------------------------------------------------------------------

describe("parseConsolidationResponse", () => {
  const validIds = ["m1", "m2", "m3"];

  it("parses ADD action", () => {
    const raw = '{"action": "add", "reason": "New information"}';
    const decision = parseConsolidationResponse(raw, validIds);
    expect(decision.action).toBe(ConsolidationAction.ADD);
    expect(decision.reason).toBe("New information");
    expect(decision.existingNodeId).toBeUndefined();
  });

  it("parses UPDATE action with valid node ID", () => {
    const raw = '{"action": "update", "existingNodeId": "m1", "reason": "Job changed"}';
    const decision = parseConsolidationResponse(raw, validIds);
    expect(decision.action).toBe(ConsolidationAction.UPDATE);
    expect(decision.existingNodeId).toBe("m1");
    expect(decision.reason).toBe("Job changed");
  });

  it("parses REINFORCE action", () => {
    const raw = '{"action": "reinforce", "existingNodeId": "m2", "reason": "Confirms existing"}';
    const decision = parseConsolidationResponse(raw, validIds);
    expect(decision.action).toBe(ConsolidationAction.REINFORCE);
    expect(decision.existingNodeId).toBe("m2");
  });

  it("parses NOOP action", () => {
    const raw = '{"action": "noop", "existingNodeId": "m3", "reason": "Too similar"}';
    const decision = parseConsolidationResponse(raw, validIds);
    expect(decision.action).toBe(ConsolidationAction.NOOP);
    expect(decision.existingNodeId).toBe("m3");
  });

  it("falls back to ADD on malformed response", () => {
    const decision = parseConsolidationResponse("not json at all", validIds);
    expect(decision.action).toBe(ConsolidationAction.ADD);
    expect(decision.reason).toContain("Failed to parse");
  });

  it("falls back to ADD on invalid action", () => {
    const raw = '{"action": "explode", "reason": "Invalid"}';
    const decision = parseConsolidationResponse(raw, validIds);
    expect(decision.action).toBe(ConsolidationAction.ADD);
  });

  it("falls back to ADD when node ID is invalid", () => {
    const raw = '{"action": "update", "existingNodeId": "invalid-id", "reason": "Test"}';
    const decision = parseConsolidationResponse(raw, validIds);
    expect(decision.action).toBe(ConsolidationAction.ADD);
  });

  it("falls back to ADD when UPDATE/REINFORCE/NOOP missing node ID", () => {
    const raw = '{"action": "update", "reason": "No node ID"}';
    const decision = parseConsolidationResponse(raw, validIds);
    expect(decision.action).toBe(ConsolidationAction.ADD);
  });

  it("extracts JSON from surrounding text", () => {
    const raw =
      'Here is my analysis: {"action": "add", "reason": "Genuinely new"} Hope that helps!';
    const decision = parseConsolidationResponse(raw, validIds);
    expect(decision.action).toBe(ConsolidationAction.ADD);
    expect(decision.reason).toBe("Genuinely new");
  });
});

// ---------------------------------------------------------------------------
// clusterBySimilarity()
// ---------------------------------------------------------------------------

describe("clusterBySimilarity", () => {
  function makeNode(id: string, embedding: number[]): import("@motebit/sdk").MemoryNode {
    return {
      node_id: id,
      motebit_id: "test",
      content: `memory ${id}`,
      embedding,
      confidence: 0.8,
      sensitivity: SensitivityLevel.None,
      created_at: Date.now(),
      last_accessed: Date.now(),
      half_life: 7 * 24 * 60 * 60 * 1000,
      tombstoned: false,
      pinned: false,
    };
  }

  it("clusters similar vectors together", () => {
    const nodes = [
      makeNode("a", [1, 0, 0]),
      makeNode("b", [0.95, 0.05, 0]),
      makeNode("c", [0, 0, 1]),
    ];

    const clusters = clusterBySimilarity(nodes, 0.9);
    // a and b should cluster (very similar), c should be standalone
    expect(clusters.length).toBe(2);
    const big = clusters.find((c) => c.length === 2)!;
    const small = clusters.find((c) => c.length === 1)!;
    expect(big.map((n) => n.node_id).sort()).toEqual(["a", "b"]);
    expect(small[0]!.node_id).toBe("c");
  });

  it("keeps dissimilar vectors as singletons", () => {
    const nodes = [makeNode("a", [1, 0, 0]), makeNode("b", [0, 1, 0]), makeNode("c", [0, 0, 1])];

    const clusters = clusterBySimilarity(nodes, 0.9);
    expect(clusters.length).toBe(3);
    expect(clusters.every((c) => c.length === 1)).toBe(true);
  });

  it("returns empty array for empty input", () => {
    expect(clusterBySimilarity([], 0.5)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// MemoryGraph.consolidateAndForm()
// ---------------------------------------------------------------------------

describe("MemoryGraph.consolidateAndForm", () => {
  let storage: InMemoryMemoryStorage;
  let eventStore: EventStore;
  let graph: MemoryGraph;

  beforeEach(() => {
    storage = new InMemoryMemoryStorage();
    eventStore = new EventStore(new InMemoryEventStore());
    graph = new MemoryGraph(storage, eventStore, "test-mote");
  });

  function mockProvider(decision: {
    action: string;
    existingNodeId?: string;
    reason: string;
  }): ConsolidationProvider {
    return {
      classify: async (_newContent, _existing) => ({
        action: decision.action as ConsolidationAction,
        existingNodeId: decision.existingNodeId,
        reason: decision.reason,
      }),
    };
  }

  it("ADD: forms a new memory normally", async () => {
    const provider = mockProvider({ action: "add", reason: "New info" });
    const { node, decision } = await graph.consolidateAndForm(
      { content: "User likes cats", confidence: 0.8, sensitivity: SensitivityLevel.None },
      [1, 0, 0],
      provider,
    );

    expect(decision.action).toBe("add");
    expect(node).not.toBeNull();
    expect(node!.content).toBe("User likes cats");
  });

  it("ADD: skips LLM call when no similar memories exist", async () => {
    let classifyCalled = false;
    const provider: ConsolidationProvider = {
      classify: async () => {
        classifyCalled = true;
        return { action: ConsolidationAction.ADD, reason: "test" };
      },
    };

    const { node, decision } = await graph.consolidateAndForm(
      { content: "Brand new fact", confidence: 0.9, sensitivity: SensitivityLevel.None },
      [1, 0, 0],
      provider,
    );

    expect(classifyCalled).toBe(false);
    expect(node).not.toBeNull();
    expect(decision.reason).toBe("No similar memories found");
  });

  it("UPDATE: old node gets valid_until, new node created, Supersedes edge exists", async () => {
    // Pre-populate with an existing memory
    const oldNode = await graph.formMemory(
      { content: "User works at Acme", confidence: 0.9, sensitivity: SensitivityLevel.None },
      [1, 0, 0],
    );

    const provider = mockProvider({
      action: "update",
      existingNodeId: oldNode.node_id,
      reason: "Changed jobs",
    });

    const { node: newNode, decision } = await graph.consolidateAndForm(
      { content: "User now works at Tesla", confidence: 0.85, sensitivity: SensitivityLevel.None },
      [0.95, 0.05, 0], // similar enough to find old node
      provider,
    );

    expect(decision.action).toBe("update");
    expect(newNode).not.toBeNull();
    expect(newNode!.content).toBe("User now works at Tesla");

    // Check old node has valid_until set
    const updatedOld = await storage.getNode(oldNode.node_id);
    expect(updatedOld!.valid_until).toBeDefined();
    expect(updatedOld!.valid_until).toBeGreaterThan(0);

    // Check Supersedes edge exists
    const edges = await storage.getEdges(newNode!.node_id);
    const supersedesEdge = edges.find((e) => e.relation_type === RelationType.Supersedes);
    expect(supersedesEdge).toBeDefined();
    expect(supersedesEdge!.target_id).toBe(oldNode.node_id);
  });

  it("REINFORCE: existing confidence boosted, half-life increased, Reinforces edge exists", async () => {
    const existingNode = await graph.formMemory(
      { content: "User likes Python", confidence: 0.7, sensitivity: SensitivityLevel.None },
      [1, 0, 0],
    );

    const originalHalfLife = existingNode.half_life;

    const provider = mockProvider({
      action: "reinforce",
      existingNodeId: existingNode.node_id,
      reason: "Confirms preference",
    });

    const { node: supportNode, decision } = await graph.consolidateAndForm(
      {
        content: "User mentioned liking Python again",
        confidence: 0.6,
        sensitivity: SensitivityLevel.None,
      },
      [0.95, 0.05, 0],
      provider,
    );

    expect(decision.action).toBe("reinforce");
    expect(supportNode).not.toBeNull();

    // Check existing confidence was boosted
    const updated = await storage.getNode(existingNode.node_id);
    expect(updated!.confidence).toBeCloseTo(0.8, 1);

    // Check half-life was increased by 1.5x (stability compounding)
    expect(updated!.half_life).toBe(originalHalfLife * 1.5);

    // Check Reinforces edge
    const edges = await storage.getEdges(supportNode!.node_id);
    const reinforcesEdge = edges.find((e) => e.relation_type === RelationType.Reinforces);
    expect(reinforcesEdge).toBeDefined();
  });

  it("REINFORCE: half-life caps at MAX_HALF_LIFE (365 days)", async () => {
    // Start with a memory near the cap (300-day half-life)
    const existingNode = await graph.formMemory(
      { content: "Core identity fact", confidence: 0.9, sensitivity: SensitivityLevel.None },
      [1, 0, 0],
      300 * 24 * 60 * 60 * 1000, // 300 days
    );

    const provider = mockProvider({
      action: "reinforce",
      existingNodeId: existingNode.node_id,
      reason: "Confirms identity",
    });

    await graph.consolidateAndForm(
      { content: "Reconfirms identity", confidence: 0.8, sensitivity: SensitivityLevel.None },
      [0.95, 0.05, 0],
      provider,
    );

    const updated = await storage.getNode(existingNode.node_id);
    // 300 * 1.5 = 450 days, but capped at 365
    expect(updated!.half_life).toBe(365 * 24 * 60 * 60 * 1000);
  });

  it("NOOP: no new node, existing confidence and half-life compounded", async () => {
    const existingNode = await graph.formMemory(
      { content: "User likes tea", confidence: 0.8, sensitivity: SensitivityLevel.None },
      [1, 0, 0],
    );

    const originalAccessed = existingNode.last_accessed;
    const originalHalfLife = existingNode.half_life;
    // Small delay to ensure time difference
    await new Promise((r) => setTimeout(r, 10));

    const provider = mockProvider({
      action: "noop",
      existingNodeId: existingNode.node_id,
      reason: "Too similar",
    });

    const { node, decision } = await graph.consolidateAndForm(
      { content: "User likes tea", confidence: 0.8, sensitivity: SensitivityLevel.None },
      [0.99, 0.01, 0],
      provider,
    );

    expect(decision.action).toBe("noop");
    expect(node).toBeNull();

    // Check confidence boosted, half-life compounded, last_accessed updated
    const updated = await storage.getNode(existingNode.node_id);
    expect(updated!.confidence).toBeCloseTo(0.9); // 0.8 + 0.1
    expect(updated!.half_life).toBe(originalHalfLife * 1.5);
    expect(updated!.last_accessed).toBeGreaterThanOrEqual(originalAccessed);
  });
});
