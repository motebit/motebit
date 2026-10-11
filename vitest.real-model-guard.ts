/**
 * Stand-in for `@xenova/transformers` in every unit-test run.
 *
 * `defineMotebitTest` (vitest.shared.ts) aliases `@xenova/transformers` to
 * this module unless MOTEBIT_REAL_MODEL_TESTS=1. No unit test may load or
 * download the real embedding model: on 2026-10 the pre-push run hung for up
 * to ~80 min because ai-core's unit tests loaded the real ONNX model out of
 * one cache dir shared by every package's workers, read a torn .onnx
 * ("protobuf parsing failed"), and onnxruntime's threaded-wasm fallback then
 * blocked the event loop.
 *
 * Reaching the loader is made LOUD, not merely refused: production
 * `embedText` deliberately swallows a load failure into its hash fallback,
 * so a plain throw would pass silently. The guard also raises the error
 * outside the caller's promise chain, which vitest reports as an unhandled
 * error and fails the run. The fix is to inject an embedder
 * (`setEmbeddingModelLoader`, the `embed` dep of `formMemoriesFromCandidates`,
 * MemoryGraph's `embed` parameter) or `vi.mock("@xenova/transformers")`.
 * A real-model test is opt-in: `MOTEBIT_REAL_MODEL_TESTS=1`, skipped otherwise.
 */

export const REAL_MODEL_GUARD_MESSAGE =
  "A unit test reached the REAL embedding-model loader (@xenova/transformers `pipeline`). " +
  "Unit tests must never load or download a model: inject an embedder " +
  "(setEmbeddingModelLoader / formMemoriesFromCandidates `embed` / MemoryGraph `embed`) " +
  'or vi.mock("@xenova/transformers"). Real-model tests are opt-in via MOTEBIT_REAL_MODEL_TESTS=1.';

/** Same shape as transformers' `env`, so a loader can configure it. */
export const env: Record<string, unknown> = {
  backends: { onnx: { wasm: {} } },
  useFSCache: false,
  cacheDir: null,
};

export function pipeline(): Promise<never> {
  const err = new Error(REAL_MODEL_GUARD_MESSAGE);
  // Fail the run even when the caller swallows the rejection below.
  setTimeout(() => {
    throw err;
  }, 0);
  return Promise.reject(err);
}

export default { env, pipeline };
