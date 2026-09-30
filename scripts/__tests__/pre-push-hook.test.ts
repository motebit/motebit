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
 * the first two against the real hook; `check-prepush-subset` (last block)
 * pins the third against the real ci.yml.
 *
 * Why a shim and not real turbo: the real gauntlet takes minutes. The shim
 * records each `pnpm` argv and fails the ones a case names, so the test proves
 * the exact commands + filters and the abort path. That turbo's
 * `...[origin/main]` really reaches a dependent's typecheck is turbo's
 * contract; it was verified end-to-end once on the real monorepo when this
 * landed (type error in a leaf's export → consumer typecheck red → push
 * blocked), recorded in the PR.
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
import { evaluate } from "../check-prepush-subset.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const HOOK_SRC = readFileSync(join(ROOT, ".husky/pre-push"), "utf8");

/**
 * The shim: logs argv (one line per call) and fails when argv matches
 * $SHIM_FAIL (an ERE). `pnpm exec turbo ls <filter>` answers with a package
 * count, as the real turbo does on its first stdout line.
 */
const SHIM = `#!/bin/sh
printf '%s\\n' "$*" >> "$SHIM_LOG"
case "$*" in
  "exec turbo ls --filter=[origin/main]") printf '%s packages (pnpm9)\\n' "\${SHIM_LS_CHANGED:-1}"; exit 0 ;;
  "exec turbo ls --filter=...[origin/main]") printf '%s packages (pnpm9)\\n' "\${SHIM_LS_AFFECTED:-3}"; exit 0 ;;
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
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
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
function repoWith(change: Record<string, string>): string {
  const dir = join(base, `case-${n++}`);
  const origin = `${dir}-origin.git`;
  mkdirSync(dir, { recursive: true });
  git(base, "init", "-q", "--bare", "-b", "main", origin);
  git(dir, "init", "-q", "-b", "main");
  write(dir, ".husky/pre-push", HOOK_SRC);
  write(dir, "package.json", '{ "name": "fixture" }\n');
  write(dir, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  write(dir, "packages/leaf/src/index.ts", "export const leaf = 1;\n");
  write(dir, "packages/other/src/index.ts", "export const other = 1;\n");
  write(dir, "docs/guide.md", "# Guide\n");
  write(dir, "scripts/check-x.ts", "export {};\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  git(dir, "remote", "add", "origin", origin);
  git(dir, "push", "-q", "origin", "main");
  git(dir, "fetch", "-q", "origin");
  git(dir, "checkout", "-qb", "feature");
  for (const [rel, content] of Object.entries(change)) write(dir, rel, content);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "change");
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
    if (v == null || k === "CI" || k.startsWith("MOTEBIT_PREPUSH") || k === "SKIP_COVERAGE") {
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
const TEST_CHANGED = "turbo run test --filter=[origin/main] --concurrency=2";

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

describe("pre-push hook — single leaf-package change", () => {
  it("(7) a clean change passes and runs exactly the scoped phases", () => {
    const r = runHook(repoWith(LEAF_CHANGE));
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toEqual([
      "build",
      "check",
      "test:gates",
      TYPECHECK_LINT,
      "exec turbo ls --filter=[origin/main]",
      TEST_CHANGED,
      "exec turbo ls --filter=...[origin/main]",
      "exec prettier --check --no-error-on-unmatched-pattern packages/leaf/src/index.ts",
    ]);
    // Out of scope for this diff: no audit (lockfile untouched), no gate
    // perturbation (scripts/ untouched), no coverage, no whole-repo prettier.
    expect(r.stderr).toMatch(/audit — SKIPPED/);
    expect(r.stderr).toMatch(/gate-effectiveness — SKIPPED/);
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
    expect(r.stderr).toMatch(/✗ test \(changed packages, concurrency=2\) FAILED/);
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
    const r = runHook(repoWith(LEAF_CHANGE), { SHIM_LS_CHANGED: "1", SHIM_LS_AFFECTED: "25" });
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
    const r = runHook(repoWith({ "docs/guide.md": "# Guide\n\nMore.\n" }), {
      SHIM_LS_CHANGED: "0",
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls.some((c) => c.startsWith("turbo run test"))).toBe(false);
    expect(r.stderr).toMatch(/test — SKIPPED/);
    expect(r.calls).toContain(
      "exec prettier --check --no-error-on-unmatched-pattern docs/guide.md",
    );
  });

  it("a scripts/ change adds gate-effectiveness", () => {
    const r = runHook(repoWith({ "scripts/check-x.ts": "export const x = 1;\n" }));
    expect(r.status, r.stderr).toBe(0);
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
      "turbo run test --filter=[origin/main] --concurrency=6",
    ]);
  });

  it("skips under $CI and on a detached HEAD (tag pushes)", () => {
    const repo = repoWith(LEAF_CHANGE);
    expect(runHook(repo, { CI: "true" }).calls).toEqual([]);
    git(repo, "checkout", "-q", "--detach");
    expect(runHook(repo).calls).toEqual([]);
  });
});

describe("(9, CI half) check-prepush-subset over the real hook and ci.yml", () => {
  const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const scripts = (
    JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    }
  ).scripts;

  it("every pre-push phase has a CI counterpart at least as wide", () => {
    const e = evaluate(HOOK_SRC, ci, scripts);
    expect(e.violations).toEqual([]);
    expect(e.keys).toEqual(expect.arrayContaining(["test", "typecheck", "lint", "format"]));
    // The trade-off's other half: CI's `check` job runs test:coverage over the
    // whole graph, so the dependent's failing test the hook skips still fails CI.
    const check = e.jobs.find((j) => j.name === "check");
    expect(check?.condition).toBeNull();
    expect(check?.runs).toContain("pnpm exec turbo run test:coverage --concurrency=4");
  });

  it("goes red when CI's test:coverage is narrowed with a --filter", () => {
    const narrowed = ci.replace(
      "run: pnpm exec turbo run test:coverage --concurrency=4",
      "run: pnpm exec turbo run test:coverage --concurrency=4 --filter=[origin/main]",
    );
    expect(narrowed).not.toBe(ci);
    const v = evaluate(HOOK_SRC, narrowed, scripts).violations;
    expect(v.some((s) => s.includes("runs test ("))).toBe(true);
  });

  it("goes red on a pre-push phase CI does not run", () => {
    const hook = HOOK_SRC.replace(
      '  run_phase "build" pnpm build\n',
      '  run_phase "e2e" pnpm turbo run test:e2e\n  run_phase "build" pnpm build\n',
    );
    const v = evaluate(hook, ci, scripts).violations;
    expect(v.some((s) => s.includes("cannot map"))).toBe(true);
  });

  it("goes red on the pre-2026-09-30 audit drift (all deps at critical locally, prod deps in CI)", () => {
    const hook = HOOK_SRC.replace(
      "pnpm audit --prod --audit-level=high",
      "pnpm audit --audit-level=critical",
    );
    const v = evaluate(hook, ci, scripts).violations;
    expect(v.some((s) => s.includes("runs audit"))).toBe(true);
  });

  it("goes red when the only counterpart sits in a job that skips pushes to main", () => {
    const gated = ci.replace(
      /\n {2}format:\n/,
      "\n  format:\n    if: github.event_name == 'pull_request'\n",
    );
    expect(gated).not.toBe(ci);
    const v = evaluate(HOOK_SRC, gated, scripts).violations;
    expect(v.some((s) => s.includes("runs format"))).toBe(true);
  });
});
