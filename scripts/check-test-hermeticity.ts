/**
 * Test hermeticity gate (invariant #167) — L1 of the test-cache law.
 *
 * THE LAW: a package's `test` / `test:coverage` result is CACHED ONLY IF THE
 * PACKAGE IS PROVEN HERMETIC. The root turbo.json sets `cache: false` on both
 * test tasks; a package opts in with its own turbo.json (`"cache": true` on
 * both), and this gate allows the opt-in only when its static scan finds no
 * input a task hash cannot carry. Everything else stays uncached — the cost is
 * a smaller cached set, never a replayed green over a test that now fails.
 *
 * Two independent layers prove a cached package hermetic; both are required:
 *
 *   L1 (this gate) — a static lint over the package's test files, its vitest
 *      config (and the setup files it names), its non-test `src/`, and the
 *      non-test `src/` of its whole workspace-dependency closure, following
 *      relative imports. It forbids every SHAPE of input that no hash carries:
 *
 *        spawn          child_process / execa / cross-spawn / node-pty imports
 *        worker         worker_threads / cluster / tinypool / piscina imports,
 *                       `new Worker(…)`, `?worker` imports
 *        global-setup   vitest `globalSetup` / `provide` in the config
 *        config-io      fs / os / env / cwd use while the vitest config evaluates
 *        glob           `import.meta.glob` (its match set is not a hashed file)
 *        asset-outside  a `?raw` / `?url` / `?inline` import resolving outside the package
 *        escape         a relative path (import, `../..` literal, cwd-relative
 *                       literal) that resolves outside the package
 *        absolute-path  a filesystem-absolute literal (/tmp, /opt, /etc, C:\…)
 *        tmpdir-fixed   a path under `tmpdir()` that is not an `mkdtemp` prefix
 *        env-whole      `process.env` used other than `process.env.NAME` /
 *                       `process.env["NAME"]` (spread, Object.keys/entries/
 *                       assign, getOwnPropertyDescriptor, `in`, a computed
 *                       key, rest destructuring, passing or aliasing the env)
 *
 *      A finding is allowed ONLY by a reviewed exemption in the package that
 *      OWNS the site: `<package>/test-hermeticity.json`, one entry per site
 *      naming the file, the rule, the exact source text, and why it is
 *      hermetic. An exemption that matches no finding fails the gate.
 *
 *   L2 — the runtime input tracer (scripts/test-support/input-tracer.ts)
 *      stays as defence in depth over the cached set: it fails any spawn,
 *      Worker, env enumeration, gitignored / foreign-tmp / system-path read,
 *      globalSetup, config-time read, or `import.meta.glob` it observes there.
 *
 * The gate fails when turbo config and the proof disagree in EITHER direction:
 * a cached package that L1 does not prove hermetic (or that bypasses the
 * tracer, or is listed in UNCACHED), and a proven package that is not opted in
 * (the cached set is exactly the proven set, so the report below is the truth).
 *
 * Doctrine: docs/ops/RUNBOOK.md § "Test results are cached too".
 *
 * ## Usage
 *
 *   tsx scripts/check-test-hermeticity.ts                 # exit 1 on any violation
 *   tsx scripts/check-test-hermeticity.ts --list          # + per-package verdicts
 *   tsx scripts/check-test-hermeticity.ts --root DIR --verdict <pkg-name>
 *                                                         # exit 0 iff L1 proves it
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

import { Evaluator, feedsLargerPath, resolveModule, UNCACHED } from "./check-turbo-test-inputs.js";
import { formatRepair } from "./lib/gate-report.js";
import {
  absGlob,
  covers,
  readJsonc,
  TEST_TASKS,
  workspaceDirs,
  type TurboCfg,
} from "./test-support/input-surface.js";

// ── Vocabulary ───────────────────────────────────────────────────────────

export const RULES = {
  spawn: "spawns a process — its reads, its env and the binary it runs are outside every hash",
  worker: "starts a worker thread — its reads and env are outside every hash",
  "global-setup":
    "vitest globalSetup / provide — runs in the main process, where no tracer sees what it reads",
  "config-io":
    "reads the filesystem / env / cwd while the vitest config evaluates — outside every tracer",
  glob: "import.meta.glob — the set of files it matches is not a hashed file",
  "asset-outside": "a ?raw / ?url / ?inline import of a file outside the package",
  escape: "a relative path that resolves outside the package — outside $TURBO_DEFAULT$",
  "absolute-path":
    "a filesystem-absolute path (a system root, or any absolute file-shaped literal) — machine state no hash carries",
  "tmpdir-fixed": "a fixed path under tmpdir() the test did not mkdtemp — machine state",
  "env-whole":
    "process.env used as a whole (spread / enumerated / probed / aliased / computed key) — an unhashed pass-through var can flow in unseen",
} as const;
export type Rule = keyof typeof RULES;

export interface Finding {
  /** Directory of the package that OWNS the site (where its exemption lives). */
  owner: string;
  /** Path relative to `owner`, `/`-separated. */
  file: string;
  line: number;
  rule: Rule;
  /** The flagged source text, whitespace-collapsed — the site's identity. */
  text: string;
}

export interface Exemption {
  file: string;
  rule: Rule;
  /** The exact site text(s) in that file — several when one reason covers each. */
  text: string | string[];
  why: string;
}

export const EXEMPTION_FILE = "test-hermeticity.json";

const CODE_EXT = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|jsx)$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "coverage",
  ".turbo",
  ".next",
  "target",
  "build",
  "out",
  ".expo",
  "src-tauri",
  "ios",
  "android",
]);
const CONFIG_FILE = /^(?:vitest|vite)\.config\.[cm]?[jt]s$/;

const SPAWN_MODULES = new Set([
  "child_process",
  "node:child_process",
  "execa",
  "cross-spawn",
  "node-pty",
  "@lydell/node-pty",
  "shelljs",
]);
const WORKER_MODULES = new Set([
  "worker_threads",
  "node:worker_threads",
  "cluster",
  "node:cluster",
  "tinypool",
  "piscina",
]);
const CONFIG_IO_MODULES = new Set([
  "fs",
  "node:fs",
  "fs/promises",
  "node:fs/promises",
  "os",
  "node:os",
  "dotenv",
  "dotenv/config",
]);
const PROCESS_MODULES = new Set(["process", "node:process"]);
const ABSOLUTE =
  /^(?:\/(?:tmp|etc|opt|usr|var|home|root|proc|sys|dev|bin|sbin|lib|lib64|mnt|srv|run|nix|Users|Library|Applications|private|System|Volumes)(?:\/|$)|[A-Za-z]:[\\/])/;
/** Any other absolute literal shaped like a FILE (a path ending in an extension). */
const ABSOLUTE_FILE = /^\/[^/\s?#:]+(?:\/[^/\s?#:]+)*\.[A-Za-z0-9]{1,6}$/;
const HARMLESS_ABSOLUTE = new Set(["/dev/null"]);
/** RFC 8615 URL paths: an HTTP route, never a filesystem root. */
const URL_PATH = /^\/\.well-known\//;
const MKDTEMP = new Set(["mkdtemp", "mkdtempSync", "mkdtempDisposableSync", "mkdtempDisposable"]);

// ── Source scan ──────────────────────────────────────────────────────────

const rel = (from: string, p: string): string => relative(from, p).split(sep).join("/");
const insideDir = (child: string, dir: string): boolean =>
  child === dir || child.startsWith(dir.endsWith(sep) ? dir : dir + sep);
const squash = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 240);

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

function calleeName(expr: ts.Expression): string | null {
  const e = strip(expr);
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

/** `process.env`, `globalThis.process.env`, `process["env"]`, `import.meta.env`. */
function isEnvObject(n: ts.Node): boolean {
  const isProcess = (e: ts.Expression): boolean => {
    const x = strip(e);
    if (ts.isIdentifier(x)) return x.text === "process";
    return (
      ts.isPropertyAccessExpression(x) &&
      x.name.text === "process" &&
      ts.isIdentifier(x.expression) &&
      ["globalThis", "global", "window", "self"].includes(x.expression.text)
    );
  };
  if (ts.isPropertyAccessExpression(n) && n.name.text === "env") {
    if (ts.isMetaProperty(n.expression)) return true; // import.meta.env
    return isProcess(n.expression);
  }
  if (
    ts.isElementAccessExpression(n) &&
    ts.isStringLiteralLike(n.argumentExpression) &&
    n.argumentExpression.text === "env"
  )
    return isProcess(n.expression);
  return false;
}

/** Is this use of the env object a named read/write of one literal key? */
function envUseIsNamed(env: ts.Node): boolean {
  let p = env.parent;
  let child: ts.Node = env;
  while (
    p &&
    (ts.isParenthesizedExpression(p) || ts.isNonNullExpression(p) || ts.isAsExpression(p))
  ) {
    child = p;
    p = p.parent;
  }
  if (!p) return false;
  if (ts.isPropertyAccessExpression(p) && p.expression === child) return true;
  if (ts.isElementAccessExpression(p) && p.expression === child)
    return ts.isStringLiteralLike(p.argumentExpression);
  if (ts.isVariableDeclaration(p) && p.initializer === child && ts.isObjectBindingPattern(p.name))
    return p.name.elements.every(
      (e) =>
        !e.dotDotDotToken &&
        (e.propertyName === undefined
          ? ts.isIdentifier(e.name)
          : ts.isIdentifier(e.propertyName) || ts.isStringLiteralLike(e.propertyName)),
    );
  return false;
}

function moduleSpecifierOf(n: ts.Node): ts.StringLiteralLike | null {
  if (ts.isImportDeclaration(n)) {
    if (n.importClause?.isTypeOnly) return null;
    return ts.isStringLiteralLike(n.moduleSpecifier) ? n.moduleSpecifier : null;
  }
  if (ts.isExportDeclaration(n)) {
    if (n.isTypeOnly || !n.moduleSpecifier) return null;
    return ts.isStringLiteralLike(n.moduleSpecifier) ? n.moduleSpecifier : null;
  }
  if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) {
    const e = n.moduleReference.expression;
    return ts.isStringLiteralLike(e) ? e : null;
  }
  if (ts.isCallExpression(n) && n.arguments.length > 0) {
    const a = n.arguments[0]!;
    const isImport = n.expression.kind === ts.SyntaxKind.ImportKeyword;
    const name = calleeName(n.expression);
    if ((isImport || name === "require") && ts.isStringLiteralLike(a)) return a;
  }
  return null;
}

/** Does a path-literal contain a `..` segment? */
const HAS_UP = /(?:^|[/\\])\.\.(?:[/\\]|$)/;
/** Two consecutive `..` hops — the `../..` shape. */
const DOUBLE_UP = /(?:^|[/\\])\.\.[/\\]\.\.(?:[/\\]|$)/;

export interface ScanOpts {
  /** The package the file belongs to (for `escape`). */
  pkgDir: string;
  /** The file is a vitest/vite config (config-io, global-setup apply). */
  config: boolean;
  /**
   * Is this out-of-package file in EVERY test task's hash (turbo.json
   * `globalDependencies` — vitest.shared.ts, tsconfig.base.json)? Only a
   * module import of such a file is allowed; a package's own `inputs` are not
   * structural proof and need a reviewed exemption.
   */
  globallyHashed: (abs: string) => boolean;
}

export interface FileScanResult {
  findings: Omit<Finding, "owner" | "file">[];
  /** In-package relative imports and config-named files to follow. */
  follow: string[];
}

export function scanSource(file: string, opts: ScanOpts): FileScanResult {
  const src = readFileSync(file, "utf-8");
  const kind = /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind);
  const ev = new Evaluator(file, opts.pkgDir, sf);
  const findings: FileScanResult["findings"] = [];
  const follow: string[] = [];
  const fileDir = dirname(file);
  const lineOf = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
  const flag = (n: ts.Node, rule: Rule, text?: string): void => {
    findings.push({ line: lineOf(n), rule, text: squash(text ?? n.getText(sf)) });
  };
  const outside = (p: string): boolean => !insideDir(resolve(p), opts.pkgDir);

  // Bindings of `tmpdir()` (`const tmp = os.tmpdir()`), treated like the call.
  const tmpBindings = new Set<string>();
  const isTmpdirCall = (n: ts.Node): boolean =>
    ts.isCallExpression(n) && calleeName(n.expression) === "tmpdir" && n.arguments.length === 0;
  const collectTmp = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      isTmpdirCall(strip(n.initializer))
    )
      tmpBindings.add(n.name.text);
    ts.forEachChild(n, collectTmp);
  };
  collectTmp(sf);

  const visit = (n: ts.Node): void => {
    // Modules.
    const spec = moduleSpecifierOf(n);
    if (spec) {
      const [bare, query = ""] = spec.text.split("?");
      if (SPAWN_MODULES.has(bare!)) flag(n, "spawn");
      if (WORKER_MODULES.has(bare!) || /(?:^|&)(?:worker|sharedworker)(?:&|$)/.test(query))
        flag(n, "worker");
      if (opts.config && CONFIG_IO_MODULES.has(bare!)) flag(n, "config-io");
      if (PROCESS_MODULES.has(bare!) && ts.isImportDeclaration(n)) {
        const named = n.importClause?.namedBindings;
        if (
          named &&
          ts.isNamedImports(named) &&
          named.elements.some((e) => (e.propertyName ?? e.name).text === "env")
        )
          flag(n, "env-whole");
        if (opts.config) flag(n, "config-io");
      }
      if (bare!.startsWith(".")) {
        const target = resolveModule(resolve(fileDir, bare!));
        if (outside(target)) {
          // A globalDependency (vitest.shared.ts) is in every hash, and its
          // own imports are the test-cache machinery, not package inputs.
          if (!opts.globallyHashed(target)) flag(n, query ? "asset-outside" : "escape");
        } else if (CODE_EXT.test(target) && !target.endsWith(".d.ts") && existsSync(target))
          follow.push(target);
      } else if (bare!.startsWith("/") && ABSOLUTE.test(bare!)) flag(n, "absolute-path");
    }
    // new Worker(…) / new SharedWorker(…)
    if (ts.isNewExpression(n)) {
      const name = calleeName(n.expression);
      if (name === "Worker" || name === "SharedWorker") flag(n, "worker");
    }
    // import.meta.glob / globEager
    if (
      ts.isPropertyAccessExpression(n) &&
      ts.isMetaProperty(n.expression) &&
      /^glob/.test(n.name.text)
    )
      flag(n.parent && ts.isCallExpression(n.parent) ? n.parent : n, "glob");
    // process.env as a whole
    if (isEnvObject(n)) {
      if (opts.config) flag(n.parent ?? n, "config-io");
      else if (!envUseIsNamed(n)) flag(n.parent ?? n, "env-whole");
    }
    // Config-time IO: cwd, loadEnv, sync fs calls
    if (opts.config && ts.isCallExpression(n)) {
      const name = calleeName(n.expression);
      if (
        name === "cwd" ||
        name === "loadEnv" ||
        name === "homedir" ||
        name === "tmpdir" ||
        (name !== null &&
          /^(?:read|stat|lstat|exists|access|open|realpath|readdir|opendir)(?:File)?(?:Sync)?$/.test(
            name,
          ))
      )
        flag(n, "config-io");
    }
    // globalSetup / provide in config
    if (
      opts.config &&
      (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) &&
      ts.isIdentifier(n.name) &&
      (n.name.text === "globalSetup" || n.name.text === "provide")
    )
      flag(n, "global-setup");
    // Config-named setup files (setupFiles: ["./x.ts"]) are followed.
    if (
      opts.config &&
      ts.isStringLiteralLike(n) &&
      /^\.\.?\//.test(n.text) &&
      CODE_EXT.test(n.text)
    ) {
      const t = resolve(opts.pkgDir, n.text);
      if (!outside(t) && existsSync(t)) follow.push(t);
    }
    // Absolute filesystem literals.
    if (
      (ts.isStringLiteralLike(n) || ts.isTemplateHead(n)) &&
      (ABSOLUTE.test(n.text) || (ABSOLUTE_FILE.test(n.text) && !URL_PATH.test(n.text))) &&
      !HARMLESS_ABSOLUTE.has(n.text) &&
      !isSpecifierPosition(n)
    )
      flag(n, "absolute-path");
    // tmpdir(): only as the prefix of an mkdtemp.
    if (isTmpdirCall(n) || (ts.isIdentifier(n) && tmpBindings.has(n.text) && isValueUse(n))) {
      if (!(ts.isIdentifier(n) && ts.isVariableDeclaration(n.parent) && n.parent.name === n)) {
        let top: ts.Node = n;
        while (top.parent && feedsLargerPath(top) && !ts.isVariableDeclaration(top.parent))
          top = top.parent;
        if (ts.isTemplateSpan(top)) top = top.parent;
        const p = top.parent;
        const isMkdtempArg =
          p &&
          ts.isCallExpression(p) &&
          p.arguments[0] === top &&
          MKDTEMP.has(calleeName(p.expression) ?? "");
        const composite = top !== n;
        // A bare tmpdir() is a location (compared, printed, bound); a path
        // BUILT on it names a fixed file unless mkdtemp makes it unique.
        if (composite && !isMkdtempArg) flag(top, "tmpdir-fixed");
      }
    }
    // Relative path literals escaping the package (module specifiers are
    // resolved as modules above; type-only and mock specifiers load nothing).
    if (ts.isStringLiteralLike(n) && HAS_UP.test(n.text) && !isSpecifierPosition(n)) {
      checkEscape(n, n.text);
    }
    if (
      (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) &&
      /(?:^|[/\\])\.\.(?:[/\\]|$)/.test(n.text)
    ) {
      checkEscape(n, n.text);
    }
    ts.forEachChild(n, visit);
  };

  const checkEscape = (lit: ts.Node, text: string): void => {
    // The largest path expression this literal feeds (a template part starts
    // at its template).
    let top: ts.Node = lit;
    if (ts.isTemplateHead(lit) || ts.isTemplateMiddle(lit) || ts.isTemplateTail(lit)) {
      top = ts.isTemplateSpan(lit.parent) ? lit.parent.parent : lit.parent;
    }
    while (top.parent && feedsLargerPath(top) && !ts.isVariableDeclaration(top.parent))
      top = top.parent;
    if (ts.isTemplateSpan(top)) top = top.parent;
    const v = top !== lit ? ev.eval(top as ts.Expression) : null;
    if (v && v.k !== "str") {
      if (outside(v.value)) flag(top, "escape");
      return;
    }
    // Unevaluable (or a bare literal). vitest runs in the package dir, so a
    // bare relative literal — or a join/resolve whose FIRST argument is one —
    // is cwd-relative; anything else is resolved against the file's directory,
    // and `../..` anywhere in the expression is refused unless proven in.
    if (top === lit) {
      if (!isPathPosition(lit)) return; // compared / matched, never opened
      if (outside(resolve(opts.pkgDir, text)) || outside(resolve(fileDir, text)))
        flag(top, "escape");
      return;
    }
    const lits = literalTexts(top);
    const joined = lits.join("/");
    const call = ts.isCallExpression(top) ? top : null;
    const cwdRelative =
      call !== null &&
      ["join", "resolve"].includes(calleeName(call.expression) ?? "") &&
      call.arguments.length > 0 &&
      ts.isStringLiteralLike(strip(call.arguments[0]!));
    if (
      DOUBLE_UP.test(joined.replace(/\/+/g, "/")) ||
      outside(resolve(fileDir, joined.replace(/^\/+/, ""))) ||
      (cwdRelative && outside(resolve(opts.pkgDir, joined)))
    )
      flag(top, "escape");
  };

  visit(sf);
  return { findings, follow };
}

/** Every literal text (string literals, template parts) inside an expression, in order. */
function literalTexts(n: ts.Node): string[] {
  const out: string[] = [];
  const walk = (x: ts.Node): void => {
    if (ts.isStringLiteralLike(x)) out.push(x.text);
    else if (ts.isTemplateHead(x) || ts.isTemplateMiddle(x) || ts.isTemplateTail(x))
      out.push(x.text);
    ts.forEachChild(x, walk);
  };
  walk(n);
  return out;
}

/** String methods and comparisons: a literal there is a value compared, never a path opened. */
const STRING_OPS = new Set([
  "includes",
  "startsWith",
  "endsWith",
  "indexOf",
  "lastIndexOf",
  "split",
  "replace",
  "replaceAll",
  "match",
  "matchAll",
  "search",
  "test",
  "toBe",
  "toEqual",
  "toContain",
  "toMatch",
  "toStrictEqual",
  "has",
]);

/** Could a bare string literal here flow to the filesystem as a path? */
function isPathPosition(lit: ts.Node): boolean {
  const p = lit.parent;
  if (!p) return false;
  if (ts.isBinaryExpression(p)) {
    const op = p.operatorToken.kind;
    return !(
      op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsToken
    );
  }
  if (ts.isCaseClause(p)) return false;
  if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
    const name = calleeName(p.expression);
    return !(name && STRING_OPS.has(name));
  }
  return true;
}

/** A literal in module-specifier position (imports, exports, require, vi.mock, import types). */
function isSpecifierPosition(lit: ts.Node): boolean {
  const p = lit.parent;
  if (!p) return false;
  if ((ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) && p.moduleSpecifier === lit)
    return true;
  if (ts.isExternalModuleReference(p)) return true;
  if (ts.isLiteralTypeNode(p) && p.parent && ts.isImportTypeNode(p.parent)) return true;
  if (ts.isCallExpression(p) && p.arguments[0] === lit) {
    if (p.expression.kind === ts.SyntaxKind.ImportKeyword) return true;
    const name = calleeName(p.expression);
    return (
      name !== null &&
      [
        "require",
        "mock",
        "doMock",
        "unmock",
        "doUnmock",
        "importActual",
        "importMock",
        "resolve",
      ].includes(name) &&
      (name !== "resolve" ||
        (ts.isPropertyAccessExpression(p.expression) &&
          calleeName(p.expression.expression) === "require"))
    );
  }
  return false;
}

function isValueUse(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if (ts.isPropertyAssignment(p) && p.name === id) return false;
  if (ts.isImportSpecifier(p) || ts.isImportClause(p)) return false;
  return true;
}

// ── Packages and their scan sets ─────────────────────────────────────────

export interface PkgInfo {
  name: string;
  dir: string;
  hasTest: boolean;
  workspaceDeps: string[];
}

export function readPackages(root: string): Map<string, PkgInfo> {
  const out = new Map<string, PkgInfo>();
  for (const d of workspaceDirs(root)) {
    const dir = join(root, d);
    const pj = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as {
      name: string;
      scripts?: Record<string, string>;
    } & Record<string, Record<string, string> | undefined>;
    const deps = new Set<string>();
    for (const k of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"])
      for (const [n, v] of Object.entries(pj[k] ?? {}))
        if (typeof v === "string" && v.startsWith("workspace:")) deps.add(n);
    out.set(pj.name, {
      name: pj.name,
      dir,
      hasTest: TEST_TASKS.some((t) => pj.scripts?.[t]),
      workspaceDeps: [...deps],
    });
  }
  return out;
}

function walk(dir: string, acc: string[], pred: (f: string) => boolean): string[] {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir)) {
    if (SKIP_DIRS.has(e) || e.startsWith(".")) continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc, pred);
    else if (CODE_EXT.test(e) && !e.endsWith(".d.ts") && pred(p)) acc.push(p);
  }
  return acc;
}

const isTestish = (p: string): boolean =>
  TEST_FILE.test(p) || p.split(sep).includes("__tests__") || p.split(sep).includes("__mocks__");

/** The package's own scan roots: config(s), every test file, and non-test src. */
function ownRoots(dir: string): { configs: string[]; files: string[] } {
  const configs = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => CONFIG_FILE.test(f))
        .map((f) => join(dir, f))
    : [];
  const files = [
    ...walk(dir, [], (p) => isTestish(p)),
    ...walk(join(dir, "src"), [], (p) => !isTestish(p)),
  ];
  return { configs, files };
}

/** A dependency's scan roots: its non-test src only. */
function depRoots(dir: string): string[] {
  return walk(join(dir, "src"), [], (p) => !isTestish(p));
}

// ── Analysis ─────────────────────────────────────────────────────────────

export interface PkgVerdict {
  name: string;
  dir: string;
  /** L1 proves it: no unexempted finding in its own scan set or its dep closure. */
  hermetic: boolean;
  /** Unexempted findings (own + closure). */
  blocking: Finding[];
  adoptsTracer: boolean;
  listedUncached: boolean;
  /** Effective turbo config: both test tasks cached. */
  cached: boolean;
  /** One task cached, the other not. */
  mixed: boolean;
  files: number;
}

export interface Analysis {
  verdicts: PkgVerdict[];
  staleExemptions: { owner: string; ex: Exemption; problem: string }[];
  filesScanned: number;
  rootDefaultUncached: boolean;
}

function loadExemptions(dir: string): { list: Exemption[]; problems: string[] } {
  const f = join(dir, EXEMPTION_FILE);
  if (!existsSync(f)) return { list: [], problems: [] };
  const raw = JSON.parse(readFileSync(f, "utf-8")) as { exemptions?: Exemption[] };
  const problems: string[] = [];
  const list = raw.exemptions ?? [];
  for (const e of list) {
    if (!e.file || !e.rule || !e.text || (Array.isArray(e.text) && e.text.length === 0))
      problems.push(`entry ${JSON.stringify(e)} lacks file/rule/text`);
    if (!(e.rule in RULES)) problems.push(`unknown rule "${e.rule}"`);
    if (!e.why || e.why.trim().length < 20)
      problems.push(`${e.file} [${e.rule}] has no reviewed reason ("why", ≥ 20 chars)`);
  }
  return { list, problems };
}

export function analyze(root: string, only?: string): Analysis {
  const pkgs = readPackages(root);
  const byDir = new Map([...pkgs.values()].map((p) => [p.dir, p]));
  const scanned = new Map<string, Finding[]>();
  const ownerOf = (file: string): PkgInfo | undefined => {
    let d = dirname(file);
    while (d.length >= root.length) {
      const p = byDir.get(d);
      if (p) return p;
      d = dirname(d);
    }
    return undefined;
  };
  const rootCfg = readJsonc<TurboCfg>(join(root, "turbo.json"));
  const globalGlobs = (rootCfg.globalDependencies ?? []).map((g) => absGlob(root, root, g));
  const globallyHashed = (abs: string): boolean => covers(globalGlobs, abs);
  const follows = new Map<string, string[]>();
  /** Scan a set of roots with their in-package relative closure. */
  const scanSet = (roots: string[], pkgDir: string, configs: string[] = []): Set<string> => {
    const seen = new Set<string>();
    const queue: [string, boolean][] = [
      ...configs.map((c) => [c, true] as [string, boolean]),
      ...roots.map((r) => [r, false] as [string, boolean]),
    ];
    while (queue.length) {
      const [f, config] = queue.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      if (!scanned.has(f)) {
        const r = scanSource(f, { pkgDir, config, globallyHashed });
        const owner = ownerOf(f)?.dir ?? pkgDir;
        scanned.set(
          f,
          r.findings.map((x) => ({ ...x, owner, file: rel(owner, f) })),
        );
        follows.set(f, r.follow);
      }
      for (const t of follows.get(f) ?? []) if (!seen.has(t)) queue.push([t, false]);
    }
    return seen;
  };

  const exemptions = new Map<string, ReturnType<typeof loadExemptions>>();
  const exOf = (dir: string) => {
    let e = exemptions.get(dir);
    if (!e) exemptions.set(dir, (e = loadExemptions(dir)));
    return e;
  };
  const used = new Set<string>();
  const texts = (e: Exemption): string[] => (Array.isArray(e.text) ? e.text : [e.text]);
  const exKey = (owner: string, file: string, rule: string, text: string): string =>
    `${owner}|${file}|${rule}|${squash(text)}`;
  const isExempt = (f: Finding): boolean => {
    const k = exKey(f.owner, f.file, f.rule, f.text);
    const hit = exOf(f.owner).list.some((e) =>
      texts(e).some((t) => exKey(f.owner, e.file, e.rule, t) === k),
    );
    if (hit) used.add(k);
    return hit;
  };

  const depClosure = (name: string): PkgInfo[] => {
    const out = new Map<string, PkgInfo>();
    const visit = (n: string) => {
      for (const d of pkgs.get(n)?.workspaceDeps ?? []) {
        const p = pkgs.get(d);
        if (p && !out.has(d)) {
          out.set(d, p);
          visit(d);
        }
      }
    };
    visit(name);
    return [...out.values()];
  };

  const rootDefaultUncached = TEST_TASKS.every((t) => rootCfg.tasks?.[t]?.cache === false);
  const verdicts: PkgVerdict[] = [];
  const depSets = new Map<string, Set<string>>();
  for (const pkg of [...pkgs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!pkg.hasTest || (only && pkg.name !== only)) continue;
    const { configs, files } = ownRoots(pkg.dir);
    const set = scanSet(files, pkg.dir, configs);
    for (const dep of depClosure(pkg.name)) {
      let ds = depSets.get(dep.dir);
      if (!ds) depSets.set(dep.dir, (ds = scanSet(depRoots(dep.dir), dep.dir)));
      for (const f of ds) set.add(f);
    }
    const blocking = [...set].flatMap((f) => scanned.get(f) ?? []).filter((f) => !isExempt(f));
    const vcfg = configs.find((c) => /vitest\.config/.test(c));
    const adoptsTracer = !!vcfg && /\bdefineMotebitTest\s*\(/.test(readFileSync(vcfg, "utf-8"));
    const pkgTurbo = join(pkg.dir, "turbo.json");
    const pcfg = existsSync(pkgTurbo) ? readJsonc<TurboCfg>(pkgTurbo) : null;
    const on = TEST_TASKS.map(
      (t) => ({ ...rootCfg.tasks?.[t], ...pcfg?.tasks?.[t] }).cache !== false,
    );
    verdicts.push({
      name: pkg.name,
      dir: pkg.dir,
      hermetic: blocking.length === 0,
      blocking,
      adoptsTracer,
      listedUncached: UNCACHED[pkg.name] !== undefined,
      cached: on.every(Boolean),
      mixed: on.some(Boolean) && !on.every(Boolean),
      files: set.size,
    });
  }
  const staleExemptions: Analysis["staleExemptions"] = [];
  if (!only) {
    for (const [dir, { list, problems }] of exemptions) {
      for (const p of problems) staleExemptions.push({ owner: dir, ex: list[0]!, problem: p });
      for (const e of list)
        for (const t of texts(e))
          if (!used.has(exKey(dir, e.file, e.rule, t)))
            staleExemptions.push({
              owner: dir,
              ex: { ...e, text: t },
              problem: "matches no finding (the site moved or was fixed) — remove or update it",
            });
    }
    // Exemption files never loaded (their package has no scanned site at all).
    for (const p of pkgs.values())
      if (!exemptions.has(p.dir) && existsSync(join(p.dir, EXEMPTION_FILE)))
        for (const e of loadExemptions(p.dir).list)
          staleExemptions.push({ owner: p.dir, ex: e, problem: "matches no finding — remove it" });
  }
  return { verdicts, staleExemptions, filesScanned: scanned.size, rootDefaultUncached };
}

// ── Gate ─────────────────────────────────────────────────────────────────

export function summarize(v: PkgVerdict): string {
  if (!v.adoptsTracer) return "vitest config bypasses defineMotebitTest (no L2 tracer)";
  if (v.listedUncached) return `UNCACHED: ${UNCACHED[v.name]!.slice(0, 90)}…`;
  if (!v.hermetic) {
    const byRule = new Map<string, number>();
    for (const f of v.blocking) byRule.set(f.rule, (byRule.get(f.rule) ?? 0) + 1);
    const first = v.blocking[0]!;
    return (
      [...byRule].map(([r, n]) => `${r}×${n}`).join(", ") +
      ` — e.g. ${first.owner.replace(/^.*?\/(packages|apps|services)\//, "$1/")}/${first.file}:${first.line}`
    );
  }
  return "proven hermetic";
}

function main(): void {
  const args = process.argv.slice(2);
  const rootArg = args.indexOf("--root");
  const root =
    rootArg >= 0
      ? resolve(args[rootArg + 1]!)
      : resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const vArg = args.indexOf("--verdict");
  if (vArg >= 0) {
    const name = args[vArg + 1]!;
    const a = analyze(root, name);
    const v = a.verdicts.find((x) => x.name === name);
    if (!v) {
      console.log(`${name}: no such package with a test script`);
      process.exit(2);
    }
    for (const f of v.blocking)
      console.log(`  [${f.rule}] ${rel(root, join(f.owner, f.file))}:${f.line} ${f.text}`);
    const ok = v.hermetic && v.adoptsTracer;
    console.log(
      `${name}: ${ok ? "PROVEN hermetic" : "NOT proven"} (${v.files} file(s) scanned) — ${summarize(v)}`,
    );
    process.exit(ok ? 0 : 1);
  }

  const t0 = Date.now();
  const a = analyze(root);
  const problems: string[] = [];
  if (!a.rootDefaultUncached)
    problems.push(
      `turbo.json — root "test" / "test:coverage" must set "cache": false (the default is UNCACHED; a package opts in only once proven hermetic)`,
    );
  for (const v of a.verdicts) {
    const site = `${rel(root, v.dir)}/turbo.json`;
    const proven = v.hermetic && v.adoptsTracer && !v.listedUncached;
    if (v.mixed)
      problems.push(
        `${site} — ${v.name} caches one test task but not the other; set "cache" identically on both`,
      );
    if (v.cached && !proven) {
      problems.push(
        `${site} — ${v.name} is CACHED but not proven hermetic: ${summarize(v)}. ` +
          `Remove "cache": true from both test tasks, or remove the site(s):\n` +
          v.blocking
            .slice(0, 12)
            .map(
              (f) =>
                `      [${f.rule}] ${rel(root, join(f.owner, f.file))}:${f.line}  ${f.text}  — ${RULES[f.rule]}`,
            )
            .join("\n") +
          (v.blocking.length > 12 ? `\n      … ${v.blocking.length - 12} more` : ""),
      );
    }
    if (!v.cached && !v.mixed && proven)
      problems.push(
        `${site} — ${v.name} is PROVEN hermetic but not cached; add { "extends": ["//"], "tasks": { "test": { "cache": true }, "test:coverage": { "cache": true } } } (the cached set is exactly the proven set)`,
      );
  }
  for (const s of a.staleExemptions)
    problems.push(
      `${rel(root, join(s.owner, EXEMPTION_FILE))} — ${s.ex ? `${s.ex.file} [${s.ex.rule}] "${s.ex.text}"` : ""}: ${s.problem}`,
    );

  const cached = a.verdicts.filter((v) => v.cached);
  const uncached = a.verdicts.filter((v) => !v.cached);
  const aperture =
    `${a.verdicts.length} package(s) scanned, ${a.filesScanned} file(s) (tests, configs, src, and the ` +
    `workspace-dependency closure); ${cached.length} cached, ${uncached.length} uncached`;
  if (args.includes("--list") || problems.length === 0) {
    for (const v of a.verdicts)
      console.log(`  ${v.cached ? "CACHED  " : "uncached"}  ${v.name.padEnd(36)} ${summarize(v)}`);
  }
  if (problems.length === 0) {
    console.log(`✓ check-test-hermeticity: ${aperture} (${Date.now() - t0}ms)`);
    return;
  }
  process.stderr.write(
    formatRepair({
      invariant: `${problems.length} test-cache hermeticity violation(s) — a cached result must be proven hermetic (L1) or the task must stay uncached`,
      sites: problems,
      canonical:
        "scripts/check-test-hermeticity.ts (the rules), <package>/turbo.json (the opt-in), <package>/test-hermeticity.json (reviewed exemptions)",
      fix: 'remove "cache": true from the package turbo.json (default uncached), or make the site hermetic, or — only when the site truly cannot change an outcome — add a reviewed exemption { "file", "rule", "text", "why" } to test-hermeticity.json in the package that owns the site',
      doctrine: 'docs/ops/RUNBOOK.md § "Test results are cached too"',
    }),
  );
  process.stderr.write(`  Aperture: ${aperture}\n\n`);
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
