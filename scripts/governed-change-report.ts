#!/usr/bin/env tsx
/**
 * governed-change-report — the `governed-change` check of the governed repo
 * change design (docs/proposals/governed-repo-change-v1.md, "External
 * enforcement"), in its EXPAND state: it reports, it is not required, and the
 * autonomy-tier verdict never reads it.
 *
 * Run by `.github/workflows/governed-change.yml` from the trusted checkout
 * (the base tip), never from the PR head. The change is a bare object store
 * (`--subject`), only read: by git plumbing here, and by `motebit-verify
 * repo-change` (spec/repo-change-v1.md §9, CI-on-PR mode), built from the
 * same trusted checkout, whose isolated session re-hashes what it reads.
 *
 * Per pull request:
 *
 *   not governed  the PR adds, modifies or deletes nothing under
 *                 `.motebit/bundles/` (compared from its merge base with the
 *                 base tip; ASCII case folded, so a case variant is judged).
 *                 There is no bundle, so there is nothing to judge: the run
 *                 succeeds, and the summary says it was NOT judged, never
 *                 that anything verified. The bundle is the change's claim
 *                 to be governed (spec §3.6, §9); a PR that makes no claim is
 *                 an ordinary PR, and reporting it NOT VERIFIED would be noise
 *                 on every PR and a false statement about a claim never made.
 *   VERIFIED      fully verified AND outcome `completed` (spec §7): exit 0.
 *   NOT VERIFIED  any other verdict: exit 1.
 *   NOT JUDGED    the verifier could not judge the change (its exit 2), or
 *                 this run's provenance self-check failed: exit 1.
 *
 * Every verdict axis goes to the job summary ($GITHUB_STEP_SUMMARY). Values
 * the PR controls (paths, failure details) appear only inside a fenced code
 * block whose fence is longer than any backtick run in them, so a PR cannot
 * write markdown into the summary.
 *
 * Provenance self-check (a consistency check run by the very policy it
 * checks, as in autonomy-tier-verdict.ts): the event is `pull_request_target`,
 * and the checkout's HEAD equals both EXPECTED_POLICY_SHA (what the workflow
 * told the checkout to take) and GITHUB_SHA (the base tip GitHub set), and
 * the payload's head equals EVENT_HEAD_SHA (what the fetch step fetched).
 *
 * ## The landed mode (`governed-change-report.ts landed ...`)
 *
 * Run by `.github/workflows/governed-change-landed.yml` (acceptance test B1's
 * offline half) inside a network namespace with no route out: it judges a
 * change that already landed with `motebit-verify repo-change --landed`
 * (spec §9 offline mode, §9.1 landing time) against the trusted tip, which is
 * this checkout's HEAD. VERIFIED is the same rule as above (the verifier's
 * exit 0 AND `accepted: true`, i.e. fully verified with outcome `completed`);
 * anything else is NOT VERIFIED or NOT JUDGED, exit 1. Its provenance
 * self-check: the event is `workflow_dispatch`, the ref is `refs/heads/main`,
 * LANDED_COMMIT is exactly 40 lowercase hex digits, and the checkout's HEAD
 * equals both GITHUB_SHA and TRUSTED_TIP (what the workflow told the checkout
 * to take). It judges; it never writes to the repository.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cleanEnv } from "./lib/differential-tree.js";

/** The directory every bundle lives under (spec §3.6; `BUNDLES_DIR` in @motebit/verify/git). */
export const BUNDLES_DIR = ".motebit/bundles/";
/** The only event this phase judges. */
export const JUDGED_EVENT = "pull_request_target";
/** The check's phase (docs/proposals/governed-repo-change-v1.md, "External enforcement"). */
export const PHASE = "expand";
/** The landed mode's subcommand (the first argument). */
export const LANDED_SUBCOMMAND = "landed";
/** The only event the landed mode judges. */
export const LANDED_EVENT = "workflow_dispatch";
/** The only ref the landed mode judges from: its HEAD is the trusted tip. */
export const LANDED_REF = "refs/heads/main";
/** A landed commit as the workflow takes it: a full sha1 commit id, lowercase. */
export const LANDED_COMMIT_ID = /^[0-9a-f]{40}$/;

const POLICY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// ── Pure core ────────────────────────────────────────────────────────────────

/** ASCII-only lower case: `A`-`Z` folded, every other byte kept. */
function asciiLower(bytes: Buffer): Buffer {
  const out = Buffer.from(bytes);
  for (let i = 0; i < out.length; i++) {
    const b = out[i]!;
    if (b >= 0x41 && b <= 0x5a) out[i] = b + 32;
  }
  return out;
}

/**
 * True iff a changed path is under `.motebit/bundles/` or is that directory's
 * own name, comparing with ASCII case folded. Paths are raw bytes (`git -z`).
 */
export function touchesBundles(path: Buffer): boolean {
  const p = asciiLower(path);
  const dir = Buffer.from(BUNDLES_DIR);
  if (p.length >= dir.length && p.subarray(0, dir.length).equals(dir)) return true;
  return p.equals(dir.subarray(0, dir.length - 1));
}

/** Split `git ... -z` output into its NUL-terminated records. */
export function splitZ(out: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < out.length; i++) {
    if (out[i] === 0) {
      parts.push(out.subarray(start, i));
      start = i + 1;
    }
  }
  if (start < out.length) parts.push(out.subarray(start));
  return parts;
}

/** A markdown code fence that `text` cannot close: longer than its longest backtick run. */
export function fenced(text: string, info = ""): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${info}\n${text}\n${fence}`;
}

/** A value shown outside a fence only when it is a plain token; anything else is withheld. */
function token(v: unknown): string {
  return typeof v === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(v)
    ? v
    : typeof v === "number" && Number.isFinite(v)
      ? String(v)
      : typeof v === "boolean"
        ? String(v)
        : v === null || v === undefined
          ? "none"
          : "(see the report below)";
}

/** The fields of `motebit-verify repo-change --json` this report reads. */
export interface CliReport {
  accepted?: unknown;
  verdict?: {
    integrity?: unknown;
    identityBinding?: unknown;
    authority?: unknown;
    revocation?: { status?: unknown } & Record<string, unknown>;
    temporalBasis?: unknown;
  } & Record<string, unknown>;
  outcome?: unknown;
  evaluatedAt?: unknown;
  temporalBasis?: unknown;
  changeCommit?: unknown;
  spent?: unknown;
  diagnostics?: { failures?: Array<{ code?: unknown; detail?: unknown }> };
  /** Landed mode only (spec §9 offline). */
  landed?: unknown;
  parent?: unknown;
  trustedTip?: unknown;
  signer?: unknown;
  timeProblem?: unknown;
}

export type Conclusion = "not-governed" | "verified" | "not-verified" | "not-judged";

export interface ReportInput {
  conclusion: Conclusion;
  number: number | null;
  policySha: string | null;
  headSha: string | null;
  /** Why the run did not judge (not-governed, not-judged). */
  reason?: string;
  /** The verifier's JSON report (verified, not-verified). */
  report?: CliReport;
  /** The verifier's stderr (not-judged). */
  stderr?: string;
}

const HEADLINE: Record<Conclusion, string> = {
  "not-governed": "not a governed change (not judged)",
  verified: "VERIFIED",
  "not-verified": "NOT VERIFIED",
  "not-judged": "NOT JUDGED",
};

/** The job summary: every axis, PR-controlled values fenced. */
export function renderSummary(r: ReportInput): string {
  const lines: string[] = [`## governed-change: ${HEADLINE[r.conclusion]}`, ""];
  lines.push(
    `Phase ${PHASE}: this check reports. It is not required, and the autonomy-tier verdict ignores it. ` +
      "A result reflects the pull request as of the event that ran it.",
    "",
  );
  lines.push("| field | value |", "| --- | --- |");
  lines.push(`| pull request | ${r.number === null ? "none" : `#${r.number}`} |`);
  lines.push(`| base tip (policy) | ${token(r.policySha)} |`);
  lines.push(`| head | ${token(r.headSha)} |`);
  if (r.report !== undefined) {
    const v = r.report.verdict ?? {};
    lines.push(`| integrity | ${token(v.integrity)} |`);
    lines.push(`| identityBinding | ${token(v.identityBinding)} |`);
    lines.push(`| authority | ${token(v.authority)} |`);
    lines.push(`| revocation | ${token(v.revocation?.status)} |`);
    lines.push(`| outcome | ${token(r.report.outcome)} |`);
    lines.push(`| accepted | ${token(r.report.accepted)} |`);
    lines.push(`| spent | ${token(r.report.spent)} |`);
    lines.push(
      `| evaluated at | ${token(r.report.evaluatedAt)} (${token(r.report.temporalBasis)}) |`,
    );
    lines.push(`| change commit | ${token(r.report.changeCommit)} |`);
  }
  lines.push("");
  if (r.conclusion === "not-governed") {
    lines.push(
      `The pull request adds, modifies or deletes nothing under \`${BUNDLES_DIR}\` (from its merge base with the base tip), ` +
        "so it carries no bundle and makes no claim to be a governed change. Nothing was judged, and nothing is " +
        "reported as verified.",
      "",
    );
  }
  if (r.reason !== undefined) lines.push(fenced(r.reason), "");
  if (r.stderr !== undefined && r.stderr !== "") {
    lines.push("The verifier's error:", "", fenced(r.stderr.trimEnd()), "");
  }
  if (r.report !== undefined) {
    lines.push(
      "The verifier's full report:",
      "",
      fenced(JSON.stringify(r.report, null, 2), "json"),
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}

/** What the landed-mode summary shows. */
export interface LandedReportInput {
  conclusion: Exclude<Conclusion, "not-governed">;
  landed: string | null;
  trustedTip: string | null;
  reason?: string;
  report?: CliReport;
  stderr?: string;
}

/** The landed-mode job summary: the inputs, every axis, repository-controlled values fenced. */
export function renderLandedSummary(r: LandedReportInput): string {
  const lines: string[] = [`## governed-change landed: ${HEADLINE[r.conclusion]}`, ""];
  lines.push(
    "Offline (spec/repo-change-v1.md §9): judged inside a network namespace with no route out, " +
      "against the trusted tip (main's tip at dispatch); the landing time is accepted only under §9.1. " +
      "This run judges; it writes nothing to the repository.",
    "",
  );
  lines.push("| field | value |", "| --- | --- |");
  lines.push(`| landed commit | ${token(r.landed)} |`);
  lines.push(`| trusted tip | ${token(r.trustedTip)} |`);
  if (r.report !== undefined) {
    const v = r.report.verdict ?? {};
    lines.push(`| parent | ${token(r.report.parent)} |`);
    lines.push(`| evaluation basis | ${token(r.report.temporalBasis)} |`);
    lines.push(`| evaluated at | ${token(r.report.evaluatedAt)} |`);
    lines.push(`| signer | ${token(r.report.signer)} |`);
    lines.push(`| time problem | ${token(r.report.timeProblem)} |`);
    lines.push(`| integrity | ${token(v.integrity)} |`);
    lines.push(`| identityBinding | ${token(v.identityBinding)} |`);
    lines.push(`| authority | ${token(v.authority)} |`);
    lines.push(`| revocation | ${token(v.revocation?.status)} |`);
    lines.push(`| outcome | ${token(r.report.outcome)} |`);
    lines.push(`| accepted | ${token(r.report.accepted)} |`);
    lines.push(`| spent | ${token(r.report.spent)} |`);
  }
  lines.push("");
  if (r.reason !== undefined) lines.push(fenced(r.reason), "");
  if (r.stderr !== undefined && r.stderr !== "") {
    lines.push("The verifier's error:", "", fenced(r.stderr.trimEnd()), "");
  }
  if (r.report !== undefined) {
    lines.push(
      "The verifier's full report:",
      "",
      fenced(JSON.stringify(r.report, null, 2), "json"),
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}

// ── I/O ──────────────────────────────────────────────────────────────────────

/** git against the bare subject: no system or global config, no replace objects, no commit-graph. */
function subjectGit(subject: string, args: readonly string[]): Buffer {
  return execFileSync("git", [`--git-dir=${subject}`, "-c", "core.commitGraph=false", ...args], {
    env: cleanEnv(process.env, {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_NO_REPLACE_OBJECTS: "1",
    }),
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
}

/**
 * Whether the pull request touches `.motebit/bundles/`, from its merge base
 * with the base tip (so a bundle that landed on main after the PR branched
 * does not make an ordinary PR look governed). With no merge base the PR is
 * judged: the verifier then reports what it finds.
 */
export function isGovernedChange(subject: string, base: string, head: string): boolean {
  let mergeBase: string;
  try {
    mergeBase = subjectGit(subject, ["merge-base", base, head]).toString("utf8").trim();
  } catch {
    return true;
  }
  const out = subjectGit(subject, [
    "diff-tree",
    "-r",
    "-z",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    "--name-only",
    mergeBase,
    head,
  ]);
  return splitZ(out).some(touchesBundles);
}

function argValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

interface EventPayload {
  pull_request?: {
    number?: number;
    head?: { sha?: string };
    base?: { ref?: string };
    user?: { login?: string };
  };
}

export interface MainOptions {
  env?: NodeJS.ProcessEnv;
  /** The trusted checkout (this script's own); tests point it at a fixture. */
  policyRoot?: string;
  /** The verifier binary; default the trusted checkout's build. */
  verifyCli?: string;
  /** Evaluation time for the verifier (tests only; the workflow never sets it). */
  now?: number;
}

/** The trusted checkout's HEAD, or null when unreadable. */
function checkoutHead(policyRoot: string, env: NodeJS.ProcessEnv): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: policyRoot,
      env: cleanEnv(env),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * The landed mode: `landed --repository <owner/name> --repo <clone>
 * --github-keys <file>`, with LANDED_COMMIT and TRUSTED_TIP from the step env.
 */
export function mainLanded(argv: readonly string[], opts: MainOptions = {}): number {
  const env = opts.env ?? process.env;
  const policyRoot = opts.policyRoot ?? POLICY_ROOT;
  const verifyCli = opts.verifyCli ?? join(policyRoot, "packages", "verify", "dist", "cli.js");
  const repository = argValue(argv, "--repository");
  const repo = argValue(argv, "--repo");
  const githubKeys = argValue(argv, "--github-keys");
  const write = (summary: string): void => {
    process.stdout.write(summary);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  };
  if (!repository || !repo || !githubKeys) {
    process.stderr.write(
      "usage: governed-change-report landed --repository <owner/name> --repo <clone> --github-keys <file> (GITHUB_EVENT_NAME, GITHUB_REF, GITHUB_SHA, LANDED_COMMIT, TRUSTED_TIP set)\n",
    );
    return 2;
  }
  const landedRaw = env.LANDED_COMMIT ?? "";
  const landed = LANDED_COMMIT_ID.test(landedRaw) ? landedRaw : null;
  const head = checkoutHead(policyRoot, env);
  const trustedTip = head !== null && FULL_SHA.test(head) ? head : null;

  // ── Provenance self-check.
  const problems: string[] = [];
  if (env.GITHUB_EVENT_NAME !== LANDED_EVENT) problems.push(`the event is not ${LANDED_EVENT}`);
  if (env.GITHUB_REF !== LANDED_REF) problems.push(`the ref is not ${LANDED_REF}`);
  if (landed === null) {
    problems.push("LANDED_COMMIT is not exactly 40 lowercase hexadecimal digits");
  }
  if (trustedTip === null) {
    problems.push("the trusted checkout's HEAD is unreadable");
  } else {
    if (env.TRUSTED_TIP !== trustedTip) problems.push("the trusted checkout is not TRUSTED_TIP");
    if (env.GITHUB_SHA !== trustedTip) problems.push("the trusted checkout is not GITHUB_SHA");
  }
  if (problems.length > 0) {
    write(
      renderLandedSummary({
        conclusion: "not-judged",
        landed,
        trustedTip,
        reason: `provenance self-check failed:\n${problems.join("\n")}`,
      }),
    );
    return 1;
  }

  const run = spawnSync(
    process.execPath,
    [
      verifyCli,
      "repo-change",
      "--landed",
      landed!,
      "--trusted-tip",
      trustedTip!,
      "--repository",
      repository,
      "--github-keys",
      githubKeys,
      "--repo",
      repo,
      "--json",
    ],
    { env: cleanEnv(env), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const stderr = run.stderr ?? "";
  if (run.status === 0 || run.status === 1) {
    let report: CliReport | null = null;
    try {
      report = JSON.parse(run.stdout) as CliReport;
    } catch {
      report = null;
    }
    if (report !== null) {
      // VERIFIED: the same rule as the pull-request mode (exit 0 AND accepted).
      const verified = report.accepted === true && run.status === 0;
      const conclusion = verified ? "verified" : "not-verified";
      write(renderLandedSummary({ conclusion, landed, trustedTip, report, stderr }));
      return verified ? 0 : 1;
    }
  }
  const reason = `motebit-verify repo-change --landed exited ${run.status ?? `on signal ${run.signal ?? "?"}`}${run.error ? `: ${run.error.message}` : ""}`;
  write(renderLandedSummary({ conclusion: "not-judged", landed, trustedTip, reason, stderr }));
  return 1;
}

/** The CLI; resolves with the exit code. */
export function main(argv: readonly string[], opts: MainOptions = {}): number {
  if (argv[0] === LANDED_SUBCOMMAND) return mainLanded(argv.slice(1), opts);
  const env = opts.env ?? process.env;
  const policyRoot = opts.policyRoot ?? POLICY_ROOT;
  const verifyCli = opts.verifyCli ?? join(policyRoot, "packages", "verify", "dist", "cli.js");
  const eventPath = argValue(argv, "--event-path");
  const repository = argValue(argv, "--repository");
  const subject = argValue(argv, "--subject");
  const write = (summary: string): void => {
    process.stdout.write(summary);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  };
  if (!eventPath || !repository || !subject) {
    process.stderr.write(
      "usage: governed-change-report --event-path <file> --repository <owner/name> --subject <git dir> (GITHUB_EVENT_NAME, GITHUB_SHA, EXPECTED_POLICY_SHA, EVENT_HEAD_SHA set)\n",
    );
    return 2;
  }
  const event = JSON.parse(readFileSync(eventPath, "utf-8")) as EventPayload;
  const pr = event.pull_request;
  const number = typeof pr?.number === "number" ? pr.number : null;
  const headSha = pr?.head?.sha ?? null;

  let policySha: string | null = null;
  try {
    policySha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: policyRoot,
      env: cleanEnv(env),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    policySha = null;
  }

  // ── Provenance self-check.
  const problems: string[] = [];
  if (env.GITHUB_EVENT_NAME !== JUDGED_EVENT) {
    problems.push(`event '${env.GITHUB_EVENT_NAME ?? ""}' is not ${JUDGED_EVENT}`);
  }
  if (policySha === null || !FULL_SHA.test(policySha)) {
    problems.push("the trusted checkout's HEAD is unreadable");
  } else {
    if (env.EXPECTED_POLICY_SHA !== policySha) {
      problems.push("the trusted checkout is not EXPECTED_POLICY_SHA");
    }
    if (env.GITHUB_SHA !== policySha) problems.push("the trusted checkout is not GITHUB_SHA");
  }
  if (headSha === null || !FULL_SHA.test(headSha)) {
    problems.push("the event names no pull request head");
  } else if (env.EVENT_HEAD_SHA !== headSha) {
    problems.push("the payload's head is not EVENT_HEAD_SHA");
  }
  if (problems.length > 0) {
    write(
      renderSummary({
        conclusion: "not-judged",
        number,
        policySha,
        headSha,
        reason: `provenance self-check failed:\n${problems.join("\n")}`,
      }),
    );
    return 1;
  }
  const base = policySha!;
  const head = headSha!;

  if (!isGovernedChange(subject, base, head)) {
    write(renderSummary({ conclusion: "not-governed", number, policySha: base, headSha: head }));
    return 0;
  }

  const args = [
    verifyCli,
    "repo-change",
    "--repo",
    subject,
    "--base",
    base,
    "--head",
    head,
    "--repository",
    repository,
    "--base-ref",
    pr?.base?.ref ?? "",
    "--pr-author",
    pr?.user?.login ?? "",
    ...(opts.now !== undefined ? ["--now", String(opts.now)] : []),
    "--json",
  ];
  const run = spawnSync(process.execPath, args, {
    env: cleanEnv(env),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const stderr = run.stderr ?? "";
  if (run.status === 0 || run.status === 1) {
    let report: CliReport | null = null;
    try {
      report = JSON.parse(run.stdout) as CliReport;
    } catch {
      report = null;
    }
    if (report !== null) {
      const accepted = run.status === 0 && report.accepted === true;
      write(
        renderSummary({
          conclusion: accepted ? "verified" : "not-verified",
          number,
          policySha: base,
          headSha: head,
          report,
          stderr,
        }),
      );
      return accepted ? 0 : 1;
    }
  }
  write(
    renderSummary({
      conclusion: "not-judged",
      number,
      policySha: base,
      headSha: head,
      reason: `motebit-verify repo-change exited ${run.status ?? `on signal ${run.signal ?? "?"}`}${run.error ? `: ${run.error.message}` : ""}`,
      stderr,
    }),
  );
  return 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let code = 1;
  try {
    code = main(process.argv.slice(2));
  } catch (err) {
    const summary = renderSummary({
      conclusion: "not-judged",
      number: null,
      policySha: null,
      headSha: null,
      reason: err instanceof Error ? err.message : String(err),
    });
    process.stdout.write(summary);
    try {
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    } catch {
      // the summary is a report; the exit code below is the check
    }
    code = 1;
  }
  process.exit(code);
}
