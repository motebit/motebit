/**
 * check-fixture-git-env — no git child process started from `scripts/` can
 * act on a repository named by an inherited `GIT_*` environment.
 *
 * Why: a git hook exports GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE (from a
 * linked worktree, a GIT_DIR into the SHARED repository) to every process it
 * spawns, and git honours them over `cwd`. A fixture's `git init` under a
 * pre-push hook wrote `core.worktree=<fixture>` into the real `.git/config`
 * and a fixture `git commit` landed on a real branch (#835; again 2026-10-01
 * and 2026-10-02). Three review rounds then found spawn SHAPES a pattern-
 * matching gate counted as "repo root" while a fixture commit landed in the
 * real repository (R3: `const opts = { cwd: tmp }; spawnSync("git", […], opts)`).
 * So the defence is structural where it can be, and deny-by-default where it
 * cannot:
 *
 * 1. STRUCTURAL — the gate self-tests (`pnpm test:gates`, every vitest run
 *    from the repo root). `scripts/lib/vitest-scrub-git-env.ts` deletes every
 *    scrubbed variable from the worker's `process.env` before any test module
 *    loads, so every child inherits a clean env WHATEVER ITS SYNTAX. This gate
 *    holds the wiring, not the spawns: the setup file is the only `setupFiles`
 *    entry point the `test:gates` command reaches (no `--config`, no shadowing
 *    root config, listed in `vitest.config.mts`), its body is exactly the
 *    import + application of `scrubGitEnvInPlace` from
 *    `scripts/lib/differential-tree.ts` (the canonical `isScrubbedGitEnvKey`
 *    rule `cleanEnv` reads — imported, never copied), and EXECUTING it on a
 *    probe environment leaves exactly what `cleanEnv` leaves.
 *    The execution proof per pool is scripts/__tests__/git-env-structural.test.ts.
 *
 * 2. STATIC, DENY-BY-DEFAULT — every other TS/JS file under `scripts/`
 *    (scripts run by `tsx` / `node`, libraries, `*.harness.ts`, hooks' helpers;
 *    vitest never wraps them). Parsed with the TypeScript compiler and its
 *    binder (identifiers resolved to their declarations, not matched by text):
 *      - a child_process spawn (`spawnSync|spawn|execFileSync|execFile|
 *        execSync|exec`, bound to a `child_process` import — including renamed
 *        and namespace imports and `promisify(…)` aliases) whose command is
 *        `git`, OR cannot be statically resolved to a non-git command, targets
 *        the repo ONLY when its options resolve (inline, or through a `const`)
 *        to an object with `cwd: ROOT` / `REPO_ROOT` and no spread, and its
 *        arguments resolve to a list whose global options and subcommand are
 *        static, with no `-C` / `--git-dir` / `--work-tree` / `--namespace`, no
 *        `clone`, no `init <path>`. ANYTHING ELSE is a fixture and must pass
 *        `env: cleanEnv(…)` (inline, or through a `const` — or a `let` every
 *        assignment of which is `cleanEnv(…)`); an `Object.assign` / spread copy
 *        of `process.env` is not a scrub;
 *      - a generic spawn wrapper — a spawn whose command is a parameter of the
 *        enclosing function — must itself pass `env: cleanEnv(…)`, or be a
 *        non-exported, named function every reference to which is a call
 *        passing a statically non-git command. An exported wrapper, a wrapper
 *        passed as a value, or a computed command forwarded into one fails.
 *    `*.test.*` files under `scripts/__tests__/` are covered by layer 1 and are
 *    counted, not required to scrub per spawn.
 *
 * 3. SHELL — a `git clone` / `git init` / `git -C` / `--git-dir` /
 *    `--work-tree` line must follow a `fixture_git_env_scrub` call
 *    (`scripts/lib/fixture-git-env.sh`).
 *
 * `cleanEnv` is recognised by name: `scripts/lib/tamper-runner.ts` keeps an
 * inlined copy (plain `node` loads it and cannot resolve the `.ts` import);
 * every `cleanEnv` under `scripts/` removes every `GIT_*`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { isScrubbedGitEnvKey } from "./lib/differential-tree.js";
import { formatRepair } from "./lib/gate-report.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SCRIPTS = join(ROOT, "scripts");

/** The structural layer: the vitest setup file and the config `pnpm test:gates` resolves. */
export const SETUP_FILE = "scripts/lib/vitest-scrub-git-env.ts";
export const GATES_CONFIG = "vitest.config.mts";
const CANONICAL_MODULE = "./differential-tree.js";
const CANONICAL_SCRUB = "scrubGitEnvInPlace";

/**
 * Variables a hook (or a hostile caller) can set to aim git at another
 * repository or to write its config — the probe the setup file is EXECUTED
 * against. Not a scrub list: the scrub is `isScrubbedGitEnvKey`; this only
 * witnesses that the setup applies it.
 */
const REDIRECT_PROBE = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_CONFIG",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
  "GIT_CONFIG_PARAMETERS",
  "GIT_QUARANTINE_PATH",
  "GIT_EXEC_PATH",
  "GIT_SOME_FUTURE_VARIABLE",
];
/** Must survive the scrub (prefix look-alikes). */
const KEEP_PROBE = ["GITHUB_PROBE", "MOTEBIT_GIT_PROBE", "GIT"];

/** Identifiers that name the repository root in `scripts/`. */
const REPO_ROOT_IDENTS = new Set(["ROOT", "REPO_ROOT"]);
const SPAWN_NAMES = new Set(["spawnSync", "spawn", "execFileSync", "execFile", "execSync", "exec"]);
/** Spawn functions whose first argument is a shell command line, not a file. */
const SHELL_SPAWNS = new Set(["execSync", "exec"]);
const CHILD_PROCESS = new Set(["child_process", "node:child_process"]);
/** `init` options that consume the next argument (so it is not the target path). */
const INIT_VALUE_FLAGS = new Set([
  "-b",
  "--initial-branch",
  "--template",
  "--separate-git-dir",
  "--object-format",
  "--ref-format",
]);
/** `-c key=value` keys that move the work tree or pull in other config. */
const REDIRECT_CONFIG_KEY = /^(core\.worktree|include\.path|includeif\..*)$/i;
/** A `git` word in a command string (a file path ending in /git included). */
const GIT_WORD = /(^|[\s;&|(`/\\])git(\.exe)?($|[\s;&|)`])/;

export interface GitSpawn {
  line: number;
  /** `git`: the command is git or not statically non-git; `wrapper`: the command is a parameter. */
  kind: "git" | "wrapper";
  target: "repo" | "fixture";
  /** git: runs with `cleanEnv`; wrapper: scrubs itself, or every caller passes a non-git command. */
  scrubbed: boolean;
  snippet: string;
  /** Why a site is a fixture / an unsafe wrapper, for the repair text. */
  why: string;
}

/**
 * One git argument: its static text, or null when it is computed. A template
 * literal keeps its leading static text (`--work-tree=${wt}` → "--work-tree=").
 */
type Arg = { text: string | null; prefix: string };

interface Ctx {
  sf: ts.SourceFile;
  checker: ts.TypeChecker;
}

function strip(node: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node)
  )
    node = node.expression;
  return node;
}

/** The binding an identifier names — for a shorthand `{ env }`, the variable, not the property. */
function symOf(ctx: Ctx, id: ts.Identifier): ts.Symbol | undefined {
  return ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id
    ? ctx.checker.getShorthandAssignmentValueSymbol(id.parent)
    : ctx.checker.getSymbolAtLocation(id);
}

/** The declaration an identifier binds to (through import aliases left as the import). */
function declOf(ctx: Ctx, id: ts.Identifier): ts.Declaration | undefined {
  return symOf(ctx, id)?.declarations?.[0];
}

function isConst(d: ts.VariableDeclaration): boolean {
  return ts.isVariableDeclarationList(d.parent) && (d.parent.flags & ts.NodeFlags.Const) !== 0;
}

/**
 * Follow an expression through `const` bindings to the expression it denotes.
 * `{ param }` when it bottoms out at a function parameter; `null` when it
 * cannot be resolved statically (a `let`, a destructured binding, an import).
 */
type Resolved = { node: ts.Expression } | { param: ts.ParameterDeclaration } | null;
function resolveExpr(ctx: Ctx, expr: ts.Expression, depth = 0): Resolved {
  const e = strip(expr);
  if (!ts.isIdentifier(e) || depth > 8) return { node: e };
  const d = declOf(ctx, e);
  if (!d) return null;
  if (ts.isParameter(d)) return { param: d };
  if (ts.isVariableDeclaration(d) && ts.isIdentifier(d.name) && d.initializer && isConst(d)) {
    return resolveExpr(ctx, d.initializer, depth + 1);
  }
  return null;
}

/** The child_process export a callee names (`spawnSync`, …), or null when it is not a spawn. */
function spawnNameOf(ctx: Ctx, callee: ts.Expression, depth = 0): string | null {
  const c = strip(callee);
  if (depth > 4) return null;
  if (ts.isIdentifier(c)) {
    const d = declOf(ctx, c);
    // Unbound (a global or a snippet without its import): recognised by name.
    if (!d) return SPAWN_NAMES.has(c.text) ? c.text : null;
    if (ts.isImportSpecifier(d)) {
      const mod = d.parent.parent.parent.moduleSpecifier;
      const name = (d.propertyName ?? d.name).text;
      return ts.isStringLiteral(mod) && CHILD_PROCESS.has(mod.text) && SPAWN_NAMES.has(name)
        ? name
        : null;
    }
    if (ts.isBindingElement(d)) {
      // const { execSync: x } = require("child_process")
      const pattern = d.parent;
      const decl = pattern.parent;
      const name = (
        d.propertyName && ts.isIdentifier(d.propertyName) ? d.propertyName : d.name
      ) as ts.Identifier;
      return ts.isVariableDeclaration(decl) &&
        decl.initializer &&
        isChildProcessModule(decl.initializer) &&
        SPAWN_NAMES.has(name.text)
        ? name.text
        : null;
    }
    if (ts.isVariableDeclaration(d) && d.initializer) {
      const init = strip(d.initializer);
      // promisify(execFile)
      if (
        ts.isCallExpression(init) &&
        init.arguments[0] &&
        /promisify$/.test(init.expression.getText(ctx.sf))
      ) {
        return spawnNameOf(ctx, init.arguments[0], depth + 1);
      }
      if (isConst(d)) return spawnNameOf(ctx, init, depth + 1);
    }
    return null;
  }
  if (ts.isPropertyAccessExpression(c) && SPAWN_NAMES.has(c.name.text)) {
    const obj = strip(c.expression);
    if (isChildProcessModule(obj)) return c.name.text;
    if (ts.isIdentifier(obj)) {
      const d = declOf(ctx, obj);
      if (d && (ts.isNamespaceImport(d) || ts.isImportClause(d))) {
        const decl = ts.isNamespaceImport(d) ? d.parent.parent : d.parent;
        const mod = decl.moduleSpecifier;
        return ts.isStringLiteral(mod) && CHILD_PROCESS.has(mod.text) ? c.name.text : null;
      }
      if (d && ts.isImportEqualsDeclaration(d)) {
        const ref = d.moduleReference;
        return ts.isExternalModuleReference(ref) &&
          ts.isStringLiteral(ref.expression) &&
          CHILD_PROCESS.has(ref.expression.text)
          ? c.name.text
          : null;
      }
      if (
        d &&
        ts.isVariableDeclaration(d) &&
        d.initializer &&
        isChildProcessModule(strip(d.initializer))
      )
        return c.name.text;
    }
  }
  return null;
}

/** `require("child_process")` / `await import("node:child_process")`. */
function isChildProcessModule(node: ts.Expression): boolean {
  let n = strip(node);
  if (ts.isAwaitExpression(n)) n = strip(n.expression);
  if (!ts.isCallExpression(n)) return false;
  const arg = n.arguments[0];
  const isLoader =
    (ts.isIdentifier(n.expression) && n.expression.text === "require") ||
    n.expression.kind === ts.SyntaxKind.ImportKeyword;
  return isLoader && arg !== undefined && ts.isStringLiteral(arg) && CHILD_PROCESS.has(arg.text);
}

function argOf(node: ts.Expression): Arg {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { text: node.text, prefix: node.text };
  }
  if (ts.isTemplateExpression(node)) return { text: null, prefix: node.head.text };
  return { text: null, prefix: "" };
}

/** A command string's static text, `\0` marking each substitution; null when not a string. */
function staticText(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node))
    return node.head.text + node.templateSpans.map((s) => "\0" + s.literal.text).join("");
  return null;
}

/** The tokens of a shell command string (`git clone ${url} ${dir}`), substitutions as computed tokens. */
function shellArgs(raw: string): Arg[] {
  return raw
    .trim()
    .split(/\s+/)
    .map((t) =>
      t.includes("\0") ? { text: null, prefix: t.split("\0")[0]! } : { text: t, prefix: t },
    );
}

type CmdKind =
  | { kind: "git"; shell: string | null }
  | { kind: "nongit" }
  | { kind: "param"; param: ts.ParameterDeclaration }
  | { kind: "unknown" };

/** What a spawn's command argument is, as far as the source says. */
function cmdKindOf(ctx: Ctx, expr: ts.Expression | undefined): CmdKind {
  if (!expr) return { kind: "unknown" };
  const r = resolveExpr(ctx, expr);
  if (r === null) return { kind: "unknown" };
  if ("param" in r) return { kind: "param", param: r.param };
  const n = r.node;
  const text = staticText(n);
  if (text !== null) {
    if (GIT_WORD.test(text.replace(/\0/g, " \0 "))) return { kind: "git", shell: text };
    const head = text.split("\0")[0]!;
    // A computed command word, or a compound line, could run git.
    if (head.trim() === "" || (text.includes("\0") && /[;&|`]|\$\(/.test(text)))
      return { kind: "unknown" };
    return { kind: "nongit" };
  }
  if (ts.isPropertyAccessExpression(n) && n.getText(ctx.sf) === "process.execPath")
    return { kind: "nongit" };
  // new URL("./node_modules/.bin/x", import.meta.url).pathname
  if (ts.isPropertyAccessExpression(n) && n.name.text === "pathname") {
    const u = strip(n.expression);
    const lit =
      ts.isNewExpression(u) && u.expression.getText(ctx.sf) === "URL"
        ? u.arguments?.[0]
        : undefined;
    const t = lit ? staticText(strip(lit)) : null;
    if (t !== null && !t.includes("\0"))
      return basename(t).replace(/\.exe$/, "") === "git"
        ? { kind: "git", shell: null }
        : { kind: "nongit" };
  }
  if (ts.isCallExpression(n)) {
    // join(…, "turbo") / resolve(…, "bin", "x"): the last segment names the file.
    const last = n.arguments.at(-1);
    const callee = n.expression.getText(ctx.sf);
    if (last && /(^|\.)(join|resolve)$/.test(callee)) {
      const t = staticText(strip(last));
      if (t !== null && !t.includes("\0"))
        return basename(t).replace(/\.exe$/, "") === "git"
          ? { kind: "git", shell: null }
          : { kind: "nongit" };
    }
  }
  if (ts.isConditionalExpression(n)) {
    const a = cmdKindOf(ctx, n.whenTrue);
    const b = cmdKindOf(ctx, n.whenFalse);
    if (a.kind === "nongit" && b.kind === "nongit") return a;
    if (a.kind === "git" || b.kind === "git") return { kind: "git", shell: null };
  }
  return { kind: "unknown" };
}

type ArgsVerdict = "local" | "redirect" | "unresolved";

/**
 * Whether git's arguments keep it on the process's (or `cwd`'s) repository:
 * "redirect" for `-C <path>`, `--git-dir`, `--work-tree`, `--namespace`, a
 * redirecting `-c` key, `clone`, `init <path>`; "unresolved" when a global
 * option, a `-c` pair or the subcommand is computed.
 */
export function argsVerdict(args: Arg[]): ArgsVerdict {
  let sub: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (sub === null) {
      if (a.prefix === "-C" || /^--(git-dir|work-tree|namespace)(=|$)/.test(a.prefix))
        return "redirect";
      if (a.text === null) return "unresolved";
      if (a.text === "-c") {
        const kv = args[i + 1];
        const eq = kv?.prefix.indexOf("=") ?? -1;
        if (!kv || eq < 0) return "unresolved";
        if (REDIRECT_CONFIG_KEY.test(kv.prefix.slice(0, eq))) return "redirect";
        i++;
      } else if (!a.text.startsWith("-")) sub = a.text;
      continue;
    }
    if (sub === "clone") return "redirect";
    if (sub !== "init") return "local";
    if (a.text !== null && INIT_VALUE_FLAGS.has(a.text)) i++;
    else if (a.text === null || !a.text.startsWith("-")) return "redirect";
  }
  return sub === "clone" ? "redirect" : "local";
}

/** The initializer of `key` in an object literal (shorthand → its identifier), or null when absent. */
function property(obj: ts.ObjectLiteralExpression, key: string): ts.Expression | null {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && p.name.getText() === key) return p.initializer;
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === key) return p.name;
  }
  return null;
}

/**
 * True when `expr` is `cleanEnv(…)` — directly, through `const`s, or through a
 * `let` whose initializer and every assignment are `cleanEnv(…)`. A spread,
 * `Object.assign` or `process.env` is not a scrub.
 */
function isScrub(ctx: Ctx, expr: ts.Expression | null, depth = 0): boolean {
  if (!expr || depth > 8) return false;
  const e = strip(expr);
  if (ts.isCallExpression(e)) {
    return ts.isIdentifier(e.expression) && e.expression.text === "cleanEnv";
  }
  if (!ts.isIdentifier(e)) return false;
  const sym = symOf(ctx, e);
  const d = sym?.declarations?.[0];
  if (!sym || !d || !ts.isVariableDeclaration(d) || !d.initializer) return false;
  if (!isScrub(ctx, d.initializer, depth + 1)) return false;
  if (isConst(d)) return true;
  let ok = true;
  const visit = (n: ts.Node): void => {
    if (
      ts.isBinaryExpression(n) &&
      ts.isIdentifier(n.left) &&
      n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      n.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ctx.checker.getSymbolAtLocation(n.left) === sym &&
      !(n.operatorToken.kind === ts.SyntaxKind.EqualsToken && isScrub(ctx, n.right, depth + 1))
    )
      ok = false;
    ts.forEachChild(n, visit);
  };
  visit(ctx.sf);
  return ok;
}

/** The function a parameter belongs to, named by the binding it is reachable through. */
function wrapperBinding(
  fn: ts.SignatureDeclaration,
): { name: ts.Identifier; exported: boolean } | null {
  const exportedMods = (n: ts.Node) =>
    ts.canHaveModifiers(n) &&
    (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  if (ts.isFunctionDeclaration(fn) && fn.name) return { name: fn.name, exported: exportedMods(fn) };
  if (
    (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
    ts.isVariableDeclaration(fn.parent) &&
    ts.isIdentifier(fn.parent.name) &&
    fn.parent.initializer === fn
  ) {
    const stmt = fn.parent.parent.parent;
    return { name: fn.parent.name, exported: exportedMods(stmt) };
  }
  return null;
}

/** Every reference to `name`'s binding in the file other than its declaration. */
function references(ctx: Ctx, name: ts.Identifier): ts.Identifier[] {
  const sym = ctx.checker.getSymbolAtLocation(name);
  const out: ts.Identifier[] = [];
  if (!sym) return out;
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && n !== name) {
      const s = ctx.checker.getSymbolAtLocation(n);
      // `export { run }` binds an export alias to the same local symbol.
      const target = s && s.flags & ts.SymbolFlags.Alias ? ctx.checker.getAliasedSymbol(s) : s;
      if (s === sym || target === sym) out.push(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(ctx.sf);
  return out;
}

/** Why a generic wrapper is unsafe, or null when every caller passes a non-git command. */
function wrapperProblem(ctx: Ctx, param: ts.ParameterDeclaration): string | null {
  const fn = param.parent;
  if (param.dotDotDotToken) return "the command is a rest parameter";
  const binding = wrapperBinding(fn);
  if (!binding) return "an anonymous or method wrapper — its callers cannot be enumerated";
  if (binding.exported)
    return `\`${binding.name.text}\` is exported — its callers outside this file cannot be enumerated`;
  const index = fn.parameters.indexOf(param);
  const refs = references(ctx, binding.name);
  for (const ref of refs) {
    const call = ref.parent;
    const line = ctx.sf.getLineAndCharacterOfPosition(ref.getStart(ctx.sf)).line + 1;
    if (ts.isExportSpecifier(call)) return `\`${binding.name.text}\` is exported (line ${line})`;
    if (!ts.isCallExpression(call) || call.expression !== ref)
      return `\`${binding.name.text}\` is used as a value at line ${line} — its callers cannot be enumerated`;
    const k = cmdKindOf(ctx, call.arguments[index]);
    if (k.kind !== "nongit")
      return `\`${binding.name.text}\` is called at line ${line} with a command that is ${k.kind === "git" ? "git" : "not statically non-git"}`;
  }
  return null;
}

/** How many directories below the repo root `fileName` sits (scripts/x.ts → 1), or null for a snippet. */
function fileDepth(fileName: string): number | null {
  const rel = relative(ROOT, dirname(resolve(fileName)));
  return fileName.startsWith("/") && !rel.startsWith("..")
    ? rel === ""
      ? 0
      : rel.split(/[\\/]/).length
    : null;
}

/** `__dirname`, `import.meta.dirname`, `dirname(fileURLToPath(import.meta.url))`. */
function isFileDir(ctx: Ctx, e: ts.Expression): boolean {
  const t = strip(e).getText(ctx.sf).replace(/\s/g, "");
  return /^(__dirname|import\.meta\.dirname|(path\.)?dirname\((url\.)?fileURLToPath\(import\.meta\.url\)\))$/.test(
    t,
  );
}

/**
 * True when `cwd` names the repository root: an identifier `ROOT` /
 * `REPO_ROOT` bound to a `const` whose value is `resolve|join(<this file's
 * dir>, "..", …)` (optionally under `realpathSync`) with exactly as many
 * `..` as the file sits below the root. The name alone is not enough —
 * `const ROOT = tmp` or `process.cwd()` is a fixture. An UNBOUND `ROOT`
 * (a snippet with no declaration) is taken at its name.
 */
function isRepoRoot(ctx: Ctx, cwd: ts.Expression, depth: number | null): boolean {
  const id = strip(cwd);
  if (!ts.isIdentifier(id) || !REPO_ROOT_IDENTS.has(id.text)) return false;
  const d = declOf(ctx, id);
  if (!d) return true;
  if (!ts.isVariableDeclaration(d) || !d.initializer || !isConst(d)) return false;
  let init = strip(d.initializer);
  if (
    ts.isCallExpression(init) &&
    /(^|\.)realpathSync$/.test(init.expression.getText(ctx.sf)) &&
    init.arguments[0]
  )
    init = strip(init.arguments[0]);
  if (!ts.isCallExpression(init) || !/(^|\.)(resolve|join)$/.test(init.expression.getText(ctx.sf)))
    return false;
  const [base, ...segs] = init.arguments;
  if (!base || !isFileDir(ctx, base)) return false;
  let ups = 0;
  for (const seg of segs) {
    const t = staticText(strip(seg));
    if (t === null || t.includes("\0")) return false;
    for (const part of t.split("/").filter((p) => p !== "" && p !== ".")) {
      if (part !== "..") return false;
      ups++;
    }
  }
  return depth === null ? ups > 0 : ups === depth;
}

/** Parse one source with a binder (no type resolution beyond the file — fast, deterministic). */
function bind(src: string, fileName: string): Ctx {
  const kind = /\.(js|mjs|cjs)$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const name = /\.[cm]?[jt]s$/.test(fileName) ? fileName : `${fileName}.ts`;
  const sf = ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true, kind);
  const host: ts.CompilerHost = {
    getSourceFile: (f) => (f === name ? sf : undefined),
    writeFile: () => {},
    getDefaultLibFileName: () => "lib.d.ts",
    useCaseSensitiveFileNames: () => true,
    getCanonicalFileName: (f) => f,
    getCurrentDirectory: () => "/",
    getNewLine: () => "\n",
    fileExists: (f) => f === name,
    readFile: () => undefined,
  };
  const program = ts.createProgram(
    [name],
    { noResolve: true, noLib: true, allowJs: true, noEmit: true, types: [] },
    host,
  );
  return { sf: program.getSourceFile(name)!, checker: program.getTypeChecker() };
}

/**
 * Every git spawn and generic spawn wrapper in a TS/JS source, classified
 * deny-by-default: a site is "repo" only when its command, arguments and
 * options all resolve statically to git on the repo root.
 */
export function analyzeTs(src: string, fileName = "x.ts"): GitSpawn[] {
  const ctx = bind(src, fileName);
  const { sf } = ctx;
  const depth = fileDepth(fileName);
  const out: GitSpawn[] = [];
  const visit = (n: ts.Node): void => {
    ts.forEachChild(n, visit);
    if (!ts.isCallExpression(n)) return;
    const spawn = spawnNameOf(ctx, n.expression);
    if (!spawn) return;
    const shell = SHELL_SPAWNS.has(spawn);
    const [cmd, ...rest] = n.arguments;
    const k = cmdKindOf(ctx, cmd);
    if (k.kind === "nongit") return;
    // Positional: exec*(cmd, opts?, cb?) / spawn*|execFile*(file, args?, opts?, cb?).
    const positional = rest.filter((a) => !ts.isFunctionExpression(a) && !ts.isArrowFunction(a));
    let argsExpr: ts.Expression | undefined;
    let optsExpr: ts.Expression | undefined;
    if (shell) optsExpr = positional[0];
    else if (positional.length >= 2) [argsExpr, optsExpr] = positional;
    else if (positional[0]) {
      const r = resolveExpr(ctx, positional[0]);
      if (r && "node" in r && ts.isObjectLiteralExpression(r.node)) optsExpr = positional[0];
      else argsExpr = positional[0];
    }
    const optsR = optsExpr ? resolveExpr(ctx, optsExpr) : undefined;
    const opts =
      optsR && "node" in optsR && ts.isObjectLiteralExpression(optsR.node) ? optsR.node : null;
    const optsResolved = optsExpr === undefined || opts !== null;
    const hasSpread = opts?.properties.some(ts.isSpreadAssignment) ?? false;
    const cwd = opts ? property(opts, "cwd") : null;
    const env = opts && !hasSpread ? property(opts, "env") : null;
    const scrubbed = isScrub(ctx, env);
    const start = n.expression.getStart(sf);
    const line = sf.getLineAndCharacterOfPosition(start).line + 1;
    const argText = n.arguments.map((a) => a.getText(sf)).join(", ");
    const snippet = `${n.expression.getText(sf)}(${argText.replace(/\s+/g, " ").trim().slice(0, 60)}…`;

    if (k.kind === "param") {
      const problem = scrubbed ? null : wrapperProblem(ctx, k.param);
      out.push({
        line,
        kind: "wrapper",
        target: "fixture",
        scrubbed: problem === null,
        snippet,
        why:
          problem ??
          (scrubbed ? "wrapper scrubs with cleanEnv" : "every caller passes a non-git command"),
      });
      return;
    }

    let verdict: ArgsVerdict;
    if (k.kind === "git" && k.shell !== null && (shell || /\s/.test(k.shell.trim()))) {
      // A command LINE (exec/execSync, or a file argument with spaces): its own tokens are the args.
      const tokens = shellArgs(k.shell);
      verdict =
        tokens[0]?.text !== "git" || /[;&|`<>]|\$\(/.test(k.shell)
          ? "unresolved"
          : argsVerdict(tokens.slice(1));
    } else if (argsExpr === undefined) verdict = "local";
    else {
      const r = resolveExpr(ctx, argsExpr);
      verdict =
        r && "node" in r && ts.isArrayLiteralExpression(r.node)
          ? argsVerdict(
              r.node.elements.map((e) =>
                ts.isSpreadElement(e) ? { text: null, prefix: "" } : argOf(e),
              ),
            )
          : "unresolved";
    }
    const cwdIsRepo = cwd !== null && isRepoRoot(ctx, cwd, depth);
    let why = "";
    if (k.kind === "unknown") why = "command not statically resolvable to a non-git program";
    else if (!optsResolved) why = "options not statically resolvable";
    else if (hasSpread) why = "options carry a spread (may override cwd/env)";
    else if (verdict === "redirect")
      why = "arguments redirect git (-C / --git-dir / --work-tree / clone / init <path>)";
    else if (verdict === "unresolved") why = "arguments not statically resolvable";
    else if (cwd === null) why = "no cwd (the process cwd is not statically the repo root)";
    else if (!cwdIsRepo) why = `cwd \`${cwd.getText(sf)}\` is not the repo root`;
    out.push({
      line,
      kind: "git",
      target: why === "" ? "repo" : "fixture",
      scrubbed,
      snippet,
      why: why === "" ? "cwd is the repo root" : why,
    });
  };
  visit(sf);
  return out.sort((a, b) => a.line - b.line);
}

/** Every fixture-targeting git line in a shell source, classified. */
export function analyzeSh(src: string): GitSpawn[] {
  const out: GitSpawn[] = [];
  const lines = src.split("\n");
  let scrubbedAt = -1;
  lines.forEach((raw, i) => {
    const l = raw.replace(/(^|\s)#.*$/, "");
    if (/^\s*fixture_git_env_scrub\b/.test(l) && scrubbedAt < 0) scrubbedAt = i;
    if (!/(^|[\s;&|(]|\$\()git\s+(clone|init|-C\b|--git-dir|--work-tree)/.test(l)) return;
    out.push({
      line: i + 1,
      kind: "git",
      target: "fixture",
      scrubbed: scrubbedAt >= 0 && scrubbedAt < i,
      snippet: l.trim().slice(0, 70),
      why: "shell git aimed at another directory",
    });
  });
  return out;
}

/** A file vitest collects under the root config — covered by the setup scrub (layer 1). */
export function isStructurallyScrubbed(rel: string): boolean {
  return /^scripts\/__tests__\/(.+\/)?[^/]+\.(test|spec)\.[cm]?[jt]sx?$/.test(
    rel.split("\\").join("/"),
  );
}

/**
 * Layer 1: the vitest setup scrub is wired into the config `pnpm test:gates`
 * resolves, its list IS the canonical `isScrubbedGitEnvKey` (imported, not
 * copied), and executing it leaves exactly what `cleanEnv` leaves. Returns
 * the problems (empty = held).
 */
export function checkStructural(root: string): string[] {
  const problems: string[] = [];
  // (a) test:gates resolves the root config.
  let script = "";
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    script = pkg.scripts?.["test:gates"] ?? "";
  } catch (err) {
    problems.push(`package.json unreadable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!/^vitest run\b/.test(script)) {
    problems.push(
      `test:gates is not a \`vitest run\` from the repo root: ${JSON.stringify(script)}`,
    );
  } else if (
    /(^|\s)(--config|-c|--root|-r|--project|--workspace|--setupFiles|--dir=?\S*\.\.)(\s|=|$)/.test(
      script,
    )
  ) {
    problems.push(
      `test:gates passes a flag that bypasses ${GATES_CONFIG} or its setupFiles: ${JSON.stringify(script)}`,
    );
  }
  // (b) no other root config shadows it.
  const configs = readdirSync(root).filter((f) =>
    /^vitest\.(config|workspace)\.[cm]?[jt]s$|^vitest\.workspace\.json$/.test(f),
  );
  for (const f of configs)
    if (f !== GATES_CONFIG)
      problems.push(`${f} at the repo root shadows or extends ${GATES_CONFIG} for test:gates`);
  // (c) the config lists the setup file.
  const cfgPath = join(root, GATES_CONFIG);
  if (!existsSync(cfgPath)) problems.push(`${GATES_CONFIG} is missing`);
  else {
    const sf = ts.createSourceFile(
      cfgPath,
      readFileSync(cfgPath, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    let listed = false;
    let multi = false;
    const visit = (n: ts.Node): void => {
      if (ts.isPropertyAssignment(n) && ["projects", "workspace"].includes(n.name.getText(sf)))
        multi = true;
      if (
        ts.isPropertyAssignment(n) &&
        n.name.getText(sf) === "setupFiles" &&
        ts.isArrayLiteralExpression(n.initializer)
      ) {
        for (const e of n.initializer.elements)
          if (ts.isStringLiteral(e) && resolve(root, e.text) === resolve(root, SETUP_FILE))
            listed = true;
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    if (!listed) problems.push(`${GATES_CONFIG} setupFiles does not list ./${SETUP_FILE}`);
    if (multi)
      problems.push(
        `${GATES_CONFIG} declares projects/workspace — each project needs the setup; keep one config`,
      );
  }
  // (d) the setup file is exactly: import the canonical scrub, apply it to process.env.
  const setupPath = join(root, SETUP_FILE);
  if (!existsSync(setupPath)) {
    problems.push(`${SETUP_FILE} is missing`);
    return problems;
  }
  const setupSf = ts.createSourceFile(
    setupPath,
    readFileSync(setupPath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  let imports = false;
  let applies = false;
  const extra: string[] = [];
  for (const st of setupSf.statements) {
    if (
      ts.isImportDeclaration(st) &&
      ts.isStringLiteral(st.moduleSpecifier) &&
      st.moduleSpecifier.text === CANONICAL_MODULE &&
      st.importClause?.namedBindings &&
      ts.isNamedImports(st.importClause.namedBindings) &&
      st.importClause.namedBindings.elements.some(
        (e) => e.name.text === CANONICAL_SCRUB && !e.propertyName,
      )
    )
      imports = true;
    else if (
      ts.isExpressionStatement(st) &&
      st.expression.getText(setupSf).replace(/\s/g, "") === `${CANONICAL_SCRUB}(process.env)`
    )
      applies = true;
    else extra.push(st.getText(setupSf).split("\n")[0]!.slice(0, 80));
  }
  if (!imports)
    problems.push(
      `${SETUP_FILE} must import { ${CANONICAL_SCRUB} } from "${CANONICAL_MODULE}" — the canonical list (isScrubbedGitEnvKey), imported, never a copy`,
    );
  if (!applies)
    problems.push(`${SETUP_FILE} must call ${CANONICAL_SCRUB}(process.env) at top level`);
  if (extra.length > 0)
    problems.push(
      `${SETUP_FILE} must contain only that import and that call; also found: ${extra.join(" | ")}`,
    );
  // (e) executed on a probe env, it leaves exactly what cleanEnv leaves.
  const probe: Record<string, string> = {};
  for (const k of [...REDIRECT_PROBE, ...KEEP_PROBE]) probe[k] = "/nonexistent-probe";
  const expected = Object.keys(probe)
    .filter((k) => !isScrubbedGitEnvKey(k))
    .sort();
  const dir = mkdtempSync(join(tmpdir(), "check-fixture-git-env-"));
  try {
    const driver = join(dir, "driver.mts");
    writeFileSync(
      driver,
      `const probe = ${JSON.stringify(Object.keys(probe))};\n` +
        `await import(${JSON.stringify(setupPath)});\n` +
        `process.stdout.write(JSON.stringify(probe.filter((k) => k in process.env).sort()));\n`,
    );
    const r = spawnSync(join(ROOT, "node_modules", ".bin", "tsx"), [driver], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...probe },
      encoding: "utf8",
      timeout: 60_000,
    });
    let left: string[] | null = null;
    try {
      left = JSON.parse(r.stdout) as string[];
    } catch {
      problems.push(
        `executing ${SETUP_FILE} failed (exit ${r.status}): ${r.stderr.trim().slice(0, 300)}`,
      );
    }
    if (left) {
      const stillSet = left.filter((k) => !expected.includes(k));
      const overRemoved = expected.filter((k) => !left.includes(k));
      if (stillSet.length > 0)
        problems.push(
          `after ${SETUP_FILE} runs, ${stillSet.join(", ")} still set — cleanEnv removes them`,
        );
      if (overRemoved.length > 0)
        problems.push(`${SETUP_FILE} removes ${overRemoved.join(", ")} — cleanEnv keeps them`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return problems;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(ts|mts|cts|js|mjs|cjs|sh)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

function main(): void {
  const files = walk(SCRIPTS).sort();
  const n = { repo: 0, fixture: 0, wrappers: 0, structural: 0, structuralFiles: 0, shell: 0 };
  const sites: string[] = [];
  for (const f of files) {
    const rel = relative(ROOT, f);
    const src = readFileSync(f, "utf8");
    if (f.endsWith(".sh")) {
      for (const s of analyzeSh(src)) {
        n.shell++;
        if (!s.scrubbed) sites.push(`${rel}:${s.line}  ${s.snippet}  [${s.why}]`);
      }
      continue;
    }
    const spawns = analyzeTs(src, f);
    if (isStructurallyScrubbed(rel)) {
      n.structuralFiles++;
      n.structural += spawns.length;
      continue;
    }
    for (const s of spawns) {
      if (s.kind === "wrapper") n.wrappers++;
      else if (s.target === "repo") n.repo++;
      else n.fixture++;
      if (s.kind === "wrapper" ? !s.scrubbed : s.target === "fixture" && !s.scrubbed)
        sites.push(`${rel}:${s.line}  ${s.snippet}  [${s.why}]`);
    }
  }
  const structural = checkStructural(ROOT);
  console.log(
    "▸ check-fixture-git-env — no git child started from scripts/ can act on a repository named by an " +
      "inherited GIT_* (a hook's GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE): structurally scrubbed in the " +
      "gate self-tests, cleanEnv at every other git spawn that does not statically resolve to the repo root.",
  );
  if (sites.length === 0 && structural.length === 0) {
    console.log(
      `✓ check-fixture-git-env: ${files.length} file(s) scanned under scripts/.\n` +
        `  Structural: ${n.structuralFiles} vitest test file(s) (${n.structural} git/wrapper spawn site(s), any syntax) ` +
        `covered by ${SETUP_FILE} — wired into ${GATES_CONFIG} for test:gates, list imported from ` +
        `isScrubbedGitEnvKey, execution leaves exactly what cleanEnv leaves (${REDIRECT_PROBE.length + KEEP_PROBE.length} probe variable(s)).\n` +
        `  Static (deny-by-default, every other TS/JS file): ${n.repo} git spawn(s) resolve to the repo root; ` +
        `${n.fixture} do not and all use cleanEnv; ${n.wrappers} generic spawn wrapper(s) scrub or take only non-git commands.\n` +
        `  Shell: ${n.shell} fixture git line(s), all after fixture_git_env_scrub.\n` +
        `  Not examined: spawns outside scripts/, and child_process calls reached only through a binding the ` +
        `parser cannot tie to a child_process import (it fails closed on everything it can see).`,
    );
    return;
  }
  process.stderr.write(
    formatRepair({
      invariant: `check-fixture-git-env: ${sites.length} unscrubbed git spawn/wrapper site(s), ${structural.length} structural-layer problem(s) (scanned ${files.length} file(s))`,
      sites: [...structural.map((p) => `structural: ${p}`), ...sites],
      canonical:
        "isScrubbedGitEnvKey / cleanEnv / scrubGitEnvInPlace in scripts/lib/differential-tree.ts (structural: scripts/lib/vitest-scrub-git-env.ts via vitest.config.mts; shell: scripts/lib/fixture-git-env.sh)",
      fix:
        'pass `env: cleanEnv()` (import { cleanEnv } from "./lib/differential-tree.js"; add your own ' +
        "extras as its second argument) to the spawn — a generic wrapper passes `env: cleanEnv(env)` itself. " +
        "A spawn counts as the repo only when its options statically say `cwd: ROOT` (inline or a const) with " +
        "static git arguments and no -C / --git-dir / --work-tree. In a shell script source scripts/lib/fixture-git-env.sh " +
        "and call fixture_git_env_scrub before the first git command. Structural problems: restore " +
        `${SETUP_FILE} to \`import { ${CANONICAL_SCRUB} } from "${CANONICAL_MODULE}"; ${CANONICAL_SCRUB}(process.env);\` ` +
        `and keep it in ${GATES_CONFIG} setupFiles, with test:gates a plain \`vitest run\` from the root.`,
      doctrine:
        "scripts/__tests__/git-env-structural.test.ts (execution proof) and scripts/__tests__/fixture-git-env.test.ts",
    }),
  );
  process.exit(1);
}

if (process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
