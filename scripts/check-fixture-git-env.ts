/**
 * check-fixture-git-env — every git spawn under `scripts/` that targets
 * anything other than the repo root (a temp dir, a fixture, a copied tree)
 * runs with `cleanEnv()` (`scripts/lib/differential-tree.ts` — the scrub #1028
 * made canonical for the gate self-tests).
 *
 * Why: a git hook exports GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE (from a
 * linked worktree, a GIT_DIR into the SHARED repository) to every process it
 * spawns, and git honours them over `cwd`. A fixture's `git init` under a
 * pre-push hook wrote `core.worktree=<fixture>` into the real `.git/config`
 * and a fixture `git commit` landed on a real branch (#835; again 2026-10-01
 * and 2026-10-02). #1028 scrubs at the ENTRY points (`.husky/pre-push`, the
 * vitest setup `scripts/lib/vitest-scrub-git-env.ts`); this gate holds the
 * per-spawn layer, which also covers a script run outside both (a bare
 * `npx tsx scripts/…` or a shell script from a hook).
 * The harness `scripts/__tests__/fixture-git-env.test.ts` proves today's
 * helpers are scrubbed against a decoy; this gate keeps a NEW spawn from
 * skipping the helper.
 *
 * Rules (static, per file):
 *   - TS/JS (parsed with the TypeScript compiler API, not regex): a
 *     `spawnSync|spawn|execFileSync|execFile|execSync|exec` call whose command
 *     is `"git"` (or a shell string starting `git `) targets the REAL repo only
 *     when the call's own top-level options object has `cwd` `ROOT` /
 *     `REPO_ROOT` (or no `cwd` and no spread — the process cwd) and its
 *     arguments carry no `-C` / `--git-dir` / `--work-tree`, no `clone`, and
 *     no `init <path>`. Any other target must pass `env: cleanEnv(…)` directly,
 *     or an `env` variable whose last prior assignment is `cleanEnv(…)`; a
 *     spread / `Object.assign` copy of `process.env` is not a scrub.
 *   - Shell: a `git clone` / `git init` / `git -C` / `--git-dir` /
 *     `--work-tree` line must come after a `fixture_git_env_scrub` call
 *     (`scripts/lib/fixture-git-env.sh`).
 *
 * Aperture: direct spawns whose command is a git literal. A wrapper taking the
 * command as a parameter (`run(cmd, …)`) is examined at its own spawn, not at
 * its callers — route a fixture wrapper's env through `cleanEnv` itself.
 *
 * `cleanEnv` is recognised by name: `scripts/lib/tamper-runner.ts` keeps an
 * inlined copy (plain `node` loads it and cannot resolve the `.ts` import);
 * every `cleanEnv` under `scripts/` removes every `GIT_*`.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { formatRepair } from "./lib/gate-report.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SCRIPTS = join(ROOT, "scripts");

/** Identifiers that name the repository root in `scripts/`. */
const REPO_ROOT_IDENTS = new Set(["ROOT", "REPO_ROOT"]);
const SPAWN_NAMES = new Set(["spawnSync", "spawn", "execFileSync", "execFile", "execSync", "exec"]);
/** `init` options that consume the next argument (so it is not the target path). */
const INIT_VALUE_FLAGS = new Set([
  "-b",
  "--initial-branch",
  "--template",
  "--separate-git-dir",
  "--object-format",
  "--ref-format",
]);

export interface GitSpawn {
  line: number;
  target: "repo" | "fixture";
  scrubbed: boolean;
  snippet: string;
}

/**
 * One git argument: its static text, or null when it is computed. A template
 * literal keeps its leading static text (`--work-tree=${wt}` → "--work-tree=").
 */
type Arg = { text: string | null; prefix: string };

function argOf(node: ts.Expression): Arg {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { text: node.text, prefix: node.text };
  }
  if (ts.isTemplateExpression(node)) return { text: null, prefix: node.head.text };
  return { text: null, prefix: "" };
}

/** The tokens of a shell command string (`git clone ${url} ${dir}`), substitutions as computed tokens. */
function shellArgs(node: ts.Expression): Arg[] | null {
  let raw: string;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) raw = node.text;
  else if (ts.isTemplateExpression(node)) {
    raw = node.head.text + node.templateSpans.map((s) => "\0" + s.literal.text).join("");
  } else return null;
  return raw
    .trim()
    .split(/\s+/)
    .map((t) =>
      t.includes("\0") ? { text: null, prefix: t.split("\0")[0]! } : { text: t, prefix: t },
    );
}

/**
 * True when the git arguments themselves aim git away from the process cwd:
 * `-C <path>`, `--git-dir`, `--work-tree`, `clone`, or `init <path>`.
 * A computed argument list (a variable, a spread) is not inspected — `cwd` decides.
 */
function argsRedirect(args: Arg[]): boolean {
  let sub: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.prefix === "-C" || /^--(git-dir|work-tree)(=|$)/.test(a.prefix)) return true;
    if (sub === null) {
      if (a.text === null) return false; // computed subcommand: cannot tell
      if (a.text === "-c") i++;
      else if (!a.text.startsWith("-")) sub = a.text;
      continue;
    }
    if (sub === "clone") return true;
    if (sub !== "init") return false;
    if (a.text !== null && INIT_VALUE_FLAGS.has(a.text)) i++;
    else if (a.text === null || !a.text.startsWith("-")) return true;
  }
  return sub === "clone";
}

/** The initializer of `key` in an object literal (shorthand → its identifier), or null when absent. */
function property(obj: ts.ObjectLiteralExpression, key: string): ts.Expression | null {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && p.name.getText() === key) return p.initializer;
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === key) return p.name;
  }
  return null;
}

/** True for a direct `cleanEnv(…)` call — anything else (spread, Object.assign, process.env) is not a scrub. */
function isScrubCall(node: ts.Expression | undefined): boolean {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)))
    node = node.expression;
  return (
    node !== undefined &&
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "cleanEnv"
  );
}

/** Every assignment `ident = expr` / `const ident = expr` in the file, by position. */
function assignments(sf: ts.SourceFile): Map<string, { pos: number; value: ts.Expression }[]> {
  const out = new Map<string, { pos: number; value: ts.Expression }[]>();
  const add = (name: string, pos: number, value: ts.Expression) => {
    const list = out.get(name) ?? [];
    list.push({ pos, value });
    out.set(name, list);
  };
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      add(n.name.text, n.getStart(sf), n.initializer);
    } else if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(n.left)
    ) {
      add(n.left.text, n.getStart(sf), n.right);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * Every git spawn in a TS/JS source, classified. Parsed with the TypeScript
 * compiler, so the options object is the call's own top-level argument —
 * never an object nested inside it, and never a brace inside a string.
 */
export function analyzeTs(src: string, fileName = "x.ts"): GitSpawn[] {
  const kind = /\.(js|mjs|cjs)$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, kind);
  const assigned = assignments(sf);
  const out: GitSpawn[] = [];
  const visit = (n: ts.Node): void => {
    ts.forEachChild(n, visit);
    if (!ts.isCallExpression(n)) return;
    const callee = ts.isPropertyAccessExpression(n.expression) ? n.expression.name : n.expression;
    if (!ts.isIdentifier(callee) || !SPAWN_NAMES.has(callee.text)) return;
    const [cmd, ...rest] = n.arguments;
    if (!cmd) return;
    const cmdArg = argOf(cmd);
    let gitArgs: Arg[] | null;
    if (cmdArg.text === "git") {
      const list = rest[0];
      // A spread element is a computed argument; a non-literal list is not inspected (cwd decides).
      gitArgs =
        list && ts.isArrayLiteralExpression(list)
          ? list.elements.map((e) =>
              ts.isSpreadElement(e) ? { text: null, prefix: "" } : argOf(e),
            )
          : null;
    } else if (/^git\s/.test(cmdArg.prefix)) {
      gitArgs = shellArgs(cmd)!.slice(1);
    } else return;
    const last = n.arguments.at(-1)!;
    const opts = last !== cmd && ts.isObjectLiteralExpression(last) ? last : null;
    const cwd = opts ? property(opts, "cwd") : null;
    const hasSpread = opts?.properties.some(ts.isSpreadAssignment) ?? false;
    const cwdIsRepo =
      cwd === null ? !hasSpread : ts.isIdentifier(cwd) && REPO_ROOT_IDENTS.has(cwd.text);
    const redirected = gitArgs !== null && argsRedirect(gitArgs);
    const target: GitSpawn["target"] = !redirected && cwdIsRepo ? "repo" : "fixture";
    const env = opts ? property(opts, "env") : null;
    const start = callee.getStart(sf);
    let scrubbed = isScrubCall(env ?? undefined);
    if (!scrubbed && env && ts.isIdentifier(env)) {
      const prior = (assigned.get(env.text) ?? []).filter((a) => a.pos < start).at(-1);
      scrubbed = isScrubCall(prior?.value);
    }
    const argText = n.arguments.map((a) => a.getText(sf)).join(", ");
    out.push({
      line: sf.getLineAndCharacterOfPosition(start).line + 1,
      target,
      scrubbed,
      snippet: `${callee.text}(${argText.replace(/\s+/g, " ").trim().slice(0, 60)}…`,
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
      target: "fixture",
      scrubbed: scrubbedAt >= 0 && scrubbedAt < i,
      snippet: l.trim().slice(0, 70),
    });
  });
  return out;
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
  let repo = 0;
  let fixture = 0;
  const sites: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const spawns = f.endsWith(".sh") ? analyzeSh(src) : analyzeTs(src, f);
    for (const s of spawns) {
      if (s.target === "repo") repo++;
      else fixture++;
      if (s.target === "fixture" && !s.scrubbed) {
        sites.push(`${relative(ROOT, f)}:${s.line}  ${s.snippet}`);
      }
    }
  }
  console.log(
    "▸ check-fixture-git-env — every git spawn under scripts/ aimed away from the repo root runs " +
      "with cleanEnv(), so a hook's GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE cannot redirect " +
      "it into the real repository.",
  );
  if (sites.length === 0) {
    console.log(
      `✓ check-fixture-git-env: ${files.length} file(s) scanned, ${repo + fixture} git spawn(s) — ` +
        `${repo} target the repo root, ${fixture} target a fixture and all ${fixture} use cleanEnv.`,
    );
    return;
  }
  process.stderr.write(
    formatRepair({
      invariant: `check-fixture-git-env: ${sites.length} git spawn(s) target a non-repo directory with the caller's GIT_* environment (scanned ${files.length} file(s))`,
      sites,
      canonical:
        "cleanEnv in scripts/lib/differential-tree.ts (shell: scripts/lib/fixture-git-env.sh)",
      fix:
        'pass `env: cleanEnv()` (import { cleanEnv } from "./lib/differential-tree.js"; add your own ' +
        "extras as its second argument) to the spawn, or in a shell script source scripts/lib/fixture-git-env.sh " +
        "and call fixture_git_env_scrub before the first git command. If the spawn really targets the repo " +
        "root, set its cwd to ROOT and drop -C / --git-dir / --work-tree.",
      doctrine:
        "scripts/__tests__/fixture-git-env.test.ts (the decoy harness this gate keeps true)",
    }),
  );
  process.exit(1);
}

if (process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
