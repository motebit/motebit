/**
 * Deterministic tokenizer shared by the corpus builder and the query path.
 *
 * Both sides MUST use the same function — mismatched tokenization would
 * silently drop matches. Implementation is intentionally minimal:
 *   1. Lowercase.
 *   2. Split on non-word characters (`[^a-z0-9]+`).
 *   3. Drop empty segments.
 *   4. Drop a small stopword set covering the most frequent English function
 *      words. Keep motebit-specific terms ("motebit", "droplet", "sovereign",
 *      "protocol") — they are the whole point of the index.
 *
 * No stemming. Short-document BM25 on a small corpus benefits more from
 * keeping exact forms than from merging singular/plural. If recall evidence
 * ever shows stemming helps, swap in a Snowball variant in one place here
 * and regenerate the corpus.
 */

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "can",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "he",
  "her",
  "him",
  "his",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "just",
  "like",
  "me",
  "my",
  "no",
  "not",
  "now",
  "of",
  "on",
  "or",
  "our",
  "out",
  "over",
  "she",
  "so",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "to",
  "too",
  "up",
  "us",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with",
  "you",
  "your",
]);

/**
 * Tokenize free text into a deterministic bag of tokens.
 * Callers MUST use this on both the indexing side and the query side.
 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  for (const raw of lower.split(/[^a-z0-9]+/)) {
    if (!raw) continue;
    if (STOPWORDS.has(raw)) continue;
    tokens.push(raw);
  }
  return tokens;
}
