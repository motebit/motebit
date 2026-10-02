/**
 * The permanent mutation table for `check-prepush-subset`. Each MUTANT is an
 * edit to the real hook / ci.yml / root package.json / a package manifest that
 * makes the local pre-push run something CI does not (or makes CI's
 * counterpart not run, not fail, or run narrower) — the gate must go RED on
 * every one. Each CONTROL is an edit that changes nothing the invariant is
 * about — the gate must stay GREEN, or it is pinning noise.
 *
 * R1–R10 are the ten shapes the review of the first (regex) version of this
 * gate found green; S* are their siblings. Not a `.test.ts`: it is data,
 * imported by check-prepush-subset.test.ts (and runnable against any version
 * of the gate's `evaluate`).
 */

export interface Inputs {
  hook: string;
  ci: string;
  rootScripts: Record<string, string>;
  packageScripts: Record<string, Record<string, string>>;
}

export interface Edit {
  id: string;
  what: string;
  apply: (i: Inputs) => Inputs;
}

/** String replace that THROWS when the anchor is gone — a row never goes vacuous. */
function sub(src: string, from: string | RegExp, to: string, id: string): string {
  const out = src.replace(from, to);
  if (out === src) throw new Error(`mutation ${id}: anchor ${String(from)} not found`);
  return out;
}
const hook =
  (id: string, from: string | RegExp, to: string) =>
  (i: Inputs): Inputs => ({ ...i, hook: sub(i.hook, from, to, id) });
const ci =
  (id: string, from: string | RegExp, to: string) =>
  (i: Inputs): Inputs => ({ ...i, ci: sub(i.ci, from, to, id) });
const script =
  (name: string, value: string) =>
  (i: Inputs): Inputs => ({ ...i, rootScripts: { ...i.rootScripts, [name]: value } });

const BUILD = '  run_phase "build" pnpm build\n';
const before = (id: string, line: string) => hook(id, BUILD, `${line}\n${BUILD}`);
const CHECK = 'run_phase "gates (pnpm check)" pnpm check\n';
const COV = "        run: pnpm exec turbo run test:coverage --concurrency=4\n";
const TEST_STEP = "      - name: Test with coverage\n";

const m = (id: string, what: string, apply: (i: Inputs) => Inputs): Edit => ({ id, what, apply });

export const MUTANTS: Edit[] = [
  // --- the ten review findings -------------------------------------------
  m(
    "R1",
    "hook: pnpm aliased through a variable",
    before("R1", '  _p=pnpm\n  run_phase "e2e" $_p turbo run test:e2e'),
  ),
  m("R2", "hook: eval of a CI-less command", before("R2", '  eval "pnpm turbo run test:e2e"')),
  m(
    "R3",
    "hook: CI-less command inside a $( ) in a condition",
    before("R3", '  if [ -n "$(pnpm turbo run test:e2e)" ]; then printf x; fi'),
  ),
  m(
    "R4",
    "hook: command smuggled through xargs",
    before("R4", "  echo test:e2e | xargs pnpm turbo run"),
  ),
  m(
    "R5",
    "hook: phase wrapped in sh -c with || true",
    hook("R5", BUILD, "  run_phase \"build\" sh -c 'pnpm build || true'\n"),
  ),
  m(
    "R6",
    "hook: phase variable set to a CI-less task",
    hook("R6", "_full_task=test:coverage", "_full_task=test:e2e"),
  ),
  m(
    "R7",
    "ci: continue-on-error on the test:coverage counterpart",
    ci("R7", COV, `${COV}        continue-on-error: true\n`),
  ),
  m(
    "R8",
    "ci: counterpart made unable to fail (|| true)",
    ci("R8", COV, "        run: pnpm exec turbo run test:coverage --concurrency=4 || true\n"),
  ),
  m(
    "R9",
    "ci: push to main limited by a paths filter",
    ci(
      "R9",
      "  push:\n    branches: [main]\n",
      '  push:\n    branches: [main]\n    paths: ["packages/**"]\n',
    ),
  ),
  m(
    "R10",
    "root: `lint` script narrowed with --filter",
    script("lint", "turbo run lint --filter=@motebit/protocol"),
  ),

  // --- hook siblings -------------------------------------------------------
  m(
    "S1",
    "hook: run_phase in a pipeline (exit only leaves the subshell)",
    hook("S1", CHECK, 'run_phase "gates (pnpm check)" pnpm check | cat\n'),
  ),
  m(
    "S2",
    "hook: run_phase in a subshell",
    hook("S2", CHECK, '( run_phase "gates (pnpm check)" pnpm check )\n'),
  ),
  m(
    "S3",
    "hook: run_phase backgrounded",
    hook("S3", CHECK, 'run_phase "gates (pnpm check)" pnpm check &\n'),
  ),
  m(
    "S4",
    "hook: backtick command substitution",
    before("S4", "  printf '%s' `pnpm turbo run test:e2e`"),
  ),
  m(
    "S5",
    "hook: a new function hiding a command",
    before("S5", '  e2e() { pnpm turbo run test:e2e; }\n  run_phase "e2e" e2e'),
  ),
  m(
    "S6",
    "hook: run_phase redefined to swallow failures",
    hook("S6", BUILD, `  run_phase() { shift; "$@" || true; }\n${BUILD}`),
  ),
  m("S7", "hook: run_phase body returns 0 on failure", hook("S7", 'exit "$_rc"', "return 0")),
  m(
    "S8",
    "hook: env-prefix on a phase",
    hook("S8", CHECK, 'CI=1 run_phase "gates (pnpm check)" pnpm check\n'),
  ),
  m(
    "S9",
    "hook: ${v:=…} assigns a phase variable",
    before("S9", '  printf "%s" "${_full_task:=test:e2e}"'),
  ),
  m(
    "S10",
    "hook: for-loop assigns a phase variable",
    before("S10", "  for _full_task in test:e2e; do printf x; done"),
  ),
  m("S11", "hook: sources another script", before("S11", "  . ./scripts/extra-prepush.sh")),
  m(
    "S12",
    "hook: _filter_affected narrowed",
    hook(
      "S12",
      "_filter_affected='--filter=...[origin/main]'",
      "_filter_affected='--filter=./packages/leaf'",
    ),
  ),
  m(
    "S13",
    "hook: _test_filters turned into a dry run",
    hook("S13", "sed 's#^#--filter=./#')", "sed 's#^#--filter=./#'; echo --dry=json)"),
  ),
  m(
    "S14",
    "hook: npx turbo instead of pnpm",
    before("S14", '  run_phase "e2e" npx turbo run test:e2e'),
  ),
  m("S15", "hook: an unconditional early exit 0", before("S15", "  exit 0")),
  m(
    "S16",
    "hook: format_changed body changed",
    hook(
      "S16",
      "xargs -0 -r pnpm exec prettier --check",
      "xargs -0 -r pnpm exec prettier --list-different",
    ),
  ),
  m(
    "S17",
    "hook: CI-less command inside a phase LABEL",
    hook("S17", BUILD, '  run_phase "build $(pnpm turbo run test:e2e)" pnpm build\n'),
  ),
  m(
    "S18",
    "hook: a new phase CI never runs",
    before("S18", '  run_phase "e2e" pnpm turbo run test:e2e'),
  ),
  m(
    "S19",
    "hook: audit at a lower bar than CI's",
    hook("S19", "pnpm audit --prod --audit-level=high", "pnpm audit --audit-level=critical"),
  ),
  m(
    "S20",
    "hook: changed_files given a computed path",
    before("S20", '  _x=$(changed_files "$HOME")'),
  ),
  m(
    "S21",
    "hook: a git alias can run a shell command",
    hook("S21", "git merge-base origin/main HEAD", "git -c alias.mb='!pnpm turbo run test:e2e' mb"),
  ),

  // --- CI siblings ---------------------------------------------------------
  m(
    "S22",
    "ci: format job skips pushes to main",
    ci("S22", "\n  format:\n", "\n  format:\n    if: github.event_name == 'pull_request'\n"),
  ),
  m(
    "S23",
    "ci: step-level if on the counterpart",
    ci("S23", COV, `${COV}        if: github.event_name == 'pull_request'\n`),
  ),
  m(
    "S24",
    "ci: working-directory on the counterpart",
    ci("S24", COV, `${COV}        working-directory: packages/protocol\n`),
  ),
  m("S25", "ci: push trigger removed", ci("S25", "  push:\n    branches: [main]\n", "")),
  m(
    "S26",
    "ci: push filtered to another branch",
    ci("S26", "  push:\n    branches: [main]\n", "  push:\n    branches: [release]\n"),
  ),
  m(
    "S27",
    "ci: counterpart narrowed with --filter",
    ci(
      "S27",
      COV,
      "        run: pnpm exec turbo run test:coverage --concurrency=4 --filter=[origin/main]\n",
    ),
  ),
  m(
    "S28",
    "ci: `changes` job gated (cascade-skips gate-effectiveness on push)",
    ci("S28", "\n  changes:\n", "\n  changes:\n    if: github.event_name == 'pull_request'\n"),
  ),
  m(
    "S29",
    "ci: gate-effectiveness no longer runs on push",
    ci(
      "S29",
      "      github.event_name == 'push' ||\n      needs.changes.outputs.scripts == 'true'\n",
      "      needs.changes.outputs.scripts == 'true'\n",
    ),
  ),
  m(
    "S30",
    "ci: job-level continue-on-error on check",
    ci(
      "S30",
      "    timeout-minutes: 30\n",
      "    timeout-minutes: 30\n    continue-on-error: true\n",
    ),
  ),
  m(
    "S31",
    "ci: workflow-level defaults.run.working-directory",
    ci(
      "S31",
      "\nenv:\n",
      "\ndefaults:\n  run:\n    working-directory: packages/protocol\n\nenv:\n",
    ),
  ),
  m(
    "S32",
    "ci: a step writes $GITHUB_ENV before the counterparts",
    ci(
      "S32",
      "        run: pnpm lint\n",
      '        run: pnpm lint\n\n      - name: tweak\n        run: echo "SKIP_COVERAGE=1" >> "$GITHUB_ENV"\n',
    ),
  ),
  m(
    "S33",
    "ci: workflow env grows a variable",
    ci("S33", "\nenv:\n", "\nenv:\n  SKIP_COVERAGE: 1\n"),
  ),
  m(
    "S34",
    "ci: an unpinned action in a counterpart job",
    ci(
      "S34",
      "        run: pnpm lint\n",
      "        run: pnpm lint\n\n      - uses: someone/patch-node@v1\n",
    ),
  ),
  m(
    "S35",
    "ci: audit level relaxed",
    ci(
      "S35",
      "run: pnpm audit --prod --audit-level=high",
      "run: pnpm audit --prod --audit-level=critical",
    ),
  ),
  m("S36", "ci: the check job renamed", ci("S36", "\n  check:\n", "\n  checks:\n")),
  m(
    "S37",
    "ci: needs points at a gated job",
    ci("S37", "    needs: changes\n", "    needs: e2e\n"),
  ),

  // --- B1 (cold review, d97e0136d): steps inserted before a counterpart ----
  // Every step of every counterpart job is pinned (name, uses, with, run, if,
  // env, continue-on-error) — any added, removed or changed step is RED.
  m(
    "B1",
    "ci: checkout of another sha inserted before Test with coverage",
    ci(
      "B1",
      TEST_STEP,
      `      - uses: actions/checkout@v4\n        with:\n          ref: 0000000000000000000000000000000000000000\n\n${TEST_STEP}`,
    ),
  ),
  m(
    "B2",
    "ci: tests deleted + obfuscated $GITHUB_ENV write before Test with coverage",
    ci(
      "B2",
      TEST_STEP,
      `      - run: rm -rf packages/*/src/__tests__ && eval "echo SKIP=1 >> $GITHUB_""ENV"\n\n${TEST_STEP}`,
    ),
  ),
  m(
    "B3",
    "ci: counterpart step renamed (was a control)",
    ci("B3", TEST_STEP, "      - name: Tests (with coverage thresholds)\n"),
  ),
  m(
    "B4",
    "ci: a non-counterpart step removed (Install dependencies in format)",
    ci(
      "B4",
      "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile\n\n      - name: Check formatting\n",
      "      - name: Check formatting\n",
    ),
  ),
  m(
    "B5",
    "ci: setup-node `with` changed in check",
    ci("B5", /node-version: "?22"?/, "node-version: 18"),
  ),
  m(
    "B6",
    "ci: changes job checkout loses fetch-depth (the diff the gate job reads)",
    ci("B6", "          fetch-depth: 0\n", "          fetch-depth: 1\n"),
  ),
  m(
    "B7",
    "ci: env added to a non-counterpart step in gate-effectiveness",
    ci(
      "B7",
      "      - name: Prove every gate in GATES actually fires\n",
      "      - name: Prove every gate in GATES actually fires\n        env:\n          MOTEBIT_GATES_SKIP: all\n",
    ),
  ),
  m(
    "B8",
    "ci: if: added to the Install step of check",
    ci(
      "B8",
      "      - name: Install dependencies\n",
      "      - name: Install dependencies\n        if: false\n",
    ),
  ),

  // --- root + package scripts ---------------------------------------------
  m(
    "S38",
    "root: format:check glob narrowed",
    script("format:check", 'prettier --check "**/*.{ts,tsx}"'),
  ),
  m(
    "S39",
    "root: check script filtered",
    script("check", "npx tsx scripts/check.ts --only check-deps"),
  ),
  m(
    "S40",
    "root: typecheck script filtered",
    script("typecheck", "turbo run typecheck --filter=@motebit/protocol"),
  ),
  m("S41", "package: test:coverage stops running the tests", (i) => ({
    ...i,
    packageScripts: {
      ...i.packageScripts,
      "packages/protocol": {
        ...i.packageScripts["packages/protocol"],
        "test:coverage": "echo skipped",
      },
    },
  })),
  m("S42", "package: test:coverage dropped while test stays", (i) => {
    const { ["test:coverage"]: _drop, ...rest } = i.packageScripts["packages/crypto"] ?? {};
    return { ...i, packageScripts: { ...i.packageScripts, "packages/crypto": rest } };
  }),
];

export const CONTROLS: Edit[] = [
  m(
    "K1",
    "hook: a comment added",
    hook("K1", BUILD, `  # a new comment about the build\n${BUILD}`),
  ),
  m(
    "K2",
    "hook: a phase label reworded",
    hook("K2", BUILD, '  run_phase "build (whole graph)" pnpm build\n'),
  ),
  m(
    "K3",
    "hook: a skip message reworded",
    hook("K3", '"no pnpm-lock.yaml changes; CI runs it"', '"lockfile untouched; CI audits"'),
  ),
  m(
    "K4",
    "hook: a phase reflowed with a line continuation",
    hook("K4", CHECK, 'run_phase "gates (pnpm check)" \\\n    pnpm check\n'),
  ),
  m(
    "K5",
    "hook: the closing banner text reworded",
    hook("K5", "pre-push gauntlet passed in", "pre-push passed in"),
  ),
  m("K7", "ci: a comment added", ci("K7", COV, `        # a comment\n${COV}`)),
  m(
    "K8",
    "ci: check job timeout raised",
    ci("K8", "    timeout-minutes: 30\n", "    timeout-minutes: 40\n"),
  ),
  m(
    "K9",
    "ci: an unrelated gated job added",
    ci(
      "K9",
      "\n  format:\n",
      "\n  extra:\n    if: github.event_name == 'pull_request'\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n\n  format:\n",
    ),
  ),
  m("K10", "root: an unrelated script added", script("hello", "echo hello")),
];
