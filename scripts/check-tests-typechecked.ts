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
 * 1. **What vitest runs is RECORDED, never predicted.** Rounds 4-6 each
 *    found another way vitest runs a file a parse of scripts and configs
 *    missed (an extensionless setupFiles entry, an env- or
 *    npm_lifecycle_event-keyed config, `vitest bench`, a node wrapper calling
 *    `startVitest`, code only a config imports). So every `test` / `test:*`
 *    script, and every script whose command mentions vitest, is RUN for real
 *    (`pnpm run <script>`) under a node preload
 *    (`scripts/lib/vitest-recorder.cjs`) that injects a vite plugin
 *    (`scripts/lib/vitest-record-plugin.mjs`) into every vite server vitest
 *    creates, however vitest was started. The plugin makes the run
 *    collection-only (vitest's own `collectTests`: globalSetup runs, setup and
 *    test files are imported, no test body runs; isolate off, one worker) and
 *    records every module vite transforms or resolves for vitest (test and
 *    bench files, setupFiles, globalSetup, environment, reporters,
 *    serializers, `vi.mock` targets and everything they import), the config
 *    file's imports, and every CommonJS file a worker requires natively.
 *    Every recorded repo file must be type-checked (step 5) unless it is
 *    untracked build output (under a package's build outDir), the resolved
 *    vitest config itself, or a `KNOWN_CONFIG_IMPORTS` entry. Deny by
 *    default: a test script whose vitest the recorder never observed (unless
 *    pinned in `NON_VITEST_TEST_SCRIPTS` by exact command + file hash), a
 *    vitest the plugin never attached to, a collection that did not finish, a
 *    file that threw while collecting, the native module runner or browser
 *    mode — each fails. A package with a vitest config and no such script is
 *    recorded under the default `vitest run`. The static prediction (vitest's
 *    globbing + every file-valued entry of the resolved config, a key in
 *    `VITEST_TEST_CODE_KEYS` collected, one in `VITEST_NON_CODE_KEYS` not, any
 *    other failing as "unknown file-valued vitest key") runs inside each
 *    recorded process as a CROSS-CHECK: a predicted file no recorded run
 *    loaded fails. Test files = recorded specs ∪ the prediction ∪ every
 *    git-listed file named `*.test.*` / `*.spec.*` or under `__tests__/`
 *    (tracked, or untracked-and-not-ignored), declarations included.
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
 *    ROOT file of some recorded invocation's program AND type-checked there
 *    (every other recorded file: IN that program — a root or imported by one —
 *    and type-checked there) —
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
 *    a second run waits up to `LOCK_WAIT_MS` (10 min — a whole full run;
 *    `CHECK_TESTS_TYPECHECKED_LOCK_WAIT_MS` overrides) and then fails naming
 *    the holder — another run's canary, globbed by this run's tsc and deleted
 *    before it is read, would stop the chain with TS6053. A dead holder is
 *    reclaimed at once, a hung one or a reused pid once its token + heartbeat
 *    stops changing.
 * 7. The `typecheck` script — and every package script it runs via
 *    `pnpm run <x>` / `pnpm <x>` — may chain only with `&&`, may not use `$`
 *    or backtick expansion, and every step must be `tsc ...` or such a hop
 *    (deny by default: an error-baseline wrapper like `node scripts/tc.mjs`
 *    fails; `TYPECHECK_EXTRA_STEPS` allows an exact codegen step by package).
 *
 * Packages come from `pnpm-workspace.yaml`; a package with collected test
 * files and no `typecheck` script fails.
 *
 * ## Cost
 *
 * Per package: every test script run collection-only under the recorder,
 * one record-only typecheck and one full canary `typecheck` (more for a chain
 * that stops early), run `availableParallelism()` packages at a time, largest
 * first (`CHECK_TESTS_TYPECHECKED_CONCURRENCY` overrides). Measured 2026-10-01
 * on a 4-core container: ~370s for the full run (74 packages, 144 recorded
 * test scripts) against ~205s for the round-5 gate on the same machine — the
 * recording is ~40% of the CPU: each test script costs a pnpm start, a vitest
 * boot and an import of every test file. CI's `check` job runs it in full.
 * The pre-push runs it DIFF-SCOPED (`CHECK_TESTS_TYPECHECKED_SCOPE=changed`,
 * or `--changed`): only packages with a non-documentation change vs
 * merge-base(origin/main, HEAD), committed or not (vitest may load any file
 * of a package). It fails CLOSED to the full run when the merge-base or diff
 * can't be computed, or when a shared config outside every package
 * (tsconfig.base.json, a vitest config, the root package.json,
 * pnpm-workspace.yaml, pnpm-lock.yaml, .npmrc) or the gate's own code (this
 * file and its seven scripts/lib helpers) changed. The aperture line names
 * which it did; every trigger is pinned by a test.
 *
 * ## Usage
 *
 *   tsx scripts/check-tests-typechecked.ts           # exit 1 on any failure
 *   tsx scripts/check-tests-typechecked.ts --table   # per-package table
 *   tsx scripts/check-tests-typechecked.ts --changed # diff-scoped (pre-push)
 *
 * Env: `CHECK_TESTS_TYPECHECKED_ROOT` (fixture workspace root, the harness),
 * `CHECK_TESTS_TYPECHECKED_VITEST_TIMEOUT_MS` (one recorded test script's
 * limit, default 300000), `CHECK_TESTS_TYPECHECKED_ONLY` (comma list of package dirs — the
 * check-gates-effective probe; the aperture line says when it is set; wins
 * over the diff scope), `CHECK_TESTS_TYPECHECKED_SCOPE=changed` (diff scope,
 * above), `CHECK_TESTS_TYPECHECKED_BASE` (the diff's base ref, default
 * origin/main).
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
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
const RECORDER = join(__dirname, "lib/tsc-recorder.cjs");
const VITEST_RECORDER = join(__dirname, "lib/vitest-recorder.cjs");
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

const AJV_STUB_REASON =
  "CommonJS module stub for ajv-formats / ajv codegen (the ajv@6 vs ajv-formats@3 conflict): vitest.config.ts aliases ajv-formats to it and src/__tests__/__stubs__/patch-ajv.ts redirects Node's native require to it, so it must stay plain CommonJS that Node (engines >=20, no type stripping) can require; tsc checks no JavaScript in this package (no checkJs). Recorded by the vitest recorder 2026-10-01. Follow-up: drop the stub when the ajv pin moves to 8.";

export const KNOWN_UNCOVERED: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "packages/mcp-server": {
    "src/__tests__/__stubs__/ajv-formats-stub.cjs": AJV_STUB_REASON,
  },
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
 * Steps of a `typecheck` chain that are neither `tsc` nor `pnpm run <script>`,
 * allowed per package by exact text with the reason. Deny by default: any
 * other step (an error-baseline wrapper such as `node scripts/tc.mjs`, `npx`,
 * a binary) fails — a wrapper can run tsc and filter its result.
 */
export const TYPECHECK_EXTRA_STEPS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "apps/docs": {
    "fumadocs-mdx":
      "codegen: writes the .source/ module tsc then type-checks (fumadocs' MDX collections); it runs no tsc and reports no type errors",
  },
};

/**
 * Every rule violation of the typecheck chain in `entry` and each package
 * script it runs: non-`&&` operators, `$`/backtick expansion, and any step
 * that is not `tsc ...` or `pnpm run <script>` / `pnpm <script>` (a script of
 * this package, whose steps are held to the same rule) — unless `extraSteps`
 * names that exact step. A deny rule on the script text, not an inference of
 * what the script compiles (the recorder supplies that).
 */
export function chainViolations(
  scripts: Record<string, string>,
  entry = "typecheck",
  extraSteps: Readonly<Record<string, string>> = {},
): string[] {
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
    const ops = new Set(nonAndOperators(cmd));
    for (const op of ops) {
      out.push(
        `script "${name}" ("${cmd}") uses \`${op}\` — every step of the typecheck chain must run unconditionally; chain with \`&&\` only`,
      );
    }
    if (ops.size > 0) return;
    for (const segment of shellSegments(cmd)) {
      const step = segment.trim();
      const words = shellWords(step);
      if (words[0] === "tsc") continue;
      const hop = words[0] === "pnpm" ? (words[1] === "run" ? words[2] : words[1]) : undefined;
      const hopArity = words[1] === "run" ? 3 : 2;
      if (hop !== undefined && scripts[hop] !== undefined && words.length === hopArity) {
        visit(hop);
        continue;
      }
      if (Object.hasOwn(extraSteps, step)) continue;
      out.push(
        `script "${name}" step "${step}" is neither \`tsc ...\` nor \`pnpm run <script>\` — deny by default: a wrapper can run tsc and filter its errors (an error baseline); run tsc directly, or, for a step that runs no tsc (codegen), allow its exact text in TYPECHECK_EXTRA_STEPS (scripts/check-tests-typechecked.ts) with the reason`,
      );
    }
  };
  visit(entry);
  return out;
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
 * Package scripts that are not vitest, each pinned to its exact command (and
 * the sha256 of every package file the command runs) with the reason. The
 * gate does not run them (an e2e browser run, a two-relay smoke test); every
 * OTHER `test` / `test:*` script, and every script whose command mentions
 * vitest, is RUN under the vitest recorder, and one whose run starts no vitest
 * the recorder observes fails (deny by default). An entry whose script is gone
 * or whose command or pinned file changed fails as stale.
 */
export const NON_VITEST_TEST_SCRIPTS: Readonly<
  Record<
    string,
    Readonly<
      Record<string, { command: string; reason: string; files?: Readonly<Record<string, string>> }>
    >
  >
> = {
  "apps/web": {
    "test:e2e": {
      command: "playwright test",
      reason:
        "Playwright e2e (a browser run, the ci.yml e2e job), not vitest; its specs are git-listed test files covered by KNOWN_UNCOVERED",
    },
    "test:e2e:ui": {
      command: "playwright test --ui",
      reason: "the interactive Playwright UI over the same e2e specs; not vitest",
    },
  },
  "apps/cli": {
    "test:dogfood": {
      command: "scripts/federation-dogfood.sh",
      files: {
        "scripts/federation-dogfood.sh":
          "d84a8972ff2f9405c8c9ea1b30824960dfe11f4480b1b28566749fc2fba6886e",
      },
      reason:
        "a bash smoke test that boots two real relays and drives the built CLI against them; it runs no vitest",
    },
  },
};

/**
 * Problems with a package's NON_VITEST_TEST_SCRIPTS entries: the script is
 * gone, its command changed, or a pinned file's bytes changed (stale — the
 * exemption was granted to exactly that command).
 */
export function nonVitestProblems(
  pkgAbs: string,
  scripts: Record<string, string>,
  entries: Readonly<Record<string, { command: string; files?: Readonly<Record<string, string>> }>>,
): string[] {
  const out: string[] = [];
  for (const [name, e] of Object.entries(entries)) {
    if (scripts[name] !== e.command) {
      out.push(
        `stale NON_VITEST_TEST_SCRIPTS entry "${name}": the script is ${scripts[name] === undefined ? "gone" : `now "${scripts[name]}"`}, the entry pins "${e.command}" — the gate runs every test script under the vitest recorder unless pinned; delete or re-pin the entry (scripts/check-tests-typechecked.ts)`,
      );
      continue;
    }
    for (const [file, sha] of Object.entries(e.files ?? {})) {
      const abs = join(pkgAbs, file);
      const got = existsSync(abs)
        ? createHash("sha256").update(readFileSync(abs)).digest("hex")
        : "missing";
      if (got !== sha) {
        out.push(
          `stale NON_VITEST_TEST_SCRIPTS entry "${name}": ${file} changed (sha256 ${got}, pinned ${sha}) — confirm it still runs no vitest, then re-pin the hash`,
        );
      }
    }
  }
  return out;
}

/** The scripts the gate runs under the vitest recorder: `test`, `test:*`, any that mention vitest. */
export function vitestScripts(
  scripts: Record<string, string>,
  exempt: Readonly<Record<string, unknown>> = {},
): string[] {
  return Object.keys(scripts)
    .filter((n) => /^test(?::|$)/.test(n) || /\bvitest\b/.test(scripts[n]!))
    .filter((n) => !Object.hasOwn(exempt, n))
    .sort();
}

/** One JSONL line of scripts/lib/vitest-recorder.cjs / vitest-record-plugin.mjs. */
export interface VitestRecord {
  pid: number;
  event: string;
  id?: string;
  configFile?: string | null;
  deps?: string[];
  argv?: string[];
  why?: string[];
  specs?: string[];
  failed?: { file: string | null; error: string }[];
  static?: { files: string[]; fileValued: { key: string; file: string }[] };
}

/** What one recorded script run says vitest loaded. */
export interface VitestRecording {
  /** Test files vitest collected (specs). */
  specs: Set<string>;
  /** Every repo code file vite transformed or resolved for vitest, or a config imported → how. */
  loaded: Map<string, string>;
  /** The config files vite resolved (exempt themselves; their imports are not). */
  configFiles: Set<string>;
  /** The static prediction over the same resolved configs (the cross-check). */
  staticFiles: string[];
  staticFileValued: { key: string; file: string }[];
  problems: string[];
}

/** Ids vite loads as a string, never as code (`?raw`, `?url`, `?inline`). */
const NON_CODE_QUERY = /[?&](?:raw|url|inline)(?:[&=]|$)/;
/** Extensions of data a test imports (never type-checked as code). Every other extension counts. */
const DATA_EXT =
  /\.(?:json5?|css|scss|sass|less|html?|svg|png|jpe?g|gif|webp|avif|ico|txt|md|mdx|wasm|woff2?|ttf|otf|ya?ml|sql|csv|map|node)$/i;

/** The absolute file a recorded id names, or null when it is not a repo code file. */
export function recordedFile(id: string, repoRoot: string): string | null {
  if (id.startsWith("\0") || NON_CODE_QUERY.test(id)) return null;
  const file = id.replace(/[?#].*$/, "");
  if (!file.startsWith("/") || file.split("/").includes("node_modules")) return null;
  if (!file.startsWith(repoRoot + "/") || DATA_EXT.test(file)) return null;
  try {
    return statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

/** How long one recorded script run may take (it is collection-only). */
const VITEST_RUN_TIMEOUT_MS =
  Number(process.env.CHECK_TESTS_TYPECHECKED_VITEST_TIMEOUT_MS) || 300_000;

/**
 * Read one script's recording. Deny by default: a run with no vitest the
 * recorder saw, a vitest process the plugin never attached to or that ended
 * before its collection finished, a mode whose modules bypass vite, a file
 * vitest could not collect (what it would load is unknown) — each is a problem.
 */
export function readRecording(
  script: string,
  records: VitestRecord[],
  run: { status: number | null; output: string; timedOut: boolean },
  repoRoot: string,
): VitestRecording {
  const res: VitestRecording = {
    specs: new Set(),
    loaded: new Map(),
    configFiles: new Set(),
    staticFiles: [],
    staticFileValued: [],
    problems: [],
  };
  const tail = run.output.replace(ANSI, "").trim().split("\n").slice(-3).join(" | ").slice(0, 300);
  if (run.timedOut) {
    res.problems.push(
      `script "${script}" did not finish under the vitest recorder within ${VITEST_RUN_TIMEOUT_MS}ms (the run is collection-only) — a watch mode or a hang; make it exit (\`vitest run\`), or raise CHECK_TESTS_TYPECHECKED_VITEST_TIMEOUT_MS`,
    );
  }
  if (records.some((r) => r.event === "no-hooks")) {
    res.problems.push(
      `the vitest recorder cannot run: node ${process.version} has no module.registerHooks — use node >= 22.15`,
    );
  }
  const pids = [...new Set(records.filter((r) => r.event === "vitest-loaded").map((r) => r.pid))];
  if (pids.length === 0) {
    res.problems.push(
      `script "${script}" ran (exit ${run.status}) but started no vitest the recorder observed${tail ? ` (output: ${tail})` : ""} — deny by default: the gate records what vitest loads by running each test script, so a script that hides its vitest (an env that drops NODE_OPTIONS, a non-node runner) cannot be checked. Run vitest from the script (directly, through \`pnpm run\` hops or a node wrapper); if the script is not vitest at all, pin it in NON_VITEST_TEST_SCRIPTS (scripts/check-tests-typechecked.ts) with the reason`,
    );
  }
  const add = (id: string, how: string): void => {
    const f = recordedFile(id, repoRoot);
    if (f && (!res.loaded.has(f) || res.loaded.get(f) === CONFIG_IMPORT_HOW))
      res.loaded.set(f, how);
  };
  for (const pid of pids) {
    const mine = records.filter((r) => r.pid === pid);
    const argv = mine.find((r) => r.event === "vitest-loaded")?.argv ?? [];
    const label = `script "${script}" (vitest pid ${pid}: ${[basename(argv[0] ?? "node"), ...argv.slice(1)].join(" ")})`;
    if (!mine.some((r) => r.event === "vitest")) {
      res.problems.push(
        `${label}: vitest loaded but the recording plugin never attached to it — the recorder was bypassed, so what it loads is unknown`,
      );
      continue;
    }
    for (const r of mine.filter((x) => x.event === "unsupported")) {
      res.problems.push(
        `${label}: ${(r.why ?? []).join("; ")} — the recorder sees only modules vite serves; run these tests through vite's module runner`,
      );
    }
    const collected = mine.filter((r) => r.event === "collected");
    if (collected.length === 0) {
      res.problems.push(
        `${label}: vitest exited (exit ${run.status}) before its collection finished${tail ? ` (output: ${tail})` : ""} — what it loads is unknown; make \`vitest list\` succeed for this package`,
      );
    }
    for (const c of collected) {
      for (const f of c.specs ?? []) res.specs.add(f);
      // A file whose collection threw: what it would have imported after the
      // throw is unknown. (A run-level unhandled error — e.g. a worker rpc
      // closing during teardown — stops no import; it is not counted.)
      // "No test suite found" means the file imported to the end — nothing hidden.
      const threw = (c.failed ?? []).filter(
        (x) => x.file !== null && !x.error.startsWith("No test suite found"),
      );
      for (const f of threw) {
        res.problems.push(
          `${label}: vitest could not collect ${relative(repoRoot, f.file!)} (${f.error}) — an import that throws hides what would load after it; fix it so the file collects`,
        );
      }
      res.staticFiles.push(...(c.static?.files ?? []));
      res.staticFileValued.push(...(c.static?.fileValued ?? []));
    }
    for (const r of mine) {
      if (r.event === "module" && r.id) add(r.id, "transformed by vite for vitest");
      else if (r.event === "resolved" && r.id) add(r.id, "resolved by vite for vitest");
      else if (r.event === "config") {
        if (r.configFile) res.configFiles.add(r.configFile);
        for (const d of r.deps ?? []) {
          const f = recordedFile(d, repoRoot);
          if (f && d !== r.configFile && !res.loaded.has(f)) res.loaded.set(f, CONFIG_IMPORT_HOW);
        }
      }
    }
  }
  for (const r of records) {
    if (r.event === "native" && r.id) add(r.id, "required natively in a vitest worker");
  }
  for (const f of res.specs) res.loaded.set(f, "a test file vitest collected");
  return res;
}

/** How a file only the vitest config imports is recorded. */
const CONFIG_IMPORT_HOW = "imported by the vitest config";

/**
 * Repo-relative files that vitest configs import and no typecheck covers, each
 * with the reason — exempt ONLY while nothing but a config imports them (a
 * test importing one makes it test code). Exact paths; a full run fails on a
 * stale entry. A package's own resolved config file is exempt by rule (vite
 * evaluates it in its config-loading phase, bundled by esbuild); every OTHER
 * import of a config must be type-checked.
 */
export const KNOWN_CONFIG_IMPORTS: Readonly<Record<string, string>> = {
  "vitest.shared.ts":
    "the repo-root vitest config factory every package config imports (defineMotebitTest); it is outside every package, and no root typecheck exists yet. Follow-up: type-check the vitest configs and this factory (a root tsconfig for configs), then delete this entry and the config-file rule",
};

/** The build's outDir (absolute), from `tsc --showConfig` of tsconfig.json, or null. */
function outDirOf(shown: ShownConfig | undefined, pkgAbs: string): string | null {
  const o = shown?.compilerOptions.outDir;
  return typeof o === "string" ? resolve(pkgAbs, o) : null;
}

const foreignOutDirs = new Map<string, string | null>();
/** Another workspace package's build outDir (cached), or null. */
function foreignOutDir(tscBin: string, pkgAbs: string): string | null {
  if (!foreignOutDirs.has(pkgAbs)) {
    let out: string | null = null;
    if (existsSync(join(pkgAbs, "tsconfig.json"))) {
      try {
        out = outDirOf(showConfig(tscBin, pkgAbs, []), pkgAbs);
      } catch {
        out = null;
      }
    }
    foreignOutDirs.set(pkgAbs, out);
  }
  return foreignOutDirs.get(pkgAbs)!;
}

const trackedCache = new Map<string, Set<string>>();
/** Every git-tracked file under `root`, absolute (cached per root). */
function trackedFiles(root: string): Set<string> {
  if (!trackedCache.has(root)) trackedCache.set(root, new Set(gitList(root, ["--cached"]).files));
  return trackedCache.get(root)!;
}

const workspaceCache = new Map<string, string[]>();
/** The deepest workspace package dir containing `abs`, or null. */
function ownerPackage(root: string, abs: string): string | null {
  if (!workspaceCache.has(root)) workspaceCache.set(root, workspacePackageDirs(root));
  return (
    workspaceCache
      .get(root)!
      .filter((d) => abs.startsWith(d + "/"))
      .sort((a, b) => b.length - a.length)[0] ?? null
  );
}

/** A vitest config vitest would find with no `-c` (a package with one but no test script). */
const DEFAULT_VITEST_CONFIG = /^vite(?:st)?\.config\.(?:[cm]?[jt]s)$/;

/**
 * Run one package script for real (`pnpm run <name>`) under the vitest
 * recorder — or, with `name` null, the default `pnpm exec vitest run` (a
 * package that has a vitest config but no script running vitest).
 */
export function recordVitestScript(
  pkgAbs: string,
  name: string | null,
  env: NodeJS.ProcessEnv,
  repoRoot = ROOT,
): Promise<VitestRecording> {
  const dir = mkdtempSync(join(tmpdir(), "vitest-record-"));
  const record = join(dir, "record.jsonl");
  const nodeOptions = [env.NODE_OPTIONS, `--require ${JSON.stringify(VITEST_RECORDER)}`]
    .filter(Boolean)
    .join(" ");
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    NODE_OPTIONS: nodeOptions,
    MOTEBIT_VITEST_RECORD: record,
    MOTEBIT_REPO_ROOT: repoRoot,
    FORCE_COLOR: "0",
  };
  delete childEnv.MOTEBIT_VITEST_INSIDE;
  return new Promise((done) => {
    const child = spawn("pnpm", name === null ? ["exec", "vitest", "run"] : ["run", name], {
      cwd: pkgAbs,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        /* already gone */
      }
    }, VITEST_RUN_TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr.on("data", (d: Buffer) => (output += d.toString()));
    child.on("close", (status) => {
      clearTimeout(timer);
      let records: VitestRecord[] = [];
      if (existsSync(record)) {
        records = readFileSync(record, "utf-8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as VitestRecord);
      }
      rmSync(dir, { recursive: true, force: true });
      const label = name ?? "(none: default `vitest run`)";
      done(readRecording(label, records, { status, output, timedOut }, repoRoot));
    });
  });
}

/** Per file: whether it is a root of / in the invocation's program, and why tsc skips it (null: checked). */
type CheckedFiles = Record<string, { root: boolean; inProgram: boolean; skip: string | null }>;

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
  /** Test scripts run under the vitest recorder. */
  scriptsRecorded: number;
  /** Distinct repo files the recorder saw vitest load as code. */
  recordedFiles: number;
  /** Vitest config files the recorder saw resolved (exempt by rule; their imports are not). */
  configFiles: number;
  /** KNOWN_CONFIG_IMPORTS entries this package's configs import. */
  configImportsSeen: string[];
  /** Recorded files that are untracked build output (a build outDir). */
  buildOutput: number;
  problems: string[];
}

export async function checkPackage(
  pkgAbs: string,
  opts: {
    root?: string;
    known?: typeof KNOWN_UNCOVERED;
    nonVitest?: typeof NON_VITEST_TEST_SCRIPTS;
    env?: NodeJS.ProcessEnv;
  } = {},
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
    scriptsRecorded: 0,
    recordedFiles: 0,
    configFiles: 0,
    configImportsSeen: [],
    buildOutput: 0,
    problems: [],
  };
  const rel = (abs: string): string => relative(pkgAbs, abs).split("\\").join("/");

  // 1. Collection: RECORDED by running every test script for real under
  // the vitest recorder, united with the static prediction (cross-check) and
  // every git-listed test-named file.
  const collected = new Set<string>();
  const vitestFiles: string[] = [];
  const recorded = new Map<string, { how: string; script: string }>();
  const configFiles = new Set<string>();
  const predicted = new Map<string, string>();
  const exemptScripts = (opts.nonVitest ?? NON_VITEST_TEST_SCRIPTS)[dir] ?? {};
  res.problems.push(...nonVitestProblems(pkgAbs, scripts, exemptScripts));
  const toRecord: (string | null)[] = vitestScripts(scripts, exemptScripts);
  // No script runs vitest but vitest would find a config here: record the
  // default `vitest run` (what `npx vitest` in the package would load).
  if (toRecord.length === 0 && readdirSync(pkgAbs).some((f) => DEFAULT_VITEST_CONFIG.test(f))) {
    toRecord.push(null);
  }
  for (const script of toRecord) {
    const name = script ?? "(none: default `vitest run`)";
    const rec = await recordVitestScript(pkgAbs, script, env, root);
    res.scriptsRecorded++;
    res.problems.push(...rec.problems);
    vitestFiles.push(...rec.specs);
    for (const [f, how] of rec.loaded) {
      const had = recorded.get(f);
      if (!had || (had.how === CONFIG_IMPORT_HOW && how !== CONFIG_IMPORT_HOW)) {
        recorded.set(f, { how, script: name });
      }
    }
    for (const f of rec.configFiles) configFiles.add(f);
    for (const f of rec.staticFiles)
      predicted.set(f, `a test file vitest's globs match (script "${name}")`);
    for (const { key, file } of rec.staticFileValued) {
      if (VITEST_TEST_CODE_KEYS.has(key)) {
        vitestFiles.push(file);
        predicted.set(
          file,
          `the value of \`${key}\` in the resolved vitest config (script "${name}")`,
        );
      } else if (!Object.hasOwn(VITEST_NON_CODE_KEYS, key)) {
        res.problems.push(
          `${relative(root, file).split("\\").join("/")} is the value of \`${key}\` in the resolved vitest config (script "${name}") — an unknown file-valued vitest key: the gate cannot tell whether vitest runs that file as test code. Classify the key in scripts/check-tests-typechecked.ts: VITEST_TEST_CODE_KEYS if vitest loads it (it is then canaried and membership-checked like a test), VITEST_NON_CODE_KEYS with the reason if it never does`,
        );
      }
    }
  }
  // Cross-check: what the static prediction says vitest runs, the recorder must have seen load.
  for (const [f, why] of predicted) {
    if (recorded.has(f) || isExemptCanary(f, new Set())) continue;
    res.problems.push(
      `${relative(root, f).split("\\").join("/")} is ${why}, but no recorded vitest run of this package loaded it — the static prediction and the recording disagree; the gate trusts neither alone. Make the script that should run it run it, or remove it from the config`,
    );
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
  res.problems.push(...chainViolations(scripts, "typecheck", TYPECHECK_EXTRA_STEPS[dir] ?? {}));

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
  // Every recorded file vitest loads as code, beyond the collected test
  // files: in the package it must be type-checked (below) unless it is the
  // vitest config itself or untracked build output; outside the package it
  // fails unless it is another package's untracked build output or an
  // allowlisted config import.
  const mustCheck = new Map<string, string>();
  const ownOut = outDirOf(reference, pkgAbs);
  const tracked = trackedFiles(root);
  for (const [f, { how: kind, script }] of recorded) {
    const how = `${kind}, script "${script}"`;
    if (collected.has(f) || isExemptCanary(f, g.tracked)) continue;
    if (configFiles.has(f)) continue;
    if (f.startsWith(pkgAbs + "/")) {
      if (ownOut && f.startsWith(ownOut + "/") && !tracked.has(f)) res.buildOutput++;
      else mustCheck.set(f, how);
      continue;
    }
    const relRoot = relative(root, f).split("\\").join("/");
    if (kind === CONFIG_IMPORT_HOW && Object.hasOwn(KNOWN_CONFIG_IMPORTS, relRoot)) {
      res.configImportsSeen.push(relRoot);
      continue;
    }
    const owner = ownerPackage(root, f);
    const theirOut = owner && tscFallback ? foreignOutDir(tscFallback, owner) : null;
    if (theirOut && f.startsWith(theirOut + "/") && !tracked.has(f)) {
      res.buildOutput++;
      continue;
    }
    res.problems.push(
      `${relRoot} is loaded as code by this package's vitest (recorded: ${how}) but is outside the package (${dir}/) and is not another package's build output — no check here proves a typecheck covers it; keep test code (setup, harness, config imports) inside the package that runs it`,
    );
  }
  res.recordedFiles = recorded.size;
  res.configFiles = configFiles.size;
  // Per collected file: some tsc checks it, or why the ones rooting it skip it.
  const verdicts = new Map<string, { checked: boolean; skips: string[] }>();
  const loadedVerdicts = new Map<string, { checked: boolean; skips: string[] }>();
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
    if (mine.length > 0 || mustCheck.size > 0) {
      try {
        const answer = await tscChecked(inv, [...new Set([...mine, ...mustCheck.keys()])], env);
        for (const f of mine) {
          const a = answer[f];
          if (!a?.root) continue;
          const v = verdicts.get(f) ?? { checked: false, skips: [] };
          if (a.skip === null) v.checked = true;
          else v.skips.push(`${a.skip} (\`${label}\`)`);
          verdicts.set(f, v);
        }
        // A recorded module need not be a root: tsc checks every source file
        // in its program, roots and what they import alike.
        for (const f of mustCheck.keys()) {
          const a = answer[f];
          if (!a?.inProgram) continue;
          const v = loadedVerdicts.get(f) ?? { checked: false, skips: [] };
          if (a.skip === null) v.checked = true;
          else v.skips.push(`${a.skip} (\`${label}\`)`);
          loadedVerdicts.set(f, v);
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
  for (const [f, how] of mustCheck) {
    const v = loadedVerdicts.get(f);
    if (v?.checked) continue;
    if (isKnown(f)) {
      res.allowlisted.push(rel(f));
      continue;
    }
    res.problems.push(
      `${rel(f)} is loaded as code by vitest (recorded: ${how}) but ${v && v.skips.length > 0 ? `the tsc that has it in its program skips it: ${v.skips.join("; ")}` : "it is in the program of no tsc the typecheck script runs"} — include it in the package's test tsconfig (\`include\`), or stop vitest loading it`,
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
  "scripts/lib/vitest-recorder.cjs",
  "scripts/lib/vitest-record-plugin.mjs",
  "scripts/lib/tsc-recorder.cjs",
  "scripts/lib/tsc-checked-files.cjs",
  "scripts/lib/repo-lock.ts",
]);

/**
 * Whether a changed package-relative path can change that package's result:
 * every change but documentation. vitest can load ANY file of the package (a
 * harness module a setup file imports, a source file a test imports), and a
 * changed source can import a new, unchecked one.
 */
export function affectsPackage(relPath: string): boolean {
  return !/\.mdx?$/i.test(relPath);
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
 * before giving up (RED, naming the holder): long enough to cover a whole full
 * run (~3-5 min), so two honest concurrent runs both pass — the second just
 * waits. A dead or hung holder is reclaimed by heartbeat well before this
 * (scripts/lib/repo-lock.ts). `CHECK_TESTS_TYPECHECKED_LOCK_WAIT_MS` overrides
 * (the gate's harness sets a short wait where it tests the timeout itself).
 */
export const LOCK_WAIT_MS = 10 * 60 * 1000;

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
        `✗ check-tests-typechecked: another run of this gate is using this worktree — ${err instanceof Error ? err.message : String(err)}.\n  Its canaries would corrupt this run's tsc (TS6053), so this run did not start. Fix: let that run finish and re-run, or raise CHECK_TESTS_TYPECHECKED_LOCK_WAIT_MS (default ${LOCK_WAIT_MS}). A dead or hung holder's lock is reclaimed automatically (its heartbeat stops).\n`,
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
    // Largest packages first (tracked-file count as the cost proxy): the
    // pool then packs short jobs into the tail instead of ending on one long
    // one. Results keep workspace order.
    const tracked = trackedFiles(ROOT);
    const size = new Map(
      dirs.map((d) => [d, [...tracked].filter((f) => f.startsWith(d + "/")).length]),
    );
    const order = [...dirs].sort((a, b) => size.get(b)! - size.get(a)!);
    const byDir = new Map<string, PackageResult | null>();
    await pool(order, concurrency, async (d) => byDir.set(d, await checkPackage(d)));
    results = dirs
      .map((d) => byDir.get(d) ?? null)
      .filter((r): r is PackageResult => r !== null && r.scanned);
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
  // A full run of the repo itself (not a fixture root, no scope) must see
  // every allowlisted config import in use.
  const globalProblems: string[] = [];
  if (
    !process.env.CHECK_TESTS_TYPECHECKED_ROOT &&
    only.length === 0 &&
    !scopeNote.includes("DIFF-SCOPED")
  ) {
    const seen = new Set(results.flatMap((r) => r.configImportsSeen));
    for (const k of Object.keys(KNOWN_CONFIG_IMPORTS)) {
      if (!seen.has(k)) {
        globalProblems.push(
          `stale KNOWN_CONFIG_IMPORTS entry "${k}" — no recorded vitest config imports it any more; delete it from scripts/check-tests-typechecked.ts`,
        );
      }
    }
  }
  const aperture = `${results.length} package(s) scanned${scopeNote}; ${sum((r) => r.scriptsRecorded)} test script(s) RUN under the vitest recorder (collection-only), which saw vitest load ${sum((r) => r.recordedFiles)} repo file(s) as code (${sum((r) => r.buildOutput)} untracked build output and ${sum((r) => r.configImportsSeen.length)} KNOWN_CONFIG_IMPORTS use(s) exempt, ${sum((r) => r.configFiles)} vitest config file(s) exempt by rule; every other one must be type-checked) and cross-checked the static prediction; ${sum((r) => r.testFiles)} collected test file(s) (recorded specs + static prediction + git-listed test-named files); ${sum((r) => r.canaryDirs)} canary director(ies) run through each package's real typecheck; every collected file asked of the recorded tsc's own Program (root + not skipped), every other recorded file too (in the program + not skipped); ${sum((r) => r.invocations)} recorded tsc invocation(s) diffed against tsconfig.json over ${sum((r) => r.keysCompared)} compilerOptions key comparison(s) (only ${DIFF_ALLOWED_KEYS.size} emit/layout keys may differ); ${sum((r) => r.allowlisted.length)} file(s) allowlisted in KNOWN_UNCOVERED; ${Math.round((Date.now() - started) / 1000)}s`;
  const failing = results.filter((r) => r.problems.length > 0);
  if (failing.length === 0 && globalProblems.length === 0) {
    process.stdout.write(`✓ check-tests-typechecked: ${aperture}.\n`);
    return;
  }
  const sites: string[] = [...globalProblems];
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
