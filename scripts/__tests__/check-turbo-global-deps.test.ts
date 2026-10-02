/**
 * check-turbo-global-deps — discovery on fixtures, and BY EXECUTION on the real
 * repo: every turbo.json `globalDependencies` entry, perturbed, must move the
 * `turbo --dry=json` task hashes (otherwise the entry is declared but inert),
 * and an unlisted root file must not (otherwise the probe proves nothing).
 *
 * The execution half runs in a throwaway `git worktree` so perturbing
 * tsconfig.base.json / DOCTRINE.md never races the other gate tests that read
 * them in the same vitest run.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate, globSelects, isGlob } from "../check-turbo-global-deps.js";
import { countSpecMd, SPEC_COUNT_INPUTS } from "../generate-llms-txt.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const TURBO = join(ROOT, "node_modules", ".bin", "turbo");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
}

function write(dir: string, rel: string, content: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), content);
}

describe("discovery (fixture repo)", () => {
  let dir: string;
  const turbo = (globalDependencies: string[], testCache = false) =>
    write(
      dir,
      "turbo.json",
      JSON.stringify({
        globalDependencies,
        tasks: { test: { cache: testCache }, "test:coverage": { cache: false } },
      }),
    );

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "turbo-global-deps-"));
    git(dir, "init", "-q");
    write(dir, "pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
    write(dir, "tsconfig.base.json", '{ "extends": "./tsconfig.root-strict.json" }\n');
    write(dir, "tsconfig.root-strict.json", "{}\n");
    write(dir, ".eslintrc.js", "module.exports = { root: true };\n");
    write(
      dir,
      "vitest.shared.ts",
      'import { x } from "./config/shared-helper.js";\nexport { x };\n',
    );
    write(dir, "config/shared-helper.ts", "export const x = 1;\n");
    write(dir, "README.md", "# not an input\n");
    write(
      dir,
      "packages/a/package.json",
      JSON.stringify({ name: "a", scripts: { lint: "eslint src/" } }),
    );
    write(dir, "packages/a/tsconfig.json", '{ "extends": "../../tsconfig.base.json" }\n');
    write(
      dir,
      "packages/a/vitest.config.ts",
      'import s from "../../vitest.shared.js";\nexport default s;\n',
    );
    // A reference into ANOTHER package is turbo's dependency graph, not a root input.
    write(dir, "packages/b/package.json", JSON.stringify({ name: "b" }));
    write(dir, "packages/b/tsconfig.json", '{ "extends": "../a/tsconfig.json" }\n');
    git(dir, "add", "-A");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const ALL = [
    ".eslintrc.js",
    "config/shared-helper.ts",
    "tsconfig.base.json",
    "tsconfig.root-strict.json",
    "vitest.shared.ts",
  ];

  it("finds ../ refs, the ESLint cascade, and transitive imports/extends", () => {
    turbo(ALL);
    const { violations, d } = evaluate(dir);
    expect(violations).toEqual([]);
    expect([...d.inputs.keys()].sort()).toEqual(ALL);
  });

  it("flags each missing entry (one at a time)", () => {
    for (const missing of ALL) {
      turbo(ALL.filter((g) => g !== missing));
      const v = evaluate(dir).violations;
      expect(
        v.some((s) => s.startsWith(`${missing} is read by`)),
        missing,
      ).toBe(true);
    }
  });

  it("flags an entry nothing reads, a glob, and a cacheable test task", () => {
    turbo([...ALL, "README.md", "*.json"], true);
    const v = evaluate(dir).violations;
    expect(v.some((s) => s.includes('lists "README.md"'))).toBe(true);
    expect(v.some((s) => s.includes('"*.json" is a glob'))).toBe(true);
    expect(v.some((s) => s.includes('task "test" is cacheable'))).toBe(true);
  });

  it("a filename literal used only in a comparison is not a read; a named one still is", () => {
    write(
      dir,
      "scripts/names.ts",
      'export const skip = (f: string) => f !== "README.md";\nexport const cfg = "tsconfig.base.json";\n',
    );
    write(
      dir,
      "packages/a/package.json",
      JSON.stringify({
        name: "a",
        scripts: { lint: "eslint src/", prebuild: "tsx ../../scripts/names.ts" },
      }),
    );
    git(dir, "add", "-A");
    turbo([...ALL, "scripts/names.ts"]);
    const { violations, d } = evaluate(dir);
    expect(violations).toEqual([]);
    expect(d.inputs.has("README.md")).toBe(false);
    expect([...d.inputs.get("tsconfig.base.json")!]).toContain("scripts/names.ts (names it)");
    write(
      dir,
      "packages/a/package.json",
      JSON.stringify({ name: "a", scripts: { lint: "eslint src/" } }),
    );
    rmSync(join(dir, "scripts"), { recursive: true });
    git(dir, "add", "-A");
  });

  it("fails closed on a root script input that reads files with no SCRIPT_DATA_READS entry", () => {
    write(dir, "scripts/gen.ts", 'import { readFileSync } from "node:fs";\nreadFileSync("x");\n');
    write(
      dir,
      "packages/a/package.json",
      JSON.stringify({
        name: "a",
        scripts: { lint: "eslint src/", prebuild: "tsx ../../scripts/gen.ts" },
      }),
    );
    git(dir, "add", "-A");
    turbo([...ALL, "scripts/gen.ts"]);
    const v = evaluate(dir).violations;
    expect(v.some((s) => s.includes("scripts/gen.ts reads files at runtime"))).toBe(true);
  });
});

const trackedFiles = (): string[] =>
  execFileSync("git", ["-c", "core.quotePath=false", "ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);

/** globalDependencies entries → the files they name (globs expanded, turbo semantics). */
function expand(entries: readonly string[]): string[] {
  const globs = entries.filter(isGlob);
  const exact = entries.filter((e) => !isGlob(e));
  return [...exact, ...(globs.length ? trackedFiles().filter((f) => globSelects(globs, f)) : [])];
}

describe("execution: each globalDependencies entry moves the turbo task hashes", () => {
  let wt: string;
  let declared: string[];

  function hashes(): string {
    const out = execFileSync(
      TURBO,
      ["run", "build", "typecheck", "lint", "--dry=json", "--filter=@motebit/protocol"],
      { cwd: wt, encoding: "utf8", env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1" } },
    );
    const json = JSON.parse(out.slice(out.indexOf("{"))) as {
      tasks: { taskId: string; hash: string }[];
    };
    return json.tasks
      .map((t) => `${t.taskId}=${t.hash}`)
      .sort()
      .join(" ");
  }

  function perturbed(rel: string): string {
    const abs = join(wt, rel);
    const before = readFileSync(abs);
    appendFileSync(abs, "\n");
    try {
      return hashes();
    } finally {
      writeFileSync(abs, before);
    }
  }

  beforeAll(() => {
    const base = mkdtempSync(join(tmpdir(), "turbo-global-deps-wt-"));
    wt = join(base, "wt");
    git(ROOT, "worktree", "add", "-q", "--detach", wt, "HEAD");
    symlinkSync(join(ROOT, "node_modules"), join(wt, "node_modules"));
    declared = (
      JSON.parse(readFileSync(join(ROOT, "turbo.json"), "utf8")) as {
        globalDependencies: string[];
      }
    ).globalDependencies;
    // The working tree's turbo.json and inputs, not HEAD's (uncommitted edits count).
    for (const f of ["turbo.json", ...expand(declared)]) copyFileSync(join(ROOT, f), join(wt, f));
  }, 120_000);

  afterAll(() => {
    git(ROOT, "worktree", "remove", "--force", wt);
  });

  it("declares the inputs the task named (tsconfig.base.json, .eslintrc.js, vitest.shared.ts, api-extractor base, llms generator)", () => {
    expect(declared).toEqual(
      expect.arrayContaining([
        "tsconfig.base.json",
        ".eslintrc.js",
        "vitest.shared.ts",
        "config/api-extractor.base.json",
        "scripts/generate-llms-txt.ts",
      ]),
    );
  });

  it("every entry, perturbed, changes the hashes; an unlisted root file does not", () => {
    const base = hashes();
    // A glob is perturbed through one file it selects; an exclusion has none.
    const inert = declared
      .filter((g) => !g.startsWith("!"))
      .filter((g) => perturbed(isGlob(g) ? expand([g])[0]! : g) === base);
    expect(inert, "globalDependencies entries that do not move any task hash").toEqual([]);
    expect(perturbed("CONTRIBUTING.md"), "control: an unlisted root file moved the hash").toBe(
      base,
    );
  }, 300_000);

  it("the spec-count globs select exactly the files the llms.txt footer counts", () => {
    expect(declared).toEqual(expect.arrayContaining([...SPEC_COUNT_INPUTS]));
    const selected = trackedFiles().filter((f) => globSelects(SPEC_COUNT_INPUTS, f));
    expect(selected.length).toBe(countSpecMd(ROOT));
    expect(selected.length).toBeGreaterThan(0);
  });

  it("a spec/*.md edit moves the @motebit/docs build hash (the llms.txt regenerator)", () => {
    const docs = (): string => {
      const out = execFileSync(TURBO, ["run", "build", "--dry=json", "--filter=@motebit/docs"], {
        cwd: wt,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1" },
      });
      const json = JSON.parse(out.slice(out.indexOf("{"))) as {
        tasks: { taskId: string; hash: string }[];
      };
      return json.tasks.find((t) => t.taskId === "@motebit/docs#build")!.hash;
    };
    const before = docs();
    const spec = expand(["spec/*.md"])[0]!;
    const abs = join(wt, spec);
    const saved = readFileSync(abs);
    appendFileSync(abs, "\n");
    try {
      expect(docs()).not.toBe(before);
    } finally {
      writeFileSync(abs, saved);
    }
  }, 120_000);

  it("RED shape: without globalDependencies, a tsconfig.base.json edit replays the cached hash", () => {
    const t = join(wt, "turbo.json");
    const saved = readFileSync(t, "utf8");
    const j = JSON.parse(saved) as Record<string, unknown>;
    delete j.globalDependencies;
    writeFileSync(t, JSON.stringify(j));
    try {
      const base = hashes();
      expect(perturbed("tsconfig.base.json")).toBe(base);
    } finally {
      writeFileSync(t, saved);
    }
  }, 120_000);
});
