/**
 * Streaming token-usage extraction — pure logic, extracted from the edge route
 * so it can be unit-tested (it feeds billing). Normalizes each provider's
 * streaming usage shape into one accumulator whose fields match
 * `calculateCostMicro`'s formula: `input` is UNCACHED input, `cacheRead` is
 * cached/discounted input, `cacheCreation` / `cacheCreation1h` are the
 * (Anthropic-only) cache writes at the 5-minute (1.25x) and 1-hour (2x) rates.
 *
 * Provider semantics differ and the normalization MUST preserve them:
 *   - Anthropic: `input_tokens` already EXCLUDES cached; `cache_read_input_tokens`
 *     and `cache_creation_input_tokens` are separate → additive. Two rules keep
 *     the meter from under-charging:
 *       · usage is CUMULATIVE and may GROW after `message_start` (server tools
 *         such as web_search re-prompt the model; `message_delta` then reports
 *         the larger input) — every field takes the max reported, never only
 *         `message_start`'s.
 *       · cache writes are priced by TTL from the `cache_creation` split
 *         (`ephemeral_5m_input_tokens` 1.25x, `ephemeral_1h_input_tokens` 2x).
 *         A client may set `ttl: "1h"`, so a write the split does not account
 *         for is priced at the 1-hour rate (the highest) and flagged
 *         `cacheTtlBounded` — logged as an estimate.
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
  /** Cache-write tokens at the 5-minute rate (1.25x input). */
  cacheCreation: number;
  /** Cache-write tokens at the 1-hour rate (2x input) — incl. any write of unknown TTL. */
  cacheCreation1h?: number;
  /** Set when some cache-write tokens had no TTL split and were priced at the 1-hour rate. */
  cacheTtlBounded?: boolean;
  /** Raw Anthropic cache-write maxima, from which the two priced fields derive. */
  anthropicCache?: { total: number; split5m: number; split1h: number };
  /** Set once the provider has REPORTED input usage (not merely defaulted to 0). */
  inputReported?: boolean;
  /** Set once the provider has reported its FINAL output usage — the request's usage is then exact. */
  outputReported?: boolean;
}

/** Anthropic's usage block (on `message_start.message` and on `message_delta`). */
interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

/** Extract token usage from a streaming SSE chunk, mutating the accumulator. */
export function extractUsage(provider: InferenceHost, line: string, usage: UsageAccumulator): void {
  if (!line.startsWith("data: ")) return;
  const json = line.slice(6);
  if (json === "[DONE]") return;
  try {
    const evt = JSON.parse(json) as Record<string, unknown>;

    if (provider === "anthropic") {
      // Anthropic nests input + cache usage on `message_start` under
      // `message.usage` (NOT top-level), and reports the final output_tokens on
      // `message_delta` under top-level `usage`. Reading top-level `usage` for
      // everything silently drops input + cache (billing the bulk of the request
      // at 0 and making cacheRead unobservable). Mirror the wire shape — and the
      // BYOK parser in @motebit/ai-core (core.ts) — exactly.
      // input_tokens EXCLUDES cached, so the cache fields stay additive.
      const start = (evt.message as { usage?: AnthropicUsage } | undefined)?.usage;
      if (start) applyAnthropicUsage(start, usage, false);
      // message_delta: final output, and — with server tools — grown input.
      // Typed, so a stray top-level `usage` on any other event never counts.
      const delta = evt.type === "message_delta" ? (evt.usage as AnthropicUsage | undefined) : null;
      if (delta) applyAnthropicUsage(delta, usage, true);
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
        usage.inputReported = true;
      }
      if (u?.completion_tokens != null) {
        usage.output = u.completion_tokens;
        usage.outputReported = true;
      }
      return;
    }

    // Google / Groq — not cache-optimized here; plain input/output.
    const u = evt.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
    if (u?.prompt_tokens != null) {
      usage.input = u.prompt_tokens;
      usage.inputReported = true;
    }
    if (u?.completion_tokens != null) {
      usage.output = u.completion_tokens;
      usage.outputReported = true;
    }
  } catch {
    // Not valid JSON — ignore
  }
}

/** Anthropic usage block → accumulator; every field is cumulative, so take the max. */
function applyAnthropicUsage(u: AnthropicUsage, usage: UsageAccumulator, isDelta: boolean): void {
  const num = (n: unknown): number | null =>
    typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
  const input = num(u.input_tokens);
  if (input != null) {
    usage.input = usage.inputReported ? Math.max(usage.input, input) : input;
    usage.inputReported = true;
  }
  const read = num(u.cache_read_input_tokens);
  if (read != null) usage.cacheRead = Math.max(usage.cacheRead, read);

  const c = (usage.anthropicCache ??= { total: 0, split5m: 0, split1h: 0 });
  const total = num(u.cache_creation_input_tokens);
  if (total != null) c.total = Math.max(c.total, total);
  const s5 = num(u.cache_creation?.ephemeral_5m_input_tokens);
  if (s5 != null) c.split5m = Math.max(c.split5m, s5);
  const s1 = num(u.cache_creation?.ephemeral_1h_input_tokens);
  if (s1 != null) c.split1h = Math.max(c.split1h, s1);
  // Whatever the split does not account for is priced at the 1-hour rate.
  const unsplit = Math.max(0, c.total - c.split5m - c.split1h);
  usage.cacheCreation = c.split5m;
  usage.cacheCreation1h = c.split1h + unsplit;
  usage.cacheTtlBounded = unsplit > 0;

  // Output is reported FINAL only on message_delta (message_start's is a placeholder).
  const output = num(u.output_tokens);
  if (isDelta && output != null) {
    usage.output = Math.max(usage.output, output);
    usage.outputReported = true;
  }
}
