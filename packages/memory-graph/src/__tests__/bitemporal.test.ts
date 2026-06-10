/**
 * Bi-temporal validity — the in-store half + wire emission + as-of-T recall.
 *
 * A memory has two time dimensions: recording time (`created_at`) and validity
 * time (`valid_from`/`valid_until`). Supersession is invalidation-with-
 * provenance — it sets `valid_until` on the old node and keeps it live, never
 * mutating content or tombstoning. Recall defaults to "current" but can
 * reconstruct "what was believed valid at T". See spec/memory-delta-v1.md §3.5
 * and docs/doctrine/memory-architecture.md.
 */
import { describe, it, expect } from "vitest";
import {
  InMemoryMemoryStorage,
  MemoryGraph,
  recallRelevantCore,
  isValidAt,
  ConsolidationAction,
} from "../index.js";
import type { ScoringConfig } from "../index.js";
import type { ConsolidationProvider } from "../consolidation.js";
import { EventStore, InMemoryEventStore } from "@motebit/event-log";
import { MemoryType, SensitivityLevel, RelationType, EventType } from "@motebit/sdk";
import type { MemoryNode, AttributedMemoryCandidate } from "@motebit/sdk";

const SCORING: ScoringConfig = {
  similarityWeight: 0.5,
  confidenceWeight: 0.3,
  recencyWeight: 0.2,
  recencyHalfLife: 86_400_000,
  overFetchRatio: 5,
};
const EMB = [1, 0, 0, 0, 0, 0, 0, 0];

function makeNode(id: string, validFrom: number, validUntil: number | null): MemoryNode {
  return {
    node_id: id,
    motebit_id: "m",
    content: id,
    embedding: EMB,
    confidence: 0.9,
    sensitivity: SensitivityLevel.None,
    created_at: validFrom,
    last_accessed: validFrom,
    half_life: Number.MAX_SAFE_INTEGER,
    tombstoned: false,
    pinned: false,
    memory_type: MemoryType.Semantic,
    valid_from: validFrom,
    valid_until: validUntil,
  };
}

describe("isValidAt — bi-temporal interval predicate", () => {
  it("true when valid_from <= t < valid_until", () => {
    expect(isValidAt(makeNode("a", 1000, 2000), 1500)).toBe(true);
  });

  it("false before valid_from", () => {
    expect(isValidAt(makeNode("a", 1000, 2000), 500)).toBe(false);
  });

  it("false at/after valid_until (exclusive upper bound)", () => {
    expect(isValidAt(makeNode("a", 1000, 2000), 2000)).toBe(false);
    expect(isValidAt(makeNode("a", 1000, 2000), 2500)).toBe(false);
  });

  it("open upper bound (null) is valid forever after valid_from", () => {
    expect(isValidAt(makeNode("a", 1000, null), 9_999_999)).toBe(true);
  });

  it("legacy node (no validity fields) is valid at every t — pre-bi-temporal logs read identically", () => {
    const legacy = makeNode("a", 0, null);
    delete (legacy as Partial<MemoryNode>).valid_from;
    delete (legacy as Partial<MemoryNode>).valid_until;
    expect(isValidAt(legacy, 12_345)).toBe(true);
  });
});

describe("recallRelevantCore — as-of-T reconstruction", () => {
  // A was believed valid [1000, 2000); B superseded it and is valid [2000, open).
  const A = makeNode("A", 1000, 2000);
  const B = makeNode("B", 2000, null);

  async function storageWith(...nodes: MemoryNode[]): Promise<InMemoryMemoryStorage> {
    const s = new InMemoryMemoryStorage();
    for (const n of nodes) await s.saveNode(n);
    return s;
  }

  const recall = (storage: InMemoryMemoryStorage, options: Record<string, unknown>) =>
    recallRelevantCore({
      storage,
      motebitId: "m",
      queryEmbedding: EMB,
      baseScoring: SCORING,
      options: { expandEdges: false, ...options },
    });

  it("asOf inside A's interval returns the superseded belief (A), not the future belief (B)", async () => {
    const storage = await storageWith(A, B);
    const { nodes } = await recall(storage, { asOf: 1500 });
    const ids = nodes.map((n) => n.node_id);
    expect(ids).toContain("A");
    expect(ids).not.toContain("B");
  });

  it("default (now) returns the current belief (B); A has expired", async () => {
    const storage = await storageWith(A, B);
    const { nodes } = await recall(storage, {});
    const ids = nodes.map((n) => n.node_id);
    expect(ids).toContain("B");
    expect(ids).not.toContain("A");
  });

  it("includeExpired returns both intervals regardless of T", async () => {
    const storage = await storageWith(A, B);
    const { nodes } = await recall(storage, { includeExpired: true });
    expect(nodes.map((n) => n.node_id).sort()).toEqual(["A", "B"]);
  });
});

describe("supersession is invalidation-with-provenance + emits validity on the wire", () => {
  it("sets valid_until on the superseded node, keeps it live (no tombstone) + Supersedes edge, and emits the validity fields", async () => {
    const storage = new InMemoryMemoryStorage();
    const eventStore = new EventStore(new InMemoryEventStore());
    const captured: Array<{
      event_type: string;
      payload: {
        node_id?: string;
        valid_from?: number;
        valid_until?: number | null;
        superseded_valid_until?: number | null;
      };
    }> = [];
    const origAppend = eventStore.appendWithClock.bind(eventStore);
    eventStore.appendWithClock = async (e) => {
      captured.push(e as (typeof captured)[number]);
      return origAppend(e);
    };
    const graph = new MemoryGraph(storage, eventStore, "m");

    const cand = (content: string): AttributedMemoryCandidate => ({
      content,
      source: "user_stated",
      confidence: 0.9,
      sensitivity: SensitivityLevel.None,
      memory_type: MemoryType.Semantic,
    });

    const a = await graph.formMemory(cand("user lives in NYC"), EMB);
    const provider: ConsolidationProvider = {
      classify: () =>
        Promise.resolve({
          action: ConsolidationAction.UPDATE,
          existingNodeId: a.node_id,
          reason: "user moved",
        }),
    };
    const { node: b } = await graph.consolidateAndForm(cand("user lives in LA"), EMB, provider);

    // Superseded node A: valid_until set, NOT tombstoned, still in storage.
    const aAfter = await storage.getNode(a.node_id);
    expect(aAfter).not.toBeNull();
    expect(aAfter!.tombstoned).toBe(false);
    expect(typeof aAfter!.valid_until).toBe("number");

    // New node B is live with a defined valid_from.
    expect(b).not.toBeNull();
    expect(typeof b!.valid_from).toBe("number");

    // Supersedes edge connects B and A (provenance retained).
    const edges = await storage.getEdges(b!.node_id);
    expect(
      edges.some(
        (e) =>
          e.relation_type === RelationType.Supersedes &&
          (e.target_id === a.node_id || e.source_id === a.node_id),
      ),
    ).toBe(true);

    // Wire emission: memory_formed(A) carried valid_from/valid_until.
    const formedA = captured.find(
      (e) => e.event_type === EventType.MemoryFormed && e.payload.node_id === a.node_id,
    );
    expect(formedA?.payload.valid_from).toBe(a.valid_from);
    expect(formedA?.payload).toHaveProperty("valid_until");

    // Wire emission: memory_consolidated carried superseded_valid_until = A.valid_until.
    const consolidated = captured.find((e) => e.event_type === EventType.MemoryConsolidated);
    expect(consolidated?.payload.superseded_valid_until).toBe(aAfter!.valid_until);
  });
});
