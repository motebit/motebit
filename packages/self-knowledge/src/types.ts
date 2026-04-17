/**
 * Types for the interior knowledge corpus.
 *
 * The corpus is a committed array of heading-delimited chunks with
 * pre-computed token statistics for BM25 ranking. Consumers never hand-edit
 * the generated `corpus-data.ts` — regenerate via the build script.
 */

/**
 * One chunk of the corpus — a heading plus its body, drawn from one of the
 * top-level motebit docs. Splitting on headings preserves coherent thematic
 * units; body length varies.
 */
export interface SelfKnowledgeChunk {
  /** Stable chunk id — `{source}#{heading-slug}`. */
  id: string;
  /** Source file path (repo-relative), e.g., "README.md". */
  source: string;
  /** Heading text for the chunk (or the doc title for the preamble). */
  title: string;
  /** Body text as-committed, trimmed. */
  content: string;
  /** Pre-computed token counts. Keys are normalized tokens. */
  termFrequencies: Record<string, number>;
  /** Total non-stopword tokens in `content`. Used as BM25 document length. */
  length: number;
}

/**
 * Committed corpus + pre-computed corpus-wide statistics for BM25. Generated
 * at build time; read-only at runtime.
 */
export interface CorpusIndex {
  /** All chunks, in file-then-heading order. */
  chunks: readonly SelfKnowledgeChunk[];
  /** Document frequency per token — how many chunks contain the token at least once. */
  documentFrequencies: Readonly<Record<string, number>>;
  /** Mean chunk length (non-stopword tokens). BM25 normalization. */
  averageLength: number;
  /** Number of chunks. */
  totalDocuments: number;
  /** SHA-256 hash of the concatenated source content that produced this corpus. */
  sourceHash: string;
  /** ISO timestamp of generation. */
  generatedAt: string;
}

/**
 * Result returned by `querySelfKnowledge`. One hit per matching chunk,
 * scored and sorted descending.
 */
export interface SelfKnowledgeHit {
  /** Chunk id (`{source}#{heading-slug}`). */
  id: string;
  /** Source file path — use this plus `title` to cite. */
  source: string;
  /** Heading. */
  title: string;
  /** Body text. The caller may truncate for prompt context. */
  content: string;
  /** BM25 score (higher = more relevant). Cross-query comparisons are not meaningful. */
  score: number;
}
