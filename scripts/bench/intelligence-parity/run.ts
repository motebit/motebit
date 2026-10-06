#!/usr/bin/env tsx
/**
 * intelligence-parity — does routing a turn through motebit make the SAME
 * model slower or worse than calling the provider directly?
 *
 * A MEASUREMENT TOOL. It changes no prompt, no context-window policy, no
 * routing and no model default anywhere in the product; it runs the product
 * as shipped and reports what it saw. Routes:
 *
 *   A   motebit runtime turn (route-motebit.ts)
 *   B   direct API, neutral system prompt, full untrimmed conversation, A's params
 *   B′  direct API replay of A's exact round-1 request (isolates pipeline time)
 *   C   vendor product answers collected by hand (route-c.example.json format)
 *
 * Costs real tokens on a real key: manual dispatch only
 * (.github/workflows/intelligence-parity-bench.yml), never in `pnpm check`.
 * A missing ANTHROPIC_API_KEY is a hard error, never a silent skip.
 *
 * Usage:
 *   npx tsx scripts/bench/intelligence-parity/run.ts estimate [opts]
 *   npx tsx scripts/bench/intelligence-parity/run.ts all [opts]        # estimate → run → judge → report
 *   npx tsx scripts/bench/intelligence-parity/run.ts run|judge|report [opts]
 *
 * Options:
 *   --model=<id>          model under test (default: the resolver's Anthropic default)
 *   --judge-model=<id>    judge (default claude-opus-5-5; must differ from --model)
 *   --subset=<list>       comma list of prompt ids and/or categories (blank = all)
 *   --routes=A,B,Bp       live routes (default A,B; add Bp to isolate pipeline time — ~+50% spend)
 *   --repetitions=<n>     default 1
 *   --max-usd=<n>         spend ceiling for the whole invocation (default 5)
 *   --route-c=<file>      manually collected vendor answers to judge alongside
 *   --out=<dir>           output directory (default bench-out/intelligence-parity)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANTHROPIC_CANONICAL_URL,
  DEFAULT_ANTHROPIC_MODEL,
} from "../../../packages/sdk/src/index.js";
import { installWireTap } from "./wire-tap.js";
import { runMotebitRoute } from "./route-motebit.js";
import { runDirectRoute } from "./route-direct.js";
import {
  buildRouteBRequest,
  buildRouteBpRequest,
  freezeParams,
  indexToolResults,
} from "./params.js";
import { anthropicJudgeTransport, judgePrompt, loadRubric, type JudgeTransport } from "./judge.js";
import { buildReport, renderMarkdown } from "./report.js";
import {
  assertEstimateWithinBudget,
  costUsd,
  estimateRun,
  priceFor,
  SpendLimitExceeded,
  SpendMeter,
} from "./spend.js";
import type {
  BenchPrompt,
  JudgeFile,
  PromptRun,
  PromptSet,
  RouteCFile,
  RouteId,
  RunFile,
} from "./types.js";
import { PROMPT_CATEGORIES } from "./types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROMPTS_PATH = path.join(HERE, "prompts.json");
export const DEFAULT_JUDGE_MODEL = "claude-opus-5-5";
const LIVE_ROUTES: readonly RouteId[] = ["A", "B", "Bp"];

export interface CliOptions {
  command: "estimate" | "run" | "judge" | "report" | "all";
  model: string;
  judgeModel: string;
  subset: string[];
  routes: RouteId[];
  repetitions: number;
  maxUsd: number;
  routeC: string | null;
  out: string;
  baseUrl: string;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const get = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit === undefined ? undefined : hit.slice(name.length + 3);
  };
  const command = (argv.find((a) => !a.startsWith("--")) ?? "all") as CliOptions["command"];
  if (!["estimate", "run", "judge", "report", "all"].includes(command)) {
    throw new Error(`Unknown command "${command}". Use estimate | run | judge | report | all.`);
  }
  const routes = (get("routes") ?? "A,B")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0) as RouteId[];
  const badRoute = routes.find((r) => !LIVE_ROUTES.includes(r));
  if (badRoute) {
    throw new Error(
      `Unknown live route "${badRoute}". Live routes: ${LIVE_ROUTES.join(", ")} (C is ingested via --route-c).`,
    );
  }
  if ((routes.includes("B") || routes.includes("Bp")) && !routes.includes("A")) {
    // B's parameters are COPIED from A — without A there is nothing to freeze.
    throw new Error("Routes B and B′ copy A's parameters, so --routes must include A.");
  }
  const repetitions = Number(get("repetitions") ?? "1");
  if (!Number.isInteger(repetitions) || repetitions < 1)
    throw new Error("--repetitions must be a positive integer");
  const maxUsd = Number(get("max-usd") ?? "5");
  if (!(maxUsd > 0)) throw new Error("--max-usd must be > 0");
  const model = get("model") || DEFAULT_ANTHROPIC_MODEL;
  const judgeModel = get("judge-model") || DEFAULT_JUDGE_MODEL;
  if (judgeModel === model) {
    throw new Error(
      `--judge-model equals --model (${model}). A model grading its own answers is the self-preference ` +
        `bias the blind judge exists to avoid — pick a different judge.`,
    );
  }
  return {
    command,
    model,
    judgeModel,
    subset: (get("subset") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && s !== "all"),
    routes,
    repetitions,
    maxUsd,
    routeC: get("route-c") || null,
    out: get("out") || path.join("bench-out", "intelligence-parity"),
    baseUrl: get("base-url") || ANTHROPIC_CANONICAL_URL,
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

function requireKey(): string {
  const key = process.env["ANTHROPIC_API_KEY"];
  if (key == null || key.trim().length === 0) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. The bench makes real calls; it never runs keyless.\n" +
        "  → In CI, set the repository secret ANTHROPIC_API_KEY. Locally, export it.\n" +
        "  → `estimate` needs no key.",
    );
  }
  return key;
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
): Promise<RunFile> {
  const tap = installWireTap();
  const runFile: RunFile = {
    bench: "intelligence-parity",
    version: 1,
    started_at: new Date().toISOString(),
    model: opts.model,
    routes: opts.routes,
    repetitions: opts.repetitions,
    runs: [],
    spend_usd: 0,
  };
  // The meter is charged from the WIRE, not from route results: every
  // `/v1/messages` exchange observed — in-turn rounds, auxiliary passes and any
  // post-turn call the runtime makes after the answer — priced at the model
  // that exchange actually named.
  let charged = 0;
  const chargeObserved = async () => {
    await tap.settled();
    for (; charged < tap.exchanges.length; charged++) {
      const ex = tap.exchanges[charged]!;
      meter.charge(String(ex.request_body["model"] ?? opts.model), ex.usage);
    }
    runFile.spend_usd = meter.spentUsd;
  };
  try {
    for (let rep = 0; rep < opts.repetitions; rep++) {
      for (const prompt of prompts) {
        const run: PromptRun = {
          prompt_id: prompt.id,
          category: prompt.category,
          repetition: rep,
          results: {},
        };
        runFile.runs.push(run);

        meter.check();
        const a = await runMotebitRoute(prompt, rep, {
          apiKey,
          model: opts.model,
          baseUrl: opts.baseUrl,
          tap,
        });
        run.results.A = a;
        await chargeObserved();
        log(
          `  ${prompt.id}#${rep} A  ${a.error ? `ERROR ${a.error}` : `${Math.round(a.total_ms)} ms, ${a.usage.output_tokens} out`}`,
        );
        const round1 = a.requests[0];
        if (!round1) {
          log(`  ${prompt.id}#${rep} — route A sent no request; B/B′ skipped (nothing to freeze)`);
          continue;
        }
        const frozen = freezeParams(round1);
        const toolResults = indexToolResults(a.requests);

        if (opts.routes.includes("B")) {
          meter.check();
          const b = await runDirectRoute({
            route: "B",
            prompt_id: prompt.id,
            repetition: rep,
            apiKey,
            baseUrl: opts.baseUrl,
            body: buildRouteBRequest(frozen, prompt.history ?? [], prompt.prompt),
            params: frozen,
            toolResults,
            tap,
          });
          run.results.B = b;
          await chargeObserved();
          log(
            `  ${prompt.id}#${rep} B  ${b.error ? `ERROR ${b.error}` : `${Math.round(b.total_ms)} ms, ${b.usage.output_tokens} out`}`,
          );
        }
        if (opts.routes.includes("Bp")) {
          meter.check();
          const bp = await runDirectRoute({
            route: "Bp",
            prompt_id: prompt.id,
            repetition: rep,
            apiKey,
            baseUrl: opts.baseUrl,
            body: buildRouteBpRequest(round1),
            params: frozen,
            toolResults,
            tap,
          });
          run.results.Bp = bp;
          await chargeObserved();
          log(
            `  ${prompt.id}#${rep} B′ ${bp.error ? `ERROR ${bp.error}` : `${Math.round(bp.total_ms)} ms, ${bp.usage.output_tokens} out`}`,
          );
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
  judgeModel: string,
  transport: JudgeTransport,
  meter: SpendMeter,
  routeC: RouteCFile | null,
  rubric: string = loadRubric(),
): Promise<JudgeFile> {
  const out: JudgeFile = {
    bench: "intelligence-parity/judgments",
    version: 1,
    judge_model: judgeModel,
    judgments: [],
    spend_usd: 0,
  };
  const byId = new Map(prompts.map((p) => [p.id, p]));
  try {
    for (const r of run.runs) {
      const prompt = byId.get(r.prompt_id);
      if (!prompt) continue;
      const answers: Array<{ route: RouteId; text: string }> = [];
      for (const route of ["A", "B", "Bp"] as const) {
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
        judgeModel,
        transport,
        rubric,
      );
      meter.charge(judgeModel, usage);
      out.spend_usd += costUsd(judgeModel, usage);
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
  // Fail closed on an unpriced model BEFORE anything is spent.
  priceFor(opts.model);
  priceFor(opts.judgeModel);
  const runPath = path.join(opts.out, "results.json");
  const judgePath = path.join(opts.out, "judgments.json");

  if (opts.command === "estimate" || opts.command === "all" || opts.command === "run") {
    const est = estimateRun({
      prompts,
      routes: opts.routes,
      repetitions: opts.repetitions,
      model: opts.model,
      judgeModel: opts.command === "run" ? null : opts.judgeModel,
    });
    console.log(
      `intelligence-parity — ${prompts.length} prompt(s) × ${opts.repetitions} rep(s), routes ${opts.routes.join(",")}, ` +
        `model ${opts.model}, judge ${opts.judgeModel}\n` +
        `  estimate: $${est.usd.toFixed(2)} (${est.calls} calls) — limit $${opts.maxUsd.toFixed(2)}`,
    );
    assertEstimateWithinBudget(est, opts.maxUsd);
    if (opts.command === "estimate") return;
  }

  const meter = new SpendMeter(opts.maxUsd);
  let run: RunFile | null = null;
  if (opts.command === "run" || opts.command === "all") {
    const key = requireKey();
    run = await runRoutes(opts, prompts, key, meter);
    writeJson(runPath, run);
    console.log(`wrote ${runPath} ($${run.spend_usd.toFixed(4)})`);
  }
  let judged: JudgeFile | null = null;
  if (opts.command === "judge" || opts.command === "all") {
    const key = requireKey();
    run ??= JSON.parse(fs.readFileSync(runPath, "utf8")) as RunFile;
    const routeC = opts.routeC ? loadRouteC(opts.routeC) : null;
    judged = await judgeRun(
      run,
      prompts,
      opts.judgeModel,
      anthropicJudgeTransport(key, opts.baseUrl),
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
