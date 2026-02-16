/**
 * Local hashed bag-of-words embedding.
 * Deterministic, no external deps. Placeholder for a real model later.
 */

const DIMENSIONS = 128;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/**
 * Simple string hash → bucket index. Deterministic across runs.
 */
function hashToken(token: string): number {
  let h = 0;
  for (let i = 0; i < token.length; i++) {
    h = (h * 31 + token.charCodeAt(i)) | 0;
  }
  return ((h % DIMENSIONS) + DIMENSIONS) % DIMENSIONS;
}

/**
 * Produce a 128-dimension L2-normalized embedding from text using
 * hashed bag-of-words. Deterministic — same text always yields
 * the same vector.
 */
export function embedText(text: string): number[] {
  const vec = new Array<number>(DIMENSIONS).fill(0);
  const tokens = tokenize(text);

  for (const token of tokens) {
    const bucket = hashToken(token);
    vec[bucket] = (vec[bucket] ?? 0) + 1;
  }

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < DIMENSIONS; i++) {
    norm += vec[i]! * vec[i]!;
  }
  norm = Math.sqrt(norm);

  if (norm > 0) {
    for (let i = 0; i < DIMENSIONS; i++) {
      vec[i] = vec[i]! / norm;
    }
  }

  return vec;
}
