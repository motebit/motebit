#!/usr/bin/env tsx
/**
 * check-promotion-ready — is the archetype slate ready for staging → prod?
 *
 * The promotion state IS the conformance workflow's own scheduled-run
 * history (docs/doctrine/agent-archetypes.md §4: accept-on-proof): ready
 * when the last N (default 5) SCHEDULED runs of archetype-conformance.yml
 * all concluded success. Manual dispatches don't count — the discipline is
 * that the slate passes unattended, on the daily cadence, not when someone
 * is watching.
 *
 * Fail-closed on thin history: fewer than N scheduled runs on record (new
 * workflow, 90-day retention horizon, a rename) reads NOT READY — never
 * "probably fine". Fail-closed on unreadable history: `gh` missing,
 * unauthenticated, erroring or answering with something that is not a run
 * list reads NOT READY.
 *
 * Two callers:
 *   1. this CLI, an operator pre-flight run by hand (N from REQUIRED);
 *   2. the slate's prod command (`RUN=1 TARGET=prod npx tsx
 *      scripts/deploy-archetype-slate.ts`), which calls
 *      `readPromotionReadiness` with N fixed at
 *      PROMOTION_REQUIRED_GREEN_RUNS before its first flyctl call and
 *      refuses unless ready (or PROMOTION_READINESS_OVERRIDE_REASON carries
 *      a non-empty reason, printed with what it overrode).
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
 * Requires `gh` authenticated.
 *
 *   npx tsx scripts/check-promotion-ready.ts        # N=5
 *   REQUIRED=3 npx tsx scripts/check-promotion-ready.ts
 */

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The workflow whose scheduled-run history is the promotion state. */
export const CONFORMANCE_WORKFLOW = "archetype-conformance.yml";

/**
 * Consecutive green scheduled runs promotion needs. The slate's prod command
 * uses exactly this number; only the hand-run CLI reads REQUIRED.
 */
export const PROMOTION_REQUIRED_GREEN_RUNS = 5;

export interface ConformanceRun {
  conclusion: string | null;
  createdAt: string;
  event: string;
  url: string;
}

/**
 * Lists the newest `limit` SCHEDULED runs of the conformance workflow, newest
 * first. Throws when the history cannot be read.
 */
export type ListRuns = (limit: number) => unknown;

export type PromotionReadiness =
  | { ready: true; required: number; runs: ConformanceRun[] }
  | { ready: false; reason: "gh-unreadable"; required: number; detail: string }
  | { ready: false; reason: "thin-history"; required: number; runs: ConformanceRun[] }
  | {
      ready: false;
      reason: "not-all-green";
      required: number;
      runs: ConformanceRun[];
      failing: ConformanceRun[];
    };

/** The default `listRuns`: `gh run list` for the conformance workflow's scheduled runs. */
export function listScheduledRunsViaGh(limit: number): unknown {
  const raw = execFileSync(
    "gh",
    [
      "run",
      "list",
      "--workflow",
      CONFORMANCE_WORKFLOW,
      "--event",
      "schedule",
      "--limit",
      String(limit),
      "--json",
      "conclusion,createdAt,event,url",
    ],
    { encoding: "utf8" },
  );
  return JSON.parse(raw) as unknown;
}

function isRun(row: unknown): row is ConformanceRun {
  if (typeof row !== "object" || row === null) return false;
  const r = row as Record<string, unknown>;
  return (
    (r["conclusion"] === null || typeof r["conclusion"] === "string") &&
    typeof r["createdAt"] === "string" &&
    typeof r["event"] === "string" &&
    typeof r["url"] === "string"
  );
}

/**
 * The readiness decision. Pure given `listRuns`: ready only when the newest
 * `required` scheduled runs exist and every one concluded `success`.
 * Everything else — unreadable history, a malformed answer, a `required`
 * that is not a positive integer, thin history, a run that failed or has not
 * concluded — is not ready, with the reason.
 */
export function readPromotionReadiness(opts: {
  required?: number;
  listRuns?: ListRuns;
}): PromotionReadiness {
  const required = opts.required ?? PROMOTION_REQUIRED_GREEN_RUNS;
  const listRuns = opts.listRuns ?? listScheduledRunsViaGh;
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
    return unreadable("the answer is not a list of runs (conclusion, createdAt, event, url)");
  }
  // Only scheduled runs count, and only the newest `required` of them: a
  // lister that answers with more, or with other events, changes nothing.
  const runs = listed.filter((r) => r.event === "schedule").slice(0, required);

  if (runs.length < required) return { ready: false, reason: "thin-history", required, runs };
  const failing = runs.filter((r) => r.conclusion !== "success");
  if (failing.length > 0) return { ready: false, reason: "not-all-green", required, runs, failing };
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
        ...result.failing.map((r) => `  ${r.createdAt}  ${r.conclusion ?? "pending"}  ${r.url}`),
        "NOT READY.",
      ];
  }
}

export interface CheckPromotionReadyIo {
  env: Record<string, string | undefined>;
  listRuns?: ListRuns;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

/** The CLI: prints the result, returns the exit code (0 ready, 1 not ready). */
export function runCheckPromotionReady(io: CheckPromotionReadyIo): number {
  const log = io.log ?? ((line: string) => console.log(line));
  const error = io.error ?? ((line: string) => console.error(line));
  const required = Number(io.env["REQUIRED"] ?? String(PROMOTION_REQUIRED_GREEN_RUNS));
  const result = readPromotionReadiness({ required, listRuns: io.listRuns });
  if (!result.ready) {
    for (const line of describePromotionReadiness(result)) error(line);
    return 1;
  }
  for (const line of describePromotionReadiness(result)) log(line);
  log(
    `READY — the slate's prod command is: RUN=1 TARGET=prod npx tsx scripts/deploy-archetype-slate.ts. It re-checks this readiness itself (always the last ${PROMOTION_REQUIRED_GREEN_RUNS} scheduled runs, whatever REQUIRED says here) before its first flyctl call and refuses unless ready. It is still a local flyctl deploy: no CI gate and no GitHub environment reviewer applies to it.`,
  );
  return 0;
}

/** True when this file is the program being run, not a module the slate script or a test imported. */
function isMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  process.exit(runCheckPromotionReady({ env: process.env }));
}
