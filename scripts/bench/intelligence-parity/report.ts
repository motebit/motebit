/**
 * Report — pure aggregation over a run file + judgments. No I/O, no clock, so
 * every number in the markdown is reproducible from the committed-format JSON
 * and unit-testable (the bootstrap is seeded).
 *
 * PAIRWISE EFFECTS ONLY. Each section contrasts two routes that differ in one
 * ingredient:
 *
 *   A  ↔ B′   runtime / pipeline      (latency deltas + pre-model breakdown)
 *   B′ ↔ B″   system prompt           (quality + length)
 *   B″ ↔ B    context trimming        (quality + length)
 *   A  ↔ C    user gap                (quality)
 *
 * The contrasts are NOT summed into a percentage attribution of A ↔ B unless
 * the 2×2 interaction check (system prompt × trimming, needing route B′ᶠ)
 * supports separability. Otherwise the report states the interaction — or that
 * it was not tested.
 *
 * Quality is a distribution, not a verdict: judge scores and win rates come
 * with cluster-bootstrap 95% CIs (prompts resampled, all of a prompt's samples
 * kept together, since repetitions of one prompt are not independent).
 */

import type {
  DirectRouteResult,
  JudgeFile,
  Judgment,
  RouteAResult,
  RouteId,
  RunFile,
  Scores,
} from "./types.js";
import { ROUTE_DISPLAY, ROUTE_LABELS, SCORE_DIMENSIONS } from "./types.js";
import { hashSeed, seededRng } from "./judge.js";

/** Nearest-rank percentile (p in [0,100]) — no interpolation, so every value reported was observed. */
export function percentile(values: readonly number[], p: number): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * xs.length));
  return xs[Math.min(rank, xs.length) - 1]!;
}

export const median = (values: readonly number[]): number | null => percentile(values, 50);

export const mean = (values: readonly number[]): number | null =>
  values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;

// === Bootstrap ===

export interface Interval {
  /** The statistic on the observed data. */
  estimate: number | null;
  /** 95% percentile-bootstrap bounds; null when there is nothing to resample. */
  lo: number | null;
  hi: number | null;
  /** Observations / clusters (prompts) behind the estimate. */
  n: number;
  clusters: number;
}

export const BOOTSTRAP_ITERATIONS = 2000;

/**
 * Cluster bootstrap: resample CLUSTERS (prompts) with replacement, keep each
 * cluster's observations together, recompute the statistic. Seeded, so a
 * report rebuilt from the same JSON prints the same interval.
 */
export function bootstrapCI(
  clusters: ReadonlyArray<readonly number[]>,
  stat: (xs: readonly number[]) => number | null,
  seed: number,
  iterations = BOOTSTRAP_ITERATIONS,
): Interval {
  const nonEmpty = clusters.filter((c) => c.length > 0);
  const flat = nonEmpty.flat();
  const estimate = stat(flat);
  if (estimate === null || nonEmpty.length === 0) {
    return { estimate, lo: null, hi: null, n: flat.length, clusters: nonEmpty.length };
  }
  const rng = seededRng(seed);
  const draws: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const sample: number[] = [];
    for (let j = 0; j < nonEmpty.length; j++) {
      sample.push(...nonEmpty[Math.floor(rng() * nonEmpty.length)]!);
    }
    const v = stat(sample);
    if (v !== null) draws.push(v);
  }
  return {
    estimate,
    lo: percentile(draws, 2.5),
    hi: percentile(draws, 97.5),
    n: flat.length,
    clusters: nonEmpty.length,
  };
}

export const containsZero = (i: Interval): boolean =>
  i.lo !== null && i.hi !== null && i.lo <= 0 && i.hi >= 0;

// === Quality ===

export const overallScore = (s: Scores): number =>
  SCORE_DIMENSIONS.reduce((n, d) => n + s[d], 0) / SCORE_DIMENSIONS.length;

function byPrompt<T>(items: readonly T[], key: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = out.get(k);
    if (arr) arr.push(it);
    else out.set(k, [it]);
  }
  return out;
}

/** x's outcome on each verdict comparing x with y: 1 win, 0 loss, 0.5 tie. */
function verdictValues(j: Judgment, x: RouteId, y: RouteId): number[] {
  const out: number[] = [];
  for (const v of j.pairwise) {
    if (!((v.a === x && v.b === y) || (v.a === y && v.b === x))) continue;
    out.push(v.winner === "tie" ? 0.5 : v.winner === x ? 1 : 0);
  }
  return out;
}

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
    for (const v of verdictValues(j, a, b)) {
      if (v === 0.5) ties += 1;
      else if (v === 1) wins += 1;
      else losses += 1;
    }
  }
  const n = wins + losses + ties;
  return { pair: [a, b], wins, losses, ties, rate: n > 0 ? (wins + ties / 2) / n : null, n };
}

export interface QualityContrast {
  x: RouteId;
  y: RouteId;
  /** Mean overall score (1–10) of x and of y over samples where both were scored. */
  mean_x: number | null;
  mean_y: number | null;
  /** Per-sample score difference x − y: mean with cluster-bootstrap CI. */
  diff: Interval;
  /** Distribution of the per-sample difference. */
  diff_p10: number | null;
  diff_median: number | null;
  diff_p90: number | null;
  /** x's pairwise win rate over y (ties = ½), with cluster-bootstrap CI. */
  win: WinRate;
  win_rate: Interval;
  per_prompt: Array<{
    prompt_id: string;
    samples: number;
    mean_x: number | null;
    mean_y: number | null;
    wins: number;
    losses: number;
    ties: number;
  }>;
}

export function qualityContrast(
  judgments: readonly Judgment[],
  x: RouteId,
  y: RouteId,
): QualityContrast {
  const groups = byPrompt(judgments, (j) => j.prompt_id);
  const diffClusters: number[][] = [];
  const winClusters: number[][] = [];
  const xs: number[] = [];
  const ys: number[] = [];
  const perPrompt: QualityContrast["per_prompt"] = [];
  for (const [prompt_id, js] of groups) {
    const d: number[] = [];
    const w: number[] = [];
    const px: number[] = [];
    const py: number[] = [];
    for (const j of js) {
      const sx = j.scores[x];
      const sy = j.scores[y];
      if (sx && sy) {
        px.push(overallScore(sx));
        py.push(overallScore(sy));
        d.push(overallScore(sx) - overallScore(sy));
      }
      w.push(...verdictValues(j, x, y));
    }
    if (d.length === 0 && w.length === 0) continue;
    diffClusters.push(d);
    winClusters.push(w);
    xs.push(...px);
    ys.push(...py);
    perPrompt.push({
      prompt_id,
      samples: Math.max(d.length, js.filter((j) => verdictValues(j, x, y).length > 0).length),
      mean_x: mean(px),
      mean_y: mean(py),
      wins: w.filter((v) => v === 1).length,
      losses: w.filter((v) => v === 0).length,
      ties: w.filter((v) => v === 0.5).length,
    });
  }
  const allDiffs = diffClusters.flat();
  const seed = hashSeed(`${x}|${y}`);
  return {
    x,
    y,
    mean_x: mean(xs),
    mean_y: mean(ys),
    diff: bootstrapCI(diffClusters, mean, seed),
    diff_p10: percentile(allDiffs, 10),
    diff_median: median(allDiffs),
    diff_p90: percentile(allDiffs, 90),
    win: winRate(judgments, x, y),
    win_rate: bootstrapCI(winClusters, mean, seed ^ 0x5bd1e995),
    per_prompt: perPrompt,
  };
}

// === Latency ===

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

export interface LatencyDelta {
  x: RouteId;
  y: RouteId;
  /** Per-sample x − y (same prompt, same repetition), ms. */
  ttft: { median: Interval; p90: number | null };
  total: { median: Interval; p90: number | null };
}

/** Paired latency deltas over every sample both routes completed (all prompts). */
export function latencyDelta(run: RunFile, x: RouteId, y: RouteId): LatencyDelta {
  const ttft = new Map<string, number[]>();
  const total = new Map<string, number[]>();
  const push = (m: Map<string, number[]>, k: string, v: number) => {
    const arr = m.get(k);
    if (arr) arr.push(v);
    else m.set(k, [v]);
  };
  for (const r of run.runs) {
    const a = r.results[x];
    const b = r.results[y];
    if (!a || !b || a.error || b.error) continue;
    push(total, r.prompt_id, a.total_ms - b.total_ms);
    if (a.ttft_ms !== null && b.ttft_ms !== null) push(ttft, r.prompt_id, a.ttft_ms - b.ttft_ms);
  }
  const seed = hashSeed(`latency:${x}|${y}`);
  return {
    x,
    y,
    ttft: {
      median: bootstrapCI([...ttft.values()], median, seed),
      p90: percentile([...ttft.values()].flat(), 90),
    },
    total: {
      median: bootstrapCI([...total.values()], median, seed + 1),
      p90: percentile([...total.values()].flat(), 90),
    },
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
  const cols = Object.fromEntries(keys.map((k) => [k, [] as number[]])) as Record<
    (typeof keys)[number],
    number[]
  >;
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

/** Output length num/den: aggregate (Σ num tokens / Σ den tokens) and median per-sample ratio. */
export function outputLengthRatio(
  run: RunFile,
  num: RouteId,
  den: RouteId,
): { aggregate: number | null; median_per_sample: number | null; n: number } {
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
    median_per_sample: median(ratios),
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
    if (r.repetition !== 0) continue; // one row per prompt
    const a = r.results.A as RouteAResult | undefined;
    const m = a?.motebit;
    if (!m || m.history_messages === 0) continue;
    out.prompts_with_history += 1;
    out.messages_total += m.history_messages;
    out.messages_retained += m.history_retained;
    out.tokens_total_est += m.history_tokens_est;
    out.tokens_retained_est += m.history_tokens_retained_est;
    if (m.history_retained < m.history_messages) out.trimmed_prompts.push(r.prompt_id);
  }
  return out;
}

export function replayDivergence(run: RunFile): {
  replayed: number;
  diverged: Array<{ prompt_id: string; repetition: number; round: number }>;
} {
  const diverged: Array<{ prompt_id: string; repetition: number; round: number }> = [];
  let replayed = 0;
  for (const r of run.runs) {
    const bp = r.results.Bp as DirectRouteResult | undefined;
    if (!bp) continue;
    replayed += 1;
    if (bp.diverged_at_round !== undefined) {
      diverged.push({
        prompt_id: r.prompt_id,
        repetition: r.repetition,
        round: bp.diverged_at_round,
      });
    }
  }
  return { replayed, diverged };
}

// === Interaction (2×2: system prompt × trimming) ===

export interface InteractionCheck {
  /** Whether the four cells (B′, B″, B′ᶠ, B) were ever judged together. */
  tested: boolean;
  /**
   * (B′ − B″) − (B′ᶠ − B): how much the system-prompt effect under trimming
   * differs from the system-prompt effect on the full conversation.
   */
  interaction: Interval;
  system_effect_trimmed: Interval;
  system_effect_full: Interval;
  /** Separability supported: interaction CI spans 0 with at least MIN samples. */
  separable: boolean;
  /** Present only when separable AND the A ↔ B gap is distinguishable from 0. */
  attribution: {
    gap: Interval;
    runtime: number;
    system_prompt: number;
    trimming: number;
  } | null;
}

/** Below this many 2×2 samples the check is too weak to license summing. */
export const MIN_INTERACTION_SAMPLES = 6;

export function interactionCheck(judgments: readonly Judgment[]): InteractionCheck {
  const groups = byPrompt(judgments, (j) => j.prompt_id);
  const inter: number[][] = [];
  const sysT: number[][] = [];
  const sysF: number[][] = [];
  const gap: number[][] = [];
  const comps: Array<[number, number, number]> = [];
  for (const js of groups.values()) {
    const ci: number[] = [];
    const st: number[] = [];
    const sf: number[] = [];
    const g: number[] = [];
    for (const j of js) {
      const s = (r: RouteId) => (j.scores[r] ? overallScore(j.scores[r]!) : null);
      const [bp, bpp, bpf, b, a] = [s("Bp"), s("Bpp"), s("Bpf"), s("B"), s("A")];
      if (bp !== null && bpp !== null && bpf !== null && b !== null) {
        st.push(bp - bpp);
        sf.push(bpf - b);
        ci.push(bp - bpp - (bpf - b));
      }
      if (a !== null && bp !== null && bpp !== null && b !== null) {
        g.push(a - b);
        comps.push([a - bp, bp - bpp, bpp - b]);
      }
    }
    inter.push(ci);
    sysT.push(st);
    sysF.push(sf);
    gap.push(g);
  }
  const seed = hashSeed("interaction");
  const interaction = bootstrapCI(inter, mean, seed);
  const tested = interaction.n > 0;
  const separable = tested && interaction.n >= MIN_INTERACTION_SAMPLES && containsZero(interaction);
  let attribution: InteractionCheck["attribution"] = null;
  if (separable) {
    const gapCI = bootstrapCI(gap, mean, seed + 7);
    if (gapCI.estimate !== null && gapCI.estimate !== 0 && !containsZero(gapCI)) {
      const m = (k: 0 | 1 | 2) => mean(comps.map((c) => c[k]))!;
      attribution = {
        gap: gapCI,
        runtime: m(0) / gapCI.estimate,
        system_prompt: m(1) / gapCI.estimate,
        trimming: m(2) / gapCI.estimate,
      };
    }
  }
  return {
    tested,
    interaction,
    system_effect_trimmed: bootstrapCI(sysT, mean, seed + 1),
    system_effect_full: bootstrapCI(sysF, mean, seed + 2),
    separable,
    attribution,
  };
}

// === Report ===

export interface PairwiseSection {
  key: "runtime" | "system_prompt" | "trimming" | "user_gap";
  title: string;
  x: RouteId;
  y: RouteId;
  quality: QualityContrast;
  output_ratio: ReturnType<typeof outputLengthRatio>;
  latency: LatencyDelta;
}

export interface Report {
  provider: string;
  model: string;
  judge_provider: string | null;
  judge_model: string | null;
  routes: RouteId[];
  prompts: number;
  quality_subset: string[];
  repetitions: number;
  latency: LatencyStats[];
  overhead: OverheadBreakdown;
  replay: ReturnType<typeof replayDivergence>;
  context: ContextRetention;
  sections: PairwiseSection[];
  interaction: InteractionCheck;
  errors: Array<{ prompt_id: string; repetition: number; route: RouteId; error: string }>;
  spend_usd: number;
}

const PAIRS: ReadonlyArray<[PairwiseSection["key"], string, RouteId, RouteId]> = [
  ["runtime", "Runtime / pipeline effect (A ↔ B′)", "A", "Bp"],
  ["system_prompt", "System-prompt effect (B′ ↔ B″)", "Bp", "Bpp"],
  ["trimming", "Context-trimming effect (B″ ↔ B)", "Bpp", "B"],
  ["user_gap", "User gap (A ↔ C)", "A", "C"],
];

export function buildReport(run: RunFile, judged: JudgeFile | null): Report {
  const judgments = (judged?.judgments ?? []).filter((j) => !j.error);
  const routes = [...run.routes];
  if (judgments.some((j) => j.scores.C) && !routes.includes("C")) routes.push("C");
  const errors: Report["errors"] = [];
  for (const r of run.runs) {
    for (const [route, res] of Object.entries(r.results)) {
      if (res?.error) {
        errors.push({
          prompt_id: r.prompt_id,
          repetition: r.repetition,
          route: route as RouteId,
          error: res.error,
        });
      }
    }
  }
  return {
    provider: run.provider,
    model: run.model,
    judge_provider: judged?.judge_provider ?? null,
    judge_model: judged?.judge_model ?? null,
    routes,
    prompts: new Set(run.runs.map((r) => r.prompt_id)).size,
    quality_subset: [...run.quality_subset],
    repetitions: run.repetitions,
    latency: routes.filter((r) => r !== "C").map((r) => latencyStats(run, r)),
    overhead: overheadBreakdown(run),
    replay: replayDivergence(run),
    context: contextRetention(run),
    sections: PAIRS.map(([key, title, x, y]) => ({
      key,
      title,
      x,
      y,
      quality: qualityContrast(judgments, x, y),
      output_ratio: outputLengthRatio(run, x, y),
      latency: latencyDelta(run, x, y),
    })),
    interaction: interactionCheck(judgments),
    errors,
    spend_usd: run.spend_usd + (judged?.spend_usd ?? 0),
  };
}

// === Markdown ===

const D = (r: RouteId) => ROUTE_DISPLAY[r];
const ms = (v: number | null): string => (v === null ? "—" : `${Math.round(v)} ms`);
const pct = (v: number | null): string => (v === null ? "—" : `${(v * 100).toFixed(0)}%`);
const num = (v: number | null, d = 2): string => (v === null ? "—" : v.toFixed(d));
const signed = (v: number | null, d = 2): string =>
  v === null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}`;
const signedMs = (v: number | null): string =>
  v === null ? "—" : `${v >= 0 ? "+" : ""}${Math.round(v)} ms`;
const ci = (i: Interval, f: (v: number | null) => string): string =>
  i.lo === null ? `${f(i.estimate)} [CI —]` : `${f(i.estimate)} [95% CI ${f(i.lo)}, ${f(i.hi)}]`;

function qualityMarkdown(q: QualityContrast): string[] {
  if (q.diff.n === 0 && q.win.n === 0) {
    return [`_Quality not measured — no judgment scored ${D(q.x)} with ${D(q.y)}._`, ""];
  }
  return [
    `Quality (${q.diff.n} judged samples over ${q.diff.clusters} prompts): mean score ` +
      `${D(q.x)} ${num(q.mean_x)} vs ${D(q.y)} ${num(q.mean_y)}; difference ${D(q.x)} − ${D(q.y)} ` +
      `**${ci(q.diff, (v) => signed(v))}**; per-sample difference p10 / median / p90 ` +
      `${signed(q.diff_p10)} / ${signed(q.diff_median)} / ${signed(q.diff_p90)}.`,
    "",
    `${D(q.x)} win rate over ${D(q.y)}: **${ci(q.win_rate, pct)}** ` +
      `(${q.win.wins} W / ${q.win.losses} L / ${q.win.ties} T over ${q.win.n} verdicts).`,
    "",
    `| prompt | samples | ${D(q.x)} mean | ${D(q.y)} mean | W / L / T |`,
    "|---|---|---|---|---|",
    ...q.per_prompt.map(
      (p) =>
        `| \`${p.prompt_id}\` | ${p.samples} | ${num(p.mean_x)} | ${num(p.mean_y)} | ${p.wins} / ${p.losses} / ${p.ties} |`,
    ),
    "",
  ];
}

function ratioLine(s: PairwiseSection): string {
  return (
    `Output tokens ${D(s.x)}/${D(s.y)}: aggregate ${num(s.output_ratio.aggregate)}×, ` +
    `median per sample ${num(s.output_ratio.median_per_sample)}× (n=${s.output_ratio.n}).`
  );
}

function sectionMarkdown(r: Report, s: PairwiseSection): string[] {
  const out = [`## ${s.title}`, ""];
  if (s.key === "runtime") {
    out.push(
      "B′ sends the provider requests A's adapter actually sent, byte for byte, so A ↔ B′ differs only by the runtime: " +
        "memory, events, context assembly, tool execution and the loop. The quality gap here should be noise.",
      "",
      `Paired latency A − B′ (all prompts, n=${s.latency.total.median.n}): ` +
        `TTFT median **${ci(s.latency.ttft.median, signedMs)}**, p90 ${signedMs(s.latency.ttft.p90)}; ` +
        `total median **${ci(s.latency.total.median, signedMs)}**, p90 ${signedMs(s.latency.total.p90)}.`,
      "",
      "Motebit pre-model overhead (route A, median of `TurnLatency`):",
      "",
      "| stage | median |",
      "|---|---|",
      `| context pipeline (total pre-model) | ${ms(r.overhead.context_pipeline_ms)} |`,
      `| event query | ${ms(r.overhead.event_query_ms)} |`,
      `| embed | ${ms(r.overhead.embed_ms)} |`,
      `| pinned memories | ${ms(r.overhead.pinned_ms)} |`,
      `| memory retrieve | ${ms(r.overhead.memory_retrieve_ms)} |`,
      `| provider TTFT (first call → first text) | ${ms(r.overhead.provider_ttft_ms)} |`,
      "",
      `Sampled turns: ${r.overhead.n}. B′ replays: ${r.replay.replayed}; trajectory diverged from A's ` +
        `(replay stopped) on ${r.replay.diverged.length}` +
        (r.replay.diverged.length > 0
          ? `: ${r.replay.diverged.map((d) => `\`${d.prompt_id}\`#${d.repetition} @ round ${d.round}`).join(", ")}.`
          : "."),
      "",
    );
  } else if (s.key === "system_prompt") {
    out.push(
      "Same trimmed messages, same parameters and tools; only the system prompt differs " +
        "(motebit's, including any memory it carries, vs. a neutral one-liner).",
      "",
      ratioLine(s),
      "",
    );
  } else if (s.key === "trimming") {
    out.push(
      "Same neutral system prompt, parameters and tools; only the conversation differs " +
        "(motebit's trimmed messages vs. the full untrimmed history).",
      "",
      ratioLine(s),
      "",
      `History retained by route A: ${r.context.messages_retained}/${r.context.messages_total} messages, ` +
        `~${r.context.tokens_retained_est}/${r.context.tokens_total_est} tokens (est.) across ` +
        `${r.context.prompts_with_history} multi-turn prompt(s).` +
        (r.context.trimmed_prompts.length > 0
          ? ` Trimmed: ${r.context.trimmed_prompts.map((p) => `\`${p}\``).join(", ")}.`
          : " Nothing was trimmed, so this contrast is expected to be noise."),
      "",
    );
  } else {
    out.push(
      "C is the vendor's own product (claude.ai / ChatGPT …), collected manually: what a user feels switching between them.",
      "",
    );
  }
  out.push(...qualityMarkdown(s.quality));
  return out;
}

function interactionMarkdown(r: Report): string[] {
  const i = r.interaction;
  const out = ["## Separability (2×2: system prompt × trimming)", ""];
  if (!i.tested) {
    out.push(
      "_Not tested_ — route B′ᶠ (motebit system prompt + full conversation) was not run, so the 2×2 is " +
        "incomplete. The pairwise effects above are reported separately and **must not be summed** into " +
        "an attribution of A ↔ B. Add `Bpf` to `--routes` to run the check on the quality subset.",
      "",
    );
    return out;
  }
  out.push(
    `System-prompt effect with trimming (B′ − B″): ${ci(i.system_effect_trimmed, (v) => signed(v))}; ` +
      `on the full conversation (B′ᶠ − B): ${ci(i.system_effect_full, (v) => signed(v))}.`,
    "",
    `Interaction (difference of the two): **${ci(i.interaction, (v) => signed(v))}** over ${i.interaction.n} samples.`,
    "",
  );
  if (!i.separable) {
    out.push(
      i.interaction.n < MIN_INTERACTION_SAMPLES
        ? `Too few samples (< ${MIN_INTERACTION_SAMPLES}) to support separability. `
        : "The interaction CI excludes 0: the system prompt's effect depends on whether the conversation was trimmed. ",
      "The effects are therefore stated pairwise only; **no additive attribution**.",
      "",
    );
  } else if (i.attribution === null) {
    out.push(
      "The interaction CI spans 0 (consistent with separability), but the A ↔ B score gap is indistinguishable " +
        "from 0, so there is nothing to attribute.",
      "",
    );
  } else {
    const a = i.attribution;
    out.push(
      "The interaction CI spans 0 (consistent with separability), so the A ↔ B score gap " +
        `(${ci(a.gap, (v) => signed(v))}) is attributed along the chain A → B′ → B″ → B:`,
      "",
      "| component | share of A − B |",
      "|---|---|",
      `| runtime (A − B′) | ${pct(a.runtime)} |`,
      `| system prompt (B′ − B″) | ${pct(a.system_prompt)} |`,
      `| context trimming (B″ − B) | ${pct(a.trimming)} |`,
      "",
    );
  }
  return out;
}

export function renderMarkdown(r: Report): string {
  const lines: string[] = [
    "# Intelligence-parity bench",
    "",
    `Provider \`${r.provider}\`, model under test \`${r.model}\` · judge: ` +
      (r.judge_model ? `\`${r.judge_provider}\` / \`${r.judge_model}\`` : "not run") +
      ` · ${r.prompts} prompts (latency) · quality subset ${r.quality_subset.length} prompt(s) × ` +
      `${r.repetitions} sample(s) · spend $${r.spend_usd.toFixed(4)}`,
    "",
    "Routes: " + r.routes.map((x) => `**${D(x)}** = ${ROUTE_LABELS[x]}`).join("; ") + ".",
    "",
    "Every direct route is derived from A's captured request (B′ replays its bytes; B″, B′ᶠ and B keep its " +
      "parameters and tools), so each contrast below differs in one ingredient. Effects are pairwise; " +
      "they are summed only if the separability check at the end supports it.",
    "",
    "## Latency (all prompts)",
    "",
    "| route | n | TTFT median | TTFT p90 | total median | total p90 |",
    "|---|---|---|---|---|---|",
    ...r.latency.map(
      (l) =>
        `| ${D(l.route)} | ${l.n} | ${ms(l.ttft_median)} | ${ms(l.ttft_p90)} | ${ms(l.total_median)} | ${ms(l.total_p90)} |`,
    ),
    "",
  ];
  for (const s of r.sections) lines.push(...sectionMarkdown(r, s));
  lines.push(...interactionMarkdown(r));
  if (r.errors.length > 0) {
    lines.push(
      "## Errors",
      "",
      "Errored answers are excluded from latency stats; they are judged as whatever text they produced.",
      "",
      ...r.errors.map(
        (e) =>
          `- \`${e.prompt_id}\`#${e.repetition} route ${D(e.route)}: ${e.error.replace(/\s+/g, " ").slice(0, 200)}`,
      ),
      "",
    );
  }
  lines.push(
    "## Aperture",
    "",
    "- Latency uses every prompt; quality uses the designated quality subset only, each prompt sampled `repetitions` times and judged per sample.",
    "- CIs are 95% cluster-bootstrap intervals (prompts resampled with their samples kept together), seeded for reproducibility.",
    "- Tools offered on route A are the deterministic CLI builtins (`current_time`, `recall_memories`, `recall_self`); web tools are excluded for repeatability.",
    "- B′ replays A's own later rounds (with A's tool results); B, B″ and B′ᶠ answer tool calls by replaying A's recorded result for an identical call, refusing and counting anything else.",
    "- Routes without motebit's system prompt have no memory: memory-category prompts measure what motebit's memory is worth, not a tax.",
    "- Token estimates for history use the runtime's own ~4 chars/token estimator.",
    "",
  );
  return lines.join("\n");
}
