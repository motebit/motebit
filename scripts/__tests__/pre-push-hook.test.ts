/**
 * pre-push hook — the REAL `.husky/pre-push`, run in a throwaway git repo with
 * a stubbed `origin/main` and a recording `pnpm` shim.
 *
 * Since 2026-09-30 the hook is a FAST gate by scope (CI is the authority):
 * typecheck+lint over changed packages AND dependents, plain `test` over
 * changed packages only, prettier over changed files, every scoping decision
 * failing closed. What makes that safe is not the hook alone but three facts:
 * the hook passes the right filter to each step, a failing step aborts the
 * push, and every step has a CI counterpart at least as wide. These tests pin
 * the first two against the real hook; `check-prepush-subset` (its own test
 * file, check-prepush-subset.test.ts) pins the third against the real ci.yml.
 *
 * Why a shim and not real turbo: the real gauntlet takes minutes. The shim
 * records each `pnpm` argv and fails the ones a case names, so the test proves
 * the exact commands + filters and the abort path. (`pnpm ls -r … --filter=
 * ...{dir}` — the dependents count behind the >10 hint — answers with
 * $SHIM_LS_REACH lines.) That turbo's
 * `...[origin/main]` really reaches a dependent is turbo's contract; it was
 * verified end-to-end on the real monorepo when this landed (renaming a type
 * @motebit/circuit-breaker exports → @motebit/relay's tsc build red → push
 * blocked at the build phase; a relay test depending on the breaker's
 * default threshold → push passes locally, the relay suite CI runs fails).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanEnv } from "../lib/differential-tree.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const HOOK_SRC = readFileSync(join(ROOT, ".husky/pre-push"), "utf8");

/**
 * The shim: logs argv (one line per call) and fails when argv matches
 * $SHIM_FAIL (an ERE). `pnpm ls -r … --parseable` answers with $SHIM_LS_REACH
 * lines, one per package reached, as the real pnpm does. With $SHIM_ENV_LOG
 * set, each call also logs the GIT_* variable NAMES it inherited (`GIT:` = none).
 */
const SHIM = `#!/bin/sh
printf '%s\\n' "$*" >> "$SHIM_LOG"
if [ -n "$SHIM_ENV_LOG" ]; then
  printf 'GIT:%s\\n' "$(env | grep -o '^GIT_[A-Za-z0-9_]*=' | tr -d '=' | sort | tr '\\n' ' ')" >> "$SHIM_ENV_LOG"
fi
case "$*" in
  "ls -r --depth -1 --parseable "*)
    # pnpm's dependents walk: one line per package reached (changed + dependents).
    i=0; while [ "$i" -lt "\${SHIM_LS_REACH:-1}" ]; do echo "/pkg/$i"; i=$((i + 1)); done
    exit 0 ;;
esac
if [ -n "$SHIM_FAIL" ] && printf '%s\\n' "$*" | grep -Eq "$SHIM_FAIL"; then
  echo "shim: failing $*" >&2
  exit 7
fi
exit 0
`;

let base: string;
let shimDir: string;

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: cleanEnv(process.env, {
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    }),
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

function write(repo: string, rel: string, content: string): void {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), content);
}

let n = 0;
/**
 * A fresh clone of a tiny origin (main = one commit), on branch `feature`
 * with `change` applied and committed. The hook is the real one.
 */
interface RepoOpts {
  /** The hook under test — the real one unless a mutant is being run. */
  hook?: string;
  /** Paths deleted in the committed change. */
  remove?: string[];
  /** Runs after the change is committed (uncommitted/untracked edits). */
  after?: (dir: string) => void;
  /** Extra files written into origin/main itself (the base commit). */
  base?: Record<string, string>;
}

function repoWith(change: Record<string, string>, opts: RepoOpts = {}): string {
  const dir = join(base, `case-${n++}`);
  const origin = `${dir}-origin.git`;
  mkdirSync(dir, { recursive: true });
  git(base, "init", "-q", "--bare", "-b", "main", origin);
  git(dir, "init", "-q", "-b", "main");
  write(dir, ".husky/pre-push", opts.hook ?? HOOK_SRC);
  write(dir, "package.json", '{ "name": "fixture" }\n');
  write(dir, "pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n  - "apps/*"\n');
  write(dir, "packages/leaf/package.json", '{ "name": "leaf" }\n');
  write(dir, "packages/other/package.json", '{ "name": "other" }\n');
  write(dir, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  write(dir, "packages/leaf/src/index.ts", "export const leaf = 1;\n");
  write(dir, "packages/other/src/index.ts", "export const other = 1;\n");
  write(dir, "docs/guide.md", "# Guide\n");
  write(dir, "scripts/check-x.ts", "export {};\n");
  write(dir, "coverage-graduation.json", "{}\n");
  // A workspace-root dir with no package.json (the real packages/github-action/
  // is an action.yml + README), and a package a change can delete outright.
  write(dir, "packages/github-action/action.yml", "name: x\n");
  write(dir, "packages/gone/package.json", '{ "name": "gone" }\n');
  write(dir, "packages/gone/src/index.ts", "export const gone = 1;\n");
  write(
    dir,
    "packages/leaf/src/moved.ts",
    "export const moved = 'a long enough body to rename';\n",
  );
  for (const [rel, content] of Object.entries(opts.base ?? {})) write(dir, rel, content);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  git(dir, "remote", "add", "origin", origin);
  git(dir, "push", "-q", "origin", "main");
  git(dir, "fetch", "-q", "origin");
  git(dir, "checkout", "-qb", "feature");
  for (const rel of opts.remove ?? []) rmSync(join(dir, rel));
  for (const [rel, content] of Object.entries(change)) write(dir, rel, content);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "change");
  opts.after?.(dir);
  return dir;
}

interface Run {
  status: number | null;
  stderr: string;
  calls: string[];
}

function runHook(repo: string, env: Record<string, string> = {}): Run {
  const log = join(repo, "..", `${repo.split("/").pop()}-shim.log`);
  rmSync(log, { force: true });
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    // The hook exits at once under $CI — CI's gate-effectiveness job runs this
    // file with CI=true, so strip it (and any operator knobs) for the child.
    // GIT_* too: an inherited GIT_DIR would point the hook's git at another
    // repository (a test that wants one passes it in `env`).
    if (
      v == null ||
      k === "CI" ||
      k.startsWith("MOTEBIT_PREPUSH") ||
      k === "SKIP_COVERAGE" ||
      k.startsWith("GIT_")
    ) {
      continue;
    }
    childEnv[k] = v;
  }
  const r = spawnSync("sh", ["-e", ".husky/pre-push"], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...childEnv,
      PATH: `${shimDir}:${process.env.PATH ?? ""}`,
      SHIM_LOG: log,
      ...env,
    },
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  return { status: r.status, stderr: r.stderr, calls };
}

const LEAF_CHANGE = { "packages/leaf/src/index.ts": "export const leaf = 2;\n" };
const TYPECHECK_LINT = "turbo run typecheck lint --filter=...[origin/main] --concurrency=2";
const TEST_CHANGED = "turbo run test --filter=./packages/leaf --concurrency=2";
const REACH_LEAF = "ls -r --depth -1 --parseable --filter=...{./packages/leaf}";

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "prepush-hook-"));
  shimDir = join(base, "bin");
  mkdirSync(shimDir);
  writeFileSync(join(shimDir, "pnpm"), SHIM);
  chmodSync(join(shimDir, "pnpm"), 0o755);
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("pre-push hook — pushed from a LINKED worktree (#835, 2026-10-02)", () => {
  // Git exports GIT_DIR=<repo>/.git/worktrees/<name> (+ GIT_PREFIX,
  // GIT_EXEC_PATH, GIT_EDITOR) into a linked worktree's hooks. Inherited by
  // `pnpm test:gates`, it pointed fixture git commands at the REAL repository
  // (core.bare = true, `fixture` commits on the pushing branch). The hook
  // unsets every GIT_* first; its own git still finds the repo from cwd.
  it("no phase inherits a GIT_* variable, and the scope is the worktree's own diff", () => {
    const repo = repoWith(LEAF_CHANGE);
    const wt = `${repo}-wt`;
    git(repo, "worktree", "add", "-q", "-b", "feature-wt", wt);
    const gitDir = git(wt, "rev-parse", "--absolute-git-dir").trim();
    expect(gitDir).toBe(join(repo, ".git", "worktrees", `${repo.split("/").pop()}-wt`));
    const envLog = `${wt}-env.log`;
    const r = runHook(wt, {
      GIT_DIR: gitDir,
      GIT_PREFIX: "",
      GIT_EXEC_PATH: git(repo, "--exec-path").trim(),
      GIT_EDITOR: ":",
      SHIM_ENV_LOG: envLog,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toEqual([
      "build",
      "check",
      TYPECHECK_LINT,
      TEST_CHANGED,
      REACH_LEAF,
      "exec prettier --check --no-error-on-unmatched-pattern -- packages/leaf/src/index.ts",
    ]);
    const seen = readFileSync(envLog, "utf8").split("\n").filter(Boolean);
    expect(seen).toEqual(r.calls.map(() => "GIT:"));
  });
});

describe("pre-push hook — single leaf-package change", () => {
  it("(7) a clean change passes and runs exactly the scoped phases", () => {
    const r = runHook(repoWith(LEAF_CHANGE));
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toEqual([
      "build",
      "check",
      TYPECHECK_LINT,
      TEST_CHANGED,
      REACH_LEAF,
      "exec prettier --check --no-error-on-unmatched-pattern -- packages/leaf/src/index.ts",
    ]);
    // Out of scope for this diff: no audit (lockfile untouched), no gate
    // perturbation (scripts/ untouched), no coverage, no whole-repo prettier.
    expect(r.stderr).toMatch(/audit — SKIPPED/);
    expect(r.stderr).toMatch(/gate self-tests \+ gate-effectiveness — SKIPPED/);
    expect(r.stderr).toMatch(/✓ pre-push gauntlet passed/);
  });

  it("(1) a formatting error in a changed file blocks — prettier sees only changed files", () => {
    const r = runHook(repoWith(LEAF_CHANGE), { SHIM_FAIL: "^exec prettier --check" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/✗ format:check \(changed files\) FAILED/);
    const prettier = r.calls.find((c) => c.startsWith("exec prettier"));
    expect(prettier).toContain("packages/leaf/src/index.ts");
    expect(prettier).not.toContain("packages/other");
    expect(r.calls).not.toContain("format:check");
  });

  it("(2)(3)(4) a type or lint error — in the package or a DEPENDENT — blocks: typecheck+lint run over changed + dependents", () => {
    const r = runHook(repoWith(LEAF_CHANGE), { SHIM_FAIL: "^turbo run typecheck lint" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/✗ typecheck\+lint \(changed \+ dependents, concurrency=2\) FAILED/);
    // `...[origin/main]` = the changed packages plus every package that
    // depends on them — the consumer whose typecheck a leaf export breaks.
    expect(r.calls).toContain(TYPECHECK_LINT);
    // Fail-stop: nothing after the failing phase ran.
    expect(r.calls.some((c) => c.startsWith("turbo run test"))).toBe(false);
  });

  it("(5) a failing test in the changed package blocks", () => {
    const r = runHook(repoWith(LEAF_CHANGE), { SHIM_FAIL: "^turbo run test " });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/✗ test \(1 changed package\(s\), concurrency=2\) FAILED/);
  });

  it("(6) a gate violation blocks", () => {
    const r = runHook(repoWith(LEAF_CHANGE), { SHIM_FAIL: "^check$" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/✗ gates \(pnpm check\) FAILED/);
    expect(r.calls.at(-1)).toBe("check");
  });

  it("(8) an uncomputable diff falls back to running every step at full width (fail closed)", () => {
    const repo = repoWith(LEAF_CHANGE);
    git(repo, "update-ref", "-d", "refs/remotes/origin/main");
    const r = runHook(repo);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/UNFILTERED \(fail closed\)/);
    expect(r.calls).toEqual([
      "build",
      "audit --prod --audit-level=high --ignore-registry-errors",
      "check",
      "test:gates",
      "check-gates-effective",
      "turbo run typecheck lint --concurrency=2",
      "turbo run test --concurrency=2",
      "format:check",
    ]);
  });

  it("(9) a DEPENDENT's tests are not run locally — the stated trade-off — and the hook says so past 10 dependents", () => {
    const r = runHook(repoWith(LEAF_CHANGE), { SHIM_LS_REACH: "25" });
    expect(r.status, r.stderr).toBe(0);
    const tests = r.calls.filter((c) => /^turbo run .*\btest\b/.test(c));
    // No `...` on the test filter: dependents' suites are CI's.
    expect(tests).toEqual([TEST_CHANGED]);
    expect(r.stderr).toMatch(/reaches 24 dependent package\(s\).*run only in CI/);
    expect(r.stderr).toMatch(/MOTEBIT_PREPUSH_FULL=1 git push/);
  });
});

describe("pre-push hook — scope follows the diff", () => {
  it("a docs-only change runs no tests and formats only the doc", () => {
    const r = runHook(repoWith({ "docs/guide.md": "# Guide\n\nMore.\n" }));
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls.some((c) => c.startsWith("turbo run test"))).toBe(false);
    expect(r.stderr).toMatch(/test — SKIPPED/);
    expect(r.calls).toContain(
      "exec prettier --check --no-error-on-unmatched-pattern -- docs/guide.md",
    );
  });

  it("tests follow the DIFF's package dirs, not turbo's [origin/main] (which marks all 74 packages for a core edit)", () => {
    const r = runHook(
      repoWith({
        "packages/leaf/src/index.ts": "export const leaf = 2;\n",
        "packages/other/src/index.ts": "export const other = 2;\n",
      }),
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls.filter((c) => c.startsWith("turbo run test"))).toEqual([
      "turbo run test --filter=./packages/leaf --filter=./packages/other --concurrency=2",
    ]);
    expect(r.calls.some((c) => c.includes("test --filter=[origin/main]"))).toBe(false);
  });

  it("an unreadable workspace manifest runs every test (fail closed)", () => {
    const repo = repoWith(LEAF_CHANGE);
    rmSync(join(repo, "pnpm-workspace.yaml"));
    const r = runHook(repo);
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toContain("turbo run test --concurrency=2");
    expect(r.stderr).toMatch(/ALL packages — package scope unknown, fail closed/);
  });

  it("a scripts/ change adds the gate self-tests and gate-effectiveness", () => {
    const r = runHook(repoWith({ "scripts/check-x.ts": "export const x = 1;\n" }));
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toContain("test:gates");
    expect(r.calls).toContain("check-gates-effective");
  });

  it("a lockfile change adds the audit (CI's exact command) and formats the whole repo", () => {
    const r = runHook(repoWith({ "pnpm-lock.yaml": "lockfileVersion: '9.0'\n# bumped\n" }));
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toContain("audit --prod --audit-level=high --ignore-registry-errors");
    expect(r.calls).toContain("format:check");
  });

  it("MOTEBIT_PREPUSH_FULL=1 restores the old gauntlet (coverage over changed + dependents)", () => {
    const r = runHook(repoWith(LEAF_CHANGE), { MOTEBIT_PREPUSH_FULL: "1" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toContain(
      "turbo run typecheck lint test:coverage --filter=...[origin/main] --concurrency=2",
    );
    expect(r.calls).not.toContain(TEST_CHANGED);
  });

  it("MOTEBIT_PREPUSH_CONCURRENCY reaches every turbo step", () => {
    const r = runHook(repoWith(LEAF_CHANGE), { MOTEBIT_PREPUSH_CONCURRENCY: "6" });
    expect(r.calls.filter((c) => c.startsWith("turbo run"))).toEqual([
      "turbo run typecheck lint --filter=...[origin/main] --concurrency=6",
      "turbo run test --filter=./packages/leaf --concurrency=6",
    ]);
  });

  it("skips under $CI and on a detached HEAD (tag pushes)", () => {
    const repo = repoWith(LEAF_CHANGE);
    expect(runHook(repo, { CI: "true" }).calls).toEqual([]);
    git(repo, "checkout", "-q", "--detach");
    expect(runHook(repo).calls).toEqual([]);
  });
});

/**
 * Path-shape and exit-status cases, each written as a SCENARIO — a function of
 * the hook source that says whether the hook behaved correctly — so the same
 * scenario runs against the real hook (must hold) and against the mutants in
 * HOOK_MUTANTS below (must break). Each one was RED on 86a3c1e5c before the
 * fix it names landed.
 */
interface Scenario {
  ok: boolean;
  detail: string;
}
const show = (r: Run) => `status=${r.status}\ncalls=${JSON.stringify(r.calls)}\n${r.stderr}`;
const testCalls = (r: Run) => r.calls.filter((c) => c.startsWith("turbo run test"));
/** The test phase ran at FULL width (unfiltered), and only that test call. */
const allTests = (r: Run) =>
  JSON.stringify(testCalls(r)) === JSON.stringify(["turbo run test --concurrency=2"]);

const SCENARIOS: Record<string, (hook: string) => Scenario> = {
  /** C1: git quotes non-ASCII paths ("packages/leaf/src/na\303\257ve.ts") unless core.quotePath=false. */
  "non-ASCII path": (hook) => {
    const r = runHook(
      repoWith({ "packages/leaf/src/naïve.ts": "export const n = 1;\n" }, { hook }),
    );
    return {
      ok:
        r.status === 0 &&
        testCalls(r).includes(TEST_CHANGED) &&
        r.calls.some(
          (c) => c.startsWith("exec prettier") && c.includes("packages/leaf/src/naïve.ts"),
        ),
      detail: show(r),
    };
  },
  /** C1 residue: a path git STILL quotes (a `"` in the name) cannot be scoped — fail closed. */
  "still-quoted path fails closed": (hook) => {
    const r = runHook(repoWith({ 'packages/leaf/src/q"t.ts': "export const q = 1;\n" }, { hook }));
    return {
      ok:
        r.status === 0 &&
        /UNFILTERED \(fail closed\)/.test(r.stderr) &&
        r.calls.includes("turbo run test --concurrency=2") &&
        r.calls.includes("format:check"),
      detail: show(r),
    };
  },
  /** C2: a cross-package rename lists only the destination unless --no-renames. */
  "cross-package rename tests both packages": (hook) => {
    const r = runHook(
      repoWith(
        { "packages/other/src/moved.ts": "export const moved = 'a long enough body to rename';\n" },
        { hook, remove: ["packages/leaf/src/moved.ts"] },
      ),
    );
    return {
      ok:
        r.status === 0 &&
        testCalls(r).includes(
          "turbo run test --filter=./packages/leaf --filter=./packages/other --concurrency=2",
        ),
      detail: show(r),
    };
  },
  /** C3: the last changed workspace dir has no package.json → `[ -f ] && printf` is the loop's status. */
  /**
   * C3 + A1: the last changed workspace dir has no package.json → it is not a
   * package, so the path is OUTSIDE every package → every test (deny by default).
   */
  "changed dir without package.json": (hook) => {
    const r = runHook(repoWith({ "packages/github-action/action.yml": "name: y\n" }, { hook }));
    return {
      ok: r.status === 0 && allTests(r) && /gauntlet passed/.test(r.stderr),
      detail: show(r),
    };
  },
  /** A deleted package's paths sit in no package any more → every test. */
  "deleted package": (hook) => {
    const r = runHook(
      repoWith({}, { hook, remove: ["packages/gone/package.json", "packages/gone/src/index.ts"] }),
    );
    return {
      ok: r.status === 0 && allTests(r) && /gauntlet passed/.test(r.stderr),
      detail: show(r),
    };
  },
  /** A1: spec/ conformance data a package test reads — the hook skipped tests (cold review probe). */
  "spec/ change runs every test": (hook) => {
    const r = runHook(
      repoWith(
        { "spec/conformance/routing-transcript/corpus.json": '{ "valid": false }\n' },
        { hook },
      ),
    );
    return { ok: r.status === 0 && allTests(r), detail: show(r) };
  },
  /** A1: vitest.shared.ts (every vitest config imports it) — the hook skipped tests. */
  "vitest.shared.ts change runs every test": (hook) => {
    const r = runHook(
      repoWith({ "vitest.shared.ts": "export const exclude = ['**/src/**'];\n" }, { hook }),
    );
    return { ok: r.status === 0 && allTests(r), detail: show(r) };
  },
  /** A1: a lockfile-only bump — main tested the lockfile-affected packages; the hook skipped tests. */
  "lockfile-only bump runs every test": (hook) => {
    const r = runHook(
      repoWith({ "pnpm-lock.yaml": "lockfileVersion: '9.0'\n# bumped\n" }, { hook }),
    );
    return { ok: r.status === 0 && allTests(r), detail: show(r) };
  },
  /** A1: a root file next to a package change still widens the test phase. */
  "root file + package change runs every test": (hook) => {
    const r = runHook(repoWith({ ...LEAF_CHANGE, "tsconfig.base.json": "{}\n" }, { hook }));
    return { ok: r.status === 0 && allTests(r), detail: show(r) };
  },
  /** A1 allowlist is markdown-only: a non-.md file under docs/ is not scoped. */
  "non-markdown file under docs/ runs every test": (hook) => {
    const r = runHook(repoWith({ "docs/operator/compose.example.yml": "x: 1\n" }, { hook }));
    return { ok: r.status === 0 && allTests(r), detail: show(r) };
  },
  /** A1 allowlist (control): docs/**\/*.md and .changeset/*.md stay scoped — no tests. */
  "allowlisted docs + changeset stay scoped": (hook) => {
    const r = runHook(
      repoWith(
        { "docs/guide.md": "# Guide\n\nMore.\n", ".changeset/x.md": "---\n---\nx\n" },
        { hook },
      ),
    );
    return {
      ok: r.status === 0 && testCalls(r).length === 0 && /test — SKIPPED/.test(r.stderr),
      detail: show(r),
    };
  },
  /** A2: a prettier config inside a package moves CI's whole-repo verdict (cold review probe). */
  "nested .prettierrc.json triggers whole-repo format": (hook) => {
    const r = runHook(
      repoWith({ "packages/leaf/.prettierrc.json": '{ "semi": false }\n' }, { hook }),
    );
    return { ok: r.status === 0 && r.calls.includes("format:check"), detail: show(r) };
  },
  "nested prettier.config.mjs triggers whole-repo format": (hook) => {
    const r = runHook(repoWith({ "apps/x/prettier.config.mjs": "export default {};\n" }, { hook }));
    return { ok: r.status === 0 && r.calls.includes("format:check"), detail: show(r) };
  },
  ".editorconfig triggers whole-repo format": (hook) => {
    const r = runHook(
      repoWith({ "packages/leaf/.editorconfig": "[*]\nindent_size = 8\n" }, { hook }),
    );
    return { ok: r.status === 0 && r.calls.includes("format:check"), detail: show(r) };
  },
  "a package.json (prettier key) triggers whole-repo format": (hook) => {
    const r = runHook(
      repoWith(
        { "packages/leaf/package.json": '{ "name": "leaf", "prettier": { "semi": false } }\n' },
        { hook },
      ),
    );
    return { ok: r.status === 0 && r.calls.includes("format:check"), detail: show(r) };
  },
  /** Final cold review (3): prettier 3 honours .gitignore — a nested one moves CI's verdict. */
  "nested .gitignore triggers whole-repo format": (hook) => {
    const r = runHook(repoWith({ "packages/leaf/.gitignore": "src/\n" }, { hook }));
    return { ok: r.status === 0 && r.calls.includes("format:check"), detail: show(r) };
  },
  /**
   * Final cold review (1): a changed file named `-x.md` reached prettier as an
   * OPTION (prettier exited 0, CI's format:check failed). Every path must be
   * an operand: after a `--`, or not starting with `-`.
   */
  "a dash-leading file name reaches prettier as a path, not an option": (hook) => {
    const r = runHook(repoWith({ "-x.md": "# X\n" }, { hook }));
    const call = r.calls.find((c) => c.startsWith("exec prettier")) ?? "";
    const argv = call.split(" ");
    const dd = argv.indexOf("--");
    const operands = argv.filter((a, i) => (dd >= 0 && i > dd) || (!a.startsWith("-") && i > 1));
    return {
      ok: r.status === 0 && operands.some((a) => a === "-x.md" || a === "./-x.md"),
      detail: show(r),
    };
  },
  /** A3: a workspace glob the hook cannot map (examples/*\/*) → package scope unknown → every test. */
  "unmappable workspace glob runs every test": (hook) => {
    const r = runHook(
      repoWith(LEAF_CHANGE, {
        hook,
        base: {
          "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n  - "apps/*"\n  - "examples/*/*"\n',
        },
      }),
    );
    return { ok: r.status === 0 && allTests(r), detail: show(r) };
  },
  /** C3: MOTEBIT_PREPUSH_QUIET=1 made the hook's LAST command `[ -z set ] && printf` → exit 1. */
  "MOTEBIT_PREPUSH_QUIET=1 passes silently": (hook) => {
    const r = runHook(repoWith(LEAF_CHANGE, { hook }), { MOTEBIT_PREPUSH_QUIET: "1" });
    return {
      ok: r.status === 0 && r.stderr === "" && r.calls.includes(TEST_CHANGED),
      detail: show(r),
    };
  },
  /** An uncommitted edit to a tracked file is in the tree turbo + prettier see. */
  "uncommitted edit is in scope": (hook) => {
    const r = runHook(
      repoWith(
        { "docs/guide.md": "# Guide\n\nMore.\n" },
        { hook, after: (d) => write(d, "packages/leaf/src/index.ts", "export const leaf = 3;\n") },
      ),
    );
    return { ok: r.status === 0 && testCalls(r).includes(TEST_CHANGED), detail: show(r) };
  },
  /** An untracked file is in the tree turbo + prettier see. */
  "untracked file is in scope": (hook) => {
    const r = runHook(
      repoWith(
        { "docs/guide.md": "# Guide\n\nMore.\n" },
        { hook, after: (d) => write(d, "packages/other/src/new.ts", "export const n = 1;\n") },
      ),
    );
    return {
      ok:
        r.status === 0 &&
        testCalls(r).includes("turbo run test --filter=./packages/other --concurrency=2"),
      detail: show(r),
    };
  },
  /** coverage-graduation.json is a gate INPUT (#589) — same trigger as CI's `changes` job. */
  "coverage-graduation.json triggers the gate self-tests": (hook) => {
    const r = runHook(repoWith({ "coverage-graduation.json": '{ "x": 1 }\n' }, { hook }));
    return {
      ok:
        r.status === 0 &&
        r.calls.includes("test:gates") &&
        r.calls.includes("check-gates-effective"),
      detail: show(r),
    };
  },
  /** A failing phase aborts the push with a non-zero code. */
  "a failing gate blocks": (hook) => {
    const r = runHook(repoWith(LEAF_CHANGE, { hook }), { SHIM_FAIL: "^check$" });
    return {
      ok: r.status !== 0 && /✗ gates \(pnpm check\) FAILED/.test(r.stderr),
      detail: show(r),
    };
  },
};

describe("pre-push hook — path shapes and exit status (scenarios on the real hook)", () => {
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    it(name, () => {
      const s = scenario(HOOK_SRC);
      expect(s.ok, s.detail).toBe(true);
    });
  }
});

/**
 * Permanent mutant table: each row is a plausible edit to the hook that
 * silently narrows what it checks or turns a pass into a silent failure, and
 * the scenario that must KILL it (go false). A row whose `from` no longer
 * appears in the hook fails too — rename the row with the hook, never drop it.
 */
const HOOK_MUTANTS: { name: string; from: string | RegExp; to: string; killedBy: string }[] = [
  {
    name: "uncommitted `git diff HEAD` term dropped from changed_files",
    from: /\n\s*git -c core\.quotePath=false diff --no-renames --name-only HEAD -- "\$@" &&/,
    to: "",
    killedBy: "uncommitted edit is in scope",
  },
  {
    name: "untracked `ls-files --others` term dropped from changed_files",
    from: /&&\n\s*git -c core\.quotePath=false ls-files --others --exclude-standard -- "\$@";/,
    to: ";",
    killedBy: "untracked file is in scope",
  },
  {
    name: "coverage-graduation.json dropped from the gate-input trigger",
    from: "changed_files scripts/ coverage-graduation.json",
    to: "changed_files scripts/",
    killedBy: "coverage-graduation.json triggers the gate self-tests",
  },
  {
    name: "core.quotePath=false dropped (C1)",
    from: /git -c core\.quotePath=false /g,
    to: "git ",
    killedBy: "non-ASCII path",
  },
  {
    name: "still-quoted-path fail-closed dropped (C1 residue)",
    from: /\n\s*if printf '%s\\n' "\$_cf" \| grep -q '\^"'; then\n[^\n]*\n[^\n]*\n\s*fi/,
    to: "",
    killedBy: "still-quoted path fails closed",
  },
  {
    name: "--no-renames dropped (C2)",
    from: / --no-renames/g,
    to: "",
    killedBy: "cross-package rename tests both packages",
  },
  {
    name: "package.json filter back to `[ -f ] && printf` (C3)",
    from: 'if [ -f "$_d/package.json" ]; then printf \'%s\\n\' "$_d"; fi',
    to: '[ -f "$_d/package.json" ] && printf \'%s\\n\' "$_d"',
    killedBy: "changed dir without package.json",
  },
  {
    name: "closing banner back to `[ -z QUIET ] && printf` as the last command (C3)",
    from: /if \[ -z "\$MOTEBIT_PREPUSH_QUIET" \]; then\n(\s*printf '\\n✓ pre-push gauntlet passed[^\n]*\n)\s*fi\n/,
    to: '[ -z "$MOTEBIT_PREPUSH_QUIET" ] &&\n$1',
    killedBy: "MOTEBIT_PREPUSH_QUIET=1 passes silently",
  },
  {
    name: "run_phase exits 0 on failure (the `$?`-read-after-`fi` shape)",
    from: /else\n(\s*)_rc=\$\?\n/,
    to: "else\n$1_rc=0\n",
    killedBy: "a failing gate blocks",
  },
  {
    name: "A1: unscoped-path widening dropped (root files scoped again)",
    from: 'elif [ -n "$_unscoped_paths" ]; then',
    to: "elif false; then",
    killedBy: "spec/ change runs every test",
  },
  {
    name: "A1: allowlist widened from docs/**/*.md to all of docs/",
    from: "^(docs/.+\\.md|",
    to: "^(docs/.+|",
    killedBy: "non-markdown file under docs/ runs every test",
  },
  {
    name: "A1: package.json existence dropped from the in-package test",
    from: '{ [ -z "$_pd" ] || [ ! -f "$_pd/package.json" ]; }',
    to: '[ -z "$_pd" ]',
    killedBy: "deleted package",
  },
  {
    name: "A3: unmappable-workspace-glob fail-closed dropped",
    from: ' && [ -z "$_ws_unmapped" ]',
    to: "",
    killedBy: "unmappable workspace glob runs every test",
  },
  {
    name: "A2: prettier config matched at the repo root only",
    from: "grep -E '(^|/)(\\.prettierrc",
    to: "grep -E '^(\\.prettierrc",
    killedBy: "nested .prettierrc.json triggers whole-repo format",
  },
  {
    name: "A2: prettier.config.* dropped",
    from: "|prettier\\.config\\.[^/]*",
    to: "",
    killedBy: "nested prettier.config.mjs triggers whole-repo format",
  },
  {
    name: "A2: .editorconfig dropped",
    from: "|\\.editorconfig",
    to: "",
    killedBy: ".editorconfig triggers whole-repo format",
  },
  {
    name: 'A2: package manifests dropped (a "prettier" key is config)',
    from: "|package\\.json|package\\.yaml",
    to: "",
    killedBy: "a package.json (prettier key) triggers whole-repo format",
  },
  {
    name: "final review (3): .gitignore dropped (prettier 3 honours it)",
    from: "|\\.gitignore",
    to: "",
    killedBy: "nested .gitignore triggers whole-repo format",
  },
  {
    name: "final review (1): paths handed to prettier without `--` (a `-x.md` is an option)",
    from: "--no-error-on-unmatched-pattern --",
    to: "--no-error-on-unmatched-pattern",
    killedBy: "a dash-leading file name reaches prettier as a path, not an option",
  },
];

/**
 * The scoped-path allowlist's REASON, pinned. The hook keeps exactly two
 * outside-package path shapes scoped (no tests): `docs/**\/*.md` and
 * `.changeset/*.md`. That is sound only while no workspace package's build or
 * test READS them. This scans every git-tracked non-markdown file under the
 * workspace roots for a filesystem read / path construction that names a
 * `docs` or `.changeset` segment, or a `../`-relative path into either.
 * Aperture: string-literal paths (a path assembled from variables is not
 * seen) — the same aperture as check-turbo-global-deps' config scan. Adding
 * a path shape to the allowlist means extending this test with its reason.
 */
describe("pre-push hook — scoped-path allowlist", () => {
  it("the allowlist in the hook is exactly docs/**/*.md and .changeset/*.md", () => {
    const m = /grep -vE '(\^\([^']*\)\$)' \|\n\s*while IFS= read -r _p/.exec(HOOK_SRC);
    expect(m?.[1]).toBe("^(docs/.+\\.md|\\.changeset/[^/]+\\.md)$");
  });

  it("no workspace package reads docs/ or .changeset/ (the allowlist's reason)", () => {
    const files = spawnSync(
      "git",
      ["-c", "core.quotePath=false", "ls-files", "--", "packages", "apps", "services"],
      { cwd: ROOT, encoding: "utf8", env: cleanEnv() },
    )
      .stdout.split("\n")
      .filter((f) => f && !/\.(md|mdx|txt|png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|wasm)$/.test(f));
    expect(files.length).toBeGreaterThan(500);
    const READ =
      /\b(readFileSync|readFile|readdirSync|readdir|existsSync|statSync|createReadStream|join|resolve|new URL|import)\s*\([^)]*["'`](?:\.\.\/)*(?:docs|\.changeset)(?:\/|["'`])/;
    const REL = /(?:\.\.\/)+(?:docs|\.changeset)\//;
    const hits: string[] = [];
    for (const f of files) {
      let text: string;
      try {
        text = readFileSync(join(ROOT, f), "utf8");
      } catch {
        continue;
      }
      text.split("\n").forEach((line, i) => {
        const code = line.trim();
        if (/^(\*|\/\/|\/\*|#)/.test(code)) return; // comments
        // A markdown link in a string (`[x](../../docs/…)`) is prose, not a read.
        const stripped = code.replace(/\]\((?:\.\.\/)+(?:docs|\.changeset)\/[^)]*\)/g, "");
        if (READ.test(stripped) || REL.test(stripped))
          hits.push(`${f}:${i + 1}: ${code.slice(0, 160)}`);
      });
    }
    expect(hits, "a package reads an allowlisted path — drop it from the hook's allowlist").toEqual(
      [],
    );
  });
});

describe("pre-push hook — mutant table (every mutant must be killed)", () => {
  for (const m of HOOK_MUTANTS) {
    it(`${m.name} — killed by "${m.killedBy}"`, () => {
      const mutant = HOOK_SRC.replace(m.from, m.to);
      expect(mutant, `mutant "${m.name}" no longer applies to the hook`).not.toBe(HOOK_SRC);
      const scenario = SCENARIOS[m.killedBy];
      expect(scenario, `unknown scenario ${m.killedBy}`).toBeDefined();
      const s = scenario!(mutant);
      expect(s.ok, `mutant survived:\n${s.detail}`).toBe(false);
    });
  }
});

// The CI half (pre-push ⊆ CI over the real ci.yml, with its mutation table)
// lives in check-prepush-subset.test.ts.
