import { describe, it, expect, beforeEach } from "vitest";
import { SensitivityLevel, RelationType } from "@motebit/sdk";
import type { MemoryNode, MemoryEdge } from "@motebit/sdk";
import { openMotebitDB } from "../idb.js";
import { IdbMemoryStorage } from "../memory-storage.js";

describe("IdbMemoryStorage", () => {
  let storage: IdbMemoryStorage;

  beforeEach(async () => {
    const db = await openMotebitDB(`test-memory-${crypto.randomUUID()}`);
    storage = new IdbMemoryStorage(db);
  });

  function makeNode(overrides: Partial<MemoryNode> = {}): MemoryNode {
    return {
      node_id: crypto.randomUUID(),
      motebit_id: "mote-1",
      content: "test memory",
      embedding: [0.1, 0.2, 0.3],
      confidence: 0.9,
      sensitivity: SensitivityLevel.None,
      created_at: Date.now(),
      last_accessed: Date.now(),
      half_life: 7 * 24 * 60 * 60 * 1000,
      tombstoned: false,
      pinned: false,
      ...overrides,
    };
  }

  function makeEdge(overrides: Partial<MemoryEdge> = {}): MemoryEdge {
    return {
      edge_id: crypto.randomUUID(),
      source_id: "src-1",
      target_id: "tgt-1",
      relation_type: RelationType.Related,
      weight: 1.0,
      confidence: 1.0,
      ...overrides,
    };
  }

  it("saves and gets a node", async () => {
    const node = makeNode();
    await storage.saveNode(node);
    const loaded = await storage.getNode(node.node_id);
    expect(loaded).not.toBeNull();
    expect(loaded!.content).toBe("test memory");
    expect(loaded!.embedding).toEqual([0.1, 0.2, 0.3]);
  });

  it("returns null for missing node", async () => {
    const loaded = await storage.getNode("missing");
    expect(loaded).toBeNull();
  });

  it("upserts nodes (put)", async () => {
    const node = makeNode({ content: "original" });
    await storage.saveNode(node);
    await storage.saveNode({ ...node, content: "updated" });
    const loaded = await storage.getNode(node.node_id);
    expect(loaded!.content).toBe("updated");
  });

  it("queryNodes filters by motebit_id", async () => {
    await storage.saveNode(makeNode({ motebit_id: "mote-1" }));
    await storage.saveNode(makeNode({ motebit_id: "mote-2" }));

    const results = await storage.queryNodes({ motebit_id: "mote-1" });
    expect(results).toHaveLength(1);
  });

  it("queryNodes excludes tombstoned by default", async () => {
    await storage.saveNode(makeNode({ tombstoned: true }));
    await storage.saveNode(makeNode({ tombstoned: false }));

    const results = await storage.queryNodes({ motebit_id: "mote-1" });
    expect(results).toHaveLength(1);
  });

  it("queryNodes includes tombstoned when requested", async () => {
    await storage.saveNode(makeNode({ tombstoned: true }));
    await storage.saveNode(makeNode({ tombstoned: false }));

    const results = await storage.queryNodes({
      motebit_id: "mote-1",
      include_tombstoned: true,
    });
    expect(results).toHaveLength(2);
  });

  it("queryNodes filters by decayed confidence", async () => {
    // Node with very short half-life, created far in the past — will have decayed
    await storage.saveNode(makeNode({
      confidence: 0.5,
      half_life: 1, // 1ms half-life
      created_at: Date.now() - 100000, // 100 seconds ago
    }));
    // Node with high confidence and long half-life
    await storage.saveNode(makeNode({
      confidence: 0.9,
      half_life: 7 * 24 * 60 * 60 * 1000,
      created_at: Date.now(),
    }));

    const results = await storage.queryNodes({
      motebit_id: "mote-1",
      min_confidence: 0.1,
    });
    expect(results).toHaveLength(1);
  });

  it("queryNodes filters by sensitivity", async () => {
    await storage.saveNode(makeNode({ sensitivity: SensitivityLevel.None }));
    await storage.saveNode(makeNode({ sensitivity: SensitivityLevel.Medical }));

    const results = await storage.queryNodes({
      motebit_id: "mote-1",
      sensitivity_filter: [SensitivityLevel.None],
    });
    expect(results).toHaveLength(1);
  });

  it("queryNodes applies limit", async () => {
    await storage.saveNode(makeNode());
    await storage.saveNode(makeNode());
    await storage.saveNode(makeNode());

    const results = await storage.queryNodes({ motebit_id: "mote-1", limit: 2 });
    expect(results).toHaveLength(2);
  });

  it("queryNodes filters by pinned", async () => {
    await storage.saveNode(makeNode({ pinned: true }));
    await storage.saveNode(makeNode({ pinned: false }));

    const pinned = await storage.queryNodes({ motebit_id: "mote-1", pinned: true });
    expect(pinned).toHaveLength(1);
    expect(pinned[0]!.pinned).toBe(true);

    const unpinned = await storage.queryNodes({ motebit_id: "mote-1", pinned: false });
    expect(unpinned).toHaveLength(1);
    expect(unpinned[0]!.pinned).toBe(false);
  });

  it("saves and gets edges", async () => {
    const edge = makeEdge();
    await storage.saveEdge(edge);
    const loaded = await storage.getEdges("src-1");
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.edge_id).toBe(edge.edge_id);
  });

  it("getEdges returns edges from both directions", async () => {
    const nodeId = "node-center";
    await storage.saveEdge(makeEdge({ source_id: nodeId, target_id: "other-1" }));
    await storage.saveEdge(makeEdge({ source_id: "other-2", target_id: nodeId }));

    const edges = await storage.getEdges(nodeId);
    expect(edges).toHaveLength(2);
  });

  it("getEdges deduplicates edges found in both indexes", async () => {
    // An edge where the node appears on both sides
    const nodeId = "self-ref";
    const edge = makeEdge({ source_id: nodeId, target_id: nodeId });
    await storage.saveEdge(edge);

    const edges = await storage.getEdges(nodeId);
    expect(edges).toHaveLength(1);
  });

  it("tombstones a node", async () => {
    const node = makeNode();
    await storage.saveNode(node);
    await storage.tombstoneNode(node.node_id);

    const loaded = await storage.getNode(node.node_id);
    expect(loaded!.tombstoned).toBe(true);
  });

  it("tombstoneNode is no-op for missing node", async () => {
    await storage.tombstoneNode("missing"); // should not throw
  });

  it("getAllNodes returns all nodes for a motebit", async () => {
    await storage.saveNode(makeNode({ motebit_id: "mote-1" }));
    await storage.saveNode(makeNode({ motebit_id: "mote-1", tombstoned: true }));
    await storage.saveNode(makeNode({ motebit_id: "mote-2" }));

    const all = await storage.getAllNodes("mote-1");
    expect(all).toHaveLength(2); // includes tombstoned
  });

  it("getAllEdges returns edges for nodes belonging to a motebit", async () => {
    const n1 = makeNode({ node_id: "n1", motebit_id: "mote-1" });
    const n2 = makeNode({ node_id: "n2", motebit_id: "mote-1" });
    const n3 = makeNode({ node_id: "n3", motebit_id: "mote-2" });
    await storage.saveNode(n1);
    await storage.saveNode(n2);
    await storage.saveNode(n3);

    await storage.saveEdge(makeEdge({ source_id: "n1", target_id: "n2" }));
    await storage.saveEdge(makeEdge({ source_id: "n3", target_id: "n3" }));

    const edges = await storage.getAllEdges("mote-1");
    expect(edges).toHaveLength(1);
  });
});
