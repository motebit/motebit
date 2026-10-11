import { describe, it, expect, afterEach, vi } from "vitest";
import { embedText, EMBEDDING_DIMENSIONS, embedTextHash, resetPipeline } from "../embeddings";

// The pre-push hang (ai-core:test stuck for up to ~80 min on "Failed to load
// model because protobuf parsing failed") had three cooperating causes in the
// local-model path of `embedText`. The cells below pin (2) and (3) against a
// mocked @xenova/transformers, so no real model is ever loaded here. (1) is
// pinned by the opt-in model-cache-corrupt.real.test.ts: vitest's mocker can
// hand CONCURRENT first dynamic imports of a mocked specifier the REAL module
// (observed: three of four concurrent embeds loaded the real model under a
// vi.mock factory), so a concurrency cell cannot be written against vi.mock:
//
//  1. Concurrent first calls each started their OWN model load (no
//     single-flight). Two loads in one process after a torn/corrupt cached
//     .onnx is exactly the case where onnxruntime's threaded-wasm fallback
//     busy-waits and blocks the event loop (measured: 1 loader rejects in
//     ~0.6s, 2 loaders never settle and no timer fires).
//  2. Nothing bounded the load: a load that never settles meant `embedText`
//     never reached its hash fallback.
//  3. The threaded wasm fallback was left on (numThreads > 1).
//
// `vi.hoisted` state lets the hoisted factory and the cells share the fake.
const fake = vi.hoisted(() => ({
  loads: 0,
  numThreadsAtLoad: [] as Array<number | undefined>,
  mode: "ok" as "ok" | "never",
  env: { backends: { onnx: { wasm: { numThreads: undefined as number | undefined } } } },
}));

vi.mock("@xenova/transformers", () => ({
  env: fake.env,
  pipeline: async () => {
    fake.loads++;
    fake.numThreadsAtLoad.push(fake.env.backends.onnx.wasm.numThreads);
    if (fake.mode === "never") return new Promise<never>(() => {});
    const data = new Float32Array(384).fill(0.05);
    return async () => ({ data });
  },
}));

/** Reject if `p` has not settled within `ms` — the cell's own deadline. */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`unsettled after ${ms}ms`)), ms),
    ),
  ]);
}

afterEach(() => {
  resetPipeline();
  fake.loads = 0;
  fake.numThreadsAtLoad = [];
  fake.mode = "ok";
  fake.env.backends.onnx.wasm.numThreads = undefined;
});

describe("embedText — local model load resilience", () => {
  it.fails(
    "RED: a model load that never settles is bounded — embedText falls back to the hash embedding",
    async () => {
      fake.mode = "never";
      const vec = await within(embedText("door code"), 3_000);
      expect(vec).toHaveLength(EMBEDDING_DIMENSIONS);
      expect(vec.slice(0, 128)).toEqual(embedTextHash("door code"));
    },
  );

  it.fails(
    "RED: the threaded-wasm fallback is pinned off (numThreads = 1) before the model loads",
    async () => {
      await embedText("x");
      expect(fake.numThreadsAtLoad).toEqual([1]);
    },
  );
});
