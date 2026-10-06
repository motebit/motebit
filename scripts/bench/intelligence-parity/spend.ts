/**
 * Spend guard — the bench costs real money, so it refuses to start a run it
 * cannot price, and stops a run that crosses its budget.
 *
 * Two layers, because each alone is insufficient:
 *   - PRE-FLIGHT: an estimate (tokens × published price) must be ≤ max_usd or
 *     the run never starts. Estimates are guesses; this catches the order-of-
 *     magnitude mistake (a subset of "all" at 10 repetitions on Fable).
 *   - LIVE METER: actual usage, read off the wire, is priced after every call;
 *     the run aborts before the next call once spend reaches max_usd. This is
 *     the hard bound the estimate cannot be.
 *
 * FAIL-CLOSED ON UNKNOWN MODELS. A model with no price row is refused rather
 * than priced at zero — a zero would make the guard a no-op for exactly the
 * model nobody has costed yet.
 *
 * Prices: Anthropic first-party list prices, USD per million tokens (as of
 * 2026-09-25). Cache writes bill at 1.25× input (5-minute TTL), cache reads at
 * the per-model rate below.
 */

import type { BenchPrompt, RouteId, Usage } from "./types.js";

export interface ModelPrice {
  input: number;
  output: number;
  cache_read: number;
}

export const PRICES_USD_PER_MTOK: Readonly<Record<string, ModelPrice>> = {
  "claude-fable-5-1": { input: 10, output: 50, cache_read: 0.25 },
  "claude-fable-5": { input: 10, output: 50, cache_read: 1 },
  "claude-opus-5-5": { input: 4, output: 20, cache_read: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cache_read: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cache_read: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cache_read: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, cache_read: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cache_read: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10, cache_read: 0.2 },
  "claude-sonnet-4-6": { input: 3, output: 15, cache_read: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, cache_read: 0.1 },
};

export const CACHE_WRITE_MULTIPLIER = 1.25;

export function priceFor(model: string): ModelPrice {
  const exact = PRICES_USD_PER_MTOK[model];
  if (exact) return exact;
  // Dated snapshot ids (`claude-haiku-4-5-20251001`) price as their family.
  const family = Object.keys(PRICES_USD_PER_MTOK)
    .filter((k) => model.startsWith(`${k}-`))
    .sort((a, b) => b.length - a.length)[0];
  if (family) return PRICES_USD_PER_MTOK[family]!;
  throw new Error(
    `No price for model "${model}". The spend guard refuses to run an unpriced model.\n` +
      `  → Add its USD-per-MTok row to PRICES_USD_PER_MTOK in ` +
      `scripts/bench/intelligence-parity/spend.ts (from the vendor's published price list).`,
  );
}

export function costUsd(model: string, usage: Usage): number {
  const p = priceFor(model);
  return (
    (usage.input_tokens * p.input +
      usage.output_tokens * p.output +
      usage.cache_read_input_tokens * p.cache_read +
      usage.cache_creation_input_tokens * p.input * CACHE_WRITE_MULTIPLIER) /
    1_000_000
  );
}

/**
 * Estimation constants. Deliberately pessimistic: the estimate's job is to
 * refuse a run that is obviously too big, so it rounds UP.
 */
export const ESTIMATE = {
  /** motebit's assembled system prompt + tool schemas, tokens (measured runs land well under). */
  motebitSystemTokens: 12_000,
  /** Neutral system + tool schemas copied from A. */
  directSystemTokens: 3_000,
  /** Per-answer output tokens, including adaptive thinking. */
  outputTokensPerAnswer: 2_500,
  /** Model rounds for a tool-expected prompt (call → result → answer). */
  toolRounds: 3,
  /** Rubric + framing on the judge call. */
  judgeOverheadTokens: 1_500,
  judgeOutputTokens: 800,
} as const;

function tokensOf(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface SpendEstimate {
  usd: number;
  input_tokens: number;
  output_tokens: number;
  calls: number;
}

export function estimateRun(opts: {
  prompts: readonly BenchPrompt[];
  routes: readonly RouteId[];
  repetitions: number;
  model: string;
  judgeModel: string | null;
}): SpendEstimate {
  const live = opts.routes.filter((r) => r !== "C");
  let usd = 0;
  let input = 0;
  let output = 0;
  let calls = 0;
  for (const p of opts.prompts) {
    const convo =
      tokensOf(p.prompt) + (p.history ?? []).reduce((n, m) => n + tokensOf(m.content), 0);
    const rounds = p.tools_expected ? ESTIMATE.toolRounds : 1;
    for (const r of live) {
      const sys = r === "B" ? ESTIMATE.directSystemTokens : ESTIMATE.motebitSystemTokens;
      // Every round resends the whole context plus the prior rounds' output.
      const inTok = rounds * (sys + convo) + ((rounds * (rounds - 1)) / 2) * 500;
      const outTok = rounds * ESTIMATE.outputTokensPerAnswer;
      input += inTok;
      output += outTok;
      calls += rounds;
      usd += costUsd(opts.model, {
        input_tokens: inTok,
        output_tokens: outTok,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      });
    }
    if (opts.judgeModel) {
      const answers = opts.routes.length * ESTIMATE.outputTokensPerAnswer;
      const inTok = ESTIMATE.judgeOverheadTokens + convo + answers;
      input += inTok;
      output += ESTIMATE.judgeOutputTokens;
      calls += 1;
      usd += costUsd(opts.judgeModel, {
        input_tokens: inTok,
        output_tokens: ESTIMATE.judgeOutputTokens,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      });
    }
  }
  const reps = Math.max(1, opts.repetitions);
  return {
    usd: usd * reps,
    input_tokens: input * reps,
    output_tokens: output * reps,
    calls: calls * reps,
  };
}

export class SpendLimitExceeded extends Error {
  constructor(
    readonly spentUsd: number,
    readonly maxUsd: number,
  ) {
    super(
      `Spend guard: $${spentUsd.toFixed(4)} spent, limit $${maxUsd.toFixed(2)} — stopping before the next call.\n` +
        `  → Results so far are written. Narrow --subset, lower --repetitions, or raise --max-usd deliberately.`,
    );
    this.name = "SpendLimitExceeded";
  }
}

/** Live meter. `charge` after every call; `check` before the next one. */
export class SpendMeter {
  private spent = 0;
  constructor(readonly maxUsd: number) {
    if (!(maxUsd > 0)) throw new Error(`--max-usd must be > 0 (got ${maxUsd})`);
  }
  charge(model: string, usage: Usage): void {
    this.spent += costUsd(model, usage);
  }
  get spentUsd(): number {
    return this.spent;
  }
  check(): void {
    if (this.spent >= this.maxUsd) throw new SpendLimitExceeded(this.spent, this.maxUsd);
  }
}

/** Pre-flight: throws when the estimate is over budget. */
export function assertEstimateWithinBudget(est: SpendEstimate, maxUsd: number): void {
  if (est.usd > maxUsd) {
    throw new Error(
      `Spend guard: estimated $${est.usd.toFixed(2)} (${est.calls} calls, ` +
        `~${est.input_tokens.toLocaleString()} in / ~${est.output_tokens.toLocaleString()} out tokens) ` +
        `exceeds --max-usd=$${maxUsd.toFixed(2)}.\n` +
        `  → Narrow --subset, lower --repetitions, or raise --max-usd deliberately.`,
    );
  }
}
