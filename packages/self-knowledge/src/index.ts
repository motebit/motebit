/**
 * @motebit/self-knowledge — interior tier of the answer engine.
 *
 * Pure BM25 ranking over a committed, pre-tokenized corpus. No runtime
 * dependencies. Every motebit surface loads the same corpus module at build
 * time; there is no network path and no model to download.
 *
 * When the public API grows, add the export here — consumers always import
 * from `@motebit/self-knowledge` (root), never from subpaths. Sibling
 * packages (`@motebit/tools`, `services/research`) are the sole consumers.
 */

import { CORPUS_INDEX } from "./corpus-data.js";
import { tokenize } from "./tokenize.js";
import type { CorpusIndex, SelfKnowledgeChunk, SelfKnowledgeHit } from "./types.js";

export type { CorpusIndex, SelfKnowledgeChunk, SelfKnowledgeHit } from "./types.js";
export { tokenize } from "./tokenize.js";

// BM25 tuning constants — the textbook defaults. Changing these is a recall
// quality decision; bake a test fixture before touching.
const BM25_K1 = 1.5;
const BM25_B = 0.75;

/** Score one chunk against a tokenized query under BM25. */
function scoreChunk(
  chunk: SelfKnowledgeChunk,
  queryTokens: readonly string[],
  index: CorpusIndex,
): number {
  if (queryTokens.length === 0 || chunk.length === 0) return 0;
  const avgLen = index.averageLength || 1;
  const n = index.totalDocuments;
  let score = 0;

  for (const token of queryTokens) {
    const tf = chunk.termFrequencies[token] ?? 0;
    if (tf === 0) continue;

    const df = index.documentFrequencies[token] ?? 0;
    // Standard BM25 IDF. The "+1" inside the log keeps the value non-negative
    // even when a token appears in every document.
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));

    const numerator = tf * (BM25_K1 + 1);
    const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (chunk.length / avgLen));
    score += idf * (numerator / denominator);
  }
  return score;
}

/**
 * Rank the corpus against a free-text query and return the top-k hits.
 *
 * Synchronous and pure — takes microseconds at corpus sizes in the tens of
 * chunks. Returns an empty array when no chunk has any query token.
 */
export function querySelfKnowledge(
  query: string,
  options: { limit?: number; minScore?: number } = {},
): SelfKnowledgeHit[] {
  const limit = options.limit ?? 5;
  const minScore = options.minScore ?? 0;
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const scored: SelfKnowledgeHit[] = [];
  for (const chunk of CORPUS_INDEX.chunks) {
    const score = scoreChunk(chunk, tokens, CORPUS_INDEX);
    if (score <= minScore) continue;
    scored.push({
      id: chunk.id,
      source: chunk.source,
      title: chunk.title,
      content: chunk.content,
      score,
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * Inspect the committed corpus. Consumers rarely need this — it's here so
 * audit tools (or a `--self-test` path) can verify the source hash and
 * generation timestamp without importing internals.
 */
export function getCorpusMetadata(): {
  sourceHash: string;
  generatedAt: string;
  totalDocuments: number;
  averageLength: number;
} {
  return {
    sourceHash: CORPUS_INDEX.sourceHash,
    generatedAt: CORPUS_INDEX.generatedAt,
    totalDocuments: CORPUS_INDEX.totalDocuments,
    averageLength: CORPUS_INDEX.averageLength,
  };
}
