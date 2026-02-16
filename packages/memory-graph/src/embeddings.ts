/**
 * Text embeddings — semantic (async, model-backed) and hash-based (sync, deterministic fallback).
 */

// === Semantic embeddings via @xenova/transformers ===

export const EMBEDDING_DIMENSIONS = 384;

type Pipeline = (text: string, options: { pooling: string; normalize: boolean }) => Promise<{ data: Float32Array }>;

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
 * Produce a 128-dimension L2-normalized embedding from text using
 * hashed bag-of-words. Deterministic — same text always yields
 * the same vector. Useful as a fast fallback in tests.
 */
export function embedTextHash(text: string): number[] {
  const vec = new Array<number>(HASH_DIMENSIONS).fill(0);
  const tokens = tokenize(text);

  for (const token of tokens) {
    const bucket = hashToken(token);
    vec[bucket] = (vec[bucket] ?? 0) + 1;
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
