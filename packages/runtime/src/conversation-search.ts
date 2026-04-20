/**
 * Conversation search — Layer-3 of the three-layer memory architecture.
 *
 * Layer 1 is the always-loaded memory index (pointer-only, in every
 * system prompt). Layer 2 is `recall_memories` — embedding-based
 * retrieval over formed memory nodes. This module is Layer 3: lexical
 * BM25 search over the motebit's raw conversation history, without
 * round-tripping through memory formation.
 *
 * Why distinct from memory. A memory is a distilled fact the motebit
 * chose to keep; a conversation is the verbatim exchange that produced
 * (or did not produce) memories. The agent often needs to cite the
 * exchange itself — "you asked me last Tuesday about the auth
 * refactor" — and that substring may never have entered the memory
 * graph. Embedding search over memory misses it. Lexical search over
 * transcripts finds it.
 *
 * Design choices:
 *   - BM25 is inlined here (not imported from `@motebit/self-knowledge`)
 *     because the self-knowledge package is explicitly a static-corpus
 *     tool. Conversation search is dynamic — the index builds per
 *     query over whatever messages the caller passes. Same math,
 *     different lifecycle.
 *   - Tokenization is shared with self-knowledge via the exported
 *     `tokenize` function. Keeping one tokenizer across both tiers
 *     means a user typing a query term gets consistent hits whether
 *     it matches docs or transcripts.
 *   - Snippet generation focuses on the first matching token + a
 *     symmetric ~80-char window so the agent sees why the message
 *     ranked without re-reading the whole turn.
 *   - Pure function: no I/O, no mutation. The caller — ConversationManager
 *     — handles message loading and storage adapter differences.
 */

import { tokenize } from "@motebit/self-knowledge";

/** A single message record as the caller provides it. */
export interface ConversationMessageRecord {
  readonly conversationId: string;
  readonly role: string;
  readonly content: string;
  readonly createdAt: number;
}

/** One ranked hit. Callers MAY augment (e.g. add conversation title) before rendering. */
export interface ConversationSearchHit {
  readonly conversationId: string;
  readonly role: string;
  readonly content: string;
  readonly timestamp: number;
  readonly score: number;
  /** Up to ~160 chars around the first matching query token. */
  readonly snippet: string;
}

// Standard BM25 tuning — same values as @motebit/self-knowledge.
const BM25_K1 = 1.5;
const BM25_B = 0.75;

interface IndexedMessage {
  readonly record: ConversationMessageRecord;
  readonly tokens: ReadonlyArray<string>;
  readonly termFrequencies: Record<string, number>;
  readonly length: number;
}

function buildIndex(messages: readonly ConversationMessageRecord[]): {
  indexed: ReadonlyArray<IndexedMessage>;
  documentFrequencies: Record<string, number>;
  averageLength: number;
  totalDocuments: number;
} {
  const indexed: IndexedMessage[] = [];
  const documentFrequencies: Record<string, number> = {};
  let totalLength = 0;

  for (const record of messages) {
    const tokens = tokenize(record.content);
    if (tokens.length === 0) continue;

    const termFrequencies: Record<string, number> = {};
    const seenInDoc = new Set<string>();
    for (const token of tokens) {
      termFrequencies[token] = (termFrequencies[token] ?? 0) + 1;
      if (!seenInDoc.has(token)) {
        seenInDoc.add(token);
        documentFrequencies[token] = (documentFrequencies[token] ?? 0) + 1;
      }
    }

    indexed.push({ record, tokens, termFrequencies, length: tokens.length });
    totalLength += tokens.length;
  }

  return {
    indexed,
    documentFrequencies,
    averageLength: indexed.length > 0 ? totalLength / indexed.length : 1,
    totalDocuments: indexed.length,
  };
}

function scoreDocument(
  doc: IndexedMessage,
  queryTokens: readonly string[],
  documentFrequencies: Record<string, number>,
  averageLength: number,
  totalDocuments: number,
): number {
  let score = 0;
  for (const token of queryTokens) {
    const tf = doc.termFrequencies[token] ?? 0;
    if (tf === 0) continue;
    const df = documentFrequencies[token] ?? 0;
    const idf = Math.log(1 + (totalDocuments - df + 0.5) / (df + 0.5));
    const numerator = tf * (BM25_K1 + 1);
    const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / averageLength));
    score += idf * (numerator / denominator);
  }
  return score;
}

/**
 * Build a snippet around the first occurrence of any query token in
 * the message content. Falls back to the first 160 chars when no
 * token overlap can be found (shouldn't happen for matched documents
 * — this is defense in depth, not the happy path).
 */
function buildSnippet(content: string, queryTokens: readonly string[]): string {
  const lowered = content.toLowerCase();
  let anchor = -1;
  for (const token of queryTokens) {
    const idx = lowered.indexOf(token);
    if (idx !== -1 && (anchor === -1 || idx < anchor)) anchor = idx;
  }
  if (anchor === -1) {
    return content.slice(0, 160).trim();
  }
  const start = Math.max(0, anchor - 60);
  const end = Math.min(content.length, anchor + 100);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < content.length ? "…" : "";
  return `${prefix}${content.slice(start, end).trim()}${suffix}`;
}

/**
 * Rank the supplied messages against `query` under BM25 and return
 * the top-k hits. Pure, synchronous, sub-millisecond at typical
 * conversation sizes. Empty result when no message shares a token
 * with the query.
 */
export function searchConversationMessages(
  messages: readonly ConversationMessageRecord[],
  query: string,
  options: { limit?: number; minScore?: number } = {},
): ConversationSearchHit[] {
  const limit = options.limit ?? 5;
  const minScore = options.minScore ?? 0;

  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const { indexed, documentFrequencies, averageLength, totalDocuments } = buildIndex(messages);
  if (totalDocuments === 0) return [];

  const hits: ConversationSearchHit[] = [];
  for (const doc of indexed) {
    const score = scoreDocument(
      doc,
      queryTokens,
      documentFrequencies,
      averageLength,
      totalDocuments,
    );
    if (score <= minScore) continue;
    hits.push({
      conversationId: doc.record.conversationId,
      role: doc.record.role,
      content: doc.record.content,
      timestamp: doc.record.createdAt,
      score,
      snippet: buildSnippet(doc.record.content, queryTokens),
    });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}
