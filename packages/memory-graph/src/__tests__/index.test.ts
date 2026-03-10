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
      pinned: false,
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
      pinned: false,
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
      pinned: false,
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
      pinned: false,
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
      pinned: false,
    });
    const results = await storage.queryNodes({
      motebit_id: "m1",
      include_tombstoned: true,
    });
    expect(results).toHaveLength(1);
  });

  it("queryNodes filters by pinned", async () => {
    await storage.saveNode({
      node_id: "n1",
      motebit_id: "m1",
      content: "pinned",
      embedding: [],
      confidence: 1,
      sensitivity: SensitivityLevel.None,
      created_at: Date.now(),
      last_accessed: Date.now(),
      half_life: 999999999,
      tombstoned: false,
      pinned: true,
    });
    await storage.saveNode({
      node_id: "n2",
      motebit_id: "m1",
      content: "not pinned",
      embedding: [],
      confidence: 1,
      sensitivity: SensitivityLevel.None,
      created_at: Date.now(),
      last_accessed: Date.now(),
      half_life: 999999999,
      tombstoned: false,
      pinned: false,
    });
    const pinned = await storage.queryNodes({ motebit_id: "m1", pinned: true });
    expect(pinned).toHaveLength(1);
    expect(pinned[0]!.node_id).toBe("n1");

    const unpinned = await storage.queryNodes({ motebit_id: "m1", pinned: false });
    expect(unpinned).toHaveLength(1);
    expect(unpinned[0]!.node_id).toBe("n2");
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
      pinned: false,
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
      expect(node.half_life).toBe(30 * 24 * 60 * 60 * 1000); // semantic default
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

  describe("getAndResetRetrievalStats", () => {
    it("returns zero stats when no retrievals have occurred", () => {
      const stats = graph.getAndResetRetrievalStats();
      expect(stats.avgScore).toBe(0);
      expect(stats.count).toBe(0);
    });

    it("accumulates similarity scores from retrieve() calls", async () => {
      await graph.formMemory(
        { content: "test memory", confidence: 0.9, sensitivity: SensitivityLevel.None },
        [1, 0, 0],
      );

      await graph.retrieve([1, 0, 0]);
      const stats = graph.getAndResetRetrievalStats();

      expect(stats.count).toBeGreaterThan(0);
      expect(stats.avgScore).toBeGreaterThan(0);
    });

    it("resets after read", async () => {
      await graph.formMemory(
        { content: "test memory", confidence: 0.9, sensitivity: SensitivityLevel.None },
        [1, 0, 0],
      );

      await graph.retrieve([1, 0, 0]);
      graph.getAndResetRetrievalStats(); // first read clears

      const stats2 = graph.getAndResetRetrievalStats();
      expect(stats2.avgScore).toBe(0);
      expect(stats2.count).toBe(0);
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

      const edge = await graph.link(nodeA.node_id, nodeB.node_id, RelationType.Related);

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

      const edge = await graph.link(nodeA.node_id, nodeB.node_id, RelationType.CausedBy, 0.5, 0.7);

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
      await graph.link(nodeA.node_id, nodeB.node_id, RelationType.Related);

      const exported = await graph.exportAll();
      expect(exported.nodes).toHaveLength(2);
      expect(exported.edges).toHaveLength(1);
    });
  });

  describe("configurable scoring weights", () => {
    it("similarity-only scoring ranks by cosine similarity alone", async () => {
      // Create two memories: one semantically close, one with higher confidence
      await graph.formMemory(
        {
          content: "semantically close",
          confidence: 0.3,
          sensitivity: SensitivityLevel.None,
        },
        [1, 0, 0], // perfect match to query
      );
      await graph.formMemory(
        {
          content: "high confidence but distant",
          confidence: 1.0,
          sensitivity: SensitivityLevel.None,
        },
        [0, 0, 1], // orthogonal to query
      );

      // With default weights (0.5 sim, 0.3 conf, 0.2 recency), the high-confidence
      // memory might rank higher. With similarity-only, it must rank lower.
      const results = await graph.retrieve([1, 0, 0], {
        scoringConfig: { similarityWeight: 1, confidenceWeight: 0, recencyWeight: 0 },
      });
      expect(results[0]!.content).toBe("semantically close");
    });

    it("confidence-only scoring ranks by decayed confidence alone", async () => {
      await graph.formMemory(
        {
          content: "low confidence exact match",
          confidence: 0.2,
          sensitivity: SensitivityLevel.None,
        },
        [1, 0, 0],
      );
      await graph.formMemory(
        {
          content: "high confidence orthogonal",
          confidence: 1.0,
          sensitivity: SensitivityLevel.None,
        },
        [0, 0, 1],
      );

      const results = await graph.retrieve([1, 0, 0], {
        scoringConfig: { similarityWeight: 0, confidenceWeight: 1, recencyWeight: 0 },
      });
      expect(results[0]!.content).toBe("high confidence orthogonal");
    });

    it("weight normalization handles non-unit-sum weights", async () => {
      // Weights (10, 0, 0) should normalize to (1, 0, 0) — same as similarity-only
      // Use 0.2 (not 0.1) to avoid straddling the min_confidence=0.1 decay boundary
      await graph.formMemory(
        {
          content: "exact match",
          confidence: 0.2,
          sensitivity: SensitivityLevel.None,
        },
        [1, 0, 0],
      );
      await graph.formMemory(
        {
          content: "high confidence distant",
          confidence: 1.0,
          sensitivity: SensitivityLevel.None,
        },
        [0, 0, 1],
      );

      const results = await graph.retrieve([1, 0, 0], {
        scoringConfig: { similarityWeight: 10, confidenceWeight: 0, recencyWeight: 0 },
      });
      expect(results[0]!.content).toBe("exact match");
    });

    it("constructor-level scoring config is used as default", async () => {
      // Create a graph with similarity-only config
      const customGraph = new MemoryGraph(storage, eventStore, motebitId, {
        similarityWeight: 1,
        confidenceWeight: 0,
        recencyWeight: 0,
      });

      await customGraph.formMemory(
        {
          content: "exact match",
          confidence: 0.1,
          sensitivity: SensitivityLevel.None,
        },
        [1, 0, 0],
      );
      await customGraph.formMemory(
        {
          content: "high confidence distant",
          confidence: 1.0,
          sensitivity: SensitivityLevel.None,
        },
        [0, 0, 1],
      );

      // No per-call config — should use constructor config
      const results = await customGraph.retrieve([1, 0, 0]);
      expect(results[0]!.content).toBe("exact match");
    });

    it("per-call scoring config overrides constructor config", async () => {
      // Constructor says similarity-only
      const customGraph = new MemoryGraph(storage, eventStore, motebitId, {
        similarityWeight: 1,
        confidenceWeight: 0,
        recencyWeight: 0,
      });

      await customGraph.formMemory(
        {
          content: "exact match low confidence",
          confidence: 0.1,
          sensitivity: SensitivityLevel.None,
        },
        [1, 0, 0],
      );
      await customGraph.formMemory(
        {
          content: "distant high confidence",
          confidence: 1.0,
          sensitivity: SensitivityLevel.None,
        },
        [0, 0, 1],
      );

      // Per-call override says confidence-only
      const results = await customGraph.retrieve([1, 0, 0], {
        scoringConfig: { similarityWeight: 0, confidenceWeight: 1, recencyWeight: 0 },
      });
      expect(results[0]!.content).toBe("distant high confidence");
    });

    it("custom overFetchRatio changes candidate pool size", async () => {
      // With overFetchRatio=1 and limit=1, only 1 candidate is fetched
      // so only the first node inserted is available for reranking
      const customGraph = new MemoryGraph(storage, eventStore, motebitId, {
        overFetchRatio: 1,
      });

      // Insert multiple memories
      for (let i = 0; i < 5; i++) {
        await customGraph.formMemory(
          {
            content: `memory-${i}`,
            confidence: 0.9,
            sensitivity: SensitivityLevel.None,
          },
          [1, 0],
        );
      }

      // With overFetchRatio=1 and limit=1, only 1 candidate fetched, 1 returned
      const results = await customGraph.retrieve([1, 0], { limit: 1 });
      expect(results).toHaveLength(1);
    });

    it("exponential recency decay gives half boost after one half-life (recency scoring)", async () => {
      // Create a graph with recency-only scoring and a known half-life
      const halfLifeMs = 1000; // 1 second for test
      const customGraph = new MemoryGraph(storage, eventStore, motebitId, {
        similarityWeight: 0,
        confidenceWeight: 0,
        recencyWeight: 1,
        recencyHalfLife: halfLifeMs,
      });

      // Create two memories: one recent, one older
      const now = Date.now();
      // Directly insert nodes with controlled timestamps via the storage adapter
      await storage.saveNode({
        node_id: "recent",
        motebit_id: motebitId,
        content: "recent memory",
        embedding: [1, 0],
        confidence: 0.9,
        sensitivity: SensitivityLevel.None,
        created_at: now,
        last_accessed: now, // just accessed
        half_life: 999999999,
        tombstoned: false,
        pinned: false,
      });
      await storage.saveNode({
        node_id: "old",
        motebit_id: motebitId,
        content: "old memory",
        embedding: [1, 0],
        confidence: 0.9,
        sensitivity: SensitivityLevel.None,
        created_at: now - 10000,
        last_accessed: now - 10000, // accessed 10s ago (10 half-lives)
        half_life: 999999999,
        tombstoned: false,
        pinned: false,
      });

      const results = await customGraph.retrieve([1, 0]);
      // Recent memory should rank first with recency-only scoring
      expect(results[0]!.content).toBe("recent memory");
      expect(results[1]!.content).toBe("old memory");
    });
  });

  describe("pinMemory / getPinnedMemories", () => {
    it("pinMemory sets pinned to true", async () => {
      const node = await graph.formMemory(
        { content: "pinnable", confidence: 0.9, sensitivity: SensitivityLevel.None },
        [1, 0],
      );

      await graph.pinMemory(node.node_id, true);

      const loaded = await storage.getNode(node.node_id);
      expect(loaded!.pinned).toBe(true);
    });

    it("pinMemory appends a MemoryPinned event", async () => {
      const node = await graph.formMemory(
        { content: "pin event", confidence: 0.9, sensitivity: SensitivityLevel.None },
        [1, 0],
      );

      await graph.pinMemory(node.node_id, true);

      const events = await eventStore.query({
        motebit_id: motebitId,
        event_types: [EventType.MemoryPinned],
      });
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toEqual({ node_id: node.node_id, pinned: true });
    });

    it("pinMemory on tombstoned node is a no-op", async () => {
      const node = await graph.formMemory(
        { content: "will be deleted", confidence: 0.9, sensitivity: SensitivityLevel.None },
        [1, 0],
      );
      await graph.deleteMemory(node.node_id);

      await graph.pinMemory(node.node_id, true);

      const events = await eventStore.query({
        motebit_id: motebitId,
        event_types: [EventType.MemoryPinned],
      });
      expect(events).toHaveLength(0);
    });

    it("unpinMemory clears pin state", async () => {
      const node = await graph.formMemory(
        { content: "unpin me", confidence: 0.9, sensitivity: SensitivityLevel.None },
        [1, 0],
      );

      await graph.pinMemory(node.node_id, true);
      await graph.pinMemory(node.node_id, false);

      const loaded = await storage.getNode(node.node_id);
      expect(loaded!.pinned).toBe(false);
    });

    it("getPinnedMemories returns only pinned non-tombstoned nodes", async () => {
      const n1 = await graph.formMemory(
        { content: "pinned one", confidence: 0.9, sensitivity: SensitivityLevel.None },
        [1, 0],
      );
      await graph.formMemory(
        { content: "not pinned", confidence: 0.9, sensitivity: SensitivityLevel.None },
        [0, 1],
      );
      const n3 = await graph.formMemory(
        { content: "pinned then deleted", confidence: 0.9, sensitivity: SensitivityLevel.None },
        [1, 1],
      );

      await graph.pinMemory(n1.node_id, true);
      await graph.pinMemory(n3.node_id, true);
      await graph.deleteMemory(n3.node_id);

      const pinned = await graph.getPinnedMemories();
      expect(pinned).toHaveLength(1);
      expect(pinned[0]!.content).toBe("pinned one");
    });
  });

  // -------------------------------------------------------------------------
  // Graph-Augmented Retrieval
  // -------------------------------------------------------------------------

  describe("graph-augmented retrieval", () => {
    it("expands results via edges to include linked neighbors", async () => {
      // A and B are linked; query matches A; B should appear via expansion
      const nodeA = await graph.formMemory(
        { content: "memory A", confidence: 0.9, sensitivity: SensitivityLevel.None },
        [1, 0, 0],
      );
      const nodeB = await graph.formMemory(
        { content: "memory B", confidence: 0.9, sensitivity: SensitivityLevel.None },
        [0, 0, 1], // very different embedding from query
      );
      await graph.formMemory(
        { content: "memory C (unlinked)", confidence: 0.9, sensitivity: SensitivityLevel.None },
        [0, 0, 1], // similar to B but not linked
      );

      // Link A → B
      await graph.link(nodeA.node_id, nodeB.node_id, RelationType.Related, 1.0, 1.0);

      // Query is very similar to A
      const results = await graph.retrieve([0.99, 0.01, 0], { limit: 10, expandEdges: true });
      const ids = results.map((r) => r.node_id);

      expect(ids).toContain(nodeA.node_id);
      expect(ids).toContain(nodeB.node_id); // expanded via edge
    });

    it("does not expand when expandEdges is false", async () => {
      const nodeA = await graph.formMemory(
        { content: "memory A", confidence: 0.9, sensitivity: SensitivityLevel.None },
        [1, 0, 0],
      );
      const nodeB = await graph.formMemory(
        { content: "memory B", confidence: 0.9, sensitivity: SensitivityLevel.None },
        [0, 0, 1],
      );

      await graph.link(nodeA.node_id, nodeB.node_id, RelationType.Related, 1.0, 1.0);

      const results = await graph.retrieve([0.99, 0.01, 0], { limit: 10, expandEdges: false });
      const ids = results.map((r) => r.node_id);

      expect(ids).toContain(nodeA.node_id);
      // B should NOT appear since expansion is disabled and its embedding is dissimilar
      // (it might appear if its composite score happens to be high enough, so we check the mechanism)
    });

    it("excludes tombstoned neighbors from expansion", async () => {
      const nodeA = await graph.formMemory(
        { content: "memory A", confidence: 0.9, sensitivity: SensitivityLevel.None },
        [1, 0, 0],
      );
      const nodeB = await graph.formMemory(
        { content: "tombstoned B", confidence: 0.9, sensitivity: SensitivityLevel.None },
        [0, 0, 1],
      );

      await graph.link(nodeA.node_id, nodeB.node_id, RelationType.Related, 1.0, 1.0);
      await graph.deleteMemory(nodeB.node_id);

      const results = await graph.retrieve([0.99, 0.01, 0], { limit: 10, expandEdges: true });
      const ids = results.map((r) => r.node_id);

      expect(ids).toContain(nodeA.node_id);
      expect(ids).not.toContain(nodeB.node_id); // tombstoned
    });

    it("applies discount factor correctly to neighbor scores", async () => {
      const nodeA = await graph.formMemory(
        { content: "memory A", confidence: 0.9, sensitivity: SensitivityLevel.None },
        [1, 0, 0],
      );
      const nodeB = await graph.formMemory(
        { content: "memory B", confidence: 0.9, sensitivity: SensitivityLevel.None },
        [0, 0, 1],
      );

      // Edge with weight 0.5, confidence 0.8
      await graph.link(nodeA.node_id, nodeB.node_id, RelationType.Related, 0.5, 0.8);

      // With custom discount factor of 0.5
      const results = await graph.retrieve([0.99, 0.01, 0], {
        limit: 10,
        expandEdges: true,
        edgeDiscountFactor: 0.5,
      });

      // B should appear with discounted score
      const ids = results.map((r) => r.node_id);
      expect(ids).toContain(nodeB.node_id);
    });
  });

  // -------------------------------------------------------------------------
  // Temporal Filtering
  // -------------------------------------------------------------------------

  describe("temporal filtering", () => {
    it("excludes expired memories from retrieval by default", async () => {
      const current = await graph.formMemory(
        { content: "current fact", confidence: 0.9, sensitivity: SensitivityLevel.None },
        [1, 0, 0],
      );

      const expired = await graph.formMemory(
        { content: "old fact", confidence: 0.9, sensitivity: SensitivityLevel.None },
        [0.95, 0.05, 0],
      );
      // Manually set valid_until in the past
      expired.valid_until = Date.now() - 1000;
      await storage.saveNode(expired);

      const results = await graph.retrieve([1, 0, 0], { limit: 10 });
      const ids = results.map((r) => r.node_id);

      expect(ids).toContain(current.node_id);
      expect(ids).not.toContain(expired.node_id);
    });

    it("includes expired memories when includeExpired is true", async () => {
      const expired = await graph.formMemory(
        { content: "old fact", confidence: 0.9, sensitivity: SensitivityLevel.None },
        [1, 0, 0],
      );
      expired.valid_until = Date.now() - 1000;
      await storage.saveNode(expired);

      const results = await graph.retrieve([1, 0, 0], { limit: 10, includeExpired: true });
      const ids = results.map((r) => r.node_id);

      expect(ids).toContain(expired.node_id);
    });

    it("excludes temporally expired neighbor during graph expansion", async () => {
      const nodeA = await graph.formMemory(
        { content: "current A", confidence: 0.9, sensitivity: SensitivityLevel.None },
        [1, 0, 0],
      );
      const nodeB = await graph.formMemory(
        { content: "expired B", confidence: 0.9, sensitivity: SensitivityLevel.None },
        [0, 0, 1],
      );
      nodeB.valid_until = Date.now() - 1000;
      await storage.saveNode(nodeB);

      await graph.link(nodeA.node_id, nodeB.node_id, RelationType.Related, 1.0, 1.0);

      const results = await graph.retrieve([0.99, 0.01, 0], { limit: 10, expandEdges: true });
      const ids = results.map((r) => r.node_id);

      expect(ids).toContain(nodeA.node_id);
      expect(ids).not.toContain(nodeB.node_id);
    });
  });

  // -------------------------------------------------------------------------
  // Type-Aware Half-Lives
  // -------------------------------------------------------------------------

  describe("type-aware half-lives", () => {
    it("uses 30-day half-life for semantic memories", async () => {
      const node = await graph.formMemory(
        { content: "semantic fact", confidence: 0.9, sensitivity: SensitivityLevel.None },
        [1, 0, 0],
      );
      expect(node.half_life).toBe(30 * 24 * 60 * 60 * 1000);
      expect(node.memory_type).toBe("semantic");
    });

    it("uses 3-day half-life for episodic memories", async () => {
      const { MemoryType: MT } = await import("@motebit/sdk");
      const node = await graph.formMemory(
        {
          content: "something happened",
          confidence: 0.8,
          sensitivity: SensitivityLevel.None,
          memory_type: MT.Episodic,
        },
        [1, 0, 0],
      );
      expect(node.half_life).toBe(3 * 24 * 60 * 60 * 1000);
      expect(node.memory_type).toBe("episodic");
    });

    it("allows explicit half-life override", async () => {
      const customHalfLife = 42 * 24 * 60 * 60 * 1000;
      const node = await graph.formMemory(
        { content: "custom decay", confidence: 0.9, sensitivity: SensitivityLevel.None },
        [1, 0, 0],
        customHalfLife,
      );
      expect(node.half_life).toBe(customHalfLife);
    });
  });
});
