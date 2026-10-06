/**
 * Report — pure aggregation over a run file + judgments. No I/O, no clock, so
 * every number in the markdown is reproducible from the committed-format JSON
 * and unit-testable.
 */

import type {
  JudgeFile,
  Judgment,
  PromptCategory,
  RouteAResult,
  RouteId,
  RunFile,
  ScoreDimension,
} from "./types.js";
import { PROMPT_CATEGORIES, ROUTE_LABELS, SCORE_DIMENSIONS } from "./types.js";

/** Nearest-rank percentile (p in [0,100]) — no interpolation, so every value reported was observed. */
export function percentile(values: readonly number[], p: number): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * xs.length));
  return xs[Math.min(rank, xs.length) - 1]!;
}

export const median = (values: readonly number[]): number | null => percentile(values, 50);

export interface WinRate {
  pair: [RouteId, RouteId];
  wins: number;
  losses: number;
  ties: number;
  /** wins / (wins + losses + ties); ties count as half a win. null when n = 0. */
  rate: number | null;
  n: number;
}

/** First route's win rate against the second, over every judgment that compared them. */
export function winRate(judgments: readonly Judgment[], a: RouteId, b: RouteId): WinRate {
  let wins = 0;
  let losses = 0;
  let ties = 0;
  for (const j of judgments) {
    for (const v of j.pairwise) {
      const matches = (v.a === a && v.b === b) || (v.a === b && v.b === a);
      if (!matches) continue;
      if (v.winner === "tie") ties += 1;
      else if (v.winner === a) wins += 1;
      else losses += 1;
    }
  }
  const n = wins + losses + ties;
  return { pair: [a, b], wins, losses, ties, rate: n > 0 ? (wins + ties / 2) / n : null, n };
}

export function meanScore(
  judgments: readonly Judgment[],
  route: RouteId,
  dim?: ScoreDimension,
): number | null {
  const xs: number[] = [];
  for (const j of judgments) {
    const s = j.scores[route];
    if (!s) continue;
    xs.push(
      dim ? s[dim] : SCORE_DIMENSIONS.reduce((n, d) => n + s[d], 0) / SCORE_DIMENSIONS.length,
    );
  }
  return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export interface LatencyStats {
  route: RouteId;
  n: number;
  ttft_median: number | null;
  ttft_p90: number | null;
  total_median: number | null;
  total_p90: number | null;
}

export function latencyStats(run: RunFile, route: RouteId): LatencyStats {
  const ttft: number[] = [];
  const total: number[] = [];
  for (const r of run.runs) {
    const res = r.results[route];
    if (!res || res.error) continue;
    if (res.ttft_ms !== null) ttft.push(res.ttft_ms);
    total.push(res.total_ms);
  }
  return {
    route,
    n: total.length,
    ttft_median: median(ttft),
    ttft_p90: percentile(ttft, 90),
    total_median: median(total),
    total_p90: percentile(total, 90),
  };
}

export interface OverheadBreakdown {
  n: number;
  context_pipeline_ms: number | null;
  event_query_ms: number | null;
  embed_ms: number | null;
  pinned_ms: number | null;
  memory_retrieve_ms: number | null;
  provider_ttft_ms: number | null;
}

export function overheadBreakdown(run: RunFile): OverheadBreakdown {
  const keys = [
    "context_pipeline_ms",
    "event_query_ms",
    "embed_ms",
    "pinned_ms",
    "memory_retrieve_ms",
    "provider_ttft_ms",
  ] as const;
  const cols: Record<(typeof keys)[number], number[]> = {
    context_pipeline_ms: [],
    event_query_ms: [],
    embed_ms: [],
    pinned_ms: [],
    memory_retrieve_ms: [],
    provider_ttft_ms: [],
  };
  let n = 0;
  for (const r of run.runs) {
    const a = r.results.A as RouteAResult | undefined;
    const lat = a?.motebit?.latency;
    if (!lat) continue;
    n += 1;
    for (const k of keys) cols[k].push(lat[k]);
  }
  return {
    n,
    context_pipeline_ms: median(cols.context_pipeline_ms),
    event_query_ms: median(cols.event_query_ms),
    embed_ms: median(cols.embed_ms),
    pinned_ms: median(cols.pinned_ms),
    memory_retrieve_ms: median(cols.memory_retrieve_ms),
    provider_ttft_ms: median(cols.provider_ttft_ms),
  };
}

/** Output length A/B: aggregate (Σ A tokens / Σ B tokens) and median per-prompt ratio. */
export function outputLengthRatio(
  run: RunFile,
  num: RouteId = "A",
  den: RouteId = "B",
): { aggregate: number | null; median_per_prompt: number | null; n: number } {
  let sa = 0;
  let sb = 0;
  const ratios: number[] = [];
  for (const r of run.runs) {
    const a = r.results[num];
    const b = r.results[den];
    if (!a || !b || a.error || b.error) continue;
    sa += a.usage.output_tokens;
    sb += b.usage.output_tokens;
    if (b.usage.output_tokens > 0) ratios.push(a.usage.output_tokens / b.usage.output_tokens);
  }
  return {
    aggregate: sb > 0 ? sa / sb : null,
    median_per_prompt: median(ratios),
    n: ratios.length,
  };
}

export interface ContextRetention {
  prompts_with_history: number;
  messages_total: number;
  messages_retained: number;
  tokens_total_est: number;
  tokens_retained_est: number;
  trimmed_prompts: string[];
}

export function contextRetention(run: RunFile): ContextRetention {
  const out: ContextRetention = {
    prompts_with_history: 0,
    messages_total: 0,
    messages_retained: 0,
    tokens_total_est: 0,
    tokens_retained_est: 0,
    trimmed_prompts: [],
  };
  for (const r of run.runs) {
    const a = r.results.A as RouteAResult | undefined;
    const m = a?.motebit;
    if (!m || m.history_messages === 0) continue;
    out.prompts_with_history += 1;
    out.messages_total += m.history_messages;
    out.messages_retained += m.history_retained;
    out.tokens_total_est += m.history_tokens_est;
    out.tokens_retained_est += m.history_tokens_retained_est;
    if (m.history_retained < m.history_messages && !out.trimmed_prompts.includes(r.prompt_id)) {
      out.trimmed_prompts.push(r.prompt_id);
    }
  }
  return out;
}

export interface GapSection {
  title: string;
  a: RouteId;
  b: RouteId;
  overall: WinRate;
  byCategory: Array<{ category: PromptCategory; win: WinRate }>;
  mean_score_a: number | null;
  mean_score_b: number | null;
}

export function gapSection(
  title: string,
  judgments: readonly Judgment[],
  a: RouteId,
  b: RouteId,
): GapSection {
  return {
    title,
    a,
    b,
    overall: winRate(judgments, a, b),
    byCategory: PROMPT_CATEGORIES.map((category) => ({
      category,
      win: winRate(
        judgments.filter((j) => j.category === category),
        a,
        b,
      ),
    })).filter((row) => row.win.n > 0),
    mean_score_a: meanScore(judgments, a),
    mean_score_b: meanScore(judgments, b),
  };
}

export interface Report {
  model: string;
  judge_model: string | null;
  routes: RouteId[];
  prompts: number;
  repetitions: number;
  latency: LatencyStats[];
  overhead: OverheadBreakdown;
  output_ratio_A_B: ReturnType<typeof outputLengthRatio>;
  context: ContextRetention;
  motebit_tax: GapSection;
  pipeline_only: GapSection;
  vendor_advantage: GapSection;
  user_gap: GapSection;
  ttft_tax_ms: number | null;
  total_tax_ms: number | null;
  pipeline_ttft_ms: number | null;
  errors: Array<{ prompt_id: string; route: RouteId; error: string }>;
  spend_usd: number;
}

export function buildReport(run: RunFile, judged: JudgeFile | null): Report {
  const judgments = judged?.judgments ?? [];
  const routes = [...run.routes];
  if (judgments.some((j) => j.scores.C) && !routes.includes("C")) routes.push("C");
  const lat = routes.map((r) => latencyStats(run, r));
  const statOf = (r: RouteId) => lat.find((l) => l.route === r);
  const diff = (x: number | null | undefined, y: number | null | undefined) =>
    x != null && y != null ? x - y : null;
  const errors: Report["errors"] = [];
  for (const r of run.runs) {
    for (const [route, res] of Object.entries(r.results)) {
      if (res?.error)
        errors.push({ prompt_id: r.prompt_id, route: route as RouteId, error: res.error });
    }
  }
  return {
    model: run.model,
    judge_model: judged?.judge_model ?? null,
    routes,
    prompts: new Set(run.runs.map((r) => r.prompt_id)).size,
    repetitions: run.repetitions,
    latency: lat,
    overhead: overheadBreakdown(run),
    output_ratio_A_B: outputLengthRatio(run),
    context: contextRetention(run),
    motebit_tax: gapSection("Motebit tax (A vs B)", judgments, "A", "B"),
    pipeline_only: gapSection("Same prompt, pipeline removed (A vs B′)", judgments, "A", "Bp"),
    vendor_advantage: gapSection("Vendor product advantage (C vs B)", judgments, "C", "B"),
    user_gap: gapSection("User gap (A vs C)", judgments, "A", "C"),
    ttft_tax_ms: diff(statOf("A")?.ttft_median, statOf("B")?.ttft_median),
    total_tax_ms: diff(statOf("A")?.total_median, statOf("B")?.total_median),
    pipeline_ttft_ms: diff(statOf("A")?.ttft_median, statOf("Bp")?.ttft_median),
    errors,
    spend_usd: run.spend_usd + (judged?.spend_usd ?? 0),
  };
}

// === Markdown ===

const ms = (v: number | null): string => (v === null ? "—" : `${Math.round(v)} ms`);
const pct = (v: number | null): string => (v === null ? "—" : `${(v * 100).toFixed(0)}%`);
const num = (v: number | null, d = 2): string => (v === null ? "—" : v.toFixed(d));
const signedMs = (v: number | null): string =>
  v === null ? "—" : `${v >= 0 ? "+" : ""}${Math.round(v)} ms`;

function gapMarkdown(g: GapSection, lead: string): string[] {
  const out = [`## ${g.title}`, "", lead, ""];
  if (g.overall.n === 0) {
    out.push(`_Not measured — no judgment compared ${g.a} with ${g.b}._`, "");
    return out;
  }
  out.push(
    `Overall: **${g.a} win rate ${pct(g.overall.rate)}** over ${g.overall.n} comparisons ` +
      `(${g.overall.wins} W / ${g.overall.losses} L / ${g.overall.ties} T). ` +
      `Mean score ${g.a} ${num(g.mean_score_a)} vs ${g.b} ${num(g.mean_score_b)}.`,
    "",
    `| category | ${g.a} win rate | W / L / T | n |`,
    "|---|---|---|---|",
    ...g.byCategory.map(
      (r) =>
        `| ${r.category} | ${pct(r.win.rate)} | ${r.win.wins} / ${r.win.losses} / ${r.win.ties} | ${r.win.n} |`,
    ),
    "",
  );
  return out;
}

export function renderMarkdown(r: Report): string {
  const lines: string[] = [
    "# Intelligence-parity bench",
    "",
    `Model under test: \`${r.model}\` · judge: ${r.judge_model ? `\`${r.judge_model}\`` : "not run"} · ` +
      `${r.prompts} prompts × ${r.repetitions} repetition(s) · spend $${r.spend_usd.toFixed(4)}`,
    "",
    "Routes: " +
      r.routes.map((x) => `**${x === "Bp" ? "B′" : x}** = ${ROUTE_LABELS[x]}`).join("; ") +
      ".",
    "B and B′ send the parameters A actually sent (copied from A's request on the wire), so a",
    "difference between them is attributable to motebit's prompt, context and pipeline only.",
    "",
    "## Latency",
    "",
    "| route | n | TTFT median | TTFT p90 | total median | total p90 |",
    "|---|---|---|---|---|---|",
    ...r.latency.map(
      (l) =>
        `| ${l.route === "Bp" ? "B′" : l.route} | ${l.n} | ${ms(l.ttft_median)} | ${ms(l.ttft_p90)} | ${ms(l.total_median)} | ${ms(l.total_p90)} |`,
    ),
    "",
    "### Motebit pre-model overhead (route A, median of `TurnLatency`)",
    "",
    `| stage | median |`,
    "|---|---|",
    `| context pipeline (total pre-model) | ${ms(r.overhead.context_pipeline_ms)} |`,
    `| event query | ${ms(r.overhead.event_query_ms)} |`,
    `| embed | ${ms(r.overhead.embed_ms)} |`,
    `| pinned memories | ${ms(r.overhead.pinned_ms)} |`,
    `| memory retrieve | ${ms(r.overhead.memory_retrieve_ms)} |`,
    `| provider TTFT (first call → first text) | ${ms(r.overhead.provider_ttft_ms)} |`,
    "",
    `Sampled turns: ${r.overhead.n}.`,
    "",
    "### Output length and context",
    "",
    `Output tokens A/B: aggregate ${num(r.output_ratio_A_B.aggregate)}×, median per prompt ${num(r.output_ratio_A_B.median_per_prompt)}× (n=${r.output_ratio_A_B.n}).`,
    "",
    `History retained by route A: ${r.context.messages_retained}/${r.context.messages_total} messages, ` +
      `~${r.context.tokens_retained_est}/${r.context.tokens_total_est} tokens (est.) across ` +
      `${r.context.prompts_with_history} multi-turn prompt(s). Route B always sends the full history.` +
      (r.context.trimmed_prompts.length > 0
        ? ` Trimmed: ${r.context.trimmed_prompts.map((p) => `\`${p}\``).join(", ")}.`
        : ""),
    "",
  ];
  lines.push(
    ...gapMarkdown(
      r.motebit_tax,
      `Same model, same parameters; A goes through motebit, B is a direct call with a neutral prompt and the full conversation. ` +
        `TTFT tax (median A − median B): **${signedMs(r.ttft_tax_ms)}**; total-time tax: **${signedMs(r.total_tax_ms)}**. ` +
        `A win rate below 50% means routing through motebit made answers worse.`,
    ),
    ...gapMarkdown(
      r.pipeline_only,
      `B′ replays A's exact request directly, so the quality gap here should be noise; the latency gap ` +
        `(median TTFT A − B′: **${signedMs(r.pipeline_ttft_ms)}**) is motebit's pipeline time.`,
    ),
    ...gapMarkdown(
      r.vendor_advantage,
      `C is the vendor's own product (claude.ai / ChatGPT), collected manually. C beating B is what the vendor's product layer adds over the raw model.`,
    ),
    ...gapMarkdown(
      r.user_gap,
      `What a user feels switching between motebit and the vendor product.`,
    ),
  );
  if (r.errors.length > 0) {
    lines.push(
      "## Errors",
      "",
      "Errored answers are excluded from latency stats; they are judged as whatever text they produced.",
      "",
      ...r.errors.map(
        (e) =>
          `- \`${e.prompt_id}\` route ${e.route}: ${e.error.replace(/\s+/g, " ").slice(0, 200)}`,
      ),
      "",
    );
  }
  lines.push(
    "## Aperture",
    "",
    "- Tools offered on route A are the deterministic CLI builtins (`current_time`, `recall_memories`, `recall_self`); web tools are excluded for repeatability.",
    "- Route B/B′ answer tool calls by replaying route A's recorded result for an identical call; any other call is refused and counted.",
    "- Route B has no memory: memory-category prompts measure what motebit's memory is worth, not a tax.",
    "- Token estimates for history use the runtime's own ~4 chars/token estimator.",
    "",
  );
  return lines.join("\n");
}
