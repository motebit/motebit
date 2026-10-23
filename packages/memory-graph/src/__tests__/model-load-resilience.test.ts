import { describe, it, expect, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  embedText,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  embedTextHash,
  resetPipeline,
  setEmbeddingModelLoader,
} from "../embeddings";

// The pre-push hang (ai-core:test stuck for up to ~80 min on "Failed to load
// model because protobuf parsing failed") had three cooperating causes in the
// local-model path of `embedText`; each cell below pins one, and no cell
// loads a real model (the default loader runs against a mocked
// @xenova/transformers; the rest inject a loader):
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
// The concurrency cell injects a loader instead of mocking the module:
// vitest's mocker can hand CONCURRENT first dynamic imports of a mocked
// specifier the REAL module (observed while writing the red repro: three of
// four concurrent embeds loaded the real model under a vi.mock factory).
const fake = vi.hoisted(() => ({
  loads: 0,
  numThreadsAtLoad: [] as Array<number | undefined>,
  mode: "ok" as "ok" | "never" | "corrupt" | "offline",
  env: {
    backends: { onnx: { wasm: { numThreads: undefined as number | undefined } } },
    useFSCache: false,
    useCustomCache: false,
    customCache: undefined as unknown,
    cacheDir: null as string | null,
    remoteHost: "https://huggingface.co/",
  },
}));

vi.mock("@xenova/transformers", () => ({
  env: fake.env,
  pipeline: async () => {
    fake.loads++;
    fake.numThreadsAtLoad.push(fake.env.backends.onnx.wasm.numThreads);
    if (fake.mode === "never") return new Promise<never>(() => {});
    if (fake.mode === "corrupt")
      throw new Error("Failed to load model because protobuf parsing failed.");
    // What transformers surfaces when the hub is unreachable (undici).
    if (fake.mode === "offline") throw new TypeError("fetch failed");
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

function hashPadded(text: string): number[] {
  const padded = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  embedTextHash(text).forEach((v, i) => (padded[i] = v));
  return padded;
}

const constantPipeline = async () => ({ data: new Float32Array(384).fill(0.05) });

afterEach(() => {
  setEmbeddingModelLoader(null);
  resetPipeline();
  fake.loads = 0;
  fake.numThreadsAtLoad = [];
  fake.mode = "ok";
  Object.assign(fake.env, {
    useFSCache: false,
    useCustomCache: false,
    customCache: undefined,
    cacheDir: null,
  });
  fake.env.backends.onnx.wasm.numThreads = undefined;
});

describe("embedText — local model load resilience", () => {
  it("concurrent first embeds share ONE model load (single-flight)", async () => {
    let loads = 0;
    setEmbeddingModelLoader(async () => {
      loads++;
      await new Promise((r) => setTimeout(r, 10));
      return constantPipeline;
    });
    const vecs = await Promise.all(["a", "b", "c", "d"].map((t) => embedText(t)));
    expect(loads).toBe(1);
    expect(vecs.every((v) => v[0] === Math.fround(0.05))).toBe(true);
  });

  it("a model load that never settles is bounded — embedText falls back to the hash embedding", async () => {
    setEmbeddingModelLoader(() => new Promise<never>(() => {}), { timeoutMs: 50 });
    const vec = await within(embedText("door code"), 3_000);
    expect(vec).toEqual(hashPadded("door code"));
  });

  it("a failed load sticks (no reload storm) until resetPipeline", async () => {
    let loads = 0;
    setEmbeddingModelLoader(async () => {
      loads++;
      throw new Error("boom");
    });
    await embedText("x");
    await embedText("y");
    expect(loads).toBe(1);
    resetPipeline();
    await embedText("z");
    expect(loads).toBe(2);
  });

  it("a reset while a load is in flight does not let the stale load mark failure", async () => {
    let rejectFirst!: (e: Error) => void;
    let n = 0;
    setEmbeddingModelLoader(() => {
      n++;
      return n === 1
        ? new Promise<never>((_, rej) => (rejectFirst = rej))
        : Promise.resolve(constantPipeline);
    });
    const stale = embedText("x");
    resetPipeline();
    rejectFirst(new Error("stale"));
    await stale;
    const vec = await embedText("y");
    expect(vec[0]).toBe(Math.fround(0.05));
  });

  it("the default loader pins the threaded-wasm fallback off (numThreads = 1) before loading", async () => {
    await embedText("x");
    expect(fake.numThreadsAtLoad).toEqual([1]);
  });

  it("the default loader routes transformers' file cache through the atomic cache", async () => {
    const dir = mkdtempSync(join(tmpdir(), "motebit-model-cache-"));
    try {
      Object.assign(fake.env, { useFSCache: true, cacheDir: dir });
      await embedText("x");
      expect(fake.env.useFSCache).toBe(false);
      expect(fake.env.useCustomCache).toBe(true);
      expect(typeof (fake.env.customCache as { put?: unknown }).put).toBe("function");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a corrupt cached model is evicted and the load fails fast to the hash fallback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "motebit-model-cache-"));
    try {
      const modelDir = join(dir, ...EMBEDDING_MODEL.split("/"));
      mkdirSync(join(modelDir, "onnx"), { recursive: true });
      writeFileSync(join(modelDir, "onnx", "model_quantized.onnx"), Buffer.from([0x08, 0x07]));
      Object.assign(fake.env, { useFSCache: true, cacheDir: dir });
      fake.mode = "corrupt";
      const vec = await within(embedText("door code"), 3_000);
      expect(vec).toEqual(hashPadded("door code"));
      expect(existsSync(modelDir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a load that fails for a reason other than corruption (offline) leaves the cached model in place", async () => {
    const dir = mkdtempSync(join(tmpdir(), "motebit-model-cache-"));
    try {
      const modelDir = join(dir, ...EMBEDDING_MODEL.split("/"));
      const onnx = join(modelDir, "onnx", "model_quantized.onnx");
      mkdirSync(join(modelDir, "onnx"), { recursive: true });
      writeFileSync(onnx, Buffer.from([0x08, 0x07]));
      Object.assign(fake.env, { useFSCache: true, cacheDir: dir });
      fake.mode = "offline";
      const vec = await within(embedText("door code"), 3_000);
      expect(vec).toEqual(hashPadded("door code"));
      // Nothing about "fetch failed" says the cached bytes are bad: evicting
      // here would turn one offline moment into a full re-download.
      expect(existsSync(onnx)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a load that outlives the timeout is not abandoned: the caller falls back once, later embeds use the model", async () => {
    let loads = 0;
    setEmbeddingModelLoader(
      async () => {
        loads++;
        await new Promise((r) => setTimeout(r, 80));
        return constantPipeline;
      },
      { timeoutMs: 20 },
    );
    const first = await within(embedText("x"), 3_000);
    expect(first).toEqual(hashPadded("x"));
    await new Promise((r) => setTimeout(r, 150));
    // A slow first download must not pin a long-lived process to hash
    // vectors (not comparable with model vectors in the same memory space).
    const later = await within(embedText("y"), 3_000);
    expect(later[0]).toBe(Math.fround(0.05));
    expect(loads).toBe(1);
  });

  it("while a timed-out load is still pending, later embeds fall back at once instead of waiting out the timeout again", async () => {
    setEmbeddingModelLoader(() => new Promise<never>(() => {}), { timeoutMs: 300 });
    await within(embedText("x"), 3_000);
    const t0 = Date.now();
    const vec = await within(embedText("y"), 3_000);
    expect(vec).toEqual(hashPadded("y"));
    expect(Date.now() - t0).toBeLessThan(150);
  });
});
