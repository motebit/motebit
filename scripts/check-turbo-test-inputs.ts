/**
 * Turbo test-cache input gate (invariant #166) — the static PRE-CHECK.
 *
 * Enforces: a CACHED test result is only as honest as its task hash. Turbo
 * replays a package's `test` / `test:coverage` result whenever the task hash
 * is unchanged, so every input that can change a test's outcome MUST be in
 * that hash. A missed input is a silently weakened gate — a change to the
 * missed file replays yesterday's green — which is worse than slowness.
 *
 * ## The law is the RUNTIME input tracer, not this scan
 *
 * scripts/test-support/input-tracer.ts runs inside every cached test run and
 * fails any test that observes an input (file, module, env var, spawn)
 * outside its hash, naming the turbo.json entry to add. A static scan of path
 * expressions can never be complete (template literals, cwd-relative reads,
 * spreads, modules resolved through another package's closure — all reproduced
 * by scripts/turbo-stale-cache-harness.ts), so the path/env scan below is a
 * fast, best-effort pre-check that catches the common shapes before a test
 * run. What this gate DOES own completely is the configuration that makes the
 * tracer and the hash sound:
 *
 *   1. ROOT CONFIG — `test` / `test:coverage`: dependsOn `build`, outputs
 *      `coverage/**`, hash REQUIRED_TEST_ENV (CI, TZ, LANG, NODE_OPTIONS,
 *      LD_LIBRARY_PATH, MOTEBIT_TEST_RUNTIME), no passThroughEnv, strict env
 *      mode; `globalDependencies` carries GLOBAL_TEST_FILES (vitest.shared.ts,
 *      tsconfig.base.json, .node-version, the tracer).
 *   2. RUNTIME (C1) — `.node-version` is an exact version; every setup-node in
 *      .github/workflows reads it (`node-version-file`); every entry point
 *      that runs a test task goes through scripts/turbo-run.mjs (which hashes
 *      the running runtime as MOTEBIT_TEST_RUNTIME): root package.json
 *      scripts, .husky/pre-push, workflows. turbo itself is pinned exactly.
 *   3. PASS-THROUGH ENV (C6) — measured, not listed: the gate runs the
 *      INSTALLED turbo on a probe task that dumps its env, with every
 *      env-shaped name in the turbo binary (and every prefix wildcard) set,
 *      and requires every var that reaches the task to be classified in
 *      scripts/test-support/env-policy.ts; a `hash`-class var must be hashed.
 *   4. TRACER ADOPTION — every cached package's vitest config builds through
 *      `defineMotebitTest` (vitest.shared.ts), which registers the tracer.
 *   5. UNCACHED — a package whose tests cannot be made hermetic (or that
 *      cannot run the tracer) sets `cache: false` on both test tasks and is
 *      listed in UNCACHED with the reason. Both directions are checked.
 *   6. PRE-CHECK SCAN — statically evaluated path expressions
 *      (`resolve/join(__dirname, …)`, `new URL("../…", import.meta.url)`,
 *      template literals, `+`, const bindings, relative imports) that escape
 *      the package must be hashed; `process.env.X` reads of a measured
 *      pass-through var must be hashed or policy-benign.
 *
 * Doctrine: docs/ops/RUNBOOK.md § "Test results are cached too".
 *
 * ## Usage
 *
 *   tsx scripts/check-turbo-test-inputs.ts            # exit 1 on any violation
 *   tsx scripts/check-turbo-test-inputs.ts --root DIR [--passthrough FILE.json]
 *                                                     # a fixture tree (and its measured set)
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

import { formatRepair } from "./lib/gate-report.js";
import { classifyEnv, ENV_POLICY, REQUIRED_TEST_ENV } from "./test-support/env-policy.js";

const TEST_TASKS = ["test", "test:coverage"] as const;

/**
 * Repo-root files every package's test task reads, required in
 * `globalDependencies`: each vitest.config imports vitest.shared.ts (test
 * defaults, timeout, coverage reporters, the tracer registration); every
 * tsconfig extends tsconfig.base.json, which vitest's esbuild transform reads;
 * .node-version pins the runtime CI runs; the tracer is the law every cached
 * result was checked under.
 */
const GLOBAL_TEST_FILES = [
  "vitest.shared.ts",
  "tsconfig.base.json",
  ".node-version",
  "scripts/test-support/**",
] as const;

/** The one wrapper every test entry point goes through (C1). */
const WRAPPER = "node scripts/turbo-run.mjs";

/** Measured pass-through: exact var names, and prefixes whose probe passed. */
export interface Passthrough {
  exact: string[];
  prefixes: string[];
  /** vars present in the task that nobody set — turbo / pnpm inject them */
  injected: string[];
  /** how the set was obtained, for the aperture line */
  source: string;
}

/**
 * Packages whose tests cannot be made hermetic. Each sets `cache: false` on
 * both test tasks in its own turbo.json; the gate checks both directions.
 */
export const UNCACHED: Record<string, string> = {
  "@motebit/crypto-appattest":
    "apple-root.test.ts asserts the REAL clock sits inside the pinned Apple root's validity " +
    "window — a wall-clock input no hash can carry (a cached pass would hide the root expiring)",
  "@motebit/crypto-android-keystore":
    "google-roots.test.ts asserts the REAL clock sits inside the pinned Google roots' validity " +
    "windows (earliest notAfter 2035-07-15) — a wall-clock input no hash can carry",
  "@motebit/crypto-tpm":
    "tpm-roots.test.ts asserts the REAL clock sits inside each pinned TPM vendor root's validity " +
    "window (earliest notAfter 2035-10-15) — a wall-clock input no hash can carry",
  "@motebit/ai-core":
    "config.test.ts calls loadConfig() with no path, which reads the REAL ~/.motebit/config.json " +
    "(the runtime input tracer caught it) — user state no hash can carry. Cache it once the test " +
    "points HOME (or the path) at an mkdtemp dir",
  "@motebit/tools":
    "builtins.test.ts reaches path-sandbox's realpath of the REAL ~/.motebit (HOME is not " +
    "redirected; the runtime input tracer caught it) — user state no hash can carry. Cache it once " +
    "the test pins HOME / MOTEBIT_CONFIG_DIR to an mkdtemp dir",
  motebit:
    "apps/cli/vitest.config.ts is a bare defineConfig, not defineMotebitTest — the runtime input " +
    "tracer never runs, so no cached result could be proven hermetic. Cache it once the config " +
    "builds through vitest.shared.ts",
  "@motebit/inspector":
    "tests run from vite.config.ts with no vitest.shared.ts — the input tracer never runs",
  "@motebit/operator":
    "tests run from vite.config.ts with no vitest.shared.ts — the input tracer never runs",
};

/**
 * Reviewed out-of-package references that are NOT test inputs, keyed
 * `<file>|<target>` (repo-relative). Each must still be produced by the scan —
 * a stale entry fails the gate, so an exemption cannot outlive its site.
 */
export const REVIEWED_SITES: Record<string, string> = {};

const CODE_EXT = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".turbo", ".next", "target"]);
const PATH_FUNCS = new Set(["resolve", "join"]);
/** vitest's default `include` plus the config files it loads. */
const TEST_ENTRY =
  /(?:\.(?:test|spec)\.[cm]?[jt]sx?|\/vitest\.(?:config|setup|workspace)\.[cm]?[jt]s)$/;

// ── Types ────────────────────────────────────────────────────────────────

export interface Violation {
  pkg: string;
  site: string;
  kind: "config" | "path" | "env";
  detail: string;
}

export interface GateStats {
  packages: number;
  files: number;
  filesSeen: number;
  outOfPackageRefs: number;
  coveredByDeps: number;
  coveredByInputs: number;
  coveredByGlobal: number;
  coveredByLockfile: number;
  envReads: number;
  envHashed: number;
  envStripped: number;
  envPlumbing: number;
  uncached: number;
  reviewed: number;
  passthrough: number;
  entryPoints: number;
  workflows: number;
}

export interface GateResult {
  violations: Violation[];
  stats: GateStats;
  passthroughSource?: string;
}

interface TaskCfg {
  cache?: boolean;
  inputs?: string[];
  env?: string[];
  passThroughEnv?: string[];
  outputs?: string[];
  dependsOn?: string[];
}

interface TurboCfg {
  globalDependencies?: string[];
  globalEnv?: string[];
  globalPassThroughEnv?: string[];
  envMode?: string;
  tasks?: Record<string, TaskCfg>;
}

interface Pkg {
  name: string;
  dir: string;
  workspaceDeps: Set<string>;
  turbo: TurboCfg | null;
}

/** A statically-evaluated value. `open` = the tail is dynamic; `value` is a prefix. */
type Val =
  | { k: "str"; value: string; open: boolean }
  | { k: "path"; value: string; open: boolean }
  | { k: "url"; value: string; open: boolean };

// ── Config parsing ───────────────────────────────────────────────────────

function readJsonc<T>(file: string): T {
  // turbo.json is JSONC. Strip comments outside strings, then trailing commas.
  const src = readFileSync(file, "utf-8");
  let out = "";
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      out += c;
      if (c === "\\") out += src[++i] ?? "";
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1")) as T;
}

function listPackages(root: string): Pkg[] {
  const pkgs: Pkg[] = [];
  for (const group of ["packages", "apps", "services"]) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base).sort()) {
      const dir = join(base, entry);
      const manifest = join(dir, "package.json");
      if (!existsSync(manifest)) continue;
      const pj = JSON.parse(readFileSync(manifest, "utf-8")) as {
        name: string;
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
      };
      if (!TEST_TASKS.some((t) => pj.scripts?.[t])) continue;
      const workspaceDeps = new Set<string>();
      for (const deps of [
        pj.dependencies,
        pj.devDependencies,
        pj.peerDependencies,
        pj.optionalDependencies,
      ]) {
        for (const [n, v] of Object.entries(deps ?? {}))
          if (v.startsWith("workspace:")) workspaceDeps.add(n);
      }
      const turboFile = join(dir, "turbo.json");
      pkgs.push({
        name: pj.name,
        dir,
        workspaceDeps,
        turbo: existsSync(turboFile) ? readJsonc<TurboCfg>(turboFile) : null,
      });
    }
  }
  return pkgs;
}

/** Every workspace package (test script or not) by directory — a dependency need not test. */
interface PkgInfo {
  name: string;
  buildInputs?: string[];
  workspaceDeps: Set<string>;
}

function workspaceDepsOf(pj: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  for (const k of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"])
    for (const [n, v] of Object.entries((pj[k] as Record<string, string> | undefined) ?? {}))
      if (v.startsWith("workspace:")) out.add(n);
  return out;
}

function allPackageDirs(root: string): Map<string, PkgInfo> {
  const out = new Map<string, PkgInfo>();
  for (const group of ["packages", "apps", "services"]) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      const dir = join(base, entry);
      if (!existsSync(join(dir, "package.json"))) continue;
      const pj = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as {
        name: string;
      } & Record<string, unknown>;
      const t = existsSync(join(dir, "turbo.json"))
        ? readJsonc<TurboCfg>(join(dir, "turbo.json"))
        : null;
      out.set(dir, {
        name: pj.name,
        buildInputs: t?.tasks?.["build"]?.inputs,
        workspaceDeps: workspaceDepsOf(pj),
      });
    }
  }
  return out;
}

function walk(dir: string, acc: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (CODE_EXT.test(entry) && !entry.endsWith(".d.ts")) acc.push(p);
  }
  return acc;
}

// ── Glob matching (turbo `inputs` subset: **, *, ?, !negation) ─────────

function globToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      const slash = glob[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Resolve one declared input to an absolute glob (`$TURBO_ROOT$` = repo root). */
function absGlob(root: string, pkgDir: string, input: string): string {
  const g = input.replace(/^\$TURBO_ROOT\$/, root);
  return (g.startsWith("/") ? g : join(pkgDir, g)).split(sep).join("/");
}

function covers(globs: string[], target: string, isDir: boolean): boolean {
  const probe = (isDir ? `${target}/__any__/__file__` : target).split(sep).join("/");
  let hit = false;
  for (const g of globs) {
    if (g.startsWith("!")) {
      if (globToRegex(g.slice(1)).test(probe)) return false;
    } else if (globToRegex(g).test(probe)) hit = true;
  }
  return hit;
}

// ── Static path evaluation ───────────────────────────────────────────────

function calleeName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

function isImportMeta(n: ts.Node, prop: string): boolean {
  return (
    ts.isPropertyAccessExpression(n) &&
    n.name.text === prop &&
    ts.isMetaProperty(n.expression) &&
    n.expression.keywordToken === ts.SyntaxKind.ImportKeyword
  );
}

function strip(n: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isNonNullExpression(n) ||
    ts.isSatisfiesExpression(n)
  )
    n = n.expression;
  return n;
}

class Evaluator {
  private bindings = new Map<string, ts.Expression>();
  private visiting = new Set<string>();

  constructor(
    private file: string,
    private pkgDir: string,
    sf: ts.SourceFile,
  ) {
    const visit = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        // First binding wins: shadowing is rare in the path-constant idiom.
        if (!this.bindings.has(n.name.text)) this.bindings.set(n.name.text, n.initializer);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  eval(node: ts.Expression): Val | null {
    const n = strip(node);
    const fileDir = dirname(this.file);
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))
      return { k: "str", value: n.text, open: false };
    if (ts.isTemplateExpression(n)) {
      let s = n.head.text;
      for (const span of n.templateSpans) {
        const v = this.eval(span.expression);
        if (!v || v.k !== "str" || v.open) return { k: "str", value: s, open: true };
        s += v.value + span.literal.text;
      }
      return { k: "str", value: s, open: false };
    }
    if (ts.isIdentifier(n)) {
      if (n.text === "__dirname") return { k: "path", value: fileDir, open: false };
      if (n.text === "__filename") return { k: "path", value: this.file, open: false };
      const init = this.bindings.get(n.text);
      if (!init || this.visiting.has(n.text)) return null;
      this.visiting.add(n.text);
      try {
        return this.eval(init);
      } finally {
        this.visiting.delete(n.text);
      }
    }
    if (isImportMeta(n, "url")) return { k: "url", value: this.file, open: false };
    if (isImportMeta(n, "dirname")) return { k: "path", value: fileDir, open: false };
    if (isImportMeta(n, "filename")) return { k: "path", value: this.file, open: false };
    if (ts.isPropertyAccessExpression(n) && n.name.text === "pathname") {
      const v = this.eval(n.expression);
      return v && v.k === "url" ? { ...v, k: "path" } : null;
    }
    if (ts.isNewExpression(n) && calleeName(n.expression) === "URL" && n.arguments?.length) {
      const spec = this.eval(n.arguments[0]!);
      const base = n.arguments[1] ? this.eval(n.arguments[1]) : null;
      if (!spec || spec.k !== "str" || !base || base.k !== "url" || base.open) return null;
      const baseDir = dirname(base.value);
      return { k: "url", value: resolve(baseDir, spec.value), open: spec.open };
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const l = this.eval(n.left);
      if (!l || l.open) return l ? { ...l, open: true } : null;
      const r = this.eval(n.right);
      if (!r || r.k !== "str") return { ...l, open: true };
      if (l.k === "str") return { k: "str", value: l.value + r.value, open: r.open };
      return { k: l.k, value: resolve(l.value + r.value), open: r.open };
    }
    if (ts.isCallExpression(n)) {
      const name = calleeName(n.expression);
      const args = n.arguments;
      if (name === "cwd" && args.length === 0 && ts.isPropertyAccessExpression(n.expression))
        // vitest runs each package's tests with the package dir as cwd.
        return { k: "path", value: this.pkgDir, open: false };
      if (name === "fileURLToPath" && args.length === 1) {
        const v = this.eval(args[0]!);
        if (v && v.k === "url") return { ...v, k: "path" };
        if (v && v.k === "str" && v.value.startsWith("file:"))
          return { k: "path", value: fileURLToPath(v.value), open: v.open };
        return null;
      }
      if (name === "dirname" && args.length === 1) {
        const v = this.eval(args[0]!);
        if (!v || v.open || v.k === "str") return null;
        return { k: "path", value: dirname(v.value), open: false };
      }
      if (name && PATH_FUNCS.has(name) && args.length > 0) {
        const first = this.eval(args[0]!);
        let acc: string;
        if (!first) return null;
        if (first.k === "str") {
          // resolve("../x") is relative to the cwd — vitest runs in the package dir.
          if (name !== "resolve" || first.value.startsWith("/")) return null;
          acc = resolve(this.pkgDir, first.value);
        } else acc = first.value;
        if (first.open) return { k: "path", value: acc, open: true };
        for (const a of args.slice(1)) {
          const v = this.eval(a);
          if (!v || v.k !== "str") return { k: "path", value: acc, open: true };
          acc = resolve(acc, v.value);
          if (v.open) return { k: "path", value: acc, open: true };
        }
        return { k: "path", value: acc, open: false };
      }
    }
    return null;
  }
}

/** Parents through which a path value flows into a LARGER path value (not a read yet). */
function feedsLargerPath(n: ts.Node): boolean {
  const p = n.parent;
  if (!p) return false;
  if (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p))
    return feedsLargerPath(p);
  if (ts.isVariableDeclaration(p) && p.initializer === n) return true; // a binding; its uses count
  if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.PlusToken) return true;
  if (ts.isTemplateSpan(p)) return true;
  if (ts.isPropertyAccessExpression(p) && p.name.text === "pathname") return true;
  if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
    const name = calleeName(p.expression);
    if (name && (PATH_FUNCS.has(name) || name === "fileURLToPath" || name === "dirname"))
      return true;
    if (ts.isNewExpression(p) && name === "URL") return true;
  }
  return false;
}

interface Ref {
  line: number;
  target: string;
  /** Dynamic tail: the read is somewhere under `target`. */
  open: boolean;
  /** Loaded as a MODULE (import / require) — its own relative imports come with it. */
  module?: boolean;
}

export interface FileScan {
  refs: Ref[];
  /** Bare module specifiers (`@motebit/x`, `x/sub`) with their line. */
  bare: { line: number; spec: string }[];
}

function moduleSpecifier(n: ts.Node): ts.Expression | null {
  if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier)
    return n.moduleSpecifier;
  if (ts.isCallExpression(n)) {
    const name = calleeName(n.expression);
    const isDynImport = n.expression.kind === ts.SyntaxKind.ImportKeyword;
    if (
      (isDynImport || name === "require" || name === "mock" || name === "doMock") &&
      n.arguments.length > 0
    )
      return n.arguments[0]!;
  }
  if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument))
    return n.argument.literal as ts.Expression;
  return null;
}

export function scanFile(file: string, pkgDir: string): FileScan {
  const src = readFileSync(file, "utf-8");
  const kind = /\.(?:tsx|jsx)$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind);
  const ev = new Evaluator(file, pkgDir, sf);
  const refs: Ref[] = [];
  const bare: FileScan["bare"] = [];
  const fileDir = dirname(file);
  const lineOf = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;

  const visit = (n: ts.Node): void => {
    const spec = moduleSpecifier(n);
    if (spec && (ts.isStringLiteral(spec) || ts.isNoSubstitutionTemplateLiteral(spec))) {
      if (!spec.text.startsWith(".") && !spec.text.startsWith("/") && !spec.text.includes(":"))
        bare.push({ line: lineOf(spec), spec: spec.text });
      if (spec.text.startsWith("."))
        refs.push({
          line: lineOf(spec),
          target: resolveModule(resolve(fileDir, spec.text)),
          open: false,
          module: true,
        });
    } else if (
      (ts.isCallExpression(n) ||
        ts.isNewExpression(n) ||
        ts.isIdentifier(n) ||
        ts.isBinaryExpression(n) ||
        ts.isTemplateExpression(n) ||
        ts.isPropertyAccessExpression(n)) &&
      !feedsLargerPath(n) &&
      !(ts.isIdentifier(n) && n.parent && !isValuePosition(n))
    ) {
      const v = ev.eval(n as ts.Expression);
      if (v && v.k !== "str") {
        const p = n.parent;
        const module =
          ts.isCallExpression(p) &&
          p.arguments[0] === n &&
          (p.expression.kind === ts.SyntaxKind.ImportKeyword ||
            calleeName(p.expression) === "require");
        refs.push({
          line: lineOf(n),
          target: module ? resolveModule(v.value) : v.value,
          open: v.open,
          module,
        });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);

  // Fallback: a "../"-literal that escapes the package and names something on
  // disk, reached through a shape the evaluator does not model (a helper
  // parameter, a spread). Recorded unless an evaluated ref already names it.
  const named = new Set(refs.map((r) => r.target));
  const fallback = (n: ts.Node): void => {
    if (
      ts.isStringLiteralLike(n) &&
      n.text.startsWith("../") &&
      // a literal inside a path expression the evaluator resolved is already counted
      !(feedsLargerPath(n) && isExpr(n.parent) && ev.eval(n.parent) !== null)
    ) {
      const t = resolve(fileDir, n.text);
      if (!t.startsWith(pkgDir + sep) && !named.has(t) && existsSync(t))
        refs.push({ line: lineOf(n), target: t, open: false });
    }
    ts.forEachChild(n, fallback);
  };
  fallback(sf);

  // An open read under a root (`root + f` over a literal list) — recover the
  // concrete files: literals in the same file that name an existing path
  // under that root. Otherwise the whole directory is the read.
  const open = refs.filter((r) => r.open);
  if (open.length > 0) {
    const lits: ts.StringLiteralLike[] = [];
    const collect = (n: ts.Node): void => {
      if (ts.isStringLiteralLike(n)) lits.push(n);
      ts.forEachChild(n, collect);
    };
    collect(sf);
    for (const r of open) {
      const base = isDirPath(r.target) ? r.target : dirname(r.target);
      // Only forward, root-relative names ("apps/web/src/x.ts") — never "." / ".." hops.
      const found = lits.filter(
        (l) =>
          /^[\w@]/.test(l.text) &&
          /[/.]/.test(l.text) &&
          !l.text.split("/").includes("..") &&
          existsSync(join(base, l.text)),
      );
      if (found.length > 0) {
        r.target = "";
        for (const l of found)
          refs.push({ line: lineOf(l), target: resolve(base, l.text), open: false });
      } else r.target = base;
    }
  }
  const uniq = new Map<string, Ref>();
  for (const r of refs) if (r.target !== "") uniq.set(`${r.line}|${r.target}|${r.open}`, r);
  return { refs: [...uniq.values()], bare };
}

function isExpr(n: ts.Node): n is ts.Expression {
  return ts.isCallExpression(n) || ts.isNewExpression(n) || ts.isBinaryExpression(n);
}

/** A relative module specifier names `x.js` for `x.ts` on disk, or omits the extension. */
function resolveModule(target: string): string {
  if (existsSync(target) && !isDirPath(target)) return target;
  const swapped = target.replace(/\.(m|c)?js$/, (_m, x: string | undefined) => `.${x ?? ""}ts`);
  const candidates = [
    swapped,
    target.replace(/\.js$/, ".tsx"),
    ...[".ts", ".tsx", ".mts", ".js", ".mjs", ".json"].map((e) => target + e),
    ...["index.ts", "index.tsx", "index.js"].map((i) => join(target, i)),
  ];
  return candidates.find((c) => existsSync(c)) ?? target;
}

function isDirPath(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** An identifier is a value read unless it is a declaration name, property name, or import binding. */
function isValuePosition(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isVariableDeclaration(p) && p.name === id) return false;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if (ts.isPropertyAssignment(p) && p.name === id) return false;
  if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p)) return false;
  if (ts.isParameter(p) && p.name === id) return false;
  if (ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p) || ts.isMethodDeclaration(p))
    return false;
  if (ts.isTypeReferenceNode(p) || ts.isQualifiedName(p)) return false;
  return true;
}

// ── Env reads ────────────────────────────────────────────────────────────

interface EnvRead {
  line: number;
  name: string;
}

function isProcessEnv(n: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(n) &&
    n.name.text === "env" &&
    ts.isIdentifier(n.expression) &&
    n.expression.text === "process"
  );
}

function isWriteTarget(n: ts.Node): boolean {
  const p = n.parent;
  if (
    ts.isBinaryExpression(p) &&
    p.left === n &&
    p.operatorToken.kind === ts.SyntaxKind.EqualsToken
  )
    return true;
  if (ts.isDeleteExpression(p)) return true;
  return false;
}

function scanEnv(file: string): EnvRead[] {
  const src = readFileSync(file, "utf-8");
  if (!src.includes("process.env")) return [];
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const out: EnvRead[] = [];
  const lineOf = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAccessExpression(n) && isProcessEnv(n.expression) && !isWriteTarget(n))
      out.push({ line: lineOf(n), name: n.name.text });
    else if (
      ts.isElementAccessExpression(n) &&
      isProcessEnv(n.expression) &&
      ts.isStringLiteralLike(n.argumentExpression) &&
      !isWriteTarget(n)
    )
      out.push({ line: lineOf(n), name: n.argumentExpression.text });
    else if (
      ts.isVariableDeclaration(n) &&
      ts.isObjectBindingPattern(n.name) &&
      n.initializer &&
      isProcessEnv(strip(n.initializer))
    ) {
      for (const el of n.name.elements) {
        const key = el.propertyName ?? el.name;
        if (ts.isIdentifier(key)) out.push({ line: lineOf(el), name: key.text });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

// ── Measured pass-through env (C6) ───────────────────────────────────────

/**
 * Names the probe must not set to a junk value: they configure the processes
 * the probe runs (turbo, pnpm, node, git, the loader). Their FAMILIES are
 * still measured, through a prefix probe (`NODE_MOTEBIT_PROBE`); the exact
 * names with a safe value are in SAFE_PROBE_VALUES.
 */
const UNSAFE_PROBE =
  /^(?:NODE_|LD_|DYLD_|GIT_|TURBO_|TOKIO_|PNPM_|COREPACK_|NPM_|YARN_|HTTPS?_|NO_PROXY|ALL_PROXY|SSL_|RUST|CARGO|TMP|TEMP|HOME$|PATH$|SHELL$|PWD$|USER$|PYTHON|VITEST|CI$)/i;
const SAFE_PROBE_VALUES: Record<string, string> = {
  NODE_OPTIONS: "--no-deprecation",
  LD_LIBRARY_PATH: "/nonexistent-motebit-probe",
  TMP: tmpdir(),
  TEMP: tmpdir(),
  TMPDIR: tmpdir(),
  CI: "1",
  COREPACK_ENABLE_AUTO_PIN: "0",
};
const PROBE_SUFFIX = "MOTEBIT_PROBE";

/** The installed turbo's native binary, or null. */
function turboBinary(root: string): string | null {
  try {
    const req = createRequire(join(root, "package.json"));
    const turboPkg = realpathSync(req.resolve("turbo/package.json"));
    const os = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform as string];
    const arch = process.arch === "x64" ? "64" : process.arch;
    const bin = createRequire(turboPkg).resolve(`@turbo/${os}-${arch}/package.json`);
    const exe = join(dirname(bin), "bin", process.platform === "win32" ? "turbo.exe" : "turbo");
    return existsSync(exe) ? exe : null;
  } catch {
    return null;
  }
}

/**
 * Candidate names: every env-shaped token in the turbo binary (strings are
 * packed, so every identifier-shaped substring of each token), the caller's
 * env, and the policy's exact names; prefixes: every `X_*` token's `_`-ended
 * suffixes, plus the policy's prefixes and common families.
 */
export function probeCandidates(binaryText: string): { exact: string[]; prefixes: string[] } {
  const exact = new Set<string>(Object.keys(process.env));
  const prefixes = new Set<string>([
    "NODE_",
    "LD_",
    "GIT_",
    "PNPM_",
    "NPM_",
    "LC_",
    "npm_config_",
    "npm_package_",
    "AWS_",
    "GOOGLE_",
    "AZURE_",
  ]);
  for (const r of ENV_POLICY) {
    if (r.pattern.endsWith("*")) prefixes.add(r.pattern.slice(0, -1));
    else exact.add(r.pattern);
  }
  for (const tok of binaryText.match(/[A-Z][A-Z0-9_]{1,}\*?/g) ?? []) {
    const star = tok.endsWith("*");
    const w = star ? tok.slice(0, -1) : tok;
    if (w.length > 120) continue;
    if (star) {
      for (let i = 0; i < w.length; i++) if (/[A-Z]/.test(w[i]!)) prefixes.add(w.slice(i));
    }
    for (let i = 0; i < w.length; i++) {
      if (!/[A-Z]/.test(w[i]!)) continue;
      for (let j = i + 2; j <= w.length; j++) {
        const x = w.slice(i, j);
        if (!x.endsWith("_")) exact.add(x);
      }
    }
  }
  return { exact: [...exact], prefixes: [...prefixes].filter((p) => p.length > 0) };
}

/**
 * Run the INSTALLED turbo on a probe task that dumps its env, with every
 * candidate set, and report which vars reach the task. Cached per binary.
 */
export function measurePassthrough(root: string): Passthrough {
  const exe = turboBinary(root);
  const text = exe ? readFileSync(exe).toString("latin1") : "";
  const key = createHash("sha256")
    .update(text)
    .update(JSON.stringify(ENV_POLICY.map((r) => r.pattern)))
    .update(readFileSync(fileURLToPath(import.meta.url))) // this measurement code itself
    .update(Object.keys(process.env).sort().join(","))
    .digest("hex")
    .slice(0, 16);
  const cacheFile = join(
    root,
    "node_modules",
    ".cache",
    "motebit",
    `turbo-passthrough-${key}.json`,
  );
  if (existsSync(cacheFile)) {
    return JSON.parse(readFileSync(cacheFile, "utf-8")) as Passthrough;
  }
  const cand = probeCandidates(text);
  const probe: Record<string, string> = {};
  for (const n of cand.exact) {
    if (process.env[n] !== undefined) continue; // the caller's env is set anyway
    // EMPTY values: turbo filters by name, and an empty var is inert to the
    // tools the probe runs (a non-empty junk value in one of turbo's own config
    // vars — XDG_DATA_HOME, SCCACHE_START_SERVER — breaks the run).
    if (SAFE_PROBE_VALUES[n] !== undefined) probe[n] = SAFE_PROBE_VALUES[n];
    else if (!UNSAFE_PROBE.test(n)) probe[n] = "";
  }
  for (const p of cand.prefixes) probe[`${p}${PROBE_SUFFIX}`] = "";
  const fx = mkdtempSync(join(tmpdir(), "turbo-passthrough-"));
  const seen = new Set<string>();
  const unprobeable: string[] = [];
  const base: Record<string, string> = {
    ...(process.env as Record<string, string>),
    TURBO_TELEMETRY_DISABLED: "1",
    DO_NOT_TRACK: "1",
    TURBO_NO_UPDATE_NOTIFIER: "1",
  };
  try {
    writeFileSync(
      join(fx, "package.json"),
      JSON.stringify({ name: "probe-root", private: true, packageManager: readRootPm(root) }),
    );
    writeFileSync(join(fx, "pnpm-workspace.yaml"), 'packages:\n  - "p"\n');
    writeFileSync(join(fx, "turbo.json"), JSON.stringify({ tasks: { dump: { cache: false } } }));
    writeFileSync(
      join(fx, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\n  p: {}\n",
    );
    mkdirSync(join(fx, "p"));
    writeFileSync(
      join(fx, "p", "package.json"),
      JSON.stringify({
        name: "p",
        scripts: {
          dump: `node -e "process.stdout.write('ENVKEYS'+JSON.stringify(Object.keys(process.env))+'ENVEND')"`,
        },
      }),
    );
    // Batches keep the environment block well under ARG_MAX.
    const names = Object.keys(probe);
    const batches: string[][] = [[]];
    let size = 0;
    for (const n of names) {
      if (size > 600_000) {
        batches.push([]);
        size = 0;
      }
      batches[batches.length - 1]!.push(n);
      size += n.length + 3;
    }
    const run = (b: string[]): string[] | null => {
      const env = { ...base };
      for (const n of b) env[n] = probe[n]!;
      const r = spawnSync(exe ?? "turbo", ["run", "dump", "--ui=stream", "--output-logs=full"], {
        cwd: fx,
        env,
        encoding: "utf-8",
        timeout: 30_000,
      });
      const m = /ENVKEYS(\[.*?\])ENVEND/s.exec(`${r.stdout}${r.stderr}`);
      return m && r.status === 0 ? (JSON.parse(m[1]!) as string[]) : null;
    };
    // A batch that breaks the run (a name turbo itself consumes, set empty)
    // is bisected: the breaking names are reported as unprobeable, the rest
    // are still measured.
    const measure = (b: string[]): void => {
      const keys = run(b);
      if (keys) {
        for (const k of keys) seen.add(k);
        return;
      }
      if (b.length === 1) {
        unprobeable.push(b[0]!);
        return;
      }
      const h = b.length >> 1;
      measure(b.slice(0, h));
      measure(b.slice(h));
    };
    if (!run([]))
      throw new Error(
        `turbo pass-through probe cannot run turbo at all (${exe ?? "turbo on PATH"})`,
      );
    for (const b of batches) measure(b);
  } finally {
    rmSync(fx, { recursive: true, force: true });
  }
  // A prefix whose probe passed is a wildcard; the shortest passing prefix
  // subsumes the longer ones and every exact name under it.
  const passing = cand.prefixes.filter((p) => seen.has(`${p}${PROBE_SUFFIX}`)).sort();
  const prefixes = passing.filter((p) => !passing.some((q) => q !== p && p.startsWith(q)));
  const underPrefix = (k: string) => prefixes.some((p) => k.startsWith(p));
  const ours = new Set([...Object.keys(probe), ...Object.keys(process.env)]);
  const out: Passthrough = {
    exact: [...seen]
      .filter((k) => ours.has(k) && !k.endsWith(PROBE_SUFFIX) && !underPrefix(k))
      .sort(),
    prefixes,
    injected: [...seen].filter((k) => !ours.has(k) && !(k in base) && !underPrefix(k)).sort(),
    source:
      `measured from ${exe ? `turbo ${turboVersion(root)}: ${Object.keys(probe).length} probed name(s), ${cand.prefixes.length} prefix probe(s)` : "turbo on PATH"}` +
      (unprobeable.length
        ? `, ${unprobeable.length} unprobeable (turbo consumes them): ${unprobeable.join(", ")}`
        : ""),
  };
  mkdirSync(dirname(cacheFile), { recursive: true });
  writeFileSync(cacheFile, JSON.stringify(out));
  return out;
}

function readRootPm(root: string): string {
  const pj = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as {
    packageManager?: string;
  };
  return pj.packageManager ?? "pnpm@9.15.0";
}

function turboVersion(root: string): string {
  try {
    const req = createRequire(join(root, "package.json"));
    return (
      JSON.parse(readFileSync(req.resolve("turbo/package.json"), "utf-8")) as { version: string }
    ).version;
  } catch {
    return "?";
  }
}

/** Is `name` a var turbo passes through (measured)? */
function passesThrough(pt: Passthrough, name: string): boolean {
  return (
    pt.exact.includes(name) ||
    pt.injected.includes(name) ||
    pt.prefixes.some((p) => name.startsWith(p))
  );
}

// ── The gate ─────────────────────────────────────────────────────────────

export interface GateOptions {
  /** The measured pass-through set; measured from the installed turbo when omitted. */
  passthrough?: Passthrough;
}

export function runGate(root: string, opts: GateOptions = {}): GateResult {
  const violations: Violation[] = [];
  const stats: GateStats = {
    packages: 0,
    files: 0,
    filesSeen: 0,
    outOfPackageRefs: 0,
    coveredByDeps: 0,
    coveredByInputs: 0,
    coveredByGlobal: 0,
    coveredByLockfile: 0,
    envReads: 0,
    envHashed: 0,
    envStripped: 0,
    envPlumbing: 0,
    uncached: 0,
    reviewed: 0,
    passthrough: 0,
    entryPoints: 0,
    workflows: 0,
  };
  const reviewedHit = new Set<string>();
  const rel = (p: string): string => relative(root, p).split(sep).join("/") || ".";
  const rootCfg = readJsonc<TurboCfg>(join(root, "turbo.json"));
  const rootTasks = rootCfg.tasks ?? {};

  // 1. Root config.
  const cfgViolation = (detail: string): void => {
    violations.push({ pkg: "(root)", site: "turbo.json", kind: "config", detail });
  };
  if (rootCfg.envMode && rootCfg.envMode !== "strict")
    cfgViolation(`envMode is "${rootCfg.envMode}" — the env argument needs strict mode`);
  for (const f of GLOBAL_TEST_FILES)
    if (!(rootCfg.globalDependencies ?? []).includes(f))
      cfgViolation(`globalDependencies is missing "${f}" (every package's test task reads it)`);
  for (const t of TEST_TASKS) {
    const cfg = rootTasks[t];
    if (!cfg) {
      cfgViolation(`task "${t}" is not defined`);
      continue;
    }
    if (!(cfg.dependsOn ?? []).includes("build"))
      cfgViolation(`task "${t}" must dependsOn "build" so dependency files feed its hash`);
    if (cfg.inputs && !cfg.inputs.includes("$TURBO_DEFAULT$"))
      cfgViolation(`task "${t}" inputs must include "$TURBO_DEFAULT$" (the package's own files)`);
    for (const e of REQUIRED_TEST_ENV)
      if (!(cfg.env ?? []).includes(e) && !(rootCfg.globalEnv ?? []).includes(e))
        cfgViolation(
          `task "${t}" must hash "${e}" in env (${classifyEnv(e)?.reason ?? "the runtime the result is valid for"})`,
        );
    if (cfg.passThroughEnv?.length)
      cfgViolation(`task "${t}" declares passThroughEnv — declare outcome-changing vars in env`);
  }
  if (!(rootTasks["test:coverage"]?.outputs ?? []).includes("coverage/**"))
    cfgViolation(`task "test:coverage" must declare outputs ["coverage/**"] (CI uploads it)`);

  // 2. Runtime (C1): exact .node-version, workflows read it, entry points wrap.
  const nodeVersionFile = join(root, ".node-version");
  const nodeVersion = existsSync(nodeVersionFile)
    ? readFileSync(nodeVersionFile, "utf-8").trim()
    : "";
  if (!/^\d+\.\d+\.\d+$/.test(nodeVersion))
    violations.push({
      pkg: "(root)",
      site: ".node-version",
      kind: "config",
      detail: `must hold an exact Node version (e.g. 22.22.2), found ${nodeVersion ? `"${nodeVersion}"` : "nothing"} — CI's runtime must be one exact value`,
    });
  const rootPj = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as {
    scripts?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const turboSpec = rootPj.devDependencies?.turbo ?? "";
  if (!/^\d+\.\d+\.\d+$/.test(turboSpec))
    violations.push({
      pkg: "(root)",
      site: "package.json",
      kind: "config",
      detail: `devDependencies.turbo is "${turboSpec}" — pin it exactly (e.g. "2.10.9"): the pass-through env set and hashing rules are per turbo version`,
    });
  const TEST_TASK_RUN = /\bturbo(?:\.cmd)?\s+run\b[^\n]*?\btest(?::coverage)?\b/;
  const WRAPPED = /node\s+scripts\/turbo-run\.mjs\s+run\b[^\n]*?\btest(?::coverage)?\b/;
  for (const [name, cmd] of Object.entries(rootPj.scripts ?? {})) {
    if (!TEST_TASK_RUN.test(cmd) && !WRAPPED.test(cmd)) continue;
    stats.entryPoints++;
    if (!cmd.trim().startsWith(WRAPPER))
      violations.push({
        pkg: "(root)",
        site: `package.json scripts.${name}`,
        kind: "config",
        detail: `runs a test task without ${WRAPPER} ("${cmd}") — MOTEBIT_TEST_RUNTIME would be unset and every cached test fails the tracer; use "${WRAPPER} run …"`,
      });
  }
  const scanLines = (file: string, label: string): void => {
    if (!existsSync(file)) return;
    readFileSync(file, "utf-8")
      .split("\n")
      .forEach((line, i) => {
        if (/^\s*#/.test(line)) return;
        if (!TEST_TASK_RUN.test(line) && !WRAPPED.test(line)) return;
        stats.entryPoints++;
        if (!line.includes(WRAPPER))
          violations.push({
            pkg: "(root)",
            site: `${label}:${i + 1}`,
            kind: "config",
            detail: `runs a test task through turbo without ${WRAPPER} — use "${WRAPPER} run …" so the runtime is in the hash`,
          });
      });
  };
  scanLines(join(root, ".husky", "pre-push"), ".husky/pre-push");
  const wfDir = join(root, ".github", "workflows");
  if (existsSync(wfDir)) {
    for (const wf of readdirSync(wfDir)
      .filter((f) => /\.ya?ml$/.test(f))
      .sort()) {
      stats.workflows++;
      const file = join(wfDir, wf);
      scanLines(file, `.github/workflows/${wf}`);
      readFileSync(file, "utf-8")
        .split("\n")
        .forEach((line, i) => {
          if (/^\s*node-version\s*:/.test(line))
            violations.push({
              pkg: "(root)",
              site: `.github/workflows/${wf}:${i + 1}`,
              kind: "config",
              detail: `setup-node pins "${line.trim()}" — use \`node-version-file: .node-version\` so CI runs the one exact runtime`,
            });
        });
    }
  }

  // 3. Measured pass-through env (C6): every var that reaches a test task is classified.
  const pt = opts.passthrough ?? measurePassthrough(root);
  const rootTestEnv = TEST_TASKS.map((t) => [
    ...(rootTasks[t]?.env ?? []),
    ...(rootCfg.globalEnv ?? []),
  ]);
  for (const name of [...pt.exact, ...pt.injected]) {
    stats.passthrough++;
    const rule = classifyEnv(name);
    if (!rule)
      violations.push({
        pkg: "(turbo)",
        site: "scripts/test-support/env-policy.ts",
        kind: "env",
        detail: `turbo passes "${name}" into test tasks unhashed and ENV_POLICY does not classify it — add a rule: "hash" (consumed without a JS read → also add it to env of both test tasks) or "benign"/"guarded" with the reason`,
      });
    else if (rule.class === "hash" && rootTestEnv.some((e) => !e.includes(name)))
      cfgViolation(
        `"${name}" is a hash-class pass-through var (${rule.reason}) — add it to env of both test tasks`,
      );
  }
  for (const p of pt.prefixes) {
    stats.passthrough++;
    if (!classifyEnv(`${p}${PROBE_SUFFIX}`))
      violations.push({
        pkg: "(turbo)",
        site: "scripts/test-support/env-policy.ts",
        kind: "env",
        detail: `turbo passes every "${p}*" var into test tasks unhashed and ENV_POLICY does not classify the family — add a "${p}*" rule with its class and reason`,
      });
  }

  const globalGlobs = (rootCfg.globalDependencies ?? []).map((g) => absGlob(root, root, g));
  const dirs = allPackageDirs(root);
  const pkgs = listPackages(root);
  const workspaceNames = new Set([...dirs.values()].map((d) => d.name));
  const lockfileCovered = (t: string): boolean => t.split(sep).includes("node_modules");

  for (const pkg of pkgs) {
    stats.packages++;
    const pkgTasks = pkg.turbo?.tasks ?? {};
    const taskCfg = (t: string): TaskCfg => ({ ...rootTasks[t], ...pkgTasks[t] });
    const site = (f: string, line?: number): string => `${rel(f)}${line ? `:${line}` : ""}`;

    // 4. Uncached registry, both directions.
    const offBoth = TEST_TASKS.every((t) => taskCfg(t).cache === false);
    const offAny = TEST_TASKS.some((t) => taskCfg(t).cache === false);
    if (UNCACHED[pkg.name] !== undefined) {
      stats.uncached++;
      if (!offBoth)
        violations.push({
          pkg: pkg.name,
          site: site(join(pkg.dir, "turbo.json")),
          kind: "config",
          detail: `listed in UNCACHED but its turbo.json does not set cache:false on both test tasks`,
        });
      continue;
    }
    if (offAny) {
      violations.push({
        pkg: pkg.name,
        site: site(join(pkg.dir, "turbo.json")),
        kind: "config",
        detail: `test caching is disabled but the package is not in UNCACHED (state the reason there)`,
      });
      continue;
    }
    // 4. Tracer adoption: the package's vitest config builds through vitest.shared.ts.
    const vcfg = ["vitest.config.ts", "vitest.config.mts", "vitest.config.js", "vitest.config.mjs"]
      .map((f) => join(pkg.dir, f))
      .find((f) => existsSync(f));
    if (!vcfg || !/\bdefineMotebitTest\s*\(/.test(readFileSync(vcfg, "utf-8")))
      violations.push({
        pkg: pkg.name,
        site: site(vcfg ?? join(pkg.dir, "vitest.config.ts")),
        kind: "config",
        detail:
          `test results are cached but ${vcfg ? "the vitest config does not call defineMotebitTest" : "there is no vitest.config"} — ` +
          `the runtime input tracer (registered by vitest.shared.ts) would never run. Build the config with ` +
          `defineMotebitTest from vitest.shared.ts, or set cache:false on both test tasks and list it in UNCACHED`,
      });
    const inTask = TEST_TASKS.map((t) => JSON.stringify(taskCfg(t).inputs ?? null));
    if (inTask[0] !== inTask[1])
      violations.push({
        pkg: pkg.name,
        site: site(join(pkg.dir, "turbo.json")),
        kind: "config",
        detail: `"test" and "test:coverage" declare different inputs — a file hashed by one is stale in the other; declare the same list on both`,
      });
    for (const t of TEST_TASKS) {
      const inputs = pkgTasks[t]?.inputs;
      if (inputs && !inputs.includes("$TURBO_DEFAULT$"))
        violations.push({
          pkg: pkg.name,
          site: site(join(pkg.dir, "turbo.json")),
          kind: "config",
          detail: `task "${t}" inputs drop "$TURBO_DEFAULT$" — the package's own files would leave the hash`,
        });
    }

    // The test-time surface: the closure of vitest's entry points (test
    // files + vitest config) over in-package imports AND in-package path
    // references to code files (a spawned fixture script is test-time too).
    // Build scripts and hand-run tamper harnesses are outside it.
    const all = walk(pkg.dir, []);
    const scans = new Map<string, FileScan>();
    const scanOf = (f: string): FileScan => {
      let v = scans.get(f);
      if (!v) scans.set(f, (v = scanFile(f, pkg.dir)));
      return v;
    };
    const inPkg = (t: string): boolean => t.startsWith(pkg.dir + sep);
    const queue = all.filter((f) => TEST_ENTRY.test(f.slice(pkg.dir.length)));
    const files = new Set(queue);
    while (queue.length > 0) {
      const f = queue.pop()!;
      for (const r of scanOf(f).refs) {
        if (r.open || !inPkg(r.target)) continue;
        const m = resolveModule(r.target);
        if (CODE_EXT.test(m) && !files.has(m) && existsSync(m) && !isDirPath(m)) {
          files.add(m);
          queue.push(m);
        }
      }
    }
    stats.files += files.size;
    stats.filesSeen += all.length;

    // 2. Out-of-package paths + undeclared workspace imports.
    for (const f of files) {
      for (const b of scanOf(f).bare) {
        const name = b.spec.startsWith("@")
          ? b.spec.split("/").slice(0, 2).join("/")
          : b.spec.split("/")[0]!;
        if (name === pkg.name || !workspaceNames.has(name) || pkg.workspaceDeps.has(name)) continue;
        stats.outOfPackageRefs++;
        violations.push({
          pkg: pkg.name,
          site: site(f, b.line),
          kind: "path",
          detail:
            `imports ${name}, which ${rel(pkg.dir)}/package.json does not declare — it resolves through a ` +
            `hoisted link, so its files are NOT in this task's hash. Add "${name}": "workspace:*" to devDependencies`,
        });
      }
      for (const r of scanOf(f).refs) {
        const t = r.target;
        if (t === pkg.dir || inPkg(t)) continue;
        stats.outOfPackageRefs++;
        const reviewKey = `${rel(f)}|${rel(t)}`;
        if (REVIEWED_SITES[reviewKey] !== undefined) {
          reviewedHit.add(reviewKey);
          stats.reviewed++;
          continue;
        }
        if (!t.startsWith(root + sep) && t !== root) {
          violations.push({
            pkg: pkg.name,
            site: site(f, r.line),
            kind: "path",
            detail: `reads ${t}, OUTSIDE the repository — no hash can carry it; move it in or list the package in UNCACHED`,
          });
          continue;
        }
        if (lockfileCovered(t)) {
          stats.coveredByLockfile++;
          continue;
        }
        // (a) a workspace dependency whose build hashes its whole tree.
        const owner = [...dirs.entries()].find(([d]) => t === d || t.startsWith(d + sep));
        if (owner && pkg.workspaceDeps.has(owner[1].name) && !owner[1].buildInputs) {
          stats.coveredByDeps++;
          continue;
        }
        // A MODULE loaded from a non-dependency package drags in its sibling
        // files (relative imports) and ITS dependencies: the target's whole
        // directory must be hashed, and its deps must already be ours.
        let t2 = t;
        let isDir = r.open || isDirPath(t);
        if (r.module && owner && CODE_EXT.test(t)) {
          t2 = dirname(t);
          isDir = true;
          const extra = [...owner[1].workspaceDeps].filter(
            (d) => d !== pkg.name && !pkg.workspaceDeps.has(d),
          );
          if (extra.length > 0)
            violations.push({
              pkg: pkg.name,
              site: site(f, r.line),
              kind: "path",
              detail:
                `loads ${rel(t)} as a module, which imports ${extra.join(", ")} — not dependencies of ` +
                `${pkg.name}, so their files are NOT in this task's hash. Add "${owner[1].name}": "workspace:*" ` +
                `to devDependencies in ${rel(pkg.dir)}/package.json`,
            });
        }
        // (c) globalDependencies.
        if (covers(globalGlobs, t2, isDir)) {
          stats.coveredByGlobal++;
          continue;
        }
        // (b) declared inputs on BOTH test tasks.
        const missing = TEST_TASKS.filter((task) => {
          const globs = (taskCfg(task).inputs ?? []).map((g) => absGlob(root, pkg.dir, g));
          return !covers(globs, t2, isDir);
        });
        if (missing.length === 0) {
          stats.coveredByInputs++;
          continue;
        }
        const want = `$TURBO_ROOT$/${rel(t2)}${isDir ? "/**" : ""}`;
        violations.push({
          pkg: pkg.name,
          site: site(f, r.line),
          kind: "path",
          detail:
            `reads ${rel(t)}${r.open ? "/<dynamic>" : isDir ? "/ (whole directory)" : ""} outside the package, not hashed by ` +
            `${missing.join(" / ")} — add "${want}" to inputs of both test tasks in ${rel(pkg.dir)}/turbo.json` +
            (owner ? ` (or declare ${owner[1].name} as a workspace dependency)` : ""),
        });
      }
    }

    // 3. Env reads.
    for (const f of files) {
      for (const e of scanEnv(f)) {
        stats.envReads++;
        const hashed = TEST_TASKS.every(
          (t) =>
            (taskCfg(t).env ?? []).includes(e.name) || (rootCfg.globalEnv ?? []).includes(e.name),
        );
        const passes =
          passesThrough(pt, e.name) ||
          TEST_TASKS.some((t) => (taskCfg(t).passThroughEnv ?? []).includes(e.name)) ||
          (rootCfg.globalPassThroughEnv ?? []).includes(e.name);
        if (hashed) stats.envHashed++;
        else if (!passes) stats.envStripped++;
        else if (classifyEnv(e.name)?.class === "benign") stats.envPlumbing++;
        else
          violations.push({
            pkg: pkg.name,
            site: site(f, e.line),
            kind: "env",
            detail:
              `reads process.env.${e.name}, which reaches the test task UNHASHED — add "${e.name}" ` +
              `to env of both test tasks (turbo.json), or classify it "benign" in ` +
              `scripts/test-support/env-policy.ts if its value cannot change an outcome`,
          });
      }
    }
  }
  for (const key of Object.keys(REVIEWED_SITES))
    if (existsSync(join(root, key.split("|")[0]!)) && !reviewedHit.has(key))
      violations.push({
        pkg: "(gate)",
        site: "scripts/check-turbo-test-inputs.ts",
        kind: "config",
        detail: `REVIEWED_SITES entry "${key}" no longer matches any scanned reference — remove the stale entry`,
      });
  return { violations, stats, passthroughSource: pt.source };
}

function main(): void {
  const argRoot = process.argv.indexOf("--root");
  const here = dirname(fileURLToPath(import.meta.url));
  const root = argRoot > -1 ? resolve(process.argv[argRoot + 1]!) : resolve(here, "..");
  // --passthrough FILE: a fixture's measured set (tests), instead of measuring.
  const argPt = process.argv.indexOf("--passthrough");
  const passthrough =
    argPt > -1
      ? (JSON.parse(readFileSync(resolve(process.argv[argPt + 1]!), "utf-8")) as Passthrough)
      : undefined;
  const { violations, stats: s, passthroughSource } = runGate(root, { passthrough });
  const aperture =
    `${s.packages} package(s) with test tasks, ${s.files} test-time code file(s) scanned ` +
    `(the import/path closure of ${s.filesSeen} package code files); ` +
    `${s.outOfPackageRefs} out-of-package reference(s) — ${s.coveredByDeps} via workspace deps, ` +
    `${s.coveredByInputs} via declared inputs, ${s.coveredByGlobal} via globalDependencies, ` +
    `${s.coveredByLockfile} via the lockfile, ${s.reviewed} reviewed non-input(s); ${s.envReads} process.env read(s) — ` +
    `${s.envHashed} hashed, ${s.envStripped} stripped by strict env mode, ${s.envPlumbing} reviewed plumbing; ` +
    `${s.uncached} package(s) explicitly uncached; ${s.passthrough} pass-through var(s)/prefix(es) ` +
    `classified (${passthroughSource}); ${s.entryPoints} test entry point(s) and ${s.workflows} workflow(s) checked ` +
    `for the runtime wrapper. The runtime input tracer (scripts/test-support/input-tracer.ts) is the law; ` +
    `this scan is its pre-check`;
  if (violations.length === 0) {
    console.log(
      `✓ check-turbo-test-inputs: every cached test input is in its task hash\n  ${aperture}`,
    );
    return;
  }
  process.stderr.write(
    formatRepair({
      invariant: `${violations.length} test input(s) can change a test outcome without changing its turbo task hash — a cached pass would be stale`,
      sites: violations.map((v) => `[${v.kind}] ${v.pkg} ${v.site} — ${v.detail}`),
      canonical:
        "turbo.json (root test / test:coverage) and <package>/turbo.json (per-package inputs / env)",
      fix:
        'declare each outside file in the package turbo.json: { "extends": ["//"], "tasks": { "test": { "inputs": ["$TURBO_DEFAULT$", "$TURBO_ROOT$/<path>"] }, "test:coverage": { same } } }; ' +
        "or add the owner as a workspace dependency; or, if the test cannot be hermetic, set cache:false on both tasks and add the package to UNCACHED in scripts/check-turbo-test-inputs.ts with the reason",
      doctrine: 'docs/ops/RUNBOOK.md § "Test results are cached too"',
    }),
  );
  process.stderr.write(`  Aperture: ${aperture}\n\n`);
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
