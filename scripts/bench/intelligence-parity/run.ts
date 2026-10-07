#!/usr/bin/env tsx
/**
 * intelligence-parity — does routing a turn through motebit make the SAME
 * model slower or worse than calling the provider directly?
 *
 * A MEASUREMENT TOOL. It changes no prompt, no context-window policy, no
 * routing and no model default anywhere in the product; it runs the product
 * as shipped and reports what it saw. Routes:
 *
 *   A    motebit runtime turn (route-motebit.ts)
 *   B′   A's captured provider requests replayed byte for byte (runtime effect)
 *   B″   neutral system prompt + A's trimmed messages + A's params/tools (system-prompt effect vs B′)
 *   B    neutral system prompt + full untrimmed conversation + A's params/tools (trimming effect vs B″)
 *   B′ᶠ  optional 2×2 cell: A's system prompt + full conversation (separability check)
 *   C    vendor product answers collected by hand (route-c.example.json format)
 *
 * Costs real tokens on a real key: manual dispatch only
 * (.github/workflows/intelligence-parity-bench.yml), never in `pnpm check`.
 * A missing provider key is a hard error naming the secret, never a silent skip.
 *
 * Usage:
 *   npx tsx scripts/bench/intelligence-parity/run.ts estimate [opts]
 *   npx tsx scripts/bench/intelligence-parity/run.ts all [opts]        # estimate → run → judge → report
 *   npx tsx scripts/bench/intelligence-parity/run.ts run|judge|report [opts]
 *
 * Options:
 *   --provider=<p>          anthropic (default) | openai | google | groq | deepseek
 *   --model=<id>            model under test (default: the resolver's default for the provider)
 *   --judge-provider=<p>    judge provider (default anthropic)
 *   --judge-model=<id>      judge (default claude-opus-5-5 on anthropic; must differ from --model)
 *   --subset=<list>         comma list of prompt ids and/or categories (blank = all)
 *   --quality-subset=<list> prompts repeated + judged (default: 6 designated prompts; "all" = every selected prompt)
 *   --repetitions=<n>       samples per quality-subset prompt (default 3); other prompts run once (latency)
 *   --routes=<list>         live routes (default A,B,Bp,Bpp; add Bpf for the 2×2 separability check)
 *   --max-usd=<n>           spend ceiling for the whole invocation (default 5)
 *   --prices=<list>         <model>=<in>:<out>[:<cache_read>] USD/MTok for models not in spend.ts
 *   --route-c=<file>        manually collected vendor answers to judge alongside
 *   --out=<dir>             output directory (default bench-out/intelligence-parity)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { installWireTap } from "./wire-tap.js";
import { runMotebitRoute } from "./route-motebit.js";
import { runDirectRoute, runReplayRoute } from "./route-direct.js";
import {
  buildRouteBRequest,
  buildRouteBpfRequest,
  buildRouteBppRequest,
  freezeParams,
} from "./params.js";
import {
  canonicalBaseUrl,
  defaultModelFor,
  indexToolResults,
  parseProvider,
  protocolOf,
  requireProviderKey,
} from "./protocol.js";
import { judgePrompt, judgeTransport, loadRubric, type JudgeTransport } from "./judge.js";
import { buildReport, renderMarkdown } from "./report.js";
import {
  assertEstimateWithinBudget,
  estimateRun,
  parsePrices,
  priceFor,
  SpendLimitExceeded,
  SpendMeter,
  type PriceOverrides,
} from "./spend.js";
import type {
  BenchPrompt,
  BenchProvider,
  DirectRouteResult,
  JudgeFile,
  PromptRun,
  PromptSet,
  RouteAResult,
  RouteCFile,
  RouteId,
  RunFile,
} from "./types.js";
import { PROMPT_CATEGORIES, ROUTE_DISPLAY } from "./types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROMPTS_PATH = path.join(HERE, "prompts.json");
export const DEFAULT_JUDGE_MODEL = "claude-opus-5-5";
export const LIVE_ROUTES: readonly RouteId[] = ["A", "B", "Bp", "Bpp", "Bpf"];
export const DEFAULT_ROUTES: readonly RouteId[] = ["A", "B", "Bp", "Bpp"];
export const DEFAULT_REPETITIONS = 3;
/**
 * The designated quality subset: one prompt per behaviour the contrasts can
 * move — a short fact, an explanation, code, writing, a long trimmed
 * conversation (trimming effect) and a memory prompt (system-prompt effect).
 */
export const DEFAULT_QUALITY_SUBSET: readonly string[] = [
  "fact-tcp-handshake",
  "explain-cap-theorem",
  "code-lru-cache",
  "write-decline-email",
  "longctx-turn1-recall",
  "mem-dietary",
];

export interface CliOptions {
  command: "estimate" | "run" | "judge" | "report" | "all";
  provider: BenchProvider;
  model: string;
  judgeProvider: BenchProvider;
  judgeModel: string;
  subset: string[];
  /** Explicit quality subset, "all", or null for the designated default. */
  qualitySubset: string[] | "all" | null;
  routes: RouteId[];
  repetitions: number;
  maxUsd: number;
  prices: PriceOverrides;
  routeC: string | null;
  out: string;
  baseUrl: string;
  judgeBaseUrl: string;
}

const list = (v: string | undefined): string[] =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

export function parseArgs(argv: readonly string[]): CliOptions {
  const get = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit === undefined ? undefined : hit.slice(name.length + 3);
  };
  const command = (argv.find((a) => !a.startsWith("--")) ?? "all") as CliOptions["command"];
  if (!["estimate", "run", "judge", "report", "all"].includes(command)) {
    throw new Error(`Unknown command "${command}". Use estimate | run | judge | report | all.`);
  }
  const provider = parseProvider(get("provider"), "--provider");
  const judgeProvider = parseProvider(get("judge-provider"), "--judge-provider");
  const routes = (
    list(get("routes")).length > 0 ? list(get("routes")) : DEFAULT_ROUTES
  ) as RouteId[];
  const badRoute = routes.find((r) => !LIVE_ROUTES.includes(r));
  if (badRoute) {
    throw new Error(
      `Unknown live route "${badRoute}". Live routes: ${LIVE_ROUTES.join(", ")} (C is ingested via --route-c).`,
    );
  }
  if (routes.some((r) => r !== "A") && !routes.includes("A")) {
    // Every direct route is DERIVED from A's captured request — without A there is nothing to derive.
    throw new Error(
      "Routes B, Bp, Bpp and Bpf are derived from A's captured request, so --routes must include A.",
    );
  }
  const repetitions = Number(get("repetitions") || String(DEFAULT_REPETITIONS));
  if (!Number.isInteger(repetitions) || repetitions < 1)
    throw new Error("--repetitions must be a positive integer");
  const maxUsd = Number(get("max-usd") || "5");
  if (!(maxUsd > 0)) throw new Error("--max-usd must be > 0");
  const model = get("model") || defaultModelFor(provider);
  const judgeModel =
    get("judge-model") ||
    (judgeProvider === "anthropic" ? DEFAULT_JUDGE_MODEL : defaultModelFor(judgeProvider));
  if (judgeModel === model) {
    throw new Error(
      `--judge-model equals --model (${model}). A model grading its own answers is the self-preference ` +
        `bias the blind judge exists to avoid — pick a different judge.`,
    );
  }
  const q = list(get("quality-subset"));
  return {
    command,
    provider,
    model,
    judgeProvider,
    judgeModel,
    subset: list(get("subset")).filter((s) => s !== "all"),
    qualitySubset: q.includes("all") ? "all" : q.length > 0 ? q : null,
    routes,
    repetitions,
    maxUsd,
    prices: parsePrices(get("prices")),
    routeC: get("route-c") || null,
    out: get("out") || path.join("bench-out", "intelligence-parity"),
    baseUrl: get("base-url") || canonicalBaseUrl(provider),
    judgeBaseUrl: get("judge-base-url") || canonicalBaseUrl(judgeProvider),
  };
}

export function loadPrompts(file = PROMPTS_PATH): BenchPrompt[] {
  const set = JSON.parse(fs.readFileSync(file, "utf8")) as PromptSet;
  const ids = new Set<string>();
  for (const p of set.prompts) {
    if (ids.has(p.id)) throw new Error(`duplicate prompt id ${p.id}`);
    ids.add(p.id);
    if (!(PROMPT_CATEGORIES as readonly string[]).includes(p.category)) {
      throw new Error(`prompt ${p.id}: unknown category ${p.category}`);
    }
    (p.history ?? []).forEach((m, i) => {
      if (m.role !== (i % 2 === 0 ? "user" : "assistant")) {
        throw new Error(
          `prompt ${p.id}: history must alternate user/assistant starting with user (index ${i})`,
        );
      }
    });
  }
  return set.prompts;
}

export function selectPrompts(
  all: readonly BenchPrompt[],
  subset: readonly string[],
): BenchPrompt[] {
  if (subset.length === 0) return [...all];
  const picked = all.filter((p) => subset.includes(p.id) || subset.includes(p.category));
  const unknown = subset.filter((s) => !all.some((p) => p.id === s || p.category === s));
  if (unknown.length > 0) {
    // A typo would otherwise shrink the run silently — "green because it isn't looking".
    throw new Error(`--subset names nothing: ${unknown.join(", ")}`);
  }
  return picked;
}

/**
 * The quality subset among the selected prompts. An explicitly named prompt
 * that is not selected is an error (a typo would otherwise shrink the subset
 * silently); the designated default is intersected with the selection.
 */
export function selectQuality(
  selected: readonly BenchPrompt[],
  qualitySubset: CliOptions["qualitySubset"],
): string[] {
  if (qualitySubset === "all") return selected.map((p) => p.id);
  if (qualitySubset === null) {
    return DEFAULT_QUALITY_SUBSET.filter((id) => selected.some((p) => p.id === id));
  }
  const missing = qualitySubset.filter(
    (s) => !selected.some((p) => p.id === s || p.category === s),
  );
  if (missing.length > 0) {
    throw new Error(
      `--quality-subset names prompts that are not selected: ${missing.join(", ")}\n` +
        `  → Quality prompts must also be in --subset (or leave --subset blank).`,
    );
  }
  return selected
    .filter((p) => qualitySubset.includes(p.id) || qualitySubset.includes(p.category))
    .map((p) => p.id);
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

export async function runRoutes(
  opts: CliOptions,
  prompts: readonly BenchPrompt[],
  apiKey: string,
  meter: SpendMeter,
  log: (s: string) => void = console.log,
  qualityIds: ReadonlySet<string> = new Set(selectQuality(prompts, opts.qualitySubset)),
): Promise<RunFile> {
  const tap = installWireTap();
  const protocol = protocolOf(opts.provider);
  const runFile: RunFile = {
    bench: "intelligence-parity",
    version: 2,
    started_at: new Date().toISOString(),
    provider: opts.provider,
    model: opts.model,
    routes: opts.routes,
    repetitions: opts.repetitions,
    quality_subset: prompts.filter((p) => qualityIds.has(p.id)).map((p) => p.id),
    runs: [],
    spend_usd: 0,
  };
  // The meter is charged from the WIRE, not from route results: every model
  // exchange observed — in-turn rounds, auxiliary passes and any post-turn
  // call the runtime makes after the answer — priced at the model that
  // exchange actually named.
  let charged = 0;
  const chargeObserved = async () => {
    await tap.settled();
    for (; charged < tap.exchanges.length; charged++) {
      const ex = tap.exchanges[charged]!;
      meter.charge(String(ex.request_body["model"] ?? opts.model), ex.usage);
    }
    runFile.spend_usd = meter.spentUsd;
  };
  const line = (
    id: string,
    rep: number,
    route: RouteId,
    r: { error?: string; total_ms: number; usage: { output_tokens: number } },
  ) =>
    log(
      `  ${id}#${rep} ${ROUTE_DISPLAY[route].padEnd(3)} ${r.error ? `ERROR ${r.error}` : `${Math.round(r.total_ms)} ms, ${r.usage.output_tokens} out`}`,
    );
  try {
    for (const prompt of prompts) {
      const quality = qualityIds.has(prompt.id);
      const samples = quality ? opts.repetitions : 1;
      for (let rep = 0; rep < samples; rep++) {
        const run: PromptRun = {
          prompt_id: prompt.id,
          category: prompt.category,
          repetition: rep,
          quality,
          results: {},
        };
        runFile.runs.push(run);

        meter.check();
        const a: RouteAResult = await runMotebitRoute(prompt, rep, {
          provider: opts.provider,
          apiKey,
          model: opts.model,
          baseUrl: opts.baseUrl,
          tap,
        });
        run.results.A = a;
        await chargeObserved();
        line(prompt.id, rep, "A", a);
        const round1 = a.requests[0];
        if (!round1) {
          log(
            `  ${prompt.id}#${rep} — route A sent no request; direct routes skipped (nothing to derive)`,
          );
          continue;
        }
        const frozen = freezeParams(round1, protocol);
        const toolResults = indexToolResults(a.requests);
        const history = prompt.history ?? [];
        const common = { prompt_id: prompt.id, repetition: rep, apiKey, tap };
        const direct = async (
          route: "B" | "Bpp" | "Bpf",
          body: Record<string, unknown>,
        ): Promise<DirectRouteResult> =>
          runDirectRoute({
            ...common,
            route,
            protocol,
            baseUrl: opts.baseUrl,
            body,
            params: frozen,
            toolResults,
          });

        for (const route of opts.routes) {
          if (route === "A" || route === "C") continue;
          // The interaction cell is only needed where quality is judged.
          if (route === "Bpf" && !quality) continue;
          meter.check();
          let res: DirectRouteResult;
          if (route === "Bp") {
            res = await runReplayRoute({
              ...common,
              captured: a.captured,
              aStoppedForTools: a.rounds_stopped_for_tools,
              params: frozen,
            });
          } else if (route === "Bpp") {
            res = await direct("Bpp", buildRouteBppRequest(round1, protocol));
          } else if (route === "Bpf") {
            res = await direct("Bpf", buildRouteBpfRequest(round1, history, protocol));
          } else {
            res = await direct("B", buildRouteBRequest(frozen, history, prompt.prompt, protocol));
          }
          run.results[route] = res;
          await chargeObserved();
          line(prompt.id, rep, route, res);
        }
      }
    }
  } catch (err) {
    if (!(err instanceof SpendLimitExceeded)) throw err;
    log(err.message);
  } finally {
    await chargeObserved();
    tap.restore();
  }
  return runFile;
}

export function loadRouteC(file: string): RouteCFile {
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as RouteCFile;
  if (data.bench !== "intelligence-parity/route-c" || !Array.isArray(data.entries)) {
    throw new Error(
      `${file} is not a route-C file (see scripts/bench/intelligence-parity/route-c.example.json)`,
    );
  }
  for (const e of data.entries) {
    if (!e.prompt_id || typeof e.answer !== "string" || !e.source || !e.collected_at) {
      throw new Error(`${file}: every entry needs prompt_id, answer, source, collected_at`);
    }
  }
  return data;
}

export async function judgeRun(
  run: RunFile,
  prompts: readonly BenchPrompt[],
  judge: { provider: BenchProvider; model: string; prices?: PriceOverrides },
  transport: JudgeTransport,
  meter: SpendMeter,
  routeC: RouteCFile | null,
  rubric: string = loadRubric(),
): Promise<JudgeFile> {
  const out: JudgeFile = {
    bench: "intelligence-parity/judgments",
    version: 2,
    judge_provider: judge.provider,
    judge_model: judge.model,
    judgments: [],
    spend_usd: 0,
  };
  const byId = new Map(prompts.map((p) => [p.id, p]));
  try {
    // Quality is judged on the designated subset only — every sample of it.
    for (const r of run.runs.filter((x) => x.quality)) {
      const prompt = byId.get(r.prompt_id);
      if (!prompt) continue;
      const answers: Array<{ route: RouteId; text: string }> = [];
      for (const route of ["A", "B", "Bp", "Bpp", "Bpf"] as const) {
        const res = r.results[route];
        if (res) answers.push({ route, text: res.answer });
      }
      const c = routeC?.entries.find((e) => e.prompt_id === r.prompt_id);
      if (c) answers.push({ route: "C", text: c.answer });
      if (answers.length < 2) continue;
      meter.check();
      const { judgment, usage } = await judgePrompt(
        prompt,
        r.repetition,
        answers,
        judge.model,
        transport,
        rubric,
      );
      out.spend_usd += meter.charge(judge.model, usage);
      out.judgments.push(judgment);
    }
  } catch (err) {
    if (!(err instanceof SpendLimitExceeded)) throw err;
    console.log(err.message);
  }
  return out;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const prompts = selectPrompts(loadPrompts(), opts.subset);
  const qualityIds = new Set(selectQuality(prompts, opts.qualitySubset));
  // Fail closed on an unpriced model BEFORE anything is spent.
  priceFor(opts.model, opts.prices);
  priceFor(opts.judgeModel, opts.prices);
  const runPath = path.join(opts.out, "results.json");
  const judgePath = path.join(opts.out, "judgments.json");

  if (opts.command === "estimate" || opts.command === "all" || opts.command === "run") {
    const est = estimateRun({
      prompts,
      routes: opts.routes,
      repetitions: opts.repetitions,
      qualityIds,
      model: opts.model,
      judgeModel: opts.command === "run" ? null : opts.judgeModel,
      routeC: opts.routeC !== null,
      prices: opts.prices,
    });
    const breakdown = Object.entries(est.by_route)
      .map(([k, v]) => `${k === "judge" ? "judge" : ROUTE_DISPLAY[k as RouteId]} $${v.toFixed(2)}`)
      .join(", ");
    console.log(
      `intelligence-parity — ${prompts.length} prompt(s) for latency; quality subset ${qualityIds.size} × ` +
        `${opts.repetitions} sample(s); routes ${opts.routes.join(",")}; ` +
        `${opts.provider}/${opts.model}, judge ${opts.judgeProvider}/${opts.judgeModel}\n` +
        `  estimate: $${est.usd.toFixed(2)} (${est.calls} calls: ${breakdown}) — limit $${opts.maxUsd.toFixed(2)}`,
    );
    assertEstimateWithinBudget(est, opts.maxUsd);
    if (opts.command === "estimate") return;
  }

  const meter = new SpendMeter(opts.maxUsd, opts.prices);
  let run: RunFile | null = null;
  if (opts.command === "run" || opts.command === "all") {
    const key = requireProviderKey(opts.provider);
    run = await runRoutes(opts, prompts, key, meter, console.log, qualityIds);
    writeJson(runPath, run);
    console.log(`wrote ${runPath} ($${run.spend_usd.toFixed(4)})`);
  }
  let judged: JudgeFile | null = null;
  if (opts.command === "judge" || opts.command === "all") {
    const key = requireProviderKey(opts.judgeProvider, process.env, "the judge");
    run ??= JSON.parse(fs.readFileSync(runPath, "utf8")) as RunFile;
    const routeC = opts.routeC ? loadRouteC(opts.routeC) : null;
    judged = await judgeRun(
      run,
      prompts,
      { provider: opts.judgeProvider, model: opts.judgeModel, prices: opts.prices },
      judgeTransport(opts.judgeProvider, key, opts.judgeBaseUrl),
      meter,
      routeC,
    );
    writeJson(judgePath, judged);
    console.log(`wrote ${judgePath} ($${judged.spend_usd.toFixed(4)})`);
  }
  if (opts.command === "report" || opts.command === "all" || opts.command === "judge") {
    run ??= JSON.parse(fs.readFileSync(runPath, "utf8")) as RunFile;
    if (judged === null && fs.existsSync(judgePath)) {
      judged = JSON.parse(fs.readFileSync(judgePath, "utf8")) as JudgeFile;
    }
    const report = buildReport(run, judged);
    writeJson(path.join(opts.out, "report.json"), report);
    fs.writeFileSync(path.join(opts.out, "report.md"), renderMarkdown(report));
    console.log(`wrote ${path.join(opts.out, "report.md")}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
