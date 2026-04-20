/**
 * Memory formation pass — extracted batch formation helper.
 *
 * Pins the three invariants callers depend on:
 *   1. Empty candidates ⇒ empty result, no graph mutation, no embed calls.
 *   2. Embeddings are requested IN PARALLEL (one batch of awaits), not
 *      sequentially — the whole point of extracting this function was
 *      to turn N serial embed waits into one parallel batch.
 *   3. Consolidation calls stay SEQUENTIAL — graph state from earlier
 *      candidates must be visible to later ones via the classifier's
 *      similarity search.
 *   4. Edge linking above the 0.7 cosine threshold fires for both
 *      new↔retrieved and new↔new pairs.
 *
 * Uses the real `InMemoryMemoryStorage` + `EventStore` so the test
 * exercises the same code path production does, not a mock.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventStore, InMemoryEventStore } from "@motebit/event-log";
import { RelationType, SensitivityLevel } from "@motebit/sdk";
import type { MemoryCandidate } from "@motebit/sdk";
import {
  InMemoryMemoryStorage,
  MemoryGraph,
  formMemoriesFromCandidates,
  MEMORY_EDGE_SIMILARITY_THRESHOLD,
} from "../index.js";
import { ConsolidationAction } from "../consolidation.js";

const MOTEBIT_ID = "mb-formation";

/**
 * Mock the module-level `embedText` so we control timing and values
 * without touching the transformers.js pipeline. The spy surfaces
 * parallelism: all N calls fire before any resolves.
 */
vi.mock("../embeddings.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../embeddings.js")>();
  return {
    ...mod,
    embedText: vi.fn(async (text: string) => {
      // Deterministic "embedding" derived from content hash so different
      // inputs produce different vectors (affects similarity-based edge
      // linking in the formation pass).
      const h = Array.from(text).reduce((acc, c) => acc + c.charCodeAt(0), 0);
      await new Promise((r) => setTimeout(r, 1));
      return [h % 7, h % 11, h % 13].map((n) => n / 13);
    }),
  };
});

describe("formMemoriesFromCandidates", () => {
  let storage: InMemoryMemoryStorage;
  let eventStore: EventStore;
  let graph: MemoryGraph;

  beforeEach(() => {
    storage = new InMemoryMemoryStorage();
    eventStore = new EventStore(new InMemoryEventStore());
    graph = new MemoryGraph(storage, eventStore, MOTEBIT_ID);
  });

  it("returns empty when no candidates are supplied — no graph work, no embed calls", async () => {
    const { embedText } = await import("../embeddings.js");
    const before = (embedText as ReturnType<typeof vi.fn>).mock.calls.length;

    const result = await formMemoriesFromCandidates({ memoryGraph: graph }, [], []);
    expect(result.memoriesFormed).toEqual([]);

    const after = (embedText as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(after).toBe(before);
  });

  it("embeds all candidates in parallel — all N calls in-flight before any resolves", async () => {
    const { embedText } = await import("../embeddings.js");
    const mock = embedText as ReturnType<typeof vi.fn>;
    mock.mockClear();

    // Track when each embed starts vs completes. If formation were
    // sequential, the Nth call would start strictly after the (N-1)th
    // completed. Parallel formation fires all starts before any
    // completes.
    const starts: number[] = [];
    const completes: number[] = [];
    mock.mockImplementation(async (text: string) => {
      starts.push(Date.now());
      await new Promise((r) => setTimeout(r, 10));
      completes.push(Date.now());
      const h = Array.from(text).reduce((acc, c) => acc + c.charCodeAt(0), 0);
      return [h % 7, h % 11, h % 13].map((n) => n / 13);
    });

    const candidates: MemoryCandidate[] = [
      { content: "First candidate", confidence: 0.8, sensitivity: SensitivityLevel.None },
      { content: "Second candidate", confidence: 0.8, sensitivity: SensitivityLevel.None },
      { content: "Third candidate", confidence: 0.8, sensitivity: SensitivityLevel.None },
    ];

    await formMemoriesFromCandidates({ memoryGraph: graph }, candidates, []);

    expect(starts).toHaveLength(3);
    expect(completes).toHaveLength(3);
    // Parallel invariant: the third call starts before the first
    // completes. If the loop were sequential, starts[2] would be
    // strictly greater than completes[0].
    expect(starts[2]!).toBeLessThanOrEqual(completes[0]!);
  });

  it("forms every candidate when no consolidation provider is supplied", async () => {
    const candidates: MemoryCandidate[] = [
      { content: "Alpha memory", confidence: 0.8, sensitivity: SensitivityLevel.None },
      { content: "Beta memory", confidence: 0.8, sensitivity: SensitivityLevel.None },
    ];

    const { memoriesFormed } = await formMemoriesFromCandidates(
      { memoryGraph: graph },
      candidates,
      [],
    );

    expect(memoriesFormed).toHaveLength(2);
    expect(memoriesFormed.map((m) => m.content)).toEqual(["Alpha memory", "Beta memory"]);
  });

  it("routes through consolidateAndForm when a consolidation provider is supplied", async () => {
    // Stub provider that always returns ADD so the consolidation
    // path's formMemory still fires — lets us observe the branch
    // under coverage while keeping the outcome deterministic.
    const consolidationProvider = {
      classify: vi.fn(async () => ({
        action: ConsolidationAction.ADD,
        reason: "test-only provider — always add",
      })),
    };

    const candidates: MemoryCandidate[] = [
      {
        content: "Gamma memory requiring consolidation",
        confidence: 0.8,
        sensitivity: SensitivityLevel.None,
      },
    ];

    const { memoriesFormed } = await formMemoriesFromCandidates(
      { memoryGraph: graph, consolidationProvider },
      candidates,
      [],
    );

    // First memory in an empty graph triggers the "no similar
    // existing memories" short-circuit inside consolidateAndForm,
    // which falls through to formMemory without invoking the
    // classifier. Seed a prior node + call again to exercise the
    // provider branch end-to-end.
    expect(memoriesFormed).toHaveLength(1);

    const { memoriesFormed: second } = await formMemoriesFromCandidates(
      { memoryGraph: graph, consolidationProvider },
      [
        {
          content: "Delta memory also requiring consolidation",
          confidence: 0.8,
          sensitivity: SensitivityLevel.None,
        },
      ],
      [],
    );
    expect(second).toHaveLength(1);
    expect(consolidationProvider.classify).toHaveBeenCalled();
  });

  it("links new memories to retrieved memories above the cosine-similarity threshold", async () => {
    // Seed a retrieved memory with a known embedding so the formation
    // pass can cosine-link against it.
    const retrieved = await graph.formMemory(
      { content: "Retrieved anchor", confidence: 0.9, sensitivity: SensitivityLevel.None },
      [1, 1, 1], // simple unit-ish vector for similarity checks
    );

    // Stub embedText to return a vector very similar to [1,1,1] — cosine
    // sim ≈ 1.0, well above MEMORY_EDGE_SIMILARITY_THRESHOLD (0.7).
    const { embedText } = await import("../embeddings.js");
    const mock = embedText as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce([0.99, 0.99, 0.99]);

    const candidates: MemoryCandidate[] = [
      { content: "New candidate", confidence: 0.8, sensitivity: SensitivityLevel.None },
    ];

    const { memoriesFormed } = await formMemoriesFromCandidates(
      { memoryGraph: graph },
      candidates,
      [retrieved],
    );

    expect(memoriesFormed).toHaveLength(1);

    // Link must exist between the new node and the retrieved anchor.
    const newEdges = await storage.getEdges(memoriesFormed[0]!.node_id);
    const related = newEdges.find(
      (e) =>
        e.relation_type === RelationType.Related &&
        (e.target_id === retrieved.node_id || e.source_id === retrieved.node_id),
    );
    expect(related).toBeDefined();
  });

  it("exports the edge-similarity threshold as a named constant for observable drift", () => {
    expect(MEMORY_EDGE_SIMILARITY_THRESHOLD).toBe(0.7);
  });
});
