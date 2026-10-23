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
  shardRunner: string;
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

const runner =
  (id: string, from: string | RegExp, to: string) =>
  (i: Inputs): Inputs => ({ ...i, shardRunner: sub(i.shardRunner, from, to, id) });

const BUILD = '  run_phase "build" pnpm build\n';
const before = (id: string, line: string) => hook(id, BUILD, `${line}\n${BUILD}`);
const CHECK = 'run_phase "gates (pnpm check)" pnpm check\n';
const SHARD_RUN =
  "pnpm test:coverage:shard --shard ${{ matrix.shard }} --manifest coverage/test-coverage-shard.json";
const COV = `        run: ${SHARD_RUN}\n`;
const TEST_STEP = "      - name: Test with coverage (this shard)\n";
const SCRUB = "unset $(env | sed -n 's/^\\(GIT_[A-Za-z0-9_]*\\)=.*/\\1/p')";
const SCRUB_LINE = `  ${SCRUB} # git-env-scrub\n`;

const m = (id: string, what: string, apply: (i: Inputs) => Inputs): Edit => ({ id, what, apply });

/** A job inserted before `format:` (unpinned — only historyViolations judges it). */
const job = (id: string, checkout: string, run: string) =>
  ci(
    id,
    "\n  format:\n",
    `\n  extra:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1${checkout}\n      - run: ${run}\n\n  format:\n`,
  );
const FULL = "\n        with:\n          fetch-depth: 0";
/** Append one env line to sibling-audit's audit step (an unpinned job). */
const SA_ENV =
  "          DIFF_BASE: ${{ github.event_name == 'merge_group' && github.event.merge_group.base_sha || 'origin/main' }}\n";
const stepEnv = (id: string, line: string) => ci(id, SA_ENV, `${SA_ENV}          ${line}\n`);

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
    ci("R8", COV, `        run: ${SHARD_RUN} || true\n`),
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
    "S43",
    "ci: merge_group trigger removed (the queue's required checks never report)",
    ci("S43", "  merge_group:\n    types: [checks_requested]\n", ""),
  ),
  m(
    "S44",
    "ci: merge_group narrowed to another activity type",
    ci(
      "S44",
      "  merge_group:\n    types: [checks_requested]\n",
      "  merge_group:\n    types: [destroyed]\n",
    ),
  ),
  m(
    "S27",
    "ci: counterpart narrowed to one fixed shard",
    ci("S27", COV, `        run: ${SHARD_RUN.replace("${{ matrix.shard }}", "1/3")}\n`),
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
    "ci: job-level continue-on-error on check-static",
    ci(
      "S30",
      "  check-static:\n    runs-on: ubuntu-latest\n",
      "  check-static:\n    runs-on: ubuntu-latest\n    continue-on-error: true\n",
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
      "      - name: Prove every gate in this shard actually fires\n",
      "      - name: Prove every gate in this shard actually fires\n        env:\n          MOTEBIT_GATES_SKIP: all\n",
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
  // --- the sharded gate-effectiveness (2026-10-02) ------------------------
  m(
    "G1",
    "ci: a shard dropped from the matrix (union no longer the full probe set)",
    ci("G1", 'shard: ["1/4", "2/4", "3/4", "4/4"]', 'shard: ["1/4", "2/4", "3/4"]'),
  ),
  m(
    "G2",
    "ci: matrix relabelled so a shard index is missing (1/4 listed twice)",
    ci("G2", 'shard: ["1/4", "2/4", "3/4", "4/4"]', 'shard: ["1/4", "1/4", "3/4", "4/4"]'),
  ),
  m(
    "G3",
    "ci: fail-fast on (a failing leg cancels the others into 'cancelled')",
    ci(
      "G3",
      '      fail-fast: false\n      matrix:\n        shard: ["1/4"',
      '      fail-fast: true\n      matrix:\n        shard: ["1/4"',
    ),
  ),
  m(
    "G4",
    "ci: shard step runs one fixed shard instead of the matrix value",
    ci("G4", "--shard ${{ matrix.shard }} --manifest", "--shard 1/4 --manifest"),
  ),
  m(
    "G5",
    "ci: verdict job no longer runs when a shard is cancelled",
    ci(
      "G5",
      "    needs: [changes, gate-effectiveness-shard, gate-self-tests]\n    if: always()\n",
      "    needs: [changes, gate-effectiveness-shard, gate-self-tests]\n    if: success()\n",
    ),
  ),
  m(
    "G6",
    "ci: verdict job stops waiting on the shards",
    ci(
      "G6",
      "    needs: [changes, gate-effectiveness-shard, gate-self-tests]\n",
      "    needs: [changes, gate-self-tests]\n",
    ),
  ),
  m(
    "G7",
    "ci: verdict job accepts a cancelled shard",
    ci("G7", 'if [ "$SHARDS" != "success" ]', 'if [ "$SHARDS" = "failure" ]'),
  ),
  m(
    "G8",
    "ci: verdict job skips the manifest coverage proof",
    ci(
      "G8",
      "        run: pnpm check-gates-effective --verify-shards /tmp/gate-shards\n",
      "        run: echo skipped\n",
    ),
  ),
  m(
    "G9",
    "ci: self-tests job no longer runs on push",
    ci("G9", "  gate-self-tests:\n", "  gate-self-tests-old:\n"),
  ),
  // --- the sharded test:coverage + its `check` verdict (2026-10-05) --------
  m(
    "T1",
    "ci: a test-coverage shard dropped from the matrix",
    ci("T1", 'shard: ["1/3", "2/3", "3/3"]', 'shard: ["1/3", "2/3"]'),
  ),
  m(
    "T2",
    "ci: test-coverage matrix lists a shard twice (2/3 never runs)",
    ci("T2", 'shard: ["1/3", "2/3", "3/3"]', 'shard: ["1/3", "1/3", "3/3"]'),
  ),
  m(
    "T3",
    "ci: test-coverage fail-fast on",
    ci(
      "T3",
      '      fail-fast: false\n      matrix:\n        shard: ["1/3"',
      '      fail-fast: true\n      matrix:\n        shard: ["1/3"',
    ),
  ),
  m("T4", "package: a new package with test:coverage but no shard weight (unassigned)", (i) => ({
    ...i,
    packageScripts: {
      ...i.packageScripts,
      "packages/zz-planted": { test: "vitest run", "test:coverage": "vitest run --coverage" },
    },
  })),
  m(
    "T5",
    "ci: the check verdict no longer runs when a leg is cancelled",
    ci(
      "T5",
      "    needs: [check-static, test-coverage]\n    if: always()\n",
      "    needs: [check-static, test-coverage]\n    if: success()\n",
    ),
  ),
  m(
    "T6",
    "ci: the check verdict stops waiting on the shards",
    ci("T6", "    needs: [check-static, test-coverage]\n", "    needs: [check-static]\n"),
  ),
  m(
    "T7",
    "ci: the check verdict accepts a cancelled shard",
    ci("T7", '[ "$TESTS" != "success" ]', '[ "$TESTS" = "failure" ]'),
  ),
  m(
    "T8",
    "ci: the check verdict skips the shard-manifest proof",
    ci(
      "T8",
      "        run: pnpm test:coverage:shard --verify-manifests /tmp/coverage-shards\n",
      "        run: echo skipped\n",
    ),
  ),
  m(
    "T9",
    "root: the shard runner script pointed elsewhere",
    script("test:coverage:shard", "echo skipped"),
  ),
  m("T10", "ci: the shard step drops its Build step", (i) =>
    ci(
      "T10",
      "      - name: Build\n        run: pnpm build\n\n      - name: Test with coverage (this shard)\n",
      "      - name: Test with coverage (this shard)\n",
    )(i),
  ),
  // --- what the shard runner actually launches (cold review, 2026-10-05) ---
  m(
    "T11",
    "runner: every shard exits 0 whatever turbo returned (failing tests pass CI)",
    runner(
      "T11",
      /process\.exit\((?:r\.status \?\? 1|runShard\(mine, spawnTurbo\(root\)\))\)/,
      "process.exit(0)",
    ),
  ),
  m(
    "T12",
    "runner: `--dry` appended to the shard's turbo args (no test runs)",
    runner("T12", "`--filter=./${d}`)]", '`--filter=./${d}`), "--dry"]'),
  ),
  m(
    "T13",
    "runner: runShard swallows the child's exit status",
    runner("T13", "return r.status ?? 1;", "return 0;"),
  ),
  // --- the GIT_* scrub (2026-10-02, second #835-class incident) -------------
  m("E1", "hook: the GIT_* scrub removed", hook("E1", SCRUB_LINE, "")),
  m("E2", "hook: the scrub moved after the build phase", (i) =>
    hook("E2b", BUILD, `${BUILD}${SCRUB_LINE}`)(hook("E2a", SCRUB_LINE, "")(i)),
  ),
  m("E3", "hook: the scrub runs in a subshell", hook("E3", SCRUB_LINE, `  ( ${SCRUB} )\n`)),
  m(
    "E4",
    "hook: the scrub behind a condition",
    hook("E4", SCRUB_LINE, `  if [ -n "$MOTEBIT_SCRUB" ]; then ${SCRUB}; fi\n`),
  ),
  m("E5", "hook: the scrub narrowed to GIT_DIR", hook("E5", SCRUB_LINE, "  unset GIT_DIR\n")),
  m("E6", "hook: the scrub's pattern narrowed", hook("E6", "GIT_[A-Za-z0-9_]*", "GIT_DIR")),
  m("E7", "hook: the scrub backgrounded", hook("E7", SCRUB_LINE, `  ${SCRUB} &\n`)),
  m(
    "E8",
    "hook: a phase before the tag guard (outside the scrubbed body)",
    hook("E8", "\nif git symbolic-ref", '\nrun_phase "build" pnpm build\nif git symbolic-ref'),
  ),
  m(
    "E9",
    "hook: the scrub after another command in the body",
    hook("E9", SCRUB_LINE, `  _scope_ok=1\n${SCRUB_LINE}`),
  ),
  // H*: a base-ref-dependent gate (check-cli-surface, check-test-outcome-floors)
  // on a shallow checkout — #1062's first run (gate-self-tests red; every
  // probe shard vacuously green, a fail-closed exit read as "fires").
  m(
    "H1",
    "ci: gate-self-tests' checkout drops fetch-depth: 0 (the #1062 shape)",
    ci(
      "H1",
      /(  gate-self-tests:[\s\S]*?actions\/checkout@\S+ # v7\.0\.1\n)        with:\n(?:          #.*\n)*          fetch-depth: 0\n/,
      "$1",
    ),
  ),
  m(
    "H2",
    "ci: gate-effectiveness-shard's checkout drops fetch-depth: 0 (its probes fire vacuously)",
    ci(
      "H2",
      /(  gate-effectiveness-shard:[\s\S]*?actions\/checkout@\S+ # v7\.0\.1\n)        with:\n(?:          #.*\n)*          fetch-depth: 0\n/,
      "$1",
    ),
  ),
  m(
    "H3",
    "ci: a new job runs check-test-outcome-floors shallow",
    job("H3", "", "pnpm check-test-outcome-floors"),
  ),
  m("H4", "ci: a new job runs check-cli-surface shallow", job("H4", "", "pnpm check-cli-surface")),
  m("H5", "ci: a new job runs `pnpm check` shallow", job("H5", "", "pnpm check")),
  m("H6", "ci: a new job runs the gate self-tests shallow", job("H6", "", "pnpm test:gates")),
  m(
    "H7",
    "ci: a new job runs the gate probes shallow",
    job("H7", "", "pnpm check-gates-effective --shard 1/1"),
  ),
  m(
    "H8",
    "ci: a new job runs check-test-outcome-floors at fetch-depth: 1",
    job("H8", "\n        with:\n          fetch-depth: 1", "pnpm check-test-outcome-floors"),
  ),
  // P*: the GITHUB_TOKEN grant (WORKFLOW_PERMISSIONS) and the turbo secrets'
  // event allowlist (WORKFLOW_ENV) — widened, removed, or bypassed per job.
  m(
    "P1",
    "ci: top-level permissions widened to contents: write",
    ci("P1", "\npermissions:\n  contents: read\n", "\npermissions:\n  contents: write\n"),
  ),
  m(
    "P2",
    "ci: top-level permissions grows an extra scope",
    ci(
      "P2",
      "\npermissions:\n  contents: read\n",
      "\npermissions:\n  contents: read\n  pull-requests: write\n",
    ),
  ),
  m(
    "P3",
    "ci: top-level permissions: write-all",
    ci("P3", "\npermissions:\n  contents: read\n", "\npermissions: write-all\n"),
  ),
  m(
    "P4",
    "ci: top-level permissions: read-all",
    ci("P4", "\npermissions:\n  contents: read\n", "\npermissions: read-all\n"),
  ),
  m(
    "P5",
    "ci: top-level permissions removed (the repo default applies)",
    ci("P5", "\npermissions:\n  contents: read\n", "\n"),
  ),
  m(
    "P6",
    "ci: a counterpart job (check-static) declares its own permissions",
    ci(
      "P6",
      "  check-static:\n    runs-on: ubuntu-latest\n",
      "  check-static:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: write\n",
    ),
  ),
  m(
    "P7",
    "ci: an unpinned job (sibling-audit) declares its own permissions",
    ci(
      "P7",
      "  sibling-audit:\n",
      "  sibling-audit:\n    permissions:\n      pull-requests: write\n",
    ),
  ),
  m(
    "P8",
    "ci: TURBO_TOKEN reaches every event again (pull_request included)",
    ci("P8", /  TURBO_TOKEN: .*\n/, "  TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}\n"),
  ),
  m(
    "P9",
    "ci: the signature key reaches every event again",
    ci(
      "P9",
      /  TURBO_REMOTE_CACHE_SIGNATURE_KEY: .*\n/,
      "  TURBO_REMOTE_CACHE_SIGNATURE_KEY: ${{ secrets.TURBO_REMOTE_CACHE_SIGNATURE_KEY }}\n",
    ),
  ),
  m(
    "P10",
    "ci: TURBO_TOKEN's allowlist inverted to a denylist (`!= 'pull_request'` lets pull_request_target or any new event through)",
    ci(
      "P10",
      /  TURBO_TOKEN: .*\n/,
      "  TURBO_TOKEN: ${{ github.event_name != 'pull_request' && secrets.TURBO_TOKEN || '' }}\n",
    ),
  ),
  m(
    "P11",
    "ci: a job re-exports the secret in its own env",
    ci(
      "P11",
      "  sibling-audit:\n",
      "  sibling-audit:\n    env:\n      TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}\n",
    ),
  ),
  m(
    "P12",
    "ci: a step hands github.token to a script",
    ci(
      "P12",
      "          DIFF_BASE: ${{ github.event_name == 'merge_group' && github.event.merge_group.base_sha || 'origin/main' }}\n",
      "          DIFF_BASE: ${{ github.event_name == 'merge_group' && github.event.merge_group.base_sha || 'origin/main' }}\n          GH_TOKEN: ${{ github.token }}\n",
    ),
  ),
  // The cold review's bypasses of the first (pattern-matching) scan: each must
  // be RED under the deny-by-default expression allowlist.
  m(
    "P13",
    "ci: `Secrets.X` (contexts are case-insensitive)",
    stepEnv("P13", "T: ${{ Secrets.TURBO_TOKEN }}"),
  ),
  m("P14", "ci: `SECRETS.X`", stepEnv("P14", "T: ${{ SECRETS.TURBO_TOKEN }}")),
  m("P15", "ci: `github.TOKEN`", stepEnv("P15", "T: ${{ github.TOKEN }}")),
  m("P16", "ci: `github['token']` (index syntax)", stepEnv("P16", "T: ${{ github['token'] }}")),
  m("P17", "ci: `toJSON(github)` serialises the token", stepEnv("P17", "T: ${{ toJSON(github) }}")),
  m(
    "P18",
    "ci: a job calls a reusable workflow with `secrets: inherit`",
    ci(
      "P18",
      "\n  format:\n",
      "\n  reuse:\n    uses: ./.github/workflows/x.yml\n    secrets: inherit\n\n  format:\n",
    ),
  ),
  m(
    "P19",
    "ci: a job calls a reusable workflow (no `secrets:`)",
    ci("P19", "\n  format:\n", "\n  reuse:\n    uses: ./.github/workflows/x.yml\n\n  format:\n"),
  ),
  m("P20", "ci: an unallowlisted context (`vars.X`)", stepEnv("P20", "T: ${{ vars.TURBO_TEAM }}")),
  m(
    "P21",
    "ci: a secret in a bare `if:` (evaluated as an expression without `${{ }}`)",
    ci(
      "P21",
      "      - name: Sibling boundary audit\n",
      "      - name: Sibling boundary audit\n        if: secrets.TURBO_TOKEN != ''\n",
    ),
  ),
  m("P22", "ci: an unterminated `${{`", stepEnv("P22", "T: ${{ github.event_name")),
  m(
    "P23",
    "ci: an allowlisted path no expression uses any more (the allowlist is exactly what ci.yml reads)",
    ci("P23", /path: \$\{\{ runner\.temp \}\}\/motebit\.md/g, "path: /tmp/motebit.md"),
  ),
  // Second cold review: a KEY is walked too; merge keys and capitalised job keys are refused.
  m("P24", "ci: an expression used as an env KEY", stepEnv("P24", "${{ secrets.TURBO_TOKEN }}: a")),
  m(
    "P25",
    "ci: a job-level YAML merge key carrying permissions",
    ci("P25", "  sibling-audit:\n", "  sibling-audit:\n    <<: { permissions: write-all }\n"),
  ),
  m(
    "P26",
    "ci: a job whose only key is a merge key carrying uses + secrets: inherit",
    ci(
      "P26",
      "\n  format:\n",
      "\n  reuse:\n    <<: { uses: ./.github/workflows/x.yml, secrets: inherit }\n\n  format:\n",
    ),
  ),
  m(
    "P27",
    "ci: a capitalised job-level `Permissions:`",
    ci("P27", "  sibling-audit:\n", "  sibling-audit:\n    Permissions: write-all\n"),
  ),
  m(
    "P28",
    "ci: a capitalised job-level `Uses:`",
    ci("P28", "\n  format:\n", "\n  reuse:\n    Uses: ./.github/workflows/x.yml\n\n  format:\n"),
  ),
  m(
    "P29",
    "ci: a capitalised job-level `Secrets:`",
    ci("P29", "  sibling-audit:\n", "  sibling-audit:\n    Secrets: inherit\n"),
  ),
  m(
    "P30",
    "ci: a secret in a bare capitalised `If:` (the if-key is matched in any case)",
    ci(
      "P30",
      "      - name: Sibling boundary audit\n",
      "      - name: Sibling boundary audit\n        If: secrets.TURBO_TOKEN != ''\n",
    ),
  ),
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
    "ci: check-static job timeout raised (the first timeout-minutes: 20 is check-static's)",
    ci("K8", "    timeout-minutes: 20\n", "    timeout-minutes: 25\n"),
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
  m(
    "K11",
    "hook: the scrub's comment reworded",
    hook("K11", "No inherited GIT_* past this line", "Scrub the inherited git environment"),
  ),
  m("KP1", "ci: a step reads an allowlisted path in its env, and a bare step `if:` on one", (i) =>
    ci(
      "KP1b",
      "      - name: Sibling boundary audit\n",
      "      - name: Sibling boundary audit\n        if: github.event_name != 'push'\n",
    )(stepEnv("KP1", "EV: ${{ GITHUB.EVENT_NAME }}")(i)),
  ),
  m(
    "HC1",
    "ci: a new job runs check-test-outcome-floors on a full-history checkout",
    job("HC1", FULL, "pnpm check-test-outcome-floors"),
  ),
  m(
    "HC2",
    "ci: a new shallow job runs only a --verify-shards read, or a check-* that is not `pnpm check`",
    job(
      "HC2",
      "",
      "pnpm check-gates-effective --verify-shards /tmp/x && pnpm check-no-secrets-in-client-bundles",
    ),
  ),
];
