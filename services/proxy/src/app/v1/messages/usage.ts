/**
 * Streaming token-usage extraction — pure logic, extracted from the edge route
 * so it can be unit-tested (it feeds billing). Normalizes each provider's
 * streaming usage shape into one accumulator whose fields match
 * `calculateCostMicro`'s formula: `input` is UNCACHED input, `cacheRead` is
 * cached/discounted input, `cacheCreation` is the (Anthropic-only) cache-write
 * surcharge.
 *
 * Provider semantics differ and the normalization MUST preserve them:
 *   - Anthropic: `input_tokens` already EXCLUDES cached; `cache_read_input_tokens`
 *     and `cache_creation_input_tokens` are separate → additive, passed straight
 *     through.
 *   - OpenAI: `prompt_tokens` INCLUDES `prompt_tokens_details.cached_tokens`, so
 *     we split (`input = prompt - cached`, `cacheRead = cached`) to keep the cost
 *     formula's (uncached + cacheRead) additive and avoid double-counting. OpenAI
 *     has no cache-creation charge.
 *   - Google / Groq: not cache-optimized here — plain input/output only.
 */
import type { InferenceHost } from "../../../validation";

export interface UsageAccumulator {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/** Extract token usage from a streaming SSE chunk, mutating the accumulator. */
export function extractUsage(provider: InferenceHost, line: string, usage: UsageAccumulator): void {
  if (!line.startsWith("data: ")) return;
  const json = line.slice(6);
  if (json === "[DONE]") return;
  try {
    const evt = JSON.parse(json) as Record<string, unknown>;

    if (provider === "anthropic") {
      // Anthropic: initial message has usage.input_tokens, message_delta has
      // usage.output_tokens. input_tokens EXCLUDES cached — additive with the
      // cache fields, so pass through unchanged.
      const u = evt.usage as
        | {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          }
        | undefined;
      if (u?.input_tokens != null) usage.input = u.input_tokens;
      if (u?.output_tokens != null) usage.output = u.output_tokens;
      if (u?.cache_read_input_tokens != null) usage.cacheRead = u.cache_read_input_tokens;
      if (u?.cache_creation_input_tokens != null)
        usage.cacheCreation = u.cache_creation_input_tokens;
      return;
    }

    if (provider === "openai") {
      // OpenAI: prompt_tokens INCLUDES cached. Split so (input + cacheRead) stays
      // additive — billing the cached portion at OpenAI's discounted rate in
      // calculateCostMicro rather than full price. No cache-creation concept.
      const u = evt.usage as
        | {
            prompt_tokens?: number;
            completion_tokens?: number;
            prompt_tokens_details?: { cached_tokens?: number };
          }
        | undefined;
      if (u?.prompt_tokens != null) {
        const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
        usage.input = u.prompt_tokens - cached;
        usage.cacheRead = cached;
      }
      if (u?.completion_tokens != null) usage.output = u.completion_tokens;
      return;
    }

    // Google / Groq — not cache-optimized here; plain input/output.
    const u = evt.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
    if (u?.prompt_tokens != null) usage.input = u.prompt_tokens;
    if (u?.completion_tokens != null) usage.output = u.completion_tokens;
  } catch {
    // Not valid JSON — ignore
  }
}
