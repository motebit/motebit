/**
 * Tests-typechecked drift gate (#1000).
 *
 * Enforces: every test file of every workspace package is type-checked by the
 * package's `typecheck` script, under compiler options identical to the
 * build's (a closed allowlist of emit/layout keys aside), unconditionally.
 *
 * ## Why this gate exists
 *
 * The published packages built their declarations from a `tsconfig.json`
 * that excludes `src/__tests__` (tests must never ship in `dist/`), and their
 * `typecheck` script (`tsc --noEmit`) compiled that same tsconfig. So their
 * test files were type-checked nowhere: vitest strips types without checking
 * them, and the `tsconfig.eslint.json` that did include them is only read by
 * the linter's parser, which never reports type errors. The 2026-09-30 audit
 * found 90 latent errors in `packages/crypto` alone.
 *
 * ## The law: positive evidence, never inference
 *
 * Two earlier versions of this gate parsed the `typecheck` script and compared
 * a hand-written list of strictness flags; both rounds of cold review broke
 * them (an extra `--noCheck` on the command line, `"noCheck": true` in the
 * config, a strict-implied flag missing from the list, `// @ts-nocheck`, a
 * test under a directory the gate's own walker skipped). So nothing here is
 * inferred from script text or a flag list:
 *
 * 1. **What is a test file** is what vitest loads — vitest's own config
 *    loading and globbing (`scripts/lib/vitest-collect.mjs`), run with the
 *    exact arguments each `test` / `test:*` script passes to `vitest`
 *    (`-c`/`--config`/`--dir`/`--root` included, parsed by vitest's own
 *    `parseCLI`), plus EVERY file-valued entry of the resolved config: a key
 *    in `VITEST_TEST_CODE_KEYS` (setupFiles, globalSetup, environment,
 *    reporters, snapshotSerializers, …) is collected; a key in
 *    `VITEST_NON_CODE_KEYS` (the config file, coverage selection, watch
 *    triggers) is not; any other key with a file value fails ("unknown
 *    file-valued vitest key") — the list is enumerated from the resolved
 *    config object, never hand-picked. United with every git-listed file named
 *    `*.test.*` / `*.spec.*` or under a `__tests__/` directory (tracked, or
 *    untracked-and-not-ignored), declaration files included. No directory is
 *    skipped by name.
 * 2. **Canary execution.** For every directory holding such a file, the gate
 *    writes a canary `__typecheck_canary_<rand>.test.<ext>` with a guaranteed
 *    type error (one per TS extension present there), runs the package's REAL
 *    `typecheck` script (`pnpm run typecheck`, as turbo runs it), and requires
 *    a non-zero exit whose output reports a TS error in EVERY canary. A `&&`
 *    chain can stop at its first failing `tsc`, so canaries still unreported
 *    are re-run alone until a pass reports none of them. Canaries are always
 *    removed (try/finally, exit and signal handlers, and a drain at start).
 *    A canary's content names its run id, pid and host; the drain removes
 *    only untracked files byte-identical to a canary whose run is no longer
 *    live (dead pid on this host, or older than an hour) — never a file by
 *    its name, never a concurrent run's canary.
 * 3. **Recorded invocations.** Every `tsc` a script actually runs is recorded
 *    with its exact argv by a node preload (`scripts/lib/tsc-recorder.cjs`),
 *    in a record-only pass that enumerates the whole chain without compiling,
 *    and again during the canary passes. An argv carrying anything beyond
 *    `-p`/`--project <x>`, `--noEmit`, `--pretty`, `-b`/`--build <x>` fails.
 * 4. **Strictness by deny-by-default diff.** Each recorded invocation's
 *    effective options (`tsc --showConfig` with that exact argv) are diffed
 *    against the package build config's (`tsc --showConfig -p tsconfig.json`)
 *    over EVERY compilerOptions key either side prints — implied strict-family
 *    flags included. Only `DIFF_ALLOWED_KEYS` may differ.
 * 5. **Type-checked, asked of the compiler.** Every collected file must be a
 *    ROOT file of some recorded invocation's program AND type-checked there —
 *    decided by the TypeScript that invocation ran
 *    (`scripts/lib/tsc-checked-files.cjs` builds its Program): not a
 *    declaration file (`SourceFile.isDeclarationFile` — so `api.d.test.ts`,
 *    which TypeScript 5 treats as one and skipLibCheck skips, fails), and not
 *    skipped by `ts.skipTypeChecking` (noCheck, skipDefaultLibCheck,
 *    project-reference redirects, `@ts-nocheck` read as tsc reads it — any
 *    case, `//` or `///`, leading comments only, last directive wins —, JS
 *    without checkJs). No filename rule. That helper self-tests the compiler
 *    it loaded and fails closed if its skip rules changed shape. A collected
 *    file outside the package dir fails (vitest `dir: ".."`). A collected
 *    file named with the canary prefix fails unless it is this run's canary
 *    or a byte-exact canary of another live run (untracked only).
 * 6. **One run per worktree.** Concurrent runs serialise on a lock
 *    (`scripts/lib/repo-lock.ts`, `<git-dir>/check-tests-typechecked.lock`):
 *    a second run waits up to `LOCK_WAIT_MS` (below the 30s gate-test
 *    timeout; `CHECK_TESTS_TYPECHECKED_LOCK_WAIT_MS` overrides) and then fails
 *    naming the holder — another run's canary, globbed by this run's tsc and
 *    deleted before it is read, would stop the chain with TS6053.
 * 7. The `typecheck` script — and every package script it runs via
 *    `pnpm run` / `pnpm <x>` / `npm run` — may chain only with `&&`, and may
 *    not use `$` or backtick expansion (a chain that varies by environment).
 *
 * Packages come from `pnpm-workspace.yaml`; a package with collected test
 * files and no `typecheck` script fails.
 *
 * ## Cost
 *
 * The canary pass is one full `typecheck` per package (more for a chain that
 * stops early), run `availableParallelism()` packages at a time
 * (`CHECK_TESTS_TYPECHECKED_CONCURRENCY` overrides). Measured 2026-09-30 on 4
 * cores: ~120-128s standalone for the full run (74 packages). CI's `check`
 * job runs it in full. The pre-push runs it DIFF-SCOPED
 * (`CHECK_TESTS_TYPECHECKED_SCOPE=changed`, or `--changed`): only packages
 * with a test / tsconfig / package.json / vitest-config / test-ish-path change
 * vs merge-base(origin/main, HEAD), committed or not. It fails CLOSED to the
 * full run when the merge-base or diff can't be computed, or when a shared
 * config outside every package (tsconfig.base.json, a vitest config, the
 * root package.json, pnpm-workspace.yaml, pnpm-lock.yaml, .npmrc) or the
 * gate's own code (this file and its five scripts/lib helpers) changed. The
 * aperture line names which it did; every trigger is pinned by a test.
 *
 * ## Usage
 *
 *   tsx scripts/check-tests-typechecked.ts           # exit 1 on any failure
 *   tsx scripts/check-tests-typechecked.ts --table   # per-package table
 *   tsx scripts/check-tests-typechecked.ts --changed # diff-scoped (pre-push)
 *
 * Env: `CHECK_TESTS_TYPECHECKED_ROOT` (fixture workspace root, the harness),
 * `CHECK_TESTS_TYPECHECKED_ONLY` (comma list of package dirs — the
 * check-gates-effective probe; the aperture line says when it is set; wins
 * over the diff scope), `CHECK_TESTS_TYPECHECKED_SCOPE=changed` (diff scope,
 * above), `CHECK_TESTS_TYPECHECKED_BASE` (the diff's base ref, default
 * origin/main).
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, hostname, tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { formatRepair } from "./lib/gate-report.js";
import { acquireRepoLock, lockPath } from "./lib/repo-lock.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.CHECK_TESTS_TYPECHECKED_ROOT
  ? resolve(process.env.CHECK_TESTS_TYPECHECKED_ROOT)
  : resolve(__dirname, "..");
const COLLECTOR = join(__dirname, "lib/vitest-collect.mjs");
const RECORDER = join(__dirname, "lib/tsc-recorder.cjs");
const TSC_CHECKED = join(__dirname, "lib/tsc-checked-files.cjs");

export const CANARY_PREFIX = "__typecheck_canary_";

const TS_SOURCE = /\.(?:ts|tsx|mts|cts)$/;
const TEST_NAME = /\.(?:test|spec)\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/**
 * compilerOptions keys a typecheck invocation may resolve differently from the
 * build config: where output goes and whether it is emitted. Every other key —
 * strictness, `paths`, `types`, `lib`, `allowJs`, `checkJs`, `noCheck`,
 * `skipLibCheck`, module resolution — must resolve identically. Widening this
 * set is a policy change; the gate's tests pin it exactly.
 */
export const DIFF_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "rootDir",
  "outDir",
  "noEmit",
  "emitDeclarationOnly",
  "declaration",
  "declarationMap",
  "composite",
  "incremental",
  "tsBuildInfoFile",
  "sourceMap",
]);

/** tsc arguments a `typecheck` invocation may carry; `-p`/`-b` take a value. */
const ARGV_FLAGS_WITH_VALUE = new Set(["-p", "--project", "-b", "--build"]);
const ARGV_FLAGS_BARE = new Set(["--noEmit", "--pretty"]);

/**
 * Test files deliberately outside a package's typecheck: repo-relative package
 * dir → exact package-relative file path → reason. Exact paths only (a prefix
 * would silently allowlist every future file under it). The gate fails when
 * an entry goes stale (the file is gone or now covered).
 */
const WEB_E2E_REASON =
  "Playwright spec, run by the ci.yml e2e job (not vitest). apps/web/tsconfig.json has rootDir src and no e2e tsconfig exists; adding one is an apps/web config change outside the #1000 published-packages lane. Measured 2026-09-30: e2e/golden/golden.spec.ts has 1 error (`Buffer` without node types). Follow-up: give apps/web an e2e tsconfig compiled by its typecheck script, then delete these entries.";

export const KNOWN_UNCOVERED: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "apps/web": {
    "e2e/app-loads.spec.ts": WEB_E2E_REASON,
    "e2e/chat-input.spec.ts": WEB_E2E_REASON,
    "e2e/golden/golden.spec.ts": WEB_E2E_REASON,
    "e2e/keyboard-shortcuts.spec.ts": WEB_E2E_REASON,
    "e2e/settings-panel.spec.ts": WEB_E2E_REASON,
    "e2e/sovereign-budget.spec.ts": WEB_E2E_REASON,
    "e2e/sovereign-ledger.spec.ts": WEB_E2E_REASON,
  },
};

/**
 * Test-named (`*.test.*` / `*.spec.*`, TS or JS), or a TS file under a
 * `__tests__/` directory (helpers and fixtures a test imports are part of the
 * test's contract). A JS helper under `__tests__/` (a `.cjs` module stub) is
 * not a test file; a JS file vitest would RUN is, and fails. Declaration
 * files are NOT exempt by name: whether tsc checks a collected file is asked
 * of the compiler (`scripts/lib/tsc-checked-files.cjs`), and it answers that a
 * `.d.ts` — or a `*.d.test.ts` — is never checked as code.
 */
export function isTestFile(relPath: string): boolean {
  const posix = relPath.split("\\").join("/");
  if (TEST_NAME.test(posix)) return true;
  return TS_SOURCE.test(posix) && posix.split("/").includes("__tests__");
}

// ── workspace ────────────────────────────────────────────────────────────────

/**
 * Workspace package dirs, from `pnpm-workspace.yaml`'s `packages:` globs.
 * Supports `dir/*` and a literal `dir`; any other glob shape throws (the gate
 * never guesses which packages exist).
 */
export function workspacePackageDirs(root = ROOT): string[] {
  const yaml = readFileSync(join(root, "pnpm-workspace.yaml"), "utf-8");
  const globs: string[] = [];
  let inPackages = false;
  for (const line of yaml.split("\n")) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const m = /^\s+-\s+["']?([^"'#]+?)["']?\s*(?:#.*)?$/.exec(line);
      if (m) globs.push(m[1]!);
      else if (/^\S/.test(line)) inPackages = false;
    }
  }
  if (globs.length === 0) throw new Error("pnpm-workspace.yaml lists no packages");
  const dirs: string[] = [];
  for (const g of globs) {
    if (g.startsWith("!") || /[*?[{]/.test(g.replace(/\/\*$/, ""))) {
      throw new Error(
        `unsupported pnpm-workspace.yaml glob "${g}" — teach workspacePackageDirs it`,
      );
    }
    if (g.endsWith("/*")) {
      const base = join(root, g.slice(0, -2));
      if (!existsSync(base)) continue;
      for (const entry of readdirSync(base).sort()) {
        const abs = join(base, entry);
        if (statSync(abs).isDirectory() && existsSync(join(abs, "package.json"))) dirs.push(abs);
      }
    } else if (existsSync(join(root, g, "package.json"))) {
      dirs.push(join(root, g));
    }
  }
  return dirs;
}

// ── chain operators ──────────────────────────────────────────────────────────

/**
 * Shell control operators in `cmd` other than `&&`, outside quotes: `||`,
 * `;`, `|`, a background `&`, or a newline. `&` inside a redirection
 * (`2>&1`, `&>`) is not a control operator.
 */
export function nonAndOperators(cmd: string): string[] {
  const found: string[] = [];
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    const next = cmd[i + 1];
    if (c === "&" && next === "&") {
      i++;
    } else if (c === "|" && next === "|") {
      found.push("||");
      i++;
    } else if (c === "|") {
      found.push("|");
    } else if (c === ";") {
      found.push(";");
    } else if (c === "\n") {
      found.push("newline");
    } else if (c === "&" && cmd[i - 1] !== ">" && next !== ">") {
      found.push("&");
    }
  }
  return found;
}

/**
 * Every non-`&&` operator in `entry` and in each package script it runs by
 * name (`pnpm run x`, `pnpm x`, `npm run x`, `yarn x`). This is a deny rule on
 * the script text, not an inference of what the script compiles.
 */
export function chainViolations(scripts: Record<string, string>, entry = "typecheck"): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (name: string): void => {
    if (seen.has(name) || scripts[name] === undefined) return;
    seen.add(name);
    const cmd = scripts[name]!;
    if (/[$`]/.test(cmd)) {
      out.push(
        `script "${name}" ("${cmd}") uses \`$\` or a backtick — parameter/command expansion lets the typecheck chain vary by environment; spell it out literally`,
      );
    }
    for (const op of new Set(nonAndOperators(cmd))) {
      out.push(
        `script "${name}" ("${cmd}") uses \`${op}\` — every step of the typecheck chain must run unconditionally; chain with \`&&\` only`,
      );
    }
    for (const m of cmd.matchAll(/\b(?:pnpm|npm|yarn)\s+(?:run\s+)?([\w:.-]+)/g)) visit(m[1]!);
  };
  visit(entry);
  return out;
}

// ── argv + options ───────────────────────────────────────────────────────────

/** argv tokens outside the typecheck allowlist, as the reason strings. */
export function argvViolations(argv: readonly string[]): string[] {
  const bad: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    if (ARGV_FLAGS_WITH_VALUE.has(t)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("-")) bad.push(`${t} without a value`);
      i++;
    } else if (!ARGV_FLAGS_BARE.has(t)) {
      bad.push(t);
    }
  }
  return bad;
}

/** The `--showConfig` argv for a recorded invocation (`-b x` → `-p x`). */
function showConfigArgv(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    if (t === "-b" || t === "--build") out.push("-p", argv[++i]!);
    else if (t === "--pretty") continue;
    else out.push(t);
  }
  return [...out, "--showConfig"];
}

/** The tsconfig path an allowlisted argv names (default `tsconfig.json`), absolute. */
function projectOf(cwd: string, argv: readonly string[]): string {
  let p = "tsconfig.json";
  for (let i = 0; i < argv.length; i++) {
    if (ARGV_FLAGS_WITH_VALUE.has(argv[i]!)) p = argv[i + 1] ?? p;
  }
  const abs = resolve(cwd, p);
  return existsSync(abs) && statSync(abs).isDirectory() ? join(abs, "tsconfig.json") : abs;
}

export interface ShownConfig {
  compilerOptions: Record<string, unknown>;
  /** Absolute paths of the program's root files. */
  files: string[];
}

/** `tsc --showConfig` for `argv` in `cwd`, using the given tsc entry point. */
export function showConfig(tscBin: string, cwd: string, argv: readonly string[]): ShownConfig {
  const r = spawnSync(process.execPath, [tscBin, ...showConfigArgv(argv)], {
    cwd,
    encoding: "utf-8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(
      `tsc ${showConfigArgv(argv).join(" ")} (in ${cwd}) failed: ${(r.stdout + r.stderr).trim().slice(0, 400)}`,
    );
  }
  const j = JSON.parse(r.stdout) as { compilerOptions?: Record<string, unknown>; files?: string[] };
  const base = dirname(projectOf(cwd, argv));
  return {
    compilerOptions: j.compilerOptions ?? {},
    files: (j.files ?? []).map((f) => resolve(base, f)),
  };
}

/**
 * Every compilerOptions key on which `test` resolves differently from
 * `build`, outside `allowed`. Presence counts: a key one side sets and the
 * other leaves to its default is a difference (deny by default — equivalence
 * is not inferred).
 */
export function optionDiff(
  build: Record<string, unknown>,
  test: Record<string, unknown>,
  allowed: ReadonlySet<string> = DIFF_ALLOWED_KEYS,
): { differing: string[]; compared: number } {
  const keys = [...new Set([...Object.keys(build), ...Object.keys(test)])].sort();
  const differing: string[] = [];
  let compared = 0;
  for (const k of keys) {
    if (allowed.has(k)) continue;
    compared++;
    const b = JSON.stringify(build[k]);
    const t = JSON.stringify(test[k]);
    if (b !== t) differing.push(`${k} (build ${b ?? "unset"}, typecheck ${t ?? "unset"})`);
  }
  return { differing, compared };
}

// ── collection ───────────────────────────────────────────────────────────────

/** A child `node` run, async (the package pool must not block on it). */
function runNode(
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; input?: string },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (status) => done({ status, stdout, stderr }));
    if (opts.input !== undefined) child.stdin!.end(opts.input);
  });
}

/**
 * Resolved-vitest-config keys whose file value vitest LOADS AND RUNS as test
 * code: such a file is collected (canaried, membership-checked) like a test.
 */
export const VITEST_TEST_CODE_KEYS: ReadonlySet<string> = new Set([
  "setupFiles",
  "globalSetup",
  "snapshotSerializers",
  "environment",
  "reporters",
  "sequence.sequencer",
  "include",
  "includeSource",
  "typecheck.include",
  "benchmark.include",
]);

/**
 * Resolved-vitest-config keys whose file value vitest never runs as test
 * code, each with the reason. Every other key with a file value fails the
 * gate ("unknown file-valued vitest key") until it is classified here or in
 * VITEST_TEST_CODE_KEYS. Widening this set is a policy change; the tests pin it.
 */
export const VITEST_NON_CODE_KEYS: Readonly<Record<string, string>> = {
  config:
    "the config file itself — vite evaluates it to resolve the config; it is not a test module",
  "coverage.include": "selects which files coverage REPORTS on; vitest does not load them as tests",
  "coverage.exclude": "removes files from the coverage report; vitest does not load them as tests",
  forceRerunTriggers:
    "watch-mode rerun triggers — vitest only watches them (setupFiles appear here too, and are collected under their own key)",
};

/**
 * The argument lists each package script passes to `vitest`: every script
 * named `test` / `test:*`, and every package script those reach through
 * `pnpm run x` / `pnpm x` / `npm run x`. A segment that invokes vitest with
 * `$`/backtick expansion cannot be resolved and is reported. With no vitest
 * invocation in any of them, the default (no arguments) is used.
 */
export function vitestArgvs(scripts: Record<string, string>): {
  argvs: string[][];
  problems: string[];
} {
  const argvs = new Map<string, string[]>();
  const problems: string[] = [];
  const seen = new Set<string>();
  const visit = (name: string): void => {
    if (seen.has(name) || scripts[name] === undefined) return;
    seen.add(name);
    const cmd = scripts[name]!;
    for (const segment of shellSegments(cmd)) {
      const words = shellWords(segment);
      const at = words.findIndex((w) => /^vitest(?:\.m?js)?$/.test(basename(w)));
      if (at < 0) continue;
      if (/[$`]/.test(segment)) {
        problems.push(
          `script "${name}" runs vitest with \`$\`/backtick expansion ("${segment.trim()}") — the gate cannot resolve which config that vitest loads; spell its arguments out literally`,
        );
        continue;
      }
      const args = words.slice(at + 1);
      argvs.set(JSON.stringify(args), args);
    }
    for (const m of cmd.matchAll(/\b(?:pnpm|npm|yarn)\s+(?:run\s+)?([\w:.-]+)/g)) visit(m[1]!);
  };
  for (const name of Object.keys(scripts).sort()) if (/^test(?::|$)/.test(name)) visit(name);
  return { argvs: argvs.size > 0 ? [...argvs.values()] : [[]], problems };
}

/** `cmd` split at shell control operators outside quotes. */
function shellSegments(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (quote) {
      if (c === quote) quote = null;
      cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (c === "&" || c === "|" || c === ";" || c === "\n") {
      if (c === "&" && (cmd[i - 1] === ">" || cmd[i + 1] === ">")) {
        cur += c;
        continue;
      }
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.filter((x) => x.trim().length > 0);
}

/** Shell-style words of one segment (quotes removed; no expansion). */
function shellWords(segment: string): string[] {
  const words: string[] = [];
  let cur: string | null = null;
  let quote: string | null = null;
  for (const c of segment) {
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      cur ??= "";
    } else if (/\s/.test(c)) {
      if (cur !== null) words.push(cur);
      cur = null;
    } else {
      cur = (cur ?? "") + c;
    }
  }
  if (cur !== null) words.push(cur);
  return words;
}

/**
 * What vitest loads for a package under one script's arguments: its test
 * files and every file-valued entry of the resolved config, absolute.
 */
export async function vitestCollect(
  pkgAbs: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  repoRoot = ROOT,
): Promise<{ files: string[]; fileValued: { key: string; file: string }[]; error?: string }> {
  const dir = mkdtempSync(join(tmpdir(), "vitest-collect-"));
  const out = join(dir, "out.json");
  try {
    const r = await runNode([COLLECTOR], {
      cwd: pkgAbs,
      env: {
        ...env,
        MOTEBIT_VITEST_RESOLVE_FALLBACK: resolve(__dirname, ".."),
        MOTEBIT_VITEST_ARGV: JSON.stringify(args),
        MOTEBIT_VITEST_COLLECT_OUT: out,
        MOTEBIT_REPO_ROOT: repoRoot,
      },
    });
    const label = `vitest ${args.join(" ")}`.trim();
    if (r.status !== 0 || !existsSync(out)) {
      return {
        files: [],
        fileValued: [],
        error: `vitest collection (\`${label}\`) failed: ${(r.stderr || r.stdout).trim().slice(0, 400)}`,
      };
    }
    const j = JSON.parse(readFileSync(out, "utf-8")) as {
      files: string[];
      fileValued: { key: string; file: string }[];
    };
    return { files: j.files.map((f) => resolve(f)), fileValued: j.fileValued };
  } catch (err) {
    return {
      files: [],
      fileValued: [],
      error: `vitest collection printed no JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Per file: whether it is a root of the invocation's program, and why tsc skips it (null: checked). */
type CheckedFiles = Record<string, { root: boolean; skip: string | null }>;

/**
 * Ask the TypeScript that ran the recorded invocation (the `typescript.js`
 * beside its `tsc`) whether it type-checks each of `files`
 * (scripts/lib/tsc-checked-files.cjs builds that invocation's own Program).
 */
export async function tscChecked(
  inv: { cwd: string; tsc: string; argv: string[] },
  files: string[],
  env: NodeJS.ProcessEnv,
): Promise<CheckedFiles> {
  const tsLib = inv.tsc.endsWith("/bin/tsc")
    ? resolve(dirname(inv.tsc), "../lib/typescript.js")
    : join(dirname(inv.tsc), "typescript.js");
  const r = await runNode([TSC_CHECKED], {
    cwd: inv.cwd,
    env,
    input: JSON.stringify({ tsLib, argv: inv.argv, files }),
  });
  if (r.status !== 0) {
    const msg = /Error: (.*)/.exec(r.stderr)?.[1] ?? (r.stderr || r.stdout).trim().slice(0, 400);
    throw new Error(
      `asking tsc ${inv.argv.join(" ")} (in ${inv.cwd}) which files it checks: ${msg}`,
    );
  }
  return (JSON.parse(r.stdout) as { results: CheckedFiles }).results;
}

/** `git ls-files -z <args> -- .` in `cwd`, absolute paths. */
function gitList(cwd: string, args: string[]): { files: string[]; error?: string } {
  const r = spawnSync("git", ["ls-files", "-z", ...args, "--", "."], {
    cwd,
    encoding: "utf-8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) return { files: [], error: `git ls-files failed: ${r.stderr.trim()}` };
  return {
    files: r.stdout
      .split("\0")
      .filter((f) => f.length > 0)
      .map((f) => resolve(cwd, f)),
  };
}

/**
 * Git-listed (tracked, or untracked-not-ignored) test-named files under a
 * package, absolute — canary-prefixed names included (whether one is this
 * run's canary is decided by `isExemptCanary`, never by the name) — plus the
 * set of those that are tracked.
 */
export function gitTestFiles(pkgAbs: string): {
  files: string[];
  tracked: Set<string>;
  error?: string;
} {
  const all = gitList(pkgAbs, ["--cached", "--others", "--exclude-standard"]);
  const cached = gitList(pkgAbs, ["--cached"]);
  const error = all.error ?? cached.error;
  return {
    files: all.files.filter((f) => isTestFile(relative(pkgAbs, f)) && existsSync(f)),
    tracked: new Set(cached.files),
    ...(error ? { error } : {}),
  };
}

// ── running the real script ──────────────────────────────────────────────────

interface Invocation {
  cwd: string;
  tsc: string;
  argv: string[];
}

interface RunResult {
  status: number | null;
  output: string;
  invocations: Invocation[];
}

function runTypecheck(
  pkgAbs: string,
  env: NodeJS.ProcessEnv,
  recordOnly: boolean,
): Promise<RunResult> {
  const dir = mkdtempSync(join(tmpdir(), "tsc-record-"));
  const record = join(dir, "record.jsonl");
  const nodeOptions = [env.NODE_OPTIONS, `--require ${JSON.stringify(RECORDER)}`]
    .filter(Boolean)
    .join(" ");
  return new Promise((done) => {
    const child = spawn("pnpm", ["run", "typecheck"], {
      cwd: pkgAbs,
      env: {
        ...env,
        NODE_OPTIONS: nodeOptions,
        MOTEBIT_TSC_RECORD: record,
        MOTEBIT_TSC_RECORD_ONLY: recordOnly ? "1" : "",
        FORCE_COLOR: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr.on("data", (d: Buffer) => (output += d.toString()));
    child.on("close", (status) => {
      let invocations: Invocation[] = [];
      if (existsSync(record)) {
        invocations = readFileSync(record, "utf-8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Invocation);
      }
      rmSync(dir, { recursive: true, force: true });
      done({ status, output, invocations });
    });
  });
}

// ── canaries ─────────────────────────────────────────────────────────────────

/** Who wrote a canary: the run (random per process), its pid and host. */
export interface CanaryOwner {
  run: string;
  pid: number;
  host: string;
}

const THIS_RUN: CanaryOwner = {
  run: randomBytes(8).toString("hex"),
  pid: process.pid,
  host: hostname(),
};

/** A canary older than this is stale whatever its pid says (pid reuse). One lives for one typecheck. */
const CANARY_MAX_AGE_MS = 60 * 60 * 1000;

const CANARY_NAME = new RegExp(`^${CANARY_PREFIX}([0-9a-f]{12})\\.test(\\.(?:ts|tsx|mts|cts))$`);
const CANARY_HEADER =
  /^\/\/ check-tests-typechecked canary run=([0-9a-f]+) pid=(\d+) host=(\S+) — /;

/** The exact bytes of a canary: its id (from the file name) and its owner. */
export function canaryContent(id: string, owner: CanaryOwner): string {
  return `// check-tests-typechecked canary run=${owner.run} pid=${owner.pid} host=${owner.host} — deliberately ill-typed; removed by the gate. Delete it if you see it.\nexport const ${CANARY_PREFIX}${id}: number = "canary ${id}";\n`;
}

/**
 * The owner of the canary at `fileName` with `content`, or null when the file
 * is not byte-for-byte a canary the gate writes (a user's file that merely
 * carries the prefix, a template whose id differs from its name).
 */
export function parseCanary(fileName: string, content: string): CanaryOwner | null {
  const name = CANARY_NAME.exec(basename(fileName));
  const head = CANARY_HEADER.exec(content);
  if (!name || !head) return null;
  const owner = { run: head[1]!, pid: Number(head[2]), host: head[3]! };
  return content === canaryContent(name[1]!, owner) ? owner : null;
}

/**
 * Whether the run that wrote a canary may still be using it: this run; or a
 * process that is alive on this host (a concurrent gate run) and a canary
 * younger than CANARY_MAX_AGE_MS. A canary from another host cannot be
 * probed, so it counts as live until it ages out — never deleted on a guess.
 */
export function canaryOwnerLive(owner: CanaryOwner, mtimeMs: number, now = Date.now()): boolean {
  if (owner.run === THIS_RUN.run) return true;
  if (now - mtimeMs > CANARY_MAX_AGE_MS) return false;
  if (owner.host !== THIS_RUN.host) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Content + mtime of a file, or null if it is gone. */
function readIfPresent(abs: string): { text: string; mtimeMs: number } | null {
  try {
    return { text: readFileSync(abs, "utf-8"), mtimeMs: statSync(abs).mtimeMs };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

const liveCanaries = new Set<string>();

function removeCanaries(paths: Iterable<string>): void {
  for (const p of [...paths]) {
    try {
      unlinkSync(p);
    } catch {
      /* already gone */
    }
    liveCanaries.delete(p);
  }
}

let handlersInstalled = false;
function installCleanupHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  process.on("exit", () => removeCanaries(liveCanaries));
  for (const [sig, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const) {
    process.on(sig, () => {
      removeCanaries(liveCanaries);
      process.exit(code);
    });
  }
}

/**
 * Remove canaries an interrupted earlier run left behind: an untracked file
 * whose content is byte-for-byte a canary template (id matching its name)
 * whose owner is no longer live. A file that merely carries the prefix is
 * never touched (the collection then fails it as a reserved name), and a
 * concurrent run's canary is left alone.
 */
export function drainCanaries(root = ROOT): string[] {
  const r = spawnSync("git", ["ls-files", "-z", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf-8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) return [];
  const drained: string[] = [];
  for (const f of r.stdout.split("\0")) {
    if (!basename(f).startsWith(CANARY_PREFIX)) continue;
    const abs = join(root, f);
    const got = readIfPresent(abs);
    const owner = got ? parseCanary(abs, got.text) : null;
    if (!got || !owner || canaryOwnerLive(owner, got.mtimeMs)) continue;
    rmSync(abs, { force: true });
    drained.push(f);
  }
  return drained;
}

/**
 * Whether a collected file is a canary to leave out of the collection: this
 * run's (the in-memory set), or an untracked, byte-exact canary of another
 * live run. Never by name alone, never a tracked file.
 */
function isExemptCanary(abs: string, tracked: ReadonlySet<string>): boolean {
  if (liveCanaries.has(abs)) return true;
  if (tracked.has(abs) || !basename(abs).startsWith(CANARY_PREFIX)) return false;
  const got = readIfPresent(abs);
  if (!got) return true; // gone: a run removed it between listing and now
  const owner = parseCanary(abs, got.text);
  return owner !== null && canaryOwnerLive(owner, got.mtimeMs);
}

function writeCanary(dirAbs: string, ext: string): string {
  const id = randomBytes(6).toString("hex");
  const file = join(dirAbs, `${CANARY_PREFIX}${id}.test${ext}`);
  liveCanaries.add(file);
  writeFileSync(file, canaryContent(id, THIS_RUN));
  return file;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

/** Whether `output` reports a TS error located in the file `canaryAbs`. */
export function reportsError(output: string, canaryAbs: string): boolean {
  const name = basename(canaryAbs);
  return output
    .replace(ANSI, "")
    .split("\n")
    .some((line) => line.includes(name) && /\berror TS\d+/.test(line));
}

// ── per package ──────────────────────────────────────────────────────────────

export interface PackageResult {
  dir: string;
  name: string;
  scanned: boolean;
  testFiles: number;
  canaryDirs: number;
  invocations: number;
  keysCompared: number;
  allowlisted: string[];
  problems: string[];
}

export async function checkPackage(
  pkgAbs: string,
  opts: { root?: string; known?: typeof KNOWN_UNCOVERED; env?: NodeJS.ProcessEnv } = {},
): Promise<PackageResult | null> {
  const root = opts.root ?? ROOT;
  const known = opts.known ?? KNOWN_UNCOVERED;
  const env = opts.env ?? process.env;
  const manifestPath = join(pkgAbs, "package.json");
  if (!existsSync(manifestPath)) return null;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
    name?: string;
    scripts?: Record<string, string>;
  };
  const scripts = manifest.scripts ?? {};
  const dir = relative(root, pkgAbs).split("\\").join("/");
  const res: PackageResult = {
    dir,
    name: manifest.name ?? dir,
    scanned: true,
    testFiles: 0,
    canaryDirs: 0,
    invocations: 0,
    keysCompared: 0,
    allowlisted: [],
    problems: [],
  };
  const rel = (abs: string): string => relative(pkgAbs, abs).split("\\").join("/");

  // 1. Collection.
  const collected = new Set<string>();
  const vitestFiles: string[] = [];
  const va = vitestArgvs(scripts);
  res.problems.push(...va.problems);
  for (const args of va.argvs) {
    const v = await vitestCollect(pkgAbs, args, env, root);
    if (v.error) res.problems.push(v.error);
    vitestFiles.push(...v.files);
    for (const { key, file } of v.fileValued) {
      if (VITEST_TEST_CODE_KEYS.has(key)) vitestFiles.push(file);
      else if (!Object.hasOwn(VITEST_NON_CODE_KEYS, key)) {
        res.problems.push(
          `${relative(root, file).split("\\").join("/")} is the value of \`${key}\` in the resolved vitest config${args.length > 0 ? ` (\`vitest ${args.join(" ")}\`)` : ""} — an unknown file-valued vitest key: the gate cannot tell whether vitest runs that file as test code. Classify the key in scripts/check-tests-typechecked.ts: VITEST_TEST_CODE_KEYS if vitest loads it (it is then canaried and membership-checked like a test), VITEST_NON_CODE_KEYS with the reason if it never does`,
        );
      }
    }
  }
  const g = gitTestFiles(pkgAbs);
  if (g.error) res.problems.push(g.error);
  for (const f of [...new Set([...vitestFiles, ...g.files])]) {
    if (isExemptCanary(f, g.tracked) || !existsSync(f)) continue;
    if (!f.startsWith(pkgAbs + "/")) {
      res.problems.push(
        `${relative(root, f).split("\\").join("/")} is collected by this package's vitest but is outside the package (${dir}/) — no check here proves its typecheck covers it; keep every test (and setup file) inside the package that runs it, or narrow the vitest config (\`dir\`, \`include\`, \`setupFiles\`) to the package`,
      );
      continue;
    }
    collected.add(f);
  }
  const files = [...collected].sort();
  for (const f of files) {
    if (basename(f).startsWith(CANARY_PREFIX)) {
      res.problems.push(
        `${rel(f)} uses the reserved canary prefix \`${CANARY_PREFIX}\` — the gate writes and removes files with that name; rename it`,
      );
    }
  }
  res.testFiles = files.length;
  if (scripts.typecheck === undefined) {
    if (files.length > 0) {
      res.problems.push(
        `${files.length} test file(s) (e.g. ${rel(files[0]!)}) but no \`typecheck\` script — add one that type-checks them`,
      );
    } else {
      res.scanned = false;
    }
    return res;
  }

  const knownHere = known[dir] ?? {};
  const isKnown = (abs: string): boolean => Object.hasOwn(knownHere, rel(abs));
  const tsFiles = files.filter((f) => TS_SOURCE.test(f));

  // 2. Chain operators.
  res.problems.push(...chainViolations(scripts));

  // 3. Record the whole chain without compiling.
  const dry = await runTypecheck(pkgAbs, env, true);
  const invocations = new Map<string, Invocation>();
  const addInvocations = (list: Invocation[]): void => {
    for (const inv of list) invocations.set(JSON.stringify([inv.cwd, inv.argv]), inv);
  };
  addInvocations(dry.invocations);
  if (dry.invocations.length === 0) {
    res.problems.push(`the typecheck script ("${scripts.typecheck}") runs no tsc (none recorded)`);
  }

  // 4. Canary passes.
  const byDir = new Map<string, Set<string>>();
  for (const f of tsFiles) {
    if (isKnown(f)) continue;
    const exts = byDir.get(dirname(f)) ?? new Set<string>();
    exts.add(extname(f));
    byDir.set(dirname(f), exts);
  }
  res.canaryDirs = byDir.size;
  installCleanupHandlers();
  let pending: string[] = [];
  try {
    for (const [d, exts] of byDir) for (const e of exts) pending.push(writeCanary(d, e));
    let lastOutput = "";
    while (pending.length > 0) {
      const run = await runTypecheck(pkgAbs, env, false);
      addInvocations(run.invocations);
      lastOutput = run.output;
      const reported = run.status !== 0 ? pending.filter((c) => reportsError(run.output, c)) : [];
      if (reported.length === 0) break;
      removeCanaries(reported);
      pending = pending.filter((c) => !reported.includes(c));
    }
    if (pending.length > 0) {
      const errs = lastOutput
        .replace(ANSI, "")
        .split("\n")
        .filter((l) => /\berror TS\d+/.test(l))
        .slice(0, 3);
      res.problems.push(
        `the typecheck script does not type-check ${pending.length} test director${pending.length === 1 ? "y" : "ies"}: ${pending
          .map((c) => rel(dirname(c)) || ".")
          .join(
            ", ",
          )} — a canary with a type error there was not reported${errs.length > 0 ? ` (the run did stop on other errors first: ${errs.join(" | ")} — fix those, \`pnpm typecheck\`)` : ""}`,
      );
    }
  } finally {
    removeCanaries(pending);
  }

  // 5. argv allowlist, strictness diff, membership.
  res.invocations = invocations.size;
  const tscFallback = [...invocations.values()][0]?.tsc;
  let reference: ShownConfig | undefined;
  if (!existsSync(join(pkgAbs, "tsconfig.json"))) {
    res.problems.push("no tsconfig.json — the build config the typecheck is diffed against");
  } else if (tscFallback) {
    try {
      reference = showConfig(tscFallback, pkgAbs, []);
    } catch (err) {
      res.problems.push(err instanceof Error ? err.message : String(err));
    }
  }
  // Per collected file: some tsc checks it, or why the ones rooting it skip it.
  const verdicts = new Map<string, { checked: boolean; skips: string[] }>();
  for (const inv of invocations.values()) {
    const label = `tsc ${inv.argv.join(" ")}`.trim();
    const bad = argvViolations(inv.argv);
    if (bad.length > 0) {
      res.problems.push(
        `\`${label}\` passes ${bad.join(", ")} — a typecheck tsc may take only -p/--project, --noEmit, --pretty, -b/--build; put options in the tsconfig`,
      );
      continue;
    }
    let shown: ShownConfig;
    try {
      shown = showConfig(inv.tsc, inv.cwd, inv.argv);
    } catch (err) {
      res.problems.push(err instanceof Error ? err.message : String(err));
      continue;
    }
    const roots = new Set(shown.files);
    const mine = files.filter((f) => roots.has(f));
    if (mine.length > 0) {
      try {
        const answer = await tscChecked(inv, mine, env);
        for (const f of mine) {
          const a = answer[f];
          if (!a?.root) continue;
          const v = verdicts.get(f) ?? { checked: false, skips: [] };
          if (a.skip === null) v.checked = true;
          else v.skips.push(`${a.skip} (\`${label}\`)`);
          verdicts.set(f, v);
        }
      } catch (err) {
        res.problems.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (reference) {
      const d = optionDiff(reference.compilerOptions, shown.compilerOptions);
      res.keysCompared += d.compared;
      if (d.differing.length > 0) {
        res.problems.push(
          `\`${label}\` resolves compiler options differently from the build config tsconfig.json: ${d.differing.join("; ")} — only ${[...DIFF_ALLOWED_KEYS].join(", ")} may differ; remove the override`,
        );
      }
    }
  }
  for (const f of files) {
    const v = verdicts.get(f);
    if (v?.checked) continue;
    if (isKnown(f)) res.allowlisted.push(rel(f));
    else if (v && v.skips.length > 0) res.problems.push(`${rel(f)} ${v.skips.join("; ")}`);
    else
      res.problems.push(
        `${rel(f)} is not a root file of any tsc the typecheck script runs (tsc --showConfig files)${TS_SOURCE.test(f) ? "" : " — a JavaScript test file; tsc never checks it: write it in TypeScript"}`,
      );
  }
  for (const k of Object.keys(knownHere)) {
    if (!res.allowlisted.includes(k)) {
      res.problems.push(
        `stale KNOWN_UNCOVERED entry "${k}" — it is gone or now type-checked; delete it from scripts/check-tests-typechecked.ts`,
      );
    }
  }
  return res;
}

// ── diff scope (pre-push) ────────────────────────────────────────────────────

/**
 * Files outside every package whose change can move any package's result:
 * shared tsconfigs / vitest configs, the workspace and lockfile (the
 * typescript/vitest versions), and the gate's own code.
 */
const GLOBAL_TRIGGER_NAME =
  /(?:tsconfig|vitest|vite\.config)|^package\.json$|^pnpm-(?:workspace\.yaml|lock\.yaml)$|^\.npmrc$/;
const GLOBAL_TRIGGER_PATHS = new Set([
  "scripts/check-tests-typechecked.ts",
  "scripts/lib/vitest-collect.mjs",
  "scripts/lib/tsc-recorder.cjs",
  "scripts/lib/tsc-checked-files.cjs",
  "scripts/lib/repo-lock.ts",
]);

/**
 * Whether a changed package-relative path can change that package's result:
 * a test file (or a canary-prefixed name), a tsconfig / vitest / vite config
 * or package.json, or anything under a test-ish path segment (a setup or
 * fixture module a `setupFiles` entry may name).
 */
export function affectsPackage(relPath: string): boolean {
  const posix = relPath.split("\\").join("/");
  const name = basename(posix);
  if (isTestFile(posix) || name.startsWith(CANARY_PREFIX)) return true;
  if (/tsconfig|vitest|vite\.config/.test(name) || name === "package.json") return true;
  return posix.split("/").some((seg) => /test|spec|setup|fixture|mock|e2e/i.test(seg));
}

export type Scope =
  { kind: "scoped"; base: string; dirs: string[] } | { kind: "full"; reason: string };

/**
 * The packages a diff-scoped run checks: those with a change `affectsPackage`
 * accepts vs merge-base(origin/main, HEAD) — committed, staged, unstaged and
 * untracked (`CHECK_TESTS_TYPECHECKED_BASE` names another base ref). Fails CLOSED to the full run whenever the diff cannot be
 * computed or a global trigger changed.
 */
export function changedScope(root: string, dirs: readonly string[]): Scope {
  const git = (args: string[]): string | null => {
    const r = spawnSync("git", args, {
      cwd: root,
      encoding: "utf-8",
      maxBuffer: 256 * 1024 * 1024,
    });
    return r.status === 0 ? r.stdout : null;
  };
  const baseRef = process.env.CHECK_TESTS_TYPECHECKED_BASE || "origin/main";
  const base = git(["merge-base", baseRef, "HEAD"])?.trim();
  if (!base) return { kind: "full", reason: `merge-base(${baseRef}, HEAD) unavailable` };
  const diff = git(["diff", "--name-only", "--no-renames", "-z", base]);
  const untracked = git(["ls-files", "-z", "--others", "--exclude-standard"]);
  if (diff === null || untracked === null) {
    return { kind: "full", reason: `git diff against ${base.slice(0, 9)} failed` };
  }
  const rels = dirs.map((d) => relative(root, d).split("\\").join("/"));
  const hit = new Set<string>();
  for (const p of `${diff}\0${untracked}`.split("\0").filter(Boolean)) {
    const owner = rels.filter((d) => p.startsWith(`${d}/`)).sort((a, b) => b.length - a.length)[0];
    if (owner === undefined) {
      if (GLOBAL_TRIGGER_PATHS.has(p) || GLOBAL_TRIGGER_NAME.test(basename(p))) {
        return { kind: "full", reason: `${p} changed` };
      }
      continue;
    }
    if (affectsPackage(p.slice(owner.length + 1))) hit.add(owner);
  }
  return { kind: "scoped", base, dirs: dirs.filter((_, i) => hit.has(rels[i]!)) };
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

/**
 * How long a run waits for a concurrent run of this gate on the same worktree
 * before giving up (RED, naming the holder). Kept below the repo's 30s test
 * timeout (`test:gates`) so a harness run that waits fails with this message,
 * not a timeout. `CHECK_TESTS_TYPECHECKED_LOCK_WAIT_MS` overrides.
 */
const LOCK_WAIT_MS = 25_000;

async function main(): Promise<void> {
  const started = Date.now();
  const table = process.argv.includes("--table");
  const only = (process.env.CHECK_TESTS_TYPECHECKED_ONLY ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  let dirs = workspacePackageDirs();
  let scopeNote = "";
  if (only.length > 0) {
    dirs = dirs.filter((d) => only.includes(relative(ROOT, d).split("\\").join("/")));
    scopeNote = ` (SCOPED by CHECK_TESTS_TYPECHECKED_ONLY to ${only.join(", ")})`;
  } else if (
    process.argv.includes("--changed") ||
    process.env.CHECK_TESTS_TYPECHECKED_SCOPE === "changed"
  ) {
    const all = dirs.length;
    const scope = changedScope(ROOT, dirs);
    if (scope.kind === "scoped") {
      dirs = scope.dirs;
      scopeNote = ` (DIFF-SCOPED: ${dirs.length} of ${all} package(s) have test/config changes vs merge-base ${scope.base.slice(0, 9)}; CI runs all)`;
    } else {
      scopeNote = ` (diff scope requested, FULL run: ${scope.reason})`;
    }
  }
  const concurrency = Math.max(
    1,
    Number(process.env.CHECK_TESTS_TYPECHECKED_CONCURRENCY) || availableParallelism(),
  );
  // One run at a time per worktree: a concurrent run's canaries, globbed by
  // this run's tsc and deleted before it reads them, stop the chain (TS6053).
  let release = (): void => {};
  if (dirs.length > 0) {
    const budgetMs = Number(process.env.CHECK_TESTS_TYPECHECKED_LOCK_WAIT_MS) || LOCK_WAIT_MS;
    try {
      release = await acquireRepoLock(lockPath(ROOT, "check-tests-typechecked"), { budgetMs });
    } catch (err) {
      process.stderr.write(
        `✗ check-tests-typechecked: another run of this gate is using this worktree — ${err instanceof Error ? err.message : String(err)}.\n  Its canaries would corrupt this run's tsc (TS6053), so this run did not start. Fix: let that run finish and re-run, or raise CHECK_TESTS_TYPECHECKED_LOCK_WAIT_MS (default ${LOCK_WAIT_MS}). A dead holder's lock is reclaimed automatically.\n`,
      );
      process.exit(1);
    }
  }
  let results: PackageResult[];
  try {
    const drained = drainCanaries();
    if (drained.length > 0) {
      process.stderr.write(`drained ${drained.length} stale canary file(s)\n`);
    }
    results = (await pool(dirs, concurrency, (d) => checkPackage(d))).filter(
      (r): r is PackageResult => r !== null && r.scanned,
    );
  } finally {
    release();
  }

  if (table) {
    process.stdout.write(
      "| package | test files | canary dirs | tsc invocations | status |\n|---|---|---|---|---|\n",
    );
    for (const r of results) {
      const status =
        r.problems.length > 0
          ? `FAIL (${r.problems.length})`
          : r.allowlisted.length > 0
            ? `ok, ${r.allowlisted.length} allowlisted`
            : "ok";
      process.stdout.write(
        `| ${r.dir} | ${r.testFiles} | ${r.canaryDirs} | ${r.invocations} | ${status} |\n`,
      );
    }
  }

  const sum = (f: (r: PackageResult) => number): number => results.reduce((n, r) => n + f(r), 0);
  const aperture = `${results.length} package(s) scanned${scopeNote}; ${sum((r) => r.testFiles)} collected test file(s) (vitest collection under each test script's arguments + every file-valued config entry vitest runs + git-listed test-named files); ${sum((r) => r.canaryDirs)} canary director(ies) run through each package's real typecheck; every collected file asked of the recorded tsc's own Program (root + not skipped); ${sum((r) => r.invocations)} recorded tsc invocation(s) diffed against tsconfig.json over ${sum((r) => r.keysCompared)} compilerOptions key comparison(s) (only ${DIFF_ALLOWED_KEYS.size} emit/layout keys may differ); ${sum((r) => r.allowlisted.length)} file(s) allowlisted in KNOWN_UNCOVERED; ${Math.round((Date.now() - started) / 1000)}s`;
  const failing = results.filter((r) => r.problems.length > 0);
  if (failing.length === 0) {
    process.stdout.write(`✓ check-tests-typechecked: ${aperture}.\n`);
    return;
  }
  const sites: string[] = [];
  for (const r of failing) for (const p of r.problems) sites.push(`${r.dir}: ${p}`);
  process.stderr.write(
    formatRepair({
      invariant: `${failing.length} package(s) have test files their \`typecheck\` script does not type-check, or type-checks under options different from the build, or only conditionally (${aperture})`,
      sites,
      canonical:
        "the package's tsconfig.json (build) + tsconfig.test.json (tests), compiled by its package.json `typecheck` script",
      fix: 'keep the build tsconfig excluding tests; add `tsconfig.test.json` (copy packages/crypto/tsconfig.test.json: `extends: ./tsconfig.json`, `rootDir: "."`, `noEmit: true`, emitDeclarationOnly/composite/incremental off, `include` covering every directory with a test or vitest setup file, `exclude: []`) and make `typecheck` run `tsc --noEmit && tsc -p tsconfig.test.json` (`&&` only, no extra tsc flags). The test config may override only emit/layout keys (see DIFF_ALLOWED_KEYS) — diff `tsc --showConfig -p tsconfig.json` against `tsc --showConfig -p tsconfig.test.json`. Then fix the surfaced errors in the tests — never loosen the config, never `@ts-nocheck`. Verify with `pnpm check-tests-typechecked --table`.',
      doctrine: "docs/drift-defenses.md (check-tests-typechecked), issue #1000",
    }),
  );
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    removeCanaries(liveCanaries);
    process.stderr.write(
      `check-tests-typechecked crashed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  });
}
