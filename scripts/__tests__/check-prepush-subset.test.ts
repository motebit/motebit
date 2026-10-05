/**
 * check-prepush-subset — deny by default. The real hook / ci.yml / package
 * scripts are GREEN; every MUTANT in the permanent table (the ten shapes the
 * first, regex version let through, plus siblings) is RED; every CONTROL
 * (an edit the invariant is not about) stays GREEN. See prepush-subset-mutants.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluate,
  evaluateTestCache,
  readInputs,
  readTestCacheInputs,
  shardRunnerViolations,
  runToFile,
  canonHash,
  CI_JOBS,
  CI_JOB_STEPS,
  type TestCacheInputs,
} from "../check-prepush-subset.js";
import { cleanEnv } from "../lib/differential-tree.js";
import { parseSh, walk } from "../lib/posix-sh.js";
import { MUTANTS, CONTROLS } from "./prepush-subset-mutants.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REAL = readInputs(ROOT);
/** The gate's whole verdict on a set of inputs: the static evaluation plus the executed shard runner. */
const verdict = (inp: typeof REAL): string[] => [
  ...evaluate(inp).violations,
  ...shardRunnerViolations(inp, ROOT).violations,
];

describe("check-prepush-subset over the real hook and ci.yml", () => {
  it("is green, and maps every phase to its CI counterpart", () => {
    const e = evaluate(REAL);
    expect(e.violations).toEqual([]);
    expect(e.keys).toEqual(
      expect.arrayContaining(["build", "check", "typecheck", "lint", "test", "format", "audit"]),
    );
    expect(e.phases).toBeGreaterThanOrEqual(10);
  });

  it("executes the real shard runner (every shard + a zero-exit run) and finds it faithful", () => {
    const r = shardRunnerViolations(REAL, ROOT);
    expect(r.violations).toEqual([]);
    expect(r.launches).toBe(
      (CI_JOBS["test-coverage"]!.strategy as { matrix: { shard: string[] } }).matrix.shard.length +
        1,
    );
  });

  it("pins the steps of EVERY counterpart job (B1: no job left unpinned)", () => {
    expect(Object.keys(CI_JOB_STEPS).sort()).toEqual(Object.keys(CI_JOBS).sort());
  });
});

describe("mutation table — every mutant RED", () => {
  for (const mu of MUTANTS) {
    it(`${mu.id}: ${mu.what}`, () => {
      const v = verdict(mu.apply(REAL));
      expect(v.length, `mutant ${mu.id} survived`).toBeGreaterThan(0);
    });
  }
});

describe("controls — every control GREEN", () => {
  for (const c of CONTROLS) {
    it(`${c.id}: ${c.what}`, () => {
      expect(verdict(c.apply(REAL))).toEqual([]);
    });
  }
});

describe("the POSIX-sh reader", () => {
  const commands = (src: string) => {
    const out: string[] = [];
    walk(parseSh(src), {
      simple: (c, ctx) =>
        out.push(`${ctx.forked ? "F:" : ""}${c.words.map((w) => w.raw).join(" ")}`),
    });
    return out;
  };

  it("sees commands inside $( ), $(( $( ) )), ${ } and double quotes", () => {
    expect(commands('x="$(a 1 | b)"; echo $(( $(c) + 1 )) "${y:-$(d)}"')).toEqual([
      "",
      "F:a 1",
      "F:b",
      'echo $(( $(c) + 1 )) "${y:-$(d)}"',
      "F:c",
      "F:d",
    ]);
  });

  it("refuses what it cannot read (fail closed)", () => {
    expect(() => parseSh("echo `a`")).toThrow(/backtick/);
    expect(() => parseSh("cat <<EOF\nx\nEOF\n")).toThrow(/here-document/);
    expect(() => parseSh("echo 'open")).toThrow(/single quote/);
    expect(() => parseSh("if a; then b")).toThrow();
  });

  it("canonical function hashes ignore comments and layout, not tokens", () => {
    const fn = (body: string) => {
      let canon = "";
      walk(parseSh(body), { func: (f) => (canon = f.canon) });
      return canonHash(canon);
    };
    expect(fn("f() {\n  # c\n  a  b\n}\n")).toBe(fn("f() { a b; }"));
    expect(fn("f() { a b; }")).not.toBe(fn("f() { a c; }"));
  });
});

/**
 * Final cold review (2): a per-package turbo.json re-enabling the cache for
 * `test:coverage` made CI replay a stale pass, while the root-turbo.json
 * checks stayed green. Proven BY EXECUTION: the real `turbo --dry=json` over a
 * throwaway worktree carrying that file must turn the gate red.
 */
describe("test tasks are never cached (turbo --dry=json, per package)", () => {
  const RED_SHAPE =
    '{"extends":["//"],"tasks":{"test:coverage":{"dependsOn":[],"cache":true,"inputs":["package.json"]}}}';
  let base: string;
  let wt: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", env: cleanEnv() });

  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "prepush-test-cache-")));
    wt = join(base, "wt");
    git(ROOT, "worktree", "add", "-q", "--detach", wt, "HEAD");
    symlinkSync(join(ROOT, "node_modules"), join(wt, "node_modules"));
    // The working tree's turbo.json, not HEAD's (uncommitted edits count).
    copyFileSync(join(ROOT, "turbo.json"), join(wt, "turbo.json"));
  }, 120_000);

  afterAll(() => {
    git(ROOT, "worktree", "remove", "--force", wt);
    rmSync(base, { recursive: true, force: true });
  });

  const run = () => evaluateTestCache(readTestCacheInputs(wt, readInputs(wt).packageScripts));

  it("the real repo resolves every package's test + test:coverage to cache: false", () => {
    expect(run()).toEqual([]);
  }, 120_000);

  it("RED: services/embed/turbo.json re-enabling the test:coverage cache", () => {
    const f = join(wt, "services/embed/turbo.json");
    writeFileSync(f, RED_SHAPE);
    try {
      const v = run();
      expect(
        v.some((x) => x.startsWith("services/embed#test:coverage resolves to cache: true")),
      ).toBe(true);
      expect(v.some((x) => x.startsWith("services/embed/turbo.json configures"))).toBe(true);
    } finally {
      rmSync(f);
    }
  }, 120_000);

  it("RED: a root `pkg#test` override that re-enables the cache (resolved, not just declared)", () => {
    const t = join(wt, "turbo.json");
    const saved = execFileSync("cat", [t], { encoding: "utf8" });
    const j = JSON.parse(saved) as { tasks: Record<string, unknown> };
    j.tasks["@motebit/embed#test"] = { dependsOn: [], cache: true };
    writeFileSync(t, JSON.stringify(j));
    try {
      expect(run().some((x) => x.startsWith("services/embed#test resolves to cache: true"))).toBe(
        true,
      );
    } finally {
      writeFileSync(t, saved);
    }
  }, 120_000);

  const fixture = (over: Partial<TestCacheInputs>): TestCacheInputs => ({
    dry: [
      { task: "test", directory: "packages/a", resolvedTaskDefinition: { cache: false } },
      { task: "test:coverage", directory: "packages/a", resolvedTaskDefinition: { cache: false } },
    ],
    turboConfigs: {},
    packageScripts: {
      "packages/a": { test: "vitest run", "test:coverage": "vitest run --coverage" },
    },
    ...over,
  });

  it("fixture control is green", () => {
    expect(evaluateTestCache(fixture({}))).toEqual([]);
  });

  it("RED: a package-level turbo.json that sets test at all (even cache: false) without an allowlist reason", () => {
    const v = evaluateTestCache(
      fixture({
        turboConfigs: { "packages/a/turbo.json": '{"tasks":{"test":{"cache":false,"inputs":[]}}}' },
      }),
    );
    expect(v.some((x) => x.includes('configures "test"'))).toBe(true);
  });

  it("control: a package-level turbo.json configuring only non-test tasks is green", () => {
    expect(
      evaluateTestCache(
        fixture({
          turboConfigs: { "packages/a/turbo.json": '{"tasks":{"build":{"outputs":[]}}}' },
        }),
      ),
    ).toEqual([]);
  });

  it("RED (deny by default): a test script the dry run did not resolve, a failed dry run, unparseable config", () => {
    expect(evaluateTestCache(fixture({ dry: [] })).length).toBeGreaterThan(0);
    expect(evaluateTestCache(fixture({ dry: "turbo: boom" })).length).toBeGreaterThan(0);
    expect(
      evaluateTestCache(fixture({ turboConfigs: { "packages/a/turbo.json": "{ nope" } })).length,
    ).toBeGreaterThan(0);
  });
});

/**
 * Main went red (2026-10-01) when the real `turbo run test test:coverage
 * --dry=json` output crossed Node's default 1 MiB `maxBuffer` (ENOBUFS): the
 * dry-run JSON lists every task's inputs and grows with the repo. A stub
 * `turbo` emitting well over 1 MiB must still be read in full.
 */
describe("the dry-run read has no output-size ceiling", () => {
  const BIG = 3 * 1024 * 1024;
  const env = () => cleanEnv();

  it("runToFile returns > 1 MiB of stdout intact", () => {
    const out = runToFile(
      process.execPath,
      ["-e", `process.stdout.write("x".repeat(${BIG}))`],
      process.cwd(),
      env(),
    );
    expect(out.length).toBe(BIG);
  });

  it("runToFile surfaces a non-zero exit with its stderr", () => {
    expect(() =>
      runToFile(
        process.execPath,
        ["-e", 'process.stderr.write("boom"); process.exit(3)'],
        process.cwd(),
        env(),
      ),
    ).toThrow(/exited 3: boom/);
  });

  it("readTestCacheInputs parses a > 1 MiB dry run (stub turbo)", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "prepush-big-dry-")));
    try {
      execFileSync("git", ["init", "-q"], { cwd: root, env: cleanEnv() });
      const bin = join(root, "node_modules", ".bin");
      mkdirSync(bin, { recursive: true });
      const payload = join(root, "dry.js");
      writeFileSync(
        payload,
        `const tasks=[{task:"test",directory:"packages/a",resolvedTaskDefinition:{cache:false},pad:"y".repeat(${BIG})},{task:"test:coverage",directory:"packages/a",resolvedTaskDefinition:{cache:false}}];process.stdout.write("turbo 2\\n"+JSON.stringify({tasks}));`,
      );
      const turbo = join(bin, "turbo");
      writeFileSync(turbo, `#!/bin/sh\nexec "${process.execPath}" "${payload}"\n`);
      chmodSync(turbo, 0o755);
      const inp = readTestCacheInputs(root, {
        "packages/a": { test: "vitest run", "test:coverage": "vitest run --coverage" },
      });
      expect(typeof inp.dry).not.toBe("string");
      expect(evaluateTestCache(inp)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
