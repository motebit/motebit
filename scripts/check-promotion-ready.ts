#!/usr/bin/env tsx
/**
 * check-promotion-ready — is the archetype slate ready for staging → prod?
 *
 * The promotion state IS the conformance workflow's own scheduled-run
 * history (docs/doctrine/agent-archetypes.md §4: accept-on-proof): ready
 * when the newest N (default 5) SCHEDULED runs of archetype-conformance.yml
 * in motebit/motebit all concluded success, each one unattended:
 *   - a manual dispatch does not count (only `schedule` runs are read);
 *   - a re-run does not count (`attempt` must be 1: a human `gh run rerun`
 *     of a failed scheduled run is not an unattended green);
 *   - the run must be on `main`, completed, conclusion `success`;
 *   - the newest run must be at most 48 hours old, and no two counted runs
 *     may be more than 48 hours apart (a schedule that stopped and restarted:
 *     one green from today does not adopt four from August). The bound stops
 *     a STOPPED schedule's old greens from being counted. It does not demand
 *     one run per calendar day: a day GitHub skips or delays is not a red run;
 *   - a run listed twice (same url, same contents) counts once; the same url
 *     with DIFFERENT contents means the answer cannot be trusted, and reads
 *     as unreadable history.
 * The discipline is that the slate passes unattended, on the daily cadence,
 * not when someone is watching.
 *
 * Fail-closed on thin history: fewer than N scheduled runs on record (new
 * workflow, 90-day retention horizon, a rename) reads NOT READY — never
 * "probably fine". Fail-closed on unreadable history: `gh` missing,
 * unauthenticated, erroring or answering with something that is not a run
 * list reads NOT READY. The read names the repository (`--repo
 * motebit/motebit`), so a fork remote, `gh repo set-default` or GH_REPO
 * cannot point it at another repository's history.
 *
 * Two callers:
 *   1. this CLI, an operator pre-flight run by hand (N from REQUIRED);
 *   2. the slate's prod command (`MOTEBIT_RELAY_PUBLIC_KEY=<production relay
 *      key> RUN=1 TARGET=prod npx tsx scripts/deploy-archetype-slate.ts`),
 *      which calls
 *      `readPromotionReadiness` with N fixed at
 *      PROMOTION_REQUIRED_GREEN_RUNS before its first flyctl call and
 *      refuses unless ready (or PROMOTION_READINESS_OVERRIDE_REASON carries
 *      a real reason, printed with what it overrode).
 *
 * What that does NOT cover — NOT a CI gate:
 *   - the slate's prod command is still a local flyctl deploy: no CI gate
 *     and no GitHub environment reviewer applies to it (docs/ops/RUNBOOK.md,
 *     "Molecule production deploys": the gate covers the GitHub Actions path
 *     only);
 *   - workflow-driven deploys of a prod app that already exists
 *     (deploy-<service>.yml) are gated on CI + staging + head of main + a
 *     reviewer and do NOT consult this conformance history;
 *   - a direct `flyctl deploy` consults nothing.
 * Requires `gh` authenticated. Run through tsx:
 *
 *   npx tsx scripts/check-promotion-ready.ts        # N=5
 *   REQUIRED=3 npx tsx scripts/check-promotion-ready.ts
 */

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { cleanEnv } from "./lib/differential-tree.ts";

/** The workflow whose scheduled-run history is the promotion state. */
export const CONFORMANCE_WORKFLOW = "archetype-conformance.yml";

/** The repository whose history is read, whatever the checkout's remotes or gh defaults say. */
export const CONFORMANCE_REPO = "motebit/motebit";

/** The branch a counted run must have run on. */
export const CONFORMANCE_BRANCH = "main";

/**
 * Consecutive green scheduled runs promotion needs. The slate's prod command
 * uses exactly this number; only the hand-run CLI reads REQUIRED.
 */
export const PROMOTION_REQUIRED_GREEN_RUNS = 5;

/** The newest counted run may be at most this old: the schedule is daily. */
export const PROMOTION_MAX_NEWEST_RUN_AGE_HOURS = 48;

/**
 * No two counted runs may be further apart than this. It stops the old greens
 * of a schedule that stopped and restarted from being counted; it does not
 * demand one run per calendar day (a day GitHub skips is not a red run).
 */
export const PROMOTION_MAX_RUN_GAP_HOURS = 48;

export interface ConformanceRun {
  attempt: number;
  conclusion: string | null;
  createdAt: string;
  event: string;
  headBranch: string;
  status: string;
  url: string;
}

/**
 * Lists up to `limit` SCHEDULED runs of the conformance workflow. Throws when
 * the history cannot be read. The order of the answer is not trusted.
 */
export type ListRuns = (limit: number) => unknown;

export type PromotionReadiness =
  | { ready: true; required: number; runs: ConformanceRun[] }
  | { ready: false; reason: "gh-unreadable"; required: number; detail: string }
  | { ready: false; reason: "thin-history"; required: number; runs: ConformanceRun[] }
  | {
      ready: false;
      reason: "not-all-green" | "rerun-attempt" | "wrong-branch";
      required: number;
      runs: ConformanceRun[];
      failing: ConformanceRun[];
    }
  | {
      ready: false;
      reason: "stale-history";
      required: number;
      runs: ConformanceRun[];
      newestAgeHours: number;
    }
  | {
      ready: false;
      reason: "gap-in-history";
      required: number;
      runs: ConformanceRun[];
      /** The newest pair of consecutive counted runs that are too far apart. */
      gap: { newer: ConformanceRun; older: ConformanceRun; hours: number };
    };

export type NotReady = Exclude<PromotionReadiness, { ready: true }>;

export type NotReadyReason = Exclude<PromotionReadiness, { ready: true }>["reason"];

/** The default `listRuns`: `gh run list` for the conformance workflow's scheduled runs. */
export function listScheduledRunsViaGh(limit: number): unknown {
  const raw = execFileSync(
    "gh",
    [
      "run",
      "list",
      "--repo",
      CONFORMANCE_REPO,
      "--workflow",
      CONFORMANCE_WORKFLOW,
      "--event",
      "schedule",
      "--limit",
      String(limit),
      "--json",
      "attempt,conclusion,createdAt,event,headBranch,status,url",
    ],
    { encoding: "utf8", env: cleanEnv() },
  );
  return JSON.parse(raw) as unknown;
}

function isRun(row: unknown): row is ConformanceRun {
  if (typeof row !== "object" || row === null) return false;
  const r = row as Record<string, unknown>;
  return (
    typeof r["attempt"] === "number" &&
    (r["conclusion"] === null || typeof r["conclusion"] === "string") &&
    typeof r["createdAt"] === "string" &&
    !Number.isNaN(Date.parse(r["createdAt"])) &&
    typeof r["event"] === "string" &&
    typeof r["headBranch"] === "string" &&
    typeof r["status"] === "string" &&
    typeof r["url"] === "string"
  );
}

/**
 * The readiness decision. Pure given `listRuns` and `now`: ready only when
 * the newest `required` scheduled runs exist, every one is a first attempt
 * on main that completed with `success`, and the newest is fresh.
 * Everything else — unreadable history, a malformed answer, a `required`
 * that is not a positive integer, thin history, a run that failed or has not
 * concluded, a re-run, another branch, a stale window — is not ready, with
 * the reason.
 */
export function readPromotionReadiness(opts: {
  required?: number;
  listRuns?: ListRuns;
  now?: () => Date;
}): PromotionReadiness {
  const required = opts.required ?? PROMOTION_REQUIRED_GREEN_RUNS;
  const listRuns = opts.listRuns ?? listScheduledRunsViaGh;
  const now = opts.now ?? (() => new Date());
  const unreadable = (detail: string): PromotionReadiness => ({
    ready: false,
    reason: "gh-unreadable",
    required,
    detail,
  });

  if (!Number.isInteger(required) || required < 1) {
    return unreadable(`the required run count must be a positive integer, got ${String(required)}`);
  }

  let listed: unknown;
  try {
    listed = listRuns(required);
  } catch (err) {
    return unreadable(err instanceof Error ? err.message : String(err));
  }
  if (!Array.isArray(listed) || !listed.every(isRun)) {
    return unreadable(
      "the answer is not a list of runs (attempt, conclusion, createdAt, event, headBranch, status, url)",
    );
  }
  // gh lists one row per run. The same url twice with DIFFERENT contents (one
  // copy green, one red) is an answer that cannot be trusted: collapsing it
  // to whichever copy came first could hide a red run.
  const byUrl = new Map<string, string>();
  for (const r of listed) {
    const contents = JSON.stringify([
      r.attempt,
      r.conclusion,
      r.createdAt,
      r.event,
      r.headBranch,
      r.status,
    ]);
    const first = byUrl.get(r.url);
    if (first !== undefined && first !== contents) {
      return unreadable(`the run list names one run twice with different contents: ${r.url}`);
    }
    byUrl.set(r.url, contents);
  }
  // Only scheduled runs count, each once (identical repeated rows collapse),
  // and only the newest `required` of them BY THEIR OWN DATES: the answer's
  // order is not trusted, and a lister that answers with more rows or with
  // other events changes nothing.
  const seen = new Set<string>();
  const runs = listed
    .filter((r) => r.event === "schedule")
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .filter((r) => {
      if (seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    })
    .slice(0, required);

  if (runs.length < required) return { ready: false, reason: "thin-history", required, runs };

  const notGreen = runs.filter((r) => r.status !== "completed" || r.conclusion !== "success");
  if (notGreen.length > 0) {
    return { ready: false, reason: "not-all-green", required, runs, failing: notGreen };
  }
  const reruns = runs.filter((r) => r.attempt !== 1);
  if (reruns.length > 0) {
    return { ready: false, reason: "rerun-attempt", required, runs, failing: reruns };
  }
  const offBranch = runs.filter((r) => r.headBranch !== CONFORMANCE_BRANCH);
  if (offBranch.length > 0) {
    return { ready: false, reason: "wrong-branch", required, runs, failing: offBranch };
  }
  const newestAgeHours = (now().getTime() - Date.parse(runs[0]!.createdAt)) / 3_600_000;
  if (newestAgeHours > PROMOTION_MAX_NEWEST_RUN_AGE_HOURS) {
    return { ready: false, reason: "stale-history", required, runs, newestAgeHours };
  }
  // A fresh newest run does not adopt old greens from before the schedule
  // stopped: no two counted runs may be too far apart.
  for (let i = 0; i + 1 < runs.length; i++) {
    const newer = runs[i]!;
    const older = runs[i + 1]!;
    const hours = (Date.parse(newer.createdAt) - Date.parse(older.createdAt)) / 3_600_000;
    if (hours > PROMOTION_MAX_RUN_GAP_HOURS) {
      return {
        ready: false,
        reason: "gap-in-history",
        required,
        runs,
        gap: { newer, older, hours },
      };
    }
  }
  return { ready: true, required, runs };
}

/** The readiness result as the lines both callers print. */
export function describePromotionReadiness(result: PromotionReadiness): string[] {
  if (result.ready) {
    const { runs } = result;
    return [
      `✓ check-promotion-ready: last ${runs.length} scheduled conformance runs all green (${runs[runs.length - 1]!.createdAt} → ${runs[0]!.createdAt}).`,
    ];
  }
  switch (result.reason) {
    case "gh-unreadable":
      return [
        `check-promotion-ready: could not read ${CONFORMANCE_WORKFLOW} run history via gh (${result.detail}).`,
        "NOT READY — unknown history is not green history.",
      ];
    case "thin-history":
      return [
        `check-promotion-ready: only ${result.runs.length}/${result.required} scheduled run(s) on record.`,
        "NOT READY — thin history reads not-ready by design (new workflow / retention horizon / rename).",
      ];
    case "not-all-green":
      return [
        `check-promotion-ready: ${result.failing.length}/${result.runs.length} of the last scheduled runs did not succeed:`,
        ...result.failing.map((r) => `  ${r.createdAt}  ${shownConclusion(r)}  ${r.url}`),
        "NOT READY.",
      ];
    case "rerun-attempt":
      return [
        `check-promotion-ready: ${result.failing.length}/${result.runs.length} of the last scheduled runs are re-runs, not the scheduled attempt:`,
        ...result.failing.map((r) => `  ${r.createdAt}  attempt ${r.attempt}  ${r.url}`),
        "NOT READY — a re-run someone started is not an unattended green.",
      ];
    case "wrong-branch":
      return [
        `check-promotion-ready: ${result.failing.length}/${result.runs.length} of the last scheduled runs did not run on ${CONFORMANCE_BRANCH}:`,
        ...result.failing.map((r) => `  ${r.createdAt}  ${r.headBranch}  ${r.url}`),
        `NOT READY — only scheduled runs on ${CONFORMANCE_BRANCH} count.`,
      ];
    case "stale-history":
      return [
        `check-promotion-ready: the newest scheduled run (${result.runs[0]!.createdAt}) is ${hoursShown(result.newestAgeHours)} hours old; the limit is ${PROMOTION_MAX_NEWEST_RUN_AGE_HOURS}.`,
        "NOT READY — old greens do not stand in for a schedule that has stopped.",
      ];
    case "gap-in-history":
      return [
        `check-promotion-ready: two counted runs are ${hoursShown(result.gap.hours)} hours apart (${result.gap.older.createdAt} → ${result.gap.newer.createdAt}); the limit is ${PROMOTION_MAX_RUN_GAP_HOURS}.`,
        "NOT READY — a schedule that stopped and restarted does not get its old greens counted.",
      ];
  }
}

/**
 * Hours for a message that compares them with a limit: one decimal, rounded
 * UP, so a value over the limit never prints as the limit (48.04 → 48.1).
 */
function hoursShown(hours: number): string {
  const up = Math.ceil(hours * 10) / 10;
  return Number.isInteger(up) ? String(up) : up.toFixed(1);
}

/** A run that has not completed; gh reports its conclusion as "" (or null). */
function inProgress(r: ConformanceRun): boolean {
  return r.status !== "completed";
}

/** The conclusion column of a listed run, truthfully: a running run has none yet. */
function shownConclusion(r: ConformanceRun): string {
  if (inProgress(r)) return "in progress";
  return r.conclusion === null || r.conclusion === "" ? "pending" : r.conclusion;
}

/** What to do about a not-ready result: one clause, no trailing period. */
export function promotionRepair(result: NotReady): string {
  switch (result.reason) {
    case "gh-unreadable":
      // An older gh does not know a field this check asks for.
      if (result.detail.includes("Unknown JSON field")) {
        return "Upgrade gh (`gh --version`): this check needs the `attempt`, `headBranch` and `status` fields of `gh run list --json`";
      }
      return "Install and authenticate gh (`gh auth status`) so the history can be read";
    case "thin-history":
      return "Wait for the daily schedule to put enough runs on record (manual dispatches do not count)";
    case "not-all-green":
      if (result.failing.every(inProgress)) {
        return "A scheduled run is still in progress: re-check when it finishes";
      }
      return "Fix what the runs listed above caught, then wait for the daily schedule to turn the window green (manual dispatches do not count)";
    case "gap-in-history":
      return `Wait for the daily schedule to produce ${result.required} runs with no two more than ${PROMOTION_MAX_RUN_GAP_HOURS} hours apart (after a schedule stopped and restarted, the count starts again from the restart)`;
    case "rerun-attempt":
      return "Wait for the daily schedule to replace the re-run runs with first attempts (do not `gh run rerun` a scheduled run: the re-run never counts)";
    case "wrong-branch":
      return `Wait for the daily schedule to put enough ${CONFORMANCE_BRANCH} runs on record`;
    case "stale-history":
      return `Find why the schedule stopped (\`gh workflow view ${CONFORMANCE_WORKFLOW} --repo ${CONFORMANCE_REPO}\`; a disabled workflow is re-enabled with \`gh workflow enable\`), then wait for the daily schedule to produce a fresh window`;
  }
}

export interface CheckPromotionReadyIo {
  env: Record<string, string | undefined>;
  listRuns?: ListRuns;
  now?: () => Date;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

/** The CLI: prints the result, returns the exit code (0 ready, 1 not ready). */
export function runCheckPromotionReady(io: CheckPromotionReadyIo): number {
  const log = io.log ?? ((line: string) => console.log(line));
  const error = io.error ?? ((line: string) => console.error(line));
  const required = Number(io.env["REQUIRED"] ?? String(PROMOTION_REQUIRED_GREEN_RUNS));
  const result = readPromotionReadiness({ required, listRuns: io.listRuns, now: io.now });
  if (!result.ready) {
    for (const line of describePromotionReadiness(result)) error(line);
    error(`Fix: ${promotionRepair(result)}.`);
    return 1;
  }
  for (const line of describePromotionReadiness(result)) log(line);
  log(
    `READY — the slate's prod command is: MOTEBIT_RELAY_PUBLIC_KEY=<production relay key> RUN=1 TARGET=prod npx tsx scripts/deploy-archetype-slate.ts. It needs the production relay's public key from you, obtained out of band (it refuses a promotion without it). It re-checks this readiness itself (always the last ${PROMOTION_REQUIRED_GREEN_RUNS} scheduled runs, whatever REQUIRED says here) before its first flyctl call and refuses unless ready. It is still a local flyctl deploy: no CI gate and no GitHub environment reviewer applies to it.`,
  );
  return 0;
}

/**
 * Is the module at `moduleUrl` the program being run (true), or a module
 * something else imported (false)?
 *
 * `process.argv[1]` is resolved the way tsx resolves an entry: as given, then
 * with `.ts` (`tsx scripts/check-promotion-ready`, no extension, is a real
 * invocation), then with a `.js` ending read as `.ts` (`tsx
 * scripts/check-promotion-ready.js` runs the `.ts` file). When it cannot be resolved at all, the answer is unknown, and
 * unknown is never "imported": a readiness check that exits 0 without
 * checking is fail-open for any `check && deploy` chain. It throws, so the
 * process exits non-zero and says why.
 */
export function isProgramEntry(moduleUrl: string): boolean {
  const entry = process.argv[1];
  // No entry at all: `node -e`, a REPL. The module was imported.
  if (entry === undefined) return false;
  const self = realpathSync(fileURLToPath(moduleUrl));
  for (const candidate of [entry, `${entry}.ts`, entry.replace(/\.js$/, ".ts")]) {
    let resolved: string;
    try {
      resolved = realpathSync(candidate);
    } catch {
      continue;
    }
    return resolved === self;
  }
  throw new Error(
    `${fileURLToPath(moduleUrl)}: cannot tell whether this script is being run or imported (the entry "${entry}" does not resolve to a file). Refusing to do nothing and exit 0. Run it by its path, e.g. npx tsx scripts/check-promotion-ready.ts`,
  );
}

if (isProgramEntry(import.meta.url)) {
  process.exit(runCheckPromotionReady({ env: process.env }));
}
