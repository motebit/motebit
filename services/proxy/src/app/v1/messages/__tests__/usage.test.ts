/**
 * extractUsage — normalizes each provider's streaming token usage so the cost
 * formula is correct AND caching is observable. The load-bearing invariant: for
 * EVERY provider, `input` is the UNCACHED portion and `cacheRead` is the
 * cached/discounted portion (additive). OpenAI's `prompt_tokens` includes cached,
 * so it must be split; Anthropic's already excludes cached, so it passes through.
 */
import { describe, it, expect } from "vitest";
import { extractUsage, type UsageAccumulator } from "../usage";

const fresh = (): UsageAccumulator => ({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}`;

describe("extractUsage — anthropic", () => {
  it("passes input/output/cache fields through (input already excludes cached)", () => {
    const u = fresh();
    extractUsage(
      "anthropic",
      sse({
        usage: {
          input_tokens: 100,
          output_tokens: 40,
          cache_read_input_tokens: 3000,
          cache_creation_input_tokens: 50,
        },
      }),
      u,
    );
    expect(u).toEqual({ input: 100, output: 40, cacheRead: 3000, cacheCreation: 50 });
  });
});

describe("extractUsage — openai", () => {
  it("splits prompt_tokens into uncached input + cached read (no double-count)", () => {
    const u = fresh();
    extractUsage(
      "openai",
      sse({
        usage: {
          prompt_tokens: 3200,
          completion_tokens: 60,
          prompt_tokens_details: { cached_tokens: 3000 },
        },
      }),
      u,
    );
    // prompt_tokens INCLUDES cached → input is the uncached remainder.
    expect(u.input).toBe(200);
    expect(u.cacheRead).toBe(3000);
    expect(u.output).toBe(60);
    // input + cacheRead reconstructs the full prompt_tokens (additive).
    expect(u.input + u.cacheRead).toBe(3200);
  });

  it("handles a response with no cached tokens (cacheRead stays 0)", () => {
    const u = fresh();
    extractUsage("openai", sse({ usage: { prompt_tokens: 500, completion_tokens: 20 } }), u);
    expect(u.input).toBe(500);
    expect(u.cacheRead).toBe(0);
  });
});

describe("extractUsage — google/groq (not cache-optimized)", () => {
  it("records plain input/output, never a cacheRead", () => {
    const g = fresh();
    extractUsage("google", sse({ usage: { prompt_tokens: 400, completion_tokens: 30 } }), g);
    expect(g).toEqual({ input: 400, output: 30, cacheRead: 0, cacheCreation: 0 });

    const q = fresh();
    extractUsage(
      "groq",
      // Even if a cached_tokens detail appeared, the non-openai path ignores it.
      sse({
        usage: {
          prompt_tokens: 400,
          completion_tokens: 30,
          prompt_tokens_details: { cached_tokens: 100 },
        },
      }),
      q,
    );
    expect(q.cacheRead).toBe(0);
    expect(q.input).toBe(400);
  });
});

describe("extractUsage — robustness", () => {
  it("ignores non-data lines, [DONE], and malformed JSON", () => {
    const u = fresh();
    extractUsage("openai", "event: ping", u);
    extractUsage("openai", "data: [DONE]", u);
    extractUsage("openai", "data: {not json", u);
    expect(u).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
  });
});
