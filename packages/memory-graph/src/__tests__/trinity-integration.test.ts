/**
 * Memory Trinity integration smoke test.
 *
 * Pins the composition of the three primitives — index + promotion +
 * rewrite — not the unit behavior of each (that's what the existing
 * `promotion.test.ts`, `memory-index.test.ts`, and
 * `rewrite-memory.test.ts` cover). This file catches regressions
 * where the three pieces individually pass but their interaction
 * breaks: e.g. promotion fires but the index doesn't pick up the
 * absolute label, or rewrite supersedes but the index still shows
 * the old content.
 *
 * Scenario:
 *   1. Form two memories at baseline confidence.
 *   2. Reinforce one of them via the consolidation REINFORCE path
 *      until its confidence crosses the promotion threshold.
 *   3. Assert `memory_promoted` was emitted exactly once (idempotency
 *      from §5.8 — the second reinforcement past threshold MUST NOT
 *      re-emit).
 *   4. Build the index and assert the promoted memory renders
 *      `(absolute)` while the other is `(confident)`.
 *   5. Rewrite the promoted memory via `supersedeMemoryByNodeId`.
 *   6. Assert the original `memory_formed` event is preserved in the
 *      log, a fresh `memory_formed` event exists for the replacement,
 *      and `memory_consolidated{action:"supersede"}` bridges them.
 *   7. Rebuild the index and assert the old content is gone and the
 *      new content is present.
 *
 * Storage and event log are both in-memory so the test is
 * sub-millisecond and deterministic.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { EventStore, InMemoryEventStore } from "@motebit/event-log";
import { SensitivityLevel, EventType } from "@motebit/sdk";
import type { EventLogEntry } from "@motebit/sdk";
import {
  InMemoryMemoryStorage,
  MemoryGraph,
  PROMOTION_CONFIDENCE_THRESHOLD,
  buildMemoryIndex,
} from "../index.js";
import { ConsolidationAction } from "../consolidation.js";

const MOTEBIT_ID = "mb-trinity";

async function countEventsOfType(
  eventStore: EventStore,
  eventType: EventType,
): Promise<EventLogEntry[]> {
  const all = await eventStore.query({ motebit_id: MOTEBIT_ID, event_types: [eventType] });
  return all;
}

describe("Memory Trinity — end-to-end composition", () => {
  let storage: InMemoryMemoryStorage;
  let eventStore: EventStore;
  let graph: MemoryGraph;

  // Injected embedder for the supersede path — deterministic and instant, so
  // these tests never lazy-load the ~90MB ONNX model. The real embedText path
  // stays covered by index.test.ts.
  const fastEmbed = async (): Promise<number[]> => [0.1, 0.1, 0.1];

  beforeEach(() => {
    storage = new InMemoryMemoryStorage();
    eventStore = new EventStore(new InMemoryEventStore());
    graph = new MemoryGraph(storage, eventStore, MOTEBIT_ID, undefined, fastEmbed);
  });

  /**
   * Drive the REINFORCE path directly by calling `consolidateAndForm`
   * with a stub provider that always returns REINFORCE for a given
   * target. Cleaner than embedding an LLM mock; mirrors the
   * real consolidation path's effect on confidence + promotion.
   */
  async function reinforceOnto(targetNodeId: string, content: string): Promise<void> {
    await graph.consolidateAndForm(
      {
        content,
        confidence: 0.8,
        sensitivity: SensitivityLevel.None,
        source: "user_stated",
      },
      [0.1, 0.1, 0.1],
      {
        classify: async () => ({
          action: ConsolidationAction.REINFORCE,
          existingNodeId: targetNodeId,
          reason: "confirms",
        }),
      },
    );
  }

  // This test composes seven graph operations end-to-end (form / reinforce /
  // promote / index / rewrite / supersede / verify). It used to false-fail on
  // contended CI at a raised 15s timeout — but the real culprit was the
  // supersede path lazy-loading the ~90MB ONNX embedding model under a starved
  // runner, not the arithmetic. With `fastEmbed` injected (above) there is no
  // model load, so the test runs in milliseconds and inherits the shared 30s
  // default (the old explicit 15s override was, after the shared default rose
  // to 30s, silently capping this test BELOW everyone else's ceiling).
  it("forms → reinforces → promotes → indexes absolute → rewrites → supersedes cleanly", async () => {
    // 1. Form two memories. Use a baseline confidence safely below the
    //    0.95 threshold so we can observe the crossing.
    const nodeA = await graph.formMemory(
      {
        content: "User prefers TypeScript",
        confidence: 0.75,
        sensitivity: SensitivityLevel.None,
        source: "user_stated",
      },
      [0.1, 0.2, 0.3],
    );
    const nodeB = await graph.formMemory(
      {
        content: "User lives in SF",
        confidence: 0.75,
        sensitivity: SensitivityLevel.None,
        source: "user_stated",
      },
      [0.4, 0.5, 0.6],
    );

    // Sanity check: neither is above the threshold yet.
    const after0 = await storage.getNode(nodeA.node_id);
    expect(after0!.confidence).toBeLessThan(PROMOTION_CONFIDENCE_THRESHOLD);

    // 2. Reinforce A three times. Motebit boosts confidence by +0.1
    //    per reinforcement: 0.75 → 0.85 → 0.95 → 1.0. Promotion crosses
    //    the threshold on the second reinforcement.
    await reinforceOnto(nodeA.node_id, "Once more, TypeScript preference");
    await reinforceOnto(nodeA.node_id, "Again, TypeScript");
    await reinforceOnto(nodeA.node_id, "Yet again");

    // 3. memory_promoted emitted exactly once — idempotent past threshold.
    const promotions = await countEventsOfType(eventStore, EventType.MemoryPromoted);
    expect(promotions).toHaveLength(1);
    expect(promotions[0]!.payload).toMatchObject({
      node_id: nodeA.node_id,
      to_confidence: expect.any(Number),
    });
    expect(promotions[0]!.payload.to_confidence).toBeGreaterThanOrEqual(
      PROMOTION_CONFIDENCE_THRESHOLD,
    );

    // 4. Index reflects the absolute certainty label.
    //    Build directly with current storage snapshot.
    const nodes = await storage.getAllNodes(MOTEBIT_ID);
    const edges = await storage.getAllEdges(MOTEBIT_ID);
    const indexV1 = buildMemoryIndex(nodes, edges);

    expect(indexV1).toContain("User prefers TypeScript");
    expect(indexV1).toContain("User lives in SF");
    expect(indexV1).toMatch(/User prefers TypeScript.*\(absolute, from:user\)/);
    expect(indexV1).toMatch(/User lives in SF.*\(confident, from:user\)/);

    // 5. Agent decides the memory was wrong and rewrites via the
    //    tool path.
    const newNodeId = await graph.supersedeMemoryByNodeId(
      nodeA.node_id,
      "User actually prefers Rust now",
      "user correction mid-conversation",
    );

    // 6. Event-log audit — original, replacement, and supersede bridge.
    const formed = await countEventsOfType(eventStore, EventType.MemoryFormed);
    // Two original formations + one from the supersede path = 3 total.
    // Every reinforcement skips the formMemory call (REINFORCE boosts
    // in place, no new node), so only the supersede adds.
    expect(formed).toHaveLength(3);
    const formedIds = formed.map((e) => e.payload.node_id);
    expect(formedIds).toContain(nodeA.node_id); // original preserved (append-only)
    expect(formedIds).toContain(nodeB.node_id);
    expect(formedIds).toContain(newNodeId);

    const consolidations = await countEventsOfType(eventStore, EventType.MemoryConsolidated);
    const supersedeEvent = consolidations.find((e) => e.payload.action === "supersede");
    expect(supersedeEvent).toBeDefined();
    expect(supersedeEvent!.payload).toMatchObject({
      action: "supersede",
      existing_node_id: nodeA.node_id,
      new_node_id: newNodeId,
    });

    // 7. Index rebuilds with the new content; old is gone from live view.
    const nodes2 = await storage.getAllNodes(MOTEBIT_ID);
    const edges2 = await storage.getAllEdges(MOTEBIT_ID);
    const indexV2 = buildMemoryIndex(nodes2, edges2);
    expect(indexV2).not.toContain("User prefers TypeScript");
    expect(indexV2).toContain("User actually prefers Rust now");
    // User lives in SF remains untouched.
    expect(indexV2).toContain("User lives in SF");
  });

  it("MemoryGraph.getMemoryIndex wraps buildMemoryIndex over live storage", async () => {
    // Empty graph produces the empty-state string.
    const emptyIndex = await graph.getMemoryIndex();
    expect(emptyIndex).toBe("");

    await graph.formMemory(
      {
        content: "Pinned anchor fact",
        confidence: 0.9,
        sensitivity: SensitivityLevel.None,
        source: "user_stated",
      },
      [0.1, 0.2, 0.3],
    );

    const index = await graph.getMemoryIndex();
    expect(index).toContain("Memory Index");
    expect(index).toContain("Pinned anchor fact");

    // Caller-supplied options pass through to the underlying builder
    // — tight maxSummaryChars truncates the rendered content summary.
    const tight = await graph.getMemoryIndex({ maxSummaryChars: 5 });
    expect(tight).toContain("Pinne"); // first 5 chars of "Pinned anchor fact"
    expect(tight).not.toContain("Pinned anchor fact");
  });

  it("short node-id prefix resolves to the exact live node", async () => {
    const node = await graph.formMemory(
      {
        content: "User's favorite color is blue",
        confidence: 0.8,
        sensitivity: SensitivityLevel.None,
        source: "user_stated",
      },
      [0.1, 0.1, 0.1],
    );

    const short = node.node_id.slice(0, 8);
    const resolution = await graph.resolveNodeIdPrefix(short);
    expect(resolution).toEqual({ kind: "ok", nodeId: node.node_id });

    const full = await graph.resolveNodeIdPrefix(node.node_id);
    expect(full).toEqual({ kind: "ok", nodeId: node.node_id });

    const notFound = await graph.resolveNodeIdPrefix("zzzzzzzz");
    expect(notFound).toEqual({ kind: "not_found" });
  });

  it("superseding a non-existent or already-superseded node throws a usable error", async () => {
    await expect(
      graph.supersedeMemoryByNodeId("not-a-real-node", "whatever", "testing"),
    ).rejects.toThrow(/No memory node/);

    const node = await graph.formMemory(
      {
        content: "Will supersede this",
        confidence: 0.8,
        sensitivity: SensitivityLevel.None,
        source: "user_stated",
      },
      [0.1, 0.1, 0.1],
    );

    // Supersede once — the old node is INVALIDATED (valid_until set) but kept
    // live, never tombstoned (history is preserved for as-of recall).
    await graph.supersedeMemoryByNodeId(node.node_id, "Replacement", "first");
    const superseded = await graph.getNode(node.node_id);
    expect(superseded!.tombstoned).toBe(false);
    expect(superseded!.valid_until).not.toBeNull();

    // Superseding the now-invalidated node again should fail cleanly (you rewrite
    // the CURRENT belief, not an already-closed interval).
    await expect(
      graph.supersedeMemoryByNodeId(node.node_id, "Second replacement", "second"),
    ).rejects.toThrow(/already superseded/);
  });
});
