import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import {
  embedText,
  embedTextHash,
  EMBEDDING_DIMENSIONS,
  resetPipeline,
  setRemoteEmbedUrl,
} from "../embeddings";
import { cosineSimilarity } from "../index";

describe("embedText (semantic)", () => {
  afterAll(() => resetPipeline());

  it("returns a vector of EMBEDDING_DIMENSIONS (384)", async () => {
    const vec = await embedText("hello world");
    expect(vec).toHaveLength(EMBEDDING_DIMENSIONS);
  });

  it("returns an L2-normalized vector", async () => {
    const vec = await embedText("the quick brown fox jumps over the lazy dog");
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 4);
  });

  it("is deterministic (same input → same output)", async () => {
    const a = await embedText("test input");
    const b = await embedText("test input");
    expect(a).toEqual(b);
  });

  it("semantically similar text has higher cosine similarity", async () => {
    const a = await embedText("I like jazz");
    const b = await embedText("I enjoy jazz");
    const c = await embedText("quantum physics");
    const simAB = cosineSimilarity(a, b);
    const simAC = cosineSimilarity(a, c);
    expect(simAB).toBeGreaterThan(simAC);
  });

  it("returns a zero vector for empty string", async () => {
    const vec = await embedText("");
    expect(vec).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(vec.every((v) => v === 0)).toBe(true);
  });

  it("empty string zero vector has correct dimensionality and all zeros", async () => {
    const vec = await embedText("");
    expect(vec).toHaveLength(384);
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBe(0);
  });
}, 120_000);

describe("embedText (hash fallback when pipeline fails)", () => {
  afterEach(() => {
    resetPipeline();
    vi.restoreAllMocks();
  });

  it("falls back to hash-based embedding padded to 384 dims", async () => {
    // Force pipeline to fail by mocking the dynamic import
    vi.mock("@xenova/transformers", () => {
      throw new Error("Simulated download failure");
    });
    resetPipeline(); // clear cached pipeline so it retries

    const vec = await embedText("hello world");
    expect(vec).toHaveLength(EMBEDDING_DIMENSIONS);
  });

  it("fallback produces an L2-normalized vector", async () => {
    vi.mock("@xenova/transformers", () => {
      throw new Error("Simulated download failure");
    });
    resetPipeline();

    const vec = await embedText("the quick brown fox");
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 5);
  });

  it("fallback is deterministic", async () => {
    vi.mock("@xenova/transformers", () => {
      throw new Error("Simulated download failure");
    });
    resetPipeline();

    const a = await embedText("test input");
    const b = await embedText("test input");
    expect(a).toEqual(b);
  });

  it("fallback pads hash embedding (128d) to EMBEDDING_DIMENSIONS (384d) with zeros", async () => {
    vi.mock("@xenova/transformers", () => {
      throw new Error("Simulated download failure");
    });
    resetPipeline();

    const vec = await embedText("some text");
    expect(vec).toHaveLength(EMBEDDING_DIMENSIONS);

    // The first 128 dimensions should have some non-zero values (from hash)
    const hashPart = vec.slice(0, 128);
    const hasNonZero = hashPart.some((v) => v !== 0);
    expect(hasNonZero).toBe(true);

    // Dimensions 128-383 should all be zero (padding)
    const padPart = vec.slice(128);
    expect(padPart.every((v) => v === 0)).toBe(true);
  });
});

describe("setRemoteEmbedUrl (remote backend)", () => {
  afterEach(() => {
    setRemoteEmbedUrl(null);
    resetPipeline();
    vi.restoreAllMocks();
  });

  it("uses remote backend when configured", async () => {
    const mockEmbedding = new Array<number>(384).fill(0.1);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, embeddings: [mockEmbedding] }), {
        headers: { "Content-Type": "application/json" },
      }),
    );

    setRemoteEmbedUrl("https://example.com/v1/embed");
    const vec = await embedText("hello");

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(vec).toEqual(mockEmbedding);
  });

  it("falls back to local model when remote fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network error"));

    setRemoteEmbedUrl("https://example.com/v1/embed");
    const vec = await embedText("hello");

    // Should still return a valid embedding from local model/hash fallback
    expect(vec).toHaveLength(EMBEDDING_DIMENSIONS);
  });

  it("skips remote when url is null", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    setRemoteEmbedUrl(null);
    const vec = await embedText("hello");

    // fetch should be called 0 times for embed (may be called by pipeline)
    const embedCalls = fetchSpy.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("/v1/embed"),
    );
    expect(embedCalls).toHaveLength(0);
    expect(vec).toHaveLength(EMBEDDING_DIMENSIONS);
  });

  it("still returns zero vector for empty string with remote configured", async () => {
    setRemoteEmbedUrl("https://example.com/v1/embed");
    const vec = await embedText("");

    expect(vec).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(vec.every((v) => v === 0)).toBe(true);
  });
});

describe("embedTextHash (fallback)", () => {
  it("returns a vector of 128 dimensions", () => {
    const vec = embedTextHash("hello world");
    expect(vec).toHaveLength(128);
  });

  it("returns an L2-normalized vector", () => {
    const vec = embedTextHash("the quick brown fox jumps over the lazy dog");
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 5);
  });

  it("is deterministic (same input → same output)", () => {
    const a = embedTextHash("test input");
    const b = embedTextHash("test input");
    expect(a).toEqual(b);
  });

  it("morphologically related words have higher similarity than unrelated words", () => {
    // "running" and "runner" share trigrams: "run", "unn"
    const running = embedTextHash("running");
    const runner = embedTextHash("runner");
    const quantum = embedTextHash("quantum");

    const simRelated = cosineSimilarity(running, runner);
    const simUnrelated = cosineSimilarity(running, quantum);

    // Trigram-enhanced hash should produce higher similarity for morphologically related words
    expect(simRelated).toBeGreaterThan(simUnrelated);
  });

  it("partial word overlap increases similarity via trigrams", () => {
    // "unhappy" and "happiness" share trigrams from "happ" / "happi"
    const a = embedTextHash("unhappy");
    const b = embedTextHash("happiness");
    const c = embedTextHash("volcano");

    const simOverlap = cosineSimilarity(a, b);
    const simNoOverlap = cosineSimilarity(a, c);

    expect(simOverlap).toBeGreaterThan(simNoOverlap);
  });

  it("identical text produces similarity of 1", () => {
    const a = embedTextHash("test phrase");
    const b = embedTextHash("test phrase");
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 10);
  });
});
