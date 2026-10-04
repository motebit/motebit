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
 *   - TS/JS: a `spawnSync|spawn|execFileSync|execFile|execSync|exec` call
 *     whose command is `"git"` (or a shell string starting `git `) targets the
 *     REAL repo only when its `cwd` is `ROOT` / `REPO_ROOT` (or absent — the
 *     process cwd) and its arguments carry no `-C` / `--git-dir` /
 *     `--work-tree`. Any other target must pass `env: cleanEnv(…)`, or an
 *     `env` variable the same file assigns from `cleanEnv(`.
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
import { formatRepair } from "./lib/gate-report.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SCRIPTS = join(ROOT, "scripts");

/** Identifiers that name the repository root in `scripts/`. */
const REPO_ROOT_IDENTS = new Set(["ROOT", "REPO_ROOT"]);
const SPAWN = /\b(spawnSync|spawn|execFileSync|execFile|execSync|exec)\s*\(/g;
const REDIRECT_FLAG = /(["'`\s])(-C|--git-dir(=|\b)|--work-tree(=|\b))/;

export interface GitSpawn {
  line: number;
  target: "repo" | "fixture";
  scrubbed: boolean;
  snippet: string;
}

/** The text between the `(` at `open` and its matching `)`, string-aware. */
function callArgs(src: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return src.slice(open + 1);
}

/** The value of `key:` (or shorthand `key`) in an options-object text, or null. */
function optionValue(opts: string, key: string): string | null {
  const m = new RegExp(`(?:^|[{,\\s])${key}\\s*:\\s*([^,}\\n]+)`).exec(opts);
  if (m) return m[1]!.trim();
  if (new RegExp(`(?:^|[{,])\\s*${key}\\s*(?:[,}]|$)`).test(opts)) return key;
  return null;
}

/** True for an env expression that is a `cleanEnv(` call. */
function isScrubExpr(text: string): boolean {
  return text.startsWith("cleanEnv(");
}

/** True when the last assignment to `ident` in `before` is a scrubbed env expression. */
function lastAssignment(before: string, ident: string): boolean {
  const all = [...before.matchAll(new RegExp(`\\b${ident}\\s*=(?![=>])\\s*`, "g"))];
  const last = all.at(-1);
  return last !== undefined && isScrubExpr(before.slice(last.index + last[0].length));
}

/** Every git spawn in a TS/JS source, classified. */
export function analyzeTs(src: string): GitSpawn[] {
  const out: GitSpawn[] = [];
  for (const m of src.matchAll(SPAWN)) {
    const open = m.index! + m[0].length - 1;
    const args = callArgs(src, open);
    const first = /^\s*(["'`])((?:\\.|(?!\1).)*)\1/s.exec(args);
    if (!first) continue;
    const literal = first[2]!;
    const isGit = literal === "git" || /^git\s/.test(literal);
    if (!isGit) continue;
    const optsStart = args.lastIndexOf("{");
    const opts = optsStart >= 0 ? args.slice(optsStart) : "";
    const cwd = optionValue(opts, "cwd");
    const redirected = REDIRECT_FLAG.test(args.slice(0, optsStart >= 0 ? optsStart : undefined));
    const target: GitSpawn["target"] =
      !redirected && (cwd === null || REPO_ROOT_IDENTS.has(cwd)) ? "repo" : "fixture";
    const env = optionValue(opts, "env");
    const scrubbed =
      env !== null &&
      (isScrubExpr(env) ||
        (/^[A-Za-z_$][\w$]*$/.test(env) && lastAssignment(src.slice(0, m.index), env)));
    out.push({
      line: src.slice(0, m.index).split("\n").length,
      target,
      scrubbed,
      snippet: `${m[1]}(${args.replace(/\s+/g, " ").trim().slice(0, 60)}…`,
    });
  }
  return out;
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
    const spawns = f.endsWith(".sh") ? analyzeSh(src) : analyzeTs(src);
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
