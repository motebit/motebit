/**
 * Harness: the gate self-tests must never write into a repository named by an
 * inherited `GIT_*` environment.
 *
 * Incidents: 2026-09-27 (#835) and 2026-10-02. A `git push` from a LINKED
 * worktree runs `.husky/pre-push` with GIT_DIR=<repo>/.git/worktrees/<name>
 * (plus GIT_PREFIX, GIT_EXEC_PATH, GIT_EDITOR) exported — a main-checkout hook
 * gets no GIT_DIR. The hook runs `pnpm test:gates`; a test whose fixture git
 * commands inherited that GIT_DIR acted on the REAL repository whatever its
 * `cwd`: the shared .git/config got `core.bare = true` and `fixture` / `base`
 * commits landed on the pushing worktree's branch.
 *
 * NOT a vitest file (it runs the whole gate-test suite; as a `.test.ts` it
 * would recurse into itself). Run it alone:
 *
 *   npx tsx scripts/__tests__/git-env-isolation.harness.ts [--hook] [-- <vitest args…>]
 *
 * It builds a SENTINEL repository in a temp dir (main checkout + a linked
 * worktree), snapshots it — .git/config bytes, every ref (`for-each-ref`),
 * every worktree's HEAD (file bytes and resolved commit), the object count —
 * then runs `pnpm test:gates` (or `pnpm exec vitest run <args>` when args are
 * given) with exactly the variables git exports into a linked-worktree hook,
 * pointed at the sentinel's worktree gitdir. Green = the sentinel is
 * byte-for-byte unchanged. The suite's own pass/fail is reported but is not
 * the verdict (a test failing under a hostile env is a separate finding).
 *
 * `--hook` runs the command behind the scrub prologue of `.husky/pre-push`
 * (the line marked `git-env-scrub`), exactly as the hook would — proving the
 * hook layer on its own. Without it, the command runs as a direct invocation
 * would, so only the vitest setup layer and the tests themselves defend.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanEnv } from "../lib/differential-tree.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const argv = process.argv.slice(2);
const viaHook = argv.includes("--hook");
const dash = argv.indexOf("--");
const vitestArgs = dash >= 0 ? argv.slice(dash + 1) : [];

/** The sentinel's fixed git identity/config, applied on top of `cleanEnv`. */
const SENTINEL_GIT: Record<string, string> = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "sentinel",
  GIT_AUTHOR_EMAIL: "sentinel@example.invalid",
  GIT_COMMITTER_NAME: "sentinel",
  GIT_COMMITTER_EMAIL: "sentinel@example.invalid",
};
/** This process's own environment with every GIT_* removed — the harness's git never leaks either. */
function scrubbed(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return cleanEnv(process.env, { ...SENTINEL_GIT, ...extra });
}
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: cleanEnv(process.env, SENTINEL_GIT),
    encoding: "utf8",
  }).trim();

// ── The sentinel ─────────────────────────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), "motebit-git-sentinel-"));
const main = join(tmp, "sentinel");
const wt = join(tmp, "sentinel-wt");
mkdirSync(main);
git(main, "init", "-q", "-b", "main");
writeFileSync(join(main, "README"), "sentinel\n");
git(main, "add", "README");
git(main, "commit", "-q", "-m", "sentinel root");
git(main, "worktree", "add", "-q", "-b", "wt-branch", wt);
const wtGitDir = git(wt, "rev-parse", "--absolute-git-dir"); // <main>/.git/worktrees/sentinel-wt

interface Snapshot {
  config: string;
  refs: string;
  heads: Record<string, string>;
  objects: string;
}
function snapshot(): Snapshot {
  const heads: Record<string, string> = {};
  for (const block of git(main, "worktree", "list", "--porcelain").split("\n\n")) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    if (path)
      heads[path] =
        `${/^HEAD (.+)$/m.exec(block)?.[1]} ${/^branch (.+)$/m.exec(block)?.[1] ?? "(detached)"}`;
  }
  heads["file:.git/HEAD"] = readFileSync(join(main, ".git", "HEAD"), "utf8");
  heads["file:worktree HEAD"] = readFileSync(join(wtGitDir, "HEAD"), "utf8");
  return {
    config: readFileSync(join(main, ".git", "config"), "utf8"),
    refs: git(main, "for-each-ref", "--format=%(refname) %(objectname)"),
    heads,
    objects: git(main, "count-objects", "-v")
      .split("\n")
      .filter((l) => /^(count|in-pack|packs):/.test(l))
      .join(", "),
  };
}
const before = snapshot();

// ── The hostile environment: what git exports into a linked-worktree hook ──
const hostile: Record<string, string> = {
  GIT_DIR: wtGitDir,
  GIT_PREFIX: "",
  GIT_EXEC_PATH: git(main, "--exec-path"),
  GIT_EDITOR: ":",
};
const childEnv: NodeJS.ProcessEnv = { ...process.env, ...hostile };
const cmd =
  vitestArgs.length > 0
    ? `pnpm exec vitest run ${vitestArgs.map((a) => `'${a}'`).join(" ")}`
    : "pnpm test:gates";

let script = cmd;
if (viaHook) {
  const scrub = readFileSync(join(ROOT, ".husky", "pre-push"), "utf8")
    .split("\n")
    .filter((l) => /git-env-scrub/.test(l) && !/^\s*#/.test(l));
  if (scrub.length !== 1) {
    console.error(
      `✗ --hook: expected exactly one line marked git-env-scrub in .husky/pre-push, found ${scrub.length}`,
    );
    process.exit(2);
  }
  script = `${scrub[0]!.trim()}\n${cmd}`;
}
console.error(`▶ sentinel ${main} (worktree ${wt})`);
console.error(
  `▶ GIT_DIR=${wtGitDir}${viaHook ? " — through the hook's scrub prologue" : " — direct (no hook)"}`,
);
console.error(`▶ ${cmd}`);
const t0 = Date.now();
const run = spawnSync("sh", ["-ec", script], {
  cwd: ROOT,
  env: childEnv,
  stdio: ["ignore", "pipe", "pipe"],
  encoding: "utf8",
  maxBuffer: 512 * 1024 * 1024,
});
const out = `${run.stdout}\n${run.stderr}`;
const failedFiles = [
  ...new Set([...out.matchAll(/^\s*(?:FAIL|❯)\s+(\S+\.test\.ts)/gm)].map((m) => m[1]!)),
];
console.error(
  `  suite exit ${run.status} after ${Math.round((Date.now() - t0) / 1000)}s${failedFiles.length ? `; failing files: ${failedFiles.join(", ")}` : ""}`,
);

// ── Verdict ──────────────────────────────────────────────────────────────
const after = snapshot();
const diffs: string[] = [];
if (after.config !== before.config)
  diffs.push(`.git/config changed:\n--- before\n${before.config}--- after\n${after.config}`);
if (after.refs !== before.refs)
  diffs.push(`refs changed:\n--- before\n${before.refs}\n--- after\n${after.refs}`);
for (const k of new Set([...Object.keys(before.heads), ...Object.keys(after.heads)])) {
  if (before.heads[k] !== after.heads[k])
    diffs.push(`HEAD of ${k}: ${before.heads[k]?.trim()} → ${after.heads[k]?.trim()}`);
}
if (after.objects !== before.objects) diffs.push(`objects: ${before.objects} → ${after.objects}`);
if (diffs.length > 0) {
  const log = git(main, "log", "--all", "--format=%h %s (%an)", "-n", "40");
  console.error(
    `\n✗ git-env-isolation: the suite WROTE INTO the sentinel repository (${diffs.length} difference(s)):\n`,
  );
  for (const d of diffs) console.error(`  - ${d}\n`);
  console.error(`  sentinel log (all refs):\n${log.replace(/^/gm, "    ")}`);
  console.error(
    `\n  Repair: every child process a gate test spawns must get an environment with EVERY GIT_* removed (cleanEnv in scripts/lib/differential-tree.ts); the vitest setup (scripts/lib/vitest-scrub-git-env.ts) and the .husky/pre-push scrub line are the structural layers.`,
  );
  console.error(`  Sentinel left at ${tmp} for inspection.`);
  process.exit(1);
}
rmSync(tmp, { recursive: true, force: true });
console.error(
  `\n✓ git-env-isolation: sentinel unchanged (config, ${before.refs.split("\n").length} ref(s), ${Object.keys(before.heads).length} worktree HEAD record(s), objects ${before.objects}) after \`${cmd}\` with GIT_DIR/GIT_PREFIX/GIT_EXEC_PATH/GIT_EDITOR set${viaHook ? " behind the hook's scrub" : ""}.`,
);
