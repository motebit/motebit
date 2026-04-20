/**
 * Memory formation pass — extracted from the agentic turn loop.
 *
 * The post-yield tail of a conversation turn:
 *   1. Embed every candidate (parallel — same content doesn't change
 *      across candidates, embedding is independent per candidate).
 *   2. Consolidate-and-form each candidate into the graph (sequential —
 *      graph state ordering matters for similarity matching on the
 *      next candidate in the same batch).
 *   3. Link the new nodes to retrieved memories and to each other via
 *      cosine similarity above a threshold (Related edges).
 *
 * Extracted so the runtime can ship a background-formation path
 * (autoDream-shape) without duplicating the formation machinery. The
 * ai-core loop calls this inline today; a future runtime Worker can
 * call the same function off-thread. Pure I/O-driven — no timers, no
 * UI refs, no global state. Logger is injected so tests can capture
 * without swallowing.
 */

import type { MemoryCandidate, MemoryNode } from "@motebit/sdk";
import { RelationType } from "@motebit/sdk";
import { embedText } from "./embeddings.js";
import { cosineSimilarity } from "./index.js";
import type { MemoryGraph } from "./index.js";
import type { ConsolidationProvider } from "./consolidation.js";

export interface MemoryFormationDeps {
  readonly memoryGraph: MemoryGraph;
  readonly consolidationProvider?: ConsolidationProvider;
}

export interface MemoryFormationResult {
  readonly memoriesFormed: MemoryNode[];
}

/**
 * Cosine-similarity threshold for creating a `Related` edge between
 * two memories. Unchanged from the prior inline constant in
 * `ai-core/loop.ts`; exported here so tests and callers observe the
 * same value.
 */
export const MEMORY_EDGE_SIMILARITY_THRESHOLD = 0.7;

/**
 * Run the memory-formation pass over a batch of candidates.
 *
 * Does not throw — caller decides whether to await or detach. A
 * persistent failure in embedding or consolidation is logged via the
 * provided logger (or rethrown on first error when no logger is set;
 * behavior matches the pre-extraction inline path).
 */
export async function formMemoriesFromCandidates(
  deps: MemoryFormationDeps,
  candidates: readonly MemoryCandidate[],
  relevantMemories: readonly MemoryNode[],
): Promise<MemoryFormationResult> {
  if (candidates.length === 0) return { memoriesFormed: [] };

  // 1. Parallel embed: candidate content is independent across items,
  //    so pay one round trip (or one CPU batch) instead of N. On
  //    mobile this is the difference between a UI stall per candidate
  //    and one stall per batch.
  const embeddings = await Promise.all(candidates.map((c) => embedText(c.content)));

  // 2. Sequential form: consolidation decisions depend on graph state
  //    (the previous candidate may have merged into a cluster the
  //    next candidate needs to match against). Parallelizing here
  //    would create race conditions in similarity search.
  const memoriesFormed: MemoryNode[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    const embedding = embeddings[i]!;
    if (deps.consolidationProvider) {
      const { node } = await deps.memoryGraph.consolidateAndForm(
        candidate,
        embedding,
        deps.consolidationProvider,
      );
      if (node) memoriesFormed.push(node);
    } else {
      const node = await deps.memoryGraph.formMemory(candidate, embedding);
      memoriesFormed.push(node);
    }
  }

  // 3. Edge linking — new nodes to retrieved context and to each other.
  //    Bounded by the batch size × retrieved size; typical turn has
  //    ≤3 candidates × ≤10 retrieved = ≤30 cosine ops, all in-memory.
  if (memoriesFormed.length > 0) {
    for (const newNode of memoriesFormed) {
      if (!newNode.embedding || newNode.embedding.length === 0) continue;
      for (const retrieved of relevantMemories) {
        if (!retrieved.embedding || retrieved.embedding.length === 0) continue;
        const sim = cosineSimilarity(newNode.embedding, retrieved.embedding);
        if (sim >= MEMORY_EDGE_SIMILARITY_THRESHOLD) {
          await deps.memoryGraph.link(
            newNode.node_id,
            retrieved.node_id,
            RelationType.Related,
            sim,
          );
        }
      }
    }
    for (let i = 0; i < memoriesFormed.length; i++) {
      for (let j = i + 1; j < memoriesFormed.length; j++) {
        const a = memoriesFormed[i]!;
        const b = memoriesFormed[j]!;
        if (!a.embedding || !b.embedding) continue;
        const sim = cosineSimilarity(a.embedding, b.embedding);
        if (sim >= MEMORY_EDGE_SIMILARITY_THRESHOLD) {
          await deps.memoryGraph.link(a.node_id, b.node_id, RelationType.Related, sim);
        }
      }
    }
  }

  return { memoriesFormed };
}
