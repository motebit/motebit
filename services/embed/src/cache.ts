/**
 * LRU embedding cache — pure functions, no side effects.
 * Extracted from index.ts for testability.
 */

import { createHash } from "node:crypto";

export const CACHE_MAX_ENTRIES = 10_000;

export const cache = new Map<string, number[]>();

export function cacheKey(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function cacheGet(text: string): number[] | undefined {
  const key = cacheKey(text);
  const vec = cache.get(key);
  if (vec) {
    // Move to end (most recently used)
    cache.delete(key);
    cache.set(key, vec);
  }
  return vec;
}

export function cacheSet(text: string, vec: number[]): void {
  const key = cacheKey(text);
  cache.set(key, vec);
  // Evict oldest if over limit
  if (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** Validation constants */
export const MAX_TEXTS = 16;
export const MAX_TEXT_LENGTH = 2000;

/**
 * Validate and clean an embed request body.
 * Returns cleaned texts array or an error string.
 */
export function validateEmbedRequest(
  body: unknown,
): { texts: string[] } | { error: string; status: number } {
  if (typeof body !== "object" || body === null) {
    return { error: "missing texts array", status: 400 };
  }

  const texts = (body as Record<string, unknown>).texts;
  if (!Array.isArray(texts) || texts.length === 0) {
    return { error: "missing texts array", status: 400 };
  }
  if (texts.length > MAX_TEXTS) {
    return { error: `max ${MAX_TEXTS} texts per request`, status: 400 };
  }

  const cleaned = texts.map((t) => (typeof t === "string" ? t.slice(0, MAX_TEXT_LENGTH) : ""));
  return { texts: cleaned };
}
