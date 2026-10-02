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
  it("reads input/cache from message_start.message.usage and output from message_delta.usage", () => {
    const u = fresh();
    // Real Anthropic wire: input + cache fields are NESTED under message.usage on
    // message_start; the final output_tokens arrives top-level on message_delta.
    extractUsage(
      "anthropic",
      sse({
        type: "message_start",
        message: {
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 3000,
            cache_creation_input_tokens: 50,
          },
        },
      }),
      u,
    );
    extractUsage("anthropic", sse({ type: "message_delta", usage: { output_tokens: 40 } }), u);
    // input EXCLUDES cached → additive with the cache fields. No TTL split was
    // reported, so the write is priced at the 1-hour rate (2x, the highest)
    // and flagged as bounded.
    expect(u).toMatchObject({
      input: 100,
      output: 40,
      cacheRead: 3000,
      cacheCreation: 0,
      cacheCreation1h: 50,
      cacheTtlBounded: true,
      inputReported: true,
      outputReported: true,
    });
  });

  it("prices cache writes by TTL from the cache_creation split (5m 1.25x, 1h 2x)", () => {
    const u = fresh();
    extractUsage(
      "anthropic",
      sse({
        type: "message_start",
        message: {
          usage: {
            input_tokens: 100,
            cache_creation_input_tokens: 70,
            cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 50 },
          },
        },
      }),
      u,
    );
    expect(u).toMatchObject({ cacheCreation: 20, cacheCreation1h: 50, cacheTtlBounded: false });
  });

  it("a total the split does not cover is priced at the 1-hour rate", () => {
    const u = fresh();
    extractUsage(
      "anthropic",
      sse({
        type: "message_start",
        message: {
          usage: {
            cache_creation_input_tokens: 100,
            cache_creation: { ephemeral_5m_input_tokens: 40 },
          },
        },
      }),
      u,
    );
    expect(u).toMatchObject({ cacheCreation: 40, cacheCreation1h: 60, cacheTtlBounded: true });
  });

  it("takes the GROWN input a message_delta reports (server tools), never only message_start's", () => {
    const u = fresh();
    extractUsage(
      "anthropic",
      sse({ type: "message_start", message: { usage: { input_tokens: 12_600 } } }),
      u,
    );
    extractUsage(
      "anthropic",
      sse({
        type: "message_delta",
        usage: { input_tokens: 225_000, cache_read_input_tokens: 9, output_tokens: 40 },
      }),
      u,
    );
    expect(u).toMatchObject({ input: 225_000, cacheRead: 9, output: 40, outputReported: true });
    // A later, smaller report never lowers what was already reported.
    extractUsage(
      "anthropic",
      sse({ type: "message_delta", usage: { input_tokens: 5, output_tokens: 41 } }),
      u,
    );
    expect(u).toMatchObject({ input: 225_000, output: 41 });
  });

  it("does NOT read top-level usage on message_start (the wrong shape captures nothing)", () => {
    const u = fresh();
    // A flat top-level usage on a message_start-like event is a shape Anthropic
    // never emits — it must NOT populate input/cache (this guards the prior bug).
    extractUsage(
      "anthropic",
      sse({ usage: { input_tokens: 100, cache_read_input_tokens: 3000 } }),
      u,
    );
    expect(u).toMatchObject({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
    expect(u.inputReported).toBeUndefined();
    expect(u.outputReported).toBeUndefined();
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
    expect(g).toEqual({
      input: 400,
      output: 30,
      cacheRead: 0,
      cacheCreation: 0,
      inputReported: true,
      outputReported: true,
    });

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

describe("extractUsage — reported flags (exact vs bounded metering)", () => {
  it("anthropic: message_start reports input only; output is reported by message_delta", () => {
    const u = fresh();
    extractUsage(
      "anthropic",
      sse({ type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } }),
      u,
    );
    expect(u.inputReported).toBe(true);
    expect(u.outputReported).toBeUndefined();
    extractUsage("anthropic", sse({ type: "message_delta", usage: { output_tokens: 7 } }), u);
    expect(u.outputReported).toBe(true);
  });

  it("openai: content chunks report nothing; the final usage chunk reports both", () => {
    const u = fresh();
    extractUsage("openai", sse({ choices: [{ delta: { content: "hi" } }] }), u);
    expect(u.inputReported).toBeUndefined();
    expect(u.outputReported).toBeUndefined();
    extractUsage("openai", sse({ usage: { prompt_tokens: 5, completion_tokens: 2 } }), u);
    expect(u.inputReported).toBe(true);
    expect(u.outputReported).toBe(true);
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
