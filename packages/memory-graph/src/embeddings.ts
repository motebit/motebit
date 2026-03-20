/**
 * Text embeddings — semantic (async, model-backed) and hash-based (sync, deterministic fallback).
 */

// === Semantic embeddings via @xenova/transformers ===

export const EMBEDDING_DIMENSIONS = 384;

type Pipeline = (
  text: string,
  options: { pooling: string; normalize: boolean },
) => Promise<{ data: Float32Array }>;

let pipelineInstance: Pipeline | null = null;
let pipelineFailed = false;

async function getPipeline(): Promise<Pipeline> {
  if (pipelineInstance !== null) return pipelineInstance;
  if (pipelineFailed) throw new Error("Pipeline previously failed to load");
  try {
    const { pipeline } = await import("@xenova/transformers");
    pipelineInstance = (await pipeline(
      "feature-extraction",
      "Xenova/all-MiniLM-L6-v2",
    )) as unknown as Pipeline;
    return pipelineInstance;
  } catch (e) {
    pipelineFailed = true;
    throw e;
  }
}

/**
 * Reset the lazy singleton pipeline. Call in test teardown.
 */
export function resetPipeline(): void {
  pipelineInstance = null;
  pipelineFailed = false;
}

/**
 * Produce a 384-dimension L2-normalized embedding using all-MiniLM-L6-v2.
 * Lazy-loads the ONNX model on first call.
 * Falls back to hash-based embedding if the model can't be loaded
 * (e.g., in a Tauri WebView where HF CDN may be unreachable).
 */
export async function embedText(text: string): Promise<number[]> {
  if (text === "") {
    return new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  }

  try {
    const extractor = await getPipeline();
    const output = await extractor(text, { pooling: "mean", normalize: true });
    return Array.from(output.data);
  } catch {
    // Hash-based fallback padded to EMBEDDING_DIMENSIONS for consistent vector sizes.
    // The hash embedding is already L2-normalized; zero-padding preserves the norm.
    const hash = embedTextHash(text);
    const padded = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    for (let i = 0; i < hash.length; i++) {
      padded[i] = hash[i]!;
    }
    return padded;
  }
}

// === Hash-based fallback (deterministic, no external deps) ===

const HASH_DIMENSIONS = 128;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

function hashToken(token: string): number {
  let h = 0;
  for (let i = 0; i < token.length; i++) {
    h = (h * 31 + token.charCodeAt(i)) | 0;
  }
  return ((h % HASH_DIMENSIONS) + HASH_DIMENSIONS) % HASH_DIMENSIONS;
}

/**
 * Extract character n-grams (trigrams) from a token.
 * E.g., "running" → ["run", "unn", "nni", "nin", "ing"]
 */
function charTrigrams(token: string): string[] {
  const grams: string[] = [];
  if (token.length < 3) {
    // For short tokens, use the token itself as its own gram
    grams.push(token);
  } else {
    for (let i = 0; i <= token.length - 3; i++) {
      grams.push(token.slice(i, i + 3));
    }
  }
  return grams;
}

/**
 * Produce a 128-dimension L2-normalized embedding from text using
 * character trigrams and word unigrams. Deterministic — same text
 * always yields the same vector. The trigram component captures
 * partial word similarity (e.g., "running" and "runner" share
 * trigrams "run", "unn"), providing better semantic signal than
 * pure bag-of-words bucketing.
 */
export function embedTextHash(text: string): number[] {
  const vec = new Array<number>(HASH_DIMENSIONS).fill(0);
  const tokens = tokenize(text);

  // Word unigrams — same as before
  for (const token of tokens) {
    const bucket = hashToken(token);
    vec[bucket] = (vec[bucket] ?? 0) + 1;
  }

  // Character trigrams — adds sub-word signal
  for (const token of tokens) {
    const grams = charTrigrams(token);
    for (const gram of grams) {
      // Use a different hash seed (prefix with "#") to spread trigrams
      // across different buckets than the word unigrams
      const bucket = hashToken("#" + gram);
      vec[bucket] = (vec[bucket] ?? 0) + 0.5; // half-weight relative to full words
    }
  }

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < HASH_DIMENSIONS; i++) {
    norm += vec[i]! * vec[i]!;
  }
  norm = Math.sqrt(norm);

  if (norm > 0) {
    for (let i = 0; i < HASH_DIMENSIONS; i++) {
      vec[i] = vec[i]! / norm;
    }
  }

  return vec;
}
