import type { MemoryNode, MemoryEdge } from "@motebit/sdk";
import type { MemoryStorageAdapter, MemoryQuery } from "@motebit/memory-graph";
import { computeDecayedConfidence } from "@motebit/memory-graph";
import { idbRequest } from "./idb.js";

export class IdbMemoryStorage implements MemoryStorageAdapter {
  constructor(private db: IDBDatabase) {}

  async saveNode(node: MemoryNode): Promise<void> {
    const tx = this.db.transaction("memory_nodes", "readwrite");
    await idbRequest(tx.objectStore("memory_nodes").put(node));
  }

  async getNode(nodeId: string): Promise<MemoryNode | null> {
    const tx = this.db.transaction("memory_nodes", "readonly");
    const result = (await idbRequest(tx.objectStore("memory_nodes").get(nodeId))) as MemoryNode | undefined;
    return result ?? null;
  }

  async queryNodes(query: MemoryQuery): Promise<MemoryNode[]> {
    const tx = this.db.transaction("memory_nodes", "readonly");
    const store = tx.objectStore("memory_nodes");
    const index = store.index("motebit_id");
    const range = IDBKeyRange.only(query.motebit_id);
    let results = await idbRequest(index.getAll(range)) as MemoryNode[];

    // Filter tombstoned
    if (query.include_tombstoned !== true) {
      results = results.filter((n) => !n.tombstoned);
    }

    // Filter by pinned
    if (query.pinned !== undefined) {
      results = results.filter((n) => n.pinned === query.pinned);
    }

    // Filter by decayed confidence
    if (query.min_confidence !== undefined) {
      const now = Date.now();
      results = results.filter((n) => {
        const decayed = computeDecayedConfidence(
          n.confidence,
          n.half_life,
          now - n.created_at,
        );
        return decayed >= query.min_confidence!;
      });
    }

    // Filter by sensitivity
    if (query.sensitivity_filter !== undefined) {
      results = results.filter((n) =>
        query.sensitivity_filter!.includes(n.sensitivity),
      );
    }

    // Sort by recency and apply limit
    if (query.limit !== undefined) {
      results.sort((a, b) => b.last_accessed - a.last_accessed);
      results = results.slice(0, query.limit);
    }

    return results;
  }

  async saveEdge(edge: MemoryEdge): Promise<void> {
    const tx = this.db.transaction("memory_edges", "readwrite");
    await idbRequest(tx.objectStore("memory_edges").put(edge));
  }

  async getEdges(nodeId: string): Promise<MemoryEdge[]> {
    const tx = this.db.transaction("memory_edges", "readonly");
    const store = tx.objectStore("memory_edges");

    // Union of source_id and target_id lookups
    const bySource = await idbRequest(
      store.index("source_id").getAll(IDBKeyRange.only(nodeId)),
    ) as MemoryEdge[];
    const byTarget = await idbRequest(
      store.index("target_id").getAll(IDBKeyRange.only(nodeId)),
    ) as MemoryEdge[];

    // Deduplicate by edge_id
    const seen = new Set<string>();
    const result: MemoryEdge[] = [];
    for (const edge of [...bySource, ...byTarget]) {
      if (!seen.has(edge.edge_id)) {
        seen.add(edge.edge_id);
        result.push(edge);
      }
    }
    return result;
  }

  async tombstoneNode(nodeId: string): Promise<void> {
    const tx = this.db.transaction("memory_nodes", "readwrite");
    const store = tx.objectStore("memory_nodes");
    const node = await idbRequest(store.get(nodeId)) as MemoryNode | undefined;
    if (node) {
      node.tombstoned = true;
      await idbRequest(store.put(node));
    }
  }

  async pinNode(nodeId: string, pinned: boolean): Promise<void> {
    const tx = this.db.transaction("memory_nodes", "readwrite");
    const store = tx.objectStore("memory_nodes");
    const node = await idbRequest(store.get(nodeId)) as MemoryNode | undefined;
    if (node && !node.tombstoned) {
      node.pinned = pinned;
      await idbRequest(store.put(node));
    }
  }

  async getAllNodes(motebitId: string): Promise<MemoryNode[]> {
    const tx = this.db.transaction("memory_nodes", "readonly");
    const store = tx.objectStore("memory_nodes");
    const index = store.index("motebit_id");
    return await idbRequest(index.getAll(IDBKeyRange.only(motebitId))) as MemoryNode[];
  }

  async getAllEdges(motebitId: string): Promise<MemoryEdge[]> {
    // Two-step: get all node IDs for motebit, then fetch edges where either endpoint matches
    const tx = this.db.transaction(["memory_nodes", "memory_edges"], "readonly");
    const nodeStore = tx.objectStore("memory_nodes");
    const edgeStore = tx.objectStore("memory_edges");

    const nodes = await idbRequest(
      nodeStore.index("motebit_id").getAll(IDBKeyRange.only(motebitId)),
    ) as MemoryNode[];
    const nodeIds = new Set(nodes.map((n) => n.node_id));

    const allEdges = await idbRequest(edgeStore.getAll()) as MemoryEdge[];
    return allEdges.filter(
      (e) => nodeIds.has(e.source_id) || nodeIds.has(e.target_id),
    );
  }
}
