import { describe, it, expect, beforeEach } from "vitest";
import {
  computeDecayedConfidence,
  cosineSimilarity,
  InMemoryMemoryStorage,
  MemoryGraph,
} from "../index";
import { EventStore, InMemoryEventStore } from "@motebit/event-log";
import { SensitivityLevel, RelationType, EventType } from "@motebit/sdk";
import type { MemoryCandidate } from "@motebit/sdk";

// ---------------------------------------------------------------------------
// computeDecayedConfidence()
// ---------------------------------------------------------------------------

describe("computeDecayedConfidence", () => {
  it("returns initial confidence when elapsed is 0", () => {
    expect(computeDecayedConfidence(1.0, 1000, 0)).toBe(1.0);
  });

  it("returns half confidence after one half-life", () => {
    expect(computeDecayedConfidence(1.0, 1000, 1000)).toBeCloseTo(0.5, 10);
  });

  it("returns quarter confidence after two half-lives", () => {
    expect(computeDecayedConfidence(1.0, 1000, 2000)).toBeCloseTo(0.25, 10);
  });

  it("returns initial confidence when halfLife <= 0", () => {
    expect(computeDecayedConfidence(0.8, 0, 5000)).toBe(0.8);
    expect(computeDecayedConfidence(0.8, -1, 5000)).toBe(0.8);
  });

  it("scales with initial confidence", () => {
    expect(computeDecayedConfidence(0.6, 1000, 1000)).toBeCloseTo(0.3, 10);
  });
});

// ---------------------------------------------------------------------------
// cosineSimilarity()
// ---------------------------------------------------------------------------

describe("cosineSimilarity", () => {
  it("returns 1 for identical unit vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0, 10);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it("returns -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0, 10);
  });

  it("returns 0 for empty arrays", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("returns 0 for mismatched lengths", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it("returns 0 for zero vectors", () => {
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
  });

  it("computes correctly for known vectors", () => {
    // cos(45 degrees) ~ 0.7071
    const a = [1, 0];
    const b = [1, 1];
    const expected = 1 / Math.sqrt(2);
    expect(cosineSimilarity(a, b)).toBeCloseTo(expected, 5);
  });
});

// ---------------------------------------------------------------------------
// InMemoryMemoryStorage
// ---------------------------------------------------------------------------

describe("InMemoryMemoryStorage", () => {
  let storage: InMemoryMemoryStorage;

  beforeEach(() => {
    storage = new InMemoryMemoryStorage();
  });

  it("saveNode and getNode roundtrip", async () => {
    const node = {
      node_id: "n1",
      motebit_id: "m1",
      content: "test memory",
      embedding: [0.1, 0.2, 0.3],
      confidence: 0.9,
      sensitivity: SensitivityLevel.None,
      created_at: Date.now(),
      last_accessed: Date.now(),
      half_life: 7 * 24 * 60 * 60 * 1000,
      tombstoned: false,
    };
    await storage.saveNode(node);
    const loaded = await storage.getNode("n1");
    expect(loaded).not.toBeNull();
    expect(loaded!.content).toBe("test memory");
  });

  it("getNode returns null for unknown node", async () => {
    expect(await storage.getNode("nonexistent")).toBeNull();
  });

  it("queryNodes filters by motebit_id", async () => {
    await storage.saveNode({
      node_id: "n1",
      motebit_id: "m1",
      content: "a",
      embedding: [],
      confidence: 1,
      sensitivity: SensitivityLevel.None,
      created_at: Date.now(),
      last_accessed: Date.now(),
      half_life: 999999999,
      tombstoned: false,
    });
    await storage.saveNode({
      node_id: "n2",
      motebit_id: "m2",
      content: "b",
      embedding: [],
      confidence: 1,
      sensitivity: SensitivityLevel.None,
      created_at: Date.now(),
      last_accessed: Date.now(),
      half_life: 999999999,
      tombstoned: false,
    });
    const results = await storage.queryNodes({ motebit_id: "m1" });
    expect(results).toHaveLength(1);
    expect(results[0]!.node_id).toBe("n1");
  });

  it("queryNodes excludes tombstoned by default", async () => {
    await storage.saveNode({
      node_id: "n1",
      motebit_id: "m1",
      content: "a",
      embedding: [],
      confidence: 1,
      sensitivity: SensitivityLevel.None,
      created_at: Date.now(),
      last_accessed: Date.now(),
      half_life: 999999999,
      tombstoned: true,
    });
    const results = await storage.queryNodes({ motebit_id: "m1" });
    expect(results).toHaveLength(0);
  });

  it("queryNodes includes tombstoned when requested", async () => {
    await storage.saveNode({
      node_id: "n1",
      motebit_id: "m1",
      content: "a",
      embedding: [],
      confidence: 1,
      sensitivity: SensitivityLevel.None,
      created_at: Date.now(),
      last_accessed: Date.now(),
      half_life: 999999999,
      tombstoned: true,
    });
    const results = await storage.queryNodes({
      motebit_id: "m1",
      include_tombstoned: true,
    });
    expect(results).toHaveLength(1);
  });

  it("saveEdge and getEdges roundtrip", async () => {
    const edge = {
      edge_id: "e1",
      source_id: "n1",
      target_id: "n2",
      relation_type: RelationType.Related,
      weight: 1.0,
      confidence: 0.9,
    };
    await storage.saveEdge(edge);
    const edgesSource = await storage.getEdges("n1");
    expect(edgesSource).toHaveLength(1);
    const edgesTarget = await storage.getEdges("n2");
    expect(edgesTarget).toHaveLength(1);
  });

  it("tombstoneNode marks node as tombstoned", async () => {
    await storage.saveNode({
      node_id: "n1",
      motebit_id: "m1",
      content: "a",
      embedding: [],
      confidence: 1,
      sensitivity: SensitivityLevel.None,
      created_at: Date.now(),
      last_accessed: Date.now(),
      half_life: 999999999,
      tombstoned: false,
    });
    await storage.tombstoneNode("n1");
    const loaded = await storage.getNode("n1");
    expect(loaded!.tombstoned).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MemoryGraph
// ---------------------------------------------------------------------------

describe("MemoryGraph", () => {
  let storage: InMemoryMemoryStorage;
  let eventStore: EventStore;
  let graph: MemoryGraph;
  const motebitId = "motebit-1";

  beforeEach(() => {
    storage = new InMemoryMemoryStorage();
    eventStore = new EventStore(new InMemoryEventStore());
    graph = new MemoryGraph(storage, eventStore, motebitId);
  });

  describe("formMemory", () => {
    it("creates a memory node with correct fields", async () => {
      const candidate: MemoryCandidate = {
        content: "The user likes jazz",
        confidence: 0.85,
        sensitivity: SensitivityLevel.Personal,
      };
      const embedding = [0.1, 0.2, 0.3];
      const node = await graph.formMemory(candidate, embedding);

      expect(node.node_id).toBeTruthy();
      expect(node.motebit_id).toBe(motebitId);
      expect(node.content).toBe("The user likes jazz");
      expect(node.confidence).toBe(0.85);
      expect(node.sensitivity).toBe(SensitivityLevel.Personal);
      expect(node.embedding).toEqual([0.1, 0.2, 0.3]);
      expect(node.tombstoned).toBe(false);
      expect(node.half_life).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it("logs a MemoryFormed event", async () => {
      const candidate: MemoryCandidate = {
        content: "test",
        confidence: 0.9,
        sensitivity: SensitivityLevel.None,
      };
      await graph.formMemory(candidate, [1, 0]);
      const events = await eventStore.query({ motebit_id: motebitId });
      expect(events).toHaveLength(1);
      expect(events[0]!.event_type).toBe("memory_formed");
    });

    it("uses custom half_life when provided", async () => {
      const candidate: MemoryCandidate = {
        content: "temp",
        confidence: 0.5,
        sensitivity: SensitivityLevel.None,
      };
      const node = await graph.formMemory(candidate, [1], 3600000);
      expect(node.half_life).toBe(3600000);
    });
  });

  describe("retrieve (two-pass)", () => {
    it("returns memories ranked by composite score", async () => {
      // Create two memories with different embeddings
      await graph.formMemory(
        {
          content: "relevant memory",
          confidence: 0.9,
          sensitivity: SensitivityLevel.None,
        },
        [1, 0, 0],
      );
      await graph.formMemory(
        {
          content: "irrelevant memory",
          confidence: 0.9,
          sensitivity: SensitivityLevel.None,
        },
        [0, 0, 1],
      );

      // Query with embedding close to the first memory
      const results = await graph.retrieve([1, 0, 0]);
      expect(results.length).toBeGreaterThanOrEqual(1);
      // The first result should be the one with matching embedding
      expect(results[0]!.content).toBe("relevant memory");
    });

    it("respects limit", async () => {
      for (let i = 0; i < 5; i++) {
        await graph.formMemory(
          {
            content: `memory-${i}`,
            confidence: 0.9,
            sensitivity: SensitivityLevel.None,
          },
          [1, 0],
        );
      }
      const results = await graph.retrieve([1, 0], { limit: 2 });
      expect(results).toHaveLength(2);
    });
  });

  describe("deleteMemory (tombstoning)", () => {
    it("tombstones the memory node", async () => {
      const node = await graph.formMemory(
        {
          content: "to be deleted",
          confidence: 0.9,
          sensitivity: SensitivityLevel.None,
        },
        [1, 0],
      );

      await graph.deleteMemory(node.node_id);

      const loaded = await storage.getNode(node.node_id);
      expect(loaded!.tombstoned).toBe(true);
    });

    it("logs a MemoryDeleted event", async () => {
      const node = await graph.formMemory(
        {
          content: "to be deleted",
          confidence: 0.9,
          sensitivity: SensitivityLevel.None,
        },
        [1, 0],
      );

      await graph.deleteMemory(node.node_id);

      const events = await eventStore.query({
        motebit_id: motebitId,
        event_types: [EventType.MemoryDeleted],
      });
      expect(events).toHaveLength(1);
    });
  });

  describe("link", () => {
    it("creates an edge between two memories", async () => {
      const nodeA = await graph.formMemory(
        {
          content: "A",
          confidence: 0.9,
          sensitivity: SensitivityLevel.None,
        },
        [1, 0],
      );
      const nodeB = await graph.formMemory(
        {
          content: "B",
          confidence: 0.9,
          sensitivity: SensitivityLevel.None,
        },
        [0, 1],
      );

      const edge = await graph.link(
        nodeA.node_id,
        nodeB.node_id,
        RelationType.Related,
      );

      expect(edge.source_id).toBe(nodeA.node_id);
      expect(edge.target_id).toBe(nodeB.node_id);
      expect(edge.relation_type).toBe(RelationType.Related);
      expect(edge.weight).toBe(1.0);
      expect(edge.confidence).toBe(1.0);
    });

    it("supports custom weight and confidence", async () => {
      const nodeA = await graph.formMemory(
        {
          content: "A",
          confidence: 0.9,
          sensitivity: SensitivityLevel.None,
        },
        [1, 0],
      );
      const nodeB = await graph.formMemory(
        {
          content: "B",
          confidence: 0.9,
          sensitivity: SensitivityLevel.None,
        },
        [0, 1],
      );

      const edge = await graph.link(
        nodeA.node_id,
        nodeB.node_id,
        RelationType.CausedBy,
        0.5,
        0.7,
      );

      expect(edge.weight).toBe(0.5);
      expect(edge.confidence).toBe(0.7);
    });
  });

  describe("version_clock incrementing", () => {
    it("increments version_clock across multiple operations", async () => {
      const c1: MemoryCandidate = {
        content: "first",
        confidence: 0.9,
        sensitivity: SensitivityLevel.None,
      };
      const c2: MemoryCandidate = {
        content: "second",
        confidence: 0.9,
        sensitivity: SensitivityLevel.None,
      };

      const node1 = await graph.formMemory(c1, [1, 0]);
      const node2 = await graph.formMemory(c2, [0, 1]);
      await graph.deleteMemory(node1.node_id);
      await graph.getMemory(node2.node_id);

      const events = await eventStore.query({ motebit_id: motebitId });
      const clocks = events.map((e) => e.version_clock);
      // Each event should have a unique, incrementing clock
      expect(clocks).toEqual([1, 2, 3, 4]);
    });
  });

  describe("exportAll", () => {
    it("returns all nodes and edges for the motebit", async () => {
      const nodeA = await graph.formMemory(
        {
          content: "A",
          confidence: 0.9,
          sensitivity: SensitivityLevel.None,
        },
        [1, 0],
      );
      const nodeB = await graph.formMemory(
        {
          content: "B",
          confidence: 0.9,
          sensitivity: SensitivityLevel.None,
        },
        [0, 1],
      );
      await graph.link(
        nodeA.node_id,
        nodeB.node_id,
        RelationType.Related,
      );

      const exported = await graph.exportAll();
      expect(exported.nodes).toHaveLength(2);
      expect(exported.edges).toHaveLength(1);
    });
  });
});
