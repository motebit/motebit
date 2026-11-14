/**
 * molecule-prod-gate — may this exact commit be deployed to a molecule's
 * PRODUCTION Fly app?
 *
 * The seven molecule prod workflows (deploy-{web-search,read-url,summarize,
 * research,auditor,clerk,code-review}.yml) used to deploy every push to main
 * that touched `packages/**`, with no CI gate and no promotion step. They now
 * call `.github/workflows/molecule-prod-gate.yml`, which runs this script
 * twice:
 *
 *   1. `GATE_MODE=wait` — the gate job, BEFORE the `production` environment
 *      asks for approval. It waits (bounded) for the evidence to conclude.
 *   2. `GATE_MODE=recheck` — the first step of the deploy job, AFTER approval
 *      (GitHub grants environment approval before a job's steps run, so the
 *      world may have moved while the approval sat). It does not wait: every
 *      check must already hold, or nothing deploys.
 *
 * For the sha being deployed (always the pinned `github.sha`, never a branch):
 *
 *   (a) the newest `CI` (ci.yml) run on main for that EXACT sha concluded
 *       `success`. Still running → wait (wait mode) / no deploy (recheck).
 *       Any other conclusion, a timeout, or no run at all → FAIL.
 *   (b) the sha is still the head of main. Otherwise nothing is deployed,
 *       and the outcome depends on whether anything will gate the new head:
 *       a NEWER run of this same deploy-<service>.yml exists on main →
 *       SUPERSEDED (green, explained); none appears within a bounded grace
 *       (main moved via commits outside the workflow's paths) → STRANDED
 *       (red, with the dispatch command that promotes the head); the lookup
 *       fails → FAIL. A CANCELLED CI on a sha main has left (ci.yml cancels
 *       per ref) takes this same path; any other non-success CI stays FAIL.
 *       The deploy predicate never changes: head of main is required.
 *
 *   A workflow_dispatch on main gates main's head: the reusable workflow
 *   passes GATE_SHA = github.sha, which for a dispatch is the head of the
 *   dispatched ref at dispatch time, and (b) requires it to still be main's.
 *   (c) when the service has a staging leg, the newest
 *       `deploy-archetype-staging.yml` run on main for that sha concluded
 *       `success`. NO run for the sha (the staging path filter skipped it) →
 *       FAIL with a repair instruction — staging is never silently skipped.
 *       A staging run that did not succeed → FAIL, unless main moved meanwhile
 *       (staging cancels superseded runs), which is SUPERSEDED.
 *
 * `GATE_STAGING_LEG=false` is the ONE named exception (code-review, which has
 * no staging app). It is passed explicitly, never defaulted, and the summary
 * carries a loud notice that only CI + approval stand between main and prod.
 *
 * Scope: this gates the GitHub Actions path only. Anyone holding Fly
 * credentials can still `flyctl deploy` directly (docs/ops/RUNBOOK.md §3).
 *
 *   GATE_MODE=wait GATE_SHA=<sha> GATE_REPO=owner/name GATE_SERVICE=clerk \
 *     GATE_STAGING_LEG=true node scripts/molecule-prod-gate.ts
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const CI_WORKFLOW = "ci.yml";
export const STAGING_WORKFLOW = "deploy-archetype-staging.yml";
export const STAGING_WORKFLOW_PATH = ".github/workflows/deploy-archetype-staging.yml";

/** One workflow run, as the Actions API reports it. */
export interface RunInfo {
  id: number;
  status: string; // queued | in_progress | completed | waiting | pending | requested
  conclusion: string | null; // success | failure | cancelled | timed_out | ...
  html_url?: string;
  created_at?: string;
}

export interface GateDeps {
  /** Newest run of `workflow` on main for `sha`, or null when there is none. Throws on an API error. */
  latestRun(workflow: string, sha: string): Promise<RunInfo | null>;
  /** The sha main points at now. Throws on an API error. */
  mainHead(): Promise<string>;
  /**
   * The newest run of the deploy workflow `workflow` on main (event push or
   * workflow_dispatch) for a commit OTHER than `sha`, created after the run
   * `runId` (run ids only grow), or null when there is none. Throws on an
   * API error.
   */
  newerRun(workflow: string, sha: string, runId: number): Promise<RunInfo | null>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export type GateMode = "wait" | "recheck";

export interface GateOptions {
  sha: string;
  service: string;
  stagingLeg: boolean;
  mode: GateMode;
  /** How long to wait for CI to conclude (wait mode). */
  ciTimeoutMs?: number;
  /** How long to wait for the staging run to conclude once it exists (wait mode). */
  stagingTimeoutMs?: number;
  /** How long a missing staging run may take to appear before it counts as missing (wait mode). */
  stagingGraceMs?: number;
  /**
   * The id of the run doing the gating (GITHUB_RUN_ID; in a reusable workflow
   * it is the caller's run). Used only on the superseded path, to find a newer
   * run of the same deploy workflow.
   */
  runId: number;
  /** How long a newer deploy run may take to appear before the outcome is STRANDED. */
  newerRunGraceMs?: number;
  pollMs?: number;
}

export type GateOutcome = "deploy" | "superseded" | "stranded" | "fail";

export interface CheckRow {
  check: string;
  result: string;
}

export interface GateDecision {
  outcome: GateOutcome;
  /** True only for outcome "deploy". */
  deploy: boolean;
  sha: string;
  reason: string;
  checks: CheckRow[];
  /** Lines printed as GitHub annotations (::error:: / ::notice:: / ::warning::). */
  annotations: string[];
  summary: string;
}

export const DEFAULTS = {
  ciTimeoutMs: 45 * 60_000, // CI can take 35+ min on shared runners (#978)
  stagingTimeoutMs: 15 * 60_000,
  stagingGraceMs: 2 * 60_000,
  newerRunGraceMs: 2 * 60_000,
  pollMs: 15_000,
};

export function stagingRepair(sha: string): string {
  return (
    `Repair: re-run staging for this sha — while ${sha} is still the head of main, run ` +
    `\`gh workflow run ${STAGING_WORKFLOW} --ref main\` (or Actions → "Deploy archetype slate (staging)" → Run workflow on main; ` +
    `if a staging run for this sha exists but failed, re-run it instead). When it is green, re-run this deploy workflow's failed jobs.`
  );
}

/** The deploy workflow a molecule service ships from (locked by the workflow tests). */
export function deployWorkflow(service: string): string {
  return `deploy-${service}.yml`;
}

const SUPERSEDED_NOTE =
  "SUPERSEDED — nothing was deployed, and this is not a failure: the commit is no longer the head of main, " +
  "and a NEWER run of this same deploy workflow exists on main (linked in the checks above). That run gates its " +
  "own commit; production keeps its current release until a gated deploy lands. A STRANDED or FAILED gate, by " +
  "contrast, is red and needs a repair.";

/**
 * The repair for STRANDED. The head that stranded the sha is outside this
 * workflow's paths, so for a staging-leg service the staging slate never ran
 * on it either: staging must be dispatched (and go green) for the current head
 * BEFORE the deploy dispatch, or the new run fails its own staging check.
 */
export function strandedRepair(sha: string, service: string, stagingLeg: boolean): string {
  const deploy = `\`gh workflow run ${deployWorkflow(service)} --ref main\``;
  return (
    `main moved past ${sha} via commits outside this workflow's paths; prod for ${service} is not on ${sha}. ` +
    (stagingLeg
      ? `To promote the current head: first re-run staging for it — \`gh workflow run ${STAGING_WORKFLOW} --ref main\` — and wait until that run is green for the current head; then run ${deploy}.`
      : `Run ${deploy} to promote the current head (no staging leg for this service).`)
  );
}

const NO_STAGING_NOTICE =
  "NO STAGING LEG: this service is deployed with GATE_STAGING_LEG=false — only CI on the exact sha plus the " +
  "`production` approval stand between main and production. No staging app exercises this commit first. " +
  "Founder decision pending: add a staging leg (recommended) or accept CI + approval only.";

function short(sha: string): string {
  return sha.slice(0, 12);
}

function describe(run: RunInfo | null): string {
  if (run === null) return "no run";
  return `status=${run.status} conclusion=${run.conclusion ?? ""}${run.html_url ? ` (${run.html_url})` : ""}`;
}

/** Poll `workflow` for `sha` until completed, the deadline passes, or (when `absentAfterMs` is set) no run appears in time. */
async function waitForRun(
  deps: GateDeps,
  workflow: string,
  sha: string,
  timeoutMs: number,
  pollMs: number,
  absentAfterMs: number | null,
  log: (l: string) => void,
): Promise<
  | { kind: "completed"; run: RunInfo }
  | { kind: "absent" }
  | { kind: "timeout"; last: RunInfo | null }
> {
  const start = deps.now();
  let last: RunInfo | null = null;
  let attempt = 0;
  for (;;) {
    attempt++;
    let run: RunInfo | null;
    try {
      run = await deps.latestRun(workflow, sha);
    } catch (err) {
      // A transient API error is not evidence either way; keep polling until the deadline.
      log(
        `  attempt ${attempt}: ${workflow} lookup failed (${err instanceof Error ? err.message : String(err)})`,
      );
      run = last;
    }
    last = run;
    log(`  attempt ${attempt}: ${workflow} ${describe(run)}`);
    if (run !== null && run.status === "completed") return { kind: "completed", run };
    const elapsed = deps.now() - start;
    if (run === null && absentAfterMs !== null && elapsed >= absentAfterMs)
      return { kind: "absent" };
    if (elapsed >= timeoutMs) return { kind: "timeout", last };
    await deps.sleep(pollMs);
  }
}

async function headIs(
  deps: GateDeps,
  sha: string,
): Promise<{ ok: true; head: string } | { ok: false; error: string }> {
  try {
    return { ok: true, head: await deps.mainHead() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function decideGate(
  deps: GateDeps,
  opts: GateOptions,
  log: (l: string) => void = () => {},
): Promise<GateDecision> {
  const ciTimeoutMs = opts.ciTimeoutMs ?? DEFAULTS.ciTimeoutMs;
  const stagingTimeoutMs = opts.stagingTimeoutMs ?? DEFAULTS.stagingTimeoutMs;
  const stagingGraceMs = opts.stagingGraceMs ?? DEFAULTS.stagingGraceMs;
  const pollMs = opts.pollMs ?? DEFAULTS.pollMs;
  const { sha, mode } = opts;
  const checks: CheckRow[] = [];
  const annotations: string[] = [];
  if (!opts.stagingLeg)
    annotations.push(`::warning title=No staging leg (${opts.service})::${NO_STAGING_NOTICE}`);

  const finish = (outcome: GateOutcome, reason: string, extra: string[] = []): GateDecision => {
    if (outcome === "fail")
      annotations.push(`::error title=Production deploy refused (${opts.service})::${reason}`);
    if (outcome === "stranded")
      annotations.push(`::error title=Production deploy stranded (${opts.service})::${reason}`);
    if (outcome === "superseded")
      annotations.push(`::notice title=Not deployed: superseded (${opts.service})::${reason}`);
    for (const e of extra) annotations.push(e);
    const verdict =
      outcome === "deploy"
        ? mode === "wait"
          ? "PASS — may proceed to the `production` approval"
          : "PASS — deploying this exact sha"
        : outcome === "superseded"
          ? "SUPERSEDED — not deployed (not a failure)"
          : outcome === "stranded"
            ? "STRANDED — not deployed, and no newer run will deploy (repair needed)"
            : "FAIL — not deployed";
    const lines = [
      `### Molecule production gate (${mode === "wait" ? "before approval" : "re-check after approval"}) — ${opts.service}`,
      "",
      `- sha: \`${sha}\``,
      `- staging leg: ${opts.stagingLeg ? "yes" : "**NO** (explicit exception)"}`,
      `- verdict: **${verdict}**`,
      `- reason: ${reason}`,
      "",
      "| check | result |",
      "| --- | --- |",
      ...checks.map((c) => `| ${c.check} | ${c.result.replace(/\|/g, "\\|")} |`),
      "",
    ];
    if (!opts.stagingLeg) lines.push(`> **${NO_STAGING_NOTICE}**`, "");
    if (outcome === "superseded") lines.push(`> ${SUPERSEDED_NOTE}`, "");
    for (const e of extra) lines.push(`> ${e.replace(/^::\w+[^:]*::/, "")}`, "");
    lines.push(
      "_This gates the GitHub Actions path only; direct `flyctl deploy` with Fly credentials bypasses it (docs/ops/RUNBOOK.md §3)._",
      "",
    );
    return {
      outcome,
      deploy: outcome === "deploy",
      sha,
      reason,
      checks,
      annotations,
      summary: lines.join("\n"),
    };
  };

  /**
   * The sha is not main's head. That is SUPERSEDED (green) only when a newer
   * run of this deploy workflow exists to gate the new head; a commit outside
   * the workflow's paths moves main without starting one, and then nothing
   * would ever promote it: STRANDED (red, with the repair). A lookup error is
   * never green. The safety predicate is unchanged: nothing here deploys.
   */
  const superseded = async (why: string): Promise<GateDecision> => {
    const workflow = deployWorkflow(opts.service);
    const graceMs = opts.newerRunGraceMs ?? DEFAULTS.newerRunGraceMs;
    const start = deps.now();
    for (;;) {
      let newer: RunInfo | null;
      try {
        newer = await deps.newerRun(workflow, sha, opts.runId);
      } catch (err) {
        checks.push({
          check: `newer ${workflow} run on main`,
          result: `lookup failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        return finish(
          "fail",
          `${why} Could not check for a newer ${workflow} run on main; refusing to call this superseded (fail-closed).`,
        );
      }
      if (newer !== null) {
        checks.push({ check: `newer ${workflow} run on main`, result: `yes: ${describe(newer)}` });
        return finish("superseded", why);
      }
      if (deps.now() - start >= graceMs) break;
      await deps.sleep(pollMs);
    }
    checks.push({
      check: `newer ${workflow} run on main`,
      result: "NONE — no run will gate the new head",
    });
    return finish("stranded", `${why} ${strandedRepair(sha, opts.service, opts.stagingLeg)}`);
  };

  if (!/^[0-9a-f]{40}$/.test(sha)) {
    checks.push({ check: "sha", result: `not a full 40-hex sha: ${JSON.stringify(sha)}` });
    return finish("fail", "The gate needs the exact 40-character commit sha being deployed.");
  }

  // (a) CI on this exact sha.
  let ci: Awaited<ReturnType<typeof waitForRun>>;
  if (mode === "wait") {
    log(`Waiting for CI to conclude on ${sha}…`);
    ci = await waitForRun(deps, CI_WORKFLOW, sha, ciTimeoutMs, pollMs, null, log);
  } else {
    let run: RunInfo | null = null;
    try {
      run = await deps.latestRun(CI_WORKFLOW, sha);
    } catch (err) {
      checks.push({
        check: "CI (ci.yml) success on this sha",
        result: `lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return finish(
        "fail",
        "Could not re-read CI for this sha after approval; refusing to deploy (fail-closed).",
      );
    }
    ci =
      run !== null && run.status === "completed"
        ? { kind: "completed", run }
        : { kind: "timeout", last: run };
  }
  if (ci.kind !== "completed") {
    const last = ci.kind === "timeout" ? ci.last : null;
    checks.push({
      check: "CI (ci.yml) success on this sha",
      result: `${mode === "wait" ? "timed out" : "not concluded"}: ${describe(last)}`,
    });
    return finish(
      "fail",
      mode === "wait"
        ? `CI did not conclude on ${short(sha)} within ${Math.round(ciTimeoutMs / 60_000)} min${last === null ? " (no CI run found for this sha)" : ""}.`
        : `CI on ${short(sha)} is no longer a concluded success at deploy time (${describe(last)}).`,
    );
  }
  if (ci.run.conclusion !== "success") {
    checks.push({ check: "CI (ci.yml) success on this sha", result: describe(ci.run) });
    // ci.yml cancels an in-progress run when a newer commit lands on its ref:
    // a CANCELLED CI on a sha main has left is supersession, not a CI failure.
    // Any other conclusion stays red, superseded or not.
    if (ci.run.conclusion === "cancelled") {
      const h = await headIs(deps, sha);
      if (h.ok && h.head !== sha) {
        checks.push({ check: "sha is the head of main", result: `no — main is at ${h.head}` });
        return superseded(
          `CI on ${short(sha)} was cancelled because main moved on (now ${short(h.head)}).`,
        );
      }
    }
    return finish(
      "fail",
      `CI concluded '${ci.run.conclusion ?? "none"}' on ${short(sha)}; refusing to deploy.`,
    );
  }
  checks.push({ check: "CI (ci.yml) success on this sha", result: describe(ci.run) });

  // (b) still the head of main.
  const head1 = await headIs(deps, sha);
  if (!head1.ok) {
    checks.push({ check: "sha is the head of main", result: `lookup failed: ${head1.error}` });
    return finish("fail", "Could not read the head of main; refusing to deploy (fail-closed).");
  }
  if (head1.head !== sha) {
    checks.push({ check: "sha is the head of main", result: `no — main is at ${head1.head}` });
    return superseded(`${short(sha)} is not the head of main (main is at ${short(head1.head)}).`);
  }
  checks.push({ check: "sha is the head of main", result: "yes" });

  // (c) staging on this exact sha, when the service has a staging leg.
  if (!opts.stagingLeg) {
    checks.push({
      check: "staging (deploy-archetype-staging.yml) success on this sha",
      result: "NOT REQUIRED — explicit no-staging-leg exception",
    });
  } else {
    let st: Awaited<ReturnType<typeof waitForRun>>;
    if (mode === "wait") {
      log(`Waiting for the staging slate deploy of ${sha}…`);
      st = await waitForRun(
        deps,
        STAGING_WORKFLOW,
        sha,
        stagingTimeoutMs,
        pollMs,
        stagingGraceMs,
        log,
      );
    } else {
      let run: RunInfo | null = null;
      try {
        run = await deps.latestRun(STAGING_WORKFLOW, sha);
      } catch (err) {
        checks.push({
          check: "staging (deploy-archetype-staging.yml) success on this sha",
          result: `lookup failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        return finish(
          "fail",
          "Could not re-read staging for this sha after approval; refusing to deploy (fail-closed).",
        );
      }
      st =
        run === null
          ? { kind: "absent" }
          : run.status === "completed"
            ? { kind: "completed", run }
            : { kind: "timeout", last: run };
    }
    if (st.kind !== "completed" || st.run.conclusion !== "success") {
      const result =
        st.kind === "absent"
          ? "MISSING — no staging run exists for this sha"
          : st.kind === "timeout"
            ? `${mode === "wait" ? "timed out" : "not concluded"}: ${describe(st.last)}`
            : describe(st.run);
      checks.push({ check: "staging (deploy-archetype-staging.yml) success on this sha", result });
      // Staging cancels superseded runs; a non-green staging on a commit main has left is supersession, not failure.
      const head2 = await headIs(deps, sha);
      if (head2.ok && head2.head !== sha) {
        checks.push({
          check: "sha is the head of main (after staging)",
          result: `no — main is at ${head2.head}`,
        });
        return superseded(
          `${short(sha)} was superseded on main (now ${short(head2.head)}) while staging was ${st.kind === "absent" ? "missing" : "not green"}.`,
        );
      }
      const repair = `::error title=Staging evidence missing or not green (${opts.service})::${stagingRepair(sha)}`;
      if (st.kind === "absent") {
        return finish(
          "fail",
          `No ${STAGING_WORKFLOW} run exists for ${short(sha)} — staging was never exercised on this commit (its path filter may have skipped it). Staging is never silently skipped.`,
          [repair],
        );
      }
      return finish(
        "fail",
        st.kind === "timeout"
          ? `Staging did not conclude on ${short(sha)}${mode === "wait" ? ` within ${Math.round(stagingTimeoutMs / 60_000)} min` : " at deploy time"}.`
          : `Staging concluded '${st.run.conclusion ?? "none"}' on ${short(sha)}; refusing to deploy.`,
        [repair],
      );
    }
    checks.push({
      check: "staging (deploy-archetype-staging.yml) success on this sha",
      result: describe(st.run),
    });

    // Final head check: staging may have taken minutes.
    const head3 = await headIs(deps, sha);
    if (!head3.ok) {
      checks.push({
        check: "sha is the head of main (final)",
        result: `lookup failed: ${head3.error}`,
      });
      return finish("fail", "Could not read the head of main; refusing to deploy (fail-closed).");
    }
    if (head3.head !== sha) {
      checks.push({
        check: "sha is the head of main (final)",
        result: `no — main is at ${head3.head}`,
      });
      return superseded(`${short(sha)} was superseded on main (now ${short(head3.head)}).`);
    }
    checks.push({ check: "sha is the head of main (final)", result: "yes" });
  }

  return finish(
    "deploy",
    mode === "wait"
      ? `CI${opts.stagingLeg ? " and staging" : ""} green on ${short(sha)}, which is the head of main.`
      : `Re-checked after approval: ${short(sha)} is still the head of main with CI${opts.stagingLeg ? " and staging" : ""} green.`,
  );
}

// ---------------------------------------------------------------------------
// CLI

export type GhExec = (args: string[]) => string;

/** `gh api` against the Actions REST endpoints. Injectable for tests. */
export function ghDeps(repo: string, gh: GhExec): GateDeps {
  return {
    async latestRun(workflow, sha) {
      const out = gh([
        "api",
        "-X",
        "GET",
        `repos/${repo}/actions/workflows/${workflow}/runs`,
        "-f",
        `head_sha=${sha}`,
        "-f",
        "branch=main",
        "-f",
        "per_page=30",
      ]);
      const body = JSON.parse(out) as { workflow_runs?: (RunInfo & { head_sha?: string })[] };
      // The API already filters by head_sha; re-filter so a run for another sha can never count.
      const runs = (body.workflow_runs ?? []).filter((r) => r.head_sha === sha);
      if (runs.length === 0) return null;
      // Newest first: a re-dispatched staging run supersedes an older failed one.
      runs.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? "") || b.id - a.id);
      return runs[0] ?? null;
    },
    async newerRun(workflow, sha, runId) {
      const out = gh([
        "api",
        "-X",
        "GET",
        `repos/${repo}/actions/workflows/${workflow}/runs`,
        "-f",
        "branch=main",
        "-f",
        "per_page=30",
      ]);
      const body = JSON.parse(out) as {
        workflow_runs?: (RunInfo & { head_sha?: string; event?: string })[];
      };
      const newer = (body.workflow_runs ?? []).filter(
        (r) =>
          (r.event === "push" || r.event === "workflow_dispatch") &&
          typeof r.head_sha === "string" &&
          r.head_sha !== sha &&
          r.id > runId,
      );
      newer.sort((a, b) => b.id - a.id);
      return newer[0] ?? null;
    },
    async mainHead() {
      const out = gh(["api", `repos/${repo}/git/ref/heads/main`, "--jq", ".object.sha"]).trim();
      if (!/^[0-9a-f]{40}$/.test(out))
        throw new Error(`unexpected head of main: ${JSON.stringify(out)}`);
      return out;
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}

export interface CliIo {
  env: Record<string, string | undefined>;
  deps?: GateDeps;
  gh?: GhExec;
  log?: (l: string) => void;
  writeOutput?: (text: string) => void;
  writeSummary?: (text: string) => void;
}

/**
 * Run the gate as the workflow does. Writes `deploy`, `outcome` and `sha` to
 * $GITHUB_OUTPUT. Exit 0 for deploy and superseded (with deploy=false), 1 for
 * fail, stranded and a misconfigured invocation. GITHUB_RUN_ID is the run's
 * own id (set by Actions in every step; in a reusable workflow, the caller's).
 */
export async function runCli(io: CliIo): Promise<{ code: number; decision: GateDecision | null }> {
  const log = io.log ?? ((l: string) => console.log(l));
  const env = io.env;
  const writeOutput =
    io.writeOutput ??
    ((t: string) => (env.GITHUB_OUTPUT ? appendFileSync(env.GITHUB_OUTPUT, t) : undefined));
  const writeSummary =
    io.writeSummary ??
    ((t: string) =>
      env.GITHUB_STEP_SUMMARY ? appendFileSync(env.GITHUB_STEP_SUMMARY, t) : undefined);

  const mode = env.GATE_MODE;
  const sha = env.GATE_SHA ?? "";
  const repo = env.GATE_REPO ?? "";
  const service = env.GATE_SERVICE ?? "";
  const leg = env.GATE_STAGING_LEG;
  const problems: string[] = [];
  if (mode !== "wait" && mode !== "recheck")
    problems.push(`GATE_MODE must be "wait" or "recheck" (got ${JSON.stringify(mode)})`);
  // Explicit, never defaulted: a missing value must not quietly drop the staging requirement.
  if (leg !== "true" && leg !== "false")
    problems.push(
      `GATE_STAGING_LEG must be exactly "true" or "false" (got ${JSON.stringify(leg)})`,
    );
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo))
    problems.push(`GATE_REPO must be owner/name (got ${JSON.stringify(repo)})`);
  if (!/^[a-z0-9-]+$/.test(service))
    problems.push(`GATE_SERVICE must be a service name (got ${JSON.stringify(service)})`);
  const runId = env.GITHUB_RUN_ID ?? "";
  if (!/^[1-9]\d*$/.test(runId))
    problems.push(`GITHUB_RUN_ID must be the run's numeric id (got ${JSON.stringify(runId)})`);
  if (problems.length > 0) {
    for (const p of problems) log(`::error title=Molecule production gate misconfigured::${p}`);
    writeOutput("deploy=false\noutcome=fail\n");
    return { code: 1, decision: null };
  }

  const gh: GhExec =
    io.gh ??
    ((args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  const deps = io.deps ?? ghDeps(repo, gh);
  const decision = await decideGate(
    deps,
    { sha, service, stagingLeg: leg === "true", mode: mode as GateMode, runId: Number(runId) },
    log,
  );
  for (const a of decision.annotations) log(a);
  writeOutput(
    `deploy=${decision.deploy ? "true" : "false"}\noutcome=${decision.outcome}\nsha=${sha}\n`,
  );
  writeSummary(decision.summary);
  return { code: decision.outcome === "fail" || decision.outcome === "stranded" ? 1 : 0, decision };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runCli({ env: process.env }).then(
    ({ code }) => process.exit(code),
    (err: unknown) => {
      console.log(
        `::error title=Molecule production gate crashed::${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    },
  );
}
