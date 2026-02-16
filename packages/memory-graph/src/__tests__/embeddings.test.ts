import { describe, it, expect } from "vitest";
import { embedText } from "../embeddings";
import { cosineSimilarity } from "../index";

describe("embedText", () => {
  it("returns a vector of 128 dimensions", () => {
    const vec = embedText("hello world");
    expect(vec).toHaveLength(128);
  });

  it("returns an L2-normalized vector", () => {
    const vec = embedText("the quick brown fox jumps over the lazy dog");
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 5);
  });

  it("is deterministic (same input → same output)", () => {
    const a = embedText("test input");
    const b = embedText("test input");
    expect(a).toEqual(b);
  });

  it("produces similar vectors for similar text", () => {
    const a = embedText("I like jazz music");
    const b = embedText("I enjoy jazz music");
    const c = embedText("quantum physics equations");
    const simAB = cosineSimilarity(a, b);
    const simAC = cosineSimilarity(a, c);
    expect(simAB).toBeGreaterThan(simAC);
  });

  it("returns a zero vector for empty string (all zeros, norm 0)", () => {
    const vec = embedText("");
    expect(vec).toHaveLength(128);
    expect(vec.every((v) => v === 0)).toBe(true);
  });
});
