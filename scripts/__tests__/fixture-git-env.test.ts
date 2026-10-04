/**
 * fixture-git-env — no fixture helper under `scripts/` may touch a repository
 * it did not create, whatever `GIT_*` the caller inherited.
 *
 * The incident (2026-10-01, and #835 before it): a pre-push hook run from a
 * linked worktree exports GIT_DIR (and GIT_WORK_TREE / GIT_INDEX_FILE in other
 * hooks) to every process it spawns. A helper that runs `git init` / `add` /
 * `commit` / `clone` in a temp dir with that environment acts on the OUTER
 * repository: `init` wrote `core.worktree=<fixture>` into the real `.git/config`
 * and a `commit` landed a "fixture" commit on a real branch.
 *
 * Harness: build a DECOY repository, aim GIT_DIR / GIT_WORK_TREE /
 * GIT_INDEX_FILE (plus GIT_CONFIG_*) at it exactly as a hook
 * would, run every inventoried fixture helper in that environment, and assert
 * the decoy is byte-for-byte unchanged (`.git/config`, HEAD, index, every ref,
 * the object count, and its work tree) — and that each helper's git resolved
 * to the FIXTURE's repository, not the decoy.
 *
 * The fixture helpers of `scripts/__tests__/differential-vs-main.test.ts`
 * (`fxGit` / `fxRun`) carry their own decoy test in that file; the shared
 * scrub they route through is the one asserted here.
 *
 * Relation to #1028: the vitest setup (`scripts/lib/vitest-scrub-git-env.ts`)
 * deletes every GIT_* from this worker before the file loads, so the leak is
 * RE-INTRODUCED per case (`withLeakedEnv`) — that is what proves the per-spawn
 * layer (`cleanEnv`, held by `check-fixture-git-env`) on its own, for a helper
 * run outside vitest and the hook. The shell script is spawned with the leak
 * in its env directly, the way a hook would run it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanEnv, readGit, runPretest } from "../lib/differential-tree.js";
import { analyzeSh, analyzeTs } from "../check-fixture-git-env.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = realpathSync(resolve(__dirname, "..", ".."));

function git(cwd: string, args: string[]): string {
  const r = spawnSync(
    "git",
    ["-c", "maintenance.auto=false", "-c", "gc.auto=0", "-c", "commit.gpgsign=false", ...args],
    { cwd, env: cleanEnv(), encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}:\n${r.stderr}`);
  return r.stdout.trim();
}

function initRepo(dir: string, file: string, content: string): string {
  mkdirSync(join(dir, dirname(file)), { recursive: true });
  writeFileSync(join(dir, file), content);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "fixture@example.invalid"]);
  git(dir, ["config", "user.name", "fixture"]);
  git(dir, ["config", "maintenance.auto", "false"]);
  git(dir, ["config", "gc.auto", "0"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return git(dir, ["rev-parse", "HEAD"]);
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function filesUnder(dir: string, skip: (rel: string) => boolean = () => false): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const rel = relative(dir, p);
      if (skip(rel)) continue;
      if (e.isDirectory()) walk(p);
      else out.push(rel);
    }
  };
  walk(dir);
  return out.sort();
}

/** What a leak would change: config, HEAD, index, refs, object count, work tree. */
function snapshot(decoy: string): Record<string, string> {
  const g = join(decoy, ".git");
  const snap: Record<string, string> = {};
  for (const f of ["config", "HEAD", "index", "packed-refs"]) {
    const p = join(g, f);
    snap[`.git/${f}`] = existsSync(p) ? sha(readFileSync(p)) : "(absent)";
  }
  for (const f of filesUnder(join(g, "refs")))
    snap[`.git/refs/${f}`] = sha(readFileSync(join(g, "refs", f)));
  const objects = filesUnder(
    join(g, "objects"),
    (rel) => rel === "info" || rel.startsWith(`info${sep}`),
  );
  snap[".git/objects (count)"] = String(objects.length);
  for (const f of filesUnder(decoy, (rel) => rel === ".git" || rel.startsWith(`.git${sep}`))) {
    snap[`worktree/${f}`] = sha(readFileSync(join(decoy, f)));
  }
  return snap;
}

function diffSnapshots(a: Record<string, string>, b: Record<string, string>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys]
    .filter((k) => a[k] !== b[k])
    .sort()
    .map((k) => `${k}: ${a[k] ?? "(absent)"} → ${b[k] ?? "(absent)"}`);
}

const inside = (dir: string, p: string) => {
  const d = realpathSync(dir);
  const r = realpathSync(p);
  return r === d || r.startsWith(d + sep);
};

describe("fixture helpers under a leaked GIT_* environment (decoy repository)", () => {
  let jail: string;
  let decoy: string;
  let leaked: Record<string, string>;
  let before: Record<string, string>;

  beforeAll(() => {
    jail = realpathSync(mkdtempSync(join(tmpdir(), "fixture-git-env-")));
    decoy = join(jail, "decoy");
    initRepo(decoy, "README", "decoy\n");
    leaked = {
      GIT_DIR: join(decoy, ".git"),
      GIT_WORK_TREE: decoy,
      GIT_INDEX_FILE: join(decoy, ".git", "index"),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "leaked-hook-identity",
    };
    before = snapshot(decoy);
  });

  afterAll(() => {
    rmSync(jail, { recursive: true, force: true });
  });

  /** Run `fn` with `leaked` in process.env (as a hook-spawned test runner would see it). */
  async function withLeakedEnv<T>(fn: () => T | Promise<T>): Promise<T> {
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(leaked)) {
      saved[k] = process.env[k];
      process.env[k] = leaked[k];
    }
    try {
      return await fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  function expectDecoyUnchanged(): void {
    const changed = diffSnapshots(before, snapshot(decoy));
    expect(changed, `the decoy was written:\n${changed.join("\n")}`).toEqual([]);
  }

  it("the decoy itself reads as a stable snapshot (no background writer)", () => {
    expectDecoyUnchanged();
  });

  it("differential-tree readGit resolves the fixture's repository, not the leaked GIT_DIR", async () => {
    const fx = join(jail, "read-fixture");
    initRepo(fx, "a.txt", "a\n");
    const resolved = await withLeakedEnv(() =>
      readGit(fx, ["rev-parse", "--absolute-git-dir"]).trim(),
    );
    expect(inside(fx, resolved), `readGit resolved ${resolved}, not ${fx}/.git`).toBe(true);
    const files = await withLeakedEnv(() => readGit(fx, ["ls-files"]).trim());
    expect(files).toBe("a.txt");
    expectDecoyUnchanged();
  });

  it("differential-tree runPretest (a tree build step that runs git init/add/commit) stays in its tree", async () => {
    const tree = join(jail, "tree");
    mkdirSync(join(tree, "pkg"), { recursive: true });
    writeFileSync(join(tree, "pkg", "file.txt"), "x\n");
    const pretest = [
      "git init -q .",
      "git add -A",
      "git -c user.email=fx@example.invalid -c user.name=fx -c maintenance.auto=false -c commit.gpgsign=false commit -q -m fixture",
      "git rev-parse --absolute-git-dir > where.txt",
    ].join(" && ");
    await withLeakedEnv(() =>
      runPretest(tree, { dir: "pkg", name: "@fx/pkg", deps: [], scripts: { pretest } }),
    );
    const where = readFileSync(join(tree, "pkg", "where.txt"), "utf8").trim();
    expect(inside(join(tree, "pkg"), where), `the pretest's git acted on ${where}`).toBe(true);
    expectDecoyUnchanged();
  });

  it("scripts/verify-pdf-text-v1-reproduction.sh clones and checks out into its temp dir, never the leaked GIT_DIR", () => {
    const spec = join(jail, "spec-src");
    // A spec repo whose build.sh fails on purpose: the run stops at step 3
    // (exit 4), after every git command the script makes (clone, checkout, rev-parse).
    const pin = initRepo(spec, "tool/build.sh", "#!/bin/sh\nexit 7\n");
    const r = spawnSync("bash", [join(ROOT, "scripts", "verify-pdf-text-v1-reproduction.sh")], {
      cwd: jail,
      env: { ...cleanEnv(), ...leaked, SPEC_REPO: spec, SPEC_SHA: pin },
      encoding: "utf8",
      timeout: 60_000,
    });
    const out = `${r.stdout}\n${r.stderr}`;
    expectDecoyUnchanged();
    expect(out).toContain(`Spec pin verified: ${pin}`);
    expect(r.status, out).toBe(4);
  });

  it("the decoy's final state is the snapshot taken before any helper ran", () => {
    expectDecoyUnchanged();
    expect(statSync(join(decoy, ".git", "config")).isFile()).toBe(true);
  });
});

describe("check-fixture-git-env classification", () => {
  it("repo-root git spawns need no scrub; anything else needs cleanEnv", () => {
    // Built at runtime so this file's own source carries no unscrubbed spawn for the gate to see.
    const src = [
      'S("git", ["status"], { cwd: ROOT });',
      'X(`git diff ${x}`, { cwd: ROOT, encoding: "utf-8" });',
      'S("git", ["-C", dir, "status"], { cwd: ROOT });',
      'S("git", ["init"], { cwd: tmp });',
      'S("git", ["init"], { cwd: tmp, env: cleanEnv() });',
      "const env = cleanEnv(process.env, {});",
      'S("git", args, { cwd, env, encoding: "utf8" });',
      'S("git", args, { cwd, env: process.env });',
      'S("node", ["x"], { cwd: tmp });',
      "let e2 = cleanEnv();",
      "e2 = process.env;",
      'S("git", args, { cwd, env: e2 });',
    ]
      .join("\n")
      .replace(/^S\(/gm, "spawnSync(")
      .replace(/^X\(/gm, "execSync(");
    expect(analyzeTs(src).map((s) => [s.line, s.target, s.scrubbed])).toEqual([
      [1, "repo", false],
      [2, "repo", false],
      [3, "fixture", false],
      [4, "fixture", false],
      [5, "fixture", true],
      [7, "fixture", true],
      [8, "fixture", false],
      [12, "fixture", false],
    ]);
  });

  it("reads the TOP-LEVEL options object; init/clone/--git-dir paths and process.env copies are fixture shapes", () => {
    // Built at runtime so this file's own source carries no unscrubbed spawn for the gate to see.
    const src = [
      // 1-2: a nested object inside cleanEnv(…) must not hide the outer `cwd`.
      'S("git", args, { cwd, encoding: "utf8", env: cleanEnv(process.env, { GIT_AUTHOR_NAME: "t" }) });',
      'F("git", args, { cwd, encoding: "utf8", env: cleanEnv(process.env, { GIT_AUTHOR_NAME: "t" }) });',
      // 3: the reviewer's mutation — Object.assign over process.env is not a scrub.
      'S("git", args, { cwd, env: Object.assign({}, process.env, { GIT_AUTHOR_NAME: "t" }) });',
      // 4: the common spread shape.
      'S("git", args, { cwd: tmp, env: { ...process.env, GIT_AUTHOR_NAME: "t" } });',
      // 5: a brace inside a template literal in the options must not be read as the options object.
      'S("git", args, { cwd, env: cleanEnv(process.env, { M: `{${x}}` }) });',
      // 6-10: init / clone name their target positionally, with no cwd.
      'S("git", ["init", "-q", dir]);',
      'S("git", ["init", "-q", "-b", "main", dir], { env: cleanEnv() });',
      'S("git", ["clone", url, dir]);',
      "X(`git clone ${url} ${dir}`);",
      "X(`git init ${dir}`, { env: cleanEnv() });",
      // 11: init with no path, in the repo root, is the repo.
      'S("git", ["init", "-q"], { cwd: ROOT });',
      // 12-13: --git-dir / --work-tree redirect, spaced or `=`-joined.
      'S("git", ["--git-dir", gd, "log"]);',
      'S("git", [`--work-tree=${wt}`, "status"]);',
      // 14: a repo-root spawn may carry a process.env copy.
      'S("git", ["rev-parse", "HEAD"], { cwd: ROOT, env: { ...process.env } });',
      // 15: cleanEnv buried inside a spread that re-adds process.env is not a scrub.
      'S("git", args, { cwd: tmp, env: { ...cleanEnv(), ...process.env } });',
    ]
      .join("\n")
      .replace(/^S\(/gm, "spawnSync(")
      .replace(/^F\(/gm, "execFileSync(")
      .replace(/^X\(/gm, "execSync(");
    expect(analyzeTs(src).map((s) => [s.line, s.target, s.scrubbed])).toEqual([
      [1, "fixture", true],
      [2, "fixture", true],
      [3, "fixture", false],
      [4, "fixture", false],
      [5, "fixture", true],
      [6, "fixture", false],
      [7, "fixture", true],
      [8, "fixture", false],
      [9, "fixture", false],
      [10, "fixture", true],
      [11, "repo", false],
      [12, "fixture", false],
      [13, "fixture", false],
      [14, "repo", false],
      [15, "fixture", false],
    ]);
  });

  it("the two scrubbed fixture helpers the old parse miscounted as repo-root read as scrubbed fixtures", () => {
    for (const [rel, line] of [
      ["scripts/__tests__/pre-push-hook.test.ts", 73],
      ["scripts/__tests__/check-turbo-global-deps.test.ts", 35],
    ] as const) {
      const site = analyzeTs(readFileSync(join(ROOT, rel), "utf8")).find((s) => s.line === line);
      expect([rel, site?.target, site?.scrubbed]).toEqual([rel, "fixture", true]);
    }
  });

  it("shell git into a temp dir must follow fixture_git_env_scrub", () => {
    const unscrubbed = 'git clone "$R" "$W"\n# fixture_git_env_scrub\ngit diff --cached\n';
    expect(analyzeSh(unscrubbed).map((s) => [s.line, s.scrubbed])).toEqual([[1, false]]);
    const scrubbed =
      '. lib/fixture-git-env.sh\nfixture_git_env_scrub\nX="$(git -C "$W" rev-parse HEAD)"\n';
    expect(analyzeSh(scrubbed).map((s) => [s.line, s.scrubbed])).toEqual([[3, true]]);
  });
});
