/**
 * Accrual production for the memory axis — the `recalled_memory` leverage
 * moment, produced HERE in the accrual source (felt-accumulation §3), never
 * authored by the model. The memory-graph retrieval is the only thing that
 * knows a memory was genuinely drawn upon for a turn; it mints the basis, and
 * `ai-core` only threads it onto the turn result. A model that could author
 * "I remembered" could fabricate a recall that never happened — so it cannot.
 *
 * Doctrine: `docs/doctrine/felt-accumulation.md`.
 */

import type { AccrualBasis } from "@motebit/protocol";
import type { MemoryNode } from "@motebit/sdk";
import { dotProduct } from "./retrieval.js";

/**
 * The cosine-similarity bar a recalled memory must clear to count as a
 * CONSEQUENTIAL leverage moment — the recall that genuinely shaped the act,
 * not every tangential match (felt-accumulation § Gotchas: "not every
 * retrieval"). Conservative by design: missing a leverage moment is
 * honest-by-absence; manufacturing one is the anti-pattern. Embeddings are
 * L2-normalized, so the dot product IS cosine similarity in [-1, 1]. Tunable
 * per call via `recalledMemoryBasis`'s `minSimilarity`; the production
 * threshold is a deliberate empirical follow-up once real-traffic recall
 * distributions are observed.
 */
export const CONSEQUENTIAL_RECALL_SIMILARITY = 0.7;

/**
 * Produce the `recalled_memory` `AccrualBasis` for a turn — the single
 * most-similar recalled memory whose similarity to the query clears the
 * consequential bar — or `undefined` when nothing was consequentially drawn
 * upon (the fail-closed default: no leverage → no attribution).
 *
 * Produced-not-authored: the basis carries the node id (`sourceRef`, an opaque
 * pointer for explicit reveal) and the memory's own `sensitivity` (the render's
 * disclosure ceiling) — both read off the retrieved node, never narrated by the
 * model. Similarity is computed exactly as the retrieval lens does
 * (`dotProduct(queryEmbedding, node.embedding)`, retrieval.ts) so a basis never
 * disagrees with what retrieval already judged relevant: it iterates the
 * query's dimensions, so a stored embedding zero-padded to a larger dimension
 * (a 128-d hash padded to the 384-d model size) scores correctly over its real
 * dimensions. Tombstoned nodes, and nodes whose embedding is SHORTER than the
 * query (unscorable without NaN), are skipped — neither can mint a basis.
 *
 * @param queryEmbedding the turn's query embedding (L2-normalized)
 * @param nodes the memories drawn into this turn's context
 */
export function recalledMemoryBasis(
  queryEmbedding: readonly number[],
  nodes: readonly MemoryNode[],
  opts: { minSimilarity?: number } = {},
): AccrualBasis | undefined {
  if (queryEmbedding.length === 0) return undefined;
  const min = opts.minSimilarity ?? CONSEQUENTIAL_RECALL_SIMILARITY;

  let best: { node: MemoryNode; sim: number } | undefined;
  for (const node of nodes) {
    if (node.tombstoned) continue;
    // Mirror the retrieval lens: dotProduct iterates the query's length, so a
    // node embedding at least as long as the query scores over the query's
    // dimensions (zero-padded tails contribute nothing). A SHORTER node would
    // read past its end → NaN, so skip it.
    if (node.embedding.length < queryEmbedding.length) continue;
    const sim = dotProduct(queryEmbedding, node.embedding);
    if (sim >= min && (best === undefined || sim > best.sim)) {
      best = { node, sim };
    }
  }
  if (best === undefined) return undefined;

  return {
    kind: "recalled_memory",
    sourceRef: best.node.node_id,
    sensitivity: best.node.sensitivity,
  };
}
