#!/usr/bin/env node
// Tamper check for classify-autonomy-tier.test.ts, autonomy-tier-verdict.test.ts
// and autonomy-tier-workflow.test.ts (the contract phase of the trigger migration).
//
// Each entry reverts (part of) one rule of the autonomy boundary — an
// allowlist exclusion, a widening of the allowlist, a rule of the path-policy
// interpreter (strict parse, grammar, case folding, include descent), where the
// policy is read from, a fail-closed rule, the CODEOWNERS defence in depth, or
// a verdict rule — and names the test expected to go red. The shared runner (scripts/lib/tamper-runner.ts)
// applies each tamper in an isolated copy of the tree.
//
//   node scripts/__tests__/autonomy-tier.tampers.mjs

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runTampers } from "../lib/tamper-runner.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLASSIFIER = "scripts/classify-autonomy-tier.ts";
// The T0 allowlist, as data, and its one interpreter (shared with the repo-change verifier).
const POLICY = ".motebit/repo-path-policy.json";
const INTERPRETER = "packages/verifier/src/repo-path-policy.ts";
const VERDICT = "scripts/autonomy-tier-verdict.ts";
const CLASSIFIER_TEST = "scripts/__tests__/classify-autonomy-tier.test.ts";
const VERDICT_TEST = "scripts/__tests__/autonomy-tier-verdict.test.ts";
const WORKFLOW = ".github/workflows/autonomy-tier.yml";
const WORKFLOW_TEST = "scripts/__tests__/autonomy-tier-workflow.test.ts";
const EXACT =
  "the autonomy-tier workflow's exact shape (the authority) equals the expected shape exactly: every key, every step, every value";
const E2E = (title) =>
  `the contract script end to end: every event it judges, the same verdict ${title}`;
const PROV = (title) =>
  `policy provenance (the primary self-check): the policy that ran is the revision selected for the event ${title}`;
const TRIP = (title) => `policy provenance: the secondary tripwire ${title}`;
const PASSES =
  "the autonomy-tier workflow's triggers passes the repository variable and the policy and head refs to the verdict step";
const SUBJ =
  "the autonomy-tier workflow's pull_request_target safety nothing in the whole workflow names subject but the fetch step's store and the verdict's --subject argument";
const FORK = (title) => `a fork PR on pull_request_target (head.repo.id != repository.id) ${title}`;
const NO_PR_CHECKOUT = FORK(
  "no checkout step checks out PR code, so actions/checkout's unsafe-PR guard never fires, and no step disables it",
);
const FETCHED = FORK(
  "the change is fetched as git objects into a bare store, from this repository, never the fork",
);
const STORE = '"$GITHUB_WORKSPACE/subject.git"';
const PR_TYPES = "opened, synchronize, reopened, ready_for_review, edited";
// The per-event policy revision expression, as the workflow spells it (checkout ref and verdict env).
const POLICY_REF =
  "${{ github.event_name == 'merge_group' && github.event.merge_group.base_sha || github.event_name == 'pull_request_target' && github.sha || (github.event_name == 'pull_request' || github.event_name == 'pull_request_review') && github.event.pull_request.base.sha || 'no-policy-revision-for-this-event' }}";

const T1 = (name) => `must-T1 fixtures T1: ${name}`;
const POLICY_DATA = "the path policy as data (.motebit/repo-path-policy.json)";
const DIFFERENTIAL = `${POLICY_DATA} differential: the interpreter gives the frozen regex predicate's isAllowlisted and caseCollision on every tracked, generated and adversarial path`;
const OFF = (text) => text.replace(/^(\s*(?:else )?)if \(/, "$1if ((false as boolean) && ");
const off = (text, red, test) => ({
  file: test === VERDICT_TEST ? VERDICT : CLASSIFIER,
  text,
  replacement: OFF(text),
  red,
  test,
});
const dropLine = (line) => ({ file: POLICY, text: `${line}\n`, replacement: "" });

const TAMPERS = [
  // One per allowlist exclusion.
  {
    name: "allowlist: docs/doctrine/** is not excluded",
    ...dropLine('    "docs/doctrine/**",'),
    red: T1("a doctrine edit (docs/doctrine/**)"),
  },
  {
    name: "allowlist: docs/proposals/** is not excluded",
    ...dropLine('    "docs/proposals/**",'),
    red: T1("a proposal edit (docs/proposals/**)"),
  },
  {
    name: "allowlist: docs/ops/** is not excluded",
    ...dropLine('    "docs/ops/**",'),
    red: T1("a runbook edit (docs/ops/**)"),
  },
  {
    name: "allowlist: docs/design/** is not excluded",
    ...dropLine('    "docs/design/**",'),
    red: T1("a design edit (docs/design/**)"),
  },
  {
    name: "allowlist: docs/drift-defenses.md is not excluded",
    ...dropLine('    "docs/drift-defenses.md",'),
    red: T1("the drift-defense inventory (docs/drift-defenses.md)"),
  },
  {
    name: "allowlist: docs/operator/** is not excluded",
    ...dropLine('    "docs/operator/**",'),
    red: T1("an operator doc's image pin (docs/operator/self-host.md)"),
  },
  // Agent-instruction exclusions (each also holds under docs/).
  {
    name: "allowlist: **/CLAUDE.md is not excluded",
    ...dropLine('    "**/CLAUDE.md",'),
    red: T1("docs/CLAUDE.md (agent instructions under docs/)"),
  },
  {
    name: "allowlist: **/AGENTS.md is not excluded",
    ...dropLine('    "**/AGENTS.md",'),
    red: T1("docs/AGENTS.md"),
  },
  {
    name: "allowlist: **/.claude/** is not excluded",
    ...dropLine('    "**/.claude/**",'),
    red: T1("docs/.claude/agents/reviewer.md"),
  },
  {
    name: "allowlist: **/SKILL.md is not excluded",
    ...dropLine('    "**/SKILL.md",'),
    red: T1("docs/guides/SKILL.md (a skill outside .claude/)"),
  },
  // Widening.
  {
    name: "allowlist re-admits apps/docs content (mdx)",
    file: POLICY,
    text: '  "include": ["docs/**/*.md", "scripts/bench/*/prompts.json"],',
    replacement:
      '  "include": ["docs/**/*.md", "apps/docs/content/**/*.mdx", "scripts/bench/*/prompts.json"],',
    red: T1("the docs quickstart's runnable block exfiltrates CI env (check-docs-quickstart-runs)"),
  },
  {
    name: "allowlist re-admits apps/docs content (md)",
    file: POLICY,
    text: '  "include": ["docs/**/*.md", "scripts/bench/*/prompts.json"],',
    replacement:
      '  "include": ["docs/**/*.md", "apps/docs/content/**/*.md", "scripts/bench/*/prompts.json"],',
    red: T1("an apps/docs markdown page (same pipeline as MDX)"),
  },
  {
    name: "allowlist widened to **/*.md (README becomes T0)",
    file: POLICY,
    text: '  "include": ["docs/**/*.md", "scripts/bench/*/prompts.json"],',
    replacement: '  "include": ["**/*.md", "scripts/bench/*/prompts.json"],',
    red: T1("README.md"),
  },
  {
    name: "allowlist widened to **/*.md (DOCTRINE.md becomes T0)",
    file: POLICY,
    text: '  "include": ["docs/**/*.md", "scripts/bench/*/prompts.json"],',
    replacement: '  "include": ["**/*.md", "scripts/bench/*/prompts.json"],',
    red: T1("DOCTRINE.md"),
  },
  {
    name: "allowlist widened back to scripts/bench/**/*.json (bench tool config becomes T0)",
    file: POLICY,
    text: '  "include": ["docs/**/*.md", "scripts/bench/*/prompts.json"],',
    replacement: '  "include": ["docs/**/*.md", "scripts/bench/**/*.json"],',
    red: T1("bench tool config: package.json (flips the bench's module format)"),
  },
  {
    name: "interpreter: an include covers a directory named like its file (include descent)",
    file: INTERPRETER,
    text: "  return compiledOf(policy).include.some((pat) => matchesFile(pat, path));",
    replacement:
      "  return compiledOf(policy).include.some((pat) => matchesWithDescent(pat, path, false));",
    red: T1(
      "a directory named prompts.json (an include names files, never a directory's contents)",
    ),
  },
  {
    name: "allowlist: docs/security/** is not excluded",
    ...dropLine('    "docs/security/**",'),
    red: T1("docs/security/** (the accepted-CVE ledger)"),
  },
  {
    name: "allowlist: **/GEMINI.md is not excluded",
    ...dropLine('    "**/GEMINI.md",'),
    red: T1("docs/GEMINI.md"),
  },
  {
    name: "allowlist: **/CLAUDE.local.md is not excluded",
    ...dropLine('    "**/CLAUDE.local.md",'),
    red: T1("docs/CLAUDE.local.md"),
  },
  {
    name: "allowlist: **/copilot-instructions.md is not excluded",
    ...dropLine('    "**/copilot-instructions.md",'),
    red: T1("docs/copilot-instructions.md"),
  },
  {
    name: "allowlist: **/.agents/** is not excluded",
    ...dropLine('    "**/.agents/**",'),
    red: T1("docs/.agents/x.md"),
  },
  {
    name: "allowlist: **/.cursor/** is not excluded",
    ...dropLine('    "**/.cursor/**",'),
    red: T1("docs/.cursor/rules/x.md"),
  },
  // Case.
  {
    name: "interpreter: exclusions match case-sensitively (case folding dropped)",
    file: INTERPRETER,
    text: "  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));",
    replacement: "  return s;",
    red: T1("a lower-case claude.md (exclusions hold whatever the case)"),
  },
  // The path policy: strict parse, closed grammar, the differential's edges,
  // and where it is read from.
  {
    name: "interpreter: an unknown key in the policy is accepted",
    file: INTERPRETER,
    text: "    if (!(POLICY_KEYS as readonly string[]).includes(k)) fail(`unknown key \\`${k}\\``);",
    replacement:
      "    if ((false as boolean) && !(POLICY_KEYS as readonly string[]).includes(k)) fail(`unknown key \\`${k}\\``);",
    red: `${POLICY_DATA} a path policy with an unknown key is a T1 classifier-error, never a classification`,
  },
  {
    name: "interpreter: a pattern outside the grammar is accepted",
    file: INTERPRETER,
    text: "    if (!GLOB.test(seg)) {",
    replacement: "    if ((false as boolean) && !GLOB.test(seg)) {",
    red: `${POLICY_DATA} a path policy with an out-of-grammar include is a T1 classifier-error, never a classification`,
  },
  {
    name: "interpreter: a path with a line terminator is no longer refused",
    file: INTERPRETER,
    text: "  if (LINE_TERMINATORS.some((t) => path.includes(t))) return false;\n",
    replacement: "",
    red: `${POLICY_DATA} differential: on a path with a line terminator the interpreter only narrows (the frozen regex's \`.\` stops at one)`,
  },
  {
    name: "interpreter: a repeated member name is accepted (the last copy wins)",
    file: INTERPRETER,
    text: "  if (repeated !== null) fail(`member name ${JSON.stringify(repeated)} is repeated in one object`);\n",
    replacement: "",
    red: `${POLICY_DATA} a path policy with a repeated member name is a T1 classifier-error, never a classification`,
  },
  {
    name: "interpreter: a hand-built policy is cached by identity (a later mutation is not seen)",
    file: INTERPRETER,
    text: "  return compiledCache.get(policy) ?? compilePolicy(policy);",
    replacement:
      "  let c = compiledCache.get(policy);\n  if (c === undefined) {\n    c = compilePolicy(policy);\n    compiledCache.set(policy, c);\n  }\n  return c;",
    red: "parseRepoPathPolicy strict shape a policy object built by hand is judged as it is at each use, never from a stale compile",
    test: "packages/verifier/src/__tests__/repo-path-policy.test.ts",
  },
  {
    name: "interpreter: a last ** also covers zero segments (the directory itself)",
    file: INTERPRETER,
    text: "    if (i === pat.length - 1) return segs.length - j >= 1;",
    replacement: "    if (i === pat.length - 1) return segs.length - j >= 0;",
    red: DIFFERENTIAL,
  },
  {
    name: "interpreter: exclude descent through a bare trailing slash",
    file: INTERPRETER,
    text: '    if (segs.slice(k).join("/") === "") continue;\n',
    replacement: "",
    red: DIFFERENTIAL,
  },
  {
    name: "classifier: the path policy is read from the diff's head, not the trusted base",
    file: CLASSIFIER,
    text: "    pathPolicy = readTrustedPathPolicy();",
    replacement:
      '    pathPolicy = execFileSync("git", ["show", `${headRev}:${REPO_PATH_POLICY_FILE}`], { cwd: repo, env: cleanEnv(), encoding: "utf-8" });',
    red: "against a real git repository (git diff --find-renames base...head) reads the path policy from the trusted checkout, never from the subject repository or the diff's head",
  },
  off(
    '        if (caseHit !== null) fire("case-collision"',
    T1("docs/Proofs/live-sovereign-migration.md (case of a tracked directory)"),
  ),
  // Fail-closed.
  off('      if (f.renamed) fire("rename"', T1("a rename within docs/ (both names allowlisted)")),
  off('      if (f.newPath === null) fire("deletion"', T1("a deleted doc")),
  off('      if (f.binary) fire("binary"', T1("binary content at an allowlisted path")),
  {
    name: "fail-closed: a mode change is accepted",
    edits: [
      {
        file: CLASSIFIER,
        from: '        else fire("mode-change", label, `file mode ${mode}`);',
        to: "        else void mode;",
      },
      {
        file: CLASSIFIER,
        from: "      if (f.oldMode !== null && f.newMode !== null && f.oldMode !== f.newMode) {",
        to: "      if ((false as boolean) && f.oldMode !== null && f.newMode !== null && f.oldMode !== f.newMode) {",
      },
    ],
    red: T1("a mode-only change on an allowlisted doc"),
  },
  off('    if (input.diff.trim() === "") {', T1("empty diff")),
  // Defence in depth.
  off(
    "        if (r && r.owners.length > 0) {",
    T1("an allowlisted path that becomes owned is T1"),
  ),
  // Verdict.
  off(
    '  if (pr.tier !== "T0") {',
    "the named design cases FAILS when motebit-reviewer approved a T1 PR",
    VERDICT_TEST,
  ),
  {
    name: "verdict: any other approval lifts an engaged kill switch (the public-repo bypass)",
    file: VERDICT,
    text: "  if (killSwitchEngaged(autonomyT0)) {",
    replacement:
      "  if (killSwitchEngaged(autonomyT0) && !approved.some(([l]) => l !== lower(MACHINE_REVIEWER))) {",
    red: "the named design cases an outsider's approval beside the machine's does not lift an engaged kill switch",
    test: VERDICT_TEST,
  },
  {
    name: "verdict: a founder approval counts whatever its author_association",
    file: VERDICT,
    text: '      r.commitId === pr.headSha &&\n      TRUSTED_ASSOCIATIONS.has(r.association ?? ""),',
    replacement: "      r.commitId === pr.headSha,",
    red: "the named design cases a founder-login approval without a trusted association does not count",
    test: VERDICT_TEST,
  },
  {
    name: "verdict: a later machine review un-binds an earlier machine approval",
    file: VERDICT,
    text: '    (r) => lower(r.login) === lower(MACHINE_REVIEWER) && r.state === "APPROVED",\n  );',
    replacement:
      '    (r) => lower(r.login) === lower(MACHINE_REVIEWER) && r.state === "APPROVED" && standing.get(lower(MACHINE_REVIEWER)) === r,\n  );',
    red: "the named design cases a machine approval binds for good, even after a later dismissed machine review",
    test: VERDICT_TEST,
  },
  {
    name: "verdict: an unset kill-switch variable leaves autonomy on",
    file: VERDICT,
    text: '  return value !== "on";',
    replacement: '  return value === "off";',
    red: "the named design cases an unset kill-switch variable engages it (fail closed)",
    test: VERDICT_TEST,
  },
  {
    name: "verdict: a stale founder approval carries a later head",
    file: VERDICT,
    text: "      r.commitId === pr.headSha &&\n      TRUSTED_ASSOCIATIONS",
    replacement: "      TRUSTED_ASSOCIATIONS",
    red: "the named design cases a STALE founder approval does not carry a machine-approved T1 head",
    test: VERDICT_TEST,
  },
  {
    // Parenthesized so `last` keeps its narrowing and the edit type-checks.
    name: "verdict: a merge group whose queue ref names an outside PR is accepted",
    file: VERDICT,
    text: "  if (!last || !out.some((c) => c.number === Number(last[1]))) {",
    replacement:
      "  if ((false as boolean) && (!last || !out.some((c) => c.number === Number(last[1])))) {",
    red: "mergeGroupPrs fails closed when the queue ref's PR is not in the group",
    test: VERDICT_TEST,
  },
  off(
    "    if (seen.has(c.number)) {",
    "mergeGroupPrs fails closed when one PR is named on more than one commit",
    VERDICT_TEST,
  ),

  // The trigger migration (expand → verify → contract), CONTRACT step: only
  // pull_request_target and merge_group, AUTONOMY_T0 read. The contract-only
  // entries (pull_request / pull_request_review back) return; the expand-only
  // "acts on AUTONOMY_T0" entries retire (acting on it is now the rule).
  {
    name: "contract: the verdict ignores AUTONOMY_T0 (the switch never opens)",
    file: VERDICT,
    text: "  const verdict = withProvenance(decide(prs, killSwitch.value), provenanceFailures(prov));",
    replacement:
      "  const verdict = withProvenance(decide(prs, EXPAND_SWITCH_VALUE), provenanceFailures(prov));",
    red: E2E(
      "every event the contract script judges gives the same verdict for the same PR state and AUTONOMY_T0; only the exact value on opens the switch",
    ),
    test: WORKFLOW_TEST,
  },
  {
    name: "contract: one event (merge_group) ignores AUTONOMY_T0",
    file: VERDICT,
    text: "  const killSwitch = switchForVerdict(env.AUTONOMY_T0);",
    replacement:
      '  const killSwitch = switchForVerdict(env.AUTONOMY_T0, eventName === "merge_group" ? "expand" : MIGRATION_PHASE);',
    red: E2E(
      "every event the contract script judges gives the same verdict for the same PR state and AUTONOMY_T0; only the exact value on opens the switch",
    ),
    test: WORKFLOW_TEST,
  },
  {
    name: "contract: switchForVerdict ignores the value in contract",
    file: VERDICT,
    text: "    return {\n      value: observed,",
    replacement: "    return {\n      value: EXPAND_SWITCH_VALUE,",
    red: "the kill switch during expand contract judges the value as read",
    test: WORKFLOW_TEST,
  },
  {
    name: "contract: any value but on opens the switch",
    file: VERDICT,
    text: '  return value !== "on";',
    replacement: '  return value !== "on" && value !== "ON";',
    red: E2E(
      "every event the contract script judges gives the same verdict for the same PR state and AUTONOMY_T0; only the exact value on opens the switch",
    ),
    test: WORKFLOW_TEST,
  },
  {
    name: "expand: switchForVerdict passes the observed value through",
    file: VERDICT,
    text: "      value: EXPAND_SWITCH_VALUE,",
    replacement: "      value: observed,",
    red: "the kill switch during expand is engaged whatever AUTONOMY_T0 reads, and the observed value is logged",
    test: WORKFLOW_TEST,
  },
  {
    name: "the observed value is no longer logged",
    file: VERDICT,
    text: "  process.stdout.write(`${killSwitch.log}\\n`);",
    replacement: "",
    red: E2E("logs the observed AUTONOMY_T0 and that it is read"),
    test: WORKFLOW_TEST,
  },
  {
    name: "phase: MIGRATION_PHASE flipped back to expand without the trigger set",
    file: VERDICT,
    text: 'export const MIGRATION_PHASE: MigrationPhase = "contract";',
    replacement: 'export const MIGRATION_PHASE: MigrationPhase = "expand";',
    red: "the autonomy-tier workflow's triggers the triggers are exactly the current phase's judged events (PHASE_EVENTS[MIGRATION_PHASE])",
    test: WORKFLOW_TEST,
  },
  {
    name: "phase: expand stops judging pull_request_review",
    file: VERDICT,
    text: '  expand: ["merge_group", "pull_request", "pull_request_review", "pull_request_target"],',
    replacement: '  expand: ["merge_group", "pull_request", "pull_request_target"],',
    red: "judgedEvent: the phase's events are judged, nothing else expand judges all four events: pull_request, pull_request_review and pull_request_target as a PR, merge_group as a queue group",
    test: WORKFLOW_TEST,
  },
  {
    name: "verdict: a pull_request run is judged again (contract)",
    file: VERDICT,
    text: '  contract: ["merge_group", "pull_request_target"],',
    replacement: '  contract: ["merge_group", "pull_request", "pull_request_target"],',
    red: "judgedEvent: the phase's events are judged, nothing else contract judges pull_request_target and merge_group only",
    test: WORKFLOW_TEST,
  },
  {
    name: "phase: an event outside the set is judged as a PR",
    file: VERDICT,
    text: "  if (!events.includes(eventName)) {",
    replacement: '  if (!events.includes(eventName) && eventName !== "push") {',
    red: "judgedEvent: the phase's events are judged, nothing else refuses any other event, and an empty name, in either phase",
    test: WORKFLOW_TEST,
  },
  {
    name: "workflow: back on pull_request (fork runs get no variables)",
    file: WORKFLOW,
    text: "on:\n  pull_request_target:\n",
    replacement: `on:\n  pull_request:\n    branches: [main]\n    types: [${PR_TYPES}]\n  pull_request_target:\n`,
    red: "the autonomy-tier workflow's triggers triggers on exactly the contract set: pull_request_target and merge_group",
    test: WORKFLOW_TEST,
  },
  {
    name: "workflow: the pull_request_review trigger is back",
    file: WORKFLOW,
    text: "  merge_group:\n    types: [checks_requested]\n",
    replacement:
      "  merge_group:\n    types: [checks_requested]\n  pull_request_review:\n    types: [submitted, edited, dismissed]\n",
    red: "the autonomy-tier workflow's triggers triggers on exactly the contract set: pull_request_target and merge_group",
    test: WORKFLOW_TEST,
  },
  ...[
    [
      "pull_request_target",
      `  pull_request_target:\n    branches: [main]\n    types: [${PR_TYPES}]\n`,
    ],
    ["merge_group", "  merge_group:\n    types: [checks_requested]\n"],
  ].map(([event, block]) => ({
    name: `workflow: the ${event} trigger is dropped`,
    file: WORKFLOW,
    text: block,
    replacement: "",
    red: "the autonomy-tier workflow's triggers triggers on exactly the contract set: pull_request_target and merge_group",
    test: WORKFLOW_TEST,
  })),
  {
    name: "workflow: merge_group dropped (the queue's judgement) — the phase set disagrees",
    file: WORKFLOW,
    text: "  merge_group:\n    types: [checks_requested]\n",
    replacement: "",
    red: "the autonomy-tier workflow's triggers the triggers are exactly the current phase's judged events (PHASE_EVENTS[MIGRATION_PHASE])",
    test: WORKFLOW_TEST,
  },
  {
    name: "workflow: a push is no longer re-judged on pull_request_target",
    file: WORKFLOW,
    text: `  pull_request_target:\n    branches: [main]\n    types: [${PR_TYPES}]\n`,
    replacement:
      "  pull_request_target:\n    branches: [main]\n    types: [opened, reopened, ready_for_review, edited]\n",
    red: "the autonomy-tier workflow's triggers pull_request_target covers every PR-side change into main; the queue is judged",
    test: WORKFLOW_TEST,
  },
  {
    name: "workflow: the concurrency group drops the event name (one event cancels another)",
    file: WORKFLOW,
    text: "  group: autonomy-tier-${{ github.event_name }}-${{",
    replacement: "  group: autonomy-tier-${{",
    red: "the autonomy-tier workflow's triggers one event's run never shares a concurrency group with (or cancels) another event's run on the same PR",
    test: WORKFLOW_TEST,
  },
  {
    name: "workflow: the job is skipped on some event (a skip reports success)",
    file: WORKFLOW,
    text: "    runs-on: ubuntu-latest\n",
    replacement: "    if: github.event_name != 'pull_request_review'\n    runs-on: ubuntu-latest\n",
    red: "the autonomy-tier workflow's triggers is one job named autonomy-tier with no job-level if (a skipped job reports success)",
    test: WORKFLOW_TEST,
  },
  {
    name: "workflow: the kill switch is no longer passed from the variable",
    file: WORKFLOW,
    text: "          AUTONOMY_T0: ${{ vars.AUTONOMY_T0 }}\n",
    replacement: "          AUTONOMY_T0: on\n",
    red: PASSES,
    test: WORKFLOW_TEST,
  },
  {
    name: "workflow: EXPECTED_POLICY_SHA is not the checkout's expression",
    file: WORKFLOW,
    text: `          EXPECTED_POLICY_SHA: ${POLICY_REF}\n`,
    replacement: "          EXPECTED_POLICY_SHA: ${{ github.sha }}\n",
    red: PASSES,
    test: WORKFLOW_TEST,
  },
  {
    name: "workflow: EVENT_HEAD_SHA is not the head checkout's expression",
    file: WORKFLOW,
    text: `          EXPECTED_POLICY_SHA: ${POLICY_REF}\n          EVENT_HEAD_SHA: \${{ github.event.pull_request.head.sha || github.event.merge_group.head_sha }}\n`,
    replacement: `          EXPECTED_POLICY_SHA: ${POLICY_REF}\n          EVENT_HEAD_SHA: \${{ github.sha }}\n`,
    red: PASSES,
    test: WORKFLOW_TEST,
  },
  // The policy revision, per event.
  {
    name: "workflow: the policy revision is github.sha on pull_request (the PR merge commit)",
    file: WORKFLOW,
    text: `          ref: ${POLICY_REF}\n`,
    replacement: `          ref: ${POLICY_REF.replace("&& github.event.pull_request.base.sha ||", "&& github.sha ||")}\n`,
    red: "the policy revision, evaluated per event pull_request and pull_request_review take the PR's base sha, never github.sha (the merge commit)",
    test: WORKFLOW_TEST,
  },
  {
    // Retargeted: the contract version's pwn-request entry, on the expand expression.
    name: "workflow: the policy revision is the PR head (the pwn request)",
    file: WORKFLOW,
    text: `          ref: ${POLICY_REF}\n`,
    replacement: `          ref: ${POLICY_REF.replace("&& github.event.pull_request.base.sha ||", "&& github.event.pull_request.head.sha ||")}\n`,
    red: "the policy revision, evaluated per event no event takes a head: never the PR head, the merge commit or the queue commit",
    test: WORKFLOW_TEST,
  },
  {
    name: "workflow: the policy revision is the queue commit on merge_group",
    file: WORKFLOW,
    text: `          ref: ${POLICY_REF}\n`,
    replacement: `          ref: ${POLICY_REF.replace("&& github.event.merge_group.base_sha ||", "&& github.sha ||")}\n`,
    red: "the policy revision, evaluated per event no event takes a head: never the PR head, the merge commit or the queue commit",
    test: WORKFLOW_TEST,
  },
  {
    name: "workflow: an unknown event falls back to github.sha",
    file: WORKFLOW,
    text: `          ref: ${POLICY_REF}\n`,
    replacement: `          ref: ${POLICY_REF.replace("'no-policy-revision-for-this-event'", "github.sha")}\n`,
    red: "the policy revision, evaluated per event any other event resolves to no revision (the checkout fails closed)",
    test: WORKFLOW_TEST,
  },
  {
    name: "workflow: the policy checkout drops the history the ancestry check needs",
    file: WORKFLOW,
    text: "          path: trusted\n          # Full history, so origin/main is present for the ancestry check.\n          fetch-depth: 0\n",
    replacement: "          path: trusted\n",
    red: EXACT,
    test: WORKFLOW_TEST,
  },
  // The change is git objects only (actions/checkout v7 refuses a fork PR's
  // head on pull_request_target; this workflow checks out no PR code at all).
  {
    name: "fork: the head checkout (and so the unsafe-PR guard) is back",
    file: WORKFLOW,
    text: "      - name: Fetch the change as git objects only (no working tree, never executed)\n",
    replacement:
      "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          ref: ${{ github.event.pull_request.head.sha || github.event.merge_group.head_sha }}\n          path: pr\n          persist-credentials: false\n\n      - name: Fetch the change as git objects only (no working tree, never executed)\n",
    red: NO_PR_CHECKOUT,
    test: WORKFLOW_TEST,
  },
  {
    name: "fork: the unsafe-PR guard is switched off on the checkout",
    file: WORKFLOW,
    text: "          fetch-depth: 0\n          persist-credentials: false\n",
    replacement:
      "          fetch-depth: 0\n          persist-credentials: false\n          allow-unsafe-pr-checkout: true\n",
    red: NO_PR_CHECKOUT,
    test: WORKFLOW_TEST,
  },
  {
    name: "fork: the store is not bare (a working tree of PR code)",
    file: WORKFLOW,
    text: `          git init --quiet --bare ${STORE} &&\n`,
    replacement: `          git init --quiet ${STORE} &&\n`,
    red: FETCHED,
    test: WORKFLOW_TEST,
  },
  {
    name: "fork: the PR tree is materialised from the store",
    file: WORKFLOW,
    text: '          "+$EVENT_HEAD_SHA:refs/autonomy-tier/head"\n',
    replacement: `          "+$EVENT_HEAD_SHA:refs/autonomy-tier/head" &&\n          git -C ${STORE} --work-tree=../pr checkout -f refs/autonomy-tier/head\n`,
    red: FETCHED,
    test: WORKFLOW_TEST,
  },
  {
    name: "fork: a step runs with the PR tree as its cwd",
    file: WORKFLOW,
    text: "      - name: Classify and decide\n        working-directory: trusted\n",
    replacement: "      - name: Classify and decide\n        working-directory: pr\n",
    red: "the autonomy-tier workflow's pull_request_target safety every run step works in trusted/, never in the PR head",
    test: WORKFLOW_TEST,
  },
  {
    name: "fork: the change is fetched from the fork's repository",
    file: WORKFLOW,
    text: '          "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY"\n',
    replacement: '          "$GITHUB_SERVER_URL/$HEAD_REPO"\n',
    red: FETCHED,
    test: WORKFLOW_TEST,
  },
  {
    name: "fork: the head is not fetched (the verdict cannot judge it)",
    file: WORKFLOW,
    text: '          "+$EVENT_BASE_SHA:refs/autonomy-tier/base"\n          "+$EVENT_HEAD_SHA:refs/autonomy-tier/head"\n',
    replacement: '          "+$EVENT_BASE_SHA:refs/autonomy-tier/base"\n',
    red: E2E(
      "the fetch step, run as written, takes a fork PR's head from the base repository's refs/pull/N/head into a bare store the verdict judges from",
    ),
    test: WORKFLOW_TEST,
  },
  // Policy provenance (the primary self-check), then the secondary tripwire.
  {
    name: "provenance: the check is removed from the verdict",
    file: VERDICT,
    text: "  const verdict = withProvenance(decide(prs, killSwitch.value), provenanceFailures(prov));",
    replacement: "  const verdict = withProvenance(decide(prs, killSwitch.value), []);",
    red: E2E("fails policy-provenance when the policy checkout is not the expected revision"),
    test: WORKFLOW_TEST,
  },
  {
    name: "provenance: a policy/expected mismatch is tolerated",
    file: VERDICT,
    text: "  if (policy !== p.expected_policy_sha) {",
    replacement: "  if ((false as boolean) && policy !== p.expected_policy_sha) {",
    red: PROV("fails when the policy checkout is not the expected revision"),
    test: WORKFLOW_TEST,
  },
  {
    name: "provenance: the workflow's expected revision is not cross-checked against the event",
    file: VERDICT,
    text: "  if (p.event_policy_ref === null || p.expected_policy_sha !== p.event_policy_ref) {",
    replacement:
      "  if ((false as boolean) && (p.event_policy_ref === null || p.expected_policy_sha !== p.event_policy_ref)) {",
    red: PROV("fails when the workflow's expected revision is not the event's own trusted ref"),
    test: WORKFLOW_TEST,
  },
  {
    name: "provenance: eventPolicyRef takes github.sha on pull_request",
    file: VERDICT,
    text: '    case "pull_request_review":\n      return event.pull_request?.base?.sha ?? null;',
    replacement: '    case "pull_request_review":\n      return githubSha ?? null;',
    red: PROV(
      "eventPolicyRef derives each event's authorized revision from GitHub-set event fields, as the workflow does",
    ),
    test: WORKFLOW_TEST,
  },
  {
    name: "provenance: the ancestry rule is removed",
    file: VERDICT,
    text: "  if (ANCESTRY_CHECKED_EVENTS.has(p.event) && p.policy_on_main !== true) {",
    replacement:
      "  if ((false as boolean) && ANCESTRY_CHECKED_EVENTS.has(p.event) && p.policy_on_main !== true) {",
    red: PROV(
      "fails on a PR event when the policy is not on main, or was not checked; merge_group skips the ancestry check",
    ),
    test: WORKFLOW_TEST,
  },
  {
    name: "provenance: the ancestry is assumed, not checked",
    file: VERDICT,
    text: "ANCESTRY_CHECKED_EVENTS.has(eventName) ? onMain(policyRoot, policySha) : null,",
    replacement: "ANCESTRY_CHECKED_EVENTS.has(eventName) ? true : null,",
    red: E2E("fails policy-provenance on a PR event when the policy commit is not on main"),
    test: WORKFLOW_TEST,
  },
  {
    name: "provenance: the review snapshot is not recorded",
    file: VERDICT,
    text: "      prov.reviews.push({ pr: pr.number, head_sha: live.head.sha, reviews: snapshot(reviews) });\n",
    replacement: "",
    red: E2E(
      "logs one provenance line: the policy sha, the API head and the review snapshot judged",
    ),
    test: WORKFLOW_TEST,
  },
  {
    name: "tripwire: the policy may be a head under judgement",
    file: VERDICT,
    text: "  if (policy !== null && heads.has(policy)) {",
    replacement: "  if ((false as boolean) && policy !== null && heads.has(policy)) {",
    red: TRIP("fails when the policy is a head under judgement"),
    test: WORKFLOW_TEST,
  },
  {
    name: "tripwire: a merge group whose base is its head passes",
    file: VERDICT,
    text: "    } else if (p.merge_group_sha === p.merge_group_base_sha) {",
    replacement:
      "    } else if ((false as boolean) && p.merge_group_sha === p.merge_group_base_sha) {",
    red: TRIP("fails when a merge group's base is its head"),
    test: WORKFLOW_TEST,
  },
  {
    name: "tripwire: the workflow's head is not compared with the payload's",
    file: VERDICT,
    text: "  if (p.event_head_sha === null || p.event_head_sha !== p.payload_head_sha) {",
    replacement:
      "  if ((false as boolean) && (p.event_head_sha === null || p.event_head_sha !== p.payload_head_sha)) {",
    red: TRIP("fails when the workflow's head differs from the payload's"),
    test: WORKFLOW_TEST,
  },
  // The pull_request_target safety rules (kept from the contract version).
  {
    name: "workflow: the token gains a write scope",
    file: WORKFLOW,
    text: "  pull-requests: read\n",
    replacement: "  pull-requests: read\n  actions: write\n",
    red: "the autonomy-tier workflow's pull_request_target safety has a read-only token: contents and pull-requests read, nothing else, no job override",
    test: WORKFLOW_TEST,
  },
  {
    name: "workflow: a secret is referenced",
    file: WORKFLOW,
    text: "          GH_TOKEN: ${{ github.token }}\n",
    replacement: "          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n",
    red: "the autonomy-tier workflow's pull_request_target safety references no secrets",
    test: WORKFLOW_TEST,
  },
  {
    name: "workflow: the policy checkout persists the token",
    file: WORKFLOW,
    text: "          fetch-depth: 0\n          persist-credentials: false\n",
    replacement: "          fetch-depth: 0\n          persist-credentials: true\n",
    red: "the autonomy-tier workflow's pull_request_target safety checks out exactly one tree, the policy revision, without persisting credentials",
    test: WORKFLOW_TEST,
  },
  {
    name: "workflow: the trusted checkout names the head",
    file: WORKFLOW,
    text: `          ref: ${POLICY_REF}\n`,
    replacement: `          ref: ${POLICY_REF.replace("'no-policy-revision-for-this-event'", "github.event.pull_request.head.sha")}\n`,
    red: "the autonomy-tier workflow's pull_request_target safety the trusted checkout is the base, never the PR head",
    test: WORKFLOW_TEST,
  },
  {
    name: "workflow: a script runs in the PR head",
    file: WORKFLOW,
    text: "      - name: Install the policy revision's dependencies (uncached)\n        working-directory: trusted\n",
    replacement:
      "      - name: Install the policy revision's dependencies (uncached)\n        working-directory: subject\n",
    red: "the autonomy-tier workflow's pull_request_target safety every run step works in trusted/, never in the PR head",
    test: WORKFLOW_TEST,
  },
  {
    name: "workflow: an event field is interpolated into the script",
    file: WORKFLOW,
    text: '          --event-name "$GITHUB_EVENT_NAME"\n',
    replacement:
      '          --event-name "$GITHUB_EVENT_NAME" # ${{ github.event.pull_request.title }}\n',
    red: "the autonomy-tier workflow's pull_request_target safety interpolates no expression into a run script (event fields reach it only by file)",
    test: WORKFLOW_TEST,
  },
  {
    name: "workflow: the verdict step is skipped outside the queue (a skipped step reports success)",
    file: WORKFLOW,
    text: "      - name: Classify and decide\n",
    replacement:
      "      - name: Classify and decide\n        if: github.event_name == 'merge_group'\n",
    red: "the autonomy-tier workflow's pull_request_target safety no step is conditional or allowed to fail (a skipped or tolerated step reports success)",
    test: WORKFLOW_TEST,
  },
  {
    name: "workflow: the job may fail and still pass (continue-on-error)",
    file: WORKFLOW,
    text: "    timeout-minutes: 15\n",
    replacement: "    timeout-minutes: 15\n    continue-on-error: true\n",
    red: "the autonomy-tier workflow's pull_request_target safety no step is conditional or allowed to fail (a skipped or tolerated step reports success)",
    test: WORKFLOW_TEST,
  },
  {
    name: "workflow: the verdict step may fail and still pass (continue-on-error)",
    file: WORKFLOW,
    text: "      - name: Classify and decide\n",
    replacement: "      - name: Classify and decide\n        continue-on-error: true\n",
    red: "the autonomy-tier workflow's pull_request_target safety no step is conditional or allowed to fail (a skipped or tolerated step reports success)",
    test: WORKFLOW_TEST,
  },
  {
    name: "workflow: a local action from the PR head runs",
    file: WORKFLOW,
    text: "      - name: Install the policy revision's dependencies (uncached)\n",
    replacement:
      "      - uses: ./subject/.github/actions/evil\n\n      - name: Install the policy revision's dependencies (uncached)\n",
    red: "the autonomy-tier workflow's pull_request_target safety every action is a remote action pinned to a full commit sha (no local ./ action)",
    test: WORKFLOW_TEST,
  },
  {
    name: "workflow: an action is pinned to a tag, not a sha",
    file: WORKFLOW,
    text: "      - uses: pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86 # v4\n",
    replacement: "      - uses: pnpm/action-setup@v4\n",
    red: "the autonomy-tier workflow's pull_request_target safety every action is a remote action pinned to a full commit sha (no local ./ action)",
    test: WORKFLOW_TEST,
  },
  {
    name: "workflow: setup-node reads its version from the PR head",
    file: WORKFLOW,
    text: '          node-version: "22"\n',
    replacement: "          node-version-file: subject/.nvmrc\n",
    red: SUBJ,
    test: WORKFLOW_TEST,
  },
  {
    name: "workflow: top-level BASH_ENV sources a file from the PR head",
    file: WORKFLOW,
    text: "permissions:\n  contents: read\n",
    replacement:
      "env:\n  BASH_ENV: ${{ github.workspace }}/subject/evil.sh\n\npermissions:\n  contents: read\n",
    red: SUBJ,
    test: WORKFLOW_TEST,
  },
  {
    name: "workflow: job-level BASH_ENV (no subject/ in the value)",
    file: WORKFLOW,
    text: "    timeout-minutes: 15\n",
    replacement: "    timeout-minutes: 15\n    env:\n      BASH_ENV: ../evil.sh\n",
    red: "the autonomy-tier workflow's pull_request_target safety sets no shell or shell start-up file anywhere (BASH_ENV / ENV / shell: would run a file first)",
    test: WORKFLOW_TEST,
  },
  {
    name: "workflow: top-level defaults.run.shell sources a file from the PR head",
    file: WORKFLOW,
    text: "permissions:\n  contents: read\n",
    replacement:
      'defaults:\n  run:\n    shell: bash -c "source ../subject/evil.sh; bash {0}"\n\npermissions:\n  contents: read\n',
    red: SUBJ,
    test: WORKFLOW_TEST,
  },
  {
    name: "workflow: a non-default shell (no subject/ in the value)",
    file: WORKFLOW,
    text: "      - name: Install the policy revision's dependencies (uncached)\n        working-directory: trusted\n",
    replacement:
      "      - name: Install the policy revision's dependencies (uncached)\n        working-directory: trusted\n        shell: bash --rcfile ../x {0}\n",
    red: "the autonomy-tier workflow's pull_request_target safety sets no shell or shell start-up file anywhere (BASH_ENV / ENV / shell: would run a file first)",
    test: WORKFLOW_TEST,
  },
  {
    name: "workflow: the install step runs a script from the PR head",
    file: WORKFLOW,
    text: "        run: pnpm install --frozen-lockfile\n",
    replacement: "        run: bash ../subject/evil.sh\n",
    red: SUBJ,
    test: WORKFLOW_TEST,
  },
  {
    name: "workflow: the verdict step also runs a script from the PR head",
    file: WORKFLOW,
    text: `          --subject ${STORE}\n`,
    replacement: `          --subject ${STORE} && bash ../subject/evil.sh\n`,
    red: SUBJ,
    test: WORKFLOW_TEST,
  },
  // Runtime-assembled bypasses no text scan can see: only the exact shape
  // (the authority) catches them.
  {
    name: "workflow K: a run body assembles the head path at run time",
    file: WORKFLOW,
    text: "        run: pnpm install --frozen-lockfile\n",
    replacement:
      "        run: pnpm install --frozen-lockfile && d=sub && cd ../${d}ject && ./evil.sh\n",
    red: EXACT,
    test: WORKFLOW_TEST,
  },
  {
    name: "workflow M: NODE_OPTIONS appended to $GITHUB_ENV",
    file: WORKFLOW,
    text: "        run: pnpm install --frozen-lockfile\n",
    replacement:
      '        run: |\n          pnpm install --frozen-lockfile\n          echo "NODE_OPTIONS=--require=$GITHUB_WORKSPACE/s""ubject/x.js" >> "$GITHUB_ENV"\n',
    red: EXACT,
    test: WORKFLOW_TEST,
  },
  {
    name: "workflow S: a head directory appended to $GITHUB_PATH",
    file: WORKFLOW,
    text: "        run: pnpm install --frozen-lockfile\n",
    replacement:
      '        run: |\n          pnpm install --frozen-lockfile\n          echo "$GITHUB_WORKSPACE/s""ubject/bin" >> "$GITHUB_PATH"\n',
    red: EXACT,
    test: WORKFLOW_TEST,
  },
  {
    name: "workflow L: NODE_OPTIONS in the verdict step env, path built by format()",
    file: WORKFLOW,
    text: "          AUTONOMY_T0: ${{ vars.AUTONOMY_T0 }}\n",
    replacement:
      "          AUTONOMY_T0: ${{ vars.AUTONOMY_T0 }}\n          NODE_OPTIONS: --require ${{ github.workspace }}/${{ format('{0}ject','sub') }}/x.js\n",
    red: EXACT,
    test: WORKFLOW_TEST,
  },
  {
    name: "workflow T: an npm config variable in the install step env",
    file: WORKFLOW,
    text: "        working-directory: trusted\n        run: pnpm install --frozen-lockfile\n",
    replacement:
      "        working-directory: trusted\n        env:\n          npm_config_globalconfig: ../x\n        run: pnpm install --frozen-lockfile\n",
    red: EXACT,
    test: WORKFLOW_TEST,
  },
  {
    name: "workflow R: the verdict's exit code is discarded (|| true)",
    file: WORKFLOW,
    text: `          --subject ${STORE}\n`,
    replacement: `          --subject ${STORE} || true\n`,
    red: EXACT,
    test: WORKFLOW_TEST,
  },
  {
    name: "workflow: the dependency cache is switched back on",
    file: WORKFLOW,
    text: "          package-manager-cache: false\n",
    replacement: "          package-manager-cache: false\n          cache: pnpm\n",
    red: "the autonomy-tier workflow's pull_request_target safety takes the package manager from the base and keeps the dependency cache off",
    test: WORKFLOW_TEST,
  },
];

// Run as a command with a red marker; `-t`, anchored to the exact full name,
// narrows each run to the one test that must go red.
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

await runTampers(
  TAMPERS.map((t) => ({
    name: t.name ?? `${t.file === VERDICT ? "verdict" : "classifier"}: ${t.red} — rule removed`,
    command: [
      "pnpm",
      "exec",
      "vitest",
      "run",
      t.test ?? CLASSIFIER_TEST,
      "-t",
      `^${escapeRegExp(t.red)}$`,
    ],
    redMarker: "Test Files  1 failed",
    edits: t.edits ?? [{ file: t.file, from: t.text, to: t.replacement }],
  })),
  { root: ROOT },
);
