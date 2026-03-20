import { describe, it, expect, beforeEach } from "vitest";
import {
  cacheKey,
  cacheGet,
  cacheSet,
  cache,
  validateEmbedRequest,
  CACHE_MAX_ENTRIES,
  MAX_TEXTS,
  MAX_TEXT_LENGTH,
} from "../cache.js";

describe("cacheKey", () => {
  it("returns a SHA-256 hex digest", () => {
    const key = cacheKey("hello");
    expect(key).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is deterministic", () => {
    expect(cacheKey("test")).toBe(cacheKey("test"));
  });

  it("different inputs produce different keys", () => {
    expect(cacheKey("a")).not.toBe(cacheKey("b"));
  });
});

describe("cacheGet / cacheSet", () => {
  beforeEach(() => {
    cache.clear();
  });

  it("returns undefined for missing entry", () => {
    expect(cacheGet("missing")).toBeUndefined();
  });

  it("stores and retrieves a vector", () => {
    const vec = [1, 2, 3];
    cacheSet("hello", vec);
    expect(cacheGet("hello")).toEqual(vec);
  });

  it("promotes accessed entry to most-recently-used", () => {
    cacheSet("a", [1]);
    cacheSet("b", [2]);
    // Access "a" to promote it
    cacheGet("a");
    // "b" should now be the oldest (first in iteration order)
    const keys = [...cache.keys()];
    const keyA = cacheKey("a");
    const keyB = cacheKey("b");
    expect(keys.indexOf(keyB)).toBeLessThan(keys.indexOf(keyA));
  });

  it("evicts oldest entry when over CACHE_MAX_ENTRIES", () => {
    // Fill cache to the limit + 1
    // Use a small subset approach: insert CACHE_MAX_ENTRIES + 1 entries
    // Since that's 10001, we'll use the cache map directly for speed
    const firstKey = cacheKey("evict-me");
    cache.set(firstKey, [0]);
    for (let i = 1; i < CACHE_MAX_ENTRIES; i++) {
      cache.set(`key-${i}`, [i]);
    }
    expect(cache.size).toBe(CACHE_MAX_ENTRIES);

    // This should trigger eviction of the first entry
    cacheSet("new-entry", [999]);
    expect(cache.size).toBe(CACHE_MAX_ENTRIES);
    expect(cache.has(firstKey)).toBe(false);
  });
});

describe("validateEmbedRequest", () => {
  it("rejects non-object body", () => {
    const result = validateEmbedRequest(null);
    expect(result).toEqual({ error: "missing texts array", status: 400 });
  });

  it("rejects missing texts field", () => {
    const result = validateEmbedRequest({});
    expect(result).toEqual({ error: "missing texts array", status: 400 });
  });

  it("rejects empty texts array", () => {
    const result = validateEmbedRequest({ texts: [] });
    expect(result).toEqual({ error: "missing texts array", status: 400 });
  });

  it("rejects too many texts", () => {
    const texts = new Array(MAX_TEXTS + 1).fill("x");
    const result = validateEmbedRequest({ texts });
    expect(result).toEqual({ error: `max ${MAX_TEXTS} texts per request`, status: 400 });
  });

  it("accepts valid texts array", () => {
    const result = validateEmbedRequest({ texts: ["hello", "world"] });
    expect(result).toEqual({ texts: ["hello", "world"] });
  });

  it("truncates long texts to MAX_TEXT_LENGTH", () => {
    const longText = "x".repeat(MAX_TEXT_LENGTH + 500);
    const result = validateEmbedRequest({ texts: [longText] });
    expect("texts" in result).toBe(true);
    if ("texts" in result) {
      expect(result.texts[0]!.length).toBe(MAX_TEXT_LENGTH);
    }
  });

  it("replaces non-string array elements with empty string", () => {
    const result = validateEmbedRequest({ texts: [42, null, "ok"] });
    expect("texts" in result).toBe(true);
    if ("texts" in result) {
      expect(result.texts).toEqual(["", "", "ok"]);
    }
  });

  it("accepts exactly MAX_TEXTS entries", () => {
    const texts = new Array(MAX_TEXTS).fill("x");
    const result = validateEmbedRequest({ texts });
    expect("texts" in result).toBe(true);
  });
});
