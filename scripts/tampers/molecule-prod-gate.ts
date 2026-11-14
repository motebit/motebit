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

const TAMPERS: TamperEntry[] = [
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
];

void runTampers(TAMPERS, { root: ROOT });
