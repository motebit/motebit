/**
 * Tamper checks for the molecule production gate (scripts/molecule-prod-gate.ts)
 * and the seven workflows wired to it.
 *
 * Each entry removes one rule — the CI-success check, the missing-staging
 * failure, the head-of-main (superseded) check, the explicit staging_leg,
 * the deploy job's gate condition, the pinned checkout, the single
 * no-staging exception — and names the test in
 * scripts/__tests__/molecule-prod-gate.test.ts that must go red.
 *
 *   node scripts/tampers/molecule-prod-gate.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runTampers, type TamperEdit, type TamperEntry } from "../lib/tamper-runner.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const SCRIPT = "scripts/molecule-prod-gate.ts";
const TEST = "scripts/__tests__/molecule-prod-gate.test.ts";

const CI = "decision: (a) CI on the exact sha";
const HEAD = "decision: (b) the sha must still be the head of main";
const STAGING = "decision: (c) staging on the exact sha";
const RECHECK = "decision: the post-approval re-check (recheck mode) never waits";
const WF = (svc: string, title: string) =>
  `the seven molecule prod workflows route every deploy through the gate deploy-${svc}.yml ${title}`;

const edit = (file: string, from: string, to: string): TamperEdit => ({ file, from, to });
/** Disable a one-term `if (` condition. */
const off = (from: string): TamperEdit =>
  edit(SCRIPT, from, from.replace("if (", "if ((false as boolean) && "));
const entry = (name: string, red: string, ...edits: TamperEdit[]): TamperEntry => ({
  name,
  test: TEST,
  red,
  edits,
});

const RECHECK_TITLE =
  "the post-approval re-check runs before any Fly step, on the pinned sha, and every later step depends on it";
const STRANDED = "decision: superseded only when a newer deploy run exists, else STRANDED";
const CANCELLED = "decision: CI cancelled because main moved is supersession, not a CI failure";

const TAMPERS: TamperEntry[] = [
  entry(
    "superseded no longer asks whether a newer deploy run exists (a stranded fix reads green)",
    `${STRANDED} no newer run within the grace (main moved via out-of-path commits): STRANDED, red, with the dispatch repair`,
    edit(SCRIPT, "      if (newer !== null) {", "      if ((true as boolean) || newer !== null) {"),
  ),
  entry(
    "a newer-run lookup error reads as superseded (green)",
    `${STRANDED} the newer-run lookup errors: fail (red), never green`,
    edit(
      SCRIPT,
      '        return finish(\n          "fail",\n          `${why} Could not check for a newer',
      '        return finish(\n          "superseded",\n          `${why} Could not check for a newer',
    ),
  ),
  entry(
    "the stranded repair drops the staging dispatch for a staging-leg service",
    `${STRANDED} no newer run within the grace (main moved via out-of-path commits): STRANDED, red, with the dispatch repair`,
    edit(
      SCRIPT,
      "strandedRepair(sha, opts.service, opts.stagingLeg)",
      "strandedRepair(sha, opts.service, false)",
    ),
  ),
  entry(
    "a CI cancelled by supersession is reported as a CI failure again",
    `${CANCELLED} CI cancelled on a sha main has left, newer run exists: superseded (green)`,
    off('    if (ci.run.conclusion === "cancelled") {'),
  ),
  entry(
    "any non-success CI on a superseded sha is treated as supersession",
    `${HEAD} CI red on a superseded sha still reports the CI failure`,
    edit(
      SCRIPT,
      '    if (ci.run.conclusion === "cancelled") {',
      '    if ((true as boolean) || ci.run.conclusion === "cancelled") {',
    ),
  ),
  entry(
    "the CI-success check is removed (a red CI deploys)",
    `${CI} CI failure: no deploy`,
    off('  if (ci.run.conclusion !== "success") {'),
  ),
  entry(
    "a missing staging run no longer fails (staging silently skipped)",
    `${STAGING} staging missing for the sha: FAIL with the repair instruction`,
    edit(
      SCRIPT,
      '      if (st.kind === "absent") {\n        return finish(\n          "fail",',
      '      if (st.kind === "absent") {\n        return finish(\n          "deploy",',
    ),
  ),
  entry(
    "the head-of-main check after CI is removed",
    `${HEAD} superseded after CI: no deploy, outcome superseded (not fail), explained`,
    off("  if (head1.head !== sha) {"),
  ),
  entry(
    "every head-of-main check is removed (approval after main moved deploys)",
    `${RECHECK} approval granted after main moved: no deploy`,
    off("  if (head1.head !== sha) {"),
    off("      if (head2.ok && head2.head !== sha) {"),
    off("    if (head3.head !== sha) {"),
  ),
  entry(
    "GATE_STAGING_LEG may be omitted (defaults instead of refusing)",
    "CLI: what the workflow sees GATE_STAGING_LEG missing or not exactly true/false: refused, never defaulted",
    off('  if (leg !== "true" && leg !== "false")'),
  ),
  entry(
    "the deploy job no longer depends on the gate's verdict",
    WF("clerk", "the deploy job needs the gate, runs only on deploy=='true', behind production"),
    edit(".github/workflows/deploy-clerk.yml", "    if: needs.gate.outputs.deploy == 'true'\n", ""),
  ),
  entry(
    "the deploy job checks out a floating ref",
    WF("research", "checks out the PINNED gated sha, never a floating ref"),
    edit(
      ".github/workflows/deploy-research.yml",
      "          ref: ${{ needs.gate.outputs.sha }}\n",
      "          ref: main\n",
    ),
  ),
  entry(
    "a step after the re-check runs regardless of it",
    WF(
      "web-search",
      "the post-approval re-check runs before any Fly step, on the pinned sha, and every later step depends on it",
    ),
    edit(
      ".github/workflows/deploy-web-search.yml",
      "      - name: Deploy to Fly.io\n        if: steps.recheck.outputs.deploy == 'true'\n",
      "      - name: Deploy to Fly.io\n",
    ),
  ),
  entry(
    "a second service drops its staging leg",
    "the seven molecule prod workflows route every deploy through the gate code-review is the ONLY caller without a staging leg",
    edit(
      ".github/workflows/deploy-auditor.yml",
      "      staging_leg: true\n",
      "      staging_leg: false\n",
    ),
  ),
  entry(
    // Locks the documented LIVENESS choice (a newer pending promotion is not
    // evicted); it does not prove a security property — safety is the re-check.
    "the queue: max liveness control is dropped from a deploy job",
    WF(
      "summarize",
      "promotions serialize per service, queued (liveness), never cancelled; no workflow-level group",
    ),
    edit(
      ".github/workflows/deploy-summarize.yml",
      "      group: production-deploy-summarize\n      queue: max\n",
      "      group: production-deploy-summarize\n",
    ),
  ),
  entry(
    "the Fly deploy step runs under always() || the re-check verdict",
    WF("read-url", RECHECK_TITLE),
    edit(
      ".github/workflows/deploy-read-url.yml",
      "      - name: Deploy to Fly.io\n        if: steps.recheck.outputs.deploy == 'true'\n",
      "      - name: Deploy to Fly.io\n        if: always() || steps.recheck.outputs.deploy == 'true'\n",
    ),
  ),
  entry(
    "the re-check reads an in-progress staging run as a success",
    `${RECHECK} staging still in progress or queued at deploy time: refused, not deploy`,
    edit(
      SCRIPT,
      '          : run.status === "completed"\n            ? { kind: "completed", run }',
      '          : (true as boolean)\n            ? { kind: "completed", run: { ...run, status: "completed", conclusion: "success" } }',
    ),
  ),
  entry(
    "the re-check reads another repository's runs",
    WF("summarize", RECHECK_TITLE),
    edit(
      ".github/workflows/deploy-summarize.yml",
      "          GATE_REPO: ${{ github.repository }}\n",
      "          GATE_REPO: someone/fork\n",
    ),
  ),
  entry(
    "the pre-approval gate reads another repository's runs",
    "the reusable gate workflow runs the script in wait mode on github.sha with least privilege",
    edit(
      ".github/workflows/molecule-prod-gate.yml",
      "          GATE_REPO: ${{ github.repository }}\n",
      "          GATE_REPO: someone/fork\n",
    ),
  ),
  entry(
    "a staging-leg deploy workflow re-adds its own file to its push paths (staging never runs for it)",
    "the seven molecule prod workflows route every deploy through the gate every staging-leg deploy workflow triggers only on paths the staging slate also triggers on",
    edit(
      ".github/workflows/deploy-clerk.yml",
      '      - "services/clerk/**"\n',
      '      - "services/clerk/**"\n      - ".github/workflows/deploy-clerk.yml"\n',
    ),
  ),
  entry(
    "the poll interval goes back to 15 s (seven gates exhaust the repo's API budget)",
    "API budget: the gate's GitHub REST calls per job a 35-minute CI then a 15-minute staging, at the default cadence: deploy within 30 calls",
    edit(SCRIPT, "  pollMs: 120_000,", "  pollMs: 15_000,"),
  ),
  entry(
    "a CI run from workflow_dispatch (or any event) counts as CI evidence",
    "CLI: what the workflow sees the gh adapter counts CI only from push, staging from push or workflow_dispatch",
    edit(
      SCRIPT,
      'const events = workflow === CI_WORKFLOW ? ["push"] : ["push", "workflow_dispatch"];',
      'const events = workflow === CI_WORKFLOW ? ["push", "workflow_dispatch"] : ["push", "workflow_dispatch"];',
    ),
  ),
  entry(
    "the event filter is dropped (pull_request or schedule runs count)",
    "CLI: what the workflow sees the gh adapter counts CI only from push, staging from push or workflow_dispatch",
    edit(SCRIPT, "events.includes(r.event)", "(true as boolean)"),
  ),
];

void runTampers(TAMPERS, { root: ROOT });
