/**
 * Text embeddings — semantic (async, model-backed) and hash-based (sync, deterministic fallback).
 */

import { CONTEXT_SAFE_SENSITIVITY } from "@motebit/sdk";
import type { SensitivityLevel } from "@motebit/sdk";
import {
  evictCachedModel,
  installAtomicModelCache,
  nodeFs,
  type TransformersCacheEnv,
} from "./model-cache.js";

// === Semantic embeddings via @xenova/transformers (or remote proxy) ===

export const EMBEDDING_DIMENSIONS = 384;

// Remote embedding backend — when configured, embedText() calls this URL instead
// of loading the local ONNX model. Used by the web app to route through the proxy.
let remoteEmbedUrl: string | null = null;

/**
 * Configure a remote embedding backend. When set, embedText() POSTs CONTEXT-SAFE
 * text (see `embedText`) to this URL instead of loading @xenova/transformers
 * locally. Pass null to disable.
 */
export function setRemoteEmbedUrl(url: string | null): void {
  remoteEmbedUrl = url;
}

async function remoteEmbed(text: string): Promise<number[]> {
  const res = await fetch(remoteEmbedUrl!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ texts: [text] }),
    signal: AbortSignal.timeout(10000),
  });
  const data = (await res.json()) as { ok: boolean; embeddings?: number[][]; error?: string };
  if (!data.ok || !data.embeddings?.[0]) {
    throw new Error(data.error ?? "Remote embedding failed");
  }
  return data.embeddings[0];
}

type Pipeline = (
  text: string,
  options: { pooling: string; normalize: boolean },
) => Promise<{ data: Float32Array }>;

/** The model every local embedding uses. */
export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";

/**
 * Loads the local embedding pipeline. The default loads {@link EMBEDDING_MODEL}
 * through @xenova/transformers; tests and hosts inject their own with
 * {@link setEmbeddingModelLoader} (adapter pattern — no unit test may load the
 * real model).
 */
export type EmbeddingModelLoader = () => Promise<Pipeline>;

/**
 * Upper bound on a caller's wait for the model load (download included). A
 * caller still waiting after this falls back to the hash embedding instead of
 * stalling; the load itself keeps going, and once it settles later callers
 * use the model.
 */
export const MODEL_LOAD_TIMEOUT_MS = 120_000;

/**
 * Is `err` what a torn or truncated cached model file produces? onnxruntime
 * reports a truncated `.onnx` as a protobuf parse failure; a truncated JSON
 * file (config, tokenizer) fails `JSON.parse`. Anything else — the hub
 * unreachable, a 404, a runtime fault — says nothing about the cached bytes.
 */
function isCorruptModelError(err: unknown): boolean {
  if (err instanceof SyntaxError || (err as { name?: unknown } | null)?.name === "SyntaxError") {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /protobuf parsing failed|unexpected end of json|is not valid json/i.test(msg);
}

/** The transformers `env` fields the default loader sets. */
type TransformersEnv = TransformersCacheEnv & {
  backends?: { onnx?: { wasm?: { numThreads?: number } } };
};

async function loadTransformersModel(): Promise<Pipeline> {
  const mod = (await import("@xenova/transformers")) as unknown as {
    pipeline: (task: string, model: string) => Promise<unknown>;
    env?: TransformersEnv;
  };
  const pipeline = mod.pipeline;
  // `in`, not a plain read: a vi.mock factory without `env` throws on access.
  const env = "env" in mod ? mod.env : undefined;
  // Single-threaded wasm only. When onnxruntime-node cannot load the model
  // (e.g. a truncated cached .onnx), transformers falls back to wasm, and the
  // THREADED wasm build busy-waits the event loop forever once two loads
  // overlap in one process — no timer fires, so nothing can time it out.
  const wasm = env?.backends?.onnx?.wasm;
  if (wasm) wasm.numThreads = 1;
  const cacheDir = env ? installAtomicModelCache(env, nodeFs()) : undefined;
  try {
    return (await pipeline("feature-extraction", EMBEDDING_MODEL)) as Pipeline;
  } catch (err) {
    // A cached file that cannot be parsed is corrupt (a torn write by an
    // older, non-atomic writer): drop it so the next load fetches it fresh.
    // Only then — an offline or server failure leaves a good cache alone.
    const fs = nodeFs();
    if (fs !== undefined && cacheDir !== undefined && isCorruptModelError(err)) {
      evictCachedModel(fs, cacheDir, EMBEDDING_MODEL);
    }
    throw new Error(
      `embedding model ${EMBEDDING_MODEL} failed to load: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

let modelLoader: EmbeddingModelLoader = loadTransformersModel;
let modelLoadTimeoutMs = MODEL_LOAD_TIMEOUT_MS;
let pipelinePromise: Promise<Pipeline> | null = null;
let pipelineFailed = false;
/** The current load outlived a caller's wait and has not settled yet. */
let pipelinePending = false;

class ModelLoadTimeout extends Error {}

/**
 * Inject the loader for the local embedding pipeline (`null` restores the
 * default @xenova/transformers loader) and, optionally, its load timeout.
 * Resets the loaded pipeline.
 */
export function setEmbeddingModelLoader(
  loader: EmbeddingModelLoader | null,
  opts: { timeoutMs?: number } = {},
): void {
  modelLoader = loader ?? loadTransformersModel;
  modelLoadTimeoutMs = opts.timeoutMs ?? MODEL_LOAD_TIMEOUT_MS;
  resetPipeline();
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ModelLoadTimeout(`embedding model load timed out after ${ms}ms`)),
      ms,
    );
    // Never keep a process alive just to time out a load.
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The loaded pipeline. Single-flight: concurrent first callers share ONE
 * load. Each caller's wait is bounded by the load timeout; a load that
 * outlives it keeps going — callers fall back (hash) at once until it
 * settles, then use the model. A failed load sticks (hash fallback) until
 * {@link resetPipeline}.
 */
function getPipeline(): Promise<Pipeline> {
  if (pipelineFailed) return Promise.reject(new Error("Pipeline previously failed to load"));
  if (pipelinePromise === null) {
    const attempt = modelLoader();
    pipelinePromise = attempt;
    // Only the current attempt may change state (a reset may have replaced it).
    attempt.then(
      () => {
        if (pipelinePromise === attempt) pipelinePending = false;
      },
      () => {
        if (pipelinePromise === attempt) pipelineFailed = true;
      },
    );
  }
  if (pipelinePending) return Promise.reject(new Error("Pipeline load still pending"));
  const attempt = pipelinePromise;
  return withTimeout(attempt, modelLoadTimeoutMs).catch((err: unknown) => {
    if (err instanceof ModelLoadTimeout && pipelinePromise === attempt) pipelinePending = true;
    throw err;
  });
}

/**
 * Reset the lazy singleton pipeline. Call in test teardown.
 */
export function resetPipeline(): void {
  pipelinePromise = null;
  pipelineFailed = false;
  pipelinePending = false;
}

/**
 * May text tagged `sensitivity` be sent to the remote embedding backend? The
 * backend is an EXTERNAL service (the proxy's /v1/embed), so it is held to the
 * ceiling for any external request: context-safe tiers only (none / personal).
 * An untagged input fails closed — it stays on the device.
 */
export function remoteEmbedPermits(sensitivity: SensitivityLevel | undefined): boolean {
  return sensitivity != null && CONTEXT_SAFE_SENSITIVITY.includes(sensitivity);
}

/**
 * Produce a 384-dimension L2-normalized embedding using all-MiniLM-L6-v2.
 * Lazy-loads the ONNX model on first call.
 * Falls back to hash-based embedding if the model can't be loaded
 * (e.g., in a Tauri WebView where HF CDN may be unreachable).
 *
 * `sensitivity` is the tier of `text`. With a remote backend configured, the
 * text is POSTed off the device only when `remoteEmbedPermits(sensitivity)`;
 * medical / financial / secret text — and text whose tier the caller does not
 * state — is embedded locally (the model, else the hash fallback).
 */
export async function embedText(text: string, sensitivity?: SensitivityLevel): Promise<number[]> {
  if (text === "") {
    return new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  }

  // Remote backend (browser via proxy) — egress, so context-safe text only.
  if (remoteEmbedUrl && remoteEmbedPermits(sensitivity)) {
    try {
      return await remoteEmbed(text);
    } catch {
      // Fall through to local model / hash fallback
    }
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
