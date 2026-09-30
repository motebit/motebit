/**
 * Turbo test-cache input gate (invariant #166).
 *
 * Enforces: a CACHED test result is only as honest as its task hash. Turbo
 * replays a package's `test` / `test:coverage` result whenever the task hash
 * is unchanged, so every input that can change a test's outcome MUST be in
 * that hash. A missed input is a silently weakened gate — a change to the
 * missed file replays yesterday's green — which is worse than slowness.
 *
 * ## What is already in the hash (and why this gate only checks the rest)
 *
 *   - every git-visible file in the package itself (`$TURBO_DEFAULT$`);
 *   - every workspace DEPENDENCY's files, transitively — `test` dependsOn the
 *     package's own `build`, which dependsOn `^build`, and a task hash folds
 *     in the hashes of the tasks it depends on;
 *   - the lockfile resolution of external deps (`node_modules/**`);
 *   - `globalDependencies` and declared `env` / `globalEnv` values.
 *
 * Turbo runs in STRICT env mode, so an env var that is not declared never
 * reaches the task at all (it is stripped) — reading it is hermetic. The only
 * undeclared vars that DO reach a test are turbo's built-in pass-through set
 * (`CI`, `TZ`, `LANG`, `HOME`, `PATH`, …) plus anything in `passThroughEnv`.
 *
 * ## What this gate checks
 *
 *   1. ROOT CONFIG — `test` and `test:coverage` in turbo.json: dependsOn
 *      `build`, declare `coverage/**` as outputs (CI uploads it), hash the
 *      pass-through vars that change outcomes implicitly (IMPLICIT_ENV), and
 *      `globalDependencies` carries the repo-wide files every package's
 *      vitest config reads (GLOBAL_TEST_FILES). Env mode stays strict.
 *   2. OUT-OF-PACKAGE PATHS — every code file of every workspace package is
 *      parsed and its path expressions are statically evaluated
 *      (`resolve/join(__dirname, …)`, `new URL("../…", import.meta.url)`,
 *      `dirname(fileURLToPath(import.meta.url))`, template literals, `+`,
 *      const bindings, relative `import` / `vi.mock` / `require` specifiers).
 *      A reference that escapes the package must be covered by (a) a
 *      workspace dependency (its files are hashed through `^build`), (b) the
 *      package's declared `inputs` on BOTH test tasks, or (c)
 *      `globalDependencies`. A reference whose tail is dynamic (a
 *      `REPO_ROOT` joined with a loop variable) must be covered as a whole
 *      directory (`dir/**`) — the gate cannot see which file is read.
 *   3. PASS-THROUGH ENV — every `process.env.X` read of a var that reaches
 *      the task unhashed must be hashed (`env`) or a reviewed PLUMBING var.
 *   4. UNCACHED — a package whose tests cannot be made hermetic sets
 *      `cache: false` on both test tasks in its own turbo.json and is listed
 *      in UNCACHED below with the reason. Both directions are checked.
 *
 * Aperture: every tracked code file (.ts/.tsx/.mts/.cts/.js/.mjs/.cjs) of
 * every workspace package that has a test script, not only `*.test.ts` —
 * code under test runs at test time too.
 *
 * Doctrine: docs/ops/RUNBOOK.md § "Turbo remote cache" (test caching).
 *
 * ## Usage
 *
 *   tsx scripts/check-turbo-test-inputs.ts            # exit 1 on any violation
 *   tsx scripts/check-turbo-test-inputs.ts --root DIR # run against a fixture tree
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

import { formatRepair } from "./lib/gate-report.js";

const TEST_TASKS = ["test", "test:coverage"] as const;

/**
 * Pass-through vars that change a test's OUTCOME without any `process.env`
 * read in repo code, so the gate requires them hashed on both test tasks:
 *   CI   — vitest's snapshot mode (CI refuses to write a missing snapshot;
 *          locally it writes it and passes), and it separates CI-produced
 *          cache entries from local ones (different Node/OS never cross).
 *   TZ   — every `Date` local-time conversion.
 *   LANG — ICU's default locale for every `Intl` / `toLocaleString`.
 */
const IMPLICIT_ENV = ["CI", "TZ", "LANG"] as const;

/**
 * Repo-root files every package's test task reads, required in
 * `globalDependencies`: each vitest.config imports vitest.shared.ts (test
 * defaults, timeout, coverage reporters); every tsconfig extends
 * tsconfig.base.json, which vitest's esbuild transform reads.
 */
const GLOBAL_TEST_FILES = ["vitest.shared.ts", "tsconfig.base.json"] as const;

/**
 * Env vars turbo passes to a strict-mode task without being declared
 * (measured against turbo 2.10: run a task whose script is `env` with each
 * candidate exported). A read of one of these is NOT stripped, so it must be
 * hashed or reviewed as plumbing. Unlisted vars are stripped → hermetic.
 */
const TURBO_BUILTIN_PASSTHROUGH = new Set([
  "CI",
  "COLORTERM",
  "COREPACK_ENABLE_AUTO_PIN",
  "DISPLAY",
  "FORCE_COLOR",
  "GITHUB_ACTIONS",
  "GITHUB_TOKEN",
  "HOME",
  "INIT_CWD",
  "LANG",
  "NODE",
  "NODE_OPTIONS",
  "NO_COLOR",
  "PATH",
  "PWD",
  "RUNNER_OS",
  "SHELL",
  "TERM",
  "TZ",
  "USER",
  "VERCEL",
]);

/**
 * Pass-through vars that are reviewed plumbing: they reach the task unhashed
 * and that is correct, because hashing the VALUE would not capture what the
 * read depends on (or the read only affects output formatting).
 */
const PLUMBING_ENV: Record<string, string> = {
  HOME:
    "a LOCATION, not content — hashing the path cannot capture what lives there. Every test " +
    "that exercises a HOME-reading code path redirects HOME / MOTEBIT_CONFIG_DIR to an mkdtemp " +
    "dir (apps/cli config/relay tests, packages/tools key-file-guard); a test that read the real " +
    "~ would be non-hermetic by content and belongs in UNCACHED",
  PATH: "process lookup only; tool versions are pinned by the lockfile",
  TERM: "output formatting only",
  COLORTERM: "output formatting only",
  FORCE_COLOR: "output formatting only",
  NO_COLOR: "output formatting only",
  PWD: "equals the package dir under turbo",
  INIT_CWD: "pnpm plumbing",
  SHELL: "process plumbing",
};

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
};

/**
 * Reviewed out-of-package references that are NOT test inputs, keyed
 * `<file>|<target>` (repo-relative). Each must still be produced by the scan —
 * a stale entry fails the gate, so an exemption cannot outlive its site.
 */
export const REVIEWED_SITES: Record<string, string> = {
  "apps/cli/src/subcommands/up.ts|apps":
    "resolveYamlPath() walks up from process.cwd() looking for motebit.yaml — interactive CLI " +
    "discovery. No test reaches it (yaml-config.test.ts imports only diffPlan); if one ever " +
    "does, it must pass an explicit path or a tmp cwd",
  "apps/cli/src/subcommands/rotate.ts|apps":
    "discoverIdentityFile() walks up from process.cwd() looking for motebit.md — interactive " +
    "CLI discovery reached only through handleRotate(), which no test calls",
};

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
}

export interface GateResult {
  violations: Violation[];
  stats: GateStats;
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

// ── The gate ─────────────────────────────────────────────────────────────

export function runGate(root: string): GateResult {
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
    for (const e of IMPLICIT_ENV)
      if (!(cfg.env ?? []).includes(e) && !(rootCfg.globalEnv ?? []).includes(e))
        cfgViolation(`task "${t}" must hash "${e}" in env (changes outcomes with no code read)`);
    if (cfg.passThroughEnv?.length)
      cfgViolation(`task "${t}" declares passThroughEnv — declare outcome-changing vars in env`);
  }
  if (!(rootTasks["test:coverage"]?.outputs ?? []).includes("coverage/**"))
    cfgViolation(`task "test:coverage" must declare outputs ["coverage/**"] (CI uploads it)`);

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
          TURBO_BUILTIN_PASSTHROUGH.has(e.name) ||
          TEST_TASKS.some((t) => (taskCfg(t).passThroughEnv ?? []).includes(e.name)) ||
          (rootCfg.globalPassThroughEnv ?? []).includes(e.name);
        if (hashed) stats.envHashed++;
        else if (!passes) stats.envStripped++;
        else if (PLUMBING_ENV[e.name] !== undefined) stats.envPlumbing++;
        else
          violations.push({
            pkg: pkg.name,
            site: site(f, e.line),
            kind: "env",
            detail:
              `reads process.env.${e.name}, which reaches the test task UNHASHED — add "${e.name}" ` +
              `to env of both test tasks (${rel(pkg.dir)}/turbo.json), or to PLUMBING_ENV in ` +
              `scripts/check-turbo-test-inputs.ts if its value cannot change an outcome`,
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
  return { violations, stats };
}

function main(): void {
  const argRoot = process.argv.indexOf("--root");
  const here = dirname(fileURLToPath(import.meta.url));
  const root = argRoot > -1 ? resolve(process.argv[argRoot + 1]!) : resolve(here, "..");
  const { violations, stats: s } = runGate(root);
  const aperture =
    `${s.packages} package(s) with test tasks, ${s.files} test-time code file(s) scanned ` +
    `(the import/path closure of ${s.filesSeen} package code files); ` +
    `${s.outOfPackageRefs} out-of-package reference(s) — ${s.coveredByDeps} via workspace deps, ` +
    `${s.coveredByInputs} via declared inputs, ${s.coveredByGlobal} via globalDependencies, ` +
    `${s.coveredByLockfile} via the lockfile, ${s.reviewed} reviewed non-input(s); ${s.envReads} process.env read(s) — ` +
    `${s.envHashed} hashed, ${s.envStripped} stripped by strict env mode, ${s.envPlumbing} reviewed plumbing; ` +
    `${s.uncached} package(s) explicitly uncached`;
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
      doctrine: "docs/ops/RUNBOOK.md § Turbo remote cache",
    }),
  );
  process.stderr.write(`  Aperture: ${aperture}\n\n`);
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
