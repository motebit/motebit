/**
 * git-env-structural — a fixture `git` spawned from a gate test or a gate
 * helper cannot reach a repository named by an inherited `GIT_*` environment,
 * WHATEVER THE SPAWN'S SYNTAX.
 *
 * Why a structural harness: three review rounds of check-fixture-git-env each
 * found a new syntactic shape the static gate counted as "repo root" while it
 * landed a FIXTURE commit in the real repository (R3, a6b1491:
 * `const opts = { cwd: tmp }; spawnSync("git", ["init"], opts); …` with
 * GIT_DIR=<real>/.git). Pattern-matching is bypassed every round, so this file
 * proves the scrub by EXECUTION instead:
 *
 *   1. a DECOY repository stands in for the real one;
 *   2. the parent environment aims GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE /
 *      GIT_OBJECT_DIRECTORY / GIT_COMMON_DIR / GIT_CONFIG* at it, as a hook
 *      exports them (no GIT_CEILING_DIRECTORIES — nothing caps discovery);
 *   3. a CHILD process runs the reviewer's exact shapes against a temp fixture
 *      — an options variable, an args variable carrying `-C` with no cwd, a
 *      generic `run(cmd, args, cwd)` wrapper, an `Object.assign` env copy —
 *      each doing init / config / commit;
 *   4. the decoy's HEAD, refs, index, config, packed-refs and object count are
 *      asserted byte-identical afterwards.
 *
 * Child kinds:
 *   - `vitest run` under the root config (the `pnpm test:gates` config), in
 *     every pool the suite can run in — the vitest setup file
 *     (scripts/lib/vitest-scrub-git-env.ts) must scrub before the shapes load;
 *   - the same shapes under a config WITHOUT that setup — the decoy MUST be
 *     written (the harness can see a leak; it is not vacuous);
 *   - plain node (via tsx) driving the repo's own generic spawn wrappers with
 *     the caller's `process.env` — a non-test entry point vitest never wraps,
 *     so the wrapper itself must scrub.
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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanEnv } from "../lib/differential-tree.js";

const ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."));
const TSX = join(ROOT, "node_modules", ".bin", "tsx");
const VITEST = join(ROOT, "node_modules", ".bin", "vitest");
const ID = ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid"];

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", [...ID, "-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: cleanEnv(),
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}:\n${r.stderr}`);
  return r.stdout.trim();
}

/** A committed repository with an index, a config identity and one ref. */
function makeDecoy(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README"), "decoy\n");
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.name", "decoy"]);
  git(dir, ["config", "user.email", "decoy@example.invalid"]);
  git(dir, ["add", "README"]);
  git(dir, ["commit", "-q", "-m", "decoy root"]);
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

/** HEAD, refs, index, config, packed-refs, object count — what a leaked write changes. */
function snapshot(decoy: string): Record<string, string> {
  const g = join(decoy, ".git");
  const snap: Record<string, string> = {};
  for (const f of ["HEAD", "index", "config", "packed-refs"]) {
    const p = join(g, f);
    snap[`.git/${f}`] = existsSync(p) ? sha(readFileSync(p)) : "(absent)";
  }
  for (const f of filesUnder(join(g, "refs")))
    snap[`.git/refs/${f}`] = sha(readFileSync(join(g, "refs", f)));
  snap["for-each-ref"] = git(decoy, ["for-each-ref", "--format=%(refname) %(objectname)"]);
  snap["objects (count)"] = String(
    filesUnder(join(g, "objects")).filter((f) => !f.startsWith("info")).length,
  );
  return snap;
}

function diff(a: Record<string, string>, b: Record<string, string>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((k) => a[k] !== b[k])
    .sort()
    .map((k) => `${k}: ${a[k] ?? "(absent)"} → ${b[k] ?? "(absent)"}`);
}

/** What a hook exports, aimed at `decoy`. */
function poison(decoy: string): Record<string, string> {
  const g = join(decoy, ".git");
  return {
    GIT_DIR: g,
    GIT_WORK_TREE: decoy,
    GIT_INDEX_FILE: join(g, "index"),
    GIT_OBJECT_DIRECTORY: join(g, "objects"),
    GIT_COMMON_DIR: g,
    GIT_CONFIG: join(g, "config"),
    GIT_CONFIG_GLOBAL: join(g, "config"),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "user.name",
    GIT_CONFIG_VALUE_0: "leaked-hook-identity",
    GIT_CONFIG_PARAMETERS: "'core.leaked'='1'",
  };
}

/**
 * The reviewer's four shapes, verbatim in form. Each targets its own temp
 * fixture under `base` and does init / config / commit; with the leak, every
 * one of those lands in the decoy instead (`commit --allow-empty` needs no
 * work tree, so even GIT_WORK_TREE=<decoy> cannot make the leak a no-op).
 */
function shapesSource(base: string): string {
  return `
import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
const base = ${JSON.stringify(base)};
const ID = ${JSON.stringify(ID)};
const dir = (n) => { const d = join(base, n); mkdirSync(d, { recursive: true }); return d; };

export function runShapes() {
  // (1) the options object in a variable.
  const t1 = dir("opts");
  const opts = { cwd: t1 };
  spawnSync("git", ["init", "-q"], opts);
  spawnSync("git", ["config", "fixture.marker", "opts"], opts);
  spawnSync("git", [...ID, "commit", "--allow-empty", "-qm", "FIXTURE opts"], opts);

  // (2) the args in a variable, carrying -C, no cwd.
  const t2 = dir("args");
  const a1 = ["-C", t2, "init", "-q"];
  const a2 = ["-C", t2, ...ID, "commit", "--allow-empty", "-qm", "FIXTURE args"];
  spawnSync("git", a1);
  try { execFileSync("git", a2, { stdio: "ignore" }); } catch {}

  // (3) a generic wrapper taking the command as a parameter.
  const t3 = dir("wrapper");
  function run(cmd, args, cwd) {
    return spawnSync(cmd, args, { cwd, encoding: "utf8" });
  }
  run("git", ["init", "-q"], t3);
  run("git", ["config", "fixture.marker", "wrapper"], t3);
  run("git", [...ID, "commit", "--allow-empty", "-qm", "FIXTURE wrapper"], t3);

  // (4) an Object.assign copy of process.env.
  const t4 = dir("assign");
  const env = Object.assign({}, process.env, { GIT_AUTHOR_NAME: "fixture" });
  spawnSync("git", ["init", "-q"], { cwd: t4, env });
  spawnSync("git", [...ID, "commit", "--allow-empty", "-qm", "FIXTURE assign"], { cwd: t4, env });
}
`;
}

describe("a fixture git spawn cannot reach a repository named by an inherited GIT_* (any syntax)", () => {
  let jail: string;

  beforeAll(() => {
    jail = realpathSync(mkdtempSync(join(tmpdir(), "git-env-structural-")));
  });
  afterAll(() => {
    rmSync(jail, { recursive: true, force: true });
  });

  /**
   * Run `argv` (cwd ROOT) with the decoy's poison in its env; return the
   * decoy's changes and the child's output.
   */
  function underPoison(
    name: string,
    build: (caseDir: string) => { argv: string[] },
  ): { changed: string[]; out: string; status: number | null } {
    const caseDir = join(jail, name);
    const decoy = join(caseDir, "decoy");
    makeDecoy(decoy);
    const before = snapshot(decoy);
    const { argv } = build(caseDir);
    const r = spawnSync(argv[0]!, argv.slice(1), {
      cwd: ROOT,
      env: { ...cleanEnv(), ...poison(decoy), CI: "1" },
      encoding: "utf8",
      timeout: 120_000,
    });
    return {
      changed: diff(before, snapshot(decoy)),
      out: `${r.stdout}\n${r.stderr}`,
      status: r.status,
    };
  }

  /** A vitest test file running the shapes, in its own directory (collected with `--dir`). */
  function shapesTestDir(caseDir: string): string {
    const d = join(caseDir, "suite");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "shapes.mjs"), shapesSource(join(caseDir, "fixtures")));
    writeFileSync(
      join(d, "shapes.test.mjs"),
      'import { it } from "vitest";\nimport { runShapes } from "./shapes.mjs";\nit("shapes", () => { runShapes(); });\n',
    );
    return d;
  }

  for (const pool of ["forks", "threads", "vmForks", "vmThreads"]) {
    it(`vitest (the test:gates config, pool=${pool}): the decoy is byte-identical`, () => {
      const r = underPoison(`vitest-${pool}`, (c) => ({
        argv: [VITEST, "run", "--dir", shapesTestDir(c), `--pool=${pool}`, "--reporter=dot"],
      }));
      expect(r.status, r.out).toBe(0);
      expect(r.changed, `the decoy was written:\n${r.changed.join("\n")}\n${r.out}`).toEqual([]);
    });
  }

  it("control: the same shapes under a config WITHOUT the setup file DO write the decoy", () => {
    const r = underPoison("control", (c) => {
      const cfg = join(c, "no-setup.config.mjs");
      writeFileSync(cfg, "export default { test: {} };\n");
      return {
        argv: [VITEST, "run", "--config", cfg, "--root", ROOT, "--dir", shapesTestDir(c)],
      };
    });
    expect(r.status, r.out).toBe(0);
    expect(r.changed.length, `the harness saw no leak at all:\n${r.out}`).toBeGreaterThan(0);
  });

  it("plain node: check-prepush-subset's runToFile(cmd, args, cwd, env) with the caller's process.env stays in its fixture", () => {
    const r = underPoison("runToFile", (c) => {
      const fx = join(c, "fixture");
      mkdirSync(fx, { recursive: true });
      const script = join(c, "drive.mts");
      writeFileSync(
        script,
        `import { runToFile } from ${JSON.stringify(join(ROOT, "scripts", "check-prepush-subset.ts"))};
const ID = ${JSON.stringify(ID)};
const fx = ${JSON.stringify(fx)};
runToFile("git", ["init", "-q"], fx, process.env);
runToFile("git", ["config", "fixture.marker", "runToFile"], fx, process.env);
runToFile("git", [...ID, "commit", "--allow-empty", "-qm", "FIXTURE runToFile"], fx, process.env);
`,
      );
      return { argv: [TSX, script] };
    });
    expect(r.changed, `the decoy was written:\n${r.changed.join("\n")}\n${r.out}`).toEqual([]);
    expect(r.status, r.out).toBe(0);
  });
});
