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
 * 1. **What is a test file** is what vitest collects — vitest's own config
 *    loading and globbing (`scripts/lib/vitest-collect.mjs`), plus every
 *    `setupFiles` entry — united with every git-listed file named
 *    `*.test.*` / `*.spec.*` or under a `__tests__/` directory (tracked, or
 *    untracked-and-not-ignored). No directory is skipped by name.
 * 2. **Canary execution.** For every directory holding such a file, the gate
 *    writes a canary `__typecheck_canary_<rand>.test.<ext>` with a guaranteed
 *    type error (one per TS extension present there), runs the package's REAL
 *    `typecheck` script (`pnpm run typecheck`, as turbo runs it), and requires
 *    a non-zero exit whose output reports a TS error in EVERY canary. A `&&`
 *    chain can stop at its first failing `tsc`, so canaries still unreported
 *    are re-run alone until a pass reports none of them. Canaries are always
 *    removed (try/finally, exit and signal handlers, and a drain at start).
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
 * 5. **Membership.** Every collected TS file must be in the `files` of some
 *    recorded invocation's `--showConfig` (catches a per-file `exclude` a
 *    directory canary cannot see).
 * 6. **`@ts-nocheck`** in any collected file fails (a canary cannot prove a
 *    file-local pragma). A collected JS test file fails (tsc never checks it).
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
 * cores: 119s standalone, 103s inside `pnpm check` (the longest gate; the
 * whole `pnpm check` took 2m51s). Under the 4-minute bar, so it stays in
 * `pnpm check` — CI's `check` job and the local pre-push both run it.
 *
 * ## Usage
 *
 *   tsx scripts/check-tests-typechecked.ts           # exit 1 on any failure
 *   tsx scripts/check-tests-typechecked.ts --table   # per-package table
 *
 * Env: `CHECK_TESTS_TYPECHECKED_ROOT` (fixture workspace root, the harness),
 * `CHECK_TESTS_TYPECHECKED_ONLY` (comma list of package dirs — the
 * check-gates-effective probe; the aperture line says when it is set).
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
import { availableParallelism, tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { formatRepair } from "./lib/gate-report.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.CHECK_TESTS_TYPECHECKED_ROOT
  ? resolve(process.env.CHECK_TESTS_TYPECHECKED_ROOT)
  : resolve(__dirname, "..");
const COLLECTOR = join(__dirname, "lib/vitest-collect.mjs");
const RECORDER = join(__dirname, "lib/tsc-recorder.cjs");

export const CANARY_PREFIX = "__typecheck_canary_";

const TS_SOURCE = /\.(?:ts|tsx|mts|cts)$/;
const DECLARATION = /\.d\.(?:ts|mts|cts)$/;
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
 * not a test file; a JS file vitest would RUN is, and fails.
 */
export function isTestFile(relPath: string): boolean {
  const posix = relPath.split("\\").join("/");
  if (DECLARATION.test(posix)) return false;
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

/** The files vitest collects for a package (tests + setupFiles), absolute. */
export function vitestCollect(
  pkgAbs: string,
  env: NodeJS.ProcessEnv,
): { files: string[]; error?: string } {
  const r = spawnSync(process.execPath, [COLLECTOR], {
    cwd: pkgAbs,
    encoding: "utf-8",
    env: { ...env, MOTEBIT_VITEST_RESOLVE_FALLBACK: resolve(__dirname, "..") },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    return {
      files: [],
      error: `vitest collection failed: ${(r.stderr || r.stdout).trim().slice(0, 400)}`,
    };
  }
  try {
    const j = JSON.parse(r.stdout) as { files: string[]; setupFiles: string[] };
    return { files: [...j.files, ...j.setupFiles].map((f) => resolve(f)) };
  } catch (err) {
    return {
      files: [],
      error: `vitest collection printed no JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Git-listed (tracked, or untracked-not-ignored) test-named files under a package, absolute. */
export function gitTestFiles(pkgAbs: string): { files: string[]; error?: string } {
  const r = spawnSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."],
    {
      cwd: pkgAbs,
      encoding: "utf-8",
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  if (r.status !== 0) return { files: [], error: `git ls-files failed: ${r.stderr.trim()}` };
  return {
    files: r.stdout
      .split("\0")
      .filter((f) => f.length > 0 && isTestFile(f) && !basename(f).startsWith(CANARY_PREFIX))
      .map((f) => resolve(pkgAbs, f))
      .filter((f) => existsSync(f)),
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

/** Remove canaries an interrupted earlier run left behind. */
export function drainCanaries(root = ROOT): string[] {
  const r = spawnSync("git", ["ls-files", "-z", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf-8",
  });
  if (r.status !== 0) return [];
  const stale = r.stdout.split("\0").filter((f) => basename(f).startsWith(CANARY_PREFIX));
  for (const f of stale) rmSync(join(root, f), { force: true });
  return stale;
}

function writeCanary(dirAbs: string, ext: string): string {
  const id = randomBytes(6).toString("hex");
  const file = join(dirAbs, `${CANARY_PREFIX}${id}.test${ext}`);
  liveCanaries.add(file);
  writeFileSync(
    file,
    `// check-tests-typechecked canary — deliberately ill-typed; removed by the gate. Delete it if you see it.\nexport const ${CANARY_PREFIX}${id}: number = "canary ${id}";\n`,
  );
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
  const v = vitestCollect(pkgAbs, env);
  if (v.error) res.problems.push(v.error);
  const g = gitTestFiles(pkgAbs);
  if (g.error) res.problems.push(g.error);
  for (const f of [...v.files, ...g.files]) {
    if (f.startsWith(pkgAbs + "/") && !basename(f).startsWith(CANARY_PREFIX)) collected.add(f);
  }
  const files = [...collected].sort();
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
  const tsFiles = files.filter((f) => TS_SOURCE.test(f) && !DECLARATION.test(f));
  for (const f of files) {
    if (!tsFiles.includes(f) && !isKnown(f)) {
      res.problems.push(
        `${rel(f)} is a JavaScript test file — tsc never checks it; write it in TypeScript`,
      );
    }
    const text = readFileSync(f, "utf-8");
    if (/@ts-nocheck/.test(text)) {
      res.problems.push(
        `${rel(f)} carries \`@ts-nocheck\` — remove it and fix the errors it hides`,
      );
    }
  }

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
  const covered = new Set<string>();
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
    for (const f of shown.files) covered.add(f);
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
  const notMember = tsFiles.filter((f) => !covered.has(f));
  for (const f of notMember) {
    if (isKnown(f)) res.allowlisted.push(rel(f));
    else
      res.problems.push(
        `${rel(f)} is not a root file of any tsc the typecheck script runs (tsc --showConfig files)`,
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

async function main(): Promise<void> {
  const started = Date.now();
  const table = process.argv.includes("--table");
  const drained = drainCanaries();
  if (drained.length > 0) process.stderr.write(`drained ${drained.length} stale canary file(s)\n`);
  const only = (process.env.CHECK_TESTS_TYPECHECKED_ONLY ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  let dirs = workspacePackageDirs();
  if (only.length > 0)
    dirs = dirs.filter((d) => only.includes(relative(ROOT, d).split("\\").join("/")));
  const concurrency = Math.max(
    1,
    Number(process.env.CHECK_TESTS_TYPECHECKED_CONCURRENCY) || availableParallelism(),
  );
  const results = (await pool(dirs, concurrency, (d) => checkPackage(d))).filter(
    (r): r is PackageResult => r !== null && r.scanned,
  );

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
  const aperture = `${results.length} package(s) scanned${only.length > 0 ? ` (SCOPED by CHECK_TESTS_TYPECHECKED_ONLY to ${only.join(", ")})` : ""}; ${sum((r) => r.testFiles)} collected test file(s) (vitest collection + setupFiles + git-listed test-named files); ${sum((r) => r.canaryDirs)} canary director(ies) run through each package's real typecheck; ${sum((r) => r.invocations)} recorded tsc invocation(s) diffed against tsconfig.json over ${sum((r) => r.keysCompared)} compilerOptions key comparison(s) (only ${DIFF_ALLOWED_KEYS.size} emit/layout keys may differ); ${sum((r) => r.allowlisted.length)} file(s) allowlisted in KNOWN_UNCOVERED; ${Math.round((Date.now() - started) / 1000)}s`;
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
