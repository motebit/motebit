import { describe, it, expect, afterAll } from "vitest";
import { embedText, embedTextHash, EMBEDDING_DIMENSIONS, resetPipeline } from "../embeddings";
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
}, 120_000);

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
});
