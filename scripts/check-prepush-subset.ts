#!/usr/bin/env tsx
/**
 * Drift defense: pre-push ⊆ CI — DENY BY DEFAULT.
 *
 * The local pre-push hook (`.husky/pre-push`) is a FAST gate by scope; CI
 * (`.github/workflows/ci.yml`, plus the merge queue) is the authority. That
 * split is safe only while everything the hook runs has a CI counterpart that
 * runs AT LEAST AS WIDE, on every push to main. The trade-off that makes the
 * hook fast — a DEPENDENT's failing test does not block locally — is only
 * acceptable because CI's `check` job runs `turbo run test:coverage`
 * unfiltered.
 *
 * The first version of this gate (2026-09-30) matched `pnpm …` text with
 * regexes and accepted anything it did not recognise as "not a check"; a
 * review found ten edits that ran a CI-less command from the hook, or
 * weakened the CI counterpart, with the gate still green (a `$_p` alias, an
 * `eval`, a command inside `$( )`, `xargs`, a `continue-on-error`, an `if:`, a
 * `paths:` filter, `|| true`, a narrowed root script …). This version inverts
 * the default: what it does not positively recognise is a violation.
 *
 * The hook side, read by a real POSIX-sh lexer/parser (scripts/lib/posix-sh.ts)
 * that sees every command including those inside `$( … )`:
 *   - every command outside a pinned function is a PURE builtin (`[`, `test`,
 *     `printf`, `echo`, `skip_phase`), an EXACT allowlisted command line, or a
 *     `run_phase` whose command is EXACTLY one of RUN_PHASE_FORMS — and that
 *     `run_phase` is never forked (pipeline, subshell, `$( )`) or
 *     backgrounded, where its `exit` would not abort the push;
 *   - every variable assignment's value is EXACTLY one allowlisted value
 *     (so `$_full_task`, `$_filter_affected`, `$_test_filters` … can only be
 *     what the forms were reviewed with); no env-prefix assignments, no
 *     `${v:=…}`, no `for`/`read` into a variable;
 *   - the functions are pinned by a hash of their canonical token text, each
 *     defined exactly once, at top level; no other function may be defined.
 * The CI side, read with a real YAML parser:
 *   - the workflow runs on `push` to `main` with no path/branch filter and no
 *     `defaults`, and on `merge_group` (checks_requested) so the merge queue's
 *     required checks report; its `env` is exactly the pinned turbo-cache block;
 *   - for each task key the hook runs, a step whose `run` EXACTLY equals the
 *     allowlisted CI form, with only `name`/`run` keys, in an allowlisted job
 *     whose `if:`/`needs:` chain is exactly the pinned one (and whose needs
 *     run unconditionally); no step in those jobs writes $GITHUB_ENV /
 *     $GITHUB_PATH or uses an action outside the pinned set;
 *   - EVERY step of every counterpart job (check, format, the sharded
 *     gate-effectiveness-shard + gate-self-tests, the fail-closed
 *     gate-effectiveness verdict job, changes) equals CI_JOB_STEPS exactly, in order — an added, removed or
 *     changed step (another checkout `ref:`, a `rm -rf` of the tests, an
 *     `eval`'d $GITHUB_ENV write) is RED until the pinned list is updated;
 *   - the root package.json scripts those forms reach compare by exact value,
 *     and every workspace package's `test:coverage` runs its `test` (plus
 *     coverage), so CI's test:coverage really is a superset of the hook's test.
 * And BY EXECUTION (evaluateTestCache): CI's `turbo run test:coverage` (and the
 * hook's `turbo run test`) must really RUN every suite, never replay a cached
 * pass. A per-package turbo.json (`{"extends":["//"],"tasks":{"test:coverage":
 * {"cache":true,"inputs":["package.json"]}}}`) overrides the root's
 * `cache: false` for that package only — CI then replays a stale green after a
 * test breaks, and no root-turbo.json check sees it. So every package's `test`
 * and `test:coverage` are resolved through `turbo run test test:coverage
 * --dry=json` and must be `cache: false` as RESOLVED, and any non-root
 * turbo.json that configures `test` / `test:coverage` at all is a violation
 * unless PACKAGE_TURBO_TEST_ALLOWLIST names it with a reason.
 *
 * Changing the hook or ci.yml in a way this gate does not know is therefore a
 * red gate whose repair is a deliberate edit to the tables below — the review
 * the pre-push ⊆ CI claim needs, made unskippable.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { cleanEnv } from "./lib/differential-tree.js";
import { failWithRepair } from "./lib/gate-report.js";
import { ShParseError, parseSh, walk, type Program, type Word } from "./lib/posix-sh.js";

const ROOT = process.cwd();
const HOOK = ".husky/pre-push";
const CI = ".github/workflows/ci.yml";

export type Key =
  | "build"
  | "audit"
  | "check"
  | "test:gates"
  | "check-gates-effective"
  | "typecheck"
  | "lint"
  | "test"
  | "test:coverage"
  | "format";

const ws = (s: string) => s.replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------
// Hook tables

/** `run_phase <label> <form>` — the only commands a phase may run. */
export const RUN_PHASE_FORMS: Record<string, Key[]> = {
  "pnpm build": ["build"],
  "pnpm audit --prod --audit-level=high --ignore-registry-errors": ["audit"],
  "pnpm check": ["check"],
  "pnpm test:gates": ["test:gates"],
  "pnpm check-gates-effective": ["check-gates-effective"],
  'pnpm turbo run typecheck lint "$_full_task" $_filter_affected --concurrency="$_concurrency"': [
    "typecheck",
    "lint",
    "test:coverage",
    "test",
  ],
  'pnpm turbo run typecheck lint $_filter_affected --concurrency="$_concurrency"': [
    "typecheck",
    "lint",
  ],
  'pnpm turbo run test --concurrency="$_concurrency"': ["test"],
  'pnpm turbo run test $_test_filters --concurrency="$_concurrency"': ["test"],
  "pnpm format:check": ["format"],
  // The pinned function below: prettier --check over the changed files.
  format_changed: ["format"],
};

/** Commands that cannot run another command and have no effect but output/status. */
const PURE = new Set(["[", "test", "printf", "echo", "skip_phase"]);

/**
 * The env scrub: the FIRST command of the hook body, before any phase. In a
 * linked worktree git exports GIT_DIR=<repo>/.git/worktrees/<name> (+
 * GIT_PREFIX, GIT_EXEC_PATH, GIT_EDITOR) into the hook; a phase that inherits
 * it — a fixture `git` in `pnpm test:gates` — acts on the REAL repository
 * whatever its cwd (2026-09-27 #835, 2026-10-02: core.bare = true and
 * `fixture` commits on the pushing branch). Its PLACEMENT is pinned by
 * envScrubViolations, not only its text: a scrub moved after a phase, into a
 * branch, a subshell or a `$( )` is a scrub that does not cover every phase.
 */
export const ENV_SCRUB = "unset $(env | sed -n 's/^\\(GIT_[A-Za-z0-9_]*\\)=.*/\\1/p')";
/** Every other command line allowed outside a pinned function, exactly. */
const EXACT_COMMANDS = new Set([
  "git symbolic-ref -q HEAD",
  // The GIT_* scrub (ENV_SCRUB) and the two commands of its `$( )`; where it
  // must stand is envScrubViolations' job.
  ENV_SCRUB,
  "env",
  "sed -n 's/^\\(GIT_[A-Za-z0-9_]*\\)=.*/\\1/p'",
  "git merge-base origin/main HEAD",
  "date +%s",
  "wc -l",
  "tr -d ' '",
  "head -n 1",
]);

/** The hook's top level: the $CI short-circuit, then `if <tag guard>; then <body> fi`. */
const TOP_GUARDS = ['[ -n "$CI" ] && exit 0'];
const TAG_GUARD = "git symbolic-ref -q HEAD >/dev/null 2>&1";

export function envScrubViolations(prog: Program): string[] {
  const where = `${HOOK}: the GIT_* scrub`;
  const fix = `the hook must be \`${TOP_GUARDS.join("")}\` then \`if ${TAG_GUARD}; then\` whose FIRST command is \`${ENV_SCRUB}\` (no else/elif)`;
  const items = prog.items;
  if (items.length !== TOP_GUARDS.length + 1) {
    return [
      `${where}: the top level has ${items.length} item(s), not the CI guard + the tag-guarded body — ${fix}`,
    ];
  }
  for (const [i, g] of TOP_GUARDS.entries()) {
    if (ws(items[i]!.canon) !== g) {
      return [`${where}: top-level item ${i + 1} is \`${ws(items[i]!.canon)}\` — ${fix}`];
    }
  }
  const body = items[TOP_GUARDS.length]!;
  const cmd =
    body.pipelines.length === 1 && body.pipelines[0]!.cmds.length === 1
      ? body.pipelines[0]!.cmds[0]!
      : null;
  if (cmd?.type !== "if" || body.background || body.pipelines[0]!.bang) {
    return [`${where}: the hook body is not a plain top-level \`if\` — ${fix}`];
  }
  if (
    cmd.bodies.length !== 2 ||
    ws(cmd.bodies[0]!.items.map((i) => i.canon).join(" ; ")) !== TAG_GUARD
  ) {
    return [`${where}: the body's \`if\` is not exactly \`if ${TAG_GUARD}; then … fi\` — ${fix}`];
  }
  const first = cmd.bodies[1]!.items[0];
  if (
    first == null ||
    first.background ||
    first.pipelines.length !== 1 ||
    first.pipelines[0]!.bang ||
    first.pipelines[0]!.cmds.length !== 1 ||
    first.pipelines[0]!.cmds[0]!.type !== "simple" ||
    ws(first.canon) !== ENV_SCRUB
  ) {
    return [
      `${where} is not the first command of the hook body (found \`${first ? ws(first.canon) : "(nothing)"}\`) — every phase would inherit a linked worktree's GIT_DIR; ${fix}`,
    ];
  }
  return [];
}

/** `exit` is allowed only as the $CI short-circuit. */
const EXIT_AND_OR = new Set(['[ -n "$CI" ] && exit 0']);

/**
 * Every variable the hook assigns outside a pinned function, and the only
 * values (whitespace-collapsed source text) it may be given. Pinning every
 * assignment — not only the ones a form names — closes the transitive path
 * (`_test_filters` ← `_changed_pkg_dirs` ← `_all_changed` / `_ws_roots`).
 */
export const ASSIGNMENTS: Record<string, string[]> = {
  _gauntlet_t0: ["$(date +%s)"],
  _scope_ok: ["1", ""],
  _all_changed: ["$(changed_files)"],
  _filter_affected: ["'--filter=...[origin/main]'", ""],
  _pkg_scope_ok: ["", "1"],
  _changed_pkg_dirs: [
    "",
    ws(`$(printf '%s\\n' "$_all_changed" | sed -E -n "s#^(($_ws_roots)/[^/]+)/.*#\\\\1#p" |
      sort -u | while IFS= read -r _d; do if [ -f "$_d/package.json" ]; then printf '%s\\n' "$_d"; fi; done)`),
  ],
  _ws_roots: [
    ws(
      `$(sed -E -n 's#^[[:space:]]*-[[:space:]]*["'\\'']?([A-Za-z0-9_.-]+)/\\*["'\\'']?[[:space:]]*$#\\1#p'     pnpm-workspace.yaml 2>/dev/null | paste -sd'|' -)`,
    ),
  ],
  _ws_unmapped: [
    ws(
      String.raw`$(grep -vE '^[[:space:]]*(#.*)?$|^packages:[[:space:]]*$|^[[:space:]]*-[[:space:]]*["'\'']?[A-Za-z0-9_.-]+/\*["'\'']?[[:space:]]*$' pnpm-workspace.yaml 2>/dev/null || true)`,
    ),
  ],
  // Every changed path outside a workspace package, minus the explicit scoped
  // allowlist (docs/**/*.md, .changeset/*.md) — non-empty ⇒ tests run unfiltered.
  _unscoped_paths: [
    "",
    ws(
      String.raw`$(printf '%s\n' "$_all_changed" | grep -vE '^(docs/.+\.md|\.changeset/[^/]+\.md)$' |
      while IFS= read -r _p; do
        _pd=$(printf '%s\n' "$_p" | sed -E -n "s#^(($_ws_roots)/[^/]+)/.*#\\1#p")
        if [ -n "$_p" ] && { [ -z "$_pd" ] || [ ! -f "$_pd/package.json" ]; }; then printf '%s\n' "$_p"; fi
      done)`,
    ),
  ],
  _deps_changed: ["$(changed_files pnpm-lock.yaml)"],
  _scripts_changed: ["$(changed_files scripts/ coverage-graduation.json examples/interop/)"],
  _concurrency: ["${MOTEBIT_PREPUSH_CONCURRENCY:-2}"],
  _full_task: ["test:coverage", "test"],
  _test_filters: [`$(printf '%s\\n' "$_changed_pkg_dirs" | sed 's#^#--filter=./#')`],
  _n_changed: [`$(printf '%s\\n' "$_changed_pkg_dirs" | wc -l | tr -d ' ')`],
  _n_reach: [
    ws(
      `$(pnpm ls -r --depth -1 --parseable $(printf '%s\\n' "$_changed_pkg_dirs" | sed 's#.*#--filter=...{./&}#') 2>/dev/null | wc -l | tr -d ' ')`,
    ),
  ],
  _fmt_exts: ["'ts|tsx|js|jsx|json|md'"],
  _fmt_config_changed: [
    ws(
      String.raw`$(printf '%s\n' "$_all_changed" | grep -E '(^|/)(\.prettierrc[^/]*|prettier\.config\.[^/]*|\.prettierignore|\.editorconfig|\.gitignore|package\.json|package\.yaml|pnpm-lock\.yaml)$' || true)`,
    ),
  ],
  _fmt_files: [`$(printf '%s\\n' "$_all_changed" | grep -E "\\.($_fmt_exts)\\$" || true)`],
};

/**
 * sha256 of each function's canonical token text (comments and layout
 * removed). A changed body is a deliberate re-review: run_phase's `exit` is
 * what makes a failing phase abort the push, changed_files decides scope,
 * format_changed runs prettier.
 */
export const PINNED_FUNCTIONS: Record<string, string> = {
  run_phase: "91e637577b02ae44",
  skip_phase: "f3194ff4fb1a93f9",
  changed_files: "2d6237cb53d2691a",
  format_changed: "620fef7d17b67873",
};

export const canonHash = (canon: string) =>
  createHash("sha256").update(ws(canon)).digest("hex").slice(0, 16);

// ---------------------------------------------------------------------------
// CI tables

interface CiForm {
  job: string;
  run: string;
}
/** The CI counterpart of each task key: a step whose `run` is exactly this. */
export const CI_FORMS: Record<Key, CiForm> = {
  build: { job: "check", run: "pnpm build" },
  audit: { job: "check", run: "pnpm audit --prod --audit-level=high --ignore-registry-errors" },
  check: { job: "check", run: "pnpm check" },
  typecheck: { job: "check", run: "pnpm typecheck" },
  lint: { job: "check", run: "pnpm lint" },
  // test:coverage runs every suite AND the thresholds — a superset of `test`.
  test: { job: "check", run: "pnpm exec turbo run test:coverage --concurrency=4" },
  "test:coverage": { job: "check", run: "pnpm exec turbo run test:coverage --concurrency=4" },
  format: { job: "format", run: "pnpm format:check" },
  "test:gates": { job: "gate-self-tests", run: "pnpm test:gates" },
  // Sharded: the union of the matrix legs is the full probe set — the pinned
  // strategy below must list every shard 1/N..N/N (matrixIsCompleteShardList),
  // check-gates-effective re-proves the partition in every leg, and the
  // `gate-effectiveness` job verifies the legs' manifests cover every probe.
  "check-gates-effective": {
    job: "gate-effectiveness-shard",
    run: "pnpm check-gates-effective --shard ${{ matrix.shard }} --manifest /tmp/gate-shard.json",
  },
};

/** Each job a counterpart may live in, with its exact `if:` / `needs:`. */
export const CI_JOBS: Record<
  string,
  { if?: string; needs?: string | string[]; strategy?: Record<string, unknown> }
> = {
  check: {},
  format: {},
  "gate-effectiveness-shard": {
    needs: "changes",
    if: "github.event_name == 'push' ||\nneeds.changes.outputs.scripts == 'true'\n",
    strategy: { "fail-fast": false, matrix: { shard: ["1/4", "2/4", "3/4", "4/4"] } },
  },
  "gate-self-tests": {
    needs: "changes",
    if: "github.event_name == 'push' ||\nneeds.changes.outputs.scripts == 'true'\n",
  },
  // The verdict job: runs whatever the shards concluded and fails closed on a
  // cancelled / skipped / failed leg (its pinned steps below).
  "gate-effectiveness": {
    needs: ["changes", "gate-effectiveness-shard", "gate-self-tests"],
    if: "always()",
  },
  changes: {},
};

/**
 * A sharded counterpart is a superset of the hook's unsharded run only if its
 * matrix lists EVERY shard exactly once: `["1/N", …, "N/N"]`, in order, and
 * fail-fast is off (a failing leg must not cancel the others into "cancelled").
 */
export function matrixIsCompleteShardList(strategy: unknown): boolean {
  const st = strategy as { "fail-fast"?: unknown; matrix?: { shard?: unknown } } | undefined;
  const list = st?.matrix?.shard;
  if (st?.["fail-fast"] !== false || !Array.isArray(list) || list.length < 1) return false;
  return list.every((v, i) => v === `${i + 1}/${list.length}`);
}
/**
 * EVERY step of every counterpart job, exactly (name, uses, with, run, if,
 * env, continue-on-error, id — the whole step object, in order). Deny by
 * default (2026-10-01 cold review, B1): a step inserted before a counterpart
 * can check out another sha, delete the tests, or write $GITHUB_ENV through
 * an `eval` no regex sees — and the counterpart's own `run` still matches.
 * So any added, removed, reordered or changed step is RED; the repair is a
 * deliberate edit to this list, reviewed against the pre-push ⊆ CI claim.
 */
export const CI_JOB_STEPS: Record<string, Step[]> = {
  check: [
    {
      uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    },
    {
      uses: "pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86",
    },
    {
      uses: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
      with: {
        "node-version": "22",
        cache: "pnpm",
      },
    },
    {
      name: "Install dependencies",
      run: "pnpm install --frozen-lockfile",
    },
    {
      name: "Audit",
      run: "pnpm audit --prod --audit-level=high --ignore-registry-errors",
    },
    {
      name: "Build",
      run: "pnpm build",
    },
    {
      name: "Drift defenses (deps, specs, service/app primitives, API surface, changeset discipline)",
      run: "pnpm check",
    },
    {
      // Read-only scan of the bundles the Build step emitted (#170); it
      // writes nothing, so it cannot change what a later counterpart tests.
      name: "No provider credentials in built client bundles",
      run: "pnpm check-no-secrets-in-client-bundles --require-dist web,verify",
    },
    {
      name: "Typecheck",
      run: "pnpm typecheck",
    },
    {
      name: "Lint",
      run: "pnpm lint",
    },
    {
      name: "Publish-integrity (publint + attw on every published package)",
      run: "pnpm lint:pack",
    },
    {
      name: "Dead code detection",
      if: "always()",
      "continue-on-error": true,
      run: "pnpm run check-unused",
    },
    {
      name: "Test with coverage",
      run: "pnpm exec turbo run test:coverage --concurrency=4",
    },
    {
      name: "Coverage summary",
      if: "always()",
      run: 'node scripts/coverage-summary.mjs >> "$GITHUB_STEP_SUMMARY"',
    },
    {
      name: "Upload coverage reports",
      if: "always()",
      uses: "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
      with: {
        name: "coverage-reports",
        path: "packages/*/coverage/\napps/*/coverage/\nservices/*/coverage/\n",
        "retention-days": 14,
      },
    },
    {
      name: "Upload build artifacts for E2E",
      uses: "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
      with: {
        name: "web-build",
        path: "apps/web/dist/",
        "retention-days": 1,
      },
    },
  ],
  format: [
    {
      uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    },
    {
      uses: "pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86",
    },
    {
      uses: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
      with: {
        "node-version": "22",
        cache: "pnpm",
      },
    },
    {
      name: "Install dependencies",
      run: "pnpm install --frozen-lockfile",
    },
    {
      name: "Check formatting",
      run: "pnpm format:check",
    },
  ],
  "gate-effectiveness-shard": [
    {
      uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    },
    {
      uses: "pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86",
    },
    {
      uses: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
      with: {
        "node-version": "22",
        cache: "pnpm",
      },
    },
    {
      name: "Install dependencies",
      run: "pnpm install --frozen-lockfile",
    },
    {
      name: "Build",
      run: "pnpm build",
    },
    {
      name: "Prove every gate in this shard actually fires",
      run: "pnpm check-gates-effective --shard ${{ matrix.shard }} --manifest /tmp/gate-shard.json",
    },
    {
      name: "Upload the shard manifest",
      uses: "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
      with: {
        name: "gate-shard-${{ strategy.job-index }}",
        path: "/tmp/gate-shard.json",
        "if-no-files-found": "error",
        "retention-days": 1,
      },
    },
  ],
  "gate-self-tests": [
    {
      uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    },
    {
      uses: "pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86",
    },
    {
      uses: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
      with: {
        "node-version": "22",
        cache: "pnpm",
      },
    },
    {
      name: "Install dependencies",
      run: "pnpm install --frozen-lockfile",
    },
    {
      name: "Build",
      run: "pnpm build",
    },
    {
      name: "Run gate self-tests (scripts/__tests__)",
      run: "pnpm test:gates",
    },
  ],
  "gate-effectiveness": [
    {
      id: "decide",
      name: "Fail closed unless every shard and the self-tests completed",
      env: {
        EVENT: "${{ github.event_name }}",
        SCRIPTS: "${{ needs.changes.outputs.scripts }}",
        CHANGES: "${{ needs.changes.result }}",
        SHARDS: "${{ needs.gate-effectiveness-shard.result }}",
        SELF_TESTS: "${{ needs.gate-self-tests.result }}",
      },
      run: 'echo "changes=$CHANGES shards=$SHARDS self-tests=$SELF_TESTS (event=$EVENT scripts=$SCRIPTS)"\nif [ "$CHANGES" != "success" ]; then\n  echo "::error::the changes job concluded \'$CHANGES\' — whether the gate proof was required is unknown, so it is not proven"\n  exit 1\nfi\nif [ "$EVENT" != "push" ] && [ "$SCRIPTS" != "true" ]; then\n  if [ "$SHARDS" = "skipped" ] && [ "$SELF_TESTS" = "skipped" ]; then\n    echo "No gate input changed on this PR: the gate proof is not required."\n    echo "required=false" >> "$GITHUB_OUTPUT"\n    exit 0\n  fi\nfi\nif [ "$SHARDS" != "success" ] || [ "$SELF_TESTS" != "success" ]; then\n  echo "::error::gate-effectiveness shards \'$SHARDS\', self-tests \'$SELF_TESTS\' — a cancelled, skipped or failed proof is not a proof"\n  exit 1\nfi\necho "required=true" >> "$GITHUB_OUTPUT"\n',
    },
    {
      if: "steps.decide.outputs.required == 'true'",
      uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    },
    {
      if: "steps.decide.outputs.required == 'true'",
      uses: "pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86",
    },
    {
      if: "steps.decide.outputs.required == 'true'",
      uses: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
      with: {
        "node-version": "22",
        cache: "pnpm",
      },
    },
    {
      if: "steps.decide.outputs.required == 'true'",
      name: "Install dependencies",
      run: "pnpm install --frozen-lockfile",
    },
    {
      if: "steps.decide.outputs.required == 'true'",
      name: "Download the shard manifests",
      uses: "actions/download-artifact@95815c38cf2ff2164869cbab79da8d1f422bc89e",
      with: {
        pattern: "gate-shard-*",
        path: "/tmp/gate-shards",
      },
    },
    {
      if: "steps.decide.outputs.required == 'true'",
      name: "Prove the shards ran every probe exactly once",
      run: "pnpm check-gates-effective --verify-shards /tmp/gate-shards",
    },
  ],
  changes: [
    {
      uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      with: {
        "fetch-depth": 0,
      },
    },
    {
      id: "filter",
      name: "Detect scripts/ and services/relay/ changes vs base",
      run: 'scripts=false\nrelay=false\n# The diff base: the PR\'s base branch, or — in the merge queue — the\n# group\'s parent commit (main, or the queue entry ahead of it), so\n# the group\'s own changes decide, exactly as the PR\'s did.\nbase=""\nif [ "${{ github.event_name }}" = "pull_request" ]; then\n  base="origin/${{ github.base_ref }}"\nelif [ "${{ github.event_name }}" = "merge_group" ]; then\n  base="${{ github.event.merge_group.base_sha }}"\nfi\nif [ -n "$base" ]; then\n  changed=$(git diff --name-only "$base...HEAD")\n  # Probes read repo data outside scripts/ (coverage-graduation.json\n  # is the live example: #589 moved a date there, the probe keyed on\n  # that literal went vacuous, and gate-effectiveness never ran on\n  # the PR because scripts/ was untouched — main went red on push).\n  # A change to a gate INPUT must trigger the same proof as a change\n  # to the gate.\n  # examples/interop/ is a gate input too: the APS vector and the pins\n  # in INTEROP.md are read by scripts/__tests__/interop-aps-vector.test.ts.\n  if echo "$changed" | grep -qE \'^scripts/|^coverage-graduation\\.json$|^examples/interop/\'; then\n    scripts=true\n  fi\n  # activation-effectiveness must fire on a relay refactor (the exact\n  # regression it guards: a source change making a booted suite go\n  # vacuous), not only on gate edits.\n  if echo "$changed" | grep -qE \'^services/relay/\'; then\n    relay=true\n  fi\nfi\necho "scripts=$scripts" >> "$GITHUB_OUTPUT"\necho "relay=$relay" >> "$GITHUB_OUTPUT"\necho "scripts/ touched vs \'$base\': $scripts; services/relay/ touched: $relay"\n',
    },
  ],
};
const JOB_KEYS = new Set(["runs-on", "timeout-minutes", "steps", "needs", "if", "outputs"]);
const STEP_ACTIONS = [
  "actions/checkout@",
  "pnpm/action-setup@",
  "actions/setup-node@",
  "actions/upload-artifact@",
  "actions/download-artifact@",
];
const WORKFLOW_KEYS = new Set(["name", "on", "concurrency", "env", "jobs"]);
export const WORKFLOW_ENV: Record<string, string> = {
  TURBO_TOKEN: "${{ secrets.TURBO_TOKEN }}",
  TURBO_TEAM: "${{ vars.TURBO_TEAM }}",
  TURBO_REMOTE_CACHE_SIGNATURE_KEY: "${{ secrets.TURBO_REMOTE_CACHE_SIGNATURE_KEY }}",
};

/** Root package.json scripts the forms reach, by exact value. */
export const ROOT_SCRIPTS: Record<string, string> = {
  build: "turbo run build",
  check: "npx tsx scripts/check.ts",
  typecheck: "turbo run typecheck",
  lint: "turbo run lint",
  "format:check": 'prettier --check "**/*.{ts,tsx,js,jsx,json,md}"',
  "test:gates": "vitest run --dir scripts/__tests__ --testTimeout=30000 --hookTimeout=30000",
  "check-gates-effective": "npx tsx scripts/check-gates-effective.ts",
};

// ---------------------------------------------------------------------------
// Evaluation

export interface Inputs {
  hook: string;
  ci: string;
  rootScripts: Record<string, string>;
  /** dir → { test, test:coverage } for every workspace package. */
  packageScripts: Record<string, Record<string, string>>;
}

export interface Evaluation {
  violations: string[];
  keys: Key[];
  commands: number;
  phases: number;
}

const varRefs = (s: string) => [...s.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!);

export function evaluateHook(hook: string): {
  violations: string[];
  keys: Set<Key>;
  commands: number;
  phases: number;
} {
  const violations: string[] = [];
  const keys = new Set<Key>();
  const at = (line: number) => `${HOOK}:${line}`;
  let prog;
  try {
    prog = parseSh(hook);
  } catch (err) {
    const msg = err instanceof ShParseError ? err.message : String(err);
    return {
      violations: [
        `${HOOK} does not parse as the POSIX sh this gate reads (${msg}) — a construct it cannot read is denied`,
      ],
      keys,
      commands: 0,
      phases: 0,
    };
  }
  violations.push(...envScrubViolations(prog));
  let commands = 0;
  let phases = 0;
  const defined = new Map<string, number>();
  const assigned = new Set<string>();
  const formVars = new Set<string>();
  const pinnedFn = (fn: string | null) => fn != null && fn in PINNED_FUNCTIONS;

  const checkParams = (w: Word, line: number) => {
    for (const p of w.params) {
      if (/^[A-Za-z_][A-Za-z0-9_]*:?[=?]/.test(p)) {
        violations.push(
          `${at(line)} \`\${${p}}\` assigns a variable inside an expansion — every assignment must be a plain, allowlisted \`NAME=value\``,
        );
      }
    }
  };

  walk(prog, {
    func(def, ctx) {
      defined.set(def.name, (defined.get(def.name) ?? 0) + 1);
      if (!(def.name in PINNED_FUNCTIONS)) {
        violations.push(
          `${at(def.line)} defines function \`${def.name}\`, which is not one of the pinned functions (${Object.keys(PINNED_FUNCTIONS).join(", ")})`,
        );
      } else if (ctx.func != null) {
        violations.push(
          `${at(def.line)} defines \`${def.name}\` inside \`${ctx.func}\` — pinned functions are defined once, at top level`,
        );
      } else if (canonHash(def.canon) !== PINNED_FUNCTIONS[def.name]) {
        violations.push(
          `${at(def.line)} function \`${def.name}\` changed (canonical hash ${canonHash(def.canon)}, pinned ${PINNED_FUNCTIONS[def.name] || "(none)"}): review that it still aborts/scopes/formats as before, then update PINNED_FUNCTIONS. Canonical body: ${ws(def.canon)}`,
        );
      }
    },
    compound(cmd, ctx) {
      if (pinnedFn(ctx.func)) return;
      if (cmd.type === "for") {
        violations.push(
          `${at(cmd.line)} \`for ${cmd.forVar} in …\` assigns a variable outside the allowlist — every assignment must be a plain, allowlisted \`NAME=value\``,
        );
      }
    },
    word(w, ctx, role) {
      if (pinnedFn(ctx.func)) return false;
      checkParams(w, w.line);
      // An allowlisted assignment's value is pinned exactly — its inner
      // commands are part of that pin, not re-checked one by one.
      if (role === "assign") return false;
      return true;
    },
    simple(cmd, ctx) {
      if (pinnedFn(ctx.func)) return;
      commands++;
      for (const a of cmd.assigns) {
        const eq = a.raw.indexOf("=");
        const name = a.raw.slice(0, eq);
        const value = ws(a.raw.slice(eq + 1));
        assigned.add(name);
        if (cmd.words.length > 0) {
          violations.push(
            `${at(cmd.line)} \`${a.raw} ${cmd.words[0]!.raw} …\` sets an environment variable for one command — not allowed (it can change what the command does)`,
          );
          continue;
        }
        const allowed = ASSIGNMENTS[name];
        if (!allowed) {
          violations.push(`${at(cmd.line)} assigns \`${name}\`, which is not in ASSIGNMENTS`);
        } else if (!allowed.map(ws).includes(value)) {
          violations.push(
            `${at(cmd.line)} assigns \`${name}=${value}\`; allowed values: ${allowed.map((v) => `\`${v}\``).join(", ")}`,
          );
        }
      }
      if (cmd.words.length === 0) return;
      const head = cmd.words[0]!.raw;
      const text = ws(cmd.words.map((w) => w.raw).join(" "));
      if (!/^[A-Za-z0-9_[.:+-]+$/.test(head) || head === ".") {
        violations.push(
          `${at(cmd.line)} runs \`${text}\` — the command word must be a literal name (no \`$var\`, quotes or path tricks)`,
        );
        return;
      }
      if (head === "run_phase") {
        phases++;
        if (ctx.func != null || ctx.forked || ctx.background || ctx.cmdsub) {
          violations.push(
            `${at(cmd.line)} \`run_phase\` runs ${ctx.func ? `inside function \`${ctx.func}\`` : "in a pipeline, subshell, command substitution or background job"} — its \`exit\` on failure would not abort the push`,
          );
        }
        const form = ws(
          cmd.words
            .slice(2)
            .map((w) => w.raw)
            .join(" "),
        );
        const k = RUN_PHASE_FORMS[form];
        if (cmd.words.length < 3 || !k) {
          violations.push(
            `${at(cmd.line)} \`run_phase\` runs \`${form}\`, which is not one of RUN_PHASE_FORMS — map it to its CI counterpart deliberately`,
          );
          return;
        }
        for (const key of k) keys.add(key);
        for (const v of varRefs(form)) formVars.add(v);
        return;
      }
      if (head === "exit") {
        if (ctx.func != null || !EXIT_AND_OR.has(ws(ctx.andOr))) {
          violations.push(
            `${at(cmd.line)} \`${ws(ctx.andOr)}\` — \`exit\` is allowed only as \`${[...EXIT_AND_OR].join("")}\``,
          );
        }
        return;
      }
      if (PURE.has(head)) return;
      if (head in PINNED_FUNCTIONS && head !== "changed_files") {
        violations.push(
          `${at(cmd.line)} calls \`${head}\` directly — a pinned phase function runs only as a run_phase form`,
        );
        return;
      }
      if (head === "changed_files") {
        if (cmd.words.slice(1).some((w) => /[$`]/.test(w.raw))) {
          violations.push(`${at(cmd.line)} \`${text}\` — changed_files takes literal paths only`);
        }
        return;
      }
      if (!EXACT_COMMANDS.has(text)) {
        violations.push(
          `${at(cmd.line)} runs \`${text}\`, which is neither a pure builtin, an EXACT_COMMANDS line, nor a run_phase form — deny by default`,
        );
      }
    },
  });

  for (const name of Object.keys(PINNED_FUNCTIONS)) {
    const n = defined.get(name) ?? 0;
    if (n !== 1)
      violations.push(
        `${HOOK} defines \`${name}\` ${n} time(s) — a pinned function is defined exactly once (else \`${name}\` resolves to a PATH command or a later redefinition)`,
      );
  }
  for (const v of formVars) {
    if (!assigned.has(v))
      violations.push(
        `${HOOK} run_phase forms read \`$${v}\` but the hook never assigns it — it would come from the environment`,
      );
  }
  return { violations, keys, commands, phases };
}

interface Step {
  [k: string]: unknown;
}
interface Job {
  [k: string]: unknown;
  steps?: Step[];
}

export function evaluateCi(
  ci: string,
  keys: Set<Key>,
  rootScripts: Record<string, string>,
  packageScripts: Record<string, Record<string, string>>,
): string[] {
  const violations: string[] = [];
  let wf: Record<string, unknown>;
  try {
    wf = parseYaml(ci) as Record<string, unknown>;
  } catch (err) {
    return [`${CI} does not parse as YAML: ${err instanceof Error ? err.message : String(err)}`];
  }
  for (const k of Object.keys(wf)) {
    if (!WORKFLOW_KEYS.has(k))
      violations.push(
        `${CI} top-level \`${k}:\` is not allowed (only ${[...WORKFLOW_KEYS].join(", ")}) — e.g. \`defaults:\` changes every run step`,
      );
  }
  const on = wf.on as Record<string, unknown> | undefined;
  if (JSON.stringify(on?.push) !== JSON.stringify({ branches: ["main"] })) {
    violations.push(
      `${CI} \`on.push\` must be exactly \`{ branches: [main] }\` (every push to main, no paths/branches filter); got ${JSON.stringify(on?.push)}`,
    );
  }
  // The merge queue is the other half of "CI is the authority": its required
  // checks report only if the workflow runs on `merge_group`, or the queue
  // waits forever (docs/ops/merge-queue.md).
  if (JSON.stringify(on?.merge_group) !== JSON.stringify({ types: ["checks_requested"] })) {
    violations.push(
      `${CI} \`on.merge_group\` must be exactly \`{ types: [checks_requested] }\` (the merge queue's required checks run on it — see docs/ops/merge-queue.md); got ${JSON.stringify(on?.merge_group)}`,
    );
  }
  if (JSON.stringify(wf.env ?? null) !== JSON.stringify(WORKFLOW_ENV)) {
    violations.push(
      `${CI} workflow \`env:\` must be exactly the pinned turbo remote-cache block ${JSON.stringify(WORKFLOW_ENV)}; got ${JSON.stringify(wf.env)}`,
    );
  }
  const jobs = (wf.jobs ?? {}) as Record<string, Job>;
  const chainOk = (name: string, seen = new Set<string>()): boolean => {
    const job = jobs[name];
    const spec = CI_JOBS[name];
    if (!job || !spec || seen.has(name)) return false;
    const needs = spec.needs == null ? [] : Array.isArray(spec.needs) ? spec.needs : [spec.needs];
    return (
      job.if === spec.if &&
      JSON.stringify(job.needs ?? null) === JSON.stringify(spec.needs ?? null) &&
      needs.every((n) => chainOk(n, new Set([...seen, name])))
    );
  };
  const jobOk = new Map<string, boolean>();
  for (const name of Object.keys(CI_JOBS)) {
    const job = jobs[name];
    if (!job) {
      violations.push(`${CI} has no \`${name}\` job (an allowlisted counterpart job)`);
      jobOk.set(name, false);
      continue;
    }
    let ok = true;
    const spec0 = CI_JOBS[name]!;
    if (spec0.strategy !== undefined) {
      if (JSON.stringify(job.strategy ?? null) !== JSON.stringify(spec0.strategy)) {
        violations.push(
          `${CI} job \`${name}\` must have exactly \`strategy: ${JSON.stringify(spec0.strategy)}\`; got ${JSON.stringify(job.strategy ?? null)} — a narrowed matrix runs a subset of the probes the hook runs; to add a shard, append it here and in ci.yml together`,
        );
        ok = false;
      }
      if (!matrixIsCompleteShardList(job.strategy)) {
        violations.push(
          `${CI} job \`${name}\` matrix must list every shard exactly once, in order ("1/N" … "N/N"), with fail-fast: false; got ${JSON.stringify(job.strategy ?? null)}`,
        );
        ok = false;
      }
    }
    for (const k of Object.keys(job)) {
      if (k === "strategy" && spec0.strategy !== undefined) continue;
      if (!JOB_KEYS.has(k)) {
        violations.push(
          `${CI} job \`${name}\` has \`${k}:\` — not allowed on a counterpart job (only ${[...JOB_KEYS].join(", ")})`,
        );
        ok = false;
      }
    }
    if (!chainOk(name)) {
      const spec = CI_JOBS[name]!;
      violations.push(
        `${CI} job \`${name}\` must have exactly \`if: ${JSON.stringify(spec.if ?? null)}\` and \`needs: ${JSON.stringify(spec.needs ?? null)}\` (and so must its needs, recursively); got if=${JSON.stringify(job.if ?? null)} needs=${JSON.stringify(job.needs ?? null)}`,
      );
      ok = false;
    }
    for (const [i, step] of (job.steps ?? []).entries()) {
      const run = typeof step.run === "string" ? step.run : "";
      if (/GITHUB_ENV|GITHUB_PATH/.test(run)) {
        violations.push(
          `${CI} job \`${name}\` step ${i + 1} writes $GITHUB_ENV/$GITHUB_PATH — it can change every later step, including a counterpart`,
        );
        ok = false;
      }
      if (
        typeof step.uses === "string" &&
        !STEP_ACTIONS.some((a) => (step.uses as string).startsWith(a))
      ) {
        violations.push(
          `${CI} job \`${name}\` step ${i + 1} uses \`${step.uses}\`, not one of the pinned actions (${STEP_ACTIONS.join(", ")})`,
        );
        ok = false;
      }
    }
    jobOk.set(name, ok);
  }

  const canon = (v: unknown): string =>
    JSON.stringify(v, (_k, x: unknown) =>
      x && typeof x === "object" && !Array.isArray(x)
        ? Object.fromEntries(
            Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
          )
        : x,
    );
  for (const [name, pinned] of Object.entries(CI_JOB_STEPS)) {
    const actual = jobs[name]?.steps ?? [];
    const n = Math.max(actual.length, pinned.length);
    let drifted = false;
    for (let i = 0; i < n; i++) {
      const a = actual[i];
      const want = pinned[i];
      if (canon(a ?? null) === canon(want ?? null)) continue;
      drifted = true;
      violations.push(
        `${CI} job \`${name}\` step ${i + 1} ${a == null ? "was REMOVED" : want == null ? "was ADDED" : "CHANGED"} vs the pinned list: expected ${canon(want ?? null)}, got ${canon(a ?? null)} — every step of a counterpart job is pinned; if the edit is deliberate, review that no step before a counterpart can change what it tests, then update CI_JOB_STEPS in scripts/check-prepush-subset.ts`,
      );
      break; // the first drift is the actionable one; later indexes shift with it
    }
    if (drifted) jobOk.set(name, false);
  }

  for (const key of [...keys].sort()) {
    const form = CI_FORMS[key];
    const steps = jobs[form.job]?.steps ?? [];
    const hit = steps.find((s) => typeof s.run === "string" && s.run.trim() === form.run);
    if (!hit) {
      violations.push(
        `the hook runs ${key}, but ${CI} job \`${form.job}\` has no step whose run is exactly \`${form.run}\``,
      );
      continue;
    }
    const extra = Object.keys(hit).filter((k) => k !== "name" && k !== "run");
    if (extra.length > 0) {
      violations.push(
        `${CI} job \`${form.job}\` step \`${form.run}\` (the ${key} counterpart) has ${extra.map((k) => `\`${k}:\``).join(", ")} — a counterpart step carries only name/run (an if:, continue-on-error:, working-directory:, shell: or env: can each make it not run, not fail, or run something else)`,
      );
    }
    if (jobOk.get(form.job) === false) {
      violations.push(
        `the ${key} counterpart sits in job \`${form.job}\`, which fails the job rules above`,
      );
    }
  }

  for (const [script, value] of Object.entries(ROOT_SCRIPTS)) {
    if (rootScripts[script] !== value) {
      violations.push(
        `package.json script "${script}" must be exactly ${JSON.stringify(value)} (a hook form or CI counterpart reaches it); got ${JSON.stringify(rootScripts[script] ?? null)}`,
      );
    }
  }
  for (const [dir, s] of Object.entries(packageScripts)) {
    const test = s.test;
    if (test == null) continue;
    const expected = `${test.replace(/ --passWithNoTests\b/, "")} --coverage`;
    if (s["test:coverage"] !== expected) {
      violations.push(
        `${dir}/package.json "test:coverage" must be its "test" plus --coverage (${JSON.stringify(expected)}) so CI's test:coverage runs every test the hook's \`test\` does; got ${JSON.stringify(s["test:coverage"] ?? null)}`,
      );
    }
  }
  return violations;
}

export function evaluate(inp: Inputs): Evaluation {
  const h = evaluateHook(inp.hook);
  const violations = [
    ...h.violations,
    ...evaluateCi(inp.ci, h.keys, inp.rootScripts, inp.packageScripts),
  ];
  // The hook's changed-file prettier extensions must sit inside CI's glob.
  const hookExts = /_fmt_exts='([^']*)'/.exec(inp.hook)?.[1];
  const ciGlob = /\{([^}]*)\}/.exec(inp.rootScripts["format:check"] ?? "")?.[1] ?? "";
  if (hookExts != null) {
    const ci = new Set(ciGlob.split(","));
    const extra = hookExts.split("|").filter((e) => !ci.has(e));
    if (extra.length > 0)
      violations.push(
        `${HOOK} _fmt_exts checks .${extra.join(", .")} but "format:check" globs only {${ciGlob}}`,
      );
  }
  return { violations, keys: [...h.keys].sort(), commands: h.commands, phases: h.phases };
}

// ---------------------------------------------------------------------------
// Test tasks are never cached — by execution

/** The tasks whose cached replay would make the hook's or CI's suite a no-op. */
const TEST_TASKS = ["test", "test:coverage"] as const;

/**
 * Non-root turbo.json files allowed to configure `test` / `test:coverage`,
 * path → reason. Empty: no package needs it, and any such override is the
 * stale-pass shape until reviewed (the resolved `cache: false` check below
 * still applies to an allowlisted file).
 */
export const PACKAGE_TURBO_TEST_ALLOWLIST: Record<string, string> = {};

export interface DryTask {
  task: string;
  directory: string;
  resolvedTaskDefinition?: { cache?: boolean };
}

export interface TestCacheInputs {
  /** `tasks` of `turbo run test test:coverage --dry=json`, or the error text. */
  dry: DryTask[] | string;
  /** Every non-root turbo.json / turbo.jsonc on disk → its text. */
  turboConfigs: Record<string, string>;
  /** package dir → scripts (as readInputs). */
  packageScripts: Record<string, Record<string, string>>;
}

export function evaluateTestCache(inp: TestCacheInputs): string[] {
  const v: string[] = [];
  for (const [file, text] of Object.entries(inp.turboConfigs)) {
    let tasks: Record<string, unknown> = {};
    try {
      tasks =
        (JSON.parse(text.replace(/^\s*\/\/.*$/gm, "")) as { tasks?: Record<string, unknown> })
          .tasks ?? {};
    } catch {
      v.push(`${file} is not parseable JSON — its task overrides are unknown (fail closed)`);
      continue;
    }
    const hits = Object.keys(tasks).filter((k) =>
      (TEST_TASKS as readonly string[]).includes(k.replace(/^[^#]*#/, "")),
    );
    if (hits.length > 0 && PACKAGE_TURBO_TEST_ALLOWLIST[file] == null)
      v.push(
        `${file} configures ${hits.map((h) => `"${h}"`).join(", ")} — a package-level override of a test task can re-enable caching (CI's test:coverage then replays a stale pass); remove it, or allowlist it with a reason in PACKAGE_TURBO_TEST_ALLOWLIST`,
      );
  }
  if (typeof inp.dry === "string") {
    v.push(
      `\`turbo run test test:coverage --dry=json\` failed — test caching unknown (fail closed): ${inp.dry}`,
    );
    return v;
  }
  const resolved = new Map<string, boolean | undefined>();
  for (const t of inp.dry) {
    if (!(TEST_TASKS as readonly string[]).includes(t.task)) continue;
    resolved.set(`${t.directory}#${t.task}`, t.resolvedTaskDefinition?.cache);
  }
  for (const [key, cache] of resolved)
    if (cache !== false)
      v.push(
        `${key} resolves to cache: ${String(cache)} — a cached test task replays a stale pass after a test breaks; it must resolve to cache: false`,
      );
  // Deny by default: a suite the dry run did not resolve is unverified.
  for (const [dir, scripts] of Object.entries(inp.packageScripts))
    for (const task of TEST_TASKS)
      if (scripts[task] != null && !resolved.has(`${dir}#${task}`))
        v.push(
          `${dir}#${task} is a script but turbo's dry run did not resolve it — its caching is unverified`,
        );
  if (resolved.size === 0) v.push("turbo's dry run resolved no test task at all (fail closed)");
  return v;
}

/**
 * Run a command and return its stdout, unbounded by construction. The dry-run
 * JSON lists every task's inputs and grows with the repo; it passed Node's
 * default 1 MiB pipe `maxBuffer` (ENOBUFS, so the gate failed closed on a
 * healthy repo). stdout and stderr go to files, never an in-memory pipe, so
 * there is no buffer to outgrow. Throws with the exit status and stderr on
 * failure. The child runs with `cleanEnv(env)`: a generic wrapper scrubs every
 * GIT_* itself (check-fixture-git-env), so no caller — `process.env` from a
 * hook included — can aim its command at another repository.
 */
export function runToFile(
  cmd: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): string {
  const dir = mkdtempSync(join(tmpdir(), "prepush-subset-"));
  try {
    const outPath = join(dir, "stdout");
    const errPath = join(dir, "stderr");
    const outFd = openSync(outPath, "w");
    const errFd = openSync(errPath, "w");
    let r: ReturnType<typeof spawnSync>;
    try {
      r = spawnSync(cmd, args, { cwd, env: cleanEnv(env), stdio: ["ignore", outFd, errFd] });
    } finally {
      closeSync(outFd);
      closeSync(errFd);
    }
    if (r.error) throw r.error;
    if (r.status !== 0)
      throw new Error(
        `${cmd} ${args.join(" ")} exited ${String(r.status ?? r.signal)}: ${readFileSync(errPath, "utf8").trim()}`,
      );
    return readFileSync(outPath, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function readTestCacheInputs(
  root: string,
  packageScripts: Record<string, Record<string, string>>,
): TestCacheInputs {
  // `root` decides the repo, never an inherited GIT_DIR / GIT_WORK_TREE (a
  // hook's environment) — so scrub every GIT_* for both child processes.
  const env = cleanEnv(process.env, { TURBO_TELEMETRY_DISABLED: "1" });
  let dry: DryTask[] | string;
  try {
    const out = runToFile(
      join(root, "node_modules", ".bin", "turbo"),
      ["run", ...TEST_TASKS, "--dry=json"],
      root,
      env,
    );
    dry = (JSON.parse(out.slice(out.indexOf("{"))) as { tasks: DryTask[] }).tasks;
  } catch (err) {
    dry = err instanceof Error ? err.message : String(err);
  }
  // Tracked AND untracked (turbo reads the working tree), every depth.
  const files = execFileSync(
    "git",
    [
      "-c",
      "core.quotePath=false",
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "*turbo.json",
      "*turbo.jsonc",
    ],
    { cwd: root, encoding: "utf8", env },
  )
    .split("\n")
    .filter(
      (f) => f && f !== "turbo.json" && /(^|\/)turbo\.jsonc?$/.test(f) && existsSync(join(root, f)),
    );
  const turboConfigs: Record<string, string> = {};
  for (const f of [...new Set(files)]) turboConfigs[f] = readFileSync(join(root, f), "utf8");
  return { dry, turboConfigs, packageScripts };
}

export function readInputs(root: string): Inputs {
  const rootScripts =
    (
      JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
        scripts?: Record<string, string>;
      }
    ).scripts ?? {};
  const packageScripts: Record<string, Record<string, string>> = {};
  const wsYaml = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  const globs = (parseYaml(wsYaml) as { packages: string[] }).packages;
  for (const g of globs) {
    const base = g.replace(/\/\*$/, "");
    for (const d of readdirSync(join(root, base))) {
      const pj = join(root, base, d, "package.json");
      if (!existsSync(pj)) continue;
      packageScripts[`${base}/${d}`] =
        (JSON.parse(readFileSync(pj, "utf8")) as { scripts?: Record<string, string> }).scripts ??
        {};
    }
  }
  return {
    hook: readFileSync(join(root, HOOK), "utf8"),
    ci: readFileSync(join(root, CI), "utf8"),
    rootScripts,
    packageScripts,
  };
}

function main(): void {
  const inp = readInputs(ROOT);
  const { violations, keys, commands, phases } = evaluate(inp);
  const testCache = readTestCacheInputs(ROOT, inp.packageScripts);
  violations.push(...evaluateTestCache(testCache));
  if (violations.length > 0) {
    failWithRepair({
      invariant:
        "pre-push ⊆ CI, deny by default — every command the local pre-push hook runs is a pure builtin, an exact allowlisted line, or a run_phase form mapped to a CI step that runs at least as wide (exact `run`, only name/run keys, in a job with the pinned if:/needs: chain, in a workflow on every push to main)",
      sites: violations,
      canonical: `${CI} (the authority) and ${HOOK} (the fast subset); turbo.json (test / test:coverage cache: false, resolved per package); the allowlists are RUN_PHASE_FORMS / EXACT_COMMANDS / ASSIGNMENTS / PINNED_FUNCTIONS / CI_FORMS / CI_JOBS / CI_JOB_STEPS / ROOT_SCRIPTS in scripts/check-prepush-subset.ts`,
      fix: "Undo the edit, or — if it is deliberate — add its CI counterpart first and then extend the matching table in scripts/check-prepush-subset.ts (a changed pinned function: review it and paste the printed hash into PINNED_FUNCTIONS). A cached test task: delete the package-level turbo.json test/test:coverage override so the root's cache: false applies.",
      doctrine: "docs/drift-defenses.md",
    });
  }
  console.log(
    `✓ check-prepush-subset: ${commands} hook command(s) read (${phases} run_phase call(s)), the GIT_* scrub first in the hook body → ${keys.length} task(s) [${keys.join(", ")}], each with an exact CI counterpart; ${Object.keys(inp.packageScripts).length} package(s)' test:coverage cover their test; ${typeof testCache.dry === "string" ? 0 : testCache.dry.filter((t) => t.task === "test" || t.task === "test:coverage").length} test task(s) resolved by \`turbo --dry=json\`, all cache: false; ${Object.keys(testCache.turboConfigs).length} non-root turbo.json file(s) scanned.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
